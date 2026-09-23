import { type Collection, type Filter, ObjectId, type WithId } from "mongodb";
import { EventError } from "../domain/events.js";
import type { EventDocument } from "../plugins/init-mongo.js";

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
};

export class EventRepository {
  constructor(private readonly events: Collection<EventDocument>) {}

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
