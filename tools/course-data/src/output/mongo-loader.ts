import { createHash, randomUUID } from "node:crypto";
import type { Db, Document } from "mongodb";
import type { CourseData, Quota, Resource } from "../contract.ts";
import { validate } from "../contract.ts";

const collections = {
  courses: "courses",
  offerings: "courseOfferings",
  sections: "classSections",
  bundles: "sectionBundles",
} as const;
const identities = {
  courses: "courseId",
  offerings: "offeringId",
  sections: "sectionId",
  bundles: "bundleId",
} as const;
const resources = Object.keys(collections) as Resource[];

export type LoadOptions = {
  importBatchId?: string;
  trigger?: "operator" | "scheduled";
  minExpectedRecords?: number;
  maxDropFraction?: number;
  allowDestructiveReconciliation?: boolean;
  leaseMs?: number;
  afterActivation?: () => Promise<void>;
};

export async function ensureAcademicIndexes(db: Db): Promise<void> {
  await db
    .collection("academicTerms")
    .createIndex(
      { source: 1, termCode: 1 },
      { unique: true, name: "academic_term_identity" },
    );
  await db.collection("academicTerms").createIndex({ activeImportBatchId: 1 });
  await db.collection("academicTerms").createIndex({ sortKey: -1 });
  for (const resource of resources) {
    const id = identities[resource];
    await db
      .collection(collections[resource])
      .createIndex(
        { source: 1, termCode: 1, [id]: 1, importBatchId: 1 },
        { unique: true, name: `${resource}_batch_identity` },
      );
    await db
      .collection(collections[resource])
      .createIndex(
        { source: 1, termCode: 1, importBatchId: 1, retiredAt: 1 },
        { name: `${resource}_active_batch` },
      );
  }
  await db
    .collection("quotaSnapshots")
    .createIndex(
      { source: 1, sectionId: 1, observedAt: 1 },
      { unique: true, name: "quota_observation_identity" },
    );
  await db
    .collection("quotaSnapshots")
    .createIndex({ sectionId: 1, observedAt: -1 });
  await db
    .collection("latestQuotas")
    .createIndex(
      { source: 1, sectionId: 1 },
      { unique: true, name: "latest_quota_identity" },
    );
  await db
    .collection("importRuns")
    .createIndex(
      { importBatchId: 1 },
      { unique: true, name: "import_batch_identity" },
    );
  await db
    .collection("importRuns")
    .createIndex({ source: 1, termCode: 1, status: 1 });
  await db
    .collection("refreshLeases")
    .createIndex(
      { leaseKey: 1 },
      { unique: true, name: "refresh_lease_identity" },
    );
  await db
    .collection("importQuotaStaging")
    .createIndex(
      { importBatchId: 1, snapshotId: 1 },
      { unique: true, name: "staged_quota_identity" },
    );
}

function hash(data: CourseData): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

