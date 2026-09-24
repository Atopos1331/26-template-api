import mongodb from "@fastify/mongodb";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Collection, Document, ObjectId } from "mongodb";
import packageJson from "../../package.json" with { type: "json" };
import type {
  AutoPlanApplyMarker,
  CoursePlanItem,
  PlanStatus,
} from "../domain/plans.js";
import {
  type AcademicCollections,
  initializeAcademicCollections,
} from "./academic-collections.js";

export type EventDocument = {
  ownerUsername: string;
  title: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  startDate?: string;
  endDate?: string;
  allDay: boolean;
  timezone: string;
  color?: string;
  recurrence?: {
    frequency: "weekly";
    interval: number;
    weekdays: string[];
    until: string;
  };
  source: string;
  sourceName?: string;
  externalId?: string | null;
  importId?: ObjectId | null;
  recurrenceId?: string | null;
  recurrenceStatus?: string;
  identityQuality?: "derived_identity";
  eventType?: "class" | "exam" | "deadline" | "reminder" | "other";
  blocksTime: boolean;
  supersedesCalendarKey?: string;
  readonly: boolean;
  revision: number;
  operationId?: string;
  createdAt: string;
  updatedAt: string;
};

export type EventImportStatus = "processing" | "active" | "deleted" | "failed";

export type EventImportDocument = {
  _id: ObjectId;
  ownerUsername: string;
  source: "ics";
  filename?: string;
  contentHash: string;
  optionsHash: string;
  importWindowFrom: string;
  importWindowTo: string;
  defaultBlocksTime: boolean;
  operationId?: string;
  importedAt: string;
  activatedAt?: string;
  processingLeaseExpiresAt?: string;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  rejectedCount: number;
  rejections?: Array<{ reason: string; count: number }>;
  status: EventImportStatus;
};

export type IdempotencyRecordState = "processing" | "completed" | "failed";

export type IdempotencyRecordDocument = {
  ownerScope: string;
  routeKey: string;
  idempotencyKeyHash: string;
  requestHash: string;
  operationId?: string;
  claimToken?: string;
  state: IdempotencyRecordState;
  responseStatus?: number;
  responseBody?: unknown;
  encryptedOneTimeSecret?: string;
  resourceId?: ObjectId;
  leaseExpiresAt?: string;
  createdAt: string;
  expiresAt: Date;
};

export type CoursePlanDocument = {
  ownerUsername: string;
  name: string;
  termCode: string;
  description?: string | null;
  status: PlanStatus;
  revision: number;
  items: CoursePlanItem[];
  lastAutoPlanApply?: AutoPlanApplyMarker;
  createdAt: string;
  updatedAt: string;
};

