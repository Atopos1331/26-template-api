import { expect, test } from "bun:test";
import {
  bundlesConflict,
  expandCourseBundle,
} from "../src/domain/course-schedules.js";

test("course meeting endDate is inclusive when expanding occurrences", () => {
  const result = expandCourseBundle(
    {
      bundleId: "bundle-1",
      courseCode: "COMP2611",
      sectionLabels: ["L1"],
      meetings: [
        {
          startDate: "2026-09-21",
          endDate: "2026-09-22",
          weekdays: ["MO", "TU"],
          startTime: "09:00",
          endTime: "10:00",
          timezone: "Asia/Hong_Kong",
        },
      ],
    },
    {
      from: "2026-09-21T00:00:00.000Z",
      to: "2026-09-23T00:00:00.000Z",
    },
    "Asia/Hong_Kong",
  );

  expect(result.items).toHaveLength(2);
  expect(result.items.map((item) => item.localStartsAt.slice(0, 10))).toEqual([
    "2026-09-21",
    "2026-09-22",
  ]);
});

test("non-midnight window end includes the local end date before UTC clipping", () => {
  const result = expandCourseBundle(
    {
      bundleId: "bundle-1",
      courseCode: "COMP2611",
      sectionLabels: ["L1"],
      meetings: [
        {
          startDate: "2026-09-22",
          endDate: "2026-09-22",
          weekdays: ["TU"],
          startTime: "09:00",
          endTime: "10:00",
          timezone: "Asia/Hong_Kong",
        },
      ],
    },
    {
      from: "2026-09-21T16:00:00.000Z",
      to: "2026-09-22T04:00:00.000Z",
    },
    "Asia/Hong_Kong",
  );

  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.localStartsAt.slice(0, 10)).toBe("2026-09-22");
});

test("midnight window end remains exclusive for the local end date", () => {
  const result = expandCourseBundle(
    {
      bundleId: "bundle-1",
      courseCode: "COMP2611",
      sectionLabels: ["L1"],
      meetings: [
        {
          startDate: "2026-09-22",
          endDate: "2026-09-22",
          weekdays: ["TU"],
          startTime: "09:00",
          endTime: "10:00",
          timezone: "Asia/Hong_Kong",
        },
      ],
    },
    {
      from: "2026-09-20T16:00:00.000Z",
      to: "2026-09-21T16:00:00.000Z",
    },
    "Asia/Hong_Kong",
  );

  expect(result.items).toHaveLength(0);
});

test("date-bounded weekly meetings conflict only when a common weekday occurs", () => {
  const first = {
    bundleId: "first",
    courseCode: "COMP1001",
    sectionLabels: ["L1"],
    meetings: [
      {
        startDate: "2026-09-04",
        endDate: "2026-09-05",
        weekdays: ["MO"],
        startTime: "10:00",
        endTime: "11:00",
      },
    ],
  };
  const second = {
    bundleId: "second",
    courseCode: "COMP1002",
    sectionLabels: ["L1"],
    meetings: [
      {
        weekdays: ["MO"],
        startTime: "10:00",
        endTime: "11:00",
      },
    ],
  };
  expect(bundlesConflict(first, second)).toBe(false);
});
