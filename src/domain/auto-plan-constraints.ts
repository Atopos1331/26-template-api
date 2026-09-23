import { Temporal } from "@js-temporal/polyfill";
import type {
  AutoPlanConstraints,
  AutoPlanWindow,
  Weekday,
} from "./auto-plan.js";
import type { CalendarOccurrence, CalendarWindow } from "./calendar.js";
import {
  type CourseMeeting,
  dateRangesShareWeekday,
  hasUnknownMeetingDate,
  hasUnknownMeetingTime,
} from "./course-schedules.js";

const WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEKDAY_INDEX = new Map(WEEKDAYS.map((day, index) => [day, index + 1]));

export type PlanningHorizon = {
  start: Temporal.PlainDate;
  end: Temporal.PlainDate;
  weeks: string[];
  window: CalendarWindow;
};

export type ScheduleMetrics = {
  partial: boolean;
  localDates: string[];
  weekDayKeys: string[];
  dailyMinutes: Record<string, number>;
  dailyBounds: Record<string, { start: number; end: number; minutes: number }>;
  occurrences: CalendarOccurrence[];
};

export type ScheduleSummary = {
  campusDays: number;
  idleMinutes: number;
  representativeWeek: {
    weekStart: string;
    knownMeetingMinutes: number;
    campusDays: number;
    idleMinutes: number;
  } | null;
};

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  try {
    return Temporal.PlainDate.from(value);
  } catch {
    return null;
  }
}

