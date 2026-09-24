import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { type Collection, type Db, ObjectId, type WithId } from "mongodb";
import { academicIdentity } from "../domain/academic.js";
import { PlanError } from "../domain/plans.js";
import {
  discoverabilityAlias,
  discoverabilityAliasKey,
  expirySeconds,
  newShareToken,
  shareablePlanError,
  shareId,
  tokenHash,
} from "../domain/sharing.js";
import type {
  CoursePlanDocument,
  IdempotencyRecordDocument,
  SectionDiscoverabilityDocument,
  SharedPlanDocument,
  SharingRateLimitDocument,
} from "../plugins/init-mongo.js";
import type { CourseCatalogRepository } from "../repositories/course-catalog.js";
import {
  type DiscoverabilityCursorPayload,
  decodeDiscoverabilityCursor,
  encodeDiscoverabilityCursor,
} from "./discoverability-cursor.js";
import { currentSelections } from "./discoverability-selection.js";

const SHARE_CREATE_ROUTE = "POST /plans/:id/shares";
const PROCESSING_LEASE_SECONDS = 30;

export type SharingSettings = {
  defaultExpirySeconds: number;
  maxExpirySeconds: number;
  discoverabilityDefaultExpirySeconds: number;
  discoverabilityMaxExpirySeconds: number;
  replayKey: string;
  cursorKey: string;
  cursorTtlSeconds: number;
  shareReadsPerMinute: number;
  friendSearchesPerMinute: number;
  idempotencyRetentionSeconds: number;
  now?: () => Date;
};

function requestHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function keyBytes(value: string) {
  return createHash("sha256").update(value).digest();
}

function encrypt(value: string, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
}

