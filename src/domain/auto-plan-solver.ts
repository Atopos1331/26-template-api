import loadHighs from "highs";
import type { AutoPlanGroup, NormalizedAutoPlanRequest } from "./auto-plan.js";

export type SolverCandidate = {
  id: string;
  courseId?: string;
  courseCode: string;
  priority: number;
  required: boolean;
  credits: number | null;
  seatSafety: number;
  timeFit: number;
  compactness: number;
  instructorFit?: number;
  conflicts: string[];
  dailyMinutes?: Record<string, number>;
  weekDayKeys?: string[];
};

export type SolverInput = {
  request: NormalizedAutoPlanRequest;
  candidates: SolverCandidate[];
  courseCodes: string[];
  groups?: AutoPlanGroup[];
  blockedAssignments?: Array<Record<string, string | null>>;
  minDesiredCourses?: number;
  minDesiredPriority?: number;
  maxSelectedCourses?: number;
};

export type SolverResult = {
  status: "completed" | "infeasible" | "time_limited";
  selectedIds: string[];
  objective: number;
};

export class AutoPlanSolverBusyError extends Error {
  constructor() {
    super("Auto-plan solver concurrency limit reached");
    this.name = "AutoPlanSolverBusyError";
  }
}

let activeSolvers = 0;

function safeName(value: string, index: number) {
  return `x${index}_${value.replace(/[^A-Za-z0-9_]/g, "_").slice(-32)}`;
}

function scoreBasisPoints(value: number) {
  return Math.max(0, Math.min(10_000, Math.round(value * 100)));
}

export function autoPlanCandidateObjective(
  candidate: SolverCandidate,
  request: NormalizedAutoPlanRequest,
  courseCount = request.courses.length,
) {
  const seat = scoreBasisPoints(candidate.seatSafety);
  const time = scoreBasisPoints(candidate.timeFit);
  const compactness = scoreBasisPoints(candidate.compactness);
  const instructor = scoreBasisPoints(candidate.instructorFit ?? 50);
  if (request.mode === "coverage_first") {
    const maxPriority = courseCount * 5;
    const maxQuality = maxPriority * 1_000_000;
    const priorityScale = maxQuality + 1;
    const courseScale = maxPriority * priorityScale + maxQuality + 1;
    const quality =
      candidate.priority * (seat * 40 + time * 35 + compactness * 25);
    return courseScale + candidate.priority * priorityScale + quality;
  }
  const weights =
    request.mode === "seat_safety"
      ? {
          coverage: 35,
          seatSafety: 45,
          timeFit: 15,
          compactness: 5,
          instructorFit: 0,
        }
      : request.mode === "balanced"
        ? {
            coverage: 45,
            seatSafety: 25,
            timeFit: 20,
            compactness: 10,
            instructorFit: 0,
          }
        : (request.weights ?? {
            coverage: 45,
            seatSafety: 25,
            timeFit: 20,
            compactness: 10,
            instructorFit: 0,
          });
  return (
    candidate.priority *
    (weights.coverage * 100 +
      seat * weights.seatSafety +
      time * weights.timeFit +
      compactness * weights.compactness +
      instructor * (weights.instructorFit ?? 0))
  );
}

function addTerm(terms: string[], coefficientValue: number, name: string) {
  if (coefficientValue === 0) return;
  terms.push(`${coefficientValue} ${name}`);
}

