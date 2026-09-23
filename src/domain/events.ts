import { Temporal } from "@js-temporal/polyfill";
import type { WithId } from "mongodb";
import type { EventDocument } from "../plugins/init-mongo.js";

export class EventError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "EventError";
  }
}

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const CREATE_FIELDS = new Set([
  "title",
  "description",
  "location",
  "startsAt",
  "endsAt",
  "startDate",
  "endDate",
  "allDay",
  "timezone",
  "color",
  "recurrence",
  "sourceName",
  "externalId",
  "eventType",
  "blocksTime",
  "supersedesCalendarKey",
]);
const PATCH_FIELDS = new Set([
  "title",
  "description",
  "location",
  "startsAt",
  "endsAt",
  "startDate",
  "endDate",
  "allDay",
  "timezone",
  "color",
  "recurrence",
  "eventType",
  "blocksTime",
  "supersedesCalendarKey",
]);

function invalid(field: string, reason: string): never {
  throw new EventError("invalid_request", 400, "Request validation failed", {
    [field]: reason,
  });
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("body", "must be an object");
  }
  return value as Record<string, unknown>;
}

function checkFields(value: Record<string, unknown>, allowed: Set<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(key, "is not allowed");
  }
}

function text(
  value: unknown,
  field: string,
  max: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) invalid(field, "is required");
    return undefined;
  }
  if (typeof value !== "string") invalid(field, "must be a string");
  const result = value.trim();
  if ((required && !result) || result.length > max) {
    invalid(
      field,
      `must contain ${required ? "1.." : "at most "}${max} characters`,
    );
  }
  return result || undefined;
}

function date(value: unknown, field: string): Temporal.PlainDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return invalid(field, "must be a YYYY-MM-DD date");
  }
  try {
    const parsed = Temporal.PlainDate.from(value);
    if (parsed.toString() !== value) invalid(field, "is not a valid date");
    return parsed;
  } catch {
    return invalid(field, "is not a valid date");
  }
}

function instant(value: unknown, field: string): Temporal.Instant {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return invalid(field, "must be a UTC timestamp ending in Z");
  }
  try {
    return Temporal.Instant.from(value);
  } catch {
    return invalid(field, "is not a valid timestamp");
  }
}

function timezone(value: unknown, fallback: string): string {
  const zone = value === undefined ? fallback : value;
  if (typeof zone !== "string" || !zone.trim()) {
    return invalid("timezone", "must be an IANA timezone");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return invalid("timezone", "must be an IANA timezone");
  }
}

function recurrence(
  value: unknown,
  start: Temporal.PlainDate,
  maxSpanDays: number,
): EventDocument["recurrence"] {
  if (value === undefined || value === null) return undefined;
  const rule = object(value);
  if (
    Object.keys(rule).some(
      (key) => !["frequency", "interval", "weekdays", "until"].includes(key),
    ) ||
    rule.frequency !== "weekly" ||
    !Number.isInteger(rule.interval) ||
    typeof rule.interval !== "number" ||
    rule.interval < 1 ||
    rule.interval > 8 ||
    !Array.isArray(rule.weekdays) ||
    rule.weekdays.length < 1 ||
    rule.weekdays.length > 7 ||
    rule.weekdays.some((day) => !WEEKDAYS.includes(day)) ||
    new Set(rule.weekdays).size !== rule.weekdays.length
  ) {
    return invalid(
      "recurrence",
      "must be a weekly rule with unique weekdays and interval 1..8",
    );
  }
  const until = date(rule.until, "recurrence.until");
  const span = start.until(until).days;
  if (span < 0 || span > maxSpanDays) {
    return invalid(
      "recurrence.until",
      `must fall within ${maxSpanDays} days of the start`,
    );
  }
  return {
    frequency: "weekly",
    interval: rule.interval,
    weekdays: WEEKDAYS.filter((day) =>
      (rule.weekdays as string[]).includes(day),
    ),
    until: until.toString(),
  };
}

export function normalizeEvent(
  input: unknown,
  appTimezone: string,
  maxSpanDays: number,
): Omit<
  EventDocument,
  "ownerUsername" | "createdAt" | "updatedAt" | "revision"
