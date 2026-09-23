import { createHmac, timingSafeEqual } from "node:crypto";
import { PlanError } from "./plans.js";

export type AutoPlanTokenPayload = {
  version: 1;
  owner: string;
  planId: string;
  planRevision: number;
  termCode: string;
  importBatchId: string;
  importFence: number | null;
  selectedBundleIds: string[];
  fillerBundleIds?: string[];
  quotaSnapshotIds: Record<string, string | null>;
  quotaTrendObservationIds?: Record<string, string[]>;
  quotaStale?: Record<string, boolean>;
  commonCore?: { catalogVersion: string; stateRevision: number } | null;
  requestHash: string;
  request: unknown;
  horizon: {
    start: string;
    end: string;
    weeks: string[];
  } | null;
  expiresAt: number;
};

function signature(key: string, value: string) {
  return createHmac("sha256", key).update(value).digest("base64url");
}

export function signAutoPlanToken(key: string, payload: AutoPlanTokenPayload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(key, encoded)}`;
}

export function verifyAutoPlanToken(
  key: string,
  token: unknown,
  now: number,
  maxBytes = 131_072,
): AutoPlanTokenPayload {
  if (
    typeof token !== "string" ||
    token.length > maxBytes ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    throw new PlanError(
      "invalid_request",
      400,
      "Invalid auto-plan option token",
    );
  const [encoded, supplied] = token.split(".") as [string, string];
  const expected = Buffer.from(signature(key, encoded));
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new PlanError(
      "invalid_request",
      400,
      "Invalid auto-plan option token",
    );
  let payload: AutoPlanTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString(),
    ) as AutoPlanTokenPayload;
    if (
      payload.version !== 1 ||
      typeof payload.owner !== "string" ||
      typeof payload.planId !== "string" ||
      !Number.isSafeInteger(payload.planRevision) ||
      typeof payload.termCode !== "string" ||
      typeof payload.importBatchId !== "string" ||
      (payload.importFence !== null &&
        !Number.isSafeInteger(payload.importFence)) ||
      !Array.isArray(payload.selectedBundleIds) ||
      payload.selectedBundleIds.some((id) => typeof id !== "string") ||
      (payload.fillerBundleIds !== undefined &&
        (!Array.isArray(payload.fillerBundleIds) ||
          payload.fillerBundleIds.some((id) => typeof id !== "string"))) ||
      payload.quotaSnapshotIds === null ||
      typeof payload.quotaSnapshotIds !== "object" ||
      (payload.quotaTrendObservationIds !== undefined &&
        (payload.quotaTrendObservationIds === null ||
          typeof payload.quotaTrendObservationIds !== "object" ||
          Object.values(payload.quotaTrendObservationIds).some(
            (ids) =>
              !Array.isArray(ids) || ids.some((id) => typeof id !== "string"),
          ))) ||
      (payload.quotaStale !== undefined &&
        (payload.quotaStale === null ||
          typeof payload.quotaStale !== "object" ||
          Object.values(payload.quotaStale).some(
            (value) => typeof value !== "boolean",
          ))) ||
      typeof payload.requestHash !== "string" ||
      payload.request === undefined ||
      (payload.horizon !== null &&
        (typeof payload.horizon !== "object" ||
          typeof payload.horizon.start !== "string" ||
          typeof payload.horizon.end !== "string" ||
          !Array.isArray(payload.horizon.weeks) ||
          payload.horizon.weeks.some((week) => typeof week !== "string"))) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt <= 0
    )
      throw new Error("invalid payload");
  } catch {
    throw new PlanError(
      "invalid_request",
      400,
      "Invalid auto-plan option token",
    );
  }
  if (payload.expiresAt <= now)
    throw new PlanError(
      "stale_recommendation",
      409,
      "Auto-plan recommendation has expired",
    );
  return payload;
}