export type SharedPlanDocument = {
  _id: ObjectId;
  shareId: string;
  planId: ObjectId;
  ownerUsername: string;
  tokenHash: string;
  operationId: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  snapshotVersion: number;
  snapshot: {
    displayLabel: string;
    termSummary: string;
    selectedCourses: Array<{
      courseCode: string;
      title: string;
      sectionLabels: string[];
      meetings: Array<Record<string, unknown>>;
      room?: string;
    }>;
    generatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type SectionDiscoverabilityDocument = {
  _id: ObjectId;
  recordId: string;
  ownerUsername: string;
  sectionId: string;
  displayName: string;
  displayNameKey: string;
  expiresAt: Date;
  createdAt: string;
  updatedAt: string;
};

export type SharingRateLimitDocument = {
  keyHash: string;
  windowStart: Date;
  expiresAt: Date;
  count: number;
};

/**
 * Options for {@link resolveMongoUri} and {@link mongoPlugin}.
 *
 * `test` selects which candidate URI is consulted — `mongoTestUri` when `true`,
 * `mongoUri` otherwise. It does NOT change the fallback chain: an unset URI
 * falls back to the production default (`mongodb://localhost:27018`) in
 * production, or an in-memory MongoDB otherwise. The two concerns are orthogonal.
 */
export type ResolveMongoUriOptions = {
  test?: boolean;
  // Non-test MongoDB URI (from MONGO_URI)
  mongoUri?: string;
  // Test-only MongoDB URI (from MONGO_TEST_URI)
  mongoTestUri?: string;
};

/** The Compose MongoDB URI used in production when none is configured. */
const PRODUCTION_DEFAULT_URI = "mongodb://localhost:27018";

// The stdlib URL parser covers the single-host `mongodb://` URIs this template
// uses; multi-host seed lists would need a MongoDB-specific parser.
function parseMongoConnectionString(uri: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("Invalid MongoDB URI");
  }

  // WHATWG URL happily parses scheme-less strings like "localhost:27018" as
  // a "localhost:" URL; reject anything that is not a MongoDB URI here so
  // the failure is immediate and clear instead of an opaque driver error.
  if (parsed.protocol !== "mongodb:" && parsed.protocol !== "mongodb+srv:") {
    throw new Error(
      'Invalid MongoDB URI: expected a "mongodb://" or "mongodb+srv://" scheme',
    );
  }

  return parsed;
}

function setMongoDatabase(connectionString: URL, databaseName: string): string {
  const hasCredentials =
    connectionString.username !== "" || connectionString.password !== "";
  if (hasCredentials && !connectionString.searchParams.has("authSource")) {
    const currentDatabase =
      decodeURIComponent(connectionString.pathname.slice(1)) || "admin";
    connectionString.searchParams.set("authSource", currentDatabase);
  }

  connectionString.pathname = `/${databaseName}`;
  return connectionString.toString();
}

/**
 * Appends `databaseName` to `uri` only when the URI does not already name a
 * database; URIs with an explicit database are returned unchanged.
 */
export function withDefaultMongoDatabase(
  uri: string,
  databaseName: string,
): string {
  const connectionString = parseMongoConnectionString(uri);

  // WHATWG URL leaves the pathname empty (not "/") for non-special schemes
  // like mongodb: without a trailing slash; both mean "no database named".
  if (connectionString.pathname === "" || connectionString.pathname === "/") {
    return setMongoDatabase(connectionString, databaseName);
  }

  return uri;
}

/**
 * Resolves the MongoDB connection URI.
 *
 * The candidate URIs are passed via options (not read from env). `loadOptions`
 * seeds them from `MONGO_URI` / `MONGO_TEST_URI`; the app forwards both to this
 * function so the env→option mapping stays single-sourced in `loadOptions`.
 *
 * Candidate selection:
 * - `test: true` → `mongoTestUri` (test-only, from `MONGO_TEST_URI`).
 * - `test` omitted / `false` → `mongoUri` (non-test / production, from `MONGO_URI`).
 *
 * Fallback chain (identical for both modes):
 * 1. The selected candidate URI, if set — used as-is.
 * 2. In production with it unset — the Compose MongoDB URI is used as the default.
 * 3. Otherwise (development / tests) — an in-memory MongoDB is spawned and its
 *    URI is used. The server is stopped on `onClose`.
 *
 * `mongodb-memory-server` is dynamically imported inside the function body so it
 * is never loaded in production code paths.
 */
export async function resolveMongoUri(
  fastify: FastifyInstance,
  databaseName: string,
  opts: ResolveMongoUriOptions = {},
): Promise<string> {
  const explicitUri = opts.test ? opts.mongoTestUri : opts.mongoUri;

  if (explicitUri !== undefined) {
    return withDefaultMongoDatabase(explicitUri, databaseName);
  }

  if (Bun.env.NODE_ENV === "production") {
    return withDefaultMongoDatabase(PRODUCTION_DEFAULT_URI, databaseName);
  }

  const { MongoMemoryServer } = await import("mongodb-memory-server");
  const mongod = await MongoMemoryServer.create();
  fastify.addHook("onClose", async () => {
    await mongod.stop();
  });
  return withDefaultMongoDatabase(mongod.getUri(), databaseName);
}

/**
 * Options for {@link mongoPlugin}.
 */
export type MongoPluginOptions = {
  // Database name appended to the resolved URI
  databaseName: string;
} & ResolveMongoUriOptions;

/**
 * Registers `@fastify/mongodb` with a resolved connection URI.
 *
 * Resolves the URI via {@link resolveMongoUri} (same candidate selection and
 * fallback chain) and registers `@fastify/mongodb` with it, stopping the
 * in-memory server on `onClose` when one was spawned.
 *
 * Wrapped in `fastify-plugin` so the `fastify.mongo` decorator is visible to
 * sibling plugins and encapsulated routes.
 */
export const mongoPlugin = fp<MongoPluginOptions>(async (fastify, opts) => {
  const uri = await resolveMongoUri(fastify, opts.databaseName, opts);
  await fastify.register(mongodb, {
    url: uri,
    forceClose: true,
  });
});

export type InitMongoPluginOptions = {
  // MongoDB URI (Optional; non-test, from MONGO_URI; forwarded to mongoPlugin
  // which resolves the URI and registers @fastify/mongodb)
  mongoUri: string | undefined;
  // Test-only MongoDB URI (from MONGO_TEST_URI)
  mongoTestUri: string | undefined;
  // Test mode flag (from --test / opts.test)
  test?: boolean;
};

async function initializeCollections(fastify: FastifyInstance): Promise<void> {
  const db = fastify.mongo.db;
  if (!db) {
    throw new Error(
      "MongoDB database handle is unavailable; mongoPlugin did not connect. Check MONGO_URI and the MongoDB server.",
    );
  }

  const example = db.collection<Document>("example");
  await example.createIndex({ example: 1 });

  const events = db.collection<EventDocument>("events");
  await events.createIndex(
    { ownerUsername: 1, startsAt: 1, _id: 1 },
    { name: "events_owner_start" },
  );
  await events.createIndex(
    { ownerUsername: 1, updatedAt: 1, _id: 1 },
    { name: "events_owner_updated" },
  );
  await events.createIndex(
    { ownerUsername: 1, source: 1, externalId: 1 },
    {
      name: "events_manual_external_id",
      unique: true,
      partialFilterExpression: {
        source: "manual",
        externalId: { $type: "string" },
        importId: null,
      },
    },
  );
  await events.createIndex(
    {
      ownerUsername: 1,
      source: 1,
      externalId: 1,
      recurrenceId: 1,
      importId: 1,
    },
    {
      name: "events_import_identity",
      unique: true,
      partialFilterExpression: {
        externalId: { $type: "string" },
        importId: { $type: "objectId" },
      },
    },
  );
  await events.createIndex(
    { ownerUsername: 1, importId: 1 },
    { name: "events_owner_import" },
  );
  await events.createIndex(
    { ownerUsername: 1, operationId: 1 },
    {
      name: "events_owner_operation",
      unique: true,
      partialFilterExpression: { operationId: { $type: "string" } },
    },
  );

  const eventImports = db.collection<EventImportDocument>("eventImports");
  await eventImports.createIndex(
    { ownerUsername: 1, source: 1, contentHash: 1, optionsHash: 1 },
    {
      name: "event_import_content_options",
      unique: true,
      partialFilterExpression: { status: { $in: ["processing", "active"] } },
    },
  );
  await eventImports.createIndex(
    { ownerUsername: 1, importedAt: -1, _id: -1 },
    { name: "event_import_owner_list" },
  );
  await eventImports.createIndex(
    { status: 1, processingLeaseExpiresAt: 1 },
    { name: "event_import_recovery" },
  );

  const idempotencyRecords =
    db.collection<IdempotencyRecordDocument>("idempotencyRecords");
  await idempotencyRecords.createIndex(
    { ownerScope: 1, routeKey: 1, idempotencyKeyHash: 1 },
    { name: "idempotency_owner_route_key", unique: true },
  );
  await idempotencyRecords.createIndex(
    { expiresAt: 1 },
    { name: "idempotency_expires_at", expireAfterSeconds: 0 },
  );

  const coursePlans = db.collection<CoursePlanDocument>("coursePlans");
  await coursePlans.createIndex(
    { ownerUsername: 1, termCode: 1, status: 1 },
    { name: "course_plans_owner_term" },
  );

  const sharedPlans = db.collection<SharedPlanDocument>("sharedPlans");
  await sharedPlans.createIndex(
    { tokenHash: 1 },
    { unique: true, name: "shared_plan_token_hash" },
  );
  await sharedPlans.createIndex(
    { ownerUsername: 1, operationId: 1 },
    { unique: true, name: "shared_plan_owner_operation" },
  );
  await sharedPlans.createIndex(
    { ownerUsername: 1, planId: 1, createdAt: -1, shareId: -1 },
    { name: "shared_plan_owner_list" },
  );
  await sharedPlans.createIndex(
    { expiresAt: 1, revokedAt: 1 },
    { name: "shared_plan_expiry" },
  );
  const sectionDiscoverability = db.collection<SectionDiscoverabilityDocument>(
    "sectionDiscoverability",
  );
  await sectionDiscoverability.createIndex(
    { ownerUsername: 1, sectionId: 1 },
    { unique: true, name: "section_discoverability_owner_section" },
  );
  const sharingRateLimits =
    db.collection<SharingRateLimitDocument>("sharingRateLimits");
  await sharingRateLimits.createIndex(
    { keyHash: 1, windowStart: 1 },
    { unique: true, name: "sharing_rate_limit_bucket" },
  );
  await sharingRateLimits.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "sharing_rate_limit_expiry" },
  );
  await sectionDiscoverability.createIndex(
    { sectionId: 1, expiresAt: 1 },
    { name: "section_discoverability_section_expiry" },
  );
  await sectionDiscoverability.createIndex(
    { sectionId: 1, displayNameKey: 1, recordId: 1, expiresAt: 1 },
    { name: "section_discoverability_section_sort" },
  );
  await sectionDiscoverability.createIndex(
    { ownerUsername: 1, expiresAt: 1 },
    { name: "section_discoverability_owner_expiry" },
  );
  await coursePlans.createIndex(
    { ownerUsername: 1, updatedAt: -1, _id: -1 },
    { name: "course_plans_owner_updated" },
  );
  await coursePlans.createIndex(
    { ownerUsername: 1, termCode: 1 },
    {
      name: "course_plans_active_identity",
      unique: true,
      partialFilterExpression: { status: "active" },
    },
  );

  const academic = await initializeAcademicCollections(db);
  fastify.decorate("collections", {
    example,
    events,
    eventImports,
    idempotencyRecords,
    coursePlans,
    sharedPlans,
    sectionDiscoverability,
    sharingRateLimits,
    ...academic,
  });
}

