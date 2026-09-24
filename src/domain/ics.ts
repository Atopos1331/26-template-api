import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import ICAL from "ical.js";
import { EventError } from "./events.js";

export type IcsImportOptions = {
  timezone: string;
  from: string;
  to: string;
  defaultBlocksTime: boolean;
  maxOccurrences: number;
};

export type ParsedIcsEvent = {
  uid: string;
  identityQuality?: "derived_identity";
  recurrenceId?: string;
  title: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  startDate?: string;
  endDate?: string;
  allDay: boolean;
  timezone: string;
  recurrence?: {
    frequency: "weekly";
    interval: number;
    weekdays: string[];
    until: string;
  };
  status?: "CANCELLED";
  blocksTime: boolean;
};

export type IcsParseResult = {
  events: ParsedIcsEvent[];
  rejected: Array<{ reason: string; count: number }>;
};

const weekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

function reject(reason: string): never {
  throw new EventError("invalid_request", 400, "Invalid ICS payload", {
    ics: reason,
  });
}

function checkedZone(value: string, field: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    reject(`${field}: unknown timezone`);
  }
}

function fixedVtimezoneOffset(component: ICAL.Component) {
  const offsets = component
    .getAllSubcomponents()
    .filter((item) => item.name === "standard" || item.name === "daylight")
    .map((item) => item.getFirstPropertyValue("tzoffsetto"))
    .filter((value): value is ICAL.UtcOffset => value instanceof ICAL.UtcOffset)
    .map((value) => value.toSeconds());
  if (!offsets.length || new Set(offsets).size !== 1) return undefined;
  const seconds = offsets[0]!;
  const sign = seconds < 0 ? "-" : "+";
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / 3_600);
  const minutes = Math.floor((absolute % 3_600) / 60);
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function zoneFor(root: ICAL.Component, tzid: string) {
  try {
    return checkedZone(tzid, "TZID");
  } catch {
    const match = root
      .getAllSubcomponents("vtimezone")
      .find((component) => text(component, "tzid") === tzid);
    const location = match
      ? (text(match, "x-lic-location") ?? text(match, "location"))
      : undefined;
    if (location) return checkedZone(location, "VTIMEZONE");
    const fixedOffset = match && fixedVtimezoneOffset(match);
    if (fixedOffset) return fixedOffset;
    reject("TZID: unknown timezone");
  }
}

function timeValue(
  property: ICAL.Property,
  fallbackZone: string,
  root: ICAL.Component,
): {
  instant: Temporal.Instant;
  dateOnly: boolean;
  zone: string;
  local: string;
} {
  const value = property.getFirstValue();
  if (!(value instanceof ICAL.Time)) reject("invalid date value");
  const dateOnly = value.isDate;
  const raw = value.toString();
  if (dateOnly) {
    return {
      instant: Temporal.PlainDate.from(raw)
        .toZonedDateTime(fallbackZone)
        .toInstant(),
      dateOnly: true,
      zone: fallbackZone,
      local: raw,
    };
  }
  const explicit = property.getFirstParameter("tzid");
  if (raw.endsWith("Z")) {
    const instant = Temporal.Instant.from(raw);
    return { instant, dateOnly: false, zone: "UTC", local: instant.toString() };
  }
  const zone =
    typeof explicit === "string" && explicit
      ? zoneFor(root, explicit)
      : checkedZone(fallbackZone, "TZID");
  const local = Temporal.PlainDateTime.from(raw);
  return {
    instant: local
      .toZonedDateTime(zone, { disambiguation: "reject" })
      .toInstant(),
    dateOnly: false,
    zone,
    local: raw,
  };
}

function text(component: ICAL.Component, name: string) {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" ? value : undefined;
}

function instantIso(value: Temporal.Instant) {
  return new Date(value.epochMilliseconds).toISOString();
}

