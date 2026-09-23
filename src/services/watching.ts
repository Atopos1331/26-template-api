import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db, Document } from "mongodb";
import { ACADEMIC_SOURCE, academicIdentity } from "../domain/academic.js";
import { PlanError } from "../domain/plans.js";
import { effectiveRemaining } from "../domain/quota.js";
import type {
  CourseWatchDocument,
  WatchNotificationDocument,
} from "../plugins/academic-collections.js";

export type WatchPreference = "none" | "in_app";

export type WatchingSettings = {
  cursorKey: string;
  cursorTtlSeconds: number;
  quotaTtlSeconds: number;
  now?: () => Date;
};

function requestError(field: string, message: string): never {
  throw new PlanError("invalid_request", 400, "Request validation failed", {
    [field]: message,
  });
}

function encodeCursor(
  key: string,
  owner: string,
  createdAt: string,
  id: string,
  issuedAt: number,
) {
  const encoded = Buffer.from(
    JSON.stringify({ owner, createdAt, id, issuedAt }),
  ).toString("base64url");
  return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
}

function decodeCursor(
  key: string,
  token: string,
  owner: string,
  ttlSeconds: number,
  now: number,
) {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra)
    throw new PlanError("invalid_cursor", 400, "Invalid cursor");
  const expected = Buffer.from(
    createHmac("sha256", key).update(encoded).digest("base64url"),
  );
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new PlanError("invalid_cursor", 400, "Invalid cursor");
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString()) as {
      owner?: string;
      createdAt?: string;
      id?: string;
      issuedAt?: number;
    };
    if (
      value.owner !== owner ||
      typeof value.createdAt !== "string" ||
      typeof value.id !== "string" ||
      !Number.isSafeInteger(value.issuedAt) ||
      value.issuedAt! > now ||
      value.issuedAt! + ttlSeconds * 1000 < now
    )
      throw new Error("cursor mismatch");
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new PlanError("invalid_cursor", 400, "Invalid cursor");
  }
}

function preference(value: unknown): WatchPreference {
  if (value === undefined) return "none";
  if (value !== "none" && value !== "in_app")
    return requestError("notificationPreference", "must be none or in_app");
  return value;
}

function quotaResponse(row: Document | null) {
  if (!row || typeof row.snapshotId !== "string" || !row.snapshotId)
    return null;
  const rawRemaining = effectiveRemaining(row);
  return {
    snapshotId: row.snapshotId ?? null,
    sectionId: row.sectionId ?? null,
    capacity:
      typeof row.capacity === "number" && Number.isFinite(row.capacity)
        ? row.capacity
        : null,
    enrolled:
      typeof row.enrolled === "number" && Number.isFinite(row.enrolled)
        ? row.enrolled
        : null,
    remaining: rawRemaining === null ? null : Math.max(0, rawRemaining),
    waitlisted:
      typeof row.waitlisted === "number" && Number.isFinite(row.waitlisted)
        ? Math.max(0, row.waitlisted)
        : null,
    reserveCapacity:
      typeof row.reserveCapacity === "number" &&
      Number.isFinite(row.reserveCapacity)
        ? row.reserveCapacity
        : null,
    open: typeof row.open === "boolean" ? row.open : null,
    observedAt: row.observedAt ?? null,
    ...(rawRemaining !== null && rawRemaining < 0 ? { rawRemaining } : {}),
  };
}

function quotaFreshness(row: Document | null, ttlSeconds: number, now: Date) {
  const observedAt =
    typeof row?.observedAt === "string" &&
    Number.isFinite(Date.parse(row.observedAt))
      ? row.observedAt
      : null;
  const nextRefreshAt =
    typeof row?.nextRefreshAt === "string" ? row.nextRefreshAt : null;
  const isStale =
    !observedAt || Date.parse(observedAt) + ttlSeconds * 1000 <= now.getTime();
  return {
    asOf: observedAt,
    isStale,
    source: ACADEMIC_SOURCE,
    lastAttemptAt:
      typeof row?.lastAttemptedAt === "string" ? row.lastAttemptedAt : null,
    nextRefreshAt,
    state: isStale ? "stale" : "fresh",
  } as const;
}

function notificationResponse(row: WatchNotificationDocument) {
  return {
    notificationId: row.notificationId,
    watchId: row.watchId,
    termCode: row.termCode,
    targetType: row.targetType,
    targetId: row.targetId,
    changeType: row.changeType,
    beforeState: row.beforeState,
    afterState: row.afterState,
    observedAt: row.observedAt,
    readAt: row.readAt ?? null,
    createdAt: row.createdAt,
  };
}

export class WatchingService {
  constructor(
    private readonly db: Db,
    private readonly settings: WatchingSettings,
  ) {}

  private now() {
    return this.settings.now?.() ?? new Date();
  }

