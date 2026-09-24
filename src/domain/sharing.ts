import { createHash, randomBytes } from "node:crypto";
import { PlanError } from "./plans.js";

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function newShareToken() {
  return randomBytes(32).toString("base64url");
}

export function shareId(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new PlanError("invalid_request", 400, "Invalid share ID");
  return value;
}

export function discoverabilityAlias(value: unknown) {
  if (typeof value !== "string")
    throw new PlanError("invalid_request", 400, "Invalid display name", {
      displayName: "must be a string",
    });
  const alias = value.trim();
  const characterCount = [...alias].length;
  if (
    characterCount < 1 ||
    characterCount > 40 ||
    !/^[\p{L}\p{M}\p{N} .,'’_-]+$/u.test(alias)
  )
    throw new PlanError("invalid_request", 400, "Invalid display name", {
      displayName: "must be 1..40 plain-text characters",
    });
  return alias;
}

export function discoverabilityAliasKey(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}

export function expirySeconds(
  value: unknown,
  defaultSeconds: number,
  maxSeconds: number,
) {
  if (value === undefined) return defaultSeconds;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maxSeconds
  )
    throw new PlanError("invalid_request", 400, "Invalid expiry", {
      expiresInSeconds: `must be an integer from 1 to ${maxSeconds}`,
    });
  return value;
}

export function shareablePlanError() {
  return new PlanError(
    "shareable_plan_required",
    409,
    "Only an active plan can be shared",
  );
}