function recurrence(component: ICAL.Component, zone: string) {
  const property = component.getFirstProperty("rrule");
  if (!property) return undefined;
  const rule = property.getFirstValue();
  if (!(rule instanceof ICAL.Recur) || rule.freq !== "WEEKLY")
    reject("unsupported recurrence rule");
  const keys = Object.keys(rule.parts);
  if (keys.some((key) => key !== "BYDAY"))
    reject("unsupported recurrence rule");
  const byday = rule.parts.BYDAY ?? [];
  if (!byday.length || byday.some((day) => !weekdays.includes(day as never)))
    reject("weekly recurrence requires BYDAY");
  if (
    !Number.isInteger(rule.interval) ||
    rule.interval < 1 ||
    rule.interval > 8
  )
    reject("weekly recurrence interval must be 1..8");
  if (rule.count !== null || !rule.until)
    reject("weekly recurrence requires UNTIL");
  const until = rule.until;
  const untilDate = until.isDate
    ? until.toString()
    : (until.toString().endsWith("Z")
        ? Temporal.Instant.from(until.toString()).toZonedDateTimeISO(zone)
        : Temporal.PlainDateTime.from(until.toString()).toZonedDateTime(zone, {
            disambiguation: "reject",
          })
      )
        .toPlainDate()
        .toString();
  return {
    frequency: "weekly" as const,
    interval: rule.interval,
    weekdays: weekdays.filter((day) => byday.includes(day)),
    until: untilDate,
  };
}

