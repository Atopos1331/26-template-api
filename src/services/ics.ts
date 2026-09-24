import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { type Collection, ObjectId, type WithId } from "mongodb";
import type { CalendarWindow } from "../domain/calendar.js";
import { EventError } from "../domain/events.js";
import { type ParsedIcsEvent, parseIcs } from "../domain/ics.js";
import { expandIcsSeries } from "../domain/ics-calendar.js";
import type {
  EventDocument,
  EventImportDocument,
  IdempotencyRecordDocument,
} from "../plugins/init-mongo.js";

export type IcsSettings = {
  timezone: string;
  maxWindowDays?: number;
  maxPayloadBytes: number;
  maxOccurrences: number;
  defaultWindowDays: number;
  processingLeaseSeconds: number;
  idempotencyRetentionSeconds?: number;
};

type ImportResult = {
  status: 200 | 201;
  body: ReturnType<typeof summary>;
};

const IMPORT_ROUTE_KEY = "POST /events/import/ics";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isDuplicate(error: unknown) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === 11000
  );
}

function parseWindow(
  value: unknown,
  fallback: string,
  timezone: string,
): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string")
    throw new EventError("invalid_request", 400, "Invalid ICS window");
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const date = Temporal.PlainDate.from(value);
      return new Date(
        date.toZonedDateTime(timezone).epochMilliseconds,
      ).toISOString();
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
      throw new Error("invalid timestamp");
    return Temporal.Instant.from(value).toString();
  } catch {
    throw new EventError("invalid_request", 400, "Invalid ICS window");
  }
}

function summary(manifest: EventImportDocument) {
  return {
    importId: manifest._id.toHexString(),
    status: manifest.status,
    created: manifest.createdCount,
    updated: manifest.updatedCount,
    skipped: manifest.skippedCount,
    rejected: manifest.rejectedCount,
    rejections: manifest.rejections ?? [],
    importedAt: manifest.importedAt,
    ...(manifest.activatedAt ? { activatedAt: manifest.activatedAt } : {}),
  };
}

export class IcsService {
  constructor(
    private readonly events: Collection<EventDocument>,
    private readonly imports: Collection<EventImportDocument>,
    private readonly settings: IcsSettings,
    private readonly records?: Collection<IdempotencyRecordDocument>,
  ) {}

