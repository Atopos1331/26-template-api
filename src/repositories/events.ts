import { type Collection, type Filter, ObjectId, type WithId } from "mongodb";
import type { CalendarWindow } from "../domain/calendar.js";
import { EventError } from "../domain/events.js";
import type {
  EventDocument,
  EventImportDocument,
} from "../plugins/init-mongo.js";

export function eventId(id: string): ObjectId {
  if (!/^[0-9a-f]{24}$/.test(id)) {
    throw new EventError("invalid_request", 400, "Invalid event ID", {
      id: "must be a lowercase 24-character ObjectId",
    });
  }
  return new ObjectId(id);
}

export type EventFilters = {
  source?: string;
  eventType?: EventDocument["eventType"];
  readonly?: boolean;
  window?: CalendarWindow;
};

export class EventRepository {
  constructor(
    private readonly events: Collection<EventDocument>,
    private readonly imports?: Collection<EventImportDocument>,
  ) {}

  async insert(event: WithId<EventDocument>) {
    await this.events.insertOne(event);
  }

  findById(ownerUsername: string, id: ObjectId) {
    return this.events.findOne({ _id: id, ownerUsername });
  }

  findByExternalId(ownerUsername: string, externalId: string) {
    return this.events.findOne({ ownerUsername, source: "manual", externalId });
  }

  findByOperation(ownerUsername: string, operationId: string) {
    return this.events.findOne({ ownerUsername, operationId });
  }

  async list(
    ownerUsername: string,
    filters: EventFilters,
    limit: number,
    after?: { startsAt: string; id: ObjectId },
  ) {
    const query: Filter<EventDocument> = {
      ownerUsername,
      ...(filters.source === undefined ? {} : { source: filters.source }),
      ...(filters.eventType === undefined
        ? {}
        : { eventType: filters.eventType }),
      ...(filters.readonly === undefined ? {} : { readonly: filters.readonly }),
      ...(filters.window === undefined
        ? {}
        : {
            $and: [
              { startsAt: { $lt: filters.window.to } },
              {
                $or: [
                  { endsAt: { $gt: filters.window.from } },
                  { recurrence: { $exists: true } },
                ],
              },
            ],
          }),
      ...(after === undefined
        ? {}
        : {
            $or: [
              { startsAt: { $gt: after.startsAt } },
              { startsAt: after.startsAt, _id: { $gt: after.id } },
            ],
          }),
    };
    return this.events
      .find(query)
      .sort({ startsAt: 1, _id: 1 })
      .limit(limit + 1)
      .toArray();
  }

  calendarCandidates(ownerUsername: string, window: CalendarWindow) {
    return this.events.find({
      ownerUsername,
      source: "manual",
      startsAt: { $lt: window.to },
      $or: [
        { endsAt: { $gt: window.from } },
        { recurrence: { $exists: true } },
      ],
    });
  }

  importedCalendarCandidates(ownerUsername: string, window: CalendarWindow) {
    return this.events.find({
      ownerUsername,
      source: "ics",
      startsAt: { $lt: window.to },
      $or: [
        { endsAt: { $gt: window.from } },
        { recurrence: { $exists: true } },
      ],
    });
  }

  async activeImportedEvents(ownerUsername: string) {
    if (!this.imports) return [];
    const manifests = await this.imports
      .find({ ownerUsername, source: "ics", status: "active" })
      .sort({ activatedAt: -1, _id: -1 })
      .toArray();
    const selected = new Map<string, ObjectId>();
    for (const manifest of manifests) {
      const rows = await this.events
        .find({ ownerUsername, source: "ics", importId: manifest._id })
        .project<{ externalId?: string }>({ externalId: 1 })
        .toArray();
      for (const row of rows) {
        const uid = String(row.externalId ?? "");
        if (!selected.has(uid)) selected.set(uid, manifest._id);
      }
    }
    if (!selected.size) return [];
    return this.events
      .find({
        ownerUsername,
        source: "ics",
        importId: { $in: [...selected.values()] },
        externalId: { $in: [...selected.keys()] },
      })
      .toArray();
  }

  async suppressedKeys(ownerUsername: string) {
    const rows = await this.events
      .find({
        ownerUsername,
        source: "manual",
        supersedesCalendarKey: { $type: "string" },
      })
      .project<{ supersedesCalendarKey: string }>({
        supersedesCalendarKey: 1,
        _id: 0,
      })
      .toArray();
    return rows.map((row) => row.supersedesCalendarKey);
  }

  async replace(
    ownerUsername: string,
    current: WithId<EventDocument>,
    next: WithId<EventDocument>,
  ) {
    const result = await this.events.replaceOne(
      {
        _id: current._id,
        ownerUsername,
        source: "manual",
        readonly: false,
        revision: current.revision,
      },
      next,
    );
    return result.matchedCount === 1;
  }

  async remove(ownerUsername: string, current: WithId<EventDocument>) {
    const result = await this.events.deleteOne({
      _id: current._id,
      ownerUsername,
      source: "manual",
      readonly: false,
      revision: current.revision,
    });
    return result.deletedCount === 1;
  }
}
