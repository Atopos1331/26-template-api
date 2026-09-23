import { describe, expect, test } from "bun:test";
import { normalizeAutoPlanRequest } from "../src/domain/auto-plan.js";
import {
  hardMeetingViolation,
  timeFitScore,
} from "../src/domain/auto-plan-constraints.js";
import {
  autoPlanCandidateObjective,
  modelTextForTest,
  type SolverInput,
  solveAutoPlan,
} from "../src/domain/auto-plan-solver.js";

const base = {
  courses: [
    {
      courseCode: "COMP2611",
      required: true,
      priority: 5,
      excludedSectionIds: [],
      excludedInstructorNames: [],
    },
    {
      courseCode: "COMP2612",
      required: false,
      priority: 3,
      excludedSectionIds: [],
      excludedInstructorNames: [],
    },
  ],
  groups: [],
  includeCurrentSelected: true,
  constraints: {
    unavailableWindows: [],
    freeWeekdays: [],
    protectedWindows: [],
    preferredWindows: [],
    preferredInstructorNames: [],
  },
  mode: "coverage_first" as const,
  allowFullWaitlist: false,
  unknownQuotaPolicy: "allow" as const,
  resultLimit: 5,
  minDifferentBundles: 1,
};

test("normalizes course identity and accepts Phase 08 inputs", () => {
  expect(
    normalizeAutoPlanRequest({ courses: [{ courseCode: " comp 2611 " }] })
      .courses[0]?.courseCode,
  ).toBe("COMP2611");
  expect(() =>
    normalizeAutoPlanRequest({
      courses: [{ courseCode: "COMP2611" }],
      mode: "custom",
    }),
  ).toThrow();
  expect(
    normalizeAutoPlanRequest({
      courses: [{ courseCode: "COMP2611" }],
      fill: {},
    }).fill?.maxCourses,
  ).toBe(0);
  expect(() =>
    normalizeAutoPlanRequest({ courses: [{ courseCode: "" }] }),
  ).toThrow();
  expect(() =>
    normalizeAutoPlanRequest({
      courses: [{ courseCode: "COMP2611" }],
      groups: [
        {
          id: "g",
          courseCodes: ["COMP 2611", "comp2611"],
          minCount: 1,
          maxCount: 1,
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    normalizeAutoPlanRequest({
      courses: [{ courseCode: "COMP2611" }],
      constraints: {
        unavailableWindows: [
          { weekdays: [], startTime: "09:00", endTime: "10:00" },
        ],
      },
    }),
  ).toThrow();
});

test("known time constraints remain usable when a meeting has no dates", () => {
  const request = normalizeAutoPlanRequest({
    courses: [{ courseCode: "COMP2611" }],
    constraints: {
      earliestStart: "09:00",
      latestEnd: "18:00",
    },
  });
  expect(
    hardMeetingViolation(
      [
        {
          weekdays: ["MO"],
          startTime: "10:00",
          endTime: "11:00",
        },
      ],
      request.constraints,
      null,
    ),
  ).toBeNull();
});

test("an empty meeting list cannot satisfy a hard temporal constraint", () => {
  const request = normalizeAutoPlanRequest({
    courses: [{ courseCode: "COMP2611" }],
    constraints: { earliestStart: "09:00" },
  });
  expect(hardMeetingViolation([], request.constraints, null)).toBe(
    "meeting time or weekday is unavailable for a hard temporal constraint",
  );
});

test("preferred-window time fit respects half-open date ranges", () => {
  const occurrence = {
    calendarKey: "course:1",
    source: "course",
    sourceId: "bundle-1",
    title: "COMP2611",
    startsAt: "2026-09-22T01:00:00.000Z",
    endsAt: "2026-09-22T02:00:00.000Z",
    localStartsAt: "2026-09-22T09:00:00+08:00[Asia/Hong_Kong]",
    localEndsAt: "2026-09-22T10:00:00+08:00[Asia/Hong_Kong]",
    allDay: false,
    timezone: "Asia/Hong_Kong",
    blocksTime: true,
    readonly: true,
  };
  const outside = normalizeAutoPlanRequest({
    courses: [{ courseCode: "COMP2611" }],
    constraints: {
      preferredWindows: [
        {
          weekdays: ["TU"],
          startTime: "09:00",
          endTime: "10:00",
          startDate: "2026-09-23",
          endDate: "2026-09-24",
        },
      ],
    },
  });
  expect(
    timeFitScore(
      [occurrence],
      false,
      outside.constraints.preferredWindows,
      "Asia/Hong_Kong",
    ),
  ).toBe(0);
});

describe("auto-plan solver", () => {
  const input: SolverInput = {
    request: base,
    courseCodes: ["COMP2611", "COMP2612"],
    candidates: [
      {
        id: "a",
        courseCode: "COMP2611",
        priority: 5,
        required: true,
        credits: 3,
        seatSafety: 50,
        timeFit: 50,
        compactness: 50,
        conflicts: ["c"],
      },
      {
        id: "b",
        courseCode: "COMP2611",
        priority: 5,
        required: true,
        credits: 3,
        seatSafety: 40,
        timeFit: 50,
        compactness: 50,
        conflicts: [],
      },
      {
        id: "c",
        courseCode: "COMP2612",
        priority: 3,
        required: false,
        credits: 3,
        seatSafety: 100,
        timeFit: 100,
        compactness: 100,
        conflicts: ["a"],
      },
    ],
  };

  test("keeps required course and avoids a hard conflict", async () => {
    const result = await solveAutoPlan(input);
    expect(result.status).toBe("completed");
    expect(result.selectedIds).toContain("b");
    expect(result.selectedIds).not.toContain("a");
    expect(result.selectedIds).toContain("c");
  });

  test("model has binary variables and required equality", () => {
    const model = modelTextForTest(input);
    expect(model).toContain("Generals");
    expect(model).toContain("COMP2611_required");
    expect(model).toContain("<= 1");
  });

  test("sanitizes distinct group IDs to distinct model row names", () => {
    const request = normalizeAutoPlanRequest({
      courses: [{ courseCode: "COMP2611" }, { courseCode: "COMP2612" }],
      groups: [
        {
          id: "a-b",
          courseCodes: ["COMP2611"],
          minCount: 0,
          maxCount: 1,
        },
        {
          id: "a_b",
          courseCodes: ["COMP2612"],
          minCount: 0,
          maxCount: 1,
        },
      ],
    });
    const model = modelTextForTest({
      request,
      courseCodes: ["COMP2611", "COMP2612"],
      candidates: [],
      groups: request.groups,
    });
    expect(model.match(/group_g0_min:/g)).toHaveLength(1);
    expect(model.match(/group_g1_min:/g)).toHaveLength(1);
  });

  test("coverage-first objective makes course count and priority lexicographic", () => {
    const candidate = input.candidates[0]!;
    const oneCourse = autoPlanCandidateObjective(candidate, base, 2);
    const next = { ...candidate, id: "next", courseCode: "COMP2612" };
    expect(
      oneCourse + autoPlanCandidateObjective(next, base, 2),
    ).toBeGreaterThan(
      autoPlanCandidateObjective({ ...candidate, priority: 5 }, base, 2),
    );
  });

  test("weighted modes keep coverage and quality on the same scale", async () => {
    const request = normalizeAutoPlanRequest({
      mode: "seat_safety",
      courses: [
        { courseCode: "COMP2611", priority: 5 },
        { courseCode: "COMP2612", priority: 1 },
      ],
    });
    const result = await solveAutoPlan({
      request,
      courseCodes: ["COMP2611", "COMP2612"],
      candidates: [
        {
          id: "high-priority",
          courseCode: "COMP2611",
          priority: 5,
          required: false,
          credits: 3,
          seatSafety: 0,
          timeFit: 50,
          compactness: 50,
          conflicts: ["high-seat"],
        },
        {
          id: "high-seat",
          courseCode: "COMP2612",
          priority: 1,
          required: false,
          credits: 3,
          seatSafety: 50,
          timeFit: 50,
          compactness: 50,
          conflicts: ["high-priority"],
        },
      ],
    });
    expect(result.status).toBe("completed");
    expect(result.selectedIds).toEqual(["high-priority"]);
  });

  test("bundle diversity counts replacing a course assignment", async () => {
    const request = normalizeAutoPlanRequest({
      courses: [{ courseCode: "COMP2611", required: true }],
      minDifferentBundles: 1,
    });
    const result = await solveAutoPlan({
      request,
      courseCodes: ["COMP2611"],
      blockedAssignments: [{ COMP2611: "first" }],
      candidates: [
        {
          id: "first",
          courseCode: "COMP2611",
          priority: 3,
          required: true,
          credits: 3,
          seatSafety: 50,
          timeFit: 50,
          compactness: 50,
          conflicts: [],
        },
        {
          id: "second",
          courseCode: "COMP2611",
          priority: 3,
          required: true,
          credits: 3,
          seatSafety: 40,
          timeFit: 50,
          compactness: 50,
          conflicts: [],
        },
      ],
    });
    expect(result.status).toBe("completed");
    expect(result.selectedIds).toEqual(["second"]);
  });

  test("bundle diversity requires the requested number of changed assignments", async () => {
    const request = normalizeAutoPlanRequest({
      courses: [
        { courseCode: "COMP2611", required: true },
        { courseCode: "COMP2612", required: true },
      ],
      minDifferentBundles: 2,
    });
    const result = await solveAutoPlan({
      request,
      courseCodes: ["COMP2611", "COMP2612"],
      blockedAssignments: [{ COMP2611: "first", COMP2612: "third" }],
      candidates: [
        {
          id: "first",
          courseCode: "COMP2611",
          priority: 3,
          required: true,
          credits: 3,
          seatSafety: 50,
          timeFit: 50,
          compactness: 50,
          conflicts: [],
        },
        {
          id: "second",
          courseCode: "COMP2611",
          priority: 3,
          required: true,
          credits: 3,
          seatSafety: 40,
          timeFit: 50,
          compactness: 50,
          conflicts: [],
        },
        {
          id: "third",
          courseCode: "COMP2612",
          priority: 3,
          required: true,
          credits: 3,
          seatSafety: 50,
          timeFit: 50,
          compactness: 50,
          conflicts: [],
        },
      ],
    });
    expect(result.status).toBe("infeasible");
  });
});
