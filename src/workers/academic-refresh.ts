import { randomUUID } from "node:crypto";
import type { Db, Document } from "mongodb";
import { ACADEMIC_SOURCE } from "../domain/academic.js";
import { effectiveRemaining } from "../domain/quota.js";
import {
  QuotaProviderError,
  type QuotaSource,
  type QuotaTarget,
} from "../providers/ust-quota.js";
import {
  enqueueQuotaRefreshJob,
  recordQuotaFailure,
  saveQuotaObservation,
} from "../repositories/quotas.js";

export type WorkerSettings = {
  maxAttempts: number;
  leaseSeconds: number;
  failureCooldownSeconds: number;
  quotaMinIntervalSeconds: number;
  quotaTtlSeconds?: number;
  maxWatchedJobsPerPoll?: number;
  projectionLeaseSeconds?: number;
  shouldStop?: () => boolean;
  now?: () => Date;
};

function jobFilter(job: Document, owner: string) {
  return {
    _id: job._id,
    claimGeneration: job.claimGeneration,
    claimOwner: owner,
    status: "running",
  };
}

function quotaState(row: Document | null) {
  const remaining = effectiveRemaining(row ?? {});
  return {
    open: typeof row?.open === "boolean" ? row.open : null,
    remaining: remaining === null ? null : Math.max(0, remaining),
    waitlisted:
      typeof row?.waitlisted === "number" && Number.isFinite(row.waitlisted)
        ? Math.max(0, row.waitlisted)
        : null,
  };
}

function quotaChange(
  previous: Document | null,
  current: Document,
): "opened" | "closed" | "seats_available" | null {
  const oldOpen = typeof previous?.open === "boolean" ? previous.open : null;
  const newOpen = typeof current.open === "boolean" ? current.open : null;
  if (oldOpen !== null && newOpen !== null && oldOpen !== newOpen)
    return newOpen ? "opened" : "closed";
  const oldRemaining = effectiveRemaining(previous ?? {});
  const newRemaining = effectiveRemaining(current);
  const displayOldRemaining =
    oldRemaining === null ? null : Math.max(0, oldRemaining);
  const displayNewRemaining =
    newRemaining === null ? null : Math.max(0, newRemaining);
  if (
    (displayOldRemaining === null || displayOldRemaining === 0) &&
    displayNewRemaining !== null &&
    displayNewRemaining > 0
  )
    return "seats_available";
  return null;
}

export class AcademicRefreshWorker {
  constructor(
    private readonly db: Db,
    private readonly source: QuotaSource,
    private readonly settings: WorkerSettings,
  ) {}

  private now(): Date {
    return this.settings.now?.() ?? new Date();
  }

  private stopping() {
    return this.settings.shouldStop?.() ?? false;
  }

