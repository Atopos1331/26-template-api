import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { WithId } from "mongodb";
import type { EventDocument } from "../plugins/init-mongo.js";
import { EventError } from "./events.js";

export type CalendarWindow = { from: string; to: string };

export type CalendarOccurrence = {
  calendarKey: string;
  source: string;
  sourceId: string;
  title: string;
  description?: string;
  location?: string;
  eventType?: EventDocument["eventType"];
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  localEndsAt: string;
  startDate?: string;
  endDate?: string;
  allDay: boolean;
  timezone: string;
  blocksTime: boolean;
  readonly: boolean;
  supersedesCalendarKey?: string;
  termCode?: string;
};

export type CalendarConflict = {
  firstCalendarKey: string;
  secondCalendarKey: string;
  severity: "blocking" | "informational";
  kind: "time_overlap" | "day_overlap";
  localDate: string;
  startTime: string | null;
  endTime: string | null;
  startsAt: string | null;
  endsAt: string | null;
};

function invalid(field: string, reason: string): never {
  throw new EventError("invalid_request", 400, "Request validation failed", {
    [field]: reason,
  });
}

function boundary(
  value: unknown,
  timezone: string,
  field: string,
): Temporal.Instant {
  if (typeof value !== "string")
    invalid(field, "must be a date or UTC timestamp");
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const day = Temporal.PlainDate.from(value);
      if (day.toString() !== value) invalid(field, "is not a valid date");
      return day.toZonedDateTime(timezone).toInstant();
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
      return Temporal.Instant.from(value);
    }
  } catch {
    invalid(field, "is not a valid date or timestamp");
  }
  return invalid(
    field,
    "must be a YYYY-MM-DD date or UTC timestamp ending in Z",
  );
}

export function calendarWindow(
  from: unknown,
  to: unknown,
  timezone: string,
  maxDays: number,
  now: Temporal.Instant = Temporal.Now.instant(),
): CalendarWindow {
  if ((from === undefined) !== (to === undefined)) {
    invalid("window", "from and to must be supplied together");
  }
  const localNow = now.toZonedDateTimeISO(timezone);
  const start =
    from === undefined
      ? localNow.toPlainDate().toZonedDateTime(timezone).toInstant()
      : boundary(from, timezone, "from");
  const end =
    to === undefined
      ? localNow
          .toPlainDate()
          .with({ day: 1 })
          .add({ months: 1 })
          .toZonedDateTime(timezone)
          .toInstant()
      : boundary(to, timezone, "to");
  if (Temporal.Instant.compare(start, end) >= 0)
    invalid("to", "must be after from");
  const maximum = start
    .toZonedDateTimeISO(timezone)
    .add({ days: maxDays })
    .toInstant();
  if (Temporal.Instant.compare(end, maximum) > 0)
    invalid("to", `window cannot exceed ${maxDays} local days`);
  return {
    from: new Date(start.epochMilliseconds).toISOString(),
    to: new Date(end.epochMilliseconds).toISOString(),
  };
}

export function optionalCalendarWindow(
  from: unknown,
  to: unknown,
  timezone: string,
  maxDays: number,
): CalendarWindow | undefined {
  return from === undefined && to === undefined
    ? undefined
    : calendarWindow(from, to, timezone, maxDays);
}

function overlaps(start: string, end: string, window: CalendarWindow) {
  return start < window.to && end > window.from;
}

export function calendarKey(
  source: string,
  sourceId: string,
  start: string,
  end: string,
) {
  const digest = createHash("sha256")
    .update(JSON.stringify([source, sourceId, start, end]))
    .digest("base64url");
  return `${source}:${digest}`;
}

function manualOccurrence(
  event: WithId<EventDocument>,
  start: string,
  end: string,
  startDate?: string,
  endDate?: string,
): CalendarOccurrence {
  const sourceId = event._id.toHexString();
  const localStart = Temporal.Instant.from(start).toZonedDateTimeISO(
    event.timezone,
  );
  const localEnd = Temporal.Instant.from(end).toZonedDateTimeISO(
    event.timezone,
  );
  return {
    calendarKey: calendarKey("manual", sourceId, start, end),
    source: "manual",
    sourceId,
    title: event.title,
    ...(event.description === undefined
      ? {}
      : { description: event.description }),
    ...(event.location === undefined ? {} : { location: event.location }),
    ...(event.eventType === undefined ? {} : { eventType: event.eventType }),
    startsAt: start,
    endsAt: end,
    localStartsAt: localStart.toString(),
    localEndsAt: localEnd.toString(),
    ...(startDate === undefined ? {} : { startDate, endDate }),
    allDay: event.allDay,
    timezone: event.timezone,
    blocksTime: event.blocksTime,
    readonly: event.readonly,
    ...(event.supersedesCalendarKey === undefined
      ? {}
      : { supersedesCalendarKey: event.supersedesCalendarKey }),
  };
}

