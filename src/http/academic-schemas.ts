import { Type } from "typebox";
import { AcademicError } from "../domain/academic.js";

export const AcademicErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    fields: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
});
export const FreshnessSchema = Type.Object({
  asOf: Type.Union([Type.String(), Type.Null()]),
  isStale: Type.Boolean(),
  source: Type.String(),
  lastAttemptAt: Type.Union([Type.String(), Type.Null()]),
  nextRefreshAt: Type.Union([Type.String(), Type.Null()]),
  state: Type.Union([
    Type.Literal("fresh"),
    Type.Literal("stale"),
    Type.Literal("refreshing"),
  ]),
});
export const AcademicMeta = Type.Object({ freshness: FreshnessSchema });
export const PageSchema = Type.Object({
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});
export const TermSchema = Type.Object(
  {
    termCode: Type.String(),
    displayName: Type.String(),
    localizedName: Type.String(),
    season: Type.String(),
    academicYearStart: Type.Number(),
    academicYearEnd: Type.Number(),
    isCurrent: Type.Boolean(),
    isSelectable: Type.Boolean(),
    freshness: Type.Optional(FreshnessSchema),
  },
  { additionalProperties: true },
);
export const CourseSummarySchema = Type.Object({
  offeringId: Type.String(),
  termCode: Type.String(),
  courseId: Type.String(),
  courseCode: Type.String(),
  title: Type.String(),
  credits: Type.Union([Type.Number(), Type.Null()]),
  academicCareer: Type.String(),
  sectionCount: Type.Number(),
  latestUpdatedAt: Type.Union([Type.String(), Type.Null()]),
  freshness: FreshnessSchema,
});
export const OfferingSchema = Type.Object(
  {
    offeringId: Type.String(),
    termCode: Type.String(),
    courseId: Type.String(),
    academicCareer: Type.String(),
    course: Type.Object(
      {
        courseId: Type.String(),
        courseCode: Type.String(),
        title: Type.String(),
        credits: Type.Union([Type.Number(), Type.Null()]),
      },
      { additionalProperties: true },
    ),
    term: TermSchema,
    sections: Type.Array(
      Type.Object(
        {
          sectionId: Type.String(),
          sectionCode: Type.String(),
          classNbr: Type.String(),
          meetings: Type.Array(Type.Any()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);
export const BundleSchema = Type.Object(
  {
    bundleId: Type.String(),
    offeringId: Type.String(),
    leadClassNbr: Type.String(),
    componentClassNbrs: Type.Array(Type.String()),
    componentTypes: Type.Array(Type.String()),
    sectionLabels: Type.Array(Type.String()),
    derivedSchedule: Type.Object({ meetings: Type.Array(Type.Any()) }),
    freshness: FreshnessSchema,
  },
  { additionalProperties: true },
);
export const QuotaSchema = Type.Object({
  snapshotId: Type.String(),
  sectionId: Type.String(),
  capacity: Type.Union([Type.Number(), Type.Null()]),
  enrolled: Type.Union([Type.Number(), Type.Null()]),
  remaining: Type.Union([Type.Number(), Type.Null()]),
  waitlisted: Type.Union([Type.Number(), Type.Null()]),
  reserveCapacity: Type.Union([Type.Number(), Type.Null()]),
  open: Type.Union([Type.Boolean(), Type.Null()]),
  observedAt: Type.String(),
});

export const academicResponses = {
  400: AcademicErrorResponse,
  401: AcademicErrorResponse,
  404: AcademicErrorResponse,
  503: AcademicErrorResponse,
};

export function pageLimit(raw?: string): number {
  if (raw === undefined) return 50;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 100)
    throw new AcademicError("invalid_request", 400, "Invalid limit", {
      limit: "must be an integer from 1 to 100",
    });
  return Number(raw);
}

export function courseFilters(query: {
  search?: string;
  subject?: string;
  catalogNumber?: string;
}) {
  const search = query.search?.trim().toLocaleLowerCase();
  const subject = query.subject?.trim().toUpperCase();
  const catalogNumber = query.catalogNumber?.trim().toUpperCase();
  if (search && search.length > 100)
    throw new AcademicError("invalid_request", 400, "Invalid search", {
      search: "must be at most 100 characters",
    });
  if (subject && !/^[A-Z]{2,8}$/.test(subject))
    throw new AcademicError("invalid_request", 400, "Invalid subject", {
      subject: "must be a subject code",
    });
  if (catalogNumber && !/^[0-9]+[A-Z]*$/.test(catalogNumber))
    throw new AcademicError("invalid_request", 400, "Invalid catalog number", {
      catalogNumber: "must be a catalog number",
    });
  return {
    ...(search ? { search } : {}),
    ...(subject ? { subject } : {}),
    ...(catalogNumber ? { catalogNumber } : {}),
  };
}