function decrypt(value: string, key: string) {
  try {
    const packed = Buffer.from(value, "base64url");
    if (packed.length < 28) throw new Error("short ciphertext");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyBytes(key),
      packed.subarray(0, 12),
    );
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([
      decipher.update(packed.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new PlanError("operation_in_progress", 409, "Share is being retried");
  }
}

function inputObject(input: unknown) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new PlanError("invalid_request", 400, "Request validation failed");
  const value = input as Record<string, unknown>;
  for (const field of Object.keys(value)) {
    if (field !== "expiresInSeconds")
      throw new PlanError("invalid_request", 400, "Request validation failed", {
        [field]: "is not allowed",
      });
  }
  return value;
}

function snapshotResponse(share: SharedPlanDocument, shareToken: string) {
  return {
    shareId: share.shareId,
    shareToken,
    expiresAt: share.expiresAt.toISOString(),
    createdAt: share.createdAt,
    snapshot: share.snapshot,
  };
}

async function consumeRateLimit(
  collection: Collection<SharingRateLimitDocument>,
  key: string,
  limit: number,
  now: Date,
) {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const expiresAt = new Date(windowStart.getTime() + 120_000);
  const keyHash = tokenHash(key);
  let row: WithId<SharingRateLimitDocument> | null = null;
  for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
    try {
      row = await collection.findOneAndUpdate(
        { keyHash, windowStart },
        {
          $inc: { count: 1 },
          $setOnInsert: { keyHash, windowStart, expiresAt },
        },
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  if (!row) throw new Error("Rate-limit bucket update returned no document");
  if (row && row.count > limit)
    throw new PlanError(
      "rate_limited",
      429,
      "Too many requests",
      undefined,
      Math.max(
        1,
        Math.ceil((windowStart.getTime() + 60_000 - now.getTime()) / 1000),
      ),
    );
}

export class SharingService {
  constructor(
    private readonly db: Db,
    private readonly plans: Collection<CoursePlanDocument>,
    private readonly shares: Collection<SharedPlanDocument>,
    private readonly records: Collection<IdempotencyRecordDocument>,
    private readonly catalog: CourseCatalogRepository,
    private readonly settings: SharingSettings,
  ) {}

  private now() {
    return this.settings.now?.() ?? new Date();
  }

  private async plan(owner: string, id: string) {
    if (!/^[0-9a-f]{24}$/.test(id))
      throw new PlanError("invalid_request", 400, "Invalid plan ID");
    const plan = await this.plans.findOne({
      _id: new ObjectId(id),
      ownerUsername: owner,
    });
    if (!plan) throw new PlanError("not_found", 404, "Plan not found");
    return plan;
  }

  private async buildSnapshot(
    plan: WithId<CoursePlanDocument>,
    generatedAt: string,
  ) {
    const term = await this.catalog.activeTerm(plan.termCode);
    const selectedCourses: SharedPlanDocument["snapshot"]["selectedCourses"] =
      [];
    for (const item of plan.items.filter((row) => row.status === "selected")) {
      const canonical = await this.catalog.activeBundleById(
        term,
        item.bundleId,
      );
      if (!canonical || canonical.bundle.offeringId !== item.offeringId)
        throw new PlanError(
          "stale_reference",
          409,
          "A selected course reference is no longer active",
        );
      const derivedMeetings = canonical.bundle.derivedSchedule?.meetings;
      const meetings: Array<Record<string, unknown>> =
        Array.isArray(derivedMeetings) && derivedMeetings.length > 0
          ? (derivedMeetings as Array<Record<string, unknown>>)
          : canonical.sections.flatMap((section) =>
              Array.isArray(section.meetings)
                ? (section.meetings as Array<Record<string, unknown>>)
                : [],
            );
      selectedCourses.push({
        courseCode: String(
          canonical.course.courseCode ?? item.courseCodeSnapshot,
        ),
        title: String(canonical.course.title ?? item.courseCodeSnapshot),
        sectionLabels: (canonical.bundle.sectionLabels ?? []).map(String),
        meetings: meetings.map((meeting) => ({
          startDate: meeting.startDate ?? null,
          endDate: meeting.endDate ?? null,
          weekdays: meeting.weekdays ?? [],
          startTime: meeting.startTime ?? null,
          endTime: meeting.endTime ?? null,
          timezone: meeting.timezone ?? null,
        })),
        ...(meetings.find((meeting) => meeting.venue)?.venue
          ? {
              room: String(meetings.find((meeting) => meeting.venue)?.venue),
            }
          : {}),
      });
    }
    return {
      displayLabel: plan.name,
      termSummary: String(
        term.displayName ?? term.localizedName ?? plan.termCode,
      ),
      selectedCourses,
      generatedAt,
    };
  }

  private async claimRecord(
    owner: string,
    keyHash: string,
    hash: string,
    now: Date,
  ): Promise<{
    record: WithId<IdempotencyRecordDocument>;
    replay?: {
      status: 201;
      body: ReturnType<typeof snapshotResponse> & { shareToken: string };
    };
  }> {
    const filter = {
      ownerScope: owner,
      routeKey: SHARE_CREATE_ROUTE,
      idempotencyKeyHash: keyHash,
    };
    const existing = await this.records.findOne(filter);
    if (existing && existing.expiresAt > now) {
      if (existing.requestHash !== hash)
        throw new PlanError(
          "idempotency_key_reused",
          409,
          "Idempotency key was used for another request",
        );
      if (
        existing.state === "completed" &&
        existing.responseBody &&
        existing.encryptedOneTimeSecret
      ) {
        const body = {
          ...(existing.responseBody as ReturnType<typeof snapshotResponse>),
          shareToken: decrypt(
            existing.encryptedOneTimeSecret,
            this.settings.replayKey,
          ),
        };
        return { record: existing, replay: { status: 201 as const, body } };
      }
      const committed = existing.operationId
        ? await this.shares.findOne({
            ownerUsername: owner,
            operationId: existing.operationId,
          })
        : null;
      if (committed && existing.encryptedOneTimeSecret) {
        const token = decrypt(
          existing.encryptedOneTimeSecret,
          this.settings.replayKey,
        );
        const response = snapshotResponse(committed, token);
        return {
          record: existing,
          replay: await this.finishRecord(existing, response, token),
        };
      }
      if (
        committed &&
        existing.state === "processing" &&
        existing.leaseExpiresAt &&
        existing.leaseExpiresAt <= now.toISOString()
      ) {
        await this.shares.deleteOne({
          _id: committed._id,
          operationId: existing.operationId,
        });
      }
      if (
        existing.state === "processing" &&
        existing.leaseExpiresAt &&
        existing.leaseExpiresAt > now.toISOString()
      )
        throw new PlanError(
          "operation_in_progress",
          409,
          "Share is still processing",
        );
    }
    const operationId = randomUUID();
    const claimToken = randomUUID();
    const lease = new Date(
      now.getTime() + PROCESSING_LEASE_SECONDS * 1000,
    ).toISOString();
    if (existing) {
      const expired = existing.expiresAt <= now;
      const canClaim =
        expired ||
        existing.state === "failed" ||
        (existing.state === "processing" &&
          (!existing.leaseExpiresAt ||
            existing.leaseExpiresAt <= now.toISOString()));
      if (!canClaim)
        throw new PlanError(
          "operation_in_progress",
          409,
          "Share is still processing",
        );
      const replaced = await this.records.findOneAndUpdate(
        {
          _id: existing._id,
          ...filter,
          expiresAt: existing.expiresAt,
          ...(expired
            ? {}
            : {
                requestHash: hash,
                operationId: existing.operationId,
                state: existing.state,
                ...(existing.claimToken === undefined
                  ? { claimToken: { $exists: false } }
                  : { claimToken: existing.claimToken }),
              }),
        },
        {
          $set: {
            requestHash: hash,
            state: "processing",
            operationId: expired ? operationId : existing.operationId,
            claimToken,
            leaseExpiresAt: lease,
            createdAt: now.toISOString(),
            expiresAt: new Date(
              now.getTime() + this.settings.idempotencyRetentionSeconds * 1000,
            ),
          },
          $unset: {
            responseStatus: "",
            responseBody: "",
            ...(expired ? { encryptedOneTimeSecret: "" } : {}),
          },
        },
        { returnDocument: "after" },
      );
      if (!replaced)
        throw new PlanError(
          "operation_in_progress",
          409,
          "Share is still processing",
        );
      return { record: replaced };
    }
    const record: IdempotencyRecordDocument = {
      ownerScope: owner,
      routeKey: SHARE_CREATE_ROUTE,
      idempotencyKeyHash: keyHash,
      requestHash: hash,
      operationId,
      claimToken,
      state: "processing",
      leaseExpiresAt: lease,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.settings.idempotencyRetentionSeconds * 1000,
      ),
    };
    try {
      const inserted = await this.records.insertOne(record);
      return {
        record: {
          ...record,
          _id: inserted.insertedId,
        } as WithId<IdempotencyRecordDocument>,
      };
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        return this.claimRecord(owner, keyHash, hash, now);
      throw error;
    }
  }

  private async failRecord(record: WithId<IdempotencyRecordDocument>) {
    await this.records.updateOne(
      {
        _id: record._id,
        operationId: record.operationId,
        claimToken: record.claimToken,
        state: "processing",
      },
      {
        $set: { state: "failed" },
        $unset: { leaseExpiresAt: "" },
      },
    );
  }

  private async finishRecord(
    record: WithId<IdempotencyRecordDocument>,
    response: ReturnType<typeof snapshotResponse>,
    token: string,
  ) {
    const { shareToken: _shareToken, ...replayBody } = response;
    const result = await this.records.updateOne(
      {
        _id: record._id,
        operationId: record.operationId,
        claimToken: record.claimToken,
        state: "processing",
      },
      {
        $set: {
          state: "completed",
          responseStatus: 201,
          responseBody: replayBody,
          encryptedOneTimeSecret: encrypt(token, this.settings.replayKey),
        },
        $unset: { leaseExpiresAt: "" },
      },
    );
    if (result.matchedCount !== 1) {
      const latest = await this.records.findOne({ _id: record._id });
      if (
        latest?.state === "completed" &&
        latest.responseBody &&
        latest.encryptedOneTimeSecret
      ) {
        const body = {
          ...(latest.responseBody as ReturnType<typeof snapshotResponse>),
          shareToken: decrypt(
            latest.encryptedOneTimeSecret,
            this.settings.replayKey,
          ),
        };
        return { status: 201 as const, body };
      }
      throw new PlanError(
        "operation_in_progress",
        409,
        "Share is being retried",
      );
    }
    return { status: 201 as const, body: response };
  }

  async create(
    owner: string,
    id: string,
    input: unknown,
    idempotencyKey?: unknown,
  ) {
    const value = inputObject(input);
    const expiresInSeconds = expirySeconds(
      value.expiresInSeconds,
      this.settings.defaultExpirySeconds,
      this.settings.maxExpirySeconds,
    );
    if (
      idempotencyKey !== undefined &&
      (typeof idempotencyKey !== "string" ||
        !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey))
    )
      throw new PlanError(
        "invalid_request",
        400,
        "Invalid Idempotency-Key header",
      );
    const keyHash =
      typeof idempotencyKey === "string"
        ? tokenHash(idempotencyKey)
        : undefined;
    const normalizedHash = requestHash({ id, expiresInSeconds });
    const now = this.now();
    let record: WithId<IdempotencyRecordDocument> | undefined;
    if (keyHash) {
      const claimed = await this.claimRecord(
        owner,
        keyHash,
        normalizedHash,
        now,
      );
      if (claimed.replay) return claimed.replay;
      record = claimed.record;
    }
    let token: string;
    if (record?.encryptedOneTimeSecret) {
      token = decrypt(record.encryptedOneTimeSecret, this.settings.replayKey);
    } else if (record) {
      token = newShareToken();
      const prepared = await this.records.updateOne(
        {
          _id: record._id,
          operationId: record.operationId,
          claimToken: record.claimToken,
          requestHash: normalizedHash,
          state: "processing",
        },
        {
          $set: {
            encryptedOneTimeSecret: encrypt(token, this.settings.replayKey),
          },
        },
      );
      if (prepared.matchedCount !== 1)
        throw new PlanError(
          "operation_in_progress",
          409,
          "Share is being retried",
        );
    } else {
      token = newShareToken();
    }
    let share: WithId<SharedPlanDocument> | undefined;
    try {
      const plan = await this.plan(owner, id);
      if (plan.status !== "active") throw shareablePlanError();
      const snapshot = await this.buildSnapshot(plan, now.toISOString());
      share = {
        _id: new ObjectId(),
        shareId: randomUUID(),
        planId: plan._id,
        ownerUsername: owner,
        tokenHash: tokenHash(token),
        operationId: record?.operationId ?? randomUUID(),
        expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
        revokedAt: null,
        snapshotVersion: plan.revision,
        snapshot,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      try {
        await this.shares.insertOne(share);
      } catch (error) {
        if ((error as { code?: number }).code !== 11000 || !record) throw error;
        const committed = await this.shares.findOne({
          ownerUsername: owner,
          operationId: record.operationId,
        });
        if (!committed || committed.tokenHash !== share.tokenHash) throw error;
        if (committed.snapshotVersion !== plan.revision) {
          await this.shares.deleteOne({
            _id: committed._id,
            operationId: record.operationId,
          });
          throw new PlanError(
            "concurrent_modification",
            409,
            "Plan changed while creating share",
          );
        }
        share = committed;
      }
      const unchanged = await this.plans.findOne({
        _id: plan._id,
        ownerUsername: owner,
        status: "active",
        revision: plan.revision,
      });
      if (!unchanged) {
        await this.shares.deleteOne({
          _id: share._id,
          operationId: share.operationId,
        });
        throw new PlanError(
          "concurrent_modification",
          409,
          "Plan changed while creating share",
        );
      }
      const response = snapshotResponse(share, token);
      if (record) return await this.finishRecord(record, response, token);
      return { status: 201 as const, body: response };
    } catch (error) {
      if (share) {
        const canCleanup =
          !record ||
          (await this.records.findOne({
            _id: record._id,
            operationId: record.operationId,
            claimToken: record.claimToken,
            state: { $in: ["processing", "failed"] },
          })) !== null;
        if (canCleanup)
          await this.shares.deleteOne({
            _id: share._id,
            operationId: share.operationId,
          });
      }
      if (record) await this.failRecord(record);
      throw error;
    }
  }

  async list(owner: string, id: string) {
    const plan = await this.plan(owner, id);
    const rows = await this.shares
      .find({ ownerUsername: owner, planId: plan._id })
      .sort({ createdAt: -1, shareId: -1 })
      .toArray();
    return rows.map((row) => ({
      shareId: row.shareId,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      snapshotVersion: row.snapshotVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async revoke(owner: string, id: string, rawShareId: string) {
    const plan = await this.plan(owner, id);
    const normalized = shareId(rawShareId);
    const now = this.now();
    const result = await this.shares.updateOne(
      {
        ownerUsername: owner,
        planId: plan._id,
        shareId: normalized,
        revokedAt: null,
      },
      { $set: { revokedAt: now, updatedAt: now.toISOString() } },
    );
    if (
      result.matchedCount === 0 &&
      !(await this.shares.findOne({
        ownerUsername: owner,
        planId: plan._id,
        shareId: normalized,
      }))
    )
      throw new PlanError("not_found", 404, "Share not found");
  }

  async read(rawToken: string, rateKey = "unknown") {
    const now = this.now();
    await consumeRateLimit(
      this.db.collection<SharingRateLimitDocument>("sharingRateLimits"),
      `read-ip:${rateKey}`,
      this.settings.shareReadsPerMinute,
      now,
    );
    if (
      typeof rawToken !== "string" ||
      rawToken.length < 32 ||
      rawToken.length > 128
    )
      throw new PlanError("not_found", 404, "Shared plan not found");
    const nowMs = now.getTime();
    const hashedToken = tokenHash(rawToken);
    await consumeRateLimit(
      this.db.collection<SharingRateLimitDocument>("sharingRateLimits"),
      `read-token:${hashedToken}`,
      this.settings.shareReadsPerMinute,
      now,
    );
    const row = await this.shares.findOne({
      tokenHash: hashedToken,
      revokedAt: null,
      expiresAt: { $gt: new Date(nowMs) },
    });
    if (!row) throw new PlanError("not_found", 404, "Shared plan not found");
    const plan = await this.plans.findOne({
      _id: row.planId,
      status: "active",
    });
    if (!plan) throw new PlanError("not_found", 404, "Shared plan not found");
    return row.snapshot;
  }
}

type DiscoverabilitySettings = Pick<
  SharingSettings,
  | "discoverabilityDefaultExpirySeconds"
  | "discoverabilityMaxExpirySeconds"
  | "cursorKey"
  | "cursorTtlSeconds"
  | "friendSearchesPerMinute"
  | "now"
>;

export class DiscoverabilityService {
  constructor(
    private readonly db: Db,
    private readonly catalog: CourseCatalogRepository,
    private readonly settings: DiscoverabilitySettings,
  ) {}

  private now() {
    return this.settings.now?.() ?? new Date();
  }

  private async currentSelection(owner: string, sectionId: string) {
    try {
      const identity = academicIdentity(sectionId, "section");
      const term = await this.catalog.activeTerm(identity.termCode);
      const section = await this.db.collection("classSections").findOne({
        source: identity.source,
        termCode: identity.termCode,
        importBatchId: term.activeImportBatchId,
        retiredAt: null,
        sectionId,
      });
      if (!section) return null;
      const plan = await this.db
        .collection<CoursePlanDocument>("coursePlans")
        .findOne({
          ownerUsername: owner,
          termCode: identity.termCode,
          status: "active",
        });
      if (!plan) return null;
      for (const item of plan.items.filter(
        (row) => row.status === "selected",
      )) {
        const canonical = await this.catalog.activeBundleById(
          term,
          item.bundleId,
        );
        if (
          canonical?.offering.offeringId === item.offeringId &&
          canonical.sections.some((row) => String(row.sectionId) === sectionId)
        )
          return { section, plan, term };
      }
    } catch (error) {
      if (
        error instanceof PlanError &&
        ["not_found", "term_not_selectable"].includes(error.code)
      )
        return null;
      throw error;
    }
    return null;
  }

  async enable(owner: string, sectionId: string, input: unknown) {
    const selected = await this.currentSelection(owner, sectionId);
    if (!selected) throw new PlanError("not_found", 404, "Section not found");
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new PlanError("invalid_request", 400, "Request validation failed");
    const body = input as Record<string, unknown>;
    for (const field of Object.keys(body))
      if (!["displayName", "expiresInSeconds"].includes(field))
        throw new PlanError(
          "invalid_request",
          400,
          "Request validation failed",
          { [field]: "is not allowed" },
        );
    const displayName = discoverabilityAlias(body.displayName);
    const seconds = expirySeconds(
      body.expiresInSeconds,
      this.settings.discoverabilityDefaultExpirySeconds,
      this.settings.discoverabilityMaxExpirySeconds,
    );
    const now = this.now();
    const collection = this.db.collection<SectionDiscoverabilityDocument>(
      "sectionDiscoverability",
    );
    try {
      await collection.updateOne(
        { ownerUsername: owner, sectionId },
        {
          $set: {
            displayName,
            displayNameKey: discoverabilityAliasKey(displayName),
            expiresAt: new Date(now.getTime() + seconds * 1000),
            updatedAt: now.toISOString(),
          },
          $setOnInsert: {
            _id: new ObjectId(),
            recordId: randomUUID(),
            ownerUsername: owner,
            sectionId,
            createdAt: now.toISOString(),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      await collection.updateOne(
        { ownerUsername: owner, sectionId },
        {
          $set: {
            displayName,
            displayNameKey: discoverabilityAliasKey(displayName),
            expiresAt: new Date(now.getTime() + seconds * 1000),
            updatedAt: now.toISOString(),
          },
        },
      );
    }
    const row = await collection.findOne({ ownerUsername: owner, sectionId });
    return {
      recordId: row!.recordId,
      sectionId,
      displayName: row!.displayName,
      expiresAt: row!.expiresAt.toISOString(),
      createdAt: row!.createdAt,
      updatedAt: row!.updatedAt,
    };
  }

  async disable(owner: string, sectionId: string) {
    academicIdentity(sectionId, "section");
    await this.db
      .collection("sectionDiscoverability")
      .deleteOne({ ownerUsername: owner, sectionId });
  }

  async classmates(
    owner: string,
    sectionId: string,
    limit: number,
    cursor?: string,
    rateKey = "unknown",
  ) {
    const now = this.now();
    await consumeRateLimit(
      this.db.collection<SharingRateLimitDocument>("sharingRateLimits"),
      `friends-owner:${owner}`,
      this.settings.friendSearchesPerMinute,
      now,
    );
    await consumeRateLimit(
      this.db.collection<SharingRateLimitDocument>("sharingRateLimits"),
      `friends-ip:${rateKey}`,
      this.settings.friendSearchesPerMinute,
      now,
    );
    const selected = await this.currentSelection(owner, sectionId);
    if (!selected) throw new PlanError("not_found", 404, "Section not found");
    const own = await this.db
      .collection<SectionDiscoverabilityDocument>("sectionDiscoverability")
      .findOne({ ownerUsername: owner, sectionId, expiresAt: { $gt: now } });
    if (!own) throw new PlanError("not_found", 404, "Section not found");
    let after = cursor
      ? decodeDiscoverabilityCursor(
          cursor,
          owner,
          sectionId,
          this.settings.cursorKey,
          this.settings.cursorTtlSeconds,
          now.getTime(),
        )
      : undefined;
    const issuedAt = after?.issuedAt ?? now.getTime();
    const collection = this.db.collection<SectionDiscoverabilityDocument>(
      "sectionDiscoverability",
    );
    const visible: Array<{
      displayName: string;
      sortKey: string;
      sectionLabel: string;
      optedInAt: string;
      recordId: string;
    }> = [];
    let scanned = 0;
    let exhausted = false;
    let lastScanned: DiscoverabilityCursorPayload | undefined;
    let hasVisibleExtra = false;
    while (!exhausted && scanned < 5000 && !hasVisibleExtra) {
      const batchSize = Math.min(100, 5000 - scanned);
      const query: Record<string, unknown> = {
        sectionId,
        expiresAt: { $gt: now },
        ownerUsername: { $ne: owner },
      };
      if (after)
        query.$or = [
          { displayNameKey: { $gt: after.name } },
          { displayNameKey: after.name, recordId: { $gt: after.recordId } },
        ];
      const rows = await collection
        .find(query)
        .sort({ displayNameKey: 1, recordId: 1 })
        .limit(batchSize)
        .toArray();
      if (rows.length < batchSize) exhausted = true;
      if (rows.length === 0) break;
      const currentOwners = await currentSelections(
        this.db,
        rows.map((candidate) => candidate.ownerUsername),
        selected.section,
        selected.term,
      );
      for (const row of rows) {
        scanned += 1;
        lastScanned = {
          owner,
          sectionId,
          name: row.displayNameKey ?? discoverabilityAliasKey(row.displayName),
          recordId: row.recordId,
          issuedAt,
          exp: issuedAt + this.settings.cursorTtlSeconds * 1000,
        };
        if (currentOwners.has(row.ownerUsername)) {
          visible.push({
            displayName: row.displayName,
            sortKey:
              row.displayNameKey ?? discoverabilityAliasKey(row.displayName),
            sectionLabel: String(selected.section.sectionCode ?? ""),
            optedInAt: row.createdAt.slice(0, 10),
            recordId: row.recordId,
          });
          if (visible.length > limit) {
            hasVisibleExtra = true;
            break;
          }
        }
      }
      after = lastScanned;
    }
    const page = hasVisibleExtra ? visible.slice(0, limit) : visible;
    const hasMore = hasVisibleExtra || (!exhausted && scanned >= 5000);
    let position:
      | Pick<DiscoverabilityCursorPayload, "name" | "recordId">
      | undefined = lastScanned;
    if (hasVisibleExtra) {
      const lastVisible = page.at(-1);
      position = lastVisible
        ? { name: lastVisible.sortKey, recordId: lastVisible.recordId }
        : undefined;
    }
    const nextCursor =
      hasMore && position
        ? encodeDiscoverabilityCursor(
            {
              owner,
              sectionId,
              ...position,
              issuedAt,
              exp: issuedAt + this.settings.cursorTtlSeconds * 1000,
            },
            this.settings.cursorKey,
          )
        : null;
    return {
      items: page.map(
        ({ recordId: _recordId, sortKey: _sortKey, ...item }) => item,
      ),
      page: { hasMore, nextCursor },
    };
  }
}
