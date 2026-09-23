import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db, Document } from "mongodb";
import type { Static } from "typebox";
import {
  ACADEMIC_SOURCE,
  AcademicError,
  academicIdentity,
} from "../domain/academic.js";
import {
  calculateQuotaTrend,
  effectiveRemaining,
  enrollmentDifficulty,
  type QuotaTrendWindow,
  selectQuotaTrendObservations,
} from "../domain/quota.js";
import type {
  BundleSchema,
  CourseSummarySchema,
  OfferingSchema,
  QuotaSchema,
  TermSchema,
} from "../http/academic-schemas.js";
import {
  enqueueQuotaRefreshJob,
  quotaSnapshots,
} from "../repositories/quotas.js";

type Freshness = {
  asOf: string | null;
  isStale: boolean;
  source: string;
  lastAttemptAt: string | null;
  nextRefreshAt: string | null;
  state: "fresh" | "stale" | "refreshing";
};

export type AcademicSettings = {
  structureTtlSeconds: number;
  quotaTtlSeconds: number;
  cursorKey: string;
  cursorTtlSeconds: number;
  currentTermCode?: string;
  now?: () => Date;
};

type Page<T> = {
  items: T[];
  page: { nextCursor: string | null; hasMore: boolean };
  meta: { freshness: Freshness };
};
type Cursor = {
  kind: string;
  scope: string;
  filters: string;
  last: string;
  issuedAt: number;
};

function clean<T>(document: Document, fields: string[]): T {
  return Object.fromEntries(
    fields.map((field) => [field, document[field] ?? null]),
  ) as T;
}

const termFields = [
  "termCode",
  "displayName",
  "localizedName",
  "season",
  "academicYearStart",
  "academicYearEnd",
  "sortKey",
  "timezone",
];
const offeringFields = [
  "offeringId",
  "termCode",
  "courseId",
  "academicCareer",
  "source",
  "sourceCourseId",
];
const courseFields = [
  "courseId",
  "courseCode",
  "subject",
  "catalogNumber",
  "title",
  "description",
  "longDescription",
  "credits",
  "prerequisites",
  "corequisites",
  "exclusions",
  "previousCourseCode",
  "attributes",
];
const sectionFields = [
  "sectionId",
  "offeringId",
  "classNbr",
  "sectionCode",
  "classType",
  "componentType",
  "associatedClass",
  "instructors",
  "meetings",
  "consentRequired",
  "open",
  "remarks",
];
const bundleFields = [
  "bundleId",
  "offeringId",
  "leadClassNbr",
  "componentClassNbrs",
  "componentTypes",
  "sectionLabels",
  "bindingGroup",
  "derivedSchedule",
  "source",
  "bindingEvidence",
];
const quotaFields = [
  "snapshotId",
  "sectionId",
  "capacity",
  "enrolled",
  "remaining",
  "waitlisted",
  "reserveCapacity",
  "open",
  "observedAt",
];

function quotaResponse(document: Document) {
  const rawRemaining = effectiveRemaining(document);
  return {
    ...clean<Static<typeof QuotaSchema>>(document, quotaFields),
    remaining: rawRemaining === null ? null : Math.max(0, rawRemaining),
    ...(rawRemaining !== null && rawRemaining < 0 ? { rawRemaining } : {}),
  };
}

export class AcademicService {
  constructor(
    private readonly db: Db,
    private readonly settings: AcademicSettings,
  ) {}

  private now(): Date {
    return this.settings.now?.() ?? new Date();
  }

  private freshness(doc: Document | null, ttlSeconds: number): Freshness {
    const observed =
      typeof doc?.lastSuccessfulImportAt === "string"
        ? doc.lastSuccessfulImportAt
        : typeof doc?.observedAt === "string"
          ? doc.observedAt
          : null;
    const asOf =
      observed && Number.isFinite(Date.parse(observed)) ? observed : null;
    const nextRefreshAt =
      typeof doc?.nextRefreshAt === "string"
        ? doc.nextRefreshAt
        : asOf
          ? new Date(Date.parse(asOf) + ttlSeconds * 1000).toISOString()
          : null;
    const isStale =
      !asOf || Date.parse(asOf) + ttlSeconds * 1000 <= this.now().getTime();
    return {
      asOf,
      isStale,
      source: ACADEMIC_SOURCE,
      lastAttemptAt:
        typeof doc?.lastAttemptedAt === "string"
          ? doc.lastAttemptedAt
          : typeof doc?.lastAttemptedImportAt === "string"
            ? doc.lastAttemptedImportAt
            : null,
      nextRefreshAt,
      state: isStale ? "stale" : "fresh",
    };
  }

