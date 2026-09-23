import { test } from "bun:test";
import * as assert from "node:assert/strict";
import { Temporal } from "@js-temporal/polyfill";
import { ObjectId, type WithId } from "mongodb";
import {
  type CalendarOccurrence,
  calendarWindow,
  detectConflicts,
  expandManualEvent,
  timeBanner,
} from "../src/domain/calendar.js";
import type { EventDocument } from "../src/plugins/init-mongo.js";

function event(overrides: Partial<EventDocument> = {}): WithId<EventDocument> {
  return {
    _id: new ObjectId(),
    ownerUsername: "alice",
    title: "Meeting",
    startsAt: "2026-03-01T14:30:00.000Z",
    endsAt: "2026-03-01T15:30:00.000Z",
    allDay: false,
    timezone: "America/Chicago",
    source: "manual",
    blocksTime: true,
    readonly: false,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function occurrence(
  start: string,
  end: string,
  overrides: Partial<CalendarOccurrence> = {},
): CalendarOccurrence {
  return {
    calendarKey: start,
    source: "manual",
    sourceId: "id",
    title: "Meeting",
    startsAt: start,
    endsAt: end,
    localStartsAt: start,
    localEndsAt: end,
    allDay: false,
    timezone: "UTC",
    blocksTime: true,
    readonly: false,
    ...overrides,
  };
}

test("calendar windows are bounded and date-only values respect local DST days", () => {
  const window = calendarWindow(
    "2026-03-08",
    "2026-03-09",
    "America/Chicago",
    1,
  );
  assert.equal(window.from, "2026-03-08T06:00:00.000Z");
  assert.equal(window.to, "2026-03-09T05:00:00.000Z");
  assert.throws(() =>
    calendarWindow("2026-03-08", undefined, "America/Chicago", 366),
  );
  assert.throws(() =>
    calendarWindow("2026-03-08", "2027-03-10", "America/Chicago", 366),
  );
  assert.throws(() =>
    calendarWindow("2026-03-09", "2026-03-08", "America/Chicago", 366),
  );
  const defaultWindow = calendarWindow(
    undefined,
    undefined,
    "Asia/Hong_Kong",
    366,
    Temporal.Instant.from("2026-09-23T20:00:00Z"),
  );
  assert.deepEqual(defaultWindow, {
    from: "2026-09-23T16:00:00.000Z",
    to: "2026-09-30T16:00:00.000Z",
  });
});

test("every-other-week recurrence is anchored to the Monday of the first week", () => {
  const alternate = event({
    startsAt: "2026-09-23T10:00:00.000Z",
    endsAt: "2026-09-23T11:00:00.000Z",
    timezone: "UTC",
    recurrence: {
      frequency: "weekly",
      interval: 2,
      weekdays: ["MO", "WE"],
      until: "2026-10-07",
    },
  });
  const items = expandManualEvent(
    alternate,
    { from: "2026-09-20T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" },
    10,
  );
  assert.deepEqual(
    items.map((item) => item.startsAt),
    [
      "2026-09-23T10:00:00.000Z",
      "2026-10-05T10:00:00.000Z",
      "2026-10-07T10:00:00.000Z",
    ],
  );
});

test("weekly expansion skips spring gaps, picks the earlier fall offset and includes until", () => {
  const spring = event({
    recurrence: {
      frequency: "weekly",
      interval: 1,
      weekdays: ["SU"],
      until: "2026-03-15",
    },
  });
  const window = {
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-03-17T00:00:00.000Z",
  };
  const springItems = expandManualEvent(spring, window, 100);
  assert.deepEqual(
    springItems.map((item) => item.startsAt),
    [
      "2026-03-01T14:30:00.000Z",
      "2026-03-08T13:30:00.000Z",
      "2026-03-15T13:30:00.000Z",
    ],
  );

  const gap = event({
    startsAt: "2026-03-01T08:30:00.000Z",
    endsAt: "2026-03-01T09:30:00.000Z",
    recurrence: {
      frequency: "weekly",
      interval: 1,
      weekdays: ["SU"],
      until: "2026-03-15",
    },
  });
  assert.deepEqual(
    expandManualEvent(gap, window, 100).map((item) => item.startsAt),
    ["2026-03-01T08:30:00.000Z", "2026-03-15T07:30:00.000Z"],
  );

  const fold = event({
    startsAt: "2026-10-25T06:30:00.000Z",
    endsAt: "2026-10-25T07:30:00.000Z",
    recurrence: {
      frequency: "weekly",
      interval: 1,
      weekdays: ["SU"],
      until: "2026-11-08",
    },
  });
  assert.deepEqual(
    expandManualEvent(
      fold,
      { from: "2026-10-25T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z" },
      100,
    ).map((item) => item.startsAt),
    [
      "2026-10-25T06:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "2026-11-08T07:30:00.000Z",
    ],
  );
});

test("all-day recurrence retains exclusive dates across DST", () => {
  const allDay = event({
    allDay: true,
    startDate: "2026-03-01",
    endDate: "2026-03-02",
    startsAt: "2026-03-01T06:00:00.000Z",
    endsAt: "2026-03-02T06:00:00.000Z",
    recurrence: {
      frequency: "weekly",
      interval: 1,
      weekdays: ["SU"],
      until: "2026-03-08",
    },
  });
  const items = expandManualEvent(
    allDay,
    { from: "2026-03-01T00:00:00.000Z", to: "2026-03-10T00:00:00.000Z" },
    10,
  );
  assert.deepEqual(
    items.map((item) => [
      item.startDate,
      item.endDate,
      item.startsAt,
      item.endsAt,
    ]),
    [
      [
        "2026-03-01",
        "2026-03-02",
        "2026-03-01T06:00:00.000Z",
        "2026-03-02T06:00:00.000Z",
      ],
      [
        "2026-03-08",
        "2026-03-09",
        "2026-03-08T06:00:00.000Z",
        "2026-03-09T05:00:00.000Z",
      ],
    ],
  );
});

test("conflicts use half-open time ranges and separate informational day overlaps", () => {
  const first = occurrence(
    "2026-09-24T10:00:00.000Z",
    "2026-09-24T11:00:00.000Z",
    { calendarKey: "a" },
  );
  const adjacent = occurrence(
    "2026-09-24T11:00:00.000Z",
    "2026-09-24T12:00:00.000Z",
    { calendarKey: "b" },
  );
  const overlapping = occurrence(
    "2026-09-24T10:30:00.000Z",
    "2026-09-24T11:30:00.000Z",
    { calendarKey: "c" },
  );
  const allDay = occurrence(
    "2026-09-24T00:00:00.000Z",
    "2026-09-25T00:00:00.000Z",
    {
      calendarKey: "d",
      allDay: true,
      startDate: "2026-09-24",
      endDate: "2026-09-25",
      blocksTime: false,
    },
  );
  const result = detectConflicts(
    [first, adjacent, overlapping, allDay],
    "UTC",
    10,
  );
  assert.equal(result.blocking.length, 2);
  assert.equal(result.informational.length, 3);
  assert.ok(result.blocking.every((item) => item.kind === "time_overlap"));
  assert.ok(result.informational.every((item) => item.kind === "day_overlap"));
  assert.throws(
    () => detectConflicts([first, adjacent, overlapping, allDay], "UTC", 1),
    /narrower/,
  );
});

test("banner captures current, upcoming, free and boundary states", () => {
  const now = Temporal.Instant.from("2026-09-24T10:00:00Z");
  const active = occurrence(
    "2026-09-24T09:00:00.000Z",
    "2026-09-24T10:30:00.000Z",
    { calendarKey: "a" },
  );
  const next = occurrence(
    "2026-09-24T10:15:00.000Z",
    "2026-09-24T11:00:00.000Z",
    { calendarKey: "b" },
  );
  assert.equal(timeBanner([active, next], now, 1).state, "current");
  assert.equal(timeBanner([active, next], now, 1).minutesRemaining, 30);
  assert.equal(
    timeBanner([active, next], Temporal.Instant.from("2026-09-24T10:30:00Z"), 1)
      .item?.calendarKey,
    "b",
  );
  assert.equal(
    timeBanner([active, next], Temporal.Instant.from("2026-09-24T11:00:00Z"), 1)
      .state,
    "free",
  );
  assert.equal(timeBanner([next], now, 1).minutesUntilStart, 15);
  assert.equal(timeBanner([], now, 1).state, "free");
  assert.equal(
    timeBanner([next], Temporal.Instant.from("2026-09-24T09:14:59Z"), 1).state,
    "free",
  );
  assert.equal(
    timeBanner([next], Temporal.Instant.from("2026-09-24T09:15:00Z"), 1).state,
    "upcoming",
  );
  assert.equal(
    timeBanner(
      [
        occurrence("2026-09-24T09:00:00.000Z", "2026-09-24T11:00:00.000Z", {
          blocksTime: false,
        }),
      ],
      now,
      1,
    ).state,
    "free",
  );
  const course = occurrence(
    "2026-09-24T09:00:00.000Z",
    "2026-09-24T11:00:00.000Z",
    {
      source: "course",
      calendarKey: "course",
    },
  );
  assert.equal(timeBanner([course, active], now, 1).item?.calendarKey, "a");
  assert.equal(
    timeBanner(
      [
        occurrence("2026-09-24T10:00:00.000Z", "2026-09-24T11:00:00.000Z", {
          allDay: true,
          startDate: "2026-09-24",
          endDate: "2026-09-25",
        }),
      ],
      now,
      1,
    ).state,
    "free",
  );
});