> {
  const body = object(input);
  checkFields(body, CREATE_FIELDS);
  const title = text(body.title, "title", 200, true)!;
  const description = text(body.description, "description", 5000);
  const location = text(body.location, "location", 300);
  const sourceName = text(body.sourceName, "sourceName", 100);
  const externalId = text(body.externalId, "externalId", 128);
  if (body.externalId !== undefined && !externalId)
    invalid("externalId", "cannot be blank");
  if (
    externalId &&
    [...externalId].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    invalid("externalId", "must be printable");
  const zone = timezone(body.timezone, appTimezone);
  if (body.allDay !== undefined && typeof body.allDay !== "boolean")
    invalid("allDay", "must be boolean");
  const allDay = body.allDay === true;
  let startsAt: string;
  let endsAt: string;
  let startDate: string | undefined;
  let endDate: string | undefined;
  let localStart: Temporal.PlainDate;

  if (allDay) {
    if (body.startsAt !== undefined || body.endsAt !== undefined) {
      invalid("startsAt", "must be omitted for all-day events");
    }
    const start = date(body.startDate, "startDate");
    const end = date(body.endDate, "endDate");
    if (Temporal.PlainDate.compare(start, end) >= 0)
      invalid("endDate", "must be after startDate");
    startDate = start.toString();
    endDate = end.toString();
    startsAt = new Date(
      start.toZonedDateTime(zone).epochMilliseconds,
    ).toISOString();
    endsAt = new Date(
      end.toZonedDateTime(zone).epochMilliseconds,
    ).toISOString();
    localStart = start;
  } else {
    if (body.startDate !== undefined || body.endDate !== undefined) {
      invalid("startDate", "must be omitted for timed events");
    }
    const start = instant(body.startsAt, "startsAt");
    const end = instant(body.endsAt, "endsAt");
    if (Temporal.Instant.compare(start, end) >= 0)
      invalid("endsAt", "must be after startsAt");
    startsAt = new Date(start.epochMilliseconds).toISOString();
    endsAt = new Date(end.epochMilliseconds).toISOString();
    localStart = start.toZonedDateTimeISO(zone).toPlainDate();
  }

  const eventType = body.eventType === undefined ? "other" : body.eventType;
  if (
    !["class", "exam", "deadline", "reminder", "other"].includes(
      eventType as string,
    )
  ) {
    invalid("eventType", "is not supported");
  }
  const color = text(body.color, "color", 7);
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color))
    invalid("color", "must be a six-digit hex color");
  if (body.blocksTime !== undefined && typeof body.blocksTime !== "boolean")
    invalid("blocksTime", "must be boolean");
  const supersedesCalendarKey = text(
    body.supersedesCalendarKey,
    "supersedesCalendarKey",
    512,
  );
  if (
    body.supersedesCalendarKey !== undefined &&
    body.supersedesCalendarKey !== null &&
    !supersedesCalendarKey
  ) {
    invalid("supersedesCalendarKey", "cannot be blank");
  }
  const normalizedRecurrence = recurrence(
    body.recurrence,
    localStart,
    maxSpanDays,
  );

  return {
    title,
    ...(description === undefined ? {} : { description }),
    ...(location === undefined ? {} : { location }),
    startsAt,
    endsAt,
    ...(startDate === undefined ? {} : { startDate, endDate }),
    allDay,
    timezone: zone,
    ...(color === undefined ? {} : { color: color.toLowerCase() }),
    ...(normalizedRecurrence === undefined
      ? {}
      : { recurrence: normalizedRecurrence }),
    ...(sourceName === undefined ? {} : { sourceName }),
    ...(externalId === undefined ? {} : { externalId }),
    eventType: eventType as EventDocument["eventType"],
    blocksTime:
      body.blocksTime === undefined
        ? !allDay && !["deadline", "reminder"].includes(eventType as string)
        : body.blocksTime,
    source: "manual",
    readonly: false,
    ...(supersedesCalendarKey === undefined ? {} : { supersedesCalendarKey }),
  };
}

export function normalizePatch(
  current: EventDocument,
  input: unknown,
  appTimezone: string,
  maxSpanDays: number,
) {
  const patch = object(input);
  checkFields(patch, PATCH_FIELDS);
  if (Object.keys(patch).length === 0)
    invalid("body", "must contain at least one field");
  const merged: Record<string, unknown> = {
    title: current.title,
    description: current.description,
    location: current.location,
    startsAt: current.startsAt,
    endsAt: current.endsAt,
    startDate: current.startDate,
    endDate: current.endDate,
    allDay: current.allDay,
    timezone: current.timezone,
    color: current.color,
    recurrence: current.recurrence,
    sourceName: current.sourceName,
    externalId: current.externalId,
    eventType: current.eventType,
    blocksTime: current.blocksTime,
    supersedesCalendarKey: current.supersedesCalendarKey,
    ...patch,
  };
  if (patch.allDay === true && !current.allDay) {
    if (patch.startsAt === undefined) delete merged.startsAt;
    if (patch.endsAt === undefined) delete merged.endsAt;
  }
  if (patch.allDay === false && current.allDay) {
    if (patch.startDate === undefined) delete merged.startDate;
    if (patch.endDate === undefined) delete merged.endDate;
    if (patch.startsAt === undefined) delete merged.startsAt;
    if (patch.endsAt === undefined) delete merged.endsAt;
  }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return normalizeEvent(merged, appTimezone, maxSpanDays);
}

export function eventResponse(event: WithId<EventDocument>) {
  const {
    _id,
    ownerUsername: _owner,
    operationId: _operation,
    importId: _import,
    ...fields
  } = event;
  return { id: _id.toHexString(), ...fields };
}

export function sameCreateFields(
  current: EventDocument,
  normalized: ReturnType<typeof normalizeEvent>,
) {
  const comparable = ({
    title,
    description,
    location,
    startsAt,
    endsAt,
    startDate,
    endDate,
    allDay,
    timezone,
    color,
    recurrence,
    sourceName,
    externalId,
    eventType,
    blocksTime,
    supersedesCalendarKey,
  }: Partial<EventDocument>) =>
    JSON.stringify({
      title,
      description,
      location,
      startsAt,
      endsAt,
      startDate,
      endDate,
      allDay,
      timezone,
      color,
      recurrence,
      sourceName,
      externalId,
      eventType,
      blocksTime,
      supersedesCalendarKey,
    });
  return comparable(current) === comparable(normalized);
}
