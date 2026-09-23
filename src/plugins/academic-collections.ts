import type { Collection, Db, Document } from "mongodb";

export type AcademicTermDocument = Document & {
  source: string;
  termCode: string;
  activeImportBatchId?: string;
  importFence: number;
  displayName?: string;
  season?: "fall" | "winter" | "spring" | "summer";
  providerCurrent?: boolean;
  providerSelectable?: boolean;
  importLeaseOwner?: string;
  importLeaseExpiresAt?: Date;
};

export type VersionedAcademicDocument = Document & {
  source: string;
  termCode: string;
  importBatchId: string;
  retiredAt?: string | null;
};

export type QuotaSnapshotDocument = Document & {
  snapshotId: string;
  source: string;
  sectionId: string;
  observedAt: string;
  projectionStatus: "pending" | "processing" | "done";
  projectionLeaseExpiresAt?: Date;
  projectionAttempts?: number;
  recordedAt?: string;
};

export type CourseWatchDocument = Document & {
  watchId: string;
  ownerUsername: string;
  targetType: "course" | "section";
  targetId: string;
  termCode: string;
  notificationPreference: "none" | "in_app";
  baselineRecordedAt: string;
  baselineBySection: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
};

export type WatchNotificationDocument = Document & {
  notificationId: string;
  ownerUsername: string;
  watchId: string;
  termCode: string;
  targetType: "course" | "section";
  targetId: string;
  changeType: "opened" | "closed" | "seats_available";
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  observedAt: string;
  dedupeKey: string;
  readAt?: string | null;
  createdAt: string;
};

export type WatchProjectionCheckpointDocument = Document & {
  source: string;
  sectionId: string;
  lastObservedAt: string;
  lastSnapshotId: string;
  updatedAt: string;
};

export type ImportRunDocument = Document & {
  importBatchId: string;
  source: string;
  termCode: string;
  status:
    | "running"
    | "staged"
    | "ready"
    | "activated"
    | "succeeded"
    | "retryable_failed"
    | "permanently_failed";
};

export type RefreshJobDocument = Document & {
  dedupeKey: string;
  jobType: "section_quota";
  source: string;
  termCode: string;
  targetId: string;
  status:
    | "queued"
    | "running"
    | "retryable_failed"
    | "succeeded"
    | "permanently_failed";
  attempts: number;
  claimGeneration: number;
  availableAt: Date;
  leaseExpiresAt?: Date;
};

export type AcademicCollections = {
  academicTerms: Collection<AcademicTermDocument>;
  courses: Collection<VersionedAcademicDocument>;
  courseOfferings: Collection<VersionedAcademicDocument>;
  classSections: Collection<VersionedAcademicDocument>;
  sectionBundles: Collection<VersionedAcademicDocument>;
  quotaSnapshots: Collection<QuotaSnapshotDocument>;
  latestQuotas: Collection<Document>;
  importRuns: Collection<ImportRunDocument>;
  refreshLeases: Collection<Document>;
  importQuotaStaging: Collection<Document>;
  refreshJobs: Collection<RefreshJobDocument>;
  courseWatches: Collection<CourseWatchDocument>;
  watchNotifications: Collection<WatchNotificationDocument>;
  watchProjectionCheckpoints: Collection<WatchProjectionCheckpointDocument>;
  commonCoreCatalogs: Collection<Document>;
  commonCoreCatalogState: Collection<Document>;
};

