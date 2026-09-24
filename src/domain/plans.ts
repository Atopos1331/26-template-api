import { ObjectId } from "mongodb";

export type PlanStatus = "draft" | "active" | "archived";
export type PlanItemStatus = "selected" | "alternative" | "rejected";

export type CoursePlanItem = {
  itemId: string;
  courseId: string;
  offeringId: string;
  bundleId: string;
  componentClassNbrs: string[];
  courseCodeSnapshot: string;
  sectionLabelsSnapshot: string[];
  colorOverride?: string;
  note?: string;
  status: PlanItemStatus;
  sourceVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type AutoPlanApplyMarker = {
  operationId: string;
  requestHash: string;
  fromRevision: number;
  toRevision: number;
  appliedAt: string;
};

export class PlanError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly fields?: Record<string, string>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

function invalid(field: string, reason: string): never {
  throw new PlanError("invalid_request", 400, "Request validation failed", {
    [field]: reason,
  });
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid("body", "must be an object");
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: Set<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(key, "is not allowed");
  }
}

function text(
  value: unknown,
  field: string,
  max: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) invalid(field, "is required");
    return undefined;
  }
  if (typeof value !== "string") invalid(field, "must be a string");
  const result = value.trim();
  if (!result && required) invalid(field, "must not be blank");
  if (result.length > max) invalid(field, `must be at most ${max} characters`);
  return result || undefined;
}

function status(value: unknown, field: string): PlanItemStatus {
  if (value !== "selected" && value !== "alternative" && value !== "rejected")
    return invalid(field, "must be selected, alternative, or rejected");
  return value;
}

function color(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid("colorOverride", "must be a string");
  const result = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(result))
    invalid("colorOverride", "must be a six-digit hexadecimal color");
  return result.toLowerCase();
}

export function planId(value: string): ObjectId {
  if (!/^[0-9a-f]{24}$/.test(value))
    throw new PlanError("invalid_request", 400, "Invalid plan ID", {
      id: "must be a lowercase 24-character ObjectId",
    });
  return new ObjectId(value);
}

export function normalizePlanCreate(input: unknown) {
  const body = object(input);
  fields(body, new Set(["name", "termCode", "description"]));
  const name = text(body.name, "name", 100, true)!;
  const termCode = text(body.termCode, "termCode", 4, true)!;
  if (!/^\d{2}(10|20|30|40)$/.test(termCode))
    invalid("termCode", "must be a YY10, YY20, YY30, or YY40 term code");
  const description = text(body.description, "description", 2000);
  return {
    name,
    termCode,
    ...(description === undefined ? {} : { description }),
  };
}

export function normalizePlanPatch(input: unknown) {
  const body = object(input);
  fields(body, new Set(["name", "description", "status"]));
  if (!Object.keys(body).length) invalid("body", "must not be empty");
  const name =
    body.name === undefined ? undefined : text(body.name, "name", 100, true);
  const description =
    body.description === null
      ? undefined
      : text(body.description, "description", 2000);
  let nextStatus: "active" | "archived" | undefined;
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "archived")
      invalid("status", "status transition must target active or archived");
    nextStatus = body.status;
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(body.description === undefined
      ? {}
      : { description: description ?? null }),
    ...(nextStatus === undefined ? {} : { status: nextStatus }),
  };
}

export function normalizeItemCreate(input: unknown) {
  const body = object(input);
  fields(
    body,
    new Set(["offeringId", "bundleId", "status", "note", "colorOverride"]),
  );
  const offeringId = text(body.offeringId, "offeringId", 512, true)!;
  const bundleId = text(body.bundleId, "bundleId", 768, true)!;
  const itemStatus = status(body.status ?? "selected", "status");
  if (itemStatus === "rejected")
    invalid("status", "new items may be selected or alternative only");
  const note = text(body.note, "note", 1000);
  const colorOverride = color(body.colorOverride);
  return {
    offeringId,
    bundleId,
    status: itemStatus,
    ...(note === undefined ? {} : { note }),
    ...(colorOverride === undefined ? {} : { colorOverride }),
  };
}

export function normalizeItemPatch(input: unknown) {
  const body = object(input);
  fields(body, new Set(["status", "note", "colorOverride"]));
  if (!Object.keys(body).length) invalid("body", "must not be empty");
  const itemStatus =
    body.status === undefined ? undefined : status(body.status, "status");
  const note = body.note === null ? undefined : text(body.note, "note", 1000);
  const colorOverride =
    body.colorOverride === null ? undefined : color(body.colorOverride);
  return {
    ...(itemStatus === undefined ? {} : { status: itemStatus }),
    ...(body.note === undefined ? {} : { note: note ?? null }),
    ...(body.colorOverride === undefined
      ? {}
      : { colorOverride: colorOverride ?? null }),
  };
}

export function assertPlanItemInvariants(items: CoursePlanItem[]) {
  if (items.length > 100)
    throw new PlanError(
      "plan_item_limit_reached",
      409,
      "A plan cannot contain more than 100 items",
    );
  const bundles = new Set<string>();
  const selectedCourses = new Set<string>();
  for (const item of items) {
    if (bundles.has(item.bundleId))
      throw new PlanError("duplicate_bundle", 409, "Bundle is already in plan");
    bundles.add(item.bundleId);
    if (item.status === "selected") {
      if (selectedCourses.has(item.courseId))
        throw new PlanError(
          "conflict_detected",
          409,
          "A course can have only one selected bundle",
        );
      selectedCourses.add(item.courseId);
    }
  }
}

export function isAllowedPlanTransition(
  current: PlanStatus,
  next: PlanStatus,
): boolean {
  return (
    (current === "draft" && (next === "active" || next === "archived")) ||
    (current === "active" && next === "archived")
  );
}
