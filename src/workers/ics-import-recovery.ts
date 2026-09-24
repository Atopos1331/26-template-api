import type { Collection, ObjectId } from "mongodb";
import type {
  EventDocument,
  EventImportDocument,
} from "../plugins/init-mongo.js";

export class IcsImportRecovery {
  constructor(
    private readonly imports: Collection<EventImportDocument>,
    private readonly events: Collection<EventDocument>,
    private readonly graceSeconds: number,
  ) {}

  async runOnce(now = new Date()) {
    const cutoff = new Date(
      now.getTime() - this.graceSeconds * 1000,
    ).toISOString();
    const candidates = await this.imports
      .find({
        status: "processing",
        processingLeaseExpiresAt: { $lte: cutoff },
      })
      .project<{ _id: ObjectId; ownerUsername: string }>({
        _id: 1,
        ownerUsername: 1,
      })
      .toArray();
    let recovered = 0;
    for (const candidate of candidates) {
      const result = await this.imports.updateOne(
        {
          _id: candidate._id,
          status: "processing",
          processingLeaseExpiresAt: { $lte: cutoff },
        },
        {
          $set: { status: "failed" },
          $unset: { processingLeaseExpiresAt: "" },
        },
      );
      if (result.matchedCount !== 1) continue;
      recovered += 1;
      await this.events.deleteMany({
        ownerUsername: candidate.ownerUsername,
        source: "ics",
        importId: candidate._id,
      });
    }
    return recovered;
  }
}
