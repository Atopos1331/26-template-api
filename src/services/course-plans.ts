import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import {
  type Document,
  MongoServerError,
  ObjectId,
  type WithId,
} from "mongodb";
import {
  type NormalizedAutoPlanRequest,
  normalizeAutoPlanRequest,
  validateAutoPlanGroups,
} from "../domain/auto-plan.js";
import {
  compactnessScore,
  derivePlanningHorizon,
  hardMeetingViolation,
  instructorFitScore,
  type PlanningHorizon,
  type ScheduleMetrics,
  scheduleMetrics,
  timeFitScore,
  violatesAggregateConstraints,
} from "../domain/auto-plan-constraints.js";
import {
  optionScheduleSummary,
  optionScore,
  optionScoreComponents,
} from "../domain/auto-plan-results.js";
import {
  AutoPlanSolverBusyError,
  type SolverCandidate,
  type SolverInput,
  type SolverResult,
  solveAutoPlan,
} from "../domain/auto-plan-solver.js";
import {
  signAutoPlanToken,
  verifyAutoPlanToken,
} from "../domain/auto-plan-token.js";
import {
  type CalendarOccurrence,
  calendarWindow,
  detectConflicts,
} from "../domain/calendar.js";
import { expandCourseBundle } from "../domain/course-schedules.js";
import { expandIcsSeries } from "../domain/ics-calendar.js";
import {
  assertPlanItemInvariants,
  type CoursePlanItem,
  isAllowedPlanTransition,
  normalizeItemCreate,
  normalizeItemPatch,
  normalizePlanCreate,
  normalizePlanPatch,
  PlanError,
  type PlanStatus,
  planId,
} from "../domain/plans.js";
import {
  calculateQuotaTrend,
  effectiveRemaining,
  enrollmentDifficulty,
} from "../domain/quota.js";
import {
  normalizeRecommendationRequest,
  type RecommendationRequest,
} from "../domain/recommendations.js";
import type {
  EventDocument,
  IdempotencyRecordDocument,
} from "../plugins/init-mongo.js";
import type { CommonCoreRepository } from "../repositories/common-core.js";
import type {
  CanonicalBundle,
  CourseCatalogRepository,
} from "../repositories/course-catalog.js";
import type { CoursePlanRepository } from "../repositories/course-plans.js";

type PlanSettings = {
  timezone: string;
  cursorKey: string;
  cursorTtlSeconds: number;
  autoPlanTokenKey: string;
  autoPlanTokenTtlSeconds: number;
  autoPlanMaxTokenBytes?: number;
  autoPlanMaxDesiredCourses?: number;
  autoPlanMaxSelectedCourses?: number;
  autoPlanMaxCandidateBundles?: number;
  autoPlanMaxCandidateOccurrences?: number;
  autoPlanMaxConflictEdges?: number;
  autoPlanMaxHorizonDays?: number;
  autoPlanSolverTimeoutMs?: number;
  autoPlanSolverConcurrency?: number;
  autoPlanMaxRequestBytes?: number;
  commonCoreMaxAgeDays?: number;
  academicQuotaTtlSeconds?: number;
  idempotencyRetentionSeconds: number;
  defaultTermCode?: string;
  now?: () => Date;
};

type PlanWithId = WithId<import("../plugins/init-mongo.js").CoursePlanDocument>;
type QuotaDocument = Document & {
  snapshotId?: string | null;
  observedAt?: string | null;
  capacity?: number | null;
  remaining?: number | null;
  open?: boolean | null;
  waitlisted?: number | null;
};

type FillerSchedule = {
  canonical: CanonicalBundle;
  metrics: ScheduleMetrics;
  quota: ReturnType<typeof historicalQuotaBundleScore>;
  timeFit: number;
  compactness: number;
  instructorFit: number;
};

const AUTO_PLAN_APPLY_ROUTE = "POST /plans/:id/auto-plans/apply";
const AUTO_PLAN_APPLY_LEASE_MS = 120_000;

function nowIso(settings: PlanSettings) {
  return (settings.now?.() ?? new Date()).toISOString();
}

function hashSign(key: string, value: string) {
  return createHmac("sha256", key).update(value).digest("base64url");
}

function requestHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encodeCursor(
  key: string,
  owner: string,
  updatedAt: string,
  id: ObjectId,
  issuedAt: number,
) {
  const encoded = Buffer.from(
    JSON.stringify({ owner, updatedAt, id: id.toHexString(), issuedAt }),
  ).toString("base64url");
  return `${encoded}.${hashSign(key, encoded)}`;
}

function decodeCursor(
  key: string,
  token: string,
  owner: string,
  ttlSeconds: number,
  now: number,
) {
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new PlanError("invalid_cursor", 400, "Invalid cursor");
  const [encoded, supplied] = token.split(".") as [string, string];
  const expected = Buffer.from(hashSign(key, encoded));
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new PlanError("invalid_cursor", 400, "Invalid cursor");
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString()) as {
      owner?: string;
      updatedAt?: string;
      id?: string;
      issuedAt?: number;
    };
    if (
      value.owner !== owner ||
      typeof value.updatedAt !== "string" ||
      typeof value.id !== "string" ||
      !Number.isSafeInteger(value.issuedAt) ||
      value.issuedAt! > now ||
      value.issuedAt! + ttlSeconds * 1000 < now
    )
      throw new Error("cursor mismatch");
    return { updatedAt: value.updatedAt, id: planId(value.id) };
  } catch {
    throw new PlanError("invalid_cursor", 400, "Invalid cursor");
  }
}

function isDuplicate(error: unknown) {
  return error instanceof MongoServerError && error.code === 11000;
}

function bundleMeetings(canonical: CanonicalBundle) {
  const derived = canonical.bundle.derivedSchedule?.meetings;
  if (Array.isArray(derived) && derived.length) return derived;
  return canonical.sections.flatMap((section) =>
    Array.isArray(section.meetings) ? section.meetings : [],
  );
}

function historicalQuotaSectionScore(
  section: Document,
  latest: QuotaDocument | undefined,
  history: Document[],
) {
  const dataQuality: string[] = [];
  const latestRemaining = effectiveRemaining(latest ?? {});
  const inconsistent = latestRemaining !== null && latestRemaining < 0;
  if (inconsistent) dataQuality.push("quota_inconsistent");
  const open =
    typeof latest?.open === "boolean"
      ? latest.open
      : typeof section.open === "boolean"
        ? section.open
        : null;
  if (open === false)
    return {
      score: 0,
      unknown: false,
      inconsistent,
      closed: true,
      full: false,
      dataQuality,
    };
  if (open === null) dataQuality.push("quota_unknown");
  const capacity =
    typeof latest?.capacity === "number" && latest.capacity > 0
      ? latest.capacity
      : null;
  const remaining =
    latestRemaining === null ? null : Math.max(0, latestRemaining);
  if (open === null || capacity === null || remaining === null)
    return {
      score: 50,
      unknown: true,
      inconsistent,
      closed: false,
      full: false,
      dataQuality: [
        ...new Set([
          ...dataQuality,
          ...(remaining === null ? ["remaining_missing"] : []),
          "quota_unknown",
        ]),
      ],
    };
  const observations = history
    .filter((row) => Number.isFinite(Date.parse(String(row.observedAt))))
    .sort(
      (left, right) =>
        Date.parse(String(left.observedAt)) -
          Date.parse(String(right.observedAt)) ||
        String(left.snapshotId).localeCompare(String(right.snapshotId)),
    );
  const latestAt = Date.parse(String(latest?.observedAt ?? ""));
  const trendFor = (field: "remaining" | "waitlisted") => {
    const valueFor = (row: Document) =>
      field === "remaining" ? effectiveRemaining(row) : (row[field] ?? null);
    const current =
      field === "remaining" ? latestRemaining : (latest?.[field] ?? null);
    if (typeof current !== "number" || !Number.isFinite(current)) {
      dataQuality.push(
        field === "remaining" ? "remaining_missing" : "waitlist_missing",
      );
      return 0.5;
    }
    const earlier = observations
      .filter(
        (row) =>
          Date.parse(String(row.observedAt)) < latestAt &&
          typeof valueFor(row) === "number" &&
          Number.isFinite(valueFor(row)),
      )
      .reverse();
    const prior =
      earlier.find(
        (row) =>
          latestAt - Date.parse(String(row.observedAt)) <= 7 * 86_400_000,
      ) ??
      earlier.find(
        (row) =>
          latestAt - Date.parse(String(row.observedAt)) <= 14 * 86_400_000,
      ) ??
      earlier[0];
    if (!prior) {
      dataQuality.push("insufficient_data");
      return 0.5;
    }
    const previous = Math.max(0, Number(valueFor(prior)));
    const currentValue = Math.max(0, current);
    const delta =
      (currentValue - previous) /
      Math.max(1, Math.abs(previous), capacity * 0.1);
    const mapped = Math.max(-1, Math.min(1, delta));
    const trend = 0.5 + (field === "remaining" ? 0.5 : -0.5) * mapped;
    return Math.max(0, Math.min(1, trend));
  };
  const waitlisted =
    typeof latest?.waitlisted === "number" && Number.isFinite(latest.waitlisted)
      ? Math.max(0, latest.waitlisted)
      : null;
  const seatRatio = Math.max(0, Math.min(1, remaining / capacity));
  const queueScore =
    waitlisted === null
      ? 0.5
      : 1 - Math.max(0, Math.min(1, waitlisted / capacity));
  const remainingTrend = trendFor("remaining");
  const waitlistTrend = trendFor("waitlisted");
  const full = remaining === 0;
  const score = full
    ? 39 * (0.6 * queueScore + 0.4 * waitlistTrend)
    : 40 +
      60 *
        (0.5 * seatRatio +
          0.2 * queueScore +
          0.15 * remainingTrend +
          0.15 * waitlistTrend);
  return {
    score: Math.round(score * 100) / 100,
    unknown: false,
    inconsistent,
    closed: false,
    full,
    dataQuality: [...new Set(dataQuality)],
  };
}

function quotaRiskObservationIds(
  latest: QuotaDocument | undefined,
  history: Document[],
) {
  const ids = new Set<string>();
  if (latest?.snapshotId) ids.add(String(latest.snapshotId));
  const latestAt = Date.parse(String(latest?.observedAt ?? ""));
  if (!Number.isFinite(latestAt)) return [...ids].sort();
  for (const field of ["remaining", "waitlisted"] as const) {
    const valueFor = (row: Document) =>
      field === "remaining" ? effectiveRemaining(row) : (row[field] ?? null);
    const current = valueFor(latest ?? {});
    if (typeof current !== "number" || !Number.isFinite(current)) continue;
    const previous = history
      .filter(
        (row) =>
          Date.parse(String(row.observedAt)) < latestAt &&
          typeof valueFor(row) === "number" &&
          Number.isFinite(valueFor(row)) &&
          typeof row.snapshotId === "string",
      )
      .sort(
        (left, right) =>
          Date.parse(String(right.observedAt)) -
            Date.parse(String(left.observedAt)) ||
          String(right.snapshotId).localeCompare(String(left.snapshotId)),
      )[0];
    if (previous) ids.add(String(previous.snapshotId));
  }
  return [...ids].sort();
}

function quotaIsStale(
  quota: QuotaDocument | undefined,
  settings: PlanSettings,
  now = settings.now?.() ?? new Date(),
) {
  const observedAt = Date.parse(String(quota?.observedAt ?? ""));
  return (
    !Number.isFinite(observedAt) ||
    observedAt + (settings.academicQuotaTtlSeconds ?? 900) * 1000 <=
      now.getTime()
  );
}

function historicalQuotaBundleScore(
  canonical: CanonicalBundle,
  quotas: Map<string, QuotaDocument>,
  history: Map<string, Document[]>,
) {
  const scores = canonical.sections.map((section) =>
    historicalQuotaSectionScore(
      section,
      quotas.get(String(section.sectionId)),
      history.get(String(section.sectionId)) ?? [],
    ),
  );
  return {
    score: scores.length ? Math.min(...scores.map((value) => value.score)) : 50,
    unknown: scores.some((value) => value.unknown),
    inconsistent: scores.some((value) => value.inconsistent),
    closed: scores.some((value) => value.closed),
    full: scores.some((value) => value.full),
    dataQuality: [...new Set(scores.flatMap((value) => value.dataQuality))],
  };
}

function quotaSectionScore(
  section: Document | undefined,
  quota: QuotaDocument | undefined,
) {
  const open =
    typeof quota?.open === "boolean"
      ? quota.open
      : typeof section?.open === "boolean"
        ? section.open
        : null;
  const remainingValue = effectiveRemaining(quota ?? {});
  const inconsistent = remainingValue !== null && remainingValue < 0;
  const dataQuality: string[] = [];
  if (inconsistent) dataQuality.push("quota_inconsistent");
  if (open === false)
    return {
      score: 0,
      unknown: false,
      inconsistent,
      closed: true,
      full: false,
      dataQuality,
    };
  if (open === null) dataQuality.push("quota_unknown");
  const remaining =
    remainingValue === null ? null : Math.max(0, remainingValue);
  if (
    open === null ||
    !quota ||
    (quota.capacity == null && quota.remaining == null)
  )
    return {
      score: 50,
      unknown: true,
      inconsistent,
      closed: false,
      full: false,
      dataQuality: [...new Set([...dataQuality, "quota_unknown"])],
    };
  const capacity =
    typeof quota.capacity === "number" && quota.capacity > 0
      ? quota.capacity
      : null;
  if (remaining === null || capacity === null)
    return {
      score: 50,
      unknown: true,
      inconsistent,
      closed: false,
      full: false,
      dataQuality: [...new Set([...dataQuality, "quota_unknown"])],
    };
  if (remaining === 0)
    return {
      score: 0,
      unknown: false,
      inconsistent,
      closed: false,
      full: true,
      dataQuality,
    };
  return {
    score: Math.round(Math.max(0, Math.min(1, remaining / capacity)) * 100),
    unknown: false,
    inconsistent,
    closed: false,
    full: false,
    dataQuality,
  };
}

function quotaSnapshotMap(
  canonical: CanonicalBundle[],
  quotas: Map<string, QuotaDocument>,
) {
  const sectionIds = new Set(
    canonical.flatMap((row) =>
      row.sections.map((section) => String(section.sectionId)),
    ),
  );
  return Object.fromEntries(
    [...sectionIds]
      .sort()
      .map((sectionId) => [
        sectionId,
        quotas.get(sectionId)?.snapshotId ?? null,
      ]),
  );
}