  private aggregateFreshness(docs: Document[], ttlSeconds: number): Freshness {
    const values = docs.map((doc) => this.freshness(doc, ttlSeconds));
    values.sort(
      (a, b) =>
        (a.asOf ? Date.parse(a.asOf) : Number.NEGATIVE_INFINITY) -
        (b.asOf ? Date.parse(b.asOf) : Number.NEGATIVE_INFINITY),
    );
    return values[0] ?? this.freshness(null, ttlSeconds);
  }

  private sign(value: string): string {
    return createHmac("sha256", this.settings.cursorKey)
      .update(value)
      .digest("base64url");
  }

  private cursor(
    kind: string,
    scope: string,
    filters: string,
    last: string,
  ): string {
    const encoded = Buffer.from(
      JSON.stringify({
        kind,
        scope,
        filters,
        last,
        issuedAt: this.now().getTime(),
      } satisfies Cursor),
    ).toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  private readCursor(
    token: string | undefined,
    kind: string,
    scope: string,
    filters: string,
  ): string | null {
    if (!token) return null;
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra)
      throw new AcademicError("invalid_cursor", 400, "Invalid cursor");
    const expected = Buffer.from(this.sign(encoded));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new AcademicError("invalid_cursor", 400, "Invalid cursor");
    try {
      const value = JSON.parse(
        Buffer.from(encoded, "base64url").toString(),
      ) as Cursor;
      if (
        value.kind !== kind ||
        value.scope !== scope ||
        value.filters !== filters ||
        typeof value.last !== "string" ||
        !Number.isFinite(value.issuedAt) ||
        value.issuedAt > this.now().getTime() ||
        value.issuedAt + this.settings.cursorTtlSeconds * 1000 <
          this.now().getTime()
      )
        throw new Error("cursor mismatch");
      return value.last;
    } catch {
      throw new AcademicError("invalid_cursor", 400, "Invalid cursor");
    }
  }

  private page<T>(
    items: T[],
    limit: number,
    next: string | null,
    freshness: Freshness,
  ): Page<T> {
    return {
      items: items.slice(0, limit),
      page: {
        nextCursor: items.length > limit ? next : null,
        hasMore: items.length > limit,
      },
      meta: { freshness },
    };
  }

  private async term(termCode: string): Promise<Document> {
    const term = await this.db
      .collection("academicTerms")
      .findOne({ source: ACADEMIC_SOURCE, termCode });
    if (!term) {
      const available = await this.db
        .collection("academicTerms")
        .findOne(
          { source: ACADEMIC_SOURCE, activeImportBatchId: { $type: "string" } },
          { projection: { _id: 1 } },
        );
      if (!available)
        throw new AcademicError(
          "provider_unavailable",
          503,
          "Academic data is not available",
        );
      throw new AcademicError("not_found", 404, "Academic term not found");
    }
    if (!term.activeImportBatchId)
      throw new AcademicError(
        "provider_unavailable",
        503,
        "Academic data is not available",
      );
    return term;
  }