function normalizeEvent(
  component: ICAL.Component,
  root: ICAL.Component,
  options: IcsImportOptions,
): ParsedIcsEvent {
  const uidValue = text(component, "uid");
  const recurrenceIdProp = component.getFirstProperty("recurrence-id");
  const cancelled = text(component, "status")?.toUpperCase() === "CANCELLED";
  if (!component.hasProperty("dtstart") && recurrenceIdProp && cancelled) {
    const recurrenceId = timeValue(recurrenceIdProp, options.timezone, root);
    const end = recurrenceId.dateOnly
      ? Temporal.PlainDate.from(recurrenceId.local)
          .add({ days: 1 })
          .toZonedDateTime(recurrenceId.zone)
          .toInstant()
      : recurrenceId.instant.add({ seconds: 1 });
    if (!uidValue?.trim()) reject("exception_without_uid");
    return {
      uid: uidValue.trim(),
      recurrenceId: instantIso(recurrenceId.instant),
      title: text(component, "summary") ?? "(untitled)",
      ...(text(component, "description")
        ? { description: text(component, "description") }
        : {}),
      ...(text(component, "location")
        ? { location: text(component, "location") }
        : {}),
      startsAt: instantIso(recurrenceId.instant),
      endsAt: instantIso(end),
      ...(recurrenceId.dateOnly
        ? {
            startDate: recurrenceId.local,
            endDate: Temporal.PlainDate.from(recurrenceId.local)
              .add({ days: 1 })
              .toString(),
          }
        : {}),
      allDay: recurrenceId.dateOnly,
      timezone: recurrenceId.zone,
      status: "CANCELLED",
      blocksTime: false,
    };
  }
  const startProp = component.getFirstProperty("dtstart");
  if (!startProp) reject("DTSTART is required");
  const configuredRootZone = text(root, "x-wr-timezone");
  const rootZone =
    configuredRootZone && isKnownZone(configuredRootZone)
      ? configuredRootZone
      : options.timezone;
  const start = timeValue(
    startProp,
    checkedZone(rootZone, "X-WR-TIMEZONE"),
    root,
  );
  const endProp = component.getFirstProperty("dtend");
  const durationProp = component.getFirstProperty("duration");
  if (
    !endProp &&
    !durationProp &&
    !start.dateOnly &&
    !(cancelled && recurrenceIdProp)
  )
    reject("timed event requires DTEND or DURATION");
  let end = start.instant;
  let endDate: string | undefined;
  if (endProp) {
    const parsedEnd = timeValue(endProp, start.zone, root);
    if (parsedEnd.dateOnly !== start.dateOnly)
      reject("DTSTART and DTEND types must match");
    end = parsedEnd.instant;
    endDate = parsedEnd.dateOnly ? parsedEnd.local : undefined;
  } else if (durationProp) {
    const duration = durationProp.getFirstValue();
    if (!(duration instanceof ICAL.Duration)) reject("invalid DURATION");
    const seconds = duration.toSeconds();
    if (start.dateOnly) {
      if (seconds <= 0 || seconds % 86_400 !== 0)
        reject("all-day DURATION must be a positive whole number of days");
      const durationEnd = Temporal.PlainDate.from(start.local).add({
        days: seconds / 86_400,
      });
      end = durationEnd.toZonedDateTime(start.zone).toInstant();
      endDate = durationEnd.toString();
    } else {
      end = start.instant.add({ seconds });
    }
  } else if (cancelled && recurrenceIdProp) {
    end = start.instant.add({ seconds: 1 });
  } else {
    const nextDay = Temporal.PlainDate.from(start.local).add({ days: 1 });
    end = nextDay.toZonedDateTime(start.zone).toInstant();
    endDate = nextDay.toString();
  }
  if (Temporal.Instant.compare(start.instant, end) >= 0)
    reject("event end must follow start");
  const recurrenceValue = recurrence(component, start.zone);
  const recurrenceIdValue = recurrenceIdProp
    ? timeValue(recurrenceIdProp, start.zone, root)
    : undefined;
  if (recurrenceIdValue && recurrenceIdValue.dateOnly !== start.dateOnly)
    reject("DTSTART and RECURRENCE-ID types must match");
  const recurrenceId = recurrenceIdValue
    ? instantIso(recurrenceIdValue.instant)
    : undefined;
  const summary = text(component, "summary") ?? "(untitled)";
  const status = cancelled ? ("CANCELLED" as const) : undefined;
  const uid =
    uidValue?.trim() ||
    createHash("sha256")
      .update(
        JSON.stringify([
          summary,
          start.instant.toString(),
          end.toString(),
          text(component, "location") ?? null,
        ]),
      )
      .digest("hex");
  return {
    uid,
    ...(uidValue ? {} : { identityQuality: "derived_identity" as const }),
    ...(recurrenceId ? { recurrenceId } : {}),
    title: summary,
    ...(text(component, "description")
      ? { description: text(component, "description") }
      : {}),
    ...(text(component, "location")
      ? { location: text(component, "location") }
      : {}),
    startsAt: instantIso(start.instant),
    endsAt: instantIso(end),
    ...(start.dateOnly ? { startDate: start.local, endDate } : {}),
    allDay: start.dateOnly,
    timezone: start.zone,
    ...(recurrenceValue ? { recurrence: recurrenceValue } : {}),
    ...(status ? { status } : {}),
    blocksTime: start.dateOnly ? false : options.defaultBlocksTime,
  };
}

function isKnownZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function parseIcs(
  input: string,
  options: IcsImportOptions,
): IcsParseResult {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(input));
  } catch {
    reject("malformed VCALENDAR");
  }
  if (root.name !== "vcalendar" || !root.getFirstPropertyValue("version"))
    reject("VCALENDAR is required");
  const components = root.getAllSubcomponents("vevent");
  if (!components.length) reject("at least one VEVENT is required");
  const groups = new Map<string, ICAL.Component[]>();
  const uidlessExceptions = new Set<ICAL.Component>();
  for (const component of components) {
    const rawUid = text(component, "uid");
    if (!rawUid?.trim() && component.hasProperty("recurrence-id")) {
      uidlessExceptions.add(component);
      continue;
    }
    let key = rawUid?.trim();
    if (!key) {
      try {
        key = `derived:${normalizeEvent(component, root, options).uid}`;
      } catch {
        key = `invalid:${groups.size}:${component.getFirstPropertyValue("dtstart")?.toString() ?? ""}`;
      }
    }
    const group = groups.get(key) ?? [];
    group.push(component);
    groups.set(key, group);
  }
  const events: ParsedIcsEvent[] = [];
  const rejected: Array<{ reason: string; count: number }> = [];
  if (uidlessExceptions.size)
    rejected.push({
      reason: "exception_without_uid",
      count: uidlessExceptions.size,
    });
  for (const group of groups.values()) {
    const masters = group.filter((item) => !item.hasProperty("recurrence-id"));
    const exceptions = group.filter((item) =>
      item.hasProperty("recurrence-id"),
    );
    if (masters.length > 1 && !rawUidForGroup(group)) {
      try {
        const normalized = group.map((component) =>
          normalizeEvent(component, root, options),
        );
        const [first, ...duplicates] = normalized;
        if (
          first &&
          duplicates.every(
            (item) => JSON.stringify(item) === JSON.stringify(first),
          )
        ) {
          events.push(first);
          rejected.push({
            reason: "duplicate_identical",
            count: duplicates.length,
          });
          continue;
        }
      } catch {
        // The normal group validation below reports the stable rejection.
      }
    }
    if (exceptions.length && !masters.length) {
      rejected.push({
        reason: "exception_without_master",
        count: group.length,
      });
      continue;
    }
    if (masters.length !== 1 && (masters.length > 0 || exceptions.length > 0)) {
      rejected.push({
        reason: "duplicate_master_or_exception",
        count: group.length,
      });
      continue;
    }
    try {
      const normalized = group.map((component) =>
        normalizeEvent(component, root, options),
      );
      const identities = new Set(
        normalized.map((item) => item.recurrenceId ?? "master"),
      );
      if (identities.size !== normalized.length) {
        rejected.push({
          reason: "duplicate_master_or_exception",
          count: group.length,
        });
        continue;
      }
      events.push(...normalized);
    } catch (error) {
      const reason =
        error instanceof EventError
          ? (error.fields?.ics ?? "invalid_event")
          : "invalid_event";
      rejected.push({ reason, count: group.length });
    }
  }
  let generated = 0;
  for (const event of events) {
    if (event.recurrenceId) continue;
    if (!event.recurrence) {
      if (event.endsAt > options.from && event.startsAt < options.to)
        generated += 1;
      continue;
    }
    const start = event.allDay
      ? Temporal.PlainDate.from(event.startDate!)
      : Temporal.Instant.from(event.startsAt)
          .toZonedDateTimeISO(event.timezone)
          .toPlainDate();
    const until = Temporal.PlainDate.from(event.recurrence.until);
    const from = Temporal.Instant.from(options.from)
      .toZonedDateTimeISO(event.timezone)
      .toPlainDate();
    const to = Temporal.Instant.from(options.to)
      .toZonedDateTimeISO(event.timezone)
      .toPlainDate();
    const monday = start.subtract({ days: start.dayOfWeek - 1 });
    const firstWeek = Math.max(0, Math.floor(monday.until(from).days / 7));
    const firstCycle =
      Math.floor(firstWeek / event.recurrence.interval) *
      event.recurrence.interval;
    const firstDay = monday.add({ days: firstCycle * 7 });
    for (
      let day =
        Temporal.PlainDate.compare(firstDay, start) < 0 ? start : firstDay;
      Temporal.PlainDate.compare(day, until) <= 0;
      day = day.add({ days: 1 })
    ) {
      if (Temporal.PlainDate.compare(day, to) >= 0) break;
      const week = Math.floor(monday.until(day).days / 7);
      if (
        week % event.recurrence.interval === 0 &&
        event.recurrence.weekdays.includes(weekdays[day.dayOfWeek - 1]!) &&
        Temporal.PlainDate.compare(day, from) >= 0 &&
        Temporal.PlainDate.compare(day, to) < 0
      )
        generated += 1;
      if (generated > options.maxOccurrences) reject("max_occurrences");
    }
  }
  return { events, rejected };
}

function rawUidForGroup(group: ICAL.Component[]) {
  return text(group[0]!, "uid")?.trim();
}
