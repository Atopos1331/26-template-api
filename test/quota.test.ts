import { expect, test } from "bun:test";
import {
  calculateQuotaTrend,
  enrollmentDifficulty,
  selectQuotaTrendObservations,
} from "../src/domain/quota.js";

const base = {
  sectionId: "s1",
  capacity: 100,
  enrolled: 100,
};

test("quota trend is deterministic, clamps negative remaining, and reports waitlist slope", () => {
  const rows = [
    {
      ...base,
      snapshotId: "b",
      observedAt: "2026-09-22T00:00:00.000Z",
      remaining: 0,
      waitlisted: 4,
    },
    {
      ...base,
      snapshotId: "a",
      observedAt: "2026-09-21T00:00:00.000Z",
      remaining: -5,
      waitlisted: 2,
    },
    {
      ...base,
      snapshotId: "c",
      observedAt: "2026-09-23T00:00:00.000Z",
      remaining: 20,
      waitlisted: 1,
    },
  ];
  const trend = calculateQuotaTrend(
    rows,
    "term",
    new Date("2026-09-24T00:00:00.000Z"),
  );
  expect(trend.status).toBe("ready");
  expect(trend.firstRemaining).toBe(0);
  expect(trend.lastRemaining).toBe(20);
  expect(trend.remainingDirection).toBe("increasing");
  expect(trend.waitlistSlopePerDay).toBe(-0.5);
  expect(
    selectQuotaTrendObservations(
      rows,
      "7d",
      new Date("2026-09-24T00:00:00.000Z"),
    )[0]?.snapshotId,
  ).toBe("a");
});

test("trend returns insufficient data without fabricating a slope", () => {
  const trend = calculateQuotaTrend(
    [
      {
        ...base,
        observedAt: "2026-09-23T00:00:00.000Z",
        remaining: null,
        waitlisted: null,
      },
    ],
    "14d",
    new Date("2026-09-24T00:00:00.000Z"),
  );
  expect(trend.status).toBe("insufficient_data");
  expect(trend.remainingSlopePerDay).toBeNull();
  expect(trend.dataQuality).toContain("insufficient_history");
});

test("missing fields keep a trend insufficient until one field has two values", () => {
  const now = new Date("2026-09-24T00:00:00.000Z");
  const missingCapacity = { ...base, capacity: null, enrolled: null };
  expect(
    calculateQuotaTrend(
      [
        {
          ...missingCapacity,
          observedAt: "2026-09-22T00:00:00.000Z",
          remaining: null,
        },
        {
          ...missingCapacity,
          observedAt: "2026-09-23T00:00:00.000Z",
          remaining: null,
        },
      ],
      "14d",
      now,
    ).status,
  ).toBe("insufficient_data");
  expect(
    calculateQuotaTrend(
      [
        {
          ...base,
          observedAt: "2026-09-22T00:00:00.000Z",
          remaining: 10,
          waitlisted: null,
        },
        {
          ...base,
          observedAt: "2026-09-23T00:00:00.000Z",
          remaining: 20,
          waitlisted: null,
        },
      ],
      "14d",
      now,
    ).status,
  ).toBe("ready");
});

test("future observations are excluded from a trend window", () => {
  const trend = calculateQuotaTrend(
    [
      { ...base, observedAt: "2026-09-23T00:00:00.000Z", remaining: 10 },
      { ...base, observedAt: "2026-09-25T00:00:00.000Z", remaining: 90 },
    ],
    "term",
    new Date("2026-09-24T00:00:00.000Z"),
  );
  expect(trend.observationCount).toBe(1);
  expect(trend.status).toBe("insufficient_data");
});

test("difficulty renormalizes known components and stays null without data", () => {
  const result = enrollmentDifficulty(
    {
      capacity: 100,
      remaining: 0,
      waitlisted: 20,
      observedAt: "2026-09-23T00:00:00.000Z",
    },
    { ...calculateQuotaTrend([], "14d"), remainingSlopePerDay: null },
  );
  expect(result.version).toBe("difficulty-v1");
  expect(result.score).toBeGreaterThan(0);
  expect(enrollmentDifficulty(null, null).score).toBeNull();
});