  async listTerms(
    limit: number,
    cursor?: string,
  ): Promise<Page<Static<typeof TermSchema>>> {
    const terms = await this.db
      .collection("academicTerms")
      .find({
        source: ACADEMIC_SOURCE,
        activeImportBatchId: { $type: "string" },
      })
      .toArray();
    if (!terms.length)
      throw new AcademicError(
        "provider_unavailable",
        503,
        "Academic data is not available",
      );
    terms.sort(
      (a, b) =>
        Number(b.termCode === this.settings.currentTermCode) -
          Number(a.termCode === this.settings.currentTermCode) ||
        Number(b.sortKey ?? 0) - Number(a.sortKey ?? 0) ||
        String(a.termCode).localeCompare(String(b.termCode)),
    );
    const last = this.readCursor(cursor, "terms", "all", "");
    const start = last
      ? terms.findIndex((item) => item.termCode === last) + 1
      : 0;
    if (last && start === 0)
      throw new AcademicError("invalid_cursor", 400, "Invalid cursor");
    const selected = terms.slice(start, start + limit + 1);
    const items = selected.map((term) => ({
      ...clean<Static<typeof TermSchema>>(term, termFields),
      isCurrent: term.termCode === this.settings.currentTermCode,
      isSelectable: true,
      freshness: this.freshness(term, this.settings.structureTtlSeconds),
    }));
    const lastItem = selected[Math.min(limit, selected.length) - 1];
    const metaFreshness = this.aggregateFreshness(
      selected.slice(0, limit),
      this.settings.structureTtlSeconds,
    );
    return this.page(
      items,
      limit,
      lastItem
        ? this.cursor("terms", "all", "", String(lastItem.termCode))
        : null,
      metaFreshness,
    );
  }

  async listCourses(
    termCode: string,
    query: {
      limit: number;
      cursor?: string;
      search?: string;
      subject?: string;
      catalogNumber?: string;
    },
  ): Promise<Page<Static<typeof CourseSummarySchema>>> {
    const term = await this.term(termCode);
    const key = {
      source: ACADEMIC_SOURCE,
      termCode,
      importBatchId: term.activeImportBatchId,
      retiredAt: null,
    };
    const filters = JSON.stringify({
      search: query.search ?? "",
      subject: query.subject ?? "",
      catalogNumber: query.catalogNumber ?? "",
    });
    const last = this.readCursor(query.cursor, "courses", termCode, filters);
    const pipeline: Document[] = [
      {
        $match: {
          ...key,
          ...(query.subject ? { subject: query.subject } : {}),
          ...(query.catalogNumber
            ? { catalogNumber: query.catalogNumber }
            : {}),
        },
      },
    ];
    if (query.search) {
      const literal = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pipeline.push({
        $match: {
          $expr: {
            $regexMatch: {
              input: { $concat: ["$courseCode", " ", "$title"] },
              regex: literal,
              options: "i",
            },
          },
        },
      });
    }
    pipeline.push(
      {
        $lookup: {
          from: "courseOfferings",
          localField: "courseId",
          foreignField: "courseId",
          pipeline: [{ $match: key }],
          as: "offering",
        },
      },
      { $unwind: "$offering" },
    );
    if (last) {
      const parts = last.split("\0");
      if (parts.length !== 3)
        throw new AcademicError("invalid_cursor", 400, "Invalid cursor");
      const [code, career, id] = parts;
      pipeline.push({
        $match: {
          $or: [
            { courseCode: { $gt: code } },
            { courseCode: code, "offering.academicCareer": { $gt: career } },
            {
              courseCode: code,
              "offering.academicCareer": career,
              "offering.offeringId": { $gt: id },
            },
          ],
        },
      });
    }
    pipeline.push(
      {
        $sort: {
          courseCode: 1,
          "offering.academicCareer": 1,
          "offering.offeringId": 1,
        },
      },
      { $limit: query.limit + 1 },
    );
    const selected = await this.db
      .collection("courses")
      .aggregate(pipeline)
      .toArray();
    const visible = selected.slice(0, query.limit);
    const sections = visible.length
      ? await this.db
          .collection("classSections")
          .find(
            {
              ...key,
              offeringId: {
                $in: visible.map((row) => row.offering.offeringId),
              },
            },
            { projection: { offeringId: 1, lastSuccessfulImportAt: 1 } },
          )
          .toArray()
      : [];
    const sectionsByOffering = new Map<string, Document[]>();
    for (const row of sections) {
      const group = sectionsByOffering.get(row.offeringId) ?? [];
      group.push(row);
      sectionsByOffering.set(row.offeringId, group);
    }
    const items = selected.map((course) => ({
      offeringId: course.offering.offeringId,
      termCode,
      courseId: course.courseId,
      courseCode: course.courseCode,
      title: course.title,
      credits: course.credits ?? null,
      academicCareer: course.offering.academicCareer,
      sectionCount:
        sectionsByOffering.get(course.offering.offeringId)?.length ?? 0,
      latestUpdatedAt: course.offering.updatedAt ?? course.updatedAt ?? null,
      freshness: this.aggregateFreshness(
        [
          course.offering,
          course,
          ...(sectionsByOffering.get(course.offering.offeringId) ?? []),
        ],
        this.settings.structureTtlSeconds,
      ),
    }));
    const lastRow = visible.at(-1);
    return this.page(
      items,
      query.limit,
      lastRow
        ? this.cursor(
            "courses",
            termCode,
            filters,
            `${lastRow.courseCode}\0${lastRow.offering.academicCareer}\0${lastRow.offering.offeringId}`,
          )
        : null,
      this.aggregateFreshness(
        [
          term,
          ...visible.flatMap((course) => [
            course.offering,
            course,
            ...(sectionsByOffering.get(course.offering.offeringId) ?? []),
          ]),
        ],
        this.settings.structureTtlSeconds,
      ),
    );
  }