function solveText(input: SolverInput, excluded: Set<string> = new Set()) {
  const candidates = input.candidates.filter(
    (candidate) => !excluded.has(candidate.id),
  );
  const names = candidates.map((candidate, index) =>
    safeName(candidate.id, index),
  );
  const byCourse = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const indexes = byCourse.get(candidate.courseCode) ?? [];
    indexes.push(index);
    byCourse.set(candidate.courseCode, indexes);
  });
  const rows: string[] = [];
  const bounds: string[] = [];
  const objective: string[] = [];
  const required = new Set(
    input.request.courses
      .filter((course) => course.required)
      .map((course) => course.courseCode),
  );
  const dayKeys = [
    ...new Set(candidates.flatMap((candidate) => candidate.weekDayKeys ?? [])),
  ].sort();
  const dayNames = new Map(
    dayKeys.map((key, index) => [
      key,
      `d${index}_${key.replace(/[^A-Za-z0-9_]/g, "_")}`,
    ]),
  );

  for (const courseCode of input.courseCodes) {
    const indexes = byCourse.get(courseCode) ?? [];
    if (!indexes.length) {
      if (required.has(courseCode)) rows.push(`required_${courseCode}: 0 = 1`);
      continue;
    }
    const expression = indexes.map((index) => names[index]!).join(" + ");
    rows.push(`${courseCode}_at_most_one: ${expression} <= 1`);
    if (required.has(courseCode))
      rows.push(`${courseCode}_required: ${expression} = 1`);
  }

  rows.push(
    `at_least_one_desired: ${names.length ? names.join(" + ") : "0"} >= 1`,
  );
  if (input.minDesiredCourses !== undefined) {
    rows.push(
      `coverage_floor: ${names.length ? names.join(" + ") : "0"} >= ${input.minDesiredCourses}`,
    );
  }
  if (input.minDesiredPriority !== undefined) {
    const priorityTerms = candidates.map(
      (candidate, index) => `${candidate.priority} ${names[index]!}`,
    );
    rows.push(
      `priority_floor: ${priorityTerms.length ? priorityTerms.join(" + ") : "0"} >= ${input.minDesiredPriority}`,
    );
  }
  rows.push(
    `max_selected_courses: ${names.length ? names.join(" + ") : "0"} <= ${input.maxSelectedCourses ?? 12}`,
  );

  for (const [groupIndex, group] of (input.groups ?? []).entries()) {
    const groupLabel = `g${groupIndex}`;
    const indexes = group.courseCodes.flatMap(
      (courseCode) => byCourse.get(courseCode) ?? [],
    );
    const expression = indexes.length
      ? indexes.map((index) => names[index]!).join(" + ")
      : "0";
    rows.push(`group_${groupLabel}_min: ${expression} >= ${group.minCount}`);
    rows.push(`group_${groupLabel}_max: ${expression} <= ${group.maxCount}`);
  }

  const candidateById = new Map(
    candidates.map((candidate, index) => [
      candidate.id,
      { candidate, name: names[index]! },
    ]),
  );
  const conflictRows = new Set<string>();
  for (const candidate of candidates) {
    const name = candidateById.get(candidate.id)!.name;
    for (const conflictId of candidate.conflicts) {
      const other = candidateById.get(conflictId);
      if (!other || other.name === name) continue;
      const pair = [name, other.name].sort().join("_");
      if (conflictRows.has(pair)) continue;
      conflictRows.add(pair);
      rows.push(`conflict_${conflictRows.size}: ${name} + ${other.name} <= 1`);
    }
  }

  const minCredits = input.request.constraints.minCredits;
  const maxCredits = input.request.constraints.maxCredits;
  if (minCredits !== undefined || maxCredits !== undefined) {
    const terms = candidates.flatMap((candidate, index) =>
      candidate.credits === null
        ? []
        : [`${candidate.credits} ${names[index]!}`],
    );
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.credits === null)
        rows.push(`unknown_credits_${index}: ${names[index]!} = 0`);
    }
    if (!terms.length) {
      if (minCredits !== undefined) rows.push("credits_min: 0 >= 1");
    } else {
      const expression = terms.join(" + ");
      if (minCredits !== undefined)
        rows.push(`credits_min: ${expression} >= ${minCredits}`);
      if (maxCredits !== undefined)
        rows.push(`credits_max: ${expression} <= ${maxCredits}`);
    }
  }

  if (input.request.constraints.maxDailyClassMinutes !== undefined) {
    const dates = [
      ...new Set(
        candidates.flatMap((candidate) =>
          Object.keys(candidate.dailyMinutes ?? {}),
        ),
      ),
    ].sort();
    for (const date of dates) {
      const terms = candidates.flatMap((candidate, index) => {
        const minutes = candidate.dailyMinutes?.[date] ?? 0;
        return minutes > 0 ? [`${minutes} ${names[index]!}`] : [];
      });
      if (terms.length)
        rows.push(
          `daily_minutes_${date}: ${terms.join(" + ")} <= ${input.request.constraints.maxDailyClassMinutes}`,
        );
    }
  }

  for (const [key, dayName] of dayNames) {
    const candidatesOnDay = candidates.flatMap((candidate, index) =>
      (candidate.weekDayKeys ?? []).includes(key) ? [names[index]!] : [],
    );
    for (const candidateName of candidatesOnDay)
      rows.push(
        `day_link_${dayName}_${candidateName}: ${candidateName} - ${dayName} <= 0`,
      );
  }
  const weekKeys = [
    ...new Set(dayKeys.map((key) => key.split(":")[0]!)),
  ].sort();
  for (const week of weekKeys) {
    const days = dayKeys.filter((key) => key.startsWith(`${week}:`));
    const dayExpression =
      days.map((key) => dayNames.get(key)!).join(" + ") || "0";
    if (input.request.constraints.maxCampusDays !== undefined)
      rows.push(
        `campus_days_${week}: ${dayExpression} <= ${input.request.constraints.maxCampusDays}`,
      );
    if (input.request.constraints.minDaysOff !== undefined) {
      const weekdayExpression =
        days
          .filter((key) => Number(key.split(":")[1]) <= 5)
          .map((key) => dayNames.get(key)!)
          .join(" + ") || "0";
      rows.push(
        `days_off_${week}: ${weekdayExpression} <= ${5 - input.request.constraints.minDaysOff}`,
      );
    }
  }

  for (const [index, candidate] of candidates.entries()) {
    objective.push(
      `${autoPlanCandidateObjective(candidate, input.request, input.courseCodes.length)} ${names[index]!}`,
    );
  }

  for (const [index, assignment] of (
    input.blockedAssignments ?? []
  ).entries()) {
    const terms: string[] = [];
    let assignedCount = 0;
    for (const courseCode of input.courseCodes) {
      const candidateId = assignment[courseCode];
      const indexes = byCourse.get(courseCode) ?? [];
      if (candidateId === null || candidateId === undefined) {
        for (const candidateIndex of indexes)
          addTerm(terms, 1, names[candidateIndex]!);
      } else {
        const candidate = candidateById.get(candidateId);
        if (candidate) {
          addTerm(terms, -1, candidate.name);
          assignedCount += 1;
        }
      }
    }
    rows.push(
      `different_${index}: ${terms.length ? terms.join(" + ") : "0"} >= ${input.request.minDifferentBundles - assignedCount}`,
    );
  }

  for (const name of names) bounds.push(`${name} >= 0`, `${name} <= 1`);
  for (const name of dayNames.values())
    bounds.push(`${name} >= 0`, `${name} <= 1`);
  const variables = [...names, ...dayNames.values()];
  return `Maximize\n obj: ${objective.length ? objective.join(" + ") : "0"}\nSubject To\n ${rows.length ? rows.join("\n ") : "always: 0 <= 1"}\nBounds\n ${bounds.join("\n ")}\nGenerals\n ${variables.join(" ")}\nEnd`;
}