  async runOne(): Promise<boolean> {
    if (this.stopping()) return false;
    await this.scanWatchedSections();
    if (this.stopping()) return false;
    const jobs = this.db.collection("refreshJobs");
    const now = this.now();
    const owner = randomUUID();
    const job = await jobs.findOneAndUpdate(
      {
        jobType: "section_quota",
        source: ACADEMIC_SOURCE,
        $or: [
          {
            status: { $in: ["queued", "retryable_failed"] },
            availableAt: { $lte: now },
          },
          { status: "running", leaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $inc: { attempts: 1, claimGeneration: 1 },
        $set: {
          status: "running",
          claimOwner: owner,
          startedAt: now.toISOString(),
          leaseExpiresAt: new Date(
            now.getTime() + this.settings.leaseSeconds * 1000,
          ),
          updatedAt: now.toISOString(),
        },
      },
      { sort: { availableAt: 1, _id: 1 }, returnDocument: "after" },
    );
    if (!job) return this.stopping() ? false : this.projectOne();
    const leaseKey = `${job.source}:${job.termCode}:quota:${job.targetId}`;
    const providerSlot = `${job.source}:quota-provider`;
    const leases = this.db.collection("refreshLeases");
    let leaseHeld = false;
    let providerSlotHeld = false;
    let live = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      try {
        const acquired = await leases.findOneAndUpdate(
          {
            leaseKey,
            $or: [
              { expiresAt: { $lte: now } },
              { expiresAt: { $exists: false } },
            ],
          },
          {
            $set: {
              ownerId: owner,
              acquiredAt: now,
              renewedAt: now,
              expiresAt: new Date(
                now.getTime() + this.settings.leaseSeconds * 1000,
              ),
            },
          },
          { upsert: true, returnDocument: "after" },
        );
        leaseHeld = acquired?.ownerId === owner;
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
      if (!leaseHeld) throw new QuotaProviderError(true, "RESOURCE_LEASE_BUSY");
      const providerNow = this.now();
      let providerLease: Document | null = null;
      try {
        providerLease = await leases.findOneAndUpdate(
          {
            leaseKey: providerSlot,
            $and: [
              {
                $or: [
                  { nextAllowedAt: { $lte: providerNow } },
                  { nextAllowedAt: { $exists: false } },
                ],
              },
              {
                $or: [
                  { providerLeaseExpiresAt: { $lte: providerNow } },
                  { providerLeaseExpiresAt: { $exists: false } },
                ],
              },
            ],
          },
          {
            $set: {
              providerOwner: owner,
              nextAllowedAt: new Date(
                providerNow.getTime() +
                  this.settings.quotaMinIntervalSeconds * 1000,
              ),
              providerLeaseExpiresAt: new Date(
                providerNow.getTime() +
                  Math.max(
                    this.settings.leaseSeconds,
                    this.settings.quotaMinIntervalSeconds,
                  ) *
                    1000,
              ),
            },
            $setOnInsert: { leaseKey: providerSlot },
          },
          { upsert: true, returnDocument: "after" },
        );
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
      providerSlotHeld = providerLease?.providerOwner === owner;
      if (!providerSlotHeld) {
        const current = await leases.findOne({ leaseKey: providerSlot });
        const nextAllowedAt =
          current?.nextAllowedAt instanceof Date
            ? current.nextAllowedAt
            : new Date(
                providerNow.getTime() +
                  this.settings.quotaMinIntervalSeconds * 1000,
              );
        await jobs.updateOne(jobFilter(job, owner), {
          $set: {
            status: "queued",
            availableAt: nextAllowedAt,
            updatedAt: this.now().toISOString(),
          },
          $unset: { claimOwner: "", leaseExpiresAt: "", startedAt: "" },
          $inc: { attempts: -1 },
        });
        return true;
      }
      heartbeat = setInterval(
        async () => {
          if (!live) return;
          try {
            const at = this.now();
            const expiry = new Date(
              at.getTime() + this.settings.leaseSeconds * 1000,
            );
            const [jobResult, leaseResult] = await Promise.all([
              jobs.updateOne(jobFilter(job, owner), {
                $set: { leaseExpiresAt: expiry },
              }),
              leases.updateOne(
                { leaseKey, ownerId: owner },
                { $set: { expiresAt: expiry, renewedAt: at } },
              ),
            ]);
            const providerResult = await leases.updateOne(
              { leaseKey: providerSlot, providerOwner: owner },
              {
                $set: {
                  providerLeaseExpiresAt: new Date(
                    at.getTime() +
                      Math.max(
                        this.settings.leaseSeconds,
                        this.settings.quotaMinIntervalSeconds,
                      ) *
                        1000,
                  ),
                },
              },
            );
            if (
              !jobResult.matchedCount ||
              !leaseResult.matchedCount ||
              !providerResult.matchedCount
            )
              live = false;
          } catch {
            live = false;
          }
        },
        Math.max(100, Math.floor((this.settings.leaseSeconds * 1000) / 3)),
      );
      const target = await this.resolveTarget(job);
      const observation = await this.source.fetchQuota(target);
      if (
        observation.sectionId !== job.targetId ||
        observation.source !== job.source ||
        !Number.isFinite(Date.parse(observation.observedAt)) ||
        observation.snapshotId !==
          `${observation.sectionId}@${observation.observedAt}`
      )
        throw new QuotaProviderError(false, "QUOTA_IDENTITY_INVALID");
      if (
        !live ||
        !(await jobs.findOne({
          ...jobFilter(job, owner),
          leaseExpiresAt: { $gt: this.now() },
        }))
      )
        return true;
      await saveQuotaObservation(
        this.db,
        job.termCode,
        observation,
        this.settings.quotaMinIntervalSeconds,
        this.now(),
      );
      await jobs.updateOne(jobFilter(job, owner), {
        $set: {
          status: "succeeded",
          finishedAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        },
        $unset: { claimOwner: "", leaseExpiresAt: "" },
      });
      await leases.updateOne(
        { leaseKey: providerSlot, providerOwner: owner },
        { $unset: { providerOwner: "", providerLeaseExpiresAt: "" } },
      );
      providerSlotHeld = false;
    } catch (error) {
      const owned = await jobs.findOne({
        ...jobFilter(job, owner),
        leaseExpiresAt: { $gt: this.now() },
      });
      if (owned) {
        const retryable =
          error instanceof QuotaProviderError ? error.retryable : true;
        const permanent =
          !retryable || job.attempts >= this.settings.maxAttempts;
        const backoff = permanent
          ? this.settings.failureCooldownSeconds
          : Math.min(
              this.settings.failureCooldownSeconds,
              30 * 2 ** Math.min(job.attempts, 10),
            );
        const availableAt = new Date(this.now().getTime() + backoff * 1000);
        const result = await jobs.updateOne(
          { ...jobFilter(job, owner), leaseExpiresAt: { $gt: this.now() } },
          {
            $set: {
              status: permanent ? "permanently_failed" : "retryable_failed",
              availableAt,
              lastErrorCode:
                error instanceof QuotaProviderError
                  ? error.code
                  : "PROVIDER_ERROR",
              updatedAt: this.now().toISOString(),
              ...(permanent ? { finishedAt: this.now().toISOString() } : {}),
            },
            $unset: { claimOwner: "", leaseExpiresAt: "" },
          },
        );
        if (result.matchedCount)
          await recordQuotaFailure(
            this.db,
            job.source,
            job.termCode,
            job.targetId,
            availableAt,
            permanent ? "permanently_failed" : "retryable_failed",
            new Date(job.startedAt),
            this.now(),
          );
      }
    } finally {
      live = false;
      if (heartbeat) clearInterval(heartbeat);
      if (providerSlotHeld)
        await leases.updateOne(
          { leaseKey: providerSlot, providerOwner: owner },
          {
            $unset: { providerOwner: "", providerLeaseExpiresAt: "" },
          },
        );
      if (leaseHeld) await leases.deleteOne({ leaseKey, ownerId: owner });
      if (!this.stopping()) await this.projectOne();
    }
    return true;
  }

  /** Enqueue due watched sections without making provider calls in the scan. */
  async scanWatchedSections(): Promise<number> {
    const watches = await this.db
      .collection("courseWatches")
      .find({}, { projection: { termCode: 1, targetType: 1, targetId: 1 } })
      .toArray();
    if (!watches.length) return 0;

    const termCodes = [
      ...new Set(watches.map((watch) => String(watch.termCode))),
    ];
    const terms = await this.db
      .collection("academicTerms")
      .find({
        source: ACADEMIC_SOURCE,
        termCode: { $in: termCodes },
        activeImportBatchId: { $type: "string" },
      })
      .project({ termCode: 1, activeImportBatchId: 1 })
      .toArray();
    const sections = new Map<string, { termCode: string; dueAt: number }>();
    for (const term of terms) {
      const termCode = String(term.termCode);
      const activeImportBatchId = String(term.activeImportBatchId);
      const termWatches = watches.filter(
        (watch) => String(watch.termCode) === termCode,
      );
      const directIds = termWatches
        .filter((watch) => watch.targetType === "section")
        .map((watch) => String(watch.targetId));
      const courseIds = termWatches
        .filter((watch) => watch.targetType === "course")
        .map((watch) => String(watch.targetId));
      const activeKey = {
        source: ACADEMIC_SOURCE,
        termCode,
        importBatchId: activeImportBatchId,
        retiredAt: null,
      };
      const courseOfferingRows = courseIds.length
        ? await this.db
            .collection("courseOfferings")
            .find({ ...activeKey, courseId: { $in: courseIds } })
            .project({ offeringId: 1 })
            .toArray()
        : [];
      const offeringIds = courseOfferingRows.map((row) => row.offeringId);
      const activeSections = await this.db
        .collection("classSections")
        .find({
          ...activeKey,
          $or: [
            ...(directIds.length ? [{ sectionId: { $in: directIds } }] : []),
            ...(offeringIds.length
              ? [
                  {
                    offeringId: { $in: offeringIds },
                  },
                ]
              : []),
          ],
        })
        .project({ sectionId: 1 })
        .toArray();
      const sectionIds = [
        ...new Set(activeSections.map((row) => String(row.sectionId))),
      ];
      if (!sectionIds.length) continue;
      const latestRows = await this.db
        .collection("latestQuotas")
        .find({ source: ACADEMIC_SOURCE, sectionId: { $in: sectionIds } })
        .toArray();
      const latestBySection = new Map(
        latestRows.map((row) => [String(row.sectionId), row]),
      );
      const now = this.now().getTime();
      for (const sectionId of sectionIds) {
        const latest = latestBySection.get(sectionId);
        const observedAt = Date.parse(String(latest?.observedAt ?? ""));
        const explicitNext = Date.parse(String(latest?.nextRefreshAt ?? ""));
        const dueAt = Number.isFinite(explicitNext)
          ? explicitNext
          : Number.isFinite(observedAt)
            ? observedAt + (this.settings.quotaTtlSeconds ?? 900) * 1000
            : Number.NEGATIVE_INFINITY;
        if (dueAt > now) continue;
        const existing = sections.get(sectionId);
        if (!existing || dueAt < existing.dueAt)
          sections.set(sectionId, { termCode, dueAt });
      }
    }
    const max = this.settings.maxWatchedJobsPerPoll ?? 100;
    const due = [...sections.entries()]
      .sort(
        ([left, a], [right, b]) =>
          a.dueAt - b.dueAt || left.localeCompare(right),
      )
      .slice(0, max);
    let enqueued = 0;
    for (const [sectionId, value] of due) {
      if (
        await enqueueQuotaRefreshJob(
          this.db,
          ACADEMIC_SOURCE,
          value.termCode,
          sectionId,
          this.now(),
        )
      )
        enqueued += 1;
    }
    return enqueued;
  }

  async projectOne(): Promise<boolean> {
    const snapshots = this.db.collection("quotaSnapshots");
    const now = this.now();
    const owner = randomUUID();
    const leaseSeconds = this.settings.projectionLeaseSeconds ?? 60;
    const snapshot = await snapshots.findOneAndUpdate(
      {
        $or: [
          { projectionStatus: "pending" },
          { projectionStatus: { $exists: false } },
          {
            projectionStatus: "processing",
            $or: [
              { projectionLeaseExpiresAt: { $lte: now } },
              { projectionLeaseExpiresAt: { $exists: false } },
            ],
          },
        ],
      },
      {
        $set: {
          projectionStatus: "processing",
          projectionLeaseOwner: owner,
          projectionLeaseExpiresAt: new Date(
            now.getTime() + leaseSeconds * 1000,
          ),
          updatedAt: now.toISOString(),
        },
        $inc: { projectionAttempts: 1 },
      },
      { sort: { observedAt: 1, snapshotId: 1 }, returnDocument: "after" },
    );
    if (!snapshot) return false;
    const snapshotId = String(snapshot.snapshotId);
    const sectionId = String(snapshot.sectionId);
    const observedAt = String(snapshot.observedAt);
    const checkpoint = await this.db
      .collection("watchProjectionCheckpoints")
      .findOne({
        source: snapshot.source,
        sectionId,
      });
    const finish = async () => {
      await snapshots.updateOne(
        {
          _id: snapshot._id,
          projectionStatus: "processing",
          projectionLeaseOwner: owner,
        },
        {
          $set: {
            projectionStatus: "done",
            updatedAt: this.now().toISOString(),
          },
          $unset: { projectionLeaseOwner: "", projectionLeaseExpiresAt: "" },
        },
      );
    };
    const earlier = await snapshots.findOne({
      source: snapshot.source,
      sectionId,
      $or: [
        { observedAt: { $lt: observedAt } },
        { observedAt, snapshotId: { $lt: snapshotId } },
      ],
      projectionStatus: { $ne: "done" },
    });
    if (earlier) {
      await snapshots.updateOne(
        {
          _id: snapshot._id,
          projectionStatus: "processing",
          projectionLeaseOwner: owner,
        },
        {
          $set: {
            projectionStatus: "pending",
            updatedAt: this.now().toISOString(),
          },
          $unset: { projectionLeaseOwner: "", projectionLeaseExpiresAt: "" },
        },
      );
      return true;
    }
    if (
      checkpoint &&
      Date.parse(String(checkpoint.lastObservedAt)) >= Date.parse(observedAt)
    ) {
      await finish();
      return true;
    }
    const previous = await snapshots
      .find({
        source: snapshot.source,
        sectionId,
        observedAt: { $lt: observedAt },
      })
      .sort({ observedAt: -1, snapshotId: -1 })
      .limit(1)
      .next();
    const watches = await this.watchesForSection(
      String(snapshot.termCode),
      sectionId,
    );
    for (const watch of watches) {
      if (watch.notificationPreference !== "in_app") continue;
      const baselineId = watch.baselineBySection?.[sectionId] ?? null;
      if (baselineId === snapshotId) continue;
      const baseline = baselineId
        ? await snapshots.findOne({
            source: snapshot.source,
            sectionId,
            snapshotId: baselineId,
          })
        : null;
      if (
        String(snapshot.recordedAt ?? "") <= String(watch.baselineRecordedAt) ||
        (baseline &&
          Date.parse(observedAt) <= Date.parse(String(baseline.observedAt)))
      )
        continue;
      const change = quotaChange(previous, snapshot);
      if (!change) continue;
      const notification: Document = {
        notificationId: randomUUID(),
        ownerUsername: watch.ownerUsername,
        watchId: watch.watchId,
        termCode: watch.termCode,
        targetType: watch.targetType,
        targetId: watch.targetId,
        changeType: change,
        beforeState: quotaState(previous),
        afterState: quotaState(snapshot),
        observedAt,
        dedupeKey: `${watch.watchId}:${snapshotId}:${change}`,
        readAt: null,
        createdAt: this.now().toISOString(),
      };
      try {
        await this.db.collection("watchNotifications").insertOne(notification);
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
    await this.db.collection("watchProjectionCheckpoints").updateOne(
      { source: snapshot.source, sectionId },
      {
        $set: {
          source: snapshot.source,
          sectionId,
          lastObservedAt: observedAt,
          lastSnapshotId: snapshotId,
          updatedAt: this.now().toISOString(),
        },
      },
      { upsert: true },
    );
    await finish();
    return true;
  }

  private async watchesForSection(termCode: string, sectionId: string) {
    const watches = this.db.collection("courseWatches");
    const direct = await watches
      .find({
        termCode,
        targetType: "section",
        targetId: sectionId,
      })
      .toArray();
    const term = await this.db.collection("academicTerms").findOne({
      source: ACADEMIC_SOURCE,
      termCode,
    });
    if (!term?.activeImportBatchId) return direct;
    const section = await this.db.collection("classSections").findOne({
      source: ACADEMIC_SOURCE,
      termCode,
      importBatchId: term.activeImportBatchId,
      retiredAt: null,
      sectionId,
    });
    if (!section) return direct;
    const offering = await this.db.collection("courseOfferings").findOne({
      source: ACADEMIC_SOURCE,
      termCode,
      importBatchId: term.activeImportBatchId,
      retiredAt: null,
      offeringId: section.offeringId,
    });
    if (!offering) return direct;
    const courseWatches = await watches
      .find({
        termCode,
        targetType: "course",
        targetId: offering.courseId,
      })
      .toArray();
    return [...direct, ...courseWatches];
  }

  private async resolveTarget(job: Document): Promise<QuotaTarget> {
    const term = await this.db
      .collection("academicTerms")
      .findOne({ source: job.source, termCode: job.termCode });
    if (!term?.activeImportBatchId)
      throw new QuotaProviderError(true, "TERM_CACHE_UNAVAILABLE");
    const key = {
      source: job.source,
      termCode: job.termCode,
      importBatchId: term.activeImportBatchId,
      retiredAt: null,
    };
    const section = await this.db
      .collection("classSections")
      .findOne({ ...key, sectionId: job.targetId });
    if (!section) throw new QuotaProviderError(false, "SECTION_RETIRED");
    const offering = await this.db
      .collection("courseOfferings")
      .findOne({ ...key, offeringId: section.offeringId });
    const course = offering
      ? await this.db
          .collection("courses")
          .findOne({ ...key, courseId: offering.courseId })
      : null;
    if (!course) throw new QuotaProviderError(false, "COURSE_CACHE_INCOMPLETE");
    return {
      termCode: job.termCode,
      subject: course.subject,
      courseCode: course.courseCode,
      sectionId: job.targetId,
      classNbr: section.classNbr,
    };
  }
}
