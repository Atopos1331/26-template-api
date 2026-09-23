import type { Collection, Filter, ObjectId, WithId } from "mongodb";
import type { CoursePlanDocument } from "../plugins/init-mongo.js";

export class CoursePlanRepository {
  constructor(private readonly plans: Collection<CoursePlanDocument>) {}

  findById(ownerUsername: string, id: ObjectId) {
    return this.plans.findOne({ _id: id, ownerUsername });
  }

  async list(
    ownerUsername: string,
    options: {
      limit: number;
      termCode?: string;
      status?: CoursePlanDocument["status"];
      after?: { updatedAt: string; id: ObjectId };
    },
  ) {
    const query: Filter<CoursePlanDocument> = {
      ownerUsername,
      ...(options.termCode === undefined ? {} : { termCode: options.termCode }),
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.after === undefined
        ? {}
        : {
            $or: [
              { updatedAt: { $lt: options.after.updatedAt } },
              {
                updatedAt: options.after.updatedAt,
                _id: { $lt: options.after.id },
              },
            ],
          }),
    };
    return this.plans
      .find(query)
      .sort({ updatedAt: -1, _id: -1 })
      .limit(options.limit + 1)
      .toArray();
  }

  insert(plan: WithId<CoursePlanDocument>) {
    return this.plans.insertOne(plan);
  }

  async compareAndSet(
    ownerUsername: string,
    id: ObjectId,
    revision: number,
    updates: Partial<CoursePlanDocument>,
  ) {
    const result = await this.plans.updateOne(
      { _id: id, ownerUsername, revision },
      { $set: updates, $inc: { revision: 1 } },
    );
    return result.matchedCount === 1;
  }

  async updateStatus(
    ownerUsername: string,
    id: ObjectId,
    revision: number,
    status: CoursePlanDocument["status"],
    updatedAt: string,
  ) {
    return this.compareAndSet(ownerUsername, id, revision, {
      status,
      updatedAt,
    });
  }
}
