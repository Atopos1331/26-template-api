import type { Db } from "mongodb";
import type { QuotaObservation } from "../providers/ust-quota.js";

export async function saveQuotaObservation(
  db: Db,
  termCode: string,
  row: QuotaObservation,
  minIntervalSeconds: number,
): Promise<void> {
  const snapshots = db.collection("quotaSnapshots");
  const key = {
    source: row.source,
    sectionId: row.sectionId,
    observedAt: row.observedAt,
  };
  await snapshots.updateOne(
    key,
    {
      $setOnInsert: {
        ...row,
        termCode,
        recordedAt: new Date().toISOString(),
        projectionStatus: "pending",
        projectionAttempts: 0,
      },
    },
    { upsert: true },
  );
  const latest = db.collection("latestQuotas");
  const target = { source: row.source, sectionId: row.sectionId };
  for (;;) {
    const current = await latest.findOne(target);
    if (
      current?.observedAt &&
      Date.parse(current.observedAt) >= Date.parse(row.observedAt)
    )
      return;
    const next = {
      ...row,
      termCode,
      nextRefreshAt: new Date(
        Date.parse(row.observedAt) + minIntervalSeconds * 1000,
      ).toISOString(),
      lastAttemptedAt: new Date().toISOString(),
      lastRefreshStatus: "succeeded",
      staleSince: null,
      updatedAt: new Date().toISOString(),
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
): Promise<void> {
  const latest = db.collection("latestQuotas");
  const key = { source, sectionId };
  const at = new Date().toISOString();
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
