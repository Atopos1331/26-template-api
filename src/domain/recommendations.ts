import {
  type AutoPlanWindow,
  normalizeAutoPlanWindows,
  normalizeCourseCode,
  type Weekday,
} from "./auto-plan.js";
import { PlanError } from "./plans.js";

const VALID_WEEKDAYS = new Set<Weekday>([
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
]);

export type RecommendationRequest = {
  targetCourseId: string;
  excludedCourseIds: string[];
  minCredits?: number;
  maxCredits?: number;
  unavailableWindows: AutoPlanWindow[];
  preferredWindows: AutoPlanWindow[];
  avoidWeekdays: Weekday[];
  allowWaitlist: boolean;
  maxRecommendations: number;
};

function invalid(field: string, reason: string): never {
  throw new PlanError("invalid_request", 400, "Request validation failed", {
    [field]: reason,
  });
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid("body", "must be an object");
  return value as Record<string, unknown>;
}

export function normalizeRecommendationRequest(
  input: unknown,
): RecommendationRequest {
  const body = object(input);
  const allowed = new Set([
    "targetCourseId",
    "excludedCourseIds",
    "minCredits",
    "maxCredits",
    "unavailableWindows",
    "preferredWindows",
    "avoidWeekdays",
    "allowWaitlist",
    "maxRecommendations",
  ]);
  for (const key of Object.keys(body))
    if (!allowed.has(key)) invalid(key, "is not allowed");
  if (typeof body.targetCourseId !== "string" || !body.targetCourseId.trim())
    invalid("targetCourseId", "is required");
  const minCredits =
    body.minCredits === undefined ? undefined : body.minCredits;
  const maxCredits =
    body.maxCredits === undefined ? undefined : body.maxCredits;
  for (const [field, value] of [
    ["minCredits", minCredits],
    ["maxCredits", maxCredits],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 60)
    )
      invalid(field, "must be a finite number from 0 to 60");
  }
  if (
    minCredits !== undefined &&
    maxCredits !== undefined &&
    (minCredits as number) > (maxCredits as number)
  )
    invalid("body", "minCredits must not exceed maxCredits");
  const array = (value: unknown, field: string, max: number) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max)
      invalid(field, `must contain at most ${max} items`);
    return value;
  };
  const normalizeWindows = (value: unknown, field: string) => {
    const rows = array(value, field, 20);
    return normalizeAutoPlanWindows(rows, field);
  };
  const weekdays = array(body.avoidWeekdays, "avoidWeekdays", 7);
  if (
    weekdays.some(
      (day) => typeof day !== "string" || !VALID_WEEKDAYS.has(day as Weekday),
    ) ||
    new Set(weekdays).size !== weekdays.length
  )
    invalid("avoidWeekdays", "must contain unique weekday codes");
  const allowWaitlist =
    body.allowWaitlist === undefined ? false : body.allowWaitlist;
  if (typeof allowWaitlist !== "boolean")
    invalid("allowWaitlist", "must be boolean");
  const maxRecommendations =
    body.maxRecommendations === undefined ? 20 : body.maxRecommendations;
  if (
    typeof maxRecommendations !== "number" ||
    !Number.isInteger(maxRecommendations) ||
    maxRecommendations < 1 ||
    maxRecommendations > 50
  )
    invalid("maxRecommendations", "must be an integer from 1 to 50");
  const excluded = array(body.excludedCourseIds, "excludedCourseIds", 50);
  if (
    excluded.some(
      (id) => typeof id !== "string" || !(id as string).trim().length,
    )
  )
    invalid("excludedCourseIds", "must contain non-empty strings");
  const excludedCourseIds = excluded.map((id) => (id as string).trim());
  if (new Set(excludedCourseIds).size !== excludedCourseIds.length)
    invalid("excludedCourseIds", "must contain unique course codes");
  return {
    targetCourseId: normalizeCourseCode(body.targetCourseId, "targetCourseId"),
    excludedCourseIds,
    ...(minCredits === undefined ? {} : { minCredits: minCredits as number }),
    ...(maxCredits === undefined ? {} : { maxCredits: maxCredits as number }),
    unavailableWindows: normalizeWindows(
      body.unavailableWindows,
      "unavailableWindows",
    ),
    preferredWindows: normalizeWindows(
      body.preferredWindows,
      "preferredWindows",
    ),
    avoidWeekdays: weekdays as Weekday[],
    allowWaitlist,
    maxRecommendations,
  };
}