  private async activeOffering(offeringId: string): Promise<{
    term: Document;
    offering: Document;
    key: Record<string, unknown>;
  }> {
    const identity = academicIdentity(offeringId, "offering");
    const term = await this.term(identity.termCode);
    const key = {
      ...identity,
      importBatchId: term.activeImportBatchId,
      retiredAt: null,
    };
    const offering = await this.db
      .collection("courseOfferings")
      .findOne({ ...key, offeringId });
    if (!offering)
      throw new AcademicError("not_found", 404, "Offering not found");
    return { term, offering, key };
  }

  async getOffering(offeringId: string) {
    const { term, offering, key } = await this.activeOffering(offeringId);
    const [course, sections, bundleCount] = await Promise.all([
      this.db
        .collection("courses")
        .findOne({ ...key, courseId: offering.courseId }),
      this.db
        .collection("classSections")
        .find({ ...key, offeringId })
        .sort({ sectionCode: 1, sectionId: 1 })
        .toArray(),
      this.db
        .collection("sectionBundles")
        .countDocuments({ ...key, offeringId }),
    ]);
    if (!course)
      throw new AcademicError(
        "provider_unavailable",
        503,
        "Course data is incomplete",
      );
    return {
      data: {
        ...clean<Static<typeof OfferingSchema>>(offering, offeringFields),
        bundleAvailability: bundleCount
          ? ("available" as const)
          : new Set(sections.map((row) => row.componentType)).size > 1
            ? ("unverified_binding" as const)
            : ("none" as const),
        course: clean<Static<typeof OfferingSchema>["course"]>(
          course,
          courseFields,
        ),
        term: {
          ...clean<Static<typeof TermSchema>>(term, termFields),
          isCurrent: term.termCode === this.settings.currentTermCode,
          isSelectable: true,
        },
        sections: sections.map((row) =>
          clean<Static<typeof OfferingSchema>["sections"][number]>(
            row,
            sectionFields,
          ),
        ),
      },
      meta: {
        freshness: this.aggregateFreshness(
          [term, offering, course, ...sections],
          this.settings.structureTtlSeconds,
        ),
      },
    };
  }

  async listBundles(offeringId: string) {
    const { term, offering, key } = await this.activeOffering(offeringId);
    const rows = await this.db
      .collection("sectionBundles")
      .find({ ...key, offeringId })
      .sort({ sectionLabels: 1, bundleId: 1 })
      .toArray();
    return {
      items: rows.map((row) => ({
        ...clean<Static<typeof BundleSchema>>(row, bundleFields),
        source:
          row.bindingSource ??
          (row.bindingEvidence ? "operator-verified" : "derived"),
        freshness: this.freshness(row, this.settings.structureTtlSeconds),
      })),
      page: { nextCursor: null, hasMore: false },
      meta: {
        freshness: this.aggregateFreshness(
          [term, offering, ...rows],
          this.settings.structureTtlSeconds,
        ),
      },
    };
  }