export async function solveAutoPlanInProcess(
  input: SolverInput,
  deadlineMs = 8_000,
): Promise<SolverResult> {
  const highs = await loadHighs();
  const start = Date.now();
  const result = highs.solve(solveText(input), {
    output_flag: false,
    time_limit: Math.max(0.1, deadlineMs / 1000),
  });
  const selected = input.candidates.filter((candidate, index) => {
    const name = safeName(candidate.id, index);
    const column = result.Columns[name];
    return column && "Primal" in column && column.Primal > 0.5;
  });
  const status =
    result.Status === "Optimal"
      ? "completed"
      : result.Status === "Infeasible"
        ? "infeasible"
        : result.Status === "Empty"
          ? "infeasible"
          : Date.now() - start >= deadlineMs
            ? "time_limited"
            : "time_limited";
  return {
    status,
    selectedIds: selected.map((candidate) => candidate.id),
    objective: result.ObjectiveValue ?? 0,
  };
}

export async function solveAutoPlan(
  input: SolverInput,
  deadlineMs = 8_000,
  concurrencyLimit = Number.MAX_SAFE_INTEGER,
): Promise<SolverResult> {
  if (deadlineMs <= 0)
    return { status: "time_limited", selectedIds: [], objective: 0 };
  if (activeSolvers >= concurrencyLimit) throw new AutoPlanSolverBusyError();
  activeSolvers += 1;
  let worker: Worker;
  try {
    worker = new Worker(
      new URL("./auto-plan-solver-worker.ts", import.meta.url).href,
    );
  } catch (error) {
    activeSolvers -= 1;
    throw error;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SolverResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      activeSolvers -= 1;
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ status: "time_limited", selectedIds: [], objective: 0 }),
      deadlineMs + 100,
    );
    worker.addEventListener("message", (event) =>
      finish(event.data as SolverResult),
    );
    worker.addEventListener("error", () =>
      finish({ status: "time_limited", selectedIds: [], objective: 0 }),
    );
    worker.addEventListener("close", () => {
      if (!settled)
        finish({ status: "time_limited", selectedIds: [], objective: 0 });
    });
    worker.postMessage({ input, deadlineMs });
  });
}

export function modelTextForTest(input: SolverInput) {
  return solveText(input);
}