export function* manualOccurrences(
  event: WithId<EventDocument>,
  window: CalendarWindow,
): Generator<CalendarOccurrence> {
  if (event.source !== "manual" || event.recurrenceStatus === "cancelled")
    return;
  if (!event.recurrence) {
    if (overlaps(event.startsAt, event.endsAt, window)) {
      yield manualOccurrence(
        event,
        event.startsAt,
        event.endsAt,
        event.startDate,
        event.endDate,
      );
    }
    return;
  }

  const original = event.allDay
    ? Temporal.PlainDate.from(event.startDate!)
    : Temporal.Instant.from(event.startsAt)
        .toZonedDateTimeISO(event.timezone)
        .toPlainDate();
  const until = Temporal.PlainDate.from(event.recurrence.until);
  const monday = original.subtract({ days: original.dayOfWeek - 1 });
  const duration =
    Temporal.Instant.from(event.endsAt).epochMilliseconds -
    Temporal.Instant.from(event.startsAt).epochMilliseconds;
  const daySpan = event.allDay
    ? original.until(Temporal.PlainDate.from(event.endDate!)).days
    : 0;
  const localTime = event.allDay
    ? undefined
    : Temporal.Instant.from(event.startsAt)
        .toZonedDateTimeISO(event.timezone)
        .toPlainTime();

  for (
    let day = original;
    Temporal.PlainDate.compare(day, until) <= 0;
    day = day.add({ days: 1 })
  ) {
    const week = Math.floor(monday.until(day).days / 7);
    const weekday = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][
      day.dayOfWeek - 1
    ];
    if (
      week % event.recurrence.interval !== 0 ||
      !weekday ||
      !event.recurrence.weekdays.includes(weekday)
    )
      continue;

    let start: string;
    let end: string;
    let startDate: string | undefined;
    let endDate: string | undefined;
    if (event.allDay) {
      const lastDay = day.add({ days: daySpan });
      start = new Date(
        day.toZonedDateTime(event.timezone).epochMilliseconds,
      ).toISOString();
      end = new Date(
        lastDay.toZonedDateTime(event.timezone).epochMilliseconds,
      ).toISOString();
      startDate = day.toString();
      endDate = lastDay.toString();
    } else {
      const wanted = day.toPlainDateTime(localTime!);
      const zoned = wanted.toZonedDateTime(event.timezone, {
        disambiguation: "earlier",
      });
      if (!zoned.toPlainDateTime().equals(wanted)) continue;
      start = new Date(zoned.epochMilliseconds).toISOString();
      end = new Date(zoned.epochMilliseconds + duration).toISOString();
    }
    if (overlaps(start, end, window))
      yield manualOccurrence(event, start, end, startDate, endDate);
  }
}

export function expandManualEvent(
  event: WithId<EventDocument>,
  window: CalendarWindow,
  maxItems: number,
) {
  const items: CalendarOccurrence[] = [];
  for (const item of manualOccurrences(event, window)) {
    if (items.length === maxItems)
      throw new EventError(
        "calendar_window_too_dense",
        400,
        "Choose a narrower calendar window",
      );
    items.push(item);
  }
  return items;
}

export function eventOverlapsWindow(
  event: WithId<EventDocument>,
  window: CalendarWindow,
) {
  if (event.source !== "manual")
    return !event.recurrence && overlaps(event.startsAt, event.endsAt, window);
  return !manualOccurrences(event, window).next().done;
}

function localSortStart(item: CalendarOccurrence, timezone: string) {
  return item.allDay && item.startDate
    ? `${item.startDate}T00:00:00.000`
    : Temporal.Instant.from(item.startsAt)
        .toZonedDateTimeISO(timezone)
        .toPlainDateTime()
        .toString({ smallestUnit: "millisecond" });
}

export function sortOccurrences(items: CalendarOccurrence[], timezone: string) {
  return items.sort(
    (a, b) =>
      localSortStart(a, timezone).localeCompare(localSortStart(b, timezone)) ||
      a.calendarKey.localeCompare(b.calendarKey),
  );
}

function datesForConflict(item: CalendarOccurrence, timezone: string) {
  if (item.allDay) return { start: item.startDate!, end: item.endDate! };
  const start = Temporal.Instant.from(item.startsAt).toZonedDateTimeISO(
    timezone,
  );
  const end = Temporal.Instant.from(item.endsAt).toZonedDateTimeISO(timezone);
  const endDate = end.toPlainTime().equals(Temporal.PlainTime.from("00:00"))
    ? end.toPlainDate()
    : end.toPlainDate().add({ days: 1 });
  return { start: start.toPlainDate().toString(), end: endDate.toString() };
}