  private async enqueueQuota(
    sectionId: string,
    termCode: string,
  ): Promise<boolean> {
    await enqueueQuotaRefreshJob(
      this.db,
      ACADEMIC_SOURCE,
      termCode,
      sectionId,
      this.now(),
    );
    return true;
  }

  async getQuota(sectionId: string) {
    const identity = academicIdentity(sectionId, "section");
    const term = await this.term(identity.termCode);
    const section = await this.db.collection("classSections").findOne({
      ...identity,
      sectionId,
      importBatchId: term.activeImportBatchId,
      retiredAt: null,
    });
    if (!section)
      throw new AcademicError("not_found", 404, "Section not found");
    const latest = await this.db
      .collection("latestQuotas")
      .findOne({ source: ACADEMIC_SOURCE, sectionId });
    const freshness = this.freshness(latest, this.settings.quotaTtlSeconds);
    if (
      freshness.isStale &&
      (!latest?.nextRefreshAt ||
        Date.parse(latest.nextRefreshAt) <= this.now().getTime())
    ) {
      await this.enqueueQuota(sectionId, identity.termCode);
      freshness.state = "refreshing";
    }
    if (!latest?.snapshotId)
      throw new AcademicError(
        "provider_unavailable",
        503,
        "Quota is not available",
      );
    const history = await quotaSnapshots(this.db, ACADEMIC_SOURCE, sectionId);
    const trend = calculateQuotaTrend(
      selectQuotaTrendObservations(history, "14d", this.now()),
      "14d",
      this.now(),
    );
    return {
      data: {
        ...quotaResponse(latest),
        difficulty: enrollmentDifficulty(
          latest as unknown as
            | import("../domain/quota.js").QuotaObservationLike
            | null,
          trend,
        ),
      },
      meta: { freshness },
    };
  }

  async getQuotaTrends(
    sectionId: string,
    window: QuotaTrendWindow = "14d",
    limit = 100,
    cursor?: string,
  ) {
    const identity = academicIdentity(sectionId, "section");
    const term = await this.term(identity.termCode);
    const section = await this.db.collection("classSections").findOne({
      ...identity,
      sectionId,
      importBatchId: term.activeImportBatchId,
      retiredAt: null,
    });
    if (!section)
      throw new AcademicError("not_found", 404, "Section not found");
    const latest = await this.db
      .collection("latestQuotas")
      .findOne({ source: ACADEMIC_SOURCE, sectionId });
    const now = this.now();
    const freshness = this.freshness(latest, this.settings.quotaTtlSeconds);
    if (
      freshness.isStale &&
      (!latest?.nextRefreshAt ||
        Date.parse(latest.nextRefreshAt) <= now.getTime())
    ) {
      await this.enqueueQuota(sectionId, identity.termCode);
      freshness.state = "refreshing";
    }
    const all = await quotaSnapshots(this.db, ACADEMIC_SOURCE, sectionId);
    const observations = selectQuotaTrendObservations(all, window, now);
    const trend = calculateQuotaTrend(observations, window, now);
    const filters = JSON.stringify({ window });
    const last = this.readCursor(cursor, "quota-trends", sectionId, filters);
    const start = last
      ? observations.findIndex(
          (row) => `${row.observedAt}\0${row.snapshotId}` === last,
        ) + 1
      : 0;
    if (last && start === 0)
      throw new AcademicError("invalid_cursor", 400, "Invalid cursor");
    const selected = observations.slice(start, start + limit + 1);
    const visible = selected.slice(0, limit).map((row) => ({
      ...quotaResponse(row),
    }));
    const lastRow = visible.at(-1);
    const difficulty = enrollmentDifficulty(
      latest as unknown as
        | import("../domain/quota.js").QuotaObservationLike
        | null,
      trend,
    );
    return {
      data: {
        sectionId,
        latest: latest ? quotaResponse(latest) : null,
        observations: visible,
        trend,
        difficulty,
        freshness,
      },
      page: {
        nextCursor:
          selected.length > limit && lastRow
            ? this.cursor(
                "quota-trends",
                sectionId,
                filters,
                `${lastRow.observedAt}\0${lastRow.snapshotId}`,
              )
            : null,
        hasMore: selected.length > limit,
      },
      meta: { freshness },
    };
  }
}