/**
 * Connects to MongoDB and prepares the application collections.
 *
 * Resolves the connection URI through {@link mongoPlugin} (explicit
 * `MONGO_URI` / `MONGO_TEST_URI`, the Compose default in production, or an
 * in-memory MongoDB out of the box), then creates the collections and indexes
 * on `onReady`. Add your own collections and indexes in the `onReady` hook
 * below and extend the `fastify.collections` decorator.
 */
export default fp<InitMongoPluginOptions>(async (fastify, opts) => {
  await fastify.register(mongoPlugin, {
    databaseName: packageJson.name,
    mongoUri: opts.mongoUri,
    mongoTestUri: opts.mongoTestUri,
    test: opts.test,
  });

  fastify.addHook("onReady", async () => {
    await initializeCollections(fastify);
  });
});

declare module "fastify" {
  export interface FastifyInstance {
    collections: AcademicCollections & {
      example: Collection<Document>;
      events: Collection<EventDocument>;
      eventImports: Collection<EventImportDocument>;
      idempotencyRecords: Collection<IdempotencyRecordDocument>;
      coursePlans: Collection<CoursePlanDocument>;
      sharedPlans: Collection<SharedPlanDocument>;
      sectionDiscoverability: Collection<SectionDiscoverabilityDocument>;
      sharingRateLimits: Collection<SharingRateLimitDocument>;
    };
  }
}
