import { randomUUID } from "node:crypto";
import type { Db, Document } from "mongodb";
import { ACADEMIC_SOURCE } from "../domain/academic.js";
import {
  QuotaProviderError,
  type QuotaSource,
  type QuotaTarget,
} from "../providers/ust-quota.js";
import {
  recordQuotaFailure,
  saveQuotaObservation,
} from "../repositories/quotas.js";

export type WorkerSettings = {
  maxAttempts: number;
  leaseSeconds: number;
  failureCooldownSeconds: number;
  quotaMinIntervalSeconds: number;
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

export class AcademicRefreshWorker {
  constructor(
    private readonly db: Db,
    private readonly source: QuotaSource,
    private readonly settings: WorkerSettings,
  ) {}

  private now(): Date {
    return this.settings.now?.() ?? new Date();
  }

  async runOne(): Promise<boolean> {
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
    if (!job) return false;
    const leaseKey = `${job.source}:${job.termCode}:quota:${job.targetId}`;
    const leases = this.db.collection("refreshLeases");
    let leaseHeld = false;
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
            if (!jobResult.matchedCount || !leaseResult.matchedCount)
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
      );
      await jobs.updateOne(jobFilter(job, owner), {
        $set: {
          status: "succeeded",
          finishedAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        },
        $unset: { claimOwner: "", leaseExpiresAt: "" },
      });
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
          );
      }
    } finally {
      live = false;
      if (heartbeat) clearInterval(heartbeat);
      if (leaseHeld) await leases.deleteOne({ leaseKey, ownerId: owner });
    }
    return true;
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
