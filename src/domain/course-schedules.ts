import { Temporal } from "@js-temporal/polyfill";
import {
  type CalendarOccurrence,
  type CalendarWindow,
  calendarKey,
} from "./calendar.js";

export type CourseMeeting = {
  startDate?: string | null;
  endDate?: string | null;
  weekdays?: string[];
  startTime?: string | null;
  endTime?: string | null;
  timezone?: string | null;
  facilityId?: string | null;
  venue?: string | null;
};

export type CourseBundleForSchedule = {
  bundleId: string;
  courseCode: string;
  sectionLabels: string[];
  meetings: CourseMeeting[];
  termCode?: string;
};

const DAY_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

function date(value: string | null | undefined): Temporal.PlainDate | null {
  if (!value) return null;
  try {
    return Temporal.PlainDate.from(value);
  } catch {
    return null;
  }
}

function time(value: string | null | undefined): Temporal.PlainTime | null {
  if (!value || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  try {
    return Temporal.PlainTime.from(value.length === 5 ? `${value}:00` : value);
  } catch {
    return null;
  }
}

export function hasUnknownMeetingTime(meeting: CourseMeeting): boolean {
  const start = time(meeting.startTime);
  const end = time(meeting.endTime);
  return (
    !start ||
    !end ||
    Temporal.PlainTime.compare(start, end) >= 0 ||
    !meeting.weekdays?.length ||
    meeting.weekdays.some((day) => !DAY_ORDER.includes(day))
  );
}

export function hasUnknownMeetingDate(meeting: CourseMeeting): boolean {
  return !date(meeting.startDate) || !date(meeting.endDate);
}

export function dateRangesShareWeekday(
  first: {
    startDate?: string | null;
    endDate?: string | null;
    weekdays?: string[];
  },
  second: {
    startDate?: string | null;
    endDate?: string | null;
    weekdays?: string[];
  },
): boolean {
  const weekdays = (first.weekdays ?? []).filter((day) =>
    (second.weekdays ?? []).includes(day),
  );
  if (!weekdays.length) return false;
  const firstStart = date(first.startDate);
  const secondStart = date(second.startDate);
  const firstEnd = date(first.endDate);
  const secondEnd = date(second.endDate);
  const starts = [firstStart, secondStart].filter(
    (value): value is Temporal.PlainDate => value !== null,
  );
  const ends = [firstEnd, secondEnd].filter(
    (value): value is Temporal.PlainDate => value !== null,
  );
  const start = starts.length
    ? starts.reduce((latest, value) =>
        Temporal.PlainDate.compare(value, latest) > 0 ? value : latest,
      )
    : null;
  const end = ends.length
    ? ends.reduce((earliest, value) =>
        Temporal.PlainDate.compare(value, earliest) < 0 ? value : earliest,
      )
    : null;
  if (start && end) {
    if (Temporal.PlainDate.compare(start, end) > 0) return false;
    if (start.until(end).days >= 7) return true;
    for (
      let day = start;
      Temporal.PlainDate.compare(day, end) <= 0;
      day = day.add({ days: 1 })
    ) {
      if (weekdays.includes(DAY_ORDER[day.dayOfWeek - 1]!)) return true;
    }
    return false;
  }
  return true;
}

function rangesOverlap(first: CourseMeeting, second: CourseMeeting): boolean {
  const aStart = date(first.startDate);
  const aEnd = date(first.endDate);
  const bStart = date(second.startDate);
  const bEnd = date(second.endDate);
  if (aEnd && bStart && Temporal.PlainDate.compare(aEnd, bStart) < 0)
    return false;
  if (bEnd && aStart && Temporal.PlainDate.compare(bEnd, aStart) < 0)
    return false;
  return dateRangesShareWeekday(first, second);
}

export function meetingsConflict(
  first: CourseMeeting,
  second: CourseMeeting,
): boolean {
  if (hasUnknownMeetingTime(first) || hasUnknownMeetingTime(second))
    return false;
  if (!rangesOverlap(first, second)) return false;
  const firstStart = time(first.startTime)!;
  const firstEnd = time(first.endTime)!;
  const secondStart = time(second.startTime)!;
  const secondEnd = time(second.endTime)!;
  return (
    Temporal.PlainTime.compare(firstStart, secondEnd) < 0 &&
    Temporal.PlainTime.compare(secondStart, firstEnd) < 0
  );
}

export function bundlesConflict(
  first: CourseBundleForSchedule,
  second: CourseBundleForSchedule,
): boolean {
  return first.meetings.some((a) =>
    second.meetings.some((b) => meetingsConflict(a, b)),
  );
}

export function bundleDateRange(bundle: CourseBundleForSchedule) {
  const dates = bundle.meetings.flatMap((meeting) => {
    const values = [date(meeting.startDate), date(meeting.endDate)];
    return values.filter(
      (value): value is Temporal.PlainDate => value !== null,
    );
  });
  if (!dates.length) return null;
  let start = dates[0]!;
  let end = dates[0]!;
  for (const value of dates.slice(1)) {
    if (Temporal.PlainDate.compare(value, start) < 0) start = value;
    if (Temporal.PlainDate.compare(value, end) > 0) end = value;
  }
  return { start, end };
}

function occurrenceWindow(window: CalendarWindow, timezone: string) {
  const end = Temporal.Instant.from(window.to).toZonedDateTimeISO(timezone);
  const endDate = end.toPlainDate();
  const endAtMidnight =
    Temporal.PlainTime.compare(
      end.toPlainTime(),
      Temporal.PlainTime.from("00:00"),
    ) === 0;
  return {
    start: Temporal.Instant.from(window.from)
      .toZonedDateTimeISO(timezone)
      .toPlainDate(),
    end: endAtMidnight ? endDate : endDate.add({ days: 1 }),
  };
}

export function expandCourseBundle(
  bundle: CourseBundleForSchedule,
  window: CalendarWindow,
  fallbackTimezone: string,
  maxItems = 1000,
): { items: CalendarOccurrence[]; partial: boolean } {
  const items: CalendarOccurrence[] = [];
  let partial = bundle.meetings.length === 0;
  for (const [meetingIndex, meeting] of bundle.meetings.entries()) {
    if (hasUnknownMeetingTime(meeting) || hasUnknownMeetingDate(meeting)) {
      partial = true;
      continue;
    }
    const timezone = meeting.timezone || fallbackTimezone;
    const dates = occurrenceWindow(window, timezone);
    const first = date(meeting.startDate);
    const last = date(meeting.endDate);
    const start =
      first && Temporal.PlainDate.compare(first, dates.start) > 0
        ? first
        : dates.start;
    const lastExclusive = last ? last.add({ days: 1 }) : dates.end;
    const end =
      Temporal.PlainDate.compare(lastExclusive, dates.end) < 0
        ? lastExclusive
        : dates.end;
    const startTime = time(meeting.startTime)!;
    const endTime = time(meeting.endTime)!;
    for (
      let day = start;
      Temporal.PlainDate.compare(day, end) < 0;
      day = day.add({ days: 1 })
    ) {
      if (!meeting.weekdays?.includes(DAY_ORDER[day.dayOfWeek - 1]!)) continue;
      const localStart = day.toPlainDateTime(startTime);
      const localEnd = day.toPlainDateTime(endTime);
      let startsAt: Temporal.ZonedDateTime;
      let endsAt: Temporal.ZonedDateTime;
      try {
        startsAt = localStart.toZonedDateTime(timezone, {
          disambiguation: "reject",
        });
        endsAt = localEnd.toZonedDateTime(timezone, {
          disambiguation: "reject",
        });
      } catch {
        partial = true;
        continue;
      }
      const startIso = new Date(startsAt.epochMilliseconds).toISOString();
      const endIso = new Date(endsAt.epochMilliseconds).toISOString();
      if (startIso >= window.to || endIso <= window.from) continue;
      const localStartText = startsAt.toString();
      const localEndText = endsAt.toString();
      items.push({
        calendarKey: calendarKey(
          "course",
          `${bundle.bundleId}:${meetingIndex}`,
          startIso,
          endIso,
        ),
        source: "course",
        sourceId: bundle.bundleId,
        title: `${bundle.courseCode}${bundle.sectionLabels.length ? ` (${bundle.sectionLabels.join("/")})` : ""}`,
        ...(meeting.venue ? { location: meeting.venue } : {}),
        startsAt: startIso,
        endsAt: endIso,
        localStartsAt: localStartText,
        localEndsAt: localEndText,
        allDay: false,
        timezone,
        blocksTime: true,
        readonly: true,
        ...(bundle.termCode ? { termCode: bundle.termCode } : {}),
      });
      if (items.length > maxItems)
        return { items: items.slice(0, maxItems + 1), partial };
    }
  }
  return { items, partial };
}

export function localDays(bundle: CourseBundleForSchedule): Set<string> {
  const result = new Set<string>();
  for (const meeting of bundle.meetings) {
    for (const day of meeting.weekdays ?? []) result.add(day);
  }
  return result;
}
