import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  type Collection,
  MongoServerError,
  ObjectId,
  type WithId,
} from "mongodb";
import {
  EventError,
  eventResponse,
  normalizeEvent,
  normalizePatch,
  sameCreateFields,
} from "../domain/events.js";
import { formatRevisionEtag } from "../domain/revision.js";
import type {
  EventDocument,
  IdempotencyRecordDocument,
} from "../plugins/init-mongo.js";
import {
  type EventFilters,
  type EventRepository,
  eventId,
} from "../repositories/events.js";

type EventBody = {
  data: ReturnType<typeof eventResponse>;
  meta: Record<string, never>;
};
type CreationResult = { status: 200 | 201; body: EventBody };
type CursorPayload = {
  owner: string;
  filters: EventFilters;
  startsAt: string;
  id: string;
  evaluatedAt: number;
  expiresAt: number;
};

type EventSettings = {
  timezone: string;
  maxSpanDays: number;
  cursorKey: string;
  cursorTtlSeconds: number;
  idempotencyRetentionSeconds: number;
};

const ROUTE_KEY = "POST /events";
const PROCESSING_LEASE_MS = 120_000;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isDuplicate(error: unknown) {
  return error instanceof MongoServerError && error.code === 11000;
}

function idempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value)) {
    throw new EventError(
      "invalid_request",
      400,
      "Invalid Idempotency-Key header",
    );
  }
  return value;
}

export class EventService {
  constructor(
    private readonly events: EventRepository,
    private readonly records: Collection<IdempotencyRecordDocument>,
    private readonly settings: EventSettings,
  ) {}

  private sign(payload: string) {
    return createHmac("sha256", this.settings.cursorKey)
      .update(payload)
      .digest("base64url");
  }

