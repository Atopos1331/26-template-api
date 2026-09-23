import type {
  AutoPlanCourseInput,
  NormalizedAutoPlanRequest,
} from "./auto-plan.js";
import {
  compactnessScore,
  type PlanningHorizon,
  type ScheduleMetrics,
  scheduleSummary,
  timeFitScore,
} from "./auto-plan-constraints.js";

export type OptionScoreCandidate = {
  courseCode: string;
  priority: number;
  seatSafety: number;
  timeFit: number;
  instructorFit: number;
};

export type AutoPlanScoreComponents = {
  coverage: number;
  seatSafety: number;
  timeFit: number;
  compactness: number;
  instructorFit: number;
};

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function priorityTotal(courses: AutoPlanCourseInput[]) {
  return courses.reduce((total, course) => total + course.priority, 0);
}

function weighted(
  selected: OptionScoreCandidate[],
  totalPriority: number,
  field: "seatSafety" | "timeFit" | "instructorFit",
) {
  if (!totalPriority) return 50;
  return round(
    selected.reduce(
      (total, candidate) => total + candidate.priority * candidate[field],
      0,
    ) / totalPriority,
  );
}

export function optionScoreComponents(
  request: NormalizedAutoPlanRequest,
  selected: OptionScoreCandidate[],
  metrics: ScheduleMetrics,
  horizon: PlanningHorizon | null,
  timezone: string,
): AutoPlanScoreComponents {
  const totalPriority = priorityTotal(request.courses);
  const selectedPriority = selected.reduce(
    (total, candidate) => total + candidate.priority,
    0,
  );
  const compactness = compactnessScore(metrics, horizon, timezone);
  const components = {
    coverage: totalPriority
      ? round((selectedPriority / totalPriority) * 100)
      : 0,
    seatSafety: weighted(selected, totalPriority, "seatSafety"),
    timeFit: weighted(selected, totalPriority, "timeFit"),
    compactness,
    instructorFit: weighted(selected, totalPriority, "instructorFit"),
  };
  return components;
}

export function optionScore(
  request: NormalizedAutoPlanRequest,
  components: AutoPlanScoreComponents,
) {
  if (request.mode === "coverage_first") {
    const quality =
      components.seatSafety * 0.4 +
      components.timeFit * 0.35 +
      components.compactness * 0.25;
    return round(components.coverage * 0.6 + quality * 0.4);
  }
  const weights =
    request.mode === "seat_safety"
      ? { coverage: 0.35, seatSafety: 0.45, timeFit: 0.15, compactness: 0.05 }
      : request.mode === "balanced"
        ? { coverage: 0.45, seatSafety: 0.25, timeFit: 0.2, compactness: 0.1 }
        : request.weights
          ? {
              coverage: request.weights.coverage / 100,
              seatSafety: request.weights.seatSafety / 100,
              timeFit: request.weights.timeFit / 100,
              compactness: request.weights.compactness / 100,
              instructorFit: request.weights.instructorFit / 100,
            }
          : {
              coverage: 0.45,
              seatSafety: 0.25,
              timeFit: 0.2,
              compactness: 0.1,
              instructorFit: 0,
            };
  return round(
    components.coverage * weights.coverage +
      components.seatSafety * weights.seatSafety +
      components.timeFit * weights.timeFit +
      components.compactness * weights.compactness +
      components.instructorFit * (weights.instructorFit ?? 0),
  );
}

export function optionScheduleSummary(
  metrics: ScheduleMetrics,
  horizon: PlanningHorizon | null,
  timezone: string,
) {
  const summary = scheduleSummary(metrics, horizon, timezone);
  return {
    campusDays: summary.campusDays,
    idleMinutes: summary.idleMinutes,
    representativeWeek: summary.representativeWeek,
    occurrences: metrics.occurrences,
    conflictCoverage: metrics.partial
      ? ("partial" as const)
      : ("complete" as const),
  };
}

export function exactTimeFit(
  metrics: ScheduleMetrics,
  request: NormalizedAutoPlanRequest,
  timezone: string,
) {
  return timeFitScore(
    metrics.occurrences,
    metrics.partial,
    request.constraints.preferredWindows,
    timezone,
  );
}
