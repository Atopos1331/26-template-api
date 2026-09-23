export type QuotaObservationLike = {
  snapshotId?: string | null;
  sectionId?: string;
  observedAt: string;
  capacity?: number | null;
  enrolled?: number | null;
  remaining?: number | null;
  waitlisted?: number | null;
  open?: boolean | null;
};

export type QuotaTrendWindow = "7d" | "14d" | "term";
export type TrendDirection =
  | "increasing"
  | "decreasing"
  | "stable"
  | "insufficient_data";

/** Returns the provider value or derives remaining seats from capacity/enrollment. */
export function effectiveRemaining(input: unknown): number | null {
  const row =
    input !== null && typeof input === "object"
      ? (input as {
          capacity?: unknown;
          enrolled?: unknown;
          remaining?: unknown;
        })
      : {};
  if (typeof row.remaining === "number" && Number.isFinite(row.remaining))
    return row.remaining;
  if (
    typeof row.capacity === "number" &&
    Number.isFinite(row.capacity) &&
    typeof row.enrolled === "number" &&
    Number.isFinite(row.enrolled)
  )
    return row.capacity - row.enrolled;
  return null;
}

export type QuotaTrend = {
  window: QuotaTrendWindow;
  status: "ready" | "insufficient_data";
  observationCount: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  firstRemaining: number | null;
  lastRemaining: number | null;
  remainingSlopePerDay: number | null;
  remainingDirection: TrendDirection;
  firstWaitlisted: number | null;
  lastWaitlisted: number | null;
  waitlistSlopePerDay: number | null;
  waitlistDirection: TrendDirection;
  dataQuality: string[];
};

function validTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function displayEffectiveRemaining(row: QuotaObservationLike): number | null {
  const value = effectiveRemaining(row);
  return value === null ? null : Math.max(0, value);
}

function direction(slope: number | null): TrendDirection {
  if (slope === null) return "insufficient_data";
  if (slope < -0.5) return "decreasing";
  if (slope > 0.5) return "increasing";
  return "stable";
}

function fieldPair(
  rows: QuotaObservationLike[],
  field: "remaining" | "waitlisted",
) {
  const values = rows
    .map((row) => {
      const at = validTimestamp(row.observedAt);
      const value =
        field === "remaining" ? displayEffectiveRemaining(row) : row[field];
      return at === null || typeof value !== "number" || !Number.isFinite(value)
        ? null
        : {
            at,
            value: Math.max(0, value),
          };
    })
    .filter((value): value is { at: number; value: number } => value !== null);
  if (values.length < 2) {
    return {
      first: values[0]?.value ?? null,
      last: values.at(-1)?.value ?? null,
      slope: null,
    };
  }
  const first = values[0]!;
  const last = values.at(-1)!;
  const elapsedDays = (last.at - first.at) / 86_400_000;
  if (elapsedDays <= 0) {
    return { first: first.value, last: last.value, slope: null };
  }
  return {
    first: first.value,
    last: last.value,
    slope: (last.value - first.value) / elapsedDays,
  };
}

export function selectQuotaTrendObservations(
  rows: QuotaObservationLike[],
  window: QuotaTrendWindow,
  now = new Date(),
): QuotaObservationLike[] {
  const cutoff =
    window === "term"
      ? Number.NEGATIVE_INFINITY
      : now.getTime() - (window === "7d" ? 7 : 14) * 86_400_000;
  return rows
    .filter((row) => {
      const at = validTimestamp(row.observedAt);
      return at !== null && at >= cutoff && at <= now.getTime();
    })
    .sort(
      (a, b) =>
        Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
        String(a.snapshotId ?? "").localeCompare(String(b.snapshotId ?? "")),
    );
}