function parseTime(value: string | null | undefined) {
  if (!value || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  try {
    return Temporal.PlainTime.from(value.length === 5 ? `${value}:00` : value);
  } catch {
    return null;
  }
}

function timeMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function rangesOverlap(
  firstStart: Temporal.PlainDate,
  firstEnd: Temporal.PlainDate,
  secondStart: Temporal.PlainDate,
  secondEnd: Temporal.PlainDate,
) {
  return (
    Temporal.PlainDate.compare(firstStart, secondEnd) <= 0 &&
    Temporal.PlainDate.compare(secondStart, firstEnd) <= 0
  );
}

function windowDateRange(window: AutoPlanWindow, horizon: PlanningHorizon) {
  const start = parseDate(window.startDate) ?? horizon.start;
  const end = parseDate(window.endDate)
    ? parseDate(window.endDate)!.subtract({ days: 1 })
    : horizon.end;
  return { start, end };
}

function meetingDateRange(meeting: CourseMeeting, horizon: PlanningHorizon) {
  const start = parseDate(meeting.startDate) ?? horizon.start;
  const end = parseDate(meeting.endDate) ?? horizon.end;
  return { start, end };
}

function minuteRange(value: {
  startTime?: string | null;
  endTime?: string | null;
}) {
  const start = parseTime(value.startTime);
  const end = parseTime(value.endTime);
  if (!start || !end) return null;
  return {
    start: start.hour * 60 + start.minute,
    end: end.hour * 60 + end.minute,
  };
}

function overlapsWindow(
  meeting: CourseMeeting,
  window: AutoPlanWindow,
  horizon: PlanningHorizon | null,
) {
  const range = minuteRange(meeting);
  if (!range) return false;
  const days = meeting.weekdays ?? [];
  if (!days.some((day) => window.weekdays.includes(day as Weekday)))
    return false;
  if (horizon) {
    const meetingDates = meetingDateRange(meeting, horizon);
    const windowDates = windowDateRange(window, horizon);
    if (
      !rangesOverlap(
        meetingDates.start,
        meetingDates.end,
        windowDates.start,
        windowDates.end,
      )
    )
      return false;
    if (
      !dateRangesShareWeekday(meeting, {
        startDate: windowDates.start.toString(),
        endDate: windowDates.end.toString(),
        weekdays: window.weekdays,
      })
    )
      return false;
  } else if (hasDateBound(window)) {
    return false;
  }
  return (
    range.start < timeMinutes(window.endTime) &&
    timeMinutes(window.startTime) < range.end
  );
}

function hasDateBound(window: AutoPlanWindow) {
  return window.startDate !== undefined || window.endDate !== undefined;
}

export function derivePlanningHorizon(
  meetings: CourseMeeting[],
  timezone: string,
  maxDays: number,
): PlanningHorizon | null {
  const dates = meetings.flatMap((meeting) =>
    [parseDate(meeting.startDate), parseDate(meeting.endDate)].filter(
      (value): value is Temporal.PlainDate => value !== null,
    ),
  );
  if (!dates.length) return null;
  let start = dates[0]!;
  let end = dates[0]!;
  for (const value of dates.slice(1)) {
    if (Temporal.PlainDate.compare(value, start) < 0) start = value;
    if (Temporal.PlainDate.compare(value, end) > 0) end = value;
  }
  if (start.until(end).days + 1 > maxDays) return null;
  const weeks: string[] = [];
  for (
    let week = start.subtract({ days: start.dayOfWeek - 1 });
    Temporal.PlainDate.compare(week, end) <= 0;
    week = week.add({ days: 7 })
  ) {
    weeks.push(week.toString());
  }
  const from = start.toZonedDateTime(timezone).toInstant();
  const to = end.add({ days: 1 }).toZonedDateTime(timezone).toInstant();
  return {
    start,
    end,
    weeks,
    window: {
      from: new Date(from.epochMilliseconds).toISOString(),
      to: new Date(to.epochMilliseconds).toISOString(),
    },
  };
}

export function scheduleMetrics(
  occurrences: CalendarOccurrence[],
  partial: boolean,
  timezone: string,
): ScheduleMetrics {
  const dates = new Set<string>();
  const weekDays = new Set<string>();
  const intervalsByDate = new Map<string, Array<[number, number]>>();
  for (const occurrence of occurrences) {
    const start = Temporal.Instant.from(occurrence.startsAt).toZonedDateTimeISO(
      timezone,
    );
    const end = Temporal.Instant.from(occurrence.endsAt).toZonedDateTimeISO(
      timezone,
    );
    const date = start.toPlainDate().toString();
    const week = start
      .toPlainDate()
      .subtract({ days: start.dayOfWeek - 1 })
      .toString();
    dates.add(date);
    weekDays.add(`${week}:${start.dayOfWeek}`);
    const intervals = intervalsByDate.get(date) ?? [];
    intervals.push([
      start.hour * 60 + start.minute,
      end.hour * 60 + end.minute,
    ]);
    intervalsByDate.set(date, intervals);
  }
  const dailyMinutes: Record<string, number> = {};
  const dailyBounds: ScheduleMetrics["dailyBounds"] = {};
  for (const [date, intervals] of intervalsByDate) {
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let total = 0;
    let start = intervals[0]?.[0];
    let end = intervals[0]?.[1];
    for (const interval of intervals.slice(1)) {
      if (start === undefined || end === undefined) break;
      if (interval[0] > end) {
        total += end - start;
        start = interval[0];
        end = interval[1];
      } else {
        end = Math.max(end, interval[1]);
      }
    }
    if (start !== undefined && end !== undefined) total += end - start;
    dailyMinutes[date] = Math.max(0, total);
    const first = intervals[0];
    const last = intervals.at(-1);
    if (first && last)
      dailyBounds[date] = {
        start: first[0],
        end: Math.max(...intervals.map((interval) => interval[1])),
        minutes: Math.max(0, total),
      };
  }
  return {
    partial,
    localDates: [...dates].sort(),
    weekDayKeys: [...weekDays].sort(),
    dailyMinutes,
    dailyBounds,
    occurrences,
  };
}

function hasUnknownDateForWindow(
  meeting: CourseMeeting,
  window: AutoPlanWindow,
) {
  return hasDateBound(window) && hasUnknownMeetingDate(meeting);
}

function meetingUsesWeekday(
  meeting: CourseMeeting,
  weekday: Weekday,
  horizon: PlanningHorizon | null,
) {
  if (!meeting.weekdays?.includes(weekday)) return false;
  if (!horizon) return true;
  return dateRangesShareWeekday(meeting, {
    startDate: horizon.start.toString(),
    endDate: horizon.end.toString(),
    weekdays: [weekday],
  });
}

export function hardMeetingViolation(
  meetings: CourseMeeting[],
  constraints: AutoPlanConstraints,
  horizon: PlanningHorizon | null,
): string | null {
  const hardWindows = [
    ...constraints.unavailableWindows,
    ...constraints.protectedWindows,
  ];
  const needsKnownSchedule =
    hardWindows.length > 0 ||
    constraints.freeWeekdays.length > 0 ||
    constraints.earliestStart !== undefined ||
    constraints.latestEnd !== undefined ||
    constraints.maxCampusDays !== undefined ||
    constraints.minDaysOff !== undefined ||
    constraints.maxDailyClassMinutes !== undefined;
  if (!needsKnownSchedule) return null;
  const needsProjectedHorizon =
    constraints.maxCampusDays !== undefined ||
    constraints.minDaysOff !== undefined ||
    constraints.maxDailyClassMinutes !== undefined;
  if (
    meetings.length === 0 ||
    meetings.some(hasUnknownMeetingTime) ||
    (needsProjectedHorizon && meetings.some(hasUnknownMeetingDate)) ||
    (needsProjectedHorizon && meetings.length > 0 && !horizon)
  )
    return "meeting time or weekday is unavailable for a hard temporal constraint";
  for (const meeting of meetings) {
    if (
      constraints.freeWeekdays.some((day) =>
        meetingUsesWeekday(meeting, day, horizon),
      )
    )
      return "uses a protected free weekday";
    const range = minuteRange(meeting);
    if (!range)
      return "meeting time is unavailable for a hard temporal constraint";
    if (
      (constraints.earliestStart !== undefined &&
        range.start < timeMinutes(constraints.earliestStart)) ||
      (constraints.latestEnd !== undefined &&
        range.end > timeMinutes(constraints.latestEnd))
    )
      return "meeting falls outside the allowed daily time range";
    for (const window of hardWindows) {
      if (hasUnknownDateForWindow(meeting, window))
        return "meeting date range is unavailable for a date-bounded hard window";
      if (overlapsWindow(meeting, window, horizon))
        return "meeting overlaps an unavailable window";
    }
  }
  return null;
}

export function timeFitScore(
  occurrences: CalendarOccurrence[],
  partial: boolean,
  preferredWindows: AutoPlanWindow[],
  timezone: string,
) {
  if (!preferredWindows.length || partial || !occurrences.length) return 50;
  let total = 0;
  let preferred = 0;
  for (const occurrence of occurrences) {
    const start = Temporal.Instant.from(occurrence.startsAt).toZonedDateTimeISO(
      timezone,
    );
    const end = Temporal.Instant.from(occurrence.endsAt).toZonedDateTimeISO(
      timezone,
    );
    const date = start.toPlainDate();
    const day = WEEKDAYS[start.dayOfWeek - 1]!;
    const startMinutes = start.hour * 60 + start.minute;
    const endMinutes = end.hour * 60 + end.minute;
    total += Math.max(0, endMinutes - startMinutes);
    const intervals = preferredWindows
      .filter((window) => window.weekdays.includes(day))
      .filter(
        (window) =>
          (window.startDate === undefined ||
            Temporal.PlainDate.compare(date, window.startDate) >= 0) &&
          (window.endDate === undefined ||
            Temporal.PlainDate.compare(date, window.endDate) < 0),
      )
      .filter((window) => {
        const dates = windowDateRange(window, {
          start: date,
          end: date,
          weeks: [],
          window: { from: "", to: "" },
        });
        return rangesOverlap(date, date, dates.start, dates.end);
      })
      .map(
        (window) =>
          [timeMinutes(window.startTime), timeMinutes(window.endTime)] as const,
      )
      .sort((a, b) => a[0] - b[0]);
    let coveredEnd = -1;
    for (const [windowStart, windowEnd] of intervals) {
      const overlapStart = Math.max(startMinutes, windowStart, coveredEnd);
      const overlapEnd = Math.min(endMinutes, windowEnd);
      if (overlapEnd > overlapStart) preferred += overlapEnd - overlapStart;
      coveredEnd = Math.max(coveredEnd, windowEnd);
    }
  }
  return total ? Math.round((preferred / total) * 100) : 50;
}

export function compactnessScore(
  metrics: ScheduleMetrics,
  horizon: PlanningHorizon | null,
  timezone: string,
) {
  if (metrics.partial || !metrics.occurrences.length || !horizon) return 50;
  const summary = scheduleSummary(metrics, horizon, timezone);
  const campusScore = (100 * (7 - summary.campusDays)) / 7;
  const idleScore = 100 * (1 - Math.min(summary.idleMinutes / 600, 1));
  return Math.round((campusScore * 0.5 + idleScore * 0.5) * 100) / 100;
}

export function scheduleSummary(
  metrics: ScheduleMetrics,
  horizon: PlanningHorizon | null,
  timezone: string,
): ScheduleSummary {
  if (!horizon || !metrics.occurrences.length) {
    return { campusDays: 0, idleMinutes: 0, representativeWeek: null };
  }
  const byWeek = new Map<string, Set<string>>();
  const intervalsByDay = new Map<string, Array<[number, number]>>();
  for (const occurrence of metrics.occurrences) {
    const start = Temporal.Instant.from(occurrence.startsAt).toZonedDateTimeISO(
      timezone,
    );
    const end = Temporal.Instant.from(occurrence.endsAt).toZonedDateTimeISO(
      timezone,
    );
    const date = start.toPlainDate().toString();
    const week = start
      .toPlainDate()
      .subtract({ days: start.dayOfWeek - 1 })
      .toString();
    const days = byWeek.get(week) ?? new Set<string>();
    days.add(date);
    byWeek.set(week, days);
    const dayKey = `${week}:${date}`;
    const intervals = intervalsByDay.get(dayKey) ?? [];
    intervals.push([
      start.hour * 60 + start.minute,
      end.hour * 60 + end.minute,
    ]);
    intervalsByDay.set(dayKey, intervals);
  }
  let campusDays = 0;
  let idleMinutes = 0;
  const knownMinutesByWeek = new Map<string, number>();
  for (const week of horizon.weeks) {
    const weekDays = byWeek.get(week)?.size ?? 0;
    campusDays += weekDays;
    let knownMinutes = 0;
    for (const [key, intervals] of intervalsByDay) {
      if (!key.startsWith(`${week}:`)) continue;
      intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      let occupied = 0;
      let start = intervals[0]?.[0];
      let end = intervals[0]?.[1];
      for (const interval of intervals.slice(1)) {
        if (start === undefined || end === undefined) break;
        if (interval[0] > end) {
          occupied += end - start;
          start = interval[0];
          end = interval[1];
        } else {
          end = Math.max(end, interval[1]);
        }
      }
      if (start !== undefined && end !== undefined) {
        occupied += end - start;
        min = start;
        max = end;
      }
      knownMinutes += occupied;
      idleMinutes += Math.max(0, max - min - occupied);
    }
    knownMinutesByWeek.set(week, knownMinutes);
  }
  const denominator = horizon.weeks.length || 1;
  const representativeWeek = [...knownMinutesByWeek.entries()]
    .filter(([, minutes]) => minutes > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const representative = representativeWeek
    ? {
        weekStart: representativeWeek[0],
        knownMeetingMinutes: representativeWeek[1],
        campusDays: byWeek.get(representativeWeek[0])?.size ?? 0,
        idleMinutes: [...intervalsByDay.entries()]
          .filter(([key]) => key.startsWith(`${representativeWeek[0]}:`))
          .reduce((total, [, intervals]) => {
            const ordered = [...intervals].sort(
              (a, b) => a[0] - b[0] || a[1] - b[1],
            );
            const first = ordered[0];
            if (!first) return total;
            let start = first[0];
            let end = first[1];
            let occupied = 0;
            for (const interval of ordered.slice(1)) {
              if (interval[0] > end) {
                occupied += end - start;
                start = interval[0];
              }
              end = Math.max(end, interval[1]);
            }
            occupied += end - start;
            return total + Math.max(0, end - start - occupied);
          }, 0),
      }
    : null;
  return {
    campusDays: Math.round((campusDays / denominator) * 100) / 100,
    idleMinutes: Math.round((idleMinutes / denominator) * 100) / 100,
    representativeWeek: representative,
  };
}

export function instructorFitScore(
  instructors: string[],
  preferredNames: string[],
) {
  if (!preferredNames.length) return 50;
  if (!instructors.length) return 50;
  const wanted = new Set(
    preferredNames.map((value) => value.trim().toLocaleLowerCase()),
  );
  const known = instructors.filter(Boolean);
  if (!known.length) return 50;
  const matched = known.filter((value) =>
    wanted.has(value.trim().toLocaleLowerCase()),
  );
  return Math.round((matched.length / known.length) * 100);
}

export function violatesAggregateConstraints(
  metrics: ScheduleMetrics,
  constraints: AutoPlanConstraints,
  horizon: PlanningHorizon | null,
) {
  if (!horizon) return null;
  if (
    constraints.maxDailyClassMinutes !== undefined &&
    Object.values(metrics.dailyMinutes).some(
      (minutes) => minutes > constraints.maxDailyClassMinutes!,
    )
  )
    return "a day exceeds the maximum class minutes";
  const daysByWeek = new Map<string, Set<number>>();
  for (const key of metrics.weekDayKeys) {
    const [week, day] = key.split(":");
    const days = daysByWeek.get(week!) ?? new Set<number>();
    days.add(Number(day));
    daysByWeek.set(week!, days);
  }
  for (const week of horizon.weeks) {
    const count = daysByWeek.get(week)?.size ?? 0;
    if (
      constraints.maxCampusDays !== undefined &&
      count > constraints.maxCampusDays
    )
      return "a week exceeds the maximum campus days";
    if (constraints.minDaysOff !== undefined) {
      const weekdays = [...(daysByWeek.get(week) ?? [])].filter(
        (day) => day <= 5,
      ).length;
      if (5 - weekdays < constraints.minDaysOff)
        return "a week has too few weekdays off";
    }
  }
  return null;
}

export function weekdayIndex(day: string) {
  return WEEKDAY_INDEX.get(day as Weekday) ?? null;
}