export function detectConflicts(
  items: CalendarOccurrence[],
  timezone: string,
  maxConflicts: number,
) {
  const blocking: CalendarConflict[] = [];
  const informational: CalendarConflict[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const first = items[i]!;
      const second = items[j]!;
      let conflict: CalendarConflict | undefined;
      const keys = [first.calendarKey, second.calendarKey].sort();
      if (first.allDay || second.allDay) {
        const a = datesForConflict(first, timezone);
        const b = datesForConflict(second, timezone);
        const date = a.start > b.start ? a.start : b.start;
        if (date < a.end && date < b.end) {
          conflict = {
            firstCalendarKey: keys[0]!,
            secondCalendarKey: keys[1]!,
            severity:
              first.blocksTime && second.blocksTime
                ? "blocking"
                : "informational",
            kind: "day_overlap",
            localDate: date,
            startTime: null,
            endTime: null,
            startsAt: null,
            endsAt: null,
          };
        }
      } else {
        const start =
          first.startsAt > second.startsAt ? first.startsAt : second.startsAt;
        const end = first.endsAt < second.endsAt ? first.endsAt : second.endsAt;
        if (start < end) {
          const localStart =
            Temporal.Instant.from(start).toZonedDateTimeISO(timezone);
          const localEnd =
            Temporal.Instant.from(end).toZonedDateTimeISO(timezone);
          conflict = {
            firstCalendarKey: keys[0]!,
            secondCalendarKey: keys[1]!,
            severity:
              first.blocksTime && second.blocksTime
                ? "blocking"
                : "informational",
            kind: "time_overlap",
            localDate: localStart.toPlainDate().toString(),
            startTime: localStart
              .toPlainTime()
              .toString({ smallestUnit: "minute" }),
            endTime: localEnd
              .toPlainTime()
              .toString({ smallestUnit: "minute" }),
            startsAt: start,
            endsAt: end,
          };
        }
      }
      if (!conflict) continue;
      const result =
        conflict.severity === "blocking" ? blocking : informational;
      result.push(conflict);
      if (blocking.length + informational.length > maxConflicts) {
        throw new EventError(
          "calendar_window_too_dense",
          400,
          "Choose a narrower calendar window",
        );
      }
    }
  }
  const order = (a: CalendarConflict, b: CalendarConflict) =>
    a.localDate.localeCompare(b.localDate) ||
    (a.startTime ?? "").localeCompare(b.startTime ?? "") ||
    a.firstCalendarKey.localeCompare(b.firstCalendarKey) ||
    a.secondCalendarKey.localeCompare(b.secondCalendarKey);
  return {
    blocking: blocking.sort(order),
    informational: informational.sort(order),
  };
}

export function timeBanner(
  items: CalendarOccurrence[],
  now: Temporal.Instant,
  upcomingHours: number,
) {
  const timestamp = now.epochMilliseconds;
  const horizon = timestamp + upcomingHours * 3_600_000;
  const priority = (item: CalendarOccurrence) =>
    item.source === "manual" ? 0 : item.source === "course" ? 1 : 2;
  const compare = (a: CalendarOccurrence, b: CalendarOccurrence) =>
    priority(a) - priority(b) ||
    a.startsAt.localeCompare(b.startsAt) ||
    a.calendarKey.localeCompare(b.calendarKey);
  const candidates = items.filter((item) => !item.allDay && item.blocksTime);
  const current = candidates
    .filter(
      (item) =>
        Date.parse(item.startsAt) <= timestamp &&
        Date.parse(item.endsAt) > timestamp,
    )
    .sort(compare)[0];
  if (current)
    return {
      state: "current" as const,
      item: current,
      minutesRemaining: Math.ceil(
        (Date.parse(current.endsAt) - timestamp) / 60_000,
      ),
      minutesUntilStart: null,
    };
  const upcoming = candidates
    .filter(
      (item) =>
        Date.parse(item.startsAt) > timestamp &&
        Date.parse(item.startsAt) <= horizon,
    )
    .sort(
      (a, b) =>
        a.startsAt.localeCompare(b.startsAt) ||
        priority(a) - priority(b) ||
        a.calendarKey.localeCompare(b.calendarKey),
    )[0];
  if (upcoming)
    return {
      state: "upcoming" as const,
      item: upcoming,
      minutesRemaining: null,
      minutesUntilStart: Math.ceil(
        (Date.parse(upcoming.startsAt) - timestamp) / 60_000,
      ),
    };
  return {
    state: "free" as const,
    item: null,
    minutesRemaining: null,
    minutesUntilStart: null,
  };
}
