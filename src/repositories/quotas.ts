import type { Db, Document } from "mongodb";
import { effectiveRemaining } from "../domain/quota.js";
import type { QuotaObservation } from "../providers/ust-quota.js";

export type QuotaSnapshotRecord = QuotaObservation & {
  termCode: string;
  recordedAt?: string;
  projectionStatus?: "pending" | "processing" | "done";
  projectionLeaseExpiresAt?: Date;
  projectionAttempts?: number;
};

export async function enqueueQuotaRefreshJob(
  db: Db,
  source: string,
  termCode: string,
  sectionId: string,
  now = new Date(),
): Promise<boolean> {
  const dedupeKey = `${source}:${termCode}:quota:${sectionId}`;
  const at = now.toISOString();
  try {
    const result = await db.collection("refreshJobs").updateOne(
      { dedupeKey, status: { $in: ["queued", "running", "retryable_failed"] } },
      {
        $setOnInsert: {
          dedupeKey,
          jobType: "section_quota",
          source,
          termCode,
          resourceType: "quota",
          targetId: sectionId,
          status: "queued",
          attempts: 0,
          claimGeneration: 0,
          availableAt: now,
          createdAt: at,
          updatedAt: at,
        },
      },
      { upsert: true },
    );
    return result.upsertedCount === 1;
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
  }
  return false;
}

export async function saveQuotaObservation(
  db: Db,
  termCode: string,
  row: QuotaObservation,
  minIntervalSeconds: number,
  now = new Date(),
): Promise<void> {
  const normalized: QuotaObservation = {
    ...row,
    remaining: effectiveRemaining(row),
  };
  const snapshots = db.collection("quotaSnapshots");
  const key = {
    source: normalized.source,
    sectionId: normalized.sectionId,
    observedAt: normalized.observedAt,
  };
  await snapshots.updateOne(
    key,
    {
      $setOnInsert: {
        ...normalized,
        termCode,
        recordedAt: now.toISOString(),
        projectionStatus: "pending",
        projectionAttempts: 0,
      },
    },
    { upsert: true },
  );
  const latest = db.collection("latestQuotas");
  const target = {
    source: normalized.source,
    sectionId: normalized.sectionId,
  };
  for (;;) {
    const current = await latest.findOne(target);
    if (
      current?.observedAt &&
      Date.parse(current.observedAt) >= Date.parse(normalized.observedAt)
    )
      return;
    const next = {
      ...normalized,
      termCode,
      nextRefreshAt: new Date(
        Date.parse(normalized.observedAt) + minIntervalSeconds * 1000,
      ).toISOString(),
      lastAttemptedAt: now.toISOString(),
      lastRefreshStatus: "succeeded",
      staleSince: null,
      updatedAt: now.toISOString(),
    };
    try {
      const result = current
        ? await latest.updateOne(
            { ...target, observedAt: current.observedAt ?? null },
            { $set: next },
          )
        : await latest.updateOne(
            target,
            { $setOnInsert: next },
            { upsert: true },
          );
      if (result.matchedCount || result.upsertedCount) return;
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
    }
  }
}

export async function recordQuotaFailure(
  db: Db,
  source: string,
  termCode: string,
  sectionId: string,
  nextRefreshAt: Date,
  status: string,
  startedAt: Date,
  now = new Date(),
): Promise<void> {
  const latest = db.collection("latestQuotas");
  const key = { source, sectionId };
  const at = now.toISOString();
  for (;;) {
    const current = await latest.findOne(key);
    if (
      current?.observedAt &&
      Date.parse(current.observedAt) >= startedAt.getTime()
    )
      return;
    const patch = {
      lastAttemptedAt: at,
      nextRefreshAt: nextRefreshAt.toISOString(),
      lastRefreshStatus: status,
      staleSince: at,
      updatedAt: at,
    };
    try {
      const result = current
        ? await latest.updateOne(
            {
              ...key,
              observedAt: current.observedAt ?? null,
              lastAttemptedAt: current.lastAttemptedAt ?? null,
            },
            { $set: patch },
          )
        : await latest.updateOne(
            key,
            {
              $setOnInsert: {
                ...key,
                termCode,
                snapshotId: null,
                capacity: null,
                enrolled: null,
                remaining: null,
                waitlisted: null,
                reserveCapacity: null,
                open: null,
                observedAt: null,
              },
              $set: patch,
            },
            { upsert: true },
          );
      if (result.matchedCount || result.upsertedCount) return;
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
    }
  }
}

export async function quotaSnapshots(
  db: Db,
  source: string,
  sectionId: string,
  options: { from?: Date; to?: Date; limit?: number } = {},
): Promise<QuotaSnapshotRecord[]> {
  const query: Document = { source, sectionId };
  if (options.from || options.to) {
    query.observedAt = {
      ...(options.from ? { $gte: options.from.toISOString() } : {}),
      ...(options.to ? { $lte: options.to.toISOString() } : {}),
    };
  }
  return (await db
    .collection<QuotaSnapshotRecord>("quotaSnapshots")
    .find(query)
    .sort({ observedAt: -1, snapshotId: -1 })
    .limit(options.limit ?? 5000)
    .toArray()) as QuotaSnapshotRecord[];
}