async function claimTerm(
  db: Db,
  data: CourseData,
  owner: string,
  leaseMs: number,
) {
  const terms = db.collection("academicTerms");
  const key = { source: data.source, termCode: data.term.termCode };
  await terms.updateOne(
    key,
    {
      $setOnInsert: {
        ...key,
        importFence: 0,
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
  const now = new Date();
  const claimed = await terms.findOneAndUpdate(
    {
      ...key,
      $or: [
        { importLeaseExpiresAt: { $lte: now } },
        { importLeaseExpiresAt: { $exists: false } },
      ],
    },
    {
      $inc: { importFence: 1 },
      $set: {
        importLeaseOwner: owner,
        importLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        lastAttemptedImportAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed) throw new Error("IMPORT_LEASE_BUSY");
  return claimed;
}

async function projectQuota(
  db: Db,
  data: CourseData,
  row: Quota,
): Promise<void> {
  const snapshots = db.collection("quotaSnapshots");
  await snapshots.updateOne(
    {
      source: row.source,
      sectionId: row.sectionId,
      observedAt: row.observedAt,
    },
    {
      $setOnInsert: {
        ...row,
        termCode: data.term.termCode,
        recordedAt: new Date().toISOString(),
        projectionStatus: "pending",
        projectionAttempts: 0,
      },
    },
    { upsert: true },
  );
  const latest = db.collection("latestQuotas");
  const key = { source: row.source, sectionId: row.sectionId };
  for (;;) {
    const current = await latest.findOne(key);
    if (
      current?.observedAt &&
      Date.parse(current.observedAt) >= Date.parse(row.observedAt)
    )
      break;
    const next = {
      ...row,
      termCode: data.term.termCode,
      lastRefreshStatus: "succeeded",
      updatedAt: new Date().toISOString(),
    };
    try {
      const result = current
        ? await latest.updateOne(
            { ...key, observedAt: current.observedAt ?? null },
            { $set: next },
          )
        : await latest.updateOne(key, { $setOnInsert: next }, { upsert: true });
      if (result.matchedCount || result.upsertedCount) break;
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

async function finishActivated(
  db: Db,
  data: CourseData,
  batchId: string,
): Promise<void> {
  const key = { source: data.source, termCode: data.term.termCode };
  const term = await db.collection("academicTerms").findOne(key);
  if (term?.activeImportBatchId !== batchId)
    throw new Error("ACTIVE_BATCH_CHANGED");
  const staged = db.collection("importQuotaStaging");
  for await (const doc of staged.find({ importBatchId: batchId })) {
    const { _id, importBatchId, ...row } = doc;
    await projectQuota(db, data, row as Quota);
  }
  await db
    .collection("importRuns")
    .updateOne(
      { importBatchId: batchId, status: { $in: ["activated", "succeeded"] } },
      { $set: { status: "succeeded", finishedAt: new Date().toISOString() } },
    );
  await staged.deleteMany({ importBatchId: batchId });
}

async function stageResource(
  db: Db,
  data: CourseData,
  name: Resource,
  batchId: string,
  previous: string | null,
  at: string,
): Promise<void> {
  const collection = db.collection(collections[name]);
  const key = { source: data.source, termCode: data.term.termCode };
  const id = identities[name];
  const incoming = new Map<string, Document>();
  for (const row of data[name])
    incoming.set(String(row[id as keyof typeof row]), row);
  const last = previous
    ? await collection.find({ ...key, importBatchId: previous }).toArray()
    : [];
  for (const prior of last) {
    const priorId = String(prior[id]);
    if (incoming.has(priorId)) continue;
    const { _id, importBatchId, ...copy } = prior;
    const retiredAt =
      data.resourceCoverage[name] === "complete"
        ? (prior.retiredAt ?? at)
        : prior.retiredAt;
    await collection.updateOne(
      { ...key, [id]: priorId, importBatchId: batchId },
      {
        $setOnInsert: {
          ...copy,
          importBatchId: batchId,
          ...(retiredAt ? { retiredAt } : {}),
        },
      },
      { upsert: true },
    );
  }
  for (const [value, row] of incoming) {
    await collection.updateOne(
      { ...key, [id]: value, importBatchId: batchId },
      {
        $setOnInsert: {
          ...row,
          ...key,
          importBatchId: batchId,
          retiredAt: null,
          updatedAt: at,
          lastSuccessfulImportAt: at,
          lastAttemptedImportAt: at,
          lastImportStatus: "succeeded",
        },
      },
      { upsert: true },
    );
  }
}

async function validateStaging(
  db: Db,
  data: CourseData,
  batchId: string,
): Promise<void> {
  const key = {
    source: data.source,
    termCode: data.term.termCode,
    importBatchId: batchId,
    retiredAt: null,
  };
  const [courses = [], offerings = [], sections = [], bundles = []] =
    await Promise.all(
      resources.map((name) =>
        db.collection(collections[name]).find(key).toArray(),
      ),
    );
  const courseIds = new Set(courses.map((row) => row.courseId));
  const offeringIds = new Set(offerings.map((row) => row.offeringId));
  const sectionIds = new Set(sections.map((row) => row.sectionId));
  if (
    offerings.some((row) => !courseIds.has(row.courseId)) ||
    sections.some((row) => !offeringIds.has(row.offeringId)) ||
    bundles.some(
      (row) =>
        !offeringIds.has(row.offeringId) ||
        row.componentClassNbrs.some(
          (nbr: string) =>
            !sectionIds.has(`${row.offeringId}:${encodeURIComponent(nbr)}`),
        ),
    )
  )
    throw new Error("STAGED_REFERENCE_INVALID");
}

export async function loadBatch(
  db: Db,
  input: unknown,
  options: LoadOptions = {},
): Promise<string> {
  validate(input);
  const data = structuredClone(input);
  data.generatedAt = new Date(data.generatedAt).toISOString();
  for (const row of data.quotaSnapshots) {
    row.observedAt = new Date(row.observedAt).toISOString();
    row.snapshotId = `${row.sectionId}@${row.observedAt}`;
  }
  validate(data);
  const batchId = options.importBatchId ?? randomUUID();
  const fingerprint = hash(data);
  await ensureAcademicIndexes(db);
  const runs = db.collection("importRuns");
  const existing = await runs.findOne({ importBatchId: batchId });
  if (existing && existing.inputHash !== fingerprint)
    throw new Error("BATCH_ID_REUSED");
  if (existing?.status === "succeeded") return batchId;
  if (existing && ["ready", "activated"].includes(existing.status)) {
    const active = await db
      .collection("academicTerms")
      .findOne({ source: data.source, termCode: data.term.termCode });
    if (active?.activeImportBatchId === batchId) {
      await runs.updateOne(
        { importBatchId: batchId },
        { $set: { status: "activated" } },
      );
      await finishActivated(db, data, batchId);
      return batchId;
    }
  }
  if (existing?.status === "activated") {
    await finishActivated(db, data, batchId);
    return batchId;
  }
  const leaseMs = options.leaseMs ?? 120_000;
  const owner = randomUUID();
  const claimed = await claimTerm(db, data, owner, leaseMs);
  const fence = claimed.importFence as number;
  const key = { source: data.source, termCode: data.term.termCode };
  const previous = (claimed.activeImportBatchId as string | undefined) ?? null;
  let live = true;
  const heartbeat = setInterval(
    async () => {
      if (!live) return;
      try {
        const renewed = await db
          .collection("academicTerms")
          .updateOne(
            { ...key, importLeaseOwner: owner, importFence: fence },
            { $set: { importLeaseExpiresAt: new Date(Date.now() + leaseMs) } },
          );
        if (!renewed.matchedCount) live = false;
      } catch {
        live = false;
      }
    },
    Math.max(100, Math.floor(leaseMs / 3)),
  );
  try {
    if (existing && existing.previousActiveBatchId !== previous)
      throw new Error("STAGED_BASE_CHANGED");
    if (!previous && !data.isCompleteSnapshot)
      throw new Error("FIRST_BATCH_REQUIRES_COMPLETE_STRUCTURE");
    if (
      data.sourceRecordCount < (options.minExpectedRecords ?? 1) &&
      data.isCompleteSnapshot
    )
      throw new Error("SUSPICIOUS_EMPTY_IMPORT");
    const priorRun = previous
      ? await runs.findOne({ importBatchId: previous })
      : null;
    const baseline = {
      ...(priorRun?.lastCompleteSourceCounts ?? {}),
    } as Record<string, number>;
    for (const name of resources) {
      if (data.resourceCoverage[name] !== "complete") continue;
      const count = data[name].length;
      const last = baseline[name];
      if (
        last &&
        count < last * (1 - (options.maxDropFraction ?? 0.5)) &&
        !options.allowDestructiveReconciliation
      )
        throw new Error(`SUSPICIOUS_${name.toUpperCase()}_DROP`);
      baseline[name] = count;
    }
    const metadata =
      data.termMetadataCoverage === "unavailable" && previous
        ? (priorRun?.termMetadataSnapshot ?? data.term)
        : data.termMetadataCoverage === "partial" && previous
          ? { ...(priorRun?.termMetadataSnapshot ?? {}), ...data.term }
          : {
              ...data.term,
              providerCurrent: data.term.providerCurrent ?? false,
              providerSelectable: data.term.providerSelectable ?? false,
            };
    const at = new Date().toISOString();
    await runs.updateOne(
      { importBatchId: batchId },
      {
        $setOnInsert: {
          importBatchId: batchId,
          inputHash: fingerprint,
          ...key,
          resourceType: "term",
          trigger: options.trigger ?? "operator",
          status: "running",
          previousActiveBatchId: previous,
          leaseFence: fence,
          termMetadataSnapshot: metadata,
          termMetadataCoverage: data.termMetadataCoverage,
          resourceCoverage: data.resourceCoverage,
          resourceCounts: Object.fromEntries(
            resources.map((name) => [name, data[name].length]),
          ),
          lastCompleteSourceCounts: baseline,
          pageTotals: data.pageTotals ?? {},
          startedAt: at,
          recordsRead: data.sourceRecordCount,
          warnings: data.warnings ?? [],
          errors: [],
        },
      },
      { upsert: true },
    );
    for (const name of resources)
      await stageResource(db, data, name, batchId, previous, at);
    for (const row of data.quotaSnapshots)
      await db
        .collection("importQuotaStaging")
        .updateOne(
          { importBatchId: batchId, snapshotId: row.snapshotId },
          { $setOnInsert: { ...row, importBatchId: batchId } },
          { upsert: true },
        );
    await runs.updateOne(
      { importBatchId: batchId },
      { $set: { status: "staged" } },
    );
    await validateStaging(db, data, batchId);
    await runs.updateOne(
      { importBatchId: batchId },
      { $set: { status: "ready" } },
    );
    if (!live) throw new Error("IMPORT_LEASE_LOST");
    const result = await db.collection("academicTerms").updateOne(
      {
        ...key,
        importLeaseOwner: owner,
        importFence: fence,
        activeImportBatchId: previous ?? { $exists: false },
        importLeaseExpiresAt: { $gt: new Date() },
      },
      {
        $set: {
          ...metadata,
          activeImportBatchId: batchId,
          lastImportBatchId: batchId,
          lastSuccessfulImportAt: at,
          lastImportStatus: "succeeded",
          updatedAt: at,
          lastSeenAt: at,
        },
      },
    );
    if (!result.matchedCount) throw new Error("IMPORT_ACTIVATION_FENCE_FAILED");
    await runs.updateOne(
      { importBatchId: batchId },
      {
        $set: {
          status: "activated",
          recordsWritten: resources.reduce(
            (sum, name) => sum + data[name].length,
            0,
          ),
        },
      },
    );
    await options.afterActivation?.();
    await finishActivated(db, data, batchId);
    return batchId;
  } catch (error) {
    const active = await db.collection("academicTerms").findOne(key);
    if (active?.activeImportBatchId !== batchId)
      await runs.updateOne(
        { importBatchId: batchId, status: { $ne: "succeeded" } },
        {
          $set: {
            status: "retryable_failed",
            errors: [
              error instanceof Error && /^[A-Z_]+$/.test(error.message)
                ? error.message
                : "IMPORT_FAILED",
            ],
          },
        },
      );
    throw error;
  } finally {
    clearInterval(heartbeat);
    await db
      .collection("academicTerms")
      .updateOne(
        { ...key, importLeaseOwner: owner, importFence: fence },
        { $unset: { importLeaseOwner: "", importLeaseExpiresAt: "" } },
      );
  }
}

export async function rollbackBatch(
  db: Db,
  source: string,
  termCode: string,
  targetBatchId: string,
): Promise<void> {
  const run = await db.collection("importRuns").findOne({
    importBatchId: targetBatchId,
    source,
    termCode,
    status: "succeeded",
  });
  if (!run) throw new Error("ROLLBACK_TARGET_INVALID");
  if (
    !(await db.collection("courses").countDocuments({
      source,
      termCode,
      importBatchId: targetBatchId,
      retiredAt: null,
    }))
  )
    throw new Error("ROLLBACK_TARGET_MISSING");
  await validateStaging(
    db,
    { source, term: { termCode } } as CourseData,
    targetBatchId,
  );
  const owner = randomUUID();
  const claimed = await claimTerm(
    db,
    { source, term: { termCode } } as CourseData,
    owner,
    120_000,
  );
  const key = { source, termCode };
  try {
    const result = await db.collection("academicTerms").updateOne(
      {
        ...key,
        importLeaseOwner: owner,
        importFence: claimed.importFence,
        activeImportBatchId: claimed.activeImportBatchId,
        importLeaseExpiresAt: { $gt: new Date() },
      },
      {
        $set: {
          ...run.termMetadataSnapshot,
          activeImportBatchId: targetBatchId,
          lastImportBatchId: targetBatchId,
          lastImportStatus: "succeeded",
          updatedAt: new Date().toISOString(),
        },
      },
    );
    if (!result.matchedCount) throw new Error("ROLLBACK_FENCE_FAILED");
  } finally {
    await db
      .collection("academicTerms")
      .updateOne(
        { ...key, importLeaseOwner: owner, importFence: claimed.importFence },
        { $unset: { importLeaseOwner: "", importLeaseExpiresAt: "" } },
      );
  }
}