function optionCourseResponse(canonical: CanonicalBundle) {
  return {
    courseId: String(canonical.course.courseId),
    courseCode: canonicalCourseCode(canonical),
    title: canonical.course.title ?? null,
    credits:
      typeof canonical.course.credits === "number"
        ? canonical.course.credits
        : null,
    offeringId: String(canonical.offering.offeringId),
    bundleId: String(canonical.bundle.bundleId),
    sectionLabels: canonical.bundle.sectionLabels ?? [],
    componentSections: canonical.sections.map((section) => ({
      sectionId: String(section.sectionId),
      classNbr: String(section.classNbr),
      sectionCode: section.sectionCode ?? null,
      componentType: section.componentType ?? section.classType ?? null,
      instructors: Array.isArray(section.instructors)
        ? section.instructors
        : [],
      meetings: Array.isArray(section.meetings) ? section.meetings : [],
    })),
  };
}

function instructorNames(canonical: CanonicalBundle) {
  return canonical.sections.flatMap((section) =>
    Array.isArray(section.instructors)
      ? section.instructors.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
}

function normalizeInstructor(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function candidateBundleSectionIds(canonical: CanonicalBundle) {
  return new Set(
    canonical.sections.flatMap((section) => [
      String(section.sectionId),
      String(section.classNbr),
      `${canonical.offering.offeringId}:${section.classNbr}`,
    ]),
  );
}

function canonicalCourseCode(canonical: CanonicalBundle) {
  return String(canonical.course.courseCode).replace(/\s+/g, "").toUpperCase();
}

function canonicalMeetings(canonical: CanonicalBundle) {
  return bundleMeetings(canonical) as Array<{
    startDate?: string | null;
    endDate?: string | null;
    weekdays?: string[];
    startTime?: string | null;
    endTime?: string | null;
    timezone?: string | null;
    facilityId?: string | null;
    venue?: string | null;
  }>;
}

function scheduleInput(canonical: CanonicalBundle) {
  return {
    bundleId: String(canonical.bundle.bundleId),
    courseCode: canonicalCourseCode(canonical),
    sectionLabels: (canonical.bundle.sectionLabels ?? []) as string[],
    meetings: canonicalMeetings(canonical),
    termCode: canonical.termCode,
  };
}

function selectedCourse(canonical: CanonicalBundle) {
  return String(canonical.course.courseId);
}

type CandidateSchedule = {
  canonical: CanonicalBundle;
  metrics: ScheduleMetrics;
  violation?: string;
};

function optionHorizon(
  value: ReturnType<typeof verifyAutoPlanToken>["horizon"],
  timezone: string,
): PlanningHorizon | null {
  if (!value) return null;
  const start = Temporal.PlainDate.from(value.start);
  const end = Temporal.PlainDate.from(value.end);
  if (Temporal.PlainDate.compare(start, end) > 0)
    throw new Error("invalid option horizon");
  const from = start.toZonedDateTime(timezone).toInstant();
  const to = end.add({ days: 1 }).toZonedDateTime(timezone).toInstant();
  return {
    start,
    end,
    weeks: [...value.weeks],
    window: {
      from: new Date(from.epochMilliseconds).toISOString(),
      to: new Date(to.epochMilliseconds).toISOString(),
    },
  };
}

function recommendationTimeScore(
  canonical: CanonicalBundle,
  request: RecommendationRequest,
) {
  const meetings = bundleMeetings(canonical);
  let score = 100;
  for (const meeting of meetings) {
    for (const day of meeting.weekdays ?? [])
      if (request.avoidWeekdays.includes(day as never)) score -= 20;
  }
  for (const preferred of request.preferredWindows) {
    const met = meetings.some((meeting) => {
      if (
        !(meeting.weekdays ?? []).some((day: string) =>
          preferred.weekdays.includes(day as never),
        )
      )
        return false;
      if (!meeting.startTime || !meeting.endTime) return false;
      if (
        meeting.startTime >= preferred.endTime ||
        meeting.endTime <= preferred.startTime
      )
        return false;
      if (
        preferred.startDate &&
        meeting.endDate &&
        meeting.endDate < preferred.startDate
      )
        return false;
      if (
        preferred.endDate &&
        meeting.startDate &&
        meeting.startDate >= preferred.endDate
      )
        return false;
      return true;
    });
    if (!met) score -= 10;
  }
  return Math.max(0, score);
}

function planItemResponse(
  item: CoursePlanItem,
  canonical: CanonicalBundle | null,
  referenceState: "active" | "retired" | "missing",
) {
  const course = canonical?.course;
  const bundle = canonical?.bundle;
  return {
    ...item,
    referenceState,
    ...(course
      ? {
          course: {
            courseId: course.courseId,
            courseCode: course.courseCode,
            title: course.title,
            credits: course.credits ?? null,
          },
        }
      : {}),
    ...(bundle
      ? {
          bundle: {
            bundleId: bundle.bundleId,
            offeringId: bundle.offeringId,
            sectionLabels: bundle.sectionLabels ?? [],
            componentClassNbrs: bundle.componentClassNbrs ?? [],
            derivedSchedule: bundle.derivedSchedule ?? { meetings: [] },
            source: bundle.bindingSource ?? bundle.source ?? "derived",
            bindingEvidence: bundle.bindingEvidence ?? null,
          },
        }
      : {}),
  };
}

export class CoursePlanService {
  constructor(
    private readonly plans: CoursePlanRepository,
    private readonly catalog: CourseCatalogRepository,
    private readonly events: {
      calendarCandidates(
        owner: string,
        window: { from: string; to: string },
      ): AsyncIterable<WithId<EventDocument>>;
      activeImportedEvents(owner: string): Promise<WithId<EventDocument>[]>;
      suppressedKeys(owner: string): Promise<string[]>;
    },
    private readonly records: import("mongodb").Collection<IdempotencyRecordDocument>,
    private readonly settings: PlanSettings,
    private readonly commonCore?: CommonCoreRepository,
  ) {}

  private async document(owner: string, id: string): Promise<PlanWithId> {
    const document = await this.plans.findById(owner, planId(id));
    if (!document) throw new PlanError("not_found", 404, "Plan not found");
    return document;
  }

  private async hydrateItem(
    termCode: string,
    item: CoursePlanItem,
    currentBatchId?: string,
  ) {
    let canonical: CanonicalBundle | null = null;
    let referenceState: "active" | "retired" | "missing" = "missing";
    if (currentBatchId) {
      const term = {
        termCode,
        activeImportBatchId: currentBatchId,
      };
      canonical = await this.catalog.activeBundleById(term, item.bundleId);
      if (canonical) referenceState = "active";
    }
    if (!canonical && item.sourceVersion) {
      canonical = await this.catalog.resolveBundleAtBatch(
        termCode,
        item.sourceVersion,
        item.offeringId,
        item.bundleId,
      );
      if (canonical) referenceState = "retired";
    }
    return planItemResponse(item, canonical, referenceState);
  }

  private async response(document: PlanWithId) {
    const term = await this.catalog.term(document.termCode);
    if (!term) throw new PlanError("not_found", 404, "Academic term not found");
    const items = await Promise.all(
      document.items.map((item) =>
        this.hydrateItem(
          document.termCode,
          item,
          typeof term.activeImportBatchId === "string"
            ? term.activeImportBatchId
            : undefined,
        ),
      ),
    );
    return {
      id: document._id.toHexString(),
      name: document.name,
      termCode: document.termCode,
      ...(document.description === undefined || document.description === null
        ? {}
        : { description: document.description }),
      status: document.status,
      revision: document.revision,
      items,
      ...(document.lastAutoPlanApply
        ? { lastAutoPlanApply: document.lastAutoPlanApply }
        : {}),
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      term: {
        termCode: term.termCode,
        displayName: term.displayName ?? term.termCode,
        localizedName: term.localizedName ?? term.displayName ?? term.termCode,
        season: term.season ?? "unknown",
        academicYearStart: term.academicYearStart ?? null,
        academicYearEnd: term.academicYearEnd ?? null,
      },
    };
  }

  async create(owner: string, input: unknown) {
    const value = normalizePlanCreate(input);
    await this.catalog.activeTerm(value.termCode);
    const timestamp = nowIso(this.settings);
    const document: PlanWithId = {
      _id: new ObjectId(),
      ownerUsername: owner,
      ...value,
      status: "draft",
      revision: 1,
      items: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await this.plans.insert(document);
    } catch (error) {
      if (isDuplicate(error))
        throw new PlanError(
          "active_plan_exists",
          409,
          "An active plan already exists for this term",
        );
      throw error;
    }
    return this.response(document);
  }

  async list(
    owner: string,
    options: {
      limit: number;
      termCode?: string;
      status?: PlanStatus;
      cursor?: string;
    },
  ) {
    const now = this.settings.now?.().getTime() ?? Date.now();
    const after = options.cursor
      ? decodeCursor(
          this.settings.cursorKey,
          options.cursor,
          owner,
          this.settings.cursorTtlSeconds,
          now,
        )
      : undefined;
    const rows = await this.plans.list(owner, {
      ...options,
      after,
    });
    const visible = rows.slice(0, options.limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => ({
        id: row._id.toHexString(),
        name: row.name,
        termCode: row.termCode,
        ...(row.description == null ? {} : { description: row.description }),
        status: row.status,
        revision: row.revision,
        itemCount: row.items.length,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      page: {
        hasMore: rows.length > options.limit,
        nextCursor:
          rows.length > options.limit && last
            ? encodeCursor(
                this.settings.cursorKey,
                owner,
                last.updatedAt,
                last._id,
                now,
              )
            : null,
      },
      meta: {},
    };
  }

  async get(owner: string, id: string) {
    return this.response(await this.document(owner, id));
  }

  private async blockingConflicts(
    owner: string,
    canonicalBundles: CanonicalBundle[],
  ) {
    const dated = canonicalBundles.flatMap((canonical) =>
      bundleMeetings(canonical).flatMap((meeting) =>
        [meeting.startDate, meeting.endDate].filter(
          (value): value is string => typeof value === "string",
        ),
      ),
    );
    if (!dated.length) return [];
    const dates = dated.sort();
    const termTimezone = this.settings.timezone;
    const from = Temporal.PlainDate.from(dates[0]!)
      .toZonedDateTime(termTimezone)
      .toInstant();
    const to = Temporal.PlainDate.from(dates.at(-1)!)
      .add({ days: 1 })
      .toZonedDateTime(termTimezone)
      .toInstant();
    const window = {
      from: new Date(from.epochMilliseconds).toISOString(),
      to: new Date(to.epochMilliseconds).toISOString(),
    };
    const projected: CalendarOccurrence[] = [];
    for (const canonical of canonicalBundles) {
      const expanded = expandCourseBundle(
        {
          bundleId: canonical.bundle.bundleId,
          courseCode: canonical.course.courseCode,
          sectionLabels: canonical.bundle.sectionLabels ?? [],
          meetings: bundleMeetings(canonical),
          termCode: canonical.termCode,
        },
        window,
        termTimezone,
      );
      projected.push(...expanded.items);
    }
    const suppressed = new Set(await this.events.suppressedKeys(owner));
    const effectiveCourses = projected.filter(
      (item) => !suppressed.has(item.calendarKey),
    );
    const expandEvent = (await import("../domain/calendar.js"))
      .expandManualEvent;
    const manualEvents: WithId<EventDocument>[] = [];
    for await (const event of this.events.calendarCandidates(owner, window))
      manualEvents.push(event);
    for (const event of manualEvents) {
      const expanded = expandEvent(event, window, 10000);
      projected.push(...expanded.filter((item) => item.blocksTime));
    }
    const effectiveImports = await this.events.activeImportedEvents(owner);
    projected.push(
      ...expandIcsSeries(effectiveImports, window, 10000).filter(
        (item) => item.blocksTime,
      ),
    );
    const result = detectConflicts(
      [
        ...effectiveCourses,
        ...projected.filter((item) => ["manual", "ics"].includes(item.source)),
      ],
      termTimezone,
      10000,
    );
    return result.blocking;
  }

  private async validateSelected(owner: string, document: PlanWithId) {
    const selected = document.items.filter(
      (item) => item.status === "selected",
    );
    const resolved: CanonicalBundle[] = [];
    for (const item of selected) {
      const term = await this.catalog.activeTerm(document.termCode);
      const canonical = await this.catalog.activeBundleById(
        term,
        item.bundleId,
      );
      if (!canonical || canonical.bundle.offeringId !== item.offeringId)
        throw new PlanError(
          "stale_reference",
          409,
          "A selected course reference is no longer active",
        );
      resolved.push(canonical);
    }
    const conflicts = await this.blockingConflicts(owner, resolved);
    if (conflicts.length)
      throw new PlanError(
        "conflict_detected",
        409,
        "Selected courses conflict with a blocking calendar item",
      );
    return resolved;
  }

  private async commit(
    owner: string,
    document: PlanWithId,
    updates: Partial<PlanWithId>,
  ) {
    await this.finalizePendingAutoPlan(owner, document);
    if (
      !(await this.plans.compareAndSet(
        owner,
        document._id,
        document.revision,
        updates,
      ))
    ) {
      const latest = await this.plans.findById(owner, document._id);
      if (!latest) throw new PlanError("not_found", 404, "Plan not found");
      throw new PlanError("concurrent_modification", 409, "Plan has changed", {
        currentRevision: String(latest.revision),
      });
    }
    return {
      ...document,
      ...updates,
      revision: document.revision + 1,
    } as PlanWithId;
  }

  async patch(owner: string, id: string, revision: number, input: unknown) {
    const document = await this.document(owner, id);
    if (document.status === "archived")
      throw new PlanError(
        "readonly_resource",
        409,
        "Archived plans are read-only",
      );
    if (document.revision !== revision)
      throw new PlanError("concurrent_modification", 409, "Plan has changed", {
        currentRevision: String(document.revision),
      });
    const value = normalizePlanPatch(input) as {
      name?: string;
      description?: string | null;
      status?: "active" | "archived";
    };
    if (value.status && !isAllowedPlanTransition(document.status, value.status))
      throw new PlanError(
        "invalid_state_transition",
        409,
        "Invalid plan status transition",
      );
    if (value.status === "active") await this.validateSelected(owner, document);
    if (value.status === "active") {
      try {
        return this.response(
          await this.commit(owner, document, {
            ...value,
            updatedAt: nowIso(this.settings),
          }),
        );
      } catch (error) {
        if (isDuplicate(error))
          throw new PlanError(
            "active_plan_exists",
            409,
            "An active plan already exists for this term",
          );
        throw error;
      }
    }
    return this.response(
      await this.commit(owner, document, {
        ...value,
        updatedAt: nowIso(this.settings),
      }),
    );
  }

  async remove(owner: string, id: string, revision: number) {
    const document = await this.document(owner, id);
    if (document.status === "archived") return document;
    if (document.revision !== revision)
      throw new PlanError("concurrent_modification", 409, "Plan has changed", {
        currentRevision: String(document.revision),
      });
    return this.commit(owner, document, {
      status: "archived",
      updatedAt: nowIso(this.settings),
    });
  }

  private async itemBase(
    document: PlanWithId,
    value: ReturnType<typeof normalizeItemCreate>,
  ): Promise<{ item: CoursePlanItem; canonical: CanonicalBundle }> {
    const term = await this.catalog.activeTerm(document.termCode);
    const canonical = await this.catalog.resolveBundle(
      term,
      value.offeringId,
      value.bundleId,
    );
    const timestamp = nowIso(this.settings);
    return {
      canonical,
      item: {
        itemId: randomUUID(),
        courseId: String(canonical.offering.courseId),
        offeringId: value.offeringId,
        bundleId: value.bundleId,
        componentClassNbrs: [...(canonical.bundle.componentClassNbrs ?? [])],
        courseCodeSnapshot: String(canonical.course.courseCode),
        sectionLabelsSnapshot: [...(canonical.bundle.sectionLabels ?? [])],
        ...(value.colorOverride === undefined
          ? {}
          : { colorOverride: value.colorOverride }),
        ...(value.note === undefined ? {} : { note: value.note }),
        status: value.status,
        sourceVersion: term.activeImportBatchId,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
  }

  async addItem(owner: string, id: string, revision: number, input: unknown) {
    const document = await this.document(owner, id);
    if (document.status === "archived")
      throw new PlanError(
        "readonly_resource",
        409,
        "Archived plans are read-only",
      );
    if (document.revision !== revision)
      throw new PlanError("concurrent_modification", 409, "Plan has changed", {
        currentRevision: String(document.revision),
      });
    const value = normalizeItemCreate(input);
    if (document.items.some((item) => item.bundleId === value.bundleId))
      throw new PlanError("duplicate_bundle", 409, "Bundle is already in plan");
    const { item, canonical } = await this.itemBase(document, value);
    const items = [...document.items, item];
    assertPlanItemInvariants(items);
    if (item.status === "selected") {
      const conflicts = await this.blockingConflicts(owner, [
        canonical,
        ...(await this.selectedCanonicals(document)),
      ]);
      if (conflicts.length)
        throw new PlanError(
          "conflict_detected",
          409,
          "Selected course conflicts with a blocking calendar item",
        );
    }
    return this.response(
      await this.commit(owner, document, {
        items,
        updatedAt: nowIso(this.settings),
      }),
    );
  }

  private async selectedCanonicals(
    document: PlanWithId,
    exceptCourseId?: string,
  ) {
    const term = await this.catalog.activeTerm(document.termCode);
    const result: CanonicalBundle[] = [];
    for (const item of document.items) {
      if (item.status !== "selected" || item.courseId === exceptCourseId)
        continue;
      const canonical = await this.catalog.activeBundleById(
        term,
        item.bundleId,
      );
      if (!canonical)
        throw new PlanError(
          "stale_reference",
          409,
          "A selected course reference is no longer active",
        );
      result.push(canonical);
    }
    return result;
  }

  async recommendations(owner: string, id: string, input: unknown) {
    const request = normalizeRecommendationRequest(input);
    const evaluationNow = this.settings.now?.() ?? new Date();
    const document = await this.document(owner, id);
    if (document.status === "archived")
      throw new PlanError(
        "readonly_resource",
        409,
        "Archived plans cannot generate recommendations",
      );
    const term = await this.catalog.activeTerm(document.termCode);
    const offeringRows = await this.catalog.findOfferingsByCode(
      term,
      request.targetCourseId,
      request.academicCareer,
    );
    if (!offeringRows.length) {
      if (!(await this.catalog.courseCodeExists(request.targetCourseId)))
        throw new PlanError("unknown_course_code", 400, "Unknown course code");
      return {
        planId: document._id.toHexString(),
        generatedAt: nowIso(this.settings),
        constraints: request,
        items: [],
        meta: {},
      };
    }
    const careers = new Set(
      offeringRows.map((row) => row.offering.academicCareer),
    );
    if (request.academicCareer === undefined && careers.size > 1)
      throw new PlanError(
        "ambiguous_offering",
        400,
        "Course code maps to multiple academic careers",
        {
          academicCareer: "must be supplied for an ambiguous course offering",
        },
      );
    const targetCourseId = String(offeringRows[0]!.course.courseId);
    if (request.excludedCourseIds.includes(targetCourseId))
      return {
        planId: document._id.toHexString(),
        generatedAt: nowIso(this.settings),
        constraints: request,
        items: [],
        meta: {},
      };
    const selected = await this.selectedCanonicals(document, targetCourseId);
    const oldTarget = document.items.find(
      (item) => item.status === "selected" && item.courseId === targetCourseId,
    );
    const selectedCredits = selected.reduce<number | null>((sum, canonical) => {
      if (sum === null) return null;
      return typeof canonical.course.credits === "number"
        ? sum + canonical.course.credits
        : null;
    }, 0);
    const bundleRows = await this.catalog.bundlesForOffering(
      term,
      String(offeringRows[0]!.offering.offeringId),
    );
    const sectionIds = bundleRows.flatMap((bundle) =>
      (bundle.componentClassNbrs ?? []).map(
        (classNbr: string) => `${bundle.offeringId}:${classNbr}`,
      ),
    );
    const quotaRows = await this.catalog.latestQuotas(sectionIds);
    const quotas = new Map(
      quotaRows.map((quota) => [String(quota.sectionId), quota]),
    );
    const quotaHistoryRows = await this.catalog.quotaHistory(sectionIds);
    const quotaHistory = new Map<string, Document[]>();
    for (const row of quotaHistoryRows) {
      const group = quotaHistory.get(String(row.sectionId)) ?? [];
      group.push(row);
      quotaHistory.set(String(row.sectionId), group);
    }
    const items = [];
    const rejected: Array<{
      bundle: Record<string, unknown>;
      reasons: string[];
    }> = [];
    for (const bundle of bundleRows) {
      const canonical = await this.catalog.resolveBundle(
        term,
        String(bundle.offeringId),
        String(bundle.bundleId),
      );
      const quota = historicalQuotaBundleScore(canonical, quotas, quotaHistory);
      const histories = canonical.sections.map((section) =>
        calculateQuotaTrend(
          (quotaHistory.get(String(section.sectionId)) ??
            []) as unknown as import("../domain/quota.js").QuotaObservationLike[],
          "14d",
          evaluationNow,
        ),
      );
      const difficulties = canonical.sections.map((section, index) =>
        enrollmentDifficulty(
          quotas.get(String(section.sectionId)) as unknown as
            | import("../domain/quota.js").QuotaObservationLike
            | undefined,
          histories[index],
        ),
      );
      const knownDifficulties = difficulties.filter(
        (value) => value.score !== null,
      );
      const componentNames = [
        "remaining_pressure",
        "waitlist_pressure",
        "seat_trend",
        "openness",
      ] as const;
      const difficulty = {
        version: "difficulty-v1" as const,
        score: knownDifficulties.length
          ? Math.round(
              (knownDifficulties.reduce(
                (sum, value) => sum + (value.score ?? 0),
                0,
              ) /
                knownDifficulties.length) *
                100,
            ) / 100
          : null,
        components: componentNames.flatMap((name) => {
          const values = difficulties.flatMap((value) =>
            value.components.filter((component) => component.name === name),
          );
          if (!values.length) return [];
          return [
            {
              name,
              value:
                Math.round(
                  (values.reduce((sum, value) => sum + (value.value ?? 0), 0) /
                    values.length) *
                    100,
                ) / 100,
              weight: values[0]!.weight,
            },
          ];
        }),
        dataQuality: [
          ...new Set(difficulties.flatMap((value) => value.dataQuality)),
        ],
      };
      const historicalStability = histories.every(
        (value) => value.status === "ready",
      )
        ? 100
        : null;
      const credits =
        typeof canonical.course.credits === "number"
          ? canonical.course.credits
          : null;
      const projectedCredits =
        selectedCredits === null || credits === null
          ? null
          : selectedCredits + credits;
      const reasons: string[] = [];
      if (quota.closed) reasons.push("a required section is closed");
      if (!request.allowWaitlist && quota.full)
        reasons.push("a required section has no remaining seats");
      if (
        request.minCredits !== undefined &&
        (projectedCredits === null || projectedCredits < request.minCredits)
      )
        reasons.push("projected credits are below the minimum");
      if (
        request.maxCredits !== undefined &&
        (projectedCredits === null || projectedCredits > request.maxCredits)
      )
        reasons.push("projected credits exceed the maximum");
      const timeScore = recommendationTimeScore(canonical, request);
      if (timeScore < 100 && request.avoidWeekdays.length)
        reasons.push("includes an avoided weekday");
      const expanded = bundleMeetings(canonical);
      const candidateCalendar = expandCourseBundle(
        {
          bundleId: canonical.bundle.bundleId,
          courseCode: canonical.course.courseCode,
          sectionLabels: canonical.bundle.sectionLabels ?? [],
          meetings: expanded,
          termCode: document.termCode,
        },
        { from: "2000-01-01T00:00:00.000Z", to: "2037-01-01T00:00:00.000Z" },
        this.settings.timezone,
      );
      const existingCalendar = selected.flatMap(
        (row) =>
          expandCourseBundle(
            {
              bundleId: row.bundle.bundleId,
              courseCode: row.course.courseCode,
              sectionLabels: row.bundle.sectionLabels ?? [],
              meetings: bundleMeetings(row),
              termCode: document.termCode,
            },
            {
              from: "2000-01-01T00:00:00.000Z",
              to: "2037-01-01T00:00:00.000Z",
            },
            this.settings.timezone,
          ).items,
      );
      const unavailableViolation = hardMeetingViolation(
        canonicalMeetings(canonical),
        {
          unavailableWindows: request.unavailableWindows,
          freeWeekdays: [],
          protectedWindows: [],
          preferredWindows: [],
          preferredInstructorNames: [],
        },
        derivePlanningHorizon(
          canonicalMeetings(canonical),
          this.settings.timezone,
          3660,
        ),
      );
      if (unavailableViolation) reasons.push(unavailableViolation);
      if (
        detectConflicts(
          [...existingCalendar, ...candidateCalendar.items],
          this.settings.timezone,
          100,
        ).blocking.length
      )
        reasons.push("has a hard conflict with the selected plan");
      if (
        (await this.blockingConflicts(owner, [...selected, canonical])).length
      )
        reasons.push("has a hard conflict with a blocking calendar item");
      const bundleResponse = {
        bundleId: canonical.bundle.bundleId,
        offeringId: canonical.offering.offeringId,
        courseCode: canonical.course.courseCode,
        sectionLabels: canonical.bundle.sectionLabels ?? [],
        componentClassNbrs: canonical.bundle.componentClassNbrs ?? [],
      };
      if (reasons.length) {
        rejected.push({ bundle: bundleResponse, reasons });
        continue;
      }
      const creditFit =
        request.minCredits === undefined && request.maxCredits === undefined
          ? 50
          : 100;
      const scoreParts = [
        { value: timeScore, weight: 35 },
        { value: creditFit, weight: 15 },
        ...(quota.unknown ? [] : [{ value: quota.score, weight: 25 }]),
        ...(difficulty.score === null
          ? []
          : [{ value: 100 - difficulty.score, weight: 15 }]),
        ...(historicalStability === null
          ? []
          : [{ value: historicalStability, weight: 10 }]),
      ];
      const score =
        Math.round(
          (scoreParts.reduce(
            (total, part) => total + part.value * part.weight,
            0,
          ) /
            scoreParts.reduce((total, part) => total + part.weight, 0)) *
            100,
        ) / 100;
      items.push({
        bundle: bundleResponse,
        score,
        scoreComponents: {
          timeFit: timeScore,
          creditFit,
          quotaAvailability: quota.score,
          enrollmentDifficulty: difficulty.score,
          historicalStability,
        },
        quotaFreshness: canonical.sections.map((section) => {
          const latest = quotas.get(String(section.sectionId));
          return {
            sectionId: String(section.sectionId),
            observedAt: latest?.observedAt ?? null,
            isStale: quotaIsStale(latest, this.settings, evaluationNow),
          };
        }),
        reasons: [
          quota.unknown
            ? "latest quota is incomplete"
            : quota.full
              ? "a required section is full; waitlist is allowed"
              : "latest quota is available",
        ],
        dataQuality: [
          ...(quota.unknown ? ["quota_unknown"] : []),
          ...(quota.inconsistent ? ["quota_inconsistent"] : []),
          ...quota.dataQuality,
          ...(canonical.sections.some((section) =>
            quotaIsStale(
              quotas.get(String(section.sectionId)),
              this.settings,
              evaluationNow,
            ),
          )
            ? ["quota_stale"]
            : []),
          ...difficulty.dataQuality,
        ],
        replacementItemId: oldTarget?.itemId ?? null,
      });
    }
    items.sort(
      (a, b) =>
        b.score - a.score ||
        a.bundle.courseCode.localeCompare(b.bundle.courseCode) ||
        a.bundle.bundleId.localeCompare(b.bundle.bundleId),
    );
    return {
      planId: document._id.toHexString(),
      generatedAt: nowIso(this.settings),
      constraints: request,
      items: items.slice(0, request.maxRecommendations),
      meta: {
        rejected: rejected.slice(0, 50),
        scoreVersion: "recommendation-score-v2-quota-history-phase8",
      },
    };
  }

  private normalizeAuto(input: unknown) {
    return normalizeAutoPlanRequest(input);
  }

  private async fillerCanonicals(
    term: import("../repositories/course-catalog.js").ActiveTerm,
    request: NormalizedAutoPlanRequest,
    excludedCodes: Set<string>,
  ) {
    const fill = request.fill;
    if (!fill || fill.maxCourses === 0)
      return {
        canonicals: [] as CanonicalBundle[],
        diagnostics: [] as string[],
        commonCore: null as {
          catalogVersion: string;
          stateRevision: number;
        } | null,
      };
    const seedCodes = new Set(fill.courseCodes);
    let commonCore: {
      catalogVersion: string;
      stateRevision: number;
    } | null = null;
    if (fill.commonCoreCategoryIds?.length) {
      if (!this.commonCore)
        throw new PlanError(
          "common_core_unavailable",
          503,
          "Common Core classification is unavailable",
        );
      if (fill.commonCoreAdmissionYear === undefined)
        throw new PlanError(
          "invalid_request",
          400,
          "fill.commonCoreAdmissionYear is required with Common Core categories",
        );
      const preset = await this.commonCore.courseCodesForCategories(
        fill.commonCoreAdmissionYear,
        fill.commonCoreCategoryIds,
        this.settings.now?.() ?? new Date(),
        this.settings.commonCoreMaxAgeDays ?? 365,
      );
      commonCore = {
        catalogVersion: preset.catalogVersion,
        stateRevision: preset.stateRevision,
      };
      for (const code of preset.courseCodes) seedCodes.add(code);
    }
    for (const code of fill.courseCodes) {
      if (!(await this.catalog.courseCodeExists(code)))
        throw new PlanError("unknown_course_code", 400, "Unknown course code", {
          courseCode: code,
        });
    }
    const rows = await this.catalog.fillOfferings(term, {
      courseCodes: [...seedCodes],
      subjects: fill.subjects,
      levels: fill.levels,
      academicCareer: fill.academicCareer,
    });
    const careers = new Map<string, Set<string>>();
    for (const row of rows) {
      const code = canonicalCourseCode({
        course: row.course,
      } as CanonicalBundle);
      if (excludedCodes.has(code)) continue;
      const set = careers.get(code) ?? new Set<string>();
      set.add(String(row.offering.academicCareer ?? ""));
      careers.set(code, set);
    }
    if (careers.size > 40)
      throw new PlanError(
        "candidate_pool_too_large",
        400,
        "Filler pool exceeds 40 distinct courses",
      );
    if (!fill.academicCareer) {
      const ambiguous = [...careers.entries()]
        .filter(([, values]) => values.size > 1)
        .map(([code]) => code)
        .sort();
      if (ambiguous.length)
        throw new PlanError(
          "ambiguous_offering",
          400,
          "Filler course code maps to multiple academic careers",
          { courseCodes: ambiguous.slice(0, 20).join(",") },
        );
    }
    const canonicals: CanonicalBundle[] = [];
    const offeredCodes = new Set(
      rows.map((row) =>
        canonicalCourseCode({ course: row.course } as CanonicalBundle),
      ),
    );
    const diagnostics = fill.courseCodes
      .filter((code) => !offeredCodes.has(code))
      .map((code) => `${code} is not offered in ${term.termCode}`);
    const seenCourses = new Set<string>();
    for (const row of rows) {
      if (seenCourses.has(String(row.course.courseId))) continue;
      if (
        fill.minCredits !== undefined &&
        (typeof row.course.credits !== "number" ||
          row.course.credits < fill.minCredits)
      )
        continue;
      if (
        fill.maxCredits !== undefined &&
        (typeof row.course.credits !== "number" ||
          row.course.credits > fill.maxCredits)
      )
        continue;
      const bundles = await this.catalog.bundlesForOffering(
        term,
        String(row.offering.offeringId),
      );
      for (const bundle of bundles) {
        const canonical = await this.catalog.resolveBundle(
          term,
          String(bundle.offeringId),
          String(bundle.bundleId),
        );
        canonicals.push(canonical);
      }
      seenCourses.add(String(row.course.courseId));
    }
    return { canonicals, diagnostics, commonCore };
  }

  async autoPlans(owner: string, id: string, input: unknown) {
    const request = this.normalizeAuto(input);
    const evaluationNow = this.settings.now?.() ?? new Date();
    const document = await this.document(owner, id);
    if (document.status === "archived")
      throw new PlanError(
        "readonly_resource",
        409,
        "Archived plans cannot generate auto-plans",
      );
    if (
      (this.settings.autoPlanMaxRequestBytes ?? 32_768) <
      Buffer.byteLength(JSON.stringify(request))
    )
      throw new PlanError(
        "invalid_request",
        400,
        "Normalized request is too large",
      );
    const term = await this.catalog.activeTerm(document.termCode);
    const deadline =
      Date.now() + (this.settings.autoPlanSolverTimeoutMs ?? 8_000);
    const requested = [...request.courses];
    if (request.includeCurrentSelected) {
      for (const item of document.items.filter(
        (item) => item.status === "selected",
      )) {
        const courseCode = item.courseCodeSnapshot
          .replace(/\s+/g, "")
          .toUpperCase();
        if (!requested.some((course) => course.courseCode === courseCode))
          requested.push({
            courseCode,
            required: false,
            priority: 3,
            excludedSectionIds: [],
            excludedInstructorNames: [],
          });
      }
    }
    const maxDesiredCourses = this.settings.autoPlanMaxDesiredCourses ?? 20;
    if (requested.length > maxDesiredCourses)
      throw new PlanError(
        "invalid_request",
        400,
        `At most ${maxDesiredCourses} desired courses are allowed`,
      );
    if (!requested.length)
      throw new PlanError(
        "invalid_request",
        400,
        "At least one desired course is required",
      );
    const normalizedRequest: NormalizedAutoPlanRequest = validateAutoPlanGroups(
      {
        ...request,
        courses: requested,
      },
    );
    if (
      Buffer.byteLength(JSON.stringify(normalizedRequest)) >
      (this.settings.autoPlanMaxRequestBytes ?? 32_768)
    )
      throw new PlanError(
        "invalid_request",
        400,
        "Normalized request is too large",
      );
    const canonicalById = new Map<string, CanonicalBundle>();
    const sectionIds: string[] = [];
    const diagnostics: Array<{ code: string; message: string }> = [];
    const rawCandidates: Array<{
      canonical: CanonicalBundle;
      course: (typeof requested)[number];
    }> = [];
    for (const course of requested) {
      const rows = await this.catalog.findOfferingsByCode(
        term,
        course.courseCode,
        course.academicCareer,
      );
      if (!rows.length) {
        if (!(await this.catalog.courseCodeExists(course.courseCode)))
          throw new PlanError(
            "unknown_course_code",
            400,
            "Unknown course code",
          );
        diagnostics.push({
          code: "course_not_offered",
          message: `${course.courseCode} is valid but not offered in ${document.termCode}`,
        });
        continue;
      }
      if (
        course.academicCareer === undefined &&
        new Set(rows.map((row) => row.offering.academicCareer)).size > 1
      )
        throw new PlanError(
          "ambiguous_offering",
          400,
          "Course code maps to multiple academic careers",
        );
      const rawCandidateCount = rawCandidates.length;
      for (const row of rows) {
        const bundles = await this.catalog.bundlesForOffering(
          term,
          String(row.offering.offeringId),
        );
        for (const bundle of bundles) {
          if (
            course.lockedBundleId &&
            course.lockedBundleId !== bundle.bundleId
          )
            continue;
          const bundleSections = new Set(
            (bundle.componentClassNbrs ?? []).flatMap((classNbr: string) => [
              classNbr,
              `${bundle.offeringId}:${classNbr}`,
            ]),
          );
          if (
            course.lockedSectionIds?.some(
              (sectionId) => !bundleSections.has(sectionId),
            )
          )
            continue;
          if (
            course.excludedSectionIds.some((sectionId) =>
              bundleSections.has(sectionId),
            )
          )
            continue;
          const canonical = await this.catalog.resolveBundle(
            term,
            String(bundle.offeringId),
            String(bundle.bundleId),
          );
          const id = String(bundle.bundleId);
          canonicalById.set(id, canonical);
          sectionIds.push(
            ...(bundle.componentClassNbrs ?? []).map(
              (classNbr: string) => `${bundle.offeringId}:${classNbr}`,
            ),
          );
          rawCandidates.push({ canonical, course });
        }
      }
      if (
        rawCandidates.length === rawCandidateCount &&
        (course.lockedBundleId || course.lockedSectionIds?.length)
      )
        diagnostics.push({
          code: "lock_conflict",
          message: `${course.courseCode} has no active bundle satisfying its lock`,
        });
    }

    const fillerPool = await this.fillerCanonicals(
      term,
      normalizedRequest,
      new Set(requested.map((course) => course.courseCode)),
    );
    const rawFillerCanonicals = fillerPool.canonicals;
    for (const canonical of rawFillerCanonicals) {
      canonicalById.set(String(canonical.bundle.bundleId), canonical);
      sectionIds.push(
        ...canonical.sections.map((section) => String(section.sectionId)),
      );
    }

    const allMeetings = [
      ...rawCandidates.flatMap(({ canonical }) => canonicalMeetings(canonical)),
      ...rawFillerCanonicals.flatMap((canonical) =>
        canonicalMeetings(canonical),
      ),
    ];
    const hasDatedMeeting = allMeetings.some(
      (meeting) => meeting.startDate || meeting.endDate,
    );
    const horizon = hasDatedMeeting
      ? derivePlanningHorizon(
          allMeetings,
          this.settings.timezone,
          this.settings.autoPlanMaxHorizonDays ?? 240,
        )
      : null;
    if (hasDatedMeeting && !horizon)
      throw new PlanError(
        "invalid_request",
        400,
        "Course meeting horizon exceeds the configured limit",
      );
    const quotaRows = await this.catalog.latestQuotas([...new Set(sectionIds)]);
    const quotas = new Map(
      quotaRows.map((quota) => [String(quota.sectionId), quota]),
    );
    const quotaHistoryRows = await this.catalog.quotaHistory([
      ...new Set(sectionIds),
    ]);
    const quotaHistory = new Map<string, Document[]>();
    for (const row of quotaHistoryRows) {
      const group = quotaHistory.get(String(row.sectionId)) ?? [];
      group.push(row);
      quotaHistory.set(String(row.sectionId), group);
    }
    const candidateSchedules = new Map<string, CandidateSchedule>();
    const candidates: SolverCandidate[] = [];
    const suppressedCalendarKeys = new Set(
      await this.events.suppressedKeys(owner),
    );
    let occurrenceCount = 0;
    for (const { canonical, course } of rawCandidates) {
      const id = String(canonical.bundle.bundleId);
      const quota = historicalQuotaBundleScore(canonical, quotas, quotaHistory);
      const hasCreditBound =
        request.constraints.minCredits !== undefined ||
        request.constraints.maxCredits !== undefined;
      if (hasCreditBound && typeof canonical.course.credits !== "number") {
        diagnostics.push({
          code: "unknown_credits",
          message: `${course.courseCode} has no known credits for the requested credit bound`,
        });
        continue;
      }
      if (
        quota.closed ||
        (!request.allowFullWaitlist && quota.full) ||
        (request.unknownQuotaPolicy === "exclude" && quota.unknown)
      ) {
        diagnostics.push({
          code: "section_unavailable",
          message: `${course.courseCode} has no eligible section bundle`,
        });
        continue;
      }
      const excludedInstructors = new Set(
        course.excludedInstructorNames.map(normalizeInstructor),
      );
      if (
        instructorNames(canonical).some((name) =>
          excludedInstructors.has(normalizeInstructor(name)),
        )
      )
        continue;
      const expanded = horizon
        ? expandCourseBundle(
            scheduleInput(canonical),
            horizon.window,
            this.settings.timezone,
          )
        : { items: [], partial: true };
      occurrenceCount += expanded.items.length;
      const metrics = scheduleMetrics(
        expanded.items,
        expanded.partial,
        this.settings.timezone,
      );
      const temporalViolation = hardMeetingViolation(
        canonicalMeetings(canonical),
        request.constraints,
        horizon,
      );
      const aggregateViolation = violatesAggregateConstraints(
        metrics,
        request.constraints,
        horizon,
      );
      if (temporalViolation || aggregateViolation) {
        diagnostics.push({
          code: temporalViolation
            ? "hard_time_constraint"
            : "hard_schedule_constraint",
          message: `${course.courseCode}: ${temporalViolation ?? aggregateViolation}`,
        });
        continue;
      }
      if ((await this.blockingConflicts(owner, [canonical])).length) continue;
      const candidate: SolverCandidate = {
        id,
        courseCode: course.courseCode,
        priority: course.priority,
        required: course.required,
        credits:
          typeof canonical.course.credits === "number"
            ? canonical.course.credits
            : null,
        seatSafety: quota.score,
        timeFit: timeFitScore(
          metrics.occurrences,
          metrics.partial,
          request.constraints.preferredWindows,
          this.settings.timezone,
        ),
        compactness: compactnessScore(metrics, horizon, this.settings.timezone),
        instructorFit: instructorFitScore(
          instructorNames(canonical),
          request.constraints.preferredInstructorNames,
        ),
        conflicts: [],
        dailyMinutes: metrics.dailyMinutes,
        weekDayKeys: metrics.weekDayKeys,
      };
      candidateSchedules.set(id, { canonical, metrics });
      candidates.push(candidate);
    }
    const fillerSchedules = new Map<string, FillerSchedule>();
    for (const canonical of rawFillerCanonicals) {
      const id = String(canonical.bundle.bundleId);
      const quota = historicalQuotaBundleScore(canonical, quotas, quotaHistory);
      if (
        quota.closed ||
        (!request.allowFullWaitlist && quota.full) ||
        (request.unknownQuotaPolicy === "exclude" && quota.unknown)
      )
        continue;
      if (
        (request.constraints.maxCredits !== undefined ||
          request.fill?.targetCredits !== undefined) &&
        typeof canonical.course.credits !== "number"
      )
        continue;
      const expanded = horizon
        ? expandCourseBundle(
            scheduleInput(canonical),
            horizon.window,
            this.settings.timezone,
          )
        : { items: [], partial: true };
      occurrenceCount += expanded.items.length;
      const metrics = scheduleMetrics(
        expanded.items,
        expanded.partial,
        this.settings.timezone,
      );
      if (
        hardMeetingViolation(
          canonicalMeetings(canonical),
          request.constraints,
          horizon,
        ) ||
        violatesAggregateConstraints(metrics, request.constraints, horizon)
      )
        continue;
      if ((await this.blockingConflicts(owner, [canonical])).length) continue;
      fillerSchedules.set(id, {
        canonical,
        metrics,
        quota,
        timeFit: timeFitScore(
          metrics.occurrences,
          metrics.partial,
          request.constraints.preferredWindows,
          this.settings.timezone,
        ),
        compactness: compactnessScore(metrics, horizon, this.settings.timezone),
        instructorFit: instructorFitScore(
          instructorNames(canonical),
          request.constraints.preferredInstructorNames,
        ),
      });
    }
    if (
      occurrenceCount >
      (this.settings.autoPlanMaxCandidateOccurrences ?? 50_000)
    )
      throw new PlanError(
        "candidate_pool_too_large",
        400,
        "Candidate occurrence pool is too large",
      );
    if (candidates.length > (this.settings.autoPlanMaxCandidateBundles ?? 600))
      throw new PlanError(
        "candidate_pool_too_large",
        400,
        "Candidate bundle pool is too large",
      );
    if (
      candidates.length + fillerSchedules.size >
      (this.settings.autoPlanMaxCandidateBundles ?? 600)
    )
      throw new PlanError(
        "candidate_pool_too_large",
        400,
        "Combined desired and filler candidate pool is too large",
      );
    let conflictEdges = 0;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const first = candidates[i]!;
        const second = candidates[j]!;
        const firstCanonical = candidateSchedules.get(first.id)!.canonical;
        const secondCanonical = candidateSchedules.get(second.id)!.canonical;
        if (
          selectedCourse(firstCanonical) !== selectedCourse(secondCanonical) &&
          detectConflicts(
            [
              ...candidateSchedules
                .get(first.id)!
                .metrics.occurrences.filter(
                  (item) => !suppressedCalendarKeys.has(item.calendarKey),
                ),
              ...candidateSchedules
                .get(second.id)!
                .metrics.occurrences.filter(
                  (item) => !suppressedCalendarKeys.has(item.calendarKey),
                ),
            ],
            this.settings.timezone,
            100_000,
          ).blocking.length
        ) {
          conflictEdges += 1;
          first.conflicts.push(second.id);
          second.conflicts.push(first.id);
        }
      }
    }
    if (conflictEdges > (this.settings.autoPlanMaxConflictEdges ?? 100_000))
      throw new PlanError(
        "candidate_pool_too_large",
        400,
        "Candidate conflict graph is too large",
      );
    const courseCodes = requested.map((course) => course.courseCode);
    const solverInput: SolverInput = {
      request: normalizedRequest,
      candidates,
      courseCodes,
      groups: normalizedRequest.groups,
      maxSelectedCourses: this.settings.autoPlanMaxSelectedCourses ?? 12,
    };
    const solve = (value: SolverInput) =>
      solveAutoPlan(
        value,
        Math.max(0, deadline - Date.now()),
        this.settings.autoPlanSolverConcurrency ?? 2,
      );
    let solved: SolverResult;
    try {
      solved = await solve(solverInput);
    } catch (error) {
      if (error instanceof AutoPlanSolverBusyError)
        throw new PlanError("rate_limited", 429, "Auto-plan solver is busy");
      throw error;
    }
    const rawOptions = [] as Array<{
      selectedIds: string[];
      score: number;
      selected: CanonicalBundle[];
    }>;
    if (solved.status !== "infeasible" && solved.selectedIds.length) {
      const selected = solved.selectedIds
        .map(
          (bundleId) =>
            canonicalById.get(bundleId) ??
            candidateSchedules.get(bundleId)?.canonical,
        )
        .filter((value): value is CanonicalBundle => Boolean(value));
      rawOptions.push({
        selectedIds: solved.selectedIds,
        score: solved.objective,
        selected,
      });
    }
    let searchStatus = solved.status;
    const selectedPriority = solved.selectedIds.reduce(
      (total, bundleId) =>
        total +
        (candidates.find((candidate) => candidate.id === bundleId)?.priority ??
          0),
      0,
    );
    const coverageFloors =
      normalizedRequest.mode === "coverage_first"
        ? {
            minDesiredCourses: solved.selectedIds.length,
            minDesiredPriority: selectedPriority,
          }
        : {};
    while (
      rawOptions.length < request.resultLimit &&
      searchStatus === "completed"
    ) {
      const previous = rawOptions.at(-1);
      if (!previous) break;
      const assignment: Record<string, string | null> = {};
      for (const courseCode of courseCodes) {
        assignment[courseCode] =
          candidates.find(
            (candidate) =>
              candidate.courseCode === courseCode &&
              previous.selectedIds.includes(candidate.id),
          )?.id ?? null;
      }
      let next: SolverResult;
      try {
        next = await solve({
          ...solverInput,
          ...coverageFloors,
          blockedAssignments: [
            ...(solverInput.blockedAssignments ?? []),
            assignment,
          ],
        });
      } catch (error) {
        if (error instanceof AutoPlanSolverBusyError)
          throw new PlanError("rate_limited", 429, "Auto-plan solver is busy");
        throw error;
      }
      if (next.status !== "completed") {
        if (next.status === "time_limited") searchStatus = "time_limited";
        break;
      }
      const nextOption = {
        selectedIds: next.selectedIds,
        score: next.objective,
        selected: next.selectedIds
          .map(
            (bundleId) =>
              canonicalById.get(bundleId) ??
              candidateSchedules.get(bundleId)?.canonical,
          )
          .filter((value): value is CanonicalBundle => Boolean(value)),
      };
      if (!nextOption.selectedIds.length) break;
      rawOptions.push(nextOption);
    }
    let fillerSearchTimedOut = false;
    const options = rawOptions.map((option) => {
      const schedules = option.selectedIds
        .map((bundleId) => candidateSchedules.get(bundleId))
        .filter((value): value is CandidateSchedule => Boolean(value));
      const selectedCanonical = schedules.map((schedule) => schedule.canonical);
      const occurrences = schedules.flatMap(
        (schedule) => schedule.metrics.occurrences,
      );
      const partial = schedules.some((schedule) => schedule.metrics.partial);
      const metrics = scheduleMetrics(
        occurrences,
        partial,
        this.settings.timezone,
      );
      const scoreCandidates = schedules.map((schedule) => {
        const candidate = candidates.find(
          (value) => value.id === schedule.canonical.bundle.bundleId,
        )!;
        return {
          courseCode: candidate.courseCode,
          priority: candidate.priority,
          seatSafety: candidate.seatSafety,
          timeFit: candidate.timeFit,
          instructorFit: candidate.instructorFit ?? 50,
        };
      });
      const scoreComponents = optionScoreComponents(
        normalizedRequest,
        scoreCandidates,
        metrics,
        horizon,
        this.settings.timezone,
      );
      const selectedCodes = new Set(
        schedules.map((schedule) => canonicalCourseCode(schedule.canonical)),
      );
      const selectedCredits = schedules.reduce<number | null>(
        (total, schedule) => {
          if (total === null) return null;
          const credits = schedule.canonical.course.credits;
          return typeof credits === "number" ? total + credits : null;
        },
        0,
      );
      const unselectedCourses = normalizedRequest.courses
        .filter((course) => !selectedCodes.has(course.courseCode))
        .map((course) => ({
          courseCode: course.courseCode,
          required: course.required,
          reason: candidates.some(
            (candidate) => candidate.courseCode === course.courseCode,
          )
            ? "not selected because its bundle would reduce the requested timetable objective"
            : "no eligible bundle satisfies the availability and hard constraints",
        }));
      const selectedBundleIds = new Set(option.selectedIds);
      const replacesItemIds = document.items
        .filter(
          (item) =>
            item.status === "selected" && !selectedBundleIds.has(item.bundleId),
        )
        .map((item) => item.itemId);
      const coreSelectedCodes = new Set(
        schedules.map((schedule) => canonicalCourseCode(schedule.canonical)),
      );
      const maxFill = Math.min(
        request.fill?.maxCourses ?? 0,
        Math.max(
          0,
          (this.settings.autoPlanMaxSelectedCourses ?? 12) - schedules.length,
        ),
      );
      const fillerCandidates = [...fillerSchedules.values()]
        .filter(
          (schedule) =>
            !coreSelectedCodes.has(canonicalCourseCode(schedule.canonical)) &&
            !document.items.some(
              (item) =>
                item.status === "selected" &&
                item.courseId === schedule.canonical.course.courseId,
            ),
        )
        .map((schedule) => ({
          ...schedule,
          credits: schedule.canonical.course.credits,
          quality:
            schedule.timeFit * 0.5 +
            schedule.quota.score * 0.3 +
            schedule.compactness * 0.2,
        }));
      let fillerStatus: "not_requested" | "completed" | "time_limited" =
        "not_requested";
      let selectedFillers: typeof fillerCandidates = [];
      let fillerScore = 0;
      let fillCreditShortfall: number | null = null;
      if (request.fill && request.fill.maxCourses > 0) {
        fillerStatus = "completed";
        const target = request.fill.targetCredits;
        const coreCredits = selectedCredits;
        const coreBundleIds = new Set(option.selectedIds);
        const coreOccurrences = schedules.flatMap(
          (schedule) => schedule.metrics.occurrences,
        );
        const candidatesWithoutCoreConflicts = fillerCandidates.filter(
          (candidate) =>
            !coreBundleIds.has(String(candidate.canonical.bundle.bundleId)) &&
            detectConflicts(
              [
                ...coreOccurrences.filter(
                  (item) => !suppressedCalendarKeys.has(item.calendarKey),
                ),
                ...candidate.metrics.occurrences.filter(
                  (item) => !suppressedCalendarKeys.has(item.calendarKey),
                ),
              ],
              this.settings.timezone,
              100_000,
            ).blocking.length === 0,
        );
        const limit = maxFill;
        const maxNodes = 100_000;
        let nodes = 0;
        let timedOut = false;
        let best: typeof fillerCandidates = [];
        const canonicalKey = (items: typeof fillerCandidates) =>
          items
            .map(
              (item) =>
                `${canonicalCourseCode(item.canonical)}:${item.canonical.bundle.bundleId}`,
            )
            .sort()
            .join("\0");
        const evaluate = (items: typeof fillerCandidates) => {
          const credits = items.reduce<number | null>((sum, item) => {
            if (sum === null || typeof item.credits !== "number") return null;
            return sum + item.credits;
          }, 0);
          const totalCredits =
            coreCredits === null || credits === null
              ? null
              : coreCredits + credits;
          if (
            request.constraints.maxCredits !== undefined &&
            (totalCredits === null ||
              totalCredits > request.constraints.maxCredits)
          )
            return;
          const quality = items.length
            ? items.reduce((sum, item) => sum + item.quality, 0) / items.length
            : 0;
          const better = () => {
            if (!best.length && !items.length) return false;
            if (target !== undefined) {
              if (totalCredits === null) return false;
              const candidateDistance = Math.abs(totalCredits - target);
              const bestFillerCredits = best.reduce<number | null>(
                (sum, item) => {
                  if (sum === null || typeof item.credits !== "number")
                    return null;
                  return sum + item.credits;
                },
                0,
              );
              const bestCredits =
                coreCredits === null || bestFillerCredits === null
                  ? null
                  : coreCredits + bestFillerCredits;
              if (bestCredits === null) return true;
              const bestDistance = Math.abs(bestCredits - target);
              if (candidateDistance !== bestDistance)
                return candidateDistance < bestDistance;
              if (items.length !== best.length)
                return items.length < best.length;
            } else if (items.length !== best.length) {
              return items.length > best.length;
            }
            const bestQuality = best.length
              ? best.reduce((sum, item) => sum + item.quality, 0) / best.length
              : 0;
            return quality !== bestQuality
              ? quality > bestQuality
              : canonicalKey(items) < canonicalKey(best);
          };
          if (better()) best = [...items];
        };
        const search = (
          start: number,
          selected: typeof fillerCandidates,
          credits: number,
          occurrences: CalendarOccurrence[],
        ) => {
          nodes += 1;
          if (nodes > maxNodes || Date.now() >= deadline) {
            timedOut = true;
            return;
          }
          evaluate(selected);
          if (selected.length >= limit) return;
          for (
            let index = start;
            index < candidatesWithoutCoreConflicts.length;
            index++
          ) {
            const candidate = candidatesWithoutCoreConflicts[index]!;
            if (
              selected.some(
                (item) =>
                  String(item.canonical.course.courseId) ===
                  String(candidate.canonical.course.courseId),
              )
            )
              continue;
            const nextCredits =
              credits +
              (typeof candidate.credits === "number" ? candidate.credits : 0);
            if (
              request.constraints.maxCredits !== undefined &&
              coreCredits !== null &&
              coreCredits + nextCredits > request.constraints.maxCredits
            )
              continue;
            const nextOccurrences = [
              ...occurrences,
              ...candidate.metrics.occurrences.filter(
                (item) => !suppressedCalendarKeys.has(item.calendarKey),
              ),
            ];
            if (
              detectConflicts(nextOccurrences, this.settings.timezone, 100_000)
                .blocking.length
            )
              continue;
            const combinedMetrics = scheduleMetrics(
              nextOccurrences,
              partial ||
                selected.some((item) => item.metrics.partial) ||
                candidate.metrics.partial,
              this.settings.timezone,
            );
            const combinedMeetings = [
              ...selectedCanonical.flatMap((item) => canonicalMeetings(item)),
              ...selected.flatMap((item) => canonicalMeetings(item.canonical)),
              ...canonicalMeetings(candidate.canonical),
            ];
            if (
              violatesAggregateConstraints(
                combinedMetrics,
                request.constraints,
                horizon,
              ) ||
              hardMeetingViolation(
                combinedMeetings,
                request.constraints,
                horizon,
              )
            )
              continue;
            search(
              index + 1,
              [...selected, candidate],
              nextCredits,
              nextOccurrences,
            );
            if (timedOut) return;
          }
        };
        search(0, [], 0, coreOccurrences);
        selectedFillers = best;
        if (timedOut) {
          fillerStatus = "time_limited";
          fillerSearchTimedOut = true;
        }
        fillerScore =
          selectedFillers.reduce((sum, item) => sum + item.quality, 0) /
          Math.max(1, selectedFillers.length);
        if (target !== undefined && coreCredits !== null) {
          const fillerCredits = selectedFillers.reduce<number | null>(
            (sum, item) => {
              if (sum === null || typeof item.credits !== "number") return null;
              return sum + item.credits;
            },
            0,
          );
          if (fillerCredits !== null)
            fillCreditShortfall = Math.max(
              0,
              target - coreCredits - fillerCredits,
            );
        }
      }
      const coreOccurrences = occurrences;
      const fillerOccurrences = selectedFillers.flatMap(
        (item) => item.metrics.occurrences,
      );
      const completeOccurrences = [...coreOccurrences, ...fillerOccurrences];
      const completeMetrics = scheduleMetrics(
        completeOccurrences,
        partial || selectedFillers.some((item) => item.metrics.partial),
        this.settings.timezone,
      );
      const fillerCredits = selectedFillers.reduce<number | null>(
        (sum, item) => {
          if (sum === null || typeof item.credits !== "number") return null;
          return sum + item.credits;
        },
        0,
      );
      const finalCredits =
        selectedCredits === null || fillerCredits === null
          ? null
          : selectedCredits + fillerCredits;
      const completedConflicts = detectConflicts(
        completeOccurrences.filter(
          (item) => !suppressedCalendarKeys.has(item.calendarKey),
        ),
        this.settings.timezone,
        100_000,
      );
      return {
        selected: schedules.map((schedule) =>
          optionCourseResponse(schedule.canonical),
        ),
        fillers: selectedFillers.map((item) => ({
          ...optionCourseResponse(item.canonical),
          status: "suggested" as const,
        })),
        selectedBundleIds: [
          ...option.selectedIds,
          ...selectedFillers.map((item) =>
            String(item.canonical.bundle.bundleId),
          ),
        ],
        score: optionScore(normalizedRequest, scoreComponents),
        scoreComponents,
        occurrences: completeOccurrences,
        representativeWeek: optionScheduleSummary(
          completeMetrics,
          horizon,
          this.settings.timezone,
        ).representativeWeek,
        credits: finalCredits,
        campusDays: optionScheduleSummary(
          completeMetrics,
          horizon,
          this.settings.timezone,
        ).campusDays,
        idleMinutes: optionScheduleSummary(
          completeMetrics,
          horizon,
          this.settings.timezone,
        ).idleMinutes,
        conflictCoverage: partial
          ? ("partial" as const)
          : ("complete" as const),
        conflicts: completedConflicts,
        quotaBottlenecks: [
          ...option.selectedIds,
          ...selectedFillers.map((item) =>
            String(item.canonical.bundle.bundleId),
          ),
        ].flatMap((bundleId) => {
          const canonical = canonicalById.get(bundleId);
          return canonical
            ? canonical.sections.map((section) => {
                const latest = quotas.get(String(section.sectionId));
                const risk = historicalQuotaSectionScore(
                  section,
                  latest,
                  quotaHistory.get(String(section.sectionId)) ?? [],
                );
                const trend = calculateQuotaTrend(
                  (quotaHistory.get(String(section.sectionId)) ??
                    []) as unknown as import("../domain/quota.js").QuotaObservationLike[],
                  "14d",
                  evaluationNow,
                );
                const difficulty = enrollmentDifficulty(
                  latest as unknown as
                    | import("../domain/quota.js").QuotaObservationLike
                    | undefined,
                  trend,
                );
                return {
                  sectionId: section.sectionId,
                  snapshotId: latest?.snapshotId ?? null,
                  observedAt: latest?.observedAt ?? null,
                  isStale: quotaIsStale(latest, this.settings, evaluationNow),
                  score: risk.score,
                  remaining:
                    effectiveRemaining(latest ?? {}) === null
                      ? null
                      : Math.max(0, effectiveRemaining(latest ?? {})!),
                  capacity:
                    typeof latest?.capacity === "number"
                      ? latest.capacity
                      : null,
                  waitlisted:
                    typeof latest?.waitlisted === "number"
                      ? Math.max(0, latest.waitlisted)
                      : null,
                  unknown: risk.unknown,
                  dataQuality: [
                    ...risk.dataQuality,
                    ...(quotaIsStale(latest, this.settings, evaluationNow)
                      ? ["quota_stale"]
                      : []),
                  ],
                  trend,
                  difficulty,
                };
              })
            : [];
        }),
        unselectedCourses,
        replacesItemIds,
        fillerStatus,
        fillerScore,
        fillCreditShortfall,
      };
    });
    if (fillerSearchTimedOut) searchStatus = "time_limited";
    if (fillerPool.commonCore && this.commonCore) {
      const currentCommonCore = await this.commonCore.active();
      if (
        currentCommonCore.catalog.catalogVersion !==
          fillerPool.commonCore.catalogVersion ||
        currentCommonCore.revision !== fillerPool.commonCore.stateRevision
      )
        throw new PlanError(
          "stale_recommendation",
          409,
          "Common Core classification changed; regenerate the recommendation",
        );
    }
    options.sort((first, second) => {
      if (normalizedRequest.mode === "coverage_first") {
        const countDifference = second.selected.length - first.selected.length;
        if (countDifference) return countDifference;
        const priorityDifference =
          second.scoreComponents.coverage - first.scoreComponents.coverage;
        if (priorityDifference) return priorityDifference;
      } else if (second.score !== first.score) {
        return second.score - first.score;
      }
      if (second.score !== first.score) return second.score - first.score;
      if (second.fillerScore !== first.fillerScore)
        return second.fillerScore - first.fillerScore;
      return first.selectedBundleIds
        .join("\u0000")
        .localeCompare(second.selectedBundleIds.join("\u0000"));
    });
    if (options.length) {
      const currentDocument = await this.document(owner, id);
      if (currentDocument.revision !== document.revision)
        throw new PlanError(
          "stale_recommendation",
          409,
          "The plan changed; regenerate the recommendation",
        );
      const currentTerm = await this.catalog.activeTerm(document.termCode);
      if (
        currentTerm.activeImportBatchId !== term.activeImportBatchId ||
        (currentTerm.importFence ?? null) !== (term.importFence ?? null)
      )
        throw new PlanError(
          "stale_recommendation",
          409,
          "Academic data changed; regenerate the recommendation",
        );

      const selectedSectionIds = [
        ...new Set(
          options.flatMap((option) =>
            option.selectedBundleIds.flatMap(
              (bundleId) =>
                canonicalById
                  .get(bundleId)
                  ?.sections.map((section) => String(section.sectionId)) ?? [],
            ),
          ),
        ),
      ];
      if (selectedSectionIds.length) {
        const currentQuotas = new Map(
          (await this.catalog.latestQuotas(selectedSectionIds)).map((row) => [
            String(row.sectionId),
            row,
          ]),
        );
        const currentHistory = new Map<string, Document[]>();
        for (const row of await this.catalog.quotaHistory(selectedSectionIds)) {
          const entries = currentHistory.get(String(row.sectionId)) ?? [];
          entries.push(row);
          currentHistory.set(String(row.sectionId), entries);
        }
        for (const sectionId of selectedSectionIds) {
          const initialSnapshot = quotas.get(sectionId)?.snapshotId ?? null;
          const currentSnapshot =
            currentQuotas.get(sectionId)?.snapshotId ?? null;
          const initialTrend = quotaRiskObservationIds(
            quotas.get(sectionId),
            quotaHistory.get(sectionId) ?? [],
          );
          const currentTrend = quotaRiskObservationIds(
            currentQuotas.get(sectionId),
            currentHistory.get(sectionId) ?? [],
          );
          if (
            initialSnapshot !== currentSnapshot ||
            JSON.stringify(initialTrend) !== JSON.stringify(currentTrend)
          )
            throw new PlanError(
              "stale_recommendation",
              409,
              "Quota data changed; regenerate the recommendation",
            );
        }
      }

      if (fillerPool.commonCore && this.commonCore) {
        const currentCommonCore = await this.commonCore.active();
        if (
          currentCommonCore.catalog.catalogVersion !==
            fillerPool.commonCore.catalogVersion ||
          currentCommonCore.revision !== fillerPool.commonCore.stateRevision
        )
          throw new PlanError(
            "stale_recommendation",
            409,
            "Common Core classification changed; regenerate the recommendation",
          );
      }
    }
    const normalizedHash = requestHash(normalizedRequest);
    const expiresAt =
      (this.settings.now?.().getTime() ?? Date.now()) +
      this.settings.autoPlanTokenTtlSeconds * 1000;
    const tokenizedOptions = options.map((option) => ({
      ...option,
      optionToken: signAutoPlanToken(this.settings.autoPlanTokenKey, {
        version: 1,
        owner,
        planId: document._id.toHexString(),
        planRevision: document.revision,
        termCode: document.termCode,
        importBatchId: term.activeImportBatchId,
        importFence: term.importFence ?? null,
        selectedBundleIds: option.selectedBundleIds,
        quotaSnapshotIds: quotaSnapshotMap(
          option.selectedBundleIds
            .map((bundleId) => canonicalById.get(bundleId))
            .filter((value): value is CanonicalBundle => Boolean(value)),
          quotas,
        ),
        fillerBundleIds: option.selectedBundleIds.filter((bundleId) =>
          fillerSchedules.has(bundleId),
        ),
        quotaTrendObservationIds: Object.fromEntries(
          [
            ...new Set(
              option.selectedBundleIds.flatMap(
                (bundleId) =>
                  canonicalById
                    .get(bundleId)
                    ?.sections.map((section) => String(section.sectionId)) ??
                  [],
              ),
            ),
          ].map((sectionId) => [
            sectionId,
            quotaRiskObservationIds(
              quotas.get(sectionId),
              quotaHistory.get(sectionId) ?? [],
            ),
          ]),
        ),
        commonCore: fillerPool.commonCore,
        quotaStale: Object.fromEntries(
          [
            ...new Set(
              option.selectedBundleIds.flatMap(
                (bundleId) =>
                  canonicalById
                    .get(bundleId)
                    ?.sections.map((section) => String(section.sectionId)) ??
                  [],
              ),
            ),
          ].map((sectionId) => [
            sectionId,
            quotaIsStale(quotas.get(sectionId), this.settings, evaluationNow),
          ]),
        ),
        requestHash: normalizedHash,
        request: normalizedRequest,
        horizon: horizon
          ? {
              start: horizon.start.toString(),
              end: horizon.end.toString(),
              weeks: horizon.weeks,
            }
          : null,
        expiresAt,
      }),
    }));
    for (const option of tokenizedOptions) {
      if (
        Buffer.byteLength(option.optionToken) >
        (this.settings.autoPlanMaxTokenBytes ?? 131_072)
      )
        throw new PlanError(
          "invalid_request",
          400,
          "Generated auto-plan option token is too large",
        );
    }
    return {
      searchStatus,
      planId: document._id.toHexString(),
      planRevision: document.revision,
      term: {
        termCode: document.termCode,
        importBatchId: term.activeImportBatchId,
        importFence: term.importFence ?? null,
      },
      commonCore: fillerPool.commonCore,
      fillDiagnostics: fillerPool.diagnostics,
      normalizedRequest,
      scoreVersion:
        normalizedRequest.mode === "custom"
          ? "auto-plan-score-v2-custom-phase8"
          : "auto-plan-score-v2-quota-history-phase8",
      options: tokenizedOptions,
      diagnostics:
        diagnostics.length || tokenizedOptions.length
          ? diagnostics.slice(0, 20)
          : [
              {
                code: "no_feasible_option",
                message:
                  "No timetable satisfies the required course and hard constraints",
              },
            ],
      meta: {},
    };
  }

  private applyResponse(document: PlanWithId) {
    return {
      data: {
        id: document._id.toHexString(),
        name: document.name,
        termCode: document.termCode,
        ...(document.description == null
          ? {}
          : { description: document.description }),
        status: document.status,
        revision: document.revision,
        items: document.items.map((item) => ({
          ...item,
          referenceState: "active" as const,
          course: {
            courseId: item.courseId,
            courseCode: item.courseCodeSnapshot,
          },
          bundle: {
            bundleId: item.bundleId,
            offeringId: item.offeringId,
            sectionLabels: item.sectionLabelsSnapshot,
            componentClassNbrs: item.componentClassNbrs,
          },
        })),
        ...(document.lastAutoPlanApply
          ? { lastAutoPlanApply: document.lastAutoPlanApply }
          : {}),
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      },
      meta: {},
    };
  }

  private idempotencyHeader(value: unknown) {
    if (typeof value !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value))
      throw new PlanError(
        "invalid_request",
        400,
        "Invalid Idempotency-Key header",
      );
    return value;
  }

  private async finishApplyRecord(
    record: WithId<IdempotencyRecordDocument>,
    response: { data: unknown; meta: Record<string, never> },
  ) {
    const updated = await this.records.updateOne(
      {
        _id: record._id,
        ownerScope: record.ownerScope,
        routeKey: record.routeKey,
        operationId: record.operationId,
        state: { $in: ["processing", "failed"] },
        requestHash: record.requestHash,
      },
      {
        $set: {
          state: "completed",
          responseStatus: 200,
          responseBody: response,
          resourceId: record.resourceId,
        },
        $unset: { leaseExpiresAt: "" },
      },
    );
    if (updated.matchedCount === 1)
      return { status: 200 as const, body: response };
    const latest = await this.records.findOne({ _id: record._id });
    if (latest?.state === "completed" && latest.responseBody)
      return {
        status: latest.responseStatus === 201 ? (201 as const) : (200 as const),
        body: latest.responseBody as {
          data: unknown;
          meta: Record<string, never>;
        },
      };
    throw new PlanError("operation_in_progress", 409, "Apply is being retried");
  }

  private async finalizePendingAutoPlan(
    owner: string,
    document: PlanWithId,
  ): Promise<void> {
    const marker = document.lastAutoPlanApply;
    if (!marker || marker.toRevision !== document.revision) return;
    const record = await this.records.findOne({
      ownerScope: owner,
      routeKey: AUTO_PLAN_APPLY_ROUTE,
      operationId: marker.operationId,
      resourceId: document._id,
    });
    if (
      !record ||
      record.state === "completed" ||
      record.expiresAt <= (this.settings.now?.() ?? new Date())
    )
      return;
    await this.finishApplyRecord(record, await this.applyResponse(document));
  }

  private async claimApplyRecord(
    record: WithId<IdempotencyRecordDocument>,
    now: Date,
  ) {
    const leaseExpiresAt = new Date(
      now.getTime() + AUTO_PLAN_APPLY_LEASE_MS,
    ).toISOString();
    const claimed = await this.records.updateOne(
      {
        _id: record._id,
        ownerScope: record.ownerScope,
        routeKey: AUTO_PLAN_APPLY_ROUTE,
        operationId: record.operationId,
        requestHash: record.requestHash,
        state: record.state,
        leaseExpiresAt:
          record.leaseExpiresAt === undefined
            ? { $exists: false }
            : record.leaseExpiresAt,
        expiresAt: { $gt: now },
      },
      { $set: { state: "processing", leaseExpiresAt } },
    );
    if (claimed.matchedCount !== 1)
      throw new PlanError(
        "operation_in_progress",
        409,
        "Apply is being retried",
      );
    return { ...record, state: "processing" as const, leaseExpiresAt };
  }

  private async releaseFailedApply(record: WithId<IdempotencyRecordDocument>) {
    await this.records.updateOne(
      {
        _id: record._id,
        ownerScope: record.ownerScope,
        routeKey: AUTO_PLAN_APPLY_ROUTE,
        operationId: record.operationId,
        requestHash: record.requestHash,
        state: "processing",
      },
      { $set: { state: "failed" }, $unset: { leaseExpiresAt: "" } },
    );
  }

  private async checkApplySnapshot(
    owner: string,
    document: PlanWithId,
    token: ReturnType<typeof verifyAutoPlanToken>,
  ) {
    if (
      token.owner !== owner ||
      token.planId !== document._id.toHexString() ||
      token.planRevision !== document.revision
    )
      throw new PlanError(
        "stale_recommendation",
        409,
        "Auto-plan recommendation is stale",
      );
    const term = await this.catalog.activeTerm(document.termCode);
    if (
      token.termCode !== document.termCode ||
      token.importBatchId !== term.activeImportBatchId ||
      token.importFence !== (term.importFence ?? null)
    )
      throw new PlanError(
        "stale_recommendation",
        409,
        "Academic data changed; regenerate the recommendation",
      );
    const normalized = validateAutoPlanGroups(
      normalizeAutoPlanRequest(token.request),
    );
    if (requestHash(normalized) !== token.requestHash)
      throw new PlanError(
        "invalid_request",
        400,
        "Invalid auto-plan option token",
      );
    const fillerBundleIds = new Set(token.fillerBundleIds ?? []);
    if (
      [...fillerBundleIds].some(
        (bundleId) => !token.selectedBundleIds.includes(bundleId),
      )
    )
      throw new PlanError(
        "invalid_request",
        400,
        "Invalid auto-plan option token",
      );
    let currentFillerPool: Awaited<
      ReturnType<CoursePlanService["fillerCanonicals"]>
    >;
    try {
      currentFillerPool = await this.fillerCanonicals(
        term,
        normalized,
        new Set(normalized.courses.map((course) => course.courseCode)),
      );
    } catch (error) {
      if (
        token.commonCore &&
        error instanceof PlanError &&
        (error.code === "common_core_unavailable" ||
          error.code === "invalid_request")
      )
        throw new PlanError(
          "stale_recommendation",
          409,
          "Common Core classification changed; regenerate the recommendation",
        );
      throw error;
    }
    if (
      JSON.stringify(currentFillerPool.commonCore) !==
      JSON.stringify(token.commonCore ?? null)
    )
      throw new PlanError(
        "stale_recommendation",
        409,
        "Common Core classification changed; regenerate the recommendation",
      );
    const allowedFillerBundles = new Set(
      currentFillerPool.canonicals.map((item) => String(item.bundle.bundleId)),
    );
    if (
      [...fillerBundleIds].some(
        (bundleId) => !allowedFillerBundles.has(bundleId),
      )
    )
      throw new PlanError(
        "stale_recommendation",
        409,
        "A filler course is no longer in the selected pool",
      );
    const uniqueBundles = new Set(token.selectedBundleIds);
    if (uniqueBundles.size !== token.selectedBundleIds.length)
      throw new PlanError(
        "invalid_request",
        400,
        "Invalid auto-plan option token",
      );
    const canonical: CanonicalBundle[] = [];
    const courseIds = new Set<string>();
    const sectionIds = new Set<string>();
    for (const bundleId of token.selectedBundleIds) {
      const resolved = await this.catalog.activeBundleById(term, bundleId);
      if (!resolved)
        throw new PlanError(
          "stale_recommendation",
          409,
          "A selected bundle is no longer active",
        );
      if (courseIds.has(String(resolved.course.courseId)))
        throw new PlanError(
          "stale_recommendation",
          409,
          "The recommendation selects a course more than once",
        );
      courseIds.add(String(resolved.course.courseId));
      canonical.push(resolved);
      for (const section of resolved.sections)
        sectionIds.add(String(section.sectionId));
    }
    const selectedByCode = new Map(
      canonical.map((item) => [canonicalCourseCode(item), item]),
    );
    const requestedCourses = new Map(
      normalized.courses.map((course) => [course.courseCode, course]),
    );
    for (const course of normalized.courses) {
      const resolved = selectedByCode.get(course.courseCode);
      if (!resolved && course.required)
        throw new PlanError(
          "stale_recommendation",
          409,
          "A required course is missing from the option",
        );
      if (resolved) {
        if (
          course.lockedBundleId &&
          course.lockedBundleId !== resolved.bundle.bundleId
        )
          throw new PlanError(
            "stale_recommendation",
            409,
            "A locked bundle changed",
          );
        const sections = candidateBundleSectionIds(resolved);
        if (
          course.lockedSectionIds?.some((sectionId) => !sections.has(sectionId))
        )
          throw new PlanError(
            "stale_recommendation",
            409,
            "A locked section is missing from the option",
          );
        if (
          course.excludedSectionIds.some((sectionId) => sections.has(sectionId))
        )
          throw new PlanError(
            "stale_recommendation",
            409,
            "The option contains an excluded section",
          );
        const excluded = new Set(
          course.excludedInstructorNames.map(normalizeInstructor),
        );
        if (
          instructorNames(resolved).some((name) =>
            excluded.has(normalizeInstructor(name)),
          )
        )
          throw new PlanError(
            "stale_recommendation",
            409,
            "The option contains an excluded instructor",
          );
      }
    }
    const desiredCanonical = canonical.filter(
      (item) => !fillerBundleIds.has(String(item.bundle.bundleId)),
    );
    if (!desiredCanonical.length)
      throw new PlanError(
        "stale_recommendation",
        409,
        "The option contains no selected course",
      );
    if (canonical.length > (this.settings.autoPlanMaxSelectedCourses ?? 12))
      throw new PlanError(
        "stale_recommendation",
        409,
        "The option exceeds the selected-course limit",
      );
    if (fillerBundleIds.size > (normalized.fill?.maxCourses ?? 0))
      throw new PlanError(
        "stale_recommendation",
        409,
        "The option exceeds the requested filler limit",
      );
    for (const item of canonical) {
      const code = canonicalCourseCode(item);
      if (
        !requestedCourses.has(code) &&
        !fillerBundleIds.has(String(item.bundle.bundleId))
      )
        throw new PlanError(
          "stale_recommendation",
          409,
          "The option contains an unrequested course",
        );
      const course = requestedCourses.get(code);
      if (!course) {
        if (
          document.items.some(
            (existing) =>
              existing.status === "selected" &&
              existing.courseId === item.course.courseId,
          )
        )
          throw new PlanError(
            "stale_recommendation",
            409,
            "A filler course is already selected in this plan",
          );
        if (
          normalized.fill?.minCredits !== undefined &&
          (typeof item.course.credits !== "number" ||
            item.course.credits < normalized.fill.minCredits)
        )
          throw new PlanError(
            "stale_recommendation",
            409,
            "A filler course no longer satisfies its minimum credit filter",
          );
        if (
          normalized.fill?.maxCredits !== undefined &&
          (typeof item.course.credits !== "number" ||
            item.course.credits > normalized.fill.maxCredits)
        )
          throw new PlanError(
            "stale_recommendation",
            409,
            "A filler course no longer satisfies its maximum credit filter",
          );
        continue;
      }
      if (
        course.academicCareer !== undefined &&
        item.offering.academicCareer !== course.academicCareer
      )
        throw new PlanError(
          "stale_recommendation",
          409,
          "A course offering career changed",
        );
    }
    for (const group of normalized.groups) {
      const count = group.courseCodes.filter((courseCode) =>
        selectedByCode.has(courseCode),
      ).length;
      if (count < group.minCount || count > group.maxCount)
        throw new PlanError(
          "stale_recommendation",
          409,
          "A group constraint changed",
        );
    }
    const currentMeetings = canonical.flatMap((item) =>
      canonicalMeetings(item),
    );
    const currentHasDatedMeeting = currentMeetings.some(
      (meeting) => meeting.startDate || meeting.endDate,
    );
    const currentHorizon = currentHasDatedMeeting
      ? derivePlanningHorizon(
          currentMeetings,
          this.settings.timezone,
          this.settings.autoPlanMaxHorizonDays ?? 240,
        )
      : null;
    if (currentHasDatedMeeting && !currentHorizon)
      throw new PlanError(
        "stale_recommendation",
        409,
        "The selected timetable now exceeds the planning horizon",
      );
    const horizon =
      currentHorizon ?? optionHorizon(token.horizon, this.settings.timezone);
    const occurrences = canonical.flatMap((item) => {
      if (!horizon) return [];
      return expandCourseBundle(
        scheduleInput(item),
        horizon.window,
        this.settings.timezone,
      ).items;
    });
    const suppressedCalendarKeys = new Set(
      await this.events.suppressedKeys(owner),
    );
    const partial = canonical.some((item) => {
      if (!horizon) return true;
      return expandCourseBundle(
        scheduleInput(item),
        horizon.window,
        this.settings.timezone,
      ).partial;
    });
    const metrics = scheduleMetrics(
      occurrences,
      partial || !horizon,
      this.settings.timezone,
    );
    const temporalViolation = hardMeetingViolation(
      canonical.flatMap((item) => canonicalMeetings(item)),
      normalized.constraints,
      horizon,
    );
    const aggregateViolation = violatesAggregateConstraints(
      metrics,
      normalized.constraints,
      horizon,
    );
    if (temporalViolation || aggregateViolation)
      throw new PlanError(
        "stale_recommendation",
        409,
        temporalViolation ?? aggregateViolation!,
      );
    const coreCredits = desiredCanonical.reduce<number | null>(
      (total, item) => {
        if (total === null) return null;
        const value = item.course.credits;
        return typeof value === "number" ? total + value : null;
      },
      0,
    );
    const credits = canonical.reduce<number | null>((total, item) => {
      if (total === null) return null;
      const value = item.course.credits;
      return typeof value === "number" ? total + value : null;
    }, 0);
    if (
      (normalized.constraints.minCredits !== undefined &&
        (coreCredits === null ||
          coreCredits < normalized.constraints.minCredits)) ||
      (normalized.constraints.maxCredits !== undefined &&
        (credits === null || credits > normalized.constraints.maxCredits))
    )
      throw new PlanError(
        "stale_recommendation",
        409,
        "The option no longer satisfies credit bounds",
      );
    if (
      detectConflicts(
        occurrences.filter(
          (item) => !suppressedCalendarKeys.has(item.calendarKey),
        ),
        this.settings.timezone,
        100_000,
      ).blocking.length
    )
      throw new PlanError(
        "stale_recommendation",
        409,
        "The selected timetable now contains an internal conflict",
      );
    const quotaRows = await this.catalog.latestQuotas([...sectionIds]);
    const quotas = new Map(
      quotaRows.map((quota) => [String(quota.sectionId), quota]),
    );
    const historyRows = await this.catalog.quotaHistoryForSections([
      ...sectionIds,
    ]);
    const histories = new Map<string, Document[]>();
    for (const row of historyRows) {
      const entries = histories.get(String(row.sectionId)) ?? [];
      entries.push(row);
      histories.set(String(row.sectionId), entries);
    }
    for (const sectionId of sectionIds) {
      const expected = token.quotaSnapshotIds[sectionId] ?? null;
      const actual = quotas.get(sectionId)?.snapshotId ?? null;
      if (expected !== actual)
        throw new PlanError(
          "stale_recommendation",
          409,
          "Quota data changed; regenerate the recommendation",
        );
      const expectedTrend = token.quotaTrendObservationIds?.[sectionId] ?? [];
      const actualTrend = quotaRiskObservationIds(
        quotas.get(sectionId),
        histories.get(sectionId) ?? [],
      );
      if (JSON.stringify(expectedTrend) !== JSON.stringify(actualTrend))
        throw new PlanError(
          "stale_recommendation",
          409,
          "Quota history changed; regenerate the recommendation",
        );
      const expectedStale = token.quotaStale?.[sectionId];
      if (
        expectedStale !== undefined &&
        expectedStale !== quotaIsStale(quotas.get(sectionId), this.settings)
      )
        throw new PlanError(
          "stale_recommendation",
          409,
          "Quota freshness changed; regenerate the recommendation",
        );
      const quota = quotas.get(sectionId);
      const section = canonical
        .flatMap((item) => item.sections)
        .find((item) => item.sectionId === sectionId);
      const quotaStatus = quotaSectionScore(section, quota);
      if (quotaStatus.closed)
        throw new PlanError(
          "stale_recommendation",
          409,
          "A selected section is closed",
        );
      if (
        !normalized.allowFullWaitlist &&
        !quotaStatus.unknown &&
        quotaStatus.full
      )
        throw new PlanError(
          "stale_recommendation",
          409,
          "A selected section is full",
        );
      if (normalized.unknownQuotaPolicy === "exclude" && quotaStatus.unknown)
        throw new PlanError(
          "stale_recommendation",
          409,
          "Quota data is now unavailable",
        );
    }
    const conflicts = await this.blockingConflicts(owner, canonical);
    if (conflicts.length)
      throw new PlanError(
        "stale_recommendation",
        409,
        "The selected timetable now conflicts with a blocking event",
      );
    return { term, canonical, metrics, credits, requestedCourses };
  }

  async applyAutoPlan(
    owner: string,
    id: string,
    revision: number,
    tokenValue: unknown,
    keyValue: unknown,
  ) {
    const planObjectId = planId(id);
    const key = this.idempotencyHeader(keyValue);
    const routeKey = AUTO_PLAN_APPLY_ROUTE;
    const normalizedRequestHash = requestHash({
      id,
      revision,
      token: tokenValue,
    });
    const now = new Date(this.settings.now?.() ?? new Date());
    let record = await this.records.findOne({
      ownerScope: owner,
      routeKey,
      idempotencyKeyHash: requestHash(key),
    });
    if (record && record.expiresAt <= now) record = null;
    if (record && record.expiresAt > now) {
      if (record.requestHash !== normalizedRequestHash)
        throw new PlanError(
          "idempotency_key_reused",
          409,
          "Idempotency key was used for another request",
        );
      if (record.state === "completed" && record.responseBody)
        return {
          status:
            record.responseStatus === 201 ? (201 as const) : (200 as const),
          body: record.responseBody as {
            data: unknown;
            meta: Record<string, never>;
          },
        };
    }
    const document = await this.document(owner, id);
    if (
      document.lastAutoPlanApply?.operationId === record?.operationId &&
      document.lastAutoPlanApply?.requestHash === normalizedRequestHash &&
      document.lastAutoPlanApply?.toRevision === document.revision
    ) {
      const body = await this.applyResponse(document);
      if (record) return this.finishApplyRecord(record, body);
    }
    if (record) {
      if (
        record.state === "processing" &&
        record.leaseExpiresAt &&
        record.leaseExpiresAt > now.toISOString()
      )
        throw new PlanError(
          "operation_in_progress",
          409,
          "Apply is still in progress",
        );
    }
    const token = verifyAutoPlanToken(
      this.settings.autoPlanTokenKey,
      tokenValue,
      this.settings.now?.().getTime() ?? Date.now(),
      this.settings.autoPlanMaxTokenBytes ?? 131_072,
    );
    if (token.owner !== owner || token.planId !== id)
      throw new PlanError(
        "invalid_request",
        400,
        "Auto-plan option token does not belong to this plan",
      );
    if (document.status === "archived")
      throw new PlanError(
        "readonly_resource",
        409,
        "Archived plans are read-only",
      );
    if (document.revision !== revision)
      throw new PlanError("concurrent_modification", 409, "Plan has changed", {
        currentRevision: String(document.revision),
      });
    if (record) record = await this.claimApplyRecord(record, now);
    const operationId = randomUUID();
    const newRecord: WithId<IdempotencyRecordDocument> = record ?? {
      _id: new ObjectId(),
      ownerScope: owner,
      routeKey,
      idempotencyKeyHash: requestHash(key),
      requestHash: normalizedRequestHash,
      operationId,
      resourceId: document._id,
      state: "processing",
      leaseExpiresAt: new Date(
        now.getTime() + AUTO_PLAN_APPLY_LEASE_MS,
      ).toISOString(),
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.settings.idempotencyRetentionSeconds * 1000,
      ),
    };
    if (!record) {
      try {
        await this.records.insertOne(newRecord);
        record = newRecord;
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        const existing = await this.records.findOne({
          ownerScope: owner,
          routeKey,
          idempotencyKeyHash: requestHash(key),
        });
        if (!existing)
          throw new PlanError(
            "operation_in_progress",
            409,
            "Apply is being retried",
          );
        if (existing.expiresAt <= now) {
          const { _id: _oldId, ...replacement } = newRecord;
          const replaced = await this.records.replaceOne(
            { _id: existing._id, expiresAt: { $lte: now } },
            replacement,
          );
          if (replaced.matchedCount !== 1)
            throw new PlanError(
              "operation_in_progress",
              409,
              "Apply is being retried",
            );
          record = { ...newRecord, _id: existing._id };
        } else if (existing.requestHash !== normalizedRequestHash)
          throw new PlanError(
            "idempotency_key_reused",
            409,
            "Idempotency key was used for another request",
          );
        else if (existing.state === "completed" && existing.responseBody)
          return {
            status: 200 as const,
            body: existing.responseBody as {
              data: unknown;
              meta: Record<string, never>;
            },
          };
        else {
          record = existing;
          if (
            record.state === "processing" &&
            record.leaseExpiresAt &&
            record.leaseExpiresAt > now.toISOString()
          )
            throw new PlanError(
              "operation_in_progress",
              409,
              "Apply is still in progress",
            );
          record = await this.claimApplyRecord(record, now);
        }
      }
    }
    try {
      const { canonical } = await this.checkApplySnapshot(
        owner,
        document,
        token,
      );
      const selectedBundles = new Set(
        canonical.map((item) => String(item.bundle.bundleId)),
      );
      const keep = document.items.filter(
        (item) =>
          item.status !== "selected" && !selectedBundles.has(item.bundleId),
      );
      const byBundle = new Map(
        document.items.map((item) => [item.bundleId, item]),
      );
      const nextSelected: CoursePlanItem[] = [];
      for (const resolved of canonical) {
        const existing = byBundle.get(String(resolved.bundle.bundleId));
        if (existing && existing.status !== "rejected") {
          nextSelected.push({
            ...existing,
            status: "selected",
            updatedAt: now.toISOString(),
          });
        } else {
          const base = await this.itemBase(document, {
            offeringId: String(resolved.offering.offeringId),
            bundleId: String(resolved.bundle.bundleId),
            status: "selected",
          });
          nextSelected.push(base.item);
        }
      }
      const items = [...keep, ...nextSelected];
      assertPlanItemInvariants(items);
      const marker = {
        operationId: record.operationId ?? operationId,
        requestHash: normalizedRequestHash,
        fromRevision: document.revision,
        toRevision: document.revision + 1,
        appliedAt: now.toISOString(),
      };
      if (
        !(await this.plans.compareAndSet(
          owner,
          planObjectId,
          document.revision,
          {
            items,
            lastAutoPlanApply: marker,
            updatedAt: now.toISOString(),
          },
        ))
      )
        throw new PlanError("concurrent_modification", 409, "Plan has changed");
      const persisted = {
        ...document,
        items,
        lastAutoPlanApply: marker,
        revision: document.revision + 1,
        updatedAt: now.toISOString(),
      } as PlanWithId;
      return this.finishApplyRecord(
        record,
        await this.applyResponse(persisted),
      );
    } catch (error) {
      const latest = await this.plans.findById(owner, planObjectId);
      if (
        latest?.lastAutoPlanApply?.operationId !== record.operationId ||
        latest?.lastAutoPlanApply?.requestHash !== normalizedRequestHash
      )
        await this.releaseFailedApply(record);
      throw error;
    }
  }

  async patchItem(
    owner: string,
    id: string,
    itemId: string,
    revision: number,
    input: unknown,
  ) {
    const document = await this.document(owner, id);
    if (document.status === "archived")
      throw new PlanError(
        "readonly_resource",
        409,
        "Archived plans are read-only",
      );
    if (document.revision !== revision)
      throw new PlanError("concurrent_modification", 409, "Plan has changed", {
        currentRevision: String(document.revision),
      });
    const index = document.items.findIndex((item) => item.itemId === itemId);
    if (index < 0) throw new PlanError("not_found", 404, "Plan item not found");
    const value = normalizeItemPatch(input) as {
      status?: "selected" | "alternative" | "rejected";
      note?: string | null;
      colorOverride?: string | null;
    };
    const current = document.items[index]!;
    if (current.status === "rejected" && value.status === "selected")
      throw new PlanError(
        "invalid_state_transition",
        409,
        "Rejected items must be added again before selection",
      );
    const next: CoursePlanItem = {
      ...current,
      ...(value.status === undefined ? {} : { status: value.status }),
      ...(value.note === undefined
        ? {}
        : value.note === null
          ? { note: undefined }
          : { note: value.note }),
      ...(value.colorOverride === undefined
        ? {}
        : value.colorOverride === null
          ? { colorOverride: undefined }
          : { colorOverride: value.colorOverride }),
      updatedAt: nowIso(this.settings),
    };
    const items = [...document.items];
    items[index] = next;
    assertPlanItemInvariants(items);
    if (next.status === "selected") {
      const term = await this.catalog.activeTerm(document.termCode);
      const canonical = await this.catalog.activeBundleById(
        term,
        next.bundleId,
      );
      if (!canonical)
        throw new PlanError(
          "stale_reference",
          409,
          "Course section bundle is no longer available",
        );
      const conflicts = await this.blockingConflicts(owner, [
        canonical,
        ...(await this.selectedCanonicals(document, next.courseId)),
      ]);
      if (conflicts.length)
        throw new PlanError(
          "conflict_detected",
          409,
          "Selected course conflicts with another selected course or blocking calendar item",
        );
    }
    return this.response(
      await this.commit(owner, document, {
        items,
        updatedAt: nowIso(this.settings),
      }),
    );
  }

  async removeItem(
    owner: string,
    id: string,
    itemId: string,
    revision: number,
  ) {
    const document = await this.document(owner, id);
    if (document.status === "archived")
      throw new PlanError(
        "readonly_resource",
        409,
        "Archived plans are read-only",
      );
    if (document.revision !== revision)
      throw new PlanError("concurrent_modification", 409, "Plan has changed", {
        currentRevision: String(document.revision),
      });
    if (!document.items.some((item) => item.itemId === itemId))
      throw new PlanError("not_found", 404, "Plan item not found");
    const items = document.items.filter((item) => item.itemId !== itemId);
    return this.response(
      await this.commit(owner, document, {
        items,
        updatedAt: nowIso(this.settings),
      }),
    );
  }

  async selectedCalendarItems(owner: string, termCode?: string) {
    return this.calendarItems(
      owner,
      {
        from: "2000-01-01T00:00:00.000Z",
        to: "2037-01-01T00:00:00.000Z",
      },
      undefined,
      termCode,
    );
  }

  async calendarWarnings(
    owner: string,
    requestedPlanId?: string,
    termCode?: string,
  ) {
    let resolvedTermCode = termCode;
    let rows: PlanWithId[];
    if (requestedPlanId !== undefined) {
      const document = await this.document(owner, requestedPlanId);
      if (termCode !== undefined && document.termCode !== termCode)
        throw new PlanError(
          "invalid_request",
          400,
          "Plan term does not match termCode",
        );
      if (document.status === "archived")
        throw new PlanError(
          "readonly_resource",
          409,
          "Archived plans cannot be previewed",
        );
      rows = [document];
    } else {
      if (resolvedTermCode === undefined) {
        const defaultTerm = await this.catalog.defaultActiveTerm(
          this.settings.defaultTermCode,
        );
        if (!defaultTerm) return ["no_current_term"];
        resolvedTermCode = defaultTerm.termCode;
      }
      rows = await this.plans.list(owner, {
        limit: 100,
        termCode: resolvedTermCode,
        status: "active",
      });
    }
    const warnings = new Set<string>();
    for (const plan of rows) {
      const term = await this.catalog.term(plan.termCode);
      const selected = plan.items.filter((item) => item.status === "selected");
      if (!selected.length) continue;
      if (!term?.activeImportBatchId) {
        warnings.add("selected_course_reference_unavailable");
        continue;
      }
      for (const item of selected) {
        if (!(await this.catalog.activeBundleById(term, item.bundleId)))
          warnings.add("selected_course_reference_stale");
      }
    }
    return [...warnings];
  }

  async calendarItems(
    owner: string,
    window: { from: string; to: string },
    requestedPlanId?: string,
    termCode?: string,
  ) {
    let resolvedTermCode = termCode;
    if (requestedPlanId === undefined && resolvedTermCode === undefined) {
      const defaultTerm = await this.catalog.defaultActiveTerm(
        this.settings.defaultTermCode,
      );
      if (!defaultTerm) return [];
      resolvedTermCode = defaultTerm.termCode;
    }
    let rows: PlanWithId[];
    if (requestedPlanId !== undefined) {
      const document = await this.document(owner, requestedPlanId);
      if (termCode !== undefined && document.termCode !== termCode)
        throw new PlanError(
          "invalid_request",
          400,
          "Plan term does not match termCode",
        );
      if (document.status === "archived")
        throw new PlanError(
          "readonly_resource",
          409,
          "Archived plans cannot be previewed",
        );
      rows = [document];
    } else {
      const listed = await this.plans.list(owner, {
        limit: 100,
        ...(resolvedTermCode ? { termCode: resolvedTermCode } : {}),
        status: "active",
      });
      rows = listed;
    }
    const output: CalendarOccurrence[] = [];
    for (const plan of rows) {
      const term = await this.catalog.term(plan.termCode);
      if (!term?.activeImportBatchId) continue;
      for (const item of plan.items.filter(
        (row) => row.status === "selected",
      )) {
        const canonical = await this.catalog.activeBundleById(
          term,
          item.bundleId,
        );
        if (!canonical) continue;
        const expanded = expandCourseBundle(
          {
            bundleId: canonical.bundle.bundleId,
            courseCode: canonical.course.courseCode,
            sectionLabels: canonical.bundle.sectionLabels ?? [],
            meetings: bundleMeetings(canonical),
            termCode: plan.termCode,
          },
          window,
          this.settings.timezone,
        );
        output.push(...expanded.items);
      }
    }
    return output;
  }

  async resolvesCalendarKey(owner: string, key: string) {
    const listed = await this.plans.list(owner, {
      limit: 100,
      status: "active",
    });
    for (const plan of listed) {
      const term = await this.catalog.term(plan.termCode);
      if (!term?.activeImportBatchId) continue;
      for (const item of plan.items.filter(
        (row) => row.status === "selected",
      )) {
        const canonical = await this.catalog.activeBundleById(
          term,
          item.bundleId,
        );
        if (!canonical) continue;
        const dates = bundleMeetings(canonical).flatMap((meeting) =>
          [meeting.startDate, meeting.endDate].filter(
            (value): value is string => typeof value === "string",
          ),
        );
        if (!dates.length) continue;
        const sorted = [...dates].sort();
        const expanded = expandCourseBundle(
          {
            bundleId: canonical.bundle.bundleId,
            courseCode: canonical.course.courseCode,
            sectionLabels: canonical.bundle.sectionLabels ?? [],
            meetings: bundleMeetings(canonical),
            termCode: plan.termCode,
          },
          calendarWindow(
            sorted[0]!,
            Temporal.PlainDate.from(sorted.at(-1)!).add({ days: 1 }).toString(),
            this.settings.timezone,
            3660,
          ),
          this.settings.timezone,
        );
        if (expanded.items.some((item) => item.calendarKey === key))
          return true;
      }
    }
    return false;
  }
}