  private async activeTerm(termCode: string) {
    const term = await this.db.collection("academicTerms").findOne({
      source: ACADEMIC_SOURCE,
      termCode,
    });
    if (!term) throw new PlanError("not_found", 404, "Academic term not found");
    if (
      typeof term.activeImportBatchId !== "string" ||
      !term.activeImportBatchId
    )
      throw new PlanError(
        "term_not_selectable",
        409,
        "Academic term has no active course data",
      );
    return term;
  }

  private async sectionIdsForCourse(term: Document, courseId: string) {
    const offerings = await this.db
      .collection("courseOfferings")
      .find({
        source: ACADEMIC_SOURCE,
        termCode: term.termCode,
        importBatchId: term.activeImportBatchId,
        retiredAt: null,
        courseId,
      })
      .project({ offeringId: 1 })
      .toArray();
    const offeringIds = offerings.map((row) => row.offeringId);
    if (!offeringIds.length)
      throw new PlanError(
        "not_found",
        404,
        "Course is not offered in this term",
      );
    const sections = await this.db
      .collection("classSections")
      .find({
        source: ACADEMIC_SOURCE,
        termCode: term.termCode,
        importBatchId: term.activeImportBatchId,
        retiredAt: null,
        offeringId: { $in: offeringIds },
      })
      .project({ sectionId: 1 })
      .toArray();
    return sections.map((row) => String(row.sectionId));
  }

  private async sectionBaseline(sectionIds: string[]) {
    if (!sectionIds.length) return {};
    const rows = await this.db
      .collection("latestQuotas")
      .find({ source: ACADEMIC_SOURCE, sectionId: { $in: sectionIds } })
      .project({ sectionId: 1, snapshotId: 1 })
      .toArray();
    const result: Record<string, string | null> = {};
    for (const sectionId of sectionIds) result[sectionId] = null;
    for (const row of rows)
      result[String(row.sectionId)] = row.snapshotId
        ? String(row.snapshotId)
        : null;
    return result;
  }

  private response(watch: CourseWatchDocument) {
    return {
      watchId: watch.watchId,
      targetType: watch.targetType,
      targetId: watch.targetId,
      termCode: watch.termCode,
      notificationPreference: watch.notificationPreference,
      baselineRecordedAt: watch.baselineRecordedAt,
      createdAt: watch.createdAt,
      updatedAt: watch.updatedAt,
    };
  }

