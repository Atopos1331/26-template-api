import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { PlanError } from "./plans.js";

export type AutoPlanMode = "coverage_first" | "seat_safety" | "balanced";
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export type AutoPlanWindow = {
  weekdays: Weekday[];
  startTime: string;
  endTime: string;
  startDate?: string;
  endDate?: string;
};

export type AutoPlanCourseInput = {
  courseCode: string;
  academicCareer?: string;
  required: boolean;
  priority: number;
  lockedBundleId?: string;
  lockedSectionIds?: string[];
  excludedSectionIds: string[];
  excludedInstructorNames: string[];
};

export type AutoPlanGroup = {
  id: string;
  courseCodes: string[];
  minCount: number;
  maxCount: number;
};

export type AutoPlanConstraints = {
  unavailableWindows: AutoPlanWindow[];
  freeWeekdays: Weekday[];
  minDaysOff?: number;
  earliestStart?: string;
  latestEnd?: string;
  protectedWindows: AutoPlanWindow[];
  maxCampusDays?: number;
  maxDailyClassMinutes?: number;
  minCredits?: number;
  maxCredits?: number;
  preferredWindows: AutoPlanWindow[];
  preferredInstructorNames: string[];
};

export type NormalizedAutoPlanRequest = {
  courses: AutoPlanCourseInput[];
  groups: AutoPlanGroup[];
  includeCurrentSelected: boolean;
  constraints: AutoPlanConstraints;
  mode: AutoPlanMode;
  allowFullWaitlist: boolean;
  unknownQuotaPolicy: "allow" | "exclude";
  resultLimit: number;
  minDifferentBundles: number;
};

const WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const ROOT_FIELDS = new Set([
  "courses",
  "groups",
  "includeCurrentSelected",
  "constraints",
  "mode",
  "allowFullWaitlist",
  "unknownQuotaPolicy",
  "resultLimit",
  "minDifferentBundles",
  "weights",
  "fill",
]);

function invalid(field: string, reason: string): never {
  throw new PlanError("invalid_request", 400, "Request validation failed", {
    [field]: reason,
  });
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid(field, "must be an object");
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) return invalid(field, "must be an array");
  if (value.length > max) invalid(field, `must contain at most ${max} items`);
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") return invalid(field, "must be a string");
  const result = value.trim();
  if (!result || result.length > max)
    invalid(field, `must contain 1..${max} characters`);
  return result;
}

export function normalizeCourseCode(value: unknown, field: string) {
  const result = text(value, field, 32).replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2,8}\d+[A-Z]?$/.test(result))
    invalid(field, "must be a canonical course code");
  return result;
}

function uniqueStrings(values: unknown[], field: string, maxLength: number) {
  const result = values.map((value, index) =>
    text(value, `${field}[${index}]`, maxLength),
  );
  if (new Set(result).size !== result.length)
    invalid(field, "must not contain duplicates");
  return result;
}

function weekday(value: unknown, field: string): Weekday {
  if (!WEEKDAYS.includes(value as Weekday))
    invalid(field, "must be a weekday code");
  return value as Weekday;
}

function weekdays(value: unknown, field: string, max = 7) {
  const values = list(value, field, max).map((entry, index) =>
    weekday(entry, `${field}[${index}]`),
  );
  if (new Set(values).size !== values.length)
    invalid(field, "must not contain duplicates");
  return WEEKDAYS.filter((entry) => values.includes(entry));
}

function clock(value: unknown, field: string): string {
  const result = text(value, field, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result))
    invalid(field, "must use local HH:mm");
  return result;
}

function date(value: unknown, field: string): string {
  const result = text(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result))
    invalid(field, "must use YYYY-MM-DD");
  try {
    if (Temporal.PlainDate.from(result).toString() !== result)
      invalid(field, "must be a valid YYYY-MM-DD date");
  } catch {
    invalid(field, "must be a valid YYYY-MM-DD date");
  }
  return result;
}

function finiteNumber(value: unknown, field: string, min: number, max: number) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    invalid(field, `must be a finite number from ${min} to ${max}`);
  return value;
}