export function calculateQuotaTrend(
  rows: QuotaObservationLike[],
  window: QuotaTrendWindow = "14d",
  now = new Date(),
): QuotaTrend {
  const selected = selectQuotaTrendObservations(rows, window, now);
  const remaining = fieldPair(selected, "remaining");
  const waitlisted = fieldPair(selected, "waitlisted");
  const dataQuality: string[] = [];
  if (
    selected.some((row) => {
      const value = effectiveRemaining(row);
      return value !== null && value < 0;
    })
  )
    dataQuality.push("quota_inconsistent");
  if (selected.some((row) => displayEffectiveRemaining(row) === null))
    dataQuality.push("remaining_missing");
  if (
    selected.some(
      (row) =>
        typeof row.waitlisted !== "number" || !Number.isFinite(row.waitlisted),
    )
  )
    dataQuality.push("waitlist_missing");
  const hasTrend = remaining.slope !== null || waitlisted.slope !== null;
  if (!hasTrend) dataQuality.push("insufficient_history");
  return {
    window,
    status: hasTrend ? "ready" : "insufficient_data",
    observationCount: selected.length,
    firstObservedAt: selected[0]?.observedAt ?? null,
    lastObservedAt: selected.at(-1)?.observedAt ?? null,
    firstRemaining: remaining.first,
    lastRemaining: remaining.last,
    remainingSlopePerDay: remaining.slope,
    remainingDirection: direction(remaining.slope),
    firstWaitlisted: waitlisted.first,
    lastWaitlisted: waitlisted.last,
    waitlistSlopePerDay: waitlisted.slope,
    waitlistDirection: direction(waitlisted.slope),
    dataQuality: [...new Set(dataQuality)],
  };
}

export type DifficultyResult = {
  version: "difficulty-v1";
  score: number | null;
  components: Array<{
    name:
      | "remaining_pressure"
      | "waitlist_pressure"
      | "seat_trend"
      | "openness";
    value: number | null;
    weight: number;
  }>;
  dataQuality: string[];
};

function bounded(value: number) {
  return Math.max(0, Math.min(100, value));
}

export function enrollmentDifficulty(
  latest: QuotaObservationLike | null | undefined,
  trend?: QuotaTrend | null,
): DifficultyResult {
  const dataQuality: string[] = [];
  const components: DifficultyResult["components"] = [];
  const capacity =
    typeof latest?.capacity === "number" && latest.capacity > 0
      ? latest.capacity
      : null;
  const remaining = latest ? displayEffectiveRemaining(latest) : null;
  if (capacity !== null && remaining !== null) {
    components.push({
      name: "remaining_pressure",
      value: bounded(100 * (1 - remaining / capacity)),
      weight: 0.4,
    });
  } else {
    dataQuality.push("remaining_or_capacity_missing");
  }
  const waitlisted =
    typeof latest?.waitlisted === "number" && Number.isFinite(latest.waitlisted)
      ? Math.max(0, latest.waitlisted)
      : null;
  if (capacity !== null && waitlisted !== null) {
    components.push({
      name: "waitlist_pressure",
      value: bounded(100 * Math.min(waitlisted / capacity, 1)),
      weight: 0.2,
    });
  } else {
    dataQuality.push("waitlist_missing");
  }
  const slope = trend?.remainingSlopePerDay ?? null;
  if (capacity !== null && slope !== null) {
    components.push({
      name: "seat_trend",
      value: bounded((-slope / capacity) * 100),
      weight: 0.2,
    });
  } else {
    dataQuality.push("remaining_trend_missing");
  }
  if (latest?.open === true || latest?.open === false) {
    components.push({
      name: "openness",
      value: latest.open ? 0 : 100,
      weight: 0.2,
    });
  } else {
    dataQuality.push("openness_missing");
  }
  const totalWeight = components.reduce(
    (sum, component) => sum + component.weight,
    0,
  );
  const score = totalWeight
    ? Math.round(
        (components.reduce(
          (sum, component) => sum + (component.value ?? 0) * component.weight,
          0,
        ) /
          totalWeight) *
          100,
      ) / 100
    : null;
  if (score === null) dataQuality.push("insufficient_data");
  return {
    version: "difficulty-v1",
    score,
    components,
    dataQuality: [...new Set(dataQuality)],
  };
}
