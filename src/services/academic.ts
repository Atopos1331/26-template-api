import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db, Document } from "mongodb";
import type { Static } from "typebox";
import {
  ACADEMIC_SOURCE,
  AcademicError,
  academicIdentity,
} from "../domain/academic.js";
import type {
  BundleSchema,
  CourseSummarySchema,
  OfferingSchema,
  QuotaSchema,
  TermSchema,
} from "../http/academic-schemas.js";

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

export class AcademicService {
  constructor(
    private readonly db: Db,
    private readonly settings: AcademicSettings,
  ) {}

  private now(): Date {
    return this.settings.now?.() ?? new Date();
  }

  private freshness(doc: Document | null, ttlSeconds: number): Freshness {
    const asOf =
      typeof doc?.lastSuccessfulImportAt === "string"
        ? doc.lastSuccessfulImportAt
        : typeof doc?.observedAt === "string"
          ? doc.observedAt
          : null;
    const nextRefreshAt =
      typeof doc?.nextRefreshAt === "string"
        ? doc.nextRefreshAt
        : asOf
          ? new Date(Date.parse(asOf) + ttlSeconds * 1000).toISOString()
          : null;
    const isStale =
      !asOf ||
      !Number.isFinite(Date.parse(asOf)) ||
      Date.parse(asOf) + ttlSeconds * 1000 <= this.now().getTime();
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
        Number(b.providerCurrent ?? false) -
          Number(a.providerCurrent ?? false) ||
        Number(b.providerSelectable ?? false) -
          Number(a.providerSelectable ?? false) ||
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
      isCurrent: term.providerCurrent === true,
      isSelectable: term.providerSelectable === true,
      freshness: this.freshness(term, this.settings.structureTtlSeconds),
    }));
    const lastItem = selected[Math.min(limit, selected.length) - 1];
    const metaFreshness = this.freshness(
      terms[0] ?? null,
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
    const [courseRows, offerings, sections] = await Promise.all([
      this.db.collection("courses").find(key).toArray(),
      this.db.collection("courseOfferings").find(key).toArray(),
      this.db
        .collection("classSections")
        .find(key, { projection: { offeringId: 1 } })
        .toArray(),
    ]);
    const courses = new Map(courseRows.map((item) => [item.courseId, item]));
    const counts = new Map<string, number>();
    for (const row of sections)
      counts.set(row.offeringId, (counts.get(row.offeringId) ?? 0) + 1);
    const filters = JSON.stringify({
      search: query.search ?? "",
      subject: query.subject ?? "",
      catalogNumber: query.catalogNumber ?? "",
    });
    const last = this.readCursor(query.cursor, "courses", termCode, filters);
    const rows = offerings.flatMap((offering) => {
      const course = courses.get(offering.courseId);
      if (!course) return [];
      if (
        query.subject &&
        String(course.subject).toUpperCase() !== query.subject
      )
        return [];
      if (
        query.catalogNumber &&
        String(course.catalogNumber).toUpperCase() !== query.catalogNumber
      )
        return [];
      if (
        query.search &&
        !`${course.courseCode} ${course.title}`
          .toLocaleLowerCase()
          .includes(query.search)
      )
        return [];
      return [{ offering, course }];
    });
    rows.sort(
      (a, b) =>
        String(a.course.courseCode).localeCompare(
          String(b.course.courseCode),
        ) ||
        String(a.offering.academicCareer).localeCompare(
          String(b.offering.academicCareer),
        ) ||
        String(a.offering.offeringId).localeCompare(
          String(b.offering.offeringId),
        ),
    );
    const position = (row: (typeof rows)[number]) =>
      `${row.course.courseCode}\0${row.offering.academicCareer}\0${row.offering.offeringId}`;
    const filtered = last ? rows.filter((row) => position(row) > last) : rows;
    const selected = filtered.slice(0, query.limit + 1);
    const items = selected.map(({ offering, course }) => ({
      offeringId: offering.offeringId,
      termCode,
      courseId: course.courseId,
      courseCode: course.courseCode,
      title: course.title,
      credits: course.credits ?? null,
      academicCareer: offering.academicCareer,
      sectionCount: counts.get(offering.offeringId) ?? 0,
      latestUpdatedAt: offering.updatedAt ?? course.updatedAt ?? null,
      freshness: this.freshness(offering, this.settings.structureTtlSeconds),
    }));
    const lastRow = selected[Math.min(query.limit, selected.length) - 1];
    return this.page(
      items,
      query.limit,
      lastRow
        ? this.cursor("courses", termCode, filters, position(lastRow))
        : null,
      this.freshness(term, this.settings.structureTtlSeconds),
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
    const [course, sections] = await Promise.all([
      this.db
        .collection("courses")
        .findOne({ ...key, courseId: offering.courseId }),
      this.db
        .collection("classSections")
        .find({ ...key, offeringId })
        .sort({ sectionCode: 1, sectionId: 1 })
        .toArray(),
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
        course: clean<Static<typeof OfferingSchema>["course"]>(
          course,
          courseFields,
        ),
        term: {
          ...clean<Static<typeof TermSchema>>(term, termFields),
          isCurrent: term.providerCurrent === true,
          isSelectable: term.providerSelectable === true,
        },
        sections: sections.map((row) =>
          clean<Static<typeof OfferingSchema>["sections"][number]>(
            row,
            sectionFields,
          ),
        ),
      },
      meta: {
        freshness: this.freshness(offering, this.settings.structureTtlSeconds),
      },
    };
  }

  async listBundles(offeringId: string) {
    const { offering, key } = await this.activeOffering(offeringId);
    const rows = await this.db
      .collection("sectionBundles")
      .find({ ...key, offeringId })
      .sort({ sectionLabels: 1, bundleId: 1 })
      .toArray();
    return {
      items: rows.map((row) => ({
        ...clean<Static<typeof BundleSchema>>(row, bundleFields),
        freshness: this.freshness(row, this.settings.structureTtlSeconds),
      })),
      page: { nextCursor: null, hasMore: false },
      meta: {
        freshness: this.freshness(
          rows[0] ?? offering,
          this.settings.structureTtlSeconds,
        ),
      },
    };
  }

  private async enqueueQuota(
    sectionId: string,
    termCode: string,
  ): Promise<boolean> {
    const dedupeKey = `${ACADEMIC_SOURCE}:${termCode}:quota:${sectionId}`;
    const jobs = this.db.collection("refreshJobs");
    const active = ["queued", "running", "retryable_failed"];
    try {
      await jobs.updateOne(
        { dedupeKey, status: { $in: active } },
        {
          $setOnInsert: {
            dedupeKey,
            jobType: "section_quota",
            source: ACADEMIC_SOURCE,
            termCode,
            resourceType: "quota",
            targetId: sectionId,
            status: "queued",
            attempts: 0,
            claimGeneration: 0,
            availableAt: this.now(),
            createdAt: this.now().toISOString(),
            updatedAt: this.now().toISOString(),
          },
        },
        { upsert: true },
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
    return {
      data: clean<Static<typeof QuotaSchema>>(latest, quotaFields),
      meta: { freshness },
    };
  }
}