export function normalizeAutoPlanWindows(
  value: unknown,
  field: string,
): AutoPlanWindow[] {
  if (value === undefined) return [];
  return list(value, field, 20).map((entry, index) => {
    const row = object(entry, `${field}[${index}]`);
    for (const key of Object.keys(row)) {
      if (
        !["weekdays", "startTime", "endTime", "startDate", "endDate"].includes(
          key,
        )
      )
        invalid(`${field}[${index}].${key}`, "is not allowed");
    }
    const startTime = clock(row.startTime, `${field}[${index}].startTime`);
    const endTime = clock(row.endTime, `${field}[${index}].endTime`);
    if (startTime >= endTime)
      invalid(`${field}[${index}]`, "startTime must precede endTime");
    const normalizedWeekdays = weekdays(
      row.weekdays,
      `${field}[${index}].weekdays`,
    );
    if (!normalizedWeekdays.length)
      invalid(
        `${field}[${index}].weekdays`,
        "must contain at least one weekday",
      );
    const result: AutoPlanWindow = {
      weekdays: normalizedWeekdays,
      startTime,
      endTime,
    };
    if (row.startDate !== undefined)
      result.startDate = date(row.startDate, `${field}[${index}].startDate`);
    if (row.endDate !== undefined)
      result.endDate = date(row.endDate, `${field}[${index}].endDate`);
    if (
      result.startDate &&
      result.endDate &&
      result.startDate >= result.endDate
    )
      invalid(`${field}[${index}]`, "startDate must precede endDate");
    return result;
  });
}

function constraints(value: unknown): AutoPlanConstraints {
  const row = value === undefined ? {} : object(value, "constraints");
  const allowed = new Set([
    "unavailableWindows",
    "freeWeekdays",
    "minDaysOff",
    "earliestStart",
    "latestEnd",
    "protectedWindows",
    "maxCampusDays",
    "maxDailyClassMinutes",
    "minCredits",
    "maxCredits",
    "preferredWindows",
    "preferredInstructorNames",
  ]);
  for (const key of Object.keys(row))
    if (!allowed.has(key)) invalid(`constraints.${key}`, "is not allowed");
  const earliestStart =
    row.earliestStart === undefined
      ? undefined
      : clock(row.earliestStart, "constraints.earliestStart");
  const latestEnd =
    row.latestEnd === undefined
      ? undefined
      : clock(row.latestEnd, "constraints.latestEnd");
  if (earliestStart && latestEnd && earliestStart >= latestEnd)
    invalid("constraints", "earliestStart must precede latestEnd");
  const minCredits =
    row.minCredits === undefined
      ? undefined
      : finiteNumber(row.minCredits, "constraints.minCredits", 0, 60);
  const maxCredits =
    row.maxCredits === undefined
      ? undefined
      : finiteNumber(row.maxCredits, "constraints.maxCredits", 0, 60);
  if (
    minCredits !== undefined &&
    maxCredits !== undefined &&
    minCredits > maxCredits
  )
    invalid("constraints", "minCredits must not exceed maxCredits");
  const minDaysOff =
    row.minDaysOff === undefined
      ? undefined
      : finiteNumber(row.minDaysOff, "constraints.minDaysOff", 0, 5);
  const maxCampusDays =
    row.maxCampusDays === undefined
      ? undefined
      : finiteNumber(row.maxCampusDays, "constraints.maxCampusDays", 0, 7);
  const maxDailyClassMinutes =
    row.maxDailyClassMinutes === undefined
      ? undefined
      : finiteNumber(
          row.maxDailyClassMinutes,
          "constraints.maxDailyClassMinutes",
          0,
          1440,
        );
  if (minDaysOff !== undefined && !Number.isInteger(minDaysOff))
    invalid("constraints.minDaysOff", "must be an integer from 0 to 5");
  if (maxCampusDays !== undefined && !Number.isInteger(maxCampusDays))
    invalid("constraints.maxCampusDays", "must be an integer from 0 to 7");
  if (
    maxDailyClassMinutes !== undefined &&
    !Number.isInteger(maxDailyClassMinutes)
  )
    invalid(
      "constraints.maxDailyClassMinutes",
      "must be an integer from 0 to 1440",
    );
  return {
    unavailableWindows: normalizeAutoPlanWindows(
      row.unavailableWindows ?? [],
      "constraints.unavailableWindows",
    ),
    freeWeekdays:
      row.freeWeekdays === undefined
        ? []
        : weekdays(row.freeWeekdays, "constraints.freeWeekdays"),
    ...(minDaysOff === undefined ? {} : { minDaysOff }),
    ...(earliestStart === undefined ? {} : { earliestStart }),
    ...(latestEnd === undefined ? {} : { latestEnd }),
    protectedWindows: normalizeAutoPlanWindows(
      row.protectedWindows ?? [],
      "constraints.protectedWindows",
    ),
    ...(maxCampusDays === undefined ? {} : { maxCampusDays }),
    ...(maxDailyClassMinutes === undefined ? {} : { maxDailyClassMinutes }),
    ...(minCredits === undefined ? {} : { minCredits }),
    ...(maxCredits === undefined ? {} : { maxCredits }),
    preferredWindows: normalizeAutoPlanWindows(
      row.preferredWindows ?? [],
      "constraints.preferredWindows",
    ),
    preferredInstructorNames:
      row.preferredInstructorNames === undefined
        ? []
        : uniqueStrings(
            list(
              row.preferredInstructorNames,
              "constraints.preferredInstructorNames",
              20,
            ),
            "constraints.preferredInstructorNames",
            100,
          ),
  };
}

