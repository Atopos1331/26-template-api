import Ajv from "ajv";
import schema from "../../../contracts/course-data-v1.schema.json";

export type Coverage = "complete" | "partial" | "unavailable";
export type Resource = "courses" | "offerings" | "sections" | "bundles";
export type Term = {
  termCode: string;
  source: string;
  academicYearStart: number;
  academicYearEnd: number;
  season: "fall" | "winter" | "spring" | "summer";
  displayName: string;
  localizedName: string;
  sortKey: number;
  timezone: string;
  providerCurrent?: boolean;
  providerSelectable?: boolean;
  sourceRecordId: string;
};
export type Meeting = {
  startDate: string | null;
  endDate: string | null;
  weekdays: string[];
  startTime: string;
  endTime: string;
  timezone: string;
  facilityId: string | null;
  venue: string | null;
};
export type Course = {
  courseId: string;
  subject: string;
  catalogNumber: string;
  courseCode: string;
  title: string;
  description: string | null;
  longDescription: string | null;
  credits: number | null;
  prerequisites: string[];
  corequisites: string[];
  exclusions: string[];
  previousCourseCode: string | null;
  attributes: Record<string, unknown>;
  sourceCourseId: string;
};
export type Offering = {
  offeringId: string;
  termCode: string;
  courseId: string;
  academicCareer: string;
  source: string;
  sourceCourseId: string;
  sourceRecordId: string;
};
export type Section = {
  sectionId: string;
  offeringId: string;
  classNbr: string;
  sectionCode: string;
  classType: string | null;
  componentType: string;
  associatedClass: string | null;
  instructors: string[];
  meetings: Meeting[];
  consentRequired: boolean | null;
  open: boolean | null;
  remarks: string | null;
  source: string;
  sourceRecordId: string;
};
export type Bundle = {
  bundleId: string;
  offeringId: string;
  leadClassNbr: string;
  componentClassNbrs: string[];
  componentTypes: string[];
  sectionLabels: string[];
  bindingGroup: string | null;
  derivedSchedule: { meetings: Meeting[] };
  source: string;
};
export type Quota = {
  snapshotId: string;
  sectionId: string;
  capacity: number | null;
  enrolled: number | null;
  remaining: number | null;
  waitlisted: number | null;
  reserveCapacity: number | null;
  open: boolean | null;
  observedAt: string;
  source: string;
};
export type CourseData = {
  schemaVersion: "course-data-v1";
  source: string;
  term: Term;
  generatedAt: string;
  termMetadataCoverage: Coverage;
  isCompleteSnapshot: boolean;
  sourceRecordCount: number;
  pageTotals?: Record<string, number>;
  resourceCoverage: Record<Resource, Coverage>;
  courses: Course[];
  offerings: Offering[];
  sections: Section[];
  bundles: Bundle[];
  quotaSnapshots: Quota[];
  warnings?: string[];
};

const ajv = new Ajv({ allErrors: true });
const check = ajv.compile(schema);
const resources: Resource[] = ["courses", "offerings", "sections", "bundles"];

function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`DUPLICATE_${field}`);
}

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function validTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value.slice(0, 10)
  );
}

export function validate(input: unknown): asserts input is CourseData {
  if (!check(input))
    throw new Error(`SCHEMA_INVALID: ${ajv.errorsText(check.errors)}`);
  const data = input as CourseData;
  if (
    !validTimestamp(data.generatedAt) ||
    data.quotaSnapshots.some((row) => !validTimestamp(row.observedAt))
  )
    throw new Error("TIMESTAMP_INVALID");
  if (
    data.isCompleteSnapshot !==
    resources.every((name) => data.resourceCoverage[name] === "complete")
  ) {
    throw new Error("COVERAGE_MISMATCH");
  }
  if (data.term.source !== data.source) throw new Error("SOURCE_MISMATCH");
  for (const name of resources) {
    if (data.resourceCoverage[name] === "unavailable" && data[name].length)
      throw new Error("UNAVAILABLE_NOT_EMPTY");
  }
  unique(
    data.courses.map((row) => row.courseId),
    "COURSE",
  );
  unique(
    data.offerings.map((row) => row.offeringId),
    "OFFERING",
  );
  unique(
    data.sections.map((row) => row.sectionId),
    "SECTION",
  );
  unique(
    data.bundles.map((row) => row.bundleId),
    "BUNDLE",
  );
  unique(
    data.quotaSnapshots.map((row) => row.snapshotId),
    "QUOTA",
  );
  const courses = new Set(data.courses.map((row) => row.courseId));
  const offerings = new Map(data.offerings.map((row) => [row.offeringId, row]));
  const sections = new Map(data.sections.map((row) => [row.sectionId, row]));
  for (const row of data.offerings) {
    if (
      row.termCode !== data.term.termCode ||
      row.source !== data.source ||
      !courses.has(row.courseId) ||
      row.offeringId !==
        [row.source, row.termCode, row.courseId, row.academicCareer]
          .map(encodeURIComponent)
          .join(":")
    )
      throw new Error("OFFERING_REFERENCE_INVALID");
  }
  for (const row of data.sections) {
    if (
      !offerings.has(row.offeringId) ||
      row.source !== data.source ||
      row.sectionId !== `${row.offeringId}:${encodeURIComponent(row.classNbr)}`
    )
      throw new Error("SECTION_REFERENCE_INVALID");
    for (const meeting of row.meetings) {
      if (
        (meeting.startDate !== null && !validDate(meeting.startDate)) ||
        (meeting.endDate !== null && !validDate(meeting.endDate)) ||
        meeting.startTime >= meeting.endTime ||
        (meeting.startDate &&
          meeting.endDate &&
          meeting.startDate > meeting.endDate)
      )
        throw new Error("MEETING_INVALID");
    }
  }
  for (const row of data.bundles) {
    if (
      !offerings.has(row.offeringId) ||
      row.componentClassNbrs.length === 0 ||
      row.componentClassNbrs.length !== row.componentTypes.length ||
      row.componentTypes.length !== row.sectionLabels.length
    )
      throw new Error("BUNDLE_INVALID");
    for (const nbr of row.componentClassNbrs) {
      if (!sections.has(`${row.offeringId}:${encodeURIComponent(nbr)}`))
        throw new Error("BUNDLE_REFERENCE_INVALID");
    }
    if (
      row.bundleId !==
      `${row.offeringId}:${[...row.componentClassNbrs].sort().map(encodeURIComponent).join("+")}`
    )
      throw new Error("BUNDLE_ID_INVALID");
  }
  for (const row of data.quotaSnapshots) {
    if (
      !sections.has(row.sectionId) ||
      row.source !== data.source ||
      row.snapshotId !== `${row.sectionId}@${row.observedAt}`
    )
      throw new Error("QUOTA_REFERENCE_INVALID");
  }
}