export async function initializeAcademicCollections(
  db: Db,
): Promise<AcademicCollections> {
  const academicTerms = db.collection<AcademicTermDocument>("academicTerms");
  await academicTerms.createIndex(
    { source: 1, termCode: 1 },
    { unique: true, name: "academic_term_identity" },
  );
  await academicTerms.createIndex({ activeImportBatchId: 1 });
  await academicTerms.createIndex({ sortKey: -1 });

  const courses = db.collection<VersionedAcademicDocument>("courses");
  const courseOfferings =
    db.collection<VersionedAcademicDocument>("courseOfferings");
  const classSections =
    db.collection<VersionedAcademicDocument>("classSections");
  const sectionBundles =
    db.collection<VersionedAcademicDocument>("sectionBundles");
  const versioned = [
    { collection: courses, name: "courses", identity: "courseId" },
    { collection: courseOfferings, name: "offerings", identity: "offeringId" },
    { collection: classSections, name: "sections", identity: "sectionId" },
    { collection: sectionBundles, name: "bundles", identity: "bundleId" },
  ];
  for (const { collection, name, identity } of versioned) {
    await collection.createIndex(
      { source: 1, termCode: 1, [identity]: 1, importBatchId: 1 },
      { unique: true, name: `${name}_batch_identity` },
    );
    await collection.createIndex(
      { source: 1, termCode: 1, importBatchId: 1, retiredAt: 1 },
      { name: `${name}_active_batch` },
    );
  }
  await courses.createIndex(
    {
      source: 1,
      termCode: 1,
      importBatchId: 1,
      retiredAt: 1,
      subject: 1,
      catalogNumber: 1,
      courseCode: 1,
    },
    { name: "courses_listing" },
  );
  await courseOfferings.createIndex(
    { courseId: 1, source: 1, termCode: 1, importBatchId: 1, retiredAt: 1 },
    { name: "offerings_by_course_batch" },
  );
  await classSections.createIndex(
    { source: 1, termCode: 1, importBatchId: 1, retiredAt: 1, offeringId: 1 },
    { name: "sections_by_offering_batch" },
  );

  const quotaSnapshots = db.collection<QuotaSnapshotDocument>("quotaSnapshots");
  await quotaSnapshots.createIndex(
    { source: 1, sectionId: 1, observedAt: 1 },
    { unique: true, name: "quota_observation_identity" },
  );
  await quotaSnapshots.createIndex({ sectionId: 1, observedAt: -1 });
  await quotaSnapshots.createIndex({ sectionId: 1, recordedAt: 1 });
  await quotaSnapshots.createIndex(
    { projectionStatus: 1, projectionLeaseExpiresAt: 1, observedAt: 1 },
    { name: "quota_projection_poll" },
  );
  const latestQuotas = db.collection<Document>("latestQuotas");
  await latestQuotas.createIndex(
    { source: 1, sectionId: 1 },
    { unique: true, name: "latest_quota_identity" },
  );
  const importRuns = db.collection<ImportRunDocument>("importRuns");
  await importRuns.createIndex(
    { importBatchId: 1 },
    { unique: true, name: "import_batch_identity" },
  );
  await importRuns.createIndex({ source: 1, termCode: 1, status: 1 });
  const refreshLeases = db.collection<Document>("refreshLeases");
  await refreshLeases.createIndex(
    { leaseKey: 1 },
    { unique: true, name: "refresh_lease_identity" },
  );
  const importQuotaStaging = db.collection<Document>("importQuotaStaging");
  await importQuotaStaging.createIndex(
    { importBatchId: 1, snapshotId: 1 },
    { unique: true, name: "staged_quota_identity" },
  );
  const refreshJobs = db.collection<RefreshJobDocument>("refreshJobs");
  await refreshJobs.createIndex(
    { dedupeKey: 1 },
    {
      unique: true,
      name: "refresh_job_active_key",
      partialFilterExpression: {
        status: { $in: ["queued", "running", "retryable_failed"] },
      },
    },
  );
  await refreshJobs.createIndex(
    { status: 1, availableAt: 1 },
    { name: "refresh_job_poll" },
  );
  await refreshJobs.createIndex(
    { leaseExpiresAt: 1 },
    { name: "refresh_job_lease" },
  );
  const courseWatches = db.collection<CourseWatchDocument>("courseWatches");
  await courseWatches.createIndex(
    { ownerUsername: 1, termCode: 1, targetType: 1, targetId: 1 },
    { unique: true, name: "course_watch_identity" },
  );
  await courseWatches.createIndex(
    { ownerUsername: 1, createdAt: -1, watchId: -1 },
    { name: "course_watch_owner_list" },
  );
  await courseWatches.createIndex(
    { termCode: 1, targetType: 1, targetId: 1, notificationPreference: 1 },
    { name: "course_watch_worker_lookup" },
  );
  const watchNotifications =
    db.collection<WatchNotificationDocument>("watchNotifications");
  await watchNotifications.createIndex(
    { ownerUsername: 1, dedupeKey: 1 },
    { unique: true, name: "watch_notification_identity" },
  );
  await watchNotifications.createIndex(
    { ownerUsername: 1, readAt: 1, createdAt: -1, notificationId: -1 },
    { name: "watch_notification_owner_list" },
  );
  await watchNotifications.createIndex(
    { watchId: 1, createdAt: -1 },
    { name: "watch_notification_watch" },
  );
  const watchProjectionCheckpoints =
    db.collection<WatchProjectionCheckpointDocument>(
      "watchProjectionCheckpoints",
    );
  await watchProjectionCheckpoints.createIndex(
    { source: 1, sectionId: 1 },
    { unique: true, name: "watch_projection_section" },
  );
  const commonCoreCatalogs = db.collection<Document>("commonCoreCatalogs");
  await commonCoreCatalogs.createIndex(
    { catalogVersion: 1 },
    { unique: true, name: "common_core_catalog_identity" },
  );
  const commonCoreCatalogState = db.collection<Document>(
    "commonCoreCatalogState",
  );
  await commonCoreCatalogState.createIndex(
    { stateId: 1 },
    { unique: true, name: "common_core_catalog_state" },
  );
  return {
    academicTerms,
    courses,
    courseOfferings,
    classSections,
    sectionBundles,
    quotaSnapshots,
    latestQuotas,
    importRuns,
    refreshLeases,
    importQuotaStaging,
    refreshJobs,
    courseWatches,
    watchNotifications,
    watchProjectionCheckpoints,
    commonCoreCatalogs,
    commonCoreCatalogState,
  };
}