  private idempotencyKey(value: unknown) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value))
      throw new EventError(
        "invalid_request",
        400,
        "Invalid Idempotency-Key header",
      );
    return value;
  }

  private async finishRecord(
    record: WithId<IdempotencyRecordDocument>,
    result: ImportResult,
  ) {
    const updated = await this.records!.updateOne(
      {
        _id: record._id,
        ownerScope: record.ownerScope,
        routeKey: IMPORT_ROUTE_KEY,
        operationId: record.operationId,
        requestHash: record.requestHash,
        state: "processing",
      },
      {
        $set: {
          state: "completed",
          responseStatus: result.status,
          responseBody: result.body,
        },
        $unset: { leaseExpiresAt: "" },
      },
    );
    if (updated.matchedCount === 1) return result;
    const latest = await this.records!.findOne({ _id: record._id });
    if (latest?.state === "completed" && latest.responseBody)
      return {
        status: latest.responseStatus === 201 ? (201 as const) : (200 as const),
        body: latest.responseBody as ReturnType<typeof summary>,
      };
    throw new EventError(
      "operation_in_progress",
      409,
      "ICS import is being retried",
    );
  }

  private async failRecord(record: WithId<IdempotencyRecordDocument>) {
    await this.records?.updateOne(
      {
        _id: record._id,
        ownerScope: record.ownerScope,
        routeKey: IMPORT_ROUTE_KEY,
        operationId: record.operationId,
        state: "processing",
      },
      { $set: { state: "failed" }, $unset: { leaseExpiresAt: "" } },
    );
  }

  private window(from: unknown, to: unknown) {
    const now = Temporal.Now.instant()
      .toZonedDateTimeISO(this.settings.timezone)
      .toPlainDate();
    const start = parseWindow(
      from,
      new Date(
        now.toZonedDateTime(this.settings.timezone).epochMilliseconds,
      ).toISOString(),
      this.settings.timezone,
    );
    const endDate = now.add({ days: this.settings.defaultWindowDays });
    const end = parseWindow(
      to,
      new Date(
        endDate.toZonedDateTime(this.settings.timezone).epochMilliseconds,
      ).toISOString(),
      this.settings.timezone,
    );
    if (Date.parse(start) >= Date.parse(end))
      throw new EventError(
        "invalid_request",
        400,
        "ICS window must be ordered",
      );
    const localStart = Temporal.Instant.from(start)
      .toZonedDateTimeISO(this.settings.timezone)
      .toPlainDate();
    const localEnd = Temporal.Instant.from(end)
      .toZonedDateTimeISO(this.settings.timezone)
      .toPlainDate();
    if (localStart.until(localEnd).days > (this.settings.maxWindowDays ?? 366))
      throw new EventError("invalid_request", 400, "ICS window is too large");
    return { from: start, to: end };
  }

  async import(
    owner: string,
    input: unknown,
    query: {
      from?: unknown;
      to?: unknown;
      defaultBlocksTime?: unknown;
      idempotencyKey?: unknown;
    },
  ) {
    if (typeof input !== "string")
      throw new EventError(
        "invalid_request",
        400,
        "ICS body must be text/calendar",
      );
    if (Buffer.byteLength(input, "utf8") > this.settings.maxPayloadBytes)
      throw new EventError("invalid_request", 400, "ICS payload is too large");
    const window = this.window(query.from, query.to);
    const defaultBlocksTime =
      query.defaultBlocksTime === undefined ? true : query.defaultBlocksTime;
    if (typeof defaultBlocksTime !== "boolean")
      throw new EventError(
        "invalid_request",
        400,
        "defaultBlocksTime must be boolean",
      );
    const optionsHash = hash(JSON.stringify({ ...window, defaultBlocksTime }));
    const contentHash = hash(input);
    const requestHash = hash(JSON.stringify({ contentHash, optionsHash }));
    const key = this.idempotencyKey(query.idempotencyKey);
    let record: WithId<IdempotencyRecordDocument> | undefined;
    if (key && this.records) {
      const now = new Date();
      const keyHash = hash(key);
      const existingRecord = await this.records.findOne({
        ownerScope: owner,
        routeKey: IMPORT_ROUTE_KEY,
        idempotencyKeyHash: keyHash,
      });
      if (existingRecord && existingRecord.expiresAt > now) {
        if (existingRecord.requestHash !== requestHash)
          throw new EventError(
            "idempotency_key_reused",
            409,
            "Idempotency key was used for another request",
          );
        if (existingRecord.state === "completed" && existingRecord.responseBody)
          return {
            status:
              existingRecord.responseStatus === 201
                ? (201 as const)
                : (200 as const),
            body: existingRecord.responseBody as ReturnType<typeof summary>,
          };
        if (
          existingRecord.state === "processing" &&
          existingRecord.leaseExpiresAt &&
          existingRecord.leaseExpiresAt > now.toISOString()
        )
          throw new EventError(
            "import_in_progress",
            409,
            "ICS import is still processing",
          );
        const operationId = randomUUID();
        const claimed = await this.records.updateOne(
          {
            _id: existingRecord._id,
            ownerScope: owner,
            routeKey: IMPORT_ROUTE_KEY,
            requestHash,
            state: existingRecord.state,
            expiresAt: { $gt: now },
            ...(existingRecord.leaseExpiresAt
              ? { leaseExpiresAt: existingRecord.leaseExpiresAt }
              : { leaseExpiresAt: { $exists: false } }),
          },
          {
            $set: {
              operationId,
              state: "processing",
              leaseExpiresAt: new Date(
                now.getTime() + this.settings.processingLeaseSeconds * 1000,
              ).toISOString(),
            },
          },
        );
        if (claimed.matchedCount !== 1)
          throw new EventError(
            "import_in_progress",
            409,
            "ICS import is still processing",
          );
        const claimedRecord = await this.records.findOne({
          _id: existingRecord._id,
          operationId,
          state: "processing",
        });
        if (!claimedRecord)
          throw new EventError(
            "import_in_progress",
            409,
            "ICS import is being retried",
          );
        record = claimedRecord;
      } else {
        const operationId = randomUUID();
        const created: WithId<IdempotencyRecordDocument> = {
          _id: new ObjectId(),
          ownerScope: owner,
          routeKey: IMPORT_ROUTE_KEY,
          idempotencyKeyHash: keyHash,
          requestHash,
          operationId,
          state: "processing",
          leaseExpiresAt: new Date(
            now.getTime() + this.settings.processingLeaseSeconds * 1000,
          ).toISOString(),
          createdAt: now.toISOString(),
          expiresAt: new Date(
            now.getTime() +
              (this.settings.idempotencyRetentionSeconds ?? 86400) * 1000,
          ),
        };
        try {
          await this.records.insertOne(created);
          record = created;
        } catch (error) {
          if (!isDuplicate(error)) throw error;
          const raced = await this.records.findOne({
            ownerScope: owner,
            routeKey: IMPORT_ROUTE_KEY,
            idempotencyKeyHash: keyHash,
          });
          if (!raced)
            throw new EventError(
              "operation_in_progress",
              409,
              "ICS import is being retried",
            );
          if (raced.expiresAt <= now) {
            const { _id: _createdId, ...replacement } = created;
            const replaced = await this.records.replaceOne(
              { _id: raced._id, expiresAt: { $lte: now } },
              replacement,
            );
            if (replaced.matchedCount === 1) {
              record = { ...created, _id: raced._id };
            } else {
              throw new EventError(
                "import_in_progress",
                409,
                "ICS import is still processing",
              );
            }
          }
          if (!record && raced.requestHash !== requestHash)
            throw new EventError(
              "idempotency_key_reused",
              409,
              "Idempotency key was used for another request",
            );
          if (!record && raced.state === "completed" && raced.responseBody)
            return {
              status:
                raced.responseStatus === 201 ? (201 as const) : (200 as const),
              body: raced.responseBody as ReturnType<typeof summary>,
            };
          if (!record)
            throw new EventError(
              "import_in_progress",
              409,
              "ICS import is still processing",
            );
        }
      }
    }
    const existing = await this.imports.findOne({
      ownerUsername: owner,
      source: "ics",
      contentHash,
      optionsHash,
      status: { $in: ["processing", "active"] },
    });
    if (existing) {
      if (
        existing.status === "processing" &&
        existing.processingLeaseExpiresAt &&
        Date.parse(existing.processingLeaseExpiresAt) > Date.now()
      )
        throw new EventError(
          "import_in_progress",
          409,
          "ICS import is still processing",
        );
      if (existing.status === "active")
        return record
          ? this.finishRecord(record, { status: 200, body: summary(existing) })
          : { status: 200 as const, body: summary(existing) };
    }
    let manifest: WithId<EventImportDocument> = {
      _id: new ObjectId(),
      ownerUsername: owner,
      source: "ics",
      contentHash,
      optionsHash,
      importWindowFrom: window.from,
      importWindowTo: window.to,
      defaultBlocksTime,
      operationId: record?.operationId ?? randomUUID(),
      importedAt: new Date().toISOString(),
      processingLeaseExpiresAt: new Date(
        Date.now() + this.settings.processingLeaseSeconds * 1000,
      ).toISOString(),
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      rejectedCount: 0,
      status: "processing",
    };
    if (existing?.status === "processing") {
      const operationId = record?.operationId ?? randomUUID();
      const claimed = await this.imports.findOneAndUpdate(
        {
          _id: existing._id,
          ownerUsername: owner,
          status: "processing",
          processingLeaseExpiresAt: { $lte: new Date().toISOString() },
        },
        {
          $set: {
            operationId,
            processingLeaseExpiresAt: new Date(
              Date.now() + this.settings.processingLeaseSeconds * 1000,
            ).toISOString(),
          },
        },
        { returnDocument: "after" },
      );
      if (!claimed)
        throw new EventError(
          "import_in_progress",
          409,
          "ICS import is still processing",
        );
      manifest = claimed;
    } else {
      try {
        await this.imports.insertOne(manifest);
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        const raced = await this.imports.findOne({
          ownerUsername: owner,
          source: "ics",
          contentHash,
          optionsHash,
          status: { $in: ["processing", "active"] },
        });
        if (!raced) throw error;
        if (raced.status === "active")
          return { status: 200 as const, body: summary(raced) };
        throw new EventError(
          "import_in_progress",
          409,
          "ICS import is still processing",
        );
      }
    }
    try {
      const parsed = parseIcs(input, {
        timezone: this.settings.timezone,
        ...window,
        defaultBlocksTime,
        maxOccurrences: this.settings.maxOccurrences,
      });
      const rejectCounts = new Map<string, number>();
      for (const item of parsed.rejected)
        rejectCounts.set(
          item.reason,
          (rejectCounts.get(item.reason) ?? 0) + item.count,
        );
      const groups = new Set<string>();
      for (const item of parsed.events) groups.add(item.uid);
      let created = 0;
      for (const item of parsed.events) {
        const row = this.toDocument(owner, manifest, item);
        try {
          await this.events.insertOne(row);
          created += 1;
        } catch (error) {
          if (!isDuplicate(error)) throw error;
          const same = await this.events.findOne({
            ownerUsername: owner,
            source: "ics",
            externalId: item.uid,
            recurrenceId: item.recurrenceId ?? null,
            importId: manifest._id,
          });
          if (!same) throw error;
        }
      }
      const updated = await this.events.countDocuments({
        ownerUsername: owner,
        source: "ics",
        externalId: { $in: [...groups] },
        importId: { $ne: manifest._id },
      });
      const now = new Date().toISOString();
      const result = await this.imports.findOneAndUpdate(
        {
          _id: manifest._id,
          ownerUsername: owner,
          status: "processing",
          operationId: manifest.operationId,
        },
        {
          $set: {
            status: "active",
            activatedAt: now,
            createdCount: created,
            updatedCount: updated,
            skippedCount: parsed.events.length - created,
            rejectedCount: parsed.rejected.reduce(
              (sum, item) => sum + item.count,
              0,
            ),
            rejections: [...rejectCounts].map(([reason, count]) => ({
              reason,
              count,
            })),
          },
          $unset: { processingLeaseExpiresAt: "" },
        },
        { returnDocument: "after" },
      );
      if (!result)
        throw new EventError(
          "import_in_progress",
          409,
          "ICS import changed during activation",
        );
      const response = { status: 201 as const, body: summary(result) };
      return record ? this.finishRecord(record, response) : response;
    } catch (error) {
      await this.imports.updateOne(
        {
          _id: manifest._id,
          ownerUsername: owner,
          status: "processing",
          operationId: manifest.operationId,
        },
        {
          $set: { status: "failed" },
          $unset: { processingLeaseExpiresAt: "" },
        },
      );
      if (record) await this.failRecord(record);
      throw error;
    }
  }

  private toDocument(
    owner: string,
    manifest: EventImportDocument,
    item: ParsedIcsEvent,
  ): WithId<EventDocument> {
    return {
      _id: new ObjectId(),
      ownerUsername: owner,
      title: item.title,
      ...(item.description ? { description: item.description } : {}),
      ...(item.location ? { location: item.location } : {}),
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      ...(item.startDate
        ? { startDate: item.startDate, endDate: item.endDate }
        : {}),
      allDay: item.allDay,
      timezone: item.timezone,
      source: "ics",
      sourceName: "ics",
      externalId: item.uid,
      importId: manifest._id,
      recurrenceId: item.recurrenceId ?? null,
      ...(item.identityQuality
        ? { identityQuality: item.identityQuality }
        : {}),
      ...(item.recurrence ? { recurrence: item.recurrence } : {}),
      ...(item.status ? { recurrenceStatus: item.status } : {}),
      eventType: "other",
      blocksTime: item.blocksTime,
      readonly: true,
      revision: 1,
      createdAt: manifest.importedAt,
      updatedAt: manifest.importedAt,
    };
  }

  async list(owner: string) {
    return (
      await this.imports
        .find({ ownerUsername: owner })
        .sort({ importedAt: -1, _id: -1 })
        .toArray()
    ).map(summary);
  }

  async remove(owner: string, id: string) {
    if (!/^[0-9a-f]{24}$/.test(id))
      throw new EventError("invalid_request", 400, "Invalid import ID");
    const result = await this.imports.findOneAndUpdate(
      {
        _id: new ObjectId(id),
        ownerUsername: owner,
        status: { $in: ["active", "failed", "deleted"] },
      },
      { $set: { status: "deleted" }, $unset: { processingLeaseExpiresAt: "" } },
      { returnDocument: "after" },
    );
    if (!result) {
      const current = await this.imports.findOne({
        _id: new ObjectId(id),
        ownerUsername: owner,
      });
      if (!current) throw new EventError("not_found", 404, "Import not found");
      if (current.status === "processing")
        throw new EventError(
          "import_in_progress",
          409,
          "ICS import is still processing",
        );
    }
    await this.events.deleteMany({
      ownerUsername: owner,
      source: "ics",
      importId: new ObjectId(id),
    });
  }

  async isVisible(owner: string, event: WithId<EventDocument>) {
    if (event.source !== "ics" || !event.importId) return true;
    const effective = await this.activeEvents(owner);
    return effective.some((row) => row._id.equals(event._id));
  }

  async activeEvents(owner: string) {
    const manifests = await this.imports
      .find({ ownerUsername: owner, source: "ics", status: "active" })
      .sort({ activatedAt: -1, _id: -1 })
      .toArray();
    const selected = new Map<string, ObjectId>();
    for (const manifest of manifests) {
      const rows = await this.events
        .find({ ownerUsername: owner, source: "ics", importId: manifest._id })
        .project({ externalId: 1 })
        .toArray();
      for (const row of rows) {
        const uid = String(row.externalId ?? "");
        if (!selected.has(uid)) selected.set(uid, manifest._id);
      }
    }
    if (!selected.size) return [];
    return this.events
      .find({
        ownerUsername: owner,
        source: "ics",
        importId: { $in: [...selected.values()] },
        externalId: { $in: [...selected.keys()] },
      })
      .toArray();
  }

  async effectiveEvents(owner: string, candidates?: WithId<EventDocument>[]) {
    const active = await this.activeEvents(owner);
    if (!candidates) return active;
    const visible = new Set(active.map((row) => row._id.toHexString()));
    return candidates.filter(
      (row) =>
        row.source !== "ics" ||
        !row.importId ||
        visible.has(row._id.toHexString()),
    );
  }

  async calendar(owner: string, window: CalendarWindow, maxItems: number) {
    return expandIcsSeries(await this.activeEvents(owner), window, maxItems);
  }
}
