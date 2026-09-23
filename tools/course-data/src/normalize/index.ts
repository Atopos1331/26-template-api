import type {
  Course,
  CourseData,
  Meeting,
  Offering,
  Quota,
  Section,
} from "../contract.ts";
import { validate } from "../contract.ts";
import {
  parseCoursePage,
  type RawCourse,
  type RawImport,
} from "../providers/ust-schedule.ts";
import { makeBundles } from "./bundle.ts";
import { parseUstTerm } from "./term.ts";

const days: Record<string, string> = {
  Mo: "MO",
  Tu: "TU",
  We: "WE",
  Th: "TH",
  Fr: "FR",
  Sa: "SA",
  Su: "SU",
};
const safe = (value: string) => encodeURIComponent(value);

function integer(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  if (!/^\d+$/.test(value.trim()))
    throw new Error(`QUOTA_INVALID: ${value.slice(0, 40)}`);
  return Number(value);
}

function date(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new Error("MEETING_DATE_INVALID");
  return value;
}

function requirement(value: string | null | undefined): string[] {
  return value?.trim() ? [value.trim()] : [];
}

export function normalize(raw: RawImport): CourseData {
  if (
    raw.source !== "ust-class-schedule" ||
    !Array.isArray(raw.pages) ||
    !Array.isArray(raw.subjects) ||
    !raw.pageTotals ||
    typeof raw.pageTotals !== "object"
  )
    throw new Error("RAW_INPUT_INVALID");
  const generatedAt = new Date(raw.fetchedAt).toISOString();
  const term = parseUstTerm(raw.termCode);
  const selected = raw.subjectFilter ? [raw.subjectFilter] : raw.subjects;
  const complete = !raw.subjectFilter && raw.subjects.length > 0;
  const seenPages = new Set<string>();
  for (const page of raw.pages) {
    if (
      !selected.includes(page.subject) ||
      !Number.isInteger(page.page) ||
      page.page < 1 ||
      page.page > (raw.pageTotals[page.subject] ?? 0) ||
      seenPages.has(`${page.subject}:${page.page}`)
    )
      throw new Error("PAGE_COVERAGE_INVALID");
    seenPages.add(`${page.subject}:${page.page}`);
  }
  if (
    !selected.length ||
    selected.some((subject) => {
      const total = raw.pageTotals[subject];
      if (total === undefined || !Number.isInteger(total) || total < 1)
        return true;
      return Array.from(
        { length: total },
        (_, index) => `${subject}:${index + 1}`,
      ).some((key) => !seenPages.has(key));
    })
  )
    throw new Error("PAGE_COVERAGE_INVALID");
  const records: RawCourse[] = raw.pages.flatMap((page) => {
    const found = parseCoursePage(page.html);
    if (found.some((row) => row.subject !== page.subject))
      throw new Error("SUBJECT_PAGE_MISMATCH");
    return found;
  });
  const courses: Course[] = [];
  const offerings: Offering[] = [];
  const sections: Section[] = [];
  const quotaSnapshots: Quota[] = [];
  const warnings: string[] = [];
  const seenCourses = new Set<string>();
  const seenOfferings = new Set<string>();
  for (const row of records) {
    if (!/^[A-Z]+$/.test(row.subject) || !/^[0-9]+[A-Z]*$/.test(row.catalogNbr))
      throw new Error("COURSE_ID_INVALID");
    const courseId = `${row.subject}${row.catalogNbr}`;
    if (!seenCourses.has(courseId)) {
      courses.push({
        courseId,
        subject: row.subject,
        catalogNumber: row.catalogNbr,
        courseCode: courseId,
        title: row.title,
        description: row.description ?? null,
        longDescription: row.longDesc ?? null,
        credits: row.credit == null ? null : Number(row.credit),
        prerequisites: requirement(row.preReq),
        corequisites: requirement(row.coReq),
        exclusions: requirement(row.exclusion),
        previousCourseCode: row.prevCrseCode ?? null,
        attributes: row.attributes ?? {},
        sourceCourseId: row.crseId ?? courseId,
      });
      seenCourses.add(courseId);
    }
    // The public schedule has no explicit career on course rows. Keep it unknown.
    const career = row.academicCareer ?? "UNKNOWN";
    const offeringId = [raw.source, raw.termCode, courseId, career]
      .map(safe)
      .join(":");
    if (!seenOfferings.has(offeringId)) {
      offerings.push({
        offeringId,
        termCode: raw.termCode,
        courseId,
        academicCareer: career,
        source: raw.source,
        sourceCourseId: row.crseId ?? courseId,
        sourceRecordId: row.crseId ?? courseId,
      });
      seenOfferings.add(offeringId);
    }
    for (const item of row.sections) {
      const classNbr = String(item.classNbr);
      const sectionId = `${offeringId}:${safe(classNbr)}`;
      const componentType =
        item.componentType ??
        (/^LA/i.test(item.section)
          ? "LAB"
          : /^T/i.test(item.section)
            ? "TUT"
            : /^L/i.test(item.section)
              ? "LEC"
              : "OTHER");
      const meetings: Meeting[] = item.schedules.map((schedule) => {
        const chunks = schedule.weekdays.match(/Mo|Tu|We|Th|Fr|Sa|Su/g) ?? [];
        if (chunks.join("") !== schedule.weekdays || !chunks.length)
          throw new Error("WEEKDAYS_INVALID");
        return {
          startDate: date(schedule.startDt),
          endDate: date(schedule.endDt),
          weekdays: [...new Set(chunks.map((day) => days[day] ?? ""))],
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          timezone: "Asia/Hong_Kong",
          facilityId: schedule.facilityId ?? null,
          venue: schedule.venue ?? null,
        };
      });
      if (!meetings.length) warnings.push(`NO_MEETING:${sectionId}`);
      sections.push({
        sectionId,
        offeringId,
        classNbr,
        sectionCode: item.section,
        classType: item.classType ?? null,
        componentType,
        associatedClass: item.associatedClass ?? null,
        instructors: [...new Set(item.instructors)],
        meetings,
        consentRequired: item.consent ?? null,
        open: item.classOpen ?? null,
        remarks: item.remarks ?? null,
        source: raw.source,
        sourceRecordId: classNbr,
      });
      const capacity = integer(item.enrlCap);
      const enrolled = integer(item.enrlTot);
      const remaining = integer(item.remaining);
      const waitlisted = integer(item.waitTot);
      const reserveCapacity = integer(item.reserveCap);
      if (
        [capacity, enrolled, remaining, waitlisted, reserveCapacity].some(
          (value) => value !== null,
        ) ||
        item.classOpen != null
      ) {
        if (
          remaining !== null &&
          capacity !== null &&
          enrolled !== null &&
          remaining !== capacity - enrolled
        )
          warnings.push(
            `QUOTA_DISAGREEMENT:${sectionId}:${capacity}:${enrolled}:${remaining}`,
          );
        quotaSnapshots.push({
          snapshotId: `${sectionId}@${generatedAt}`,
          sectionId,
          capacity,
          enrolled,
          remaining:
            remaining ??
            (capacity !== null && enrolled !== null
              ? capacity - enrolled
              : null),
          waitlisted,
          reserveCapacity,
          open: item.classOpen ?? null,
          observedAt: generatedAt,
          source: raw.source,
        });
      }
    }
  }
  const bundles = offerings.flatMap((offering) => {
    const result = makeBundles(
      sections.filter((row) => row.offeringId === offering.offeringId),
    );
    warnings.push(...result.warnings);
    return result.bundles;
  });
  const coverage = complete ? "complete" : "partial";
  const data: CourseData = {
    schemaVersion: "course-data-v1",
    source: raw.source,
    term,
    generatedAt,
    termMetadataCoverage: "unavailable",
    isCompleteSnapshot: complete,
    sourceRecordCount: records.length,
    pageTotals: raw.pageTotals,
    resourceCoverage: {
      courses: coverage,
      offerings: coverage,
      sections: coverage,
      bundles: coverage,
    },
    courses,
    offerings,
    sections,
    bundles,
    quotaSnapshots,
    warnings,
  };
  validate(data);
  return data;
}