export function normalizeAutoPlanRequest(
  input: unknown,
): NormalizedAutoPlanRequest {
  const body = object(input, "body");
  for (const key of Object.keys(body))
    if (!ROOT_FIELDS.has(key)) invalid(key, "is not allowed");
  if (body.weights !== undefined)
    invalid("weights", "custom weights are deferred to Phase 08");
  if (body.fill !== undefined)
    invalid("fill", "gap filling is deferred to Phase 08");
  const mode = body.mode ?? "coverage_first";
  if (mode === "custom") invalid("mode", "custom mode is deferred to Phase 08");
  if (
    mode !== "coverage_first" &&
    mode !== "seat_safety" &&
    mode !== "balanced"
  )
    invalid("mode", "must be coverage_first, seat_safety, or balanced");
  const courseRows = list(body.courses ?? [], "courses", 20).map(
    (entry, index) => {
      const row = object(entry, `courses[${index}]`);
      const allowed = new Set([
        "courseCode",
        "academicCareer",
        "required",
        "priority",
        "lockedBundleId",
        "lockedSectionIds",
        "excludedSectionIds",
        "excludedInstructorNames",
      ]);
      for (const key of Object.keys(row))
        if (!allowed.has(key))
          invalid(`courses[${index}].${key}`, "is not allowed");
      const code = normalizeCourseCode(
        row.courseCode,
        `courses[${index}].courseCode`,
      );
      const career =
        row.academicCareer === undefined
          ? undefined
          : text(
              row.academicCareer,
              `courses[${index}].academicCareer`,
              32,
            ).toUpperCase();
      const required = row.required === undefined ? false : row.required;
      if (typeof required !== "boolean")
        invalid(`courses[${index}].required`, "must be boolean");
      const priority =
        row.priority === undefined
          ? 3
          : finiteNumber(row.priority, `courses[${index}].priority`, 1, 5);
      if (!Number.isInteger(priority))
        invalid(`courses[${index}].priority`, "must be an integer from 1 to 5");
      const lockedBundleId =
        row.lockedBundleId === undefined
          ? undefined
          : text(row.lockedBundleId, `courses[${index}].lockedBundleId`, 768);
      const lockedSectionIds =
        row.lockedSectionIds === undefined
          ? undefined
          : uniqueStrings(
              list(
                row.lockedSectionIds,
                `courses[${index}].lockedSectionIds`,
                20,
              ),
              `courses[${index}].lockedSectionIds`,
              768,
            );
      if (lockedBundleId !== undefined && lockedSectionIds !== undefined)
        invalid(
          `courses[${index}]`,
          "use lockedBundleId or lockedSectionIds, not both",
        );
      return {
        courseCode: code,
        ...(career === undefined ? {} : { academicCareer: career }),
        required,
        priority,
        ...(lockedBundleId === undefined ? {} : { lockedBundleId }),
        ...(lockedSectionIds === undefined ? {} : { lockedSectionIds }),
        excludedSectionIds: uniqueStrings(
          list(
            row.excludedSectionIds ?? [],
            `courses[${index}].excludedSectionIds`,
            30,
          ),
          `courses[${index}].excludedSectionIds`,
          768,
        ),
        excludedInstructorNames: uniqueStrings(
          list(
            row.excludedInstructorNames ?? [],
            `courses[${index}].excludedInstructorNames`,
            20,
          ),
          `courses[${index}].excludedInstructorNames`,
          100,
        ),
      };
    },
  );
  const seenCourses = new Set<string>();
  for (const row of courseRows)
    if (seenCourses.has(row.courseCode))
      invalid("courses", "normalized course codes must be unique");
    else seenCourses.add(row.courseCode);
  const groupRows = list(body.groups ?? [], "groups", 5).map((entry, index) => {
    const row = object(entry, `groups[${index}]`);
    for (const key of Object.keys(row))
      if (!["id", "courseCodes", "minCount", "maxCount"].includes(key))
        invalid(`groups[${index}].${key}`, "is not allowed");
    const id = text(row.id, `groups[${index}].id`, 40);
    const codes = uniqueStrings(
      list(row.courseCodes, `groups[${index}].courseCodes`, 20),
      `groups[${index}].courseCodes`,
      32,
    ).map((code) => normalizeCourseCode(code, `groups[${index}].courseCodes`));
    if (!codes.length)
      invalid(
        `groups[${index}].courseCodes`,
        "must contain at least one course",
      );
    if (new Set(codes).size !== codes.length)
      invalid(
        `groups[${index}].courseCodes`,
        "normalized course codes must not contain duplicates",
      );
    const minCount = finiteNumber(
      row.minCount,
      `groups[${index}].minCount`,
      0,
      20,
    );
    const maxCount = finiteNumber(
      row.maxCount,
      `groups[${index}].maxCount`,
      0,
      20,
    );
    if (
      !Number.isInteger(minCount) ||
      !Number.isInteger(maxCount) ||
      minCount > maxCount ||
      maxCount > codes.length
    )
      invalid(
        `groups[${index}]`,
        "must satisfy 0 <= minCount <= maxCount <= group size",
      );
    return { id, courseCodes: codes, minCount, maxCount };
  });
  const groupIds = new Set<string>();
  for (const group of groupRows) {
    if (groupIds.has(group.id)) invalid("groups", "group IDs must be unique");
    groupIds.add(group.id);
  }
  const memberships = new Set<string>();
  for (const group of groupRows)
    for (const code of group.courseCodes)
      if (memberships.has(code))
        invalid("groups", "a course may belong to only one group");
      else memberships.add(code);
  const resultLimit =
    body.resultLimit === undefined
      ? 5
      : finiteNumber(body.resultLimit, "resultLimit", 1, 10);
  const minDifferentBundles =
    body.minDifferentBundles === undefined
      ? 1
      : finiteNumber(body.minDifferentBundles, "minDifferentBundles", 1, 3);
  if (!Number.isInteger(resultLimit))
    invalid("resultLimit", "must be an integer");
  if (!Number.isInteger(minDifferentBundles))
    invalid("minDifferentBundles", "must be an integer");
  const request: NormalizedAutoPlanRequest = {
    courses: courseRows,
    groups: groupRows,
    includeCurrentSelected:
      body.includeCurrentSelected === undefined
        ? true
        : (body.includeCurrentSelected as boolean),
    constraints: constraints(body.constraints),
    mode,
    allowFullWaitlist:
      body.allowFullWaitlist === undefined
        ? false
        : (body.allowFullWaitlist as boolean),
    unknownQuotaPolicy:
      body.unknownQuotaPolicy === undefined
        ? "allow"
        : (body.unknownQuotaPolicy as "allow" | "exclude"),
    resultLimit,
    minDifferentBundles,
  };
  if (typeof request.includeCurrentSelected !== "boolean")
    invalid("includeCurrentSelected", "must be boolean");
  if (typeof request.allowFullWaitlist !== "boolean")
    invalid("allowFullWaitlist", "must be boolean");
  if (
    request.unknownQuotaPolicy !== "allow" &&
    request.unknownQuotaPolicy !== "exclude"
  )
    invalid("unknownQuotaPolicy", "must be allow or exclude");
  const bytes = Buffer.byteLength(JSON.stringify(request));
  if (bytes > 64_000) invalid("body", "normalized request is too large");
  return request;
}

export function validateAutoPlanGroups(request: NormalizedAutoPlanRequest) {
  const requested = new Set(request.courses.map((course) => course.courseCode));
  for (const group of request.groups) {
    for (const code of group.courseCodes) {
      if (!requested.has(code))
        throw new PlanError(
          "invalid_request",
          400,
          "Request validation failed",
          {
            [`groups.${group.id}.courseCodes`]:
              "must reference a requested course",
          },
        );
    }
  }
  return request;
}

export function autoPlanRequestHash(request: NormalizedAutoPlanRequest) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