  private encodeCursor(payload: CursorPayload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  private decodeCursor(token: string, owner: string, filters: EventFilters) {
    if (
      token.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    ) {
      throw new EventError("invalid_cursor", 400, "Invalid cursor");
    }
    const [encoded, signature] = token.split(".") as [string, string];
    const expected = Buffer.from(this.sign(encoded));
    const supplied = Buffer.from(signature);
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    ) {
      throw new EventError("invalid_cursor", 400, "Invalid cursor");
    }
    try {
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString(),
      ) as CursorPayload;
      if (
        payload.owner !== owner ||
        JSON.stringify(payload.filters) !== JSON.stringify(filters) ||
        !Number.isSafeInteger(payload.evaluatedAt) ||
        payload.evaluatedAt > Date.now() ||
        !Number.isSafeInteger(payload.expiresAt) ||
        payload.expiresAt !==
          payload.evaluatedAt + this.settings.cursorTtlSeconds * 1000 ||
        payload.expiresAt <= Date.now() ||
        typeof payload.startsAt !== "string"
      ) {
        throw new Error("cursor mismatch");
      }
      return {
        startsAt: payload.startsAt,
        id: eventId(payload.id),
        evaluatedAt: payload.evaluatedAt,
      };
    } catch {
      throw new EventError("invalid_cursor", 400, "Invalid cursor");
    }
  }

  async list(
    owner: string,
    filters: EventFilters,
    limit: number,
    cursor?: string,
  ) {
    const after =
      cursor === undefined
        ? undefined
        : this.decodeCursor(cursor, owner, filters);
    const evaluatedAt = after?.evaluatedAt ?? Date.now();
    const rows = await this.events.list(owner, filters, limit, after);
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(eventResponse),
      page: {
        hasMore: rows.length > limit,
        nextCursor:
          rows.length > limit && last
            ? this.encodeCursor({
                owner,
                filters,
                startsAt: last.startsAt,
                id: last._id.toHexString(),
                evaluatedAt,
                expiresAt: evaluatedAt + this.settings.cursorTtlSeconds * 1000,
              })
            : null,
      },
      meta: {},
    };
  }

  async get(owner: string, id: string) {
    const event = await this.events.findById(owner, eventId(id));
    if (!event) throw new EventError("not_found", 404, "Event not found");
    return event;
  }

  private async insertOrReuse(
    owner: string,
    event: WithId<EventDocument>,
    normalized: ReturnType<typeof normalizeEvent>,
  ): Promise<CreationResult> {
    try {
      await this.events.insert(event);
      return { status: 201, body: { data: eventResponse(event), meta: {} } };
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const sameOperation = await this.events.findByOperation(
        owner,
        event.operationId!,
      );
      if (sameOperation) {
        return {
          status: 201,
          body: { data: eventResponse(sameOperation), meta: {} },
        };
      }
      if (normalized.externalId) {
        const existing = await this.events.findByExternalId(
          owner,
          normalized.externalId,
        );
        if (existing) {
          if (!sameCreateFields(existing, normalized)) {
            throw new EventError(
              "external_id_conflict",
              409,
              "External ID already belongs to another event",
            );
          }
          return {
            status: 200,
            body: { data: eventResponse(existing), meta: {} },
          };
        }
      }
      throw error;
    }
  }

  private async finishRecord(
    record: WithId<IdempotencyRecordDocument>,
    result: CreationResult,
  ) {
    const completed = await this.records.updateOne(
      {
        _id: record._id,
        ownerScope: record.ownerScope,
        operationId: record.operationId,
        requestHash: record.requestHash,
        state: "processing",
      },
      {
        $set: {
          state: "completed",
          responseStatus: result.status,
          responseBody: result.body,
          resourceId: new ObjectId(result.body.data.id),
        },
        $unset: { leaseExpiresAt: "" },
      },
    );
    if (completed.matchedCount !== 1) {
      const latest = await this.records.findOne({ _id: record._id });
      if (
        latest?.state === "completed" &&
        latest.operationId === record.operationId &&
        latest.requestHash === record.requestHash
      ) {
        return {
          status: latest.responseStatus as 200 | 201,
          body: latest.responseBody as EventBody,
        };
      }
      throw new EventError(
        "operation_in_progress",
        409,
        "Create is being retried",
      );
    }
    return result;
  }

  private async resumeRecord(
    owner: string,
    record: WithId<IdempotencyRecordDocument>,
    normalized: ReturnType<typeof normalizeEvent>,
  ): Promise<CreationResult> {
    if (record.state === "completed") {
      if (
        !record.responseBody ||
        ![200, 201].includes(record.responseStatus ?? 0)
      ) {
        throw new Error("Completed idempotency record has no response");
      }
      return {
        status: record.responseStatus as 200 | 201,
        body: record.responseBody as EventBody,
      };
    }
    const committed = await this.events.findByOperation(
      owner,
      record.operationId!,
    );
    if (committed) {
      if (!record.responseBody)
        throw new Error("Processing idempotency record has no response");
      const saved = record.responseBody as EventBody;
      return this.finishRecord(record, { status: 201, body: saved });
    }
    const now = new Date();
    if (record.leaseExpiresAt && record.leaseExpiresAt > now.toISOString()) {
      throw new EventError(
        "operation_in_progress",
        409,
        "Create is still in progress",
      );
    }
    const claimed = await this.records.updateOne(
      {
        _id: record._id,
        ownerScope: owner,
        state: "processing",
        operationId: record.operationId,
        leaseExpiresAt: record.leaseExpiresAt,
      },
      {
        $set: {
          leaseExpiresAt: new Date(
            now.getTime() + PROCESSING_LEASE_MS,
          ).toISOString(),
        },
      },
    );
    if (claimed.matchedCount !== 1) {
      throw new EventError(
        "operation_in_progress",
        409,
        "Create is still in progress",
      );
    }
    const event: WithId<EventDocument> = {
      _id: record.resourceId!,
      ownerUsername: owner,
      ...normalized,
      revision: 1,
      operationId: record.operationId,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
    };
    const result = await this.insertOrReuse(owner, event, normalized);
    return this.finishRecord(record, result);
  }

  async create(
    owner: string,
    input: unknown,
    keyHeader?: unknown,
  ): Promise<CreationResult> {
    const normalized = normalizeEvent(
      input,
      this.settings.timezone,
      this.settings.maxSpanDays,
    );
    const key = idempotencyKey(keyHeader);
    const now = new Date();
    const operationId = randomUUID();
    const event: WithId<EventDocument> = {
      _id: new ObjectId(),
      ownerUsername: owner,
      ...normalized,
      revision: 1,
      operationId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    if (!key) return this.insertOrReuse(owner, event, normalized);

    const requestHash = hash(JSON.stringify(normalized));
    const record: WithId<IdempotencyRecordDocument> = {
      _id: new ObjectId(),
      ownerScope: owner,
      routeKey: ROUTE_KEY,
      idempotencyKeyHash: hash(key),
      requestHash,
      operationId,
      resourceId: event._id,
      state: "processing",
      responseStatus: 201,
      responseBody: { data: eventResponse(event), meta: {} },
      leaseExpiresAt: new Date(
        now.getTime() + PROCESSING_LEASE_MS,
      ).toISOString(),
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.settings.idempotencyRetentionSeconds * 1000,
      ),
    };
    try {
      await this.records.insertOne(record);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const existing = await this.records.findOne({
        ownerScope: owner,
        routeKey: ROUTE_KEY,
        idempotencyKeyHash: record.idempotencyKeyHash,
      });
      if (!existing) {
        throw new EventError(
          "operation_in_progress",
          409,
          "Create is being retried",
        );
      }
      if (existing.expiresAt <= now) {
        const { _id: _oldId, ...replacement } = record;
        const replaced = await this.records.replaceOne(
          { _id: existing._id, expiresAt: { $lte: now } },
          replacement,
        );
        if (replaced.matchedCount !== 1) {
          throw new EventError(
            "operation_in_progress",
            409,
            "Create is being retried",
          );
        }
        record._id = existing._id;
      } else {
        if (existing.requestHash !== requestHash) {
          throw new EventError(
            "idempotency_key_reused",
            409,
            "Idempotency key was used for another request",
          );
        }
        return this.resumeRecord(owner, existing, normalized);
      }
    }
    const result = await this.insertOrReuse(owner, event, normalized);
    return this.finishRecord(record, result);
  }

  async patch(owner: string, id: string, revision: number, input: unknown) {
    const current = await this.get(owner, id);
    if (current.readonly || current.source !== "manual") {
      throw new EventError("readonly_resource", 409, "Event is read-only");
    }
    if (current.revision !== revision) {
      throw new EventError(
        "concurrent_modification",
        409,
        "Event has changed",
        {
          currentRevision: String(current.revision),
        },
      );
    }
    const normalized = normalizePatch(
      current,
      input,
      this.settings.timezone,
      this.settings.maxSpanDays,
    );
    const updated: WithId<EventDocument> = {
      _id: current._id,
      ownerUsername: owner,
      ...normalized,
      revision: current.revision + 1,
      operationId: current.operationId,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (!(await this.events.replace(owner, current, updated))) {
      const latest = await this.events.findById(owner, current._id);
      if (!latest) throw new EventError("not_found", 404, "Event not found");
      throw new EventError(
        "concurrent_modification",
        409,
        "Event has changed",
        {
          currentRevision: String(latest.revision),
        },
      );
    }
    return updated;
  }

  async remove(owner: string, id: string, revision: number) {
    const current = await this.get(owner, id);
    if (current.readonly || current.source !== "manual") {
      throw new EventError("readonly_resource", 409, "Event is read-only");
    }
    if (current.revision !== revision) {
      throw new EventError(
        "concurrent_modification",
        409,
        "Event has changed",
        {
          currentRevision: String(current.revision),
        },
      );
    }
    if (!(await this.events.remove(owner, current))) {
      const latest = await this.events.findById(owner, current._id);
      if (!latest) throw new EventError("not_found", 404, "Event not found");
      throw new EventError(
        "concurrent_modification",
        409,
        "Event has changed",
        {
          currentRevision: String(latest.revision),
        },
      );
    }
    return formatRevisionEtag(current.revision);
  }
}