  async createCourseWatch(
    owner: string,
    courseId: string,
    termCode: string,
    requestedPreference: unknown,
  ) {
    if (!termCode?.trim()) return requestError("termCode", "is required");
    const normalizedTermCode = termCode.trim();
    const term = await this.activeTerm(normalizedTermCode);
    const targetId = courseId.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z]{2,8}\d+[A-Z]?$/.test(targetId))
      return requestError("courseId", "must be a canonical course code");
    const sectionIds = await this.sectionIdsForCourse(term, targetId);
    return this.upsert(
      owner,
      "course",
      targetId,
      normalizedTermCode,
      sectionIds,
      requestedPreference,
    );
  }

  async createSectionWatch(
    owner: string,
    sectionId: string,
    requestedPreference: unknown,
  ) {
    const identity = academicIdentity(sectionId, "section");
    const term = await this.activeTerm(identity.termCode);
    const section = await this.db.collection("classSections").findOne({
      ...identity,
      sectionId,
      importBatchId: term.activeImportBatchId,
      retiredAt: null,
    });
    if (!section) throw new PlanError("not_found", 404, "Section not found");
    return this.upsert(
      owner,
      "section",
      sectionId,
      identity.termCode,
      [sectionId],
      requestedPreference,
    );
  }

  private async upsert(
    owner: string,
    targetType: "course" | "section",
    targetId: string,
    termCode: string,
    sectionIds: string[],
    requestedPreference: unknown,
  ) {
    const notificationPreference = preference(requestedPreference);
    const watches = this.db.collection<CourseWatchDocument>("courseWatches");
    const identity = { ownerUsername: owner, termCode, targetType, targetId };
    const existing = await watches.findOne(identity);
    const now = this.now().toISOString();
    if (existing) {
      if (existing.notificationPreference === notificationPreference)
        return this.response(existing);
      const update =
        existing.notificationPreference === "none" &&
        notificationPreference === "in_app"
          ? {
              notificationPreference,
              baselineRecordedAt: now,
              baselineBySection: await this.sectionBaseline(sectionIds),
              updatedAt: now,
            }
          : { notificationPreference, updatedAt: now };
      await watches.updateOne(identity, { $set: update });
      return this.response((await watches.findOne(identity))!);
    }
    const watch: CourseWatchDocument = {
      ...identity,
      watchId: randomUUID(),
      notificationPreference,
      baselineRecordedAt: now,
      baselineBySection: await this.sectionBaseline(sectionIds),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await watches.insertOne(watch);
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 11000
        )
      )
        throw error;
      return this.response((await watches.findOne(identity))!);
    }
    return this.response(watch);
  }

  async remove(
    owner: string,
    targetType: "course" | "section",
    targetId: string,
    termCode?: string,
  ) {
    if (targetType === "course" && !termCode?.trim())
      return requestError("termCode", "is required");
    if (targetType === "section") academicIdentity(targetId, "section");
    const normalizedTargetId =
      targetType === "course"
        ? targetId.replace(/\s+/g, "").toUpperCase()
        : targetId;
    if (
      targetType === "course" &&
      !/^[A-Z]{2,8}\d+[A-Z]?$/.test(normalizedTargetId)
    )
      return requestError("courseId", "must be a canonical course code");
    await this.db.collection("courseWatches").deleteOne({
      ownerUsername: owner,
      targetType,
      targetId: normalizedTargetId,
      ...(termCode ? { termCode: termCode.trim() } : {}),
    });
  }

  async list(
    owner: string,
    query: {
      termCode?: string;
      targetType?: "course" | "section";
      limit: number;
      cursor?: string;
    },
  ) {
    const watches = this.db.collection<CourseWatchDocument>("courseWatches");
    const now = this.now();
    const filter: Document = {
      ownerUsername: owner,
      ...(query.termCode ? { termCode: query.termCode } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
    };
    const cursor = query.cursor
      ? decodeCursor(
          this.settings.cursorKey,
          query.cursor,
          owner,
          this.settings.cursorTtlSeconds,
          now.getTime(),
        )
      : null;
    if (cursor)
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, watchId: { $lt: cursor.id } },
      ];
    const rows = await watches
      .find(filter)
      .sort({ createdAt: -1, watchId: -1 })
      .limit(query.limit + 1)
      .toArray();
    const visible = rows.slice(0, query.limit);
    const items = await Promise.all(
      visible.map(async (watch) => {
        const sectionIds =
          watch.targetType === "section"
            ? [watch.targetId]
            : await this.sectionIdsForCourse(
                await this.activeTerm(watch.termCode),
                watch.targetId,
              ).catch(() => []);
        const latest = sectionIds.length
          ? await this.db
              .collection("latestQuotas")
              .find({ source: ACADEMIC_SOURCE, sectionId: { $in: sectionIds } })
              .sort({ observedAt: -1, snapshotId: -1, sectionId: 1 })
              .limit(1)
              .next()
          : null;
        const freshness = quotaFreshness(
          latest,
          this.settings.quotaTtlSeconds,
          now,
        );
        const remaining = effectiveRemaining(latest ?? {});
        const dataQuality = !latest?.snapshotId
          ? ["quota_missing"]
          : freshness.isStale
            ? ["quota_stale"]
            : [];
        if (remaining !== null && remaining < 0)
          dataQuality.push("quota_inconsistent");
        return {
          ...this.response(watch),
          latestQuota: quotaResponse(latest),
          freshness,
          dataQuality,
        };
      }),
    );
    const last = visible.at(-1);
    return {
      items,
      page: {
        hasMore: rows.length > query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor(
                this.settings.cursorKey,
                owner,
                last.createdAt,
                last.watchId,
                now.getTime(),
              )
            : null,
      },
      meta: {},
    };
  }

  async notifications(
    owner: string,
    query: { unreadOnly: boolean; limit: number; cursor?: string },
  ) {
    const notifications =
      this.db.collection<WatchNotificationDocument>("watchNotifications");
    const now = this.now();
    const filter: Document = {
      ownerUsername: owner,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };
    const cursor = query.cursor
      ? decodeCursor(
          this.settings.cursorKey,
          query.cursor,
          owner,
          this.settings.cursorTtlSeconds,
          now.getTime(),
        )
      : null;
    if (cursor)
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, notificationId: { $lt: cursor.id } },
      ];
    const rows = await notifications
      .find(filter)
      .sort({ createdAt: -1, notificationId: -1 })
      .limit(query.limit + 1)
      .toArray();
    const visible = rows.slice(0, query.limit);
    const last = visible.at(-1);
    return {
      items: visible.map(notificationResponse),
      page: {
        hasMore: rows.length > query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor(
                this.settings.cursorKey,
                owner,
                last.createdAt,
                last.notificationId,
                now.getTime(),
              )
            : null,
      },
      meta: {},
    };
  }

  async acknowledge(owner: string, notificationId: string) {
    const notifications =
      this.db.collection<WatchNotificationDocument>("watchNotifications");
    const result = await notifications.findOneAndUpdate(
      { ownerUsername: owner, notificationId },
      { $set: { readAt: this.now().toISOString() } },
      { returnDocument: "after" },
    );
    if (!result)
      throw new PlanError("not_found", 404, "Notification not found");
    return notificationResponse(result);
  }
}
