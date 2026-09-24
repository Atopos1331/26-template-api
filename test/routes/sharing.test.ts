import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { type Db, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import App from "../../src/app.js";
import { ACADEMIC_SOURCE } from "../../src/domain/academic.js";
import type { IdempotencyRecordDocument } from "../../src/plugins/init-mongo.js";
import { CourseCatalogRepository } from "../../src/repositories/course-catalog.js";
import { SharingService } from "../../src/services/sharing.js";

const alice = { authorization: "Bearer alice-dev-token" };
const bob = { authorization: "Bearer bob-dev-token" };
const termCode = "2530";
const batch = "batch-sharing";
const offeringId = `${ACADEMIC_SOURCE}:${termCode}:COMP2611:UNKNOWN`;
const bundleId = `${offeringId}:12345`;
const sectionId = `${offeringId}:12345`;

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
});

afterAll(async () => {
  await mongod?.stop();
});

async function buildApp(overrides: Record<string, unknown> = {}) {
  const app = Fastify({ pluginTimeout: 300_000 });
  await app.register(fp(App), {
    mongoUri: mongod.getUri(`sharing-${randomUUID()}`),
    mongoTestUri: undefined,
    authSkip: false,
    cursorSigningKey: "test-signing-key-with-at-least-32-bytes",
    autoPlanTokenSigningKey: "test-auto-plan-signing-key-with-32-bytes",
    appTimezone: "Asia/Hong_Kong",
    shareTokenReplayEncryptionKey: "test-share-replay-key-with-32-bytes!!",
    ...overrides,
  });
  await app.ready();
  return app;
}

async function seed(db: Db) {
  const key = {
    source: ACADEMIC_SOURCE,
    termCode,
    importBatchId: batch,
    retiredAt: null,
  };
  await db.collection("academicTerms").insertOne({
    ...key,
    activeImportBatchId: batch,
    importFence: 1,
    displayName: "2025-26 Spring",
    localizedName: "2025-26 Spring",
    season: "spring",
    academicYearStart: 2025,
    academicYearEnd: 2026,
    sortKey: 202530,
  });
  await db.collection("courses").insertOne({
    ...key,
    courseId: "COMP2611",
    courseCode: "COMP2611",
    title: "Computer Organization",
    credits: 3,
  });
  await db.collection("courseOfferings").insertOne({
    ...key,
    offeringId,
    courseId: "COMP2611",
    academicCareer: "UNKNOWN",
  });
  await db.collection("classSections").insertOne({
    ...key,
    sectionId,
    offeringId,
    classNbr: "12345",
    sectionCode: "L1",
    meetings: [
      {
        startDate: "2026-09-01",
        endDate: "2026-12-01",
        weekdays: ["TU"],
        startTime: "10:00",
        endTime: "11:00",
        timezone: "Asia/Hong_Kong",
        venue: "LT-A",
      },
    ],
    componentType: "LEC",
  });
  await db.collection("sectionBundles").insertOne({
    ...key,
    bundleId,
    offeringId,
    leadClassNbr: "12345",
    componentClassNbrs: ["12345"],
    componentTypes: ["LEC"],
    sectionLabels: ["L1"],
    derivedSchedule: {
      meetings: [
        {
          startDate: "2026-09-01",
          endDate: "2026-12-01",
          weekdays: ["TU"],
          startTime: "10:00",
          endTime: "11:00",
          timezone: "Asia/Hong_Kong",
          venue: "LT-A",
        },
      ],
    },
    source: ACADEMIC_SOURCE,
  });
}

async function createActivePlan(
  app: Awaited<ReturnType<typeof buildApp>>,
  owner: typeof alice,
) {
  const created = await app.inject({
    method: "POST",
    url: "/plans",
    headers: owner,
    payload: { name: `${owner === alice ? "Alice" : "Bob"} plan`, termCode },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().data.id;
  const item = await app.inject({
    method: "POST",
    url: `/plans/${id}/items`,
    headers: { ...owner, "if-match": '"1"' },
    payload: { offeringId, bundleId },
  });
  expect(item.statusCode).toBe(200);
  const active = await app.inject({
    method: "PATCH",
    url: `/plans/${id}`,
    headers: { ...owner, "if-match": '"2"' },
    payload: { status: "active" },
  });
  expect(active.statusCode).toBe(200);
  return id as string;
}

test("plan shares return a one-time token and an allowlisted read-only snapshot", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const planId = await createActivePlan(app, alice);
    const created = await app.inject({
      method: "POST",
      url: `/plans/${planId}/shares`,
      headers: { ...alice, "idempotency-key": "share-1" },
      payload: { expiresInSeconds: 3600 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json().data;
    expect(body.shareId).toBeString();
    expect(body.shareToken).toBeString();
    expect(body.snapshot).toMatchObject({
      displayLabel: "Alice plan",
      termSummary: "2025-26 Spring",
    });
    expect(body.snapshot.selectedCourses[0]).toMatchObject({
      courseCode: "COMP2611",
      title: "Computer Organization",
      sectionLabels: ["L1"],
    });
    expect(JSON.stringify(body)).not.toContain("alice");
    expect(JSON.stringify(body)).not.toContain("note");

    const token = body.shareToken as string;
    const stored = await app.mongo
      .db!.collection("sharedPlans")
      .findOne({ shareId: body.shareId });
    expect(stored?.tokenHash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(stored?.tokenHash).not.toBe(token);
    const idempotencyRecord = await app.mongo
      .db!.collection("idempotencyRecords")
      .findOne({
        routeKey: "POST /plans/:id/shares",
        idempotencyKeyHash: createHash("sha256")
          .update("share-1")
          .digest("hex"),
      });
    expect(
      (idempotencyRecord?.responseBody as Record<string, unknown>)?.shareToken,
    ).toBeUndefined();
    expect(idempotencyRecord?.encryptedOneTimeSecret).toBeString();
    const shared = await app.inject({ url: `/shared-plans/${token}` });
    expect(shared.statusCode).toBe(200);
    expect(shared.json().data).toEqual(body.snapshot);
    expect(shared.json().data.planId).toBeUndefined();

    const listed = await app.inject({
      url: `/plans/${planId}/shares`,
      headers: alice,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items[0].shareToken).toBeUndefined();
    expect(listed.json().items[0].tokenHash).toBeUndefined();

    const replay = await app.inject({
      method: "POST",
      url: `/plans/${planId}/shares`,
      headers: { ...alice, "idempotency-key": "share-1" },
      payload: { expiresInSeconds: 3600 },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(created.json());

    const modified = await app.inject({
      method: "PATCH",
      url: `/shared-plans/${token}`,
      payload: { name: "nope" },
    });
    expect(modified.statusCode).toBe(404);
  } finally {
    await app.close();
  }
});

test("revoked and archived plan shares are unreadable immediately", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const planId = await createActivePlan(app, alice);
    const created = await app.inject({
      method: "POST",
      url: `/plans/${planId}/shares`,
      headers: alice,
      payload: {},
    });
    const token = created.json().data.shareToken as string;
    const shareId = created.json().data.shareId as string;
    const revoked = await app.inject({
      method: "DELETE",
      url: `/plans/${planId}/shares/${shareId}`,
      headers: alice,
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      (await app.inject({ url: `/shared-plans/${token}` })).statusCode,
    ).toBe(404);

    const second = await app.inject({
      method: "POST",
      url: `/plans/${planId}/shares`,
      headers: alice,
      payload: {},
    });
    const secondToken = second.json().data.shareToken as string;
    const archived = await app.inject({
      method: "PATCH",
      url: `/plans/${planId}`,
      headers: { ...alice, "if-match": '"3"' },
      payload: { status: "archived" },
    });
    expect(archived.statusCode).toBe(200);
    expect(
      (await app.inject({ url: `/shared-plans/${secondToken}` })).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});

test("section classmates require opt-in and only expose current selected matches", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    await createActivePlan(app, alice);
    const bobPlanId = await createActivePlan(app, bob);
    const missing = await app.inject({
      url: `/sections/${sectionId}/classmates`,
      headers: alice,
    });
    expect(missing.statusCode).toBe(404);

    const invalidAlias = await app.inject({
      method: "POST",
      url: `/sections/${sectionId}/discoverability`,
      headers: bob,
      payload: { displayName: "<script>" },
    });
    expect(invalidAlias.statusCode).toBe(400);

    const bobOptIn = await app.inject({
      method: "POST",
      url: `/sections/${sectionId}/discoverability`,
      headers: bob,
      payload: { displayName: "Bob Alias" },
    });
    expect(bobOptIn.statusCode).toBe(200);
    const aliceOptIn = await app.inject({
      method: "POST",
      url: `/sections/${sectionId}/discoverability`,
      headers: alice,
      payload: { displayName: "Alice Alias" },
    });
    expect(aliceOptIn.statusCode).toBe(200);
    const classmates = await app.inject({
      url: `/sections/${sectionId}/classmates?limit=1`,
      headers: alice,
    });
    expect(classmates.statusCode).toBe(200);
    expect(classmates.json().items).toHaveLength(1);
    expect(classmates.json().items[0]).toMatchObject({
      displayName: "Bob Alias",
      sectionLabel: "L1",
    });
    expect(JSON.stringify(classmates.json())).not.toContain("alice");
    expect(JSON.stringify(classmates.json())).not.toContain("bob-dev-token");

    const bobPlan = await app.mongo
      .db!.collection("coursePlans")
      .findOne({ ownerUsername: "bob", termCode, status: "active" });
    await app.mongo
      .db!.collection("coursePlans")
      .insertOne({ ...bobPlan, _id: new ObjectId(), ownerUsername: "charlie" });
    await app.mongo.db!.collection("sectionDiscoverability").insertOne({
      _id: new ObjectId(),
      recordId: randomUUID(),
      ownerUsername: "charlie",
      sectionId,
      displayName: "Charlie Alias",
      displayNameKey: "charlie alias",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const firstPage = await app.inject({
      url: `/sections/${sectionId}/classmates?limit=1`,
      headers: alice,
    });
    expect(firstPage.json().page.hasMore).toBe(true);
    const secondPage = await app.inject({
      url: `/sections/${sectionId}/classmates?limit=1&cursor=${encodeURIComponent(firstPage.json().page.nextCursor)}`,
      headers: alice,
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    expect(secondPage.json().items[0].displayName).not.toBe(
      firstPage.json().items[0].displayName,
    );
    const tampered = `${firstPage.json().page.nextCursor.slice(0, -2)}aa`;
    expect(
      (
        await app.inject({
          url: `/sections/${sectionId}/classmates?cursor=${encodeURIComponent(tampered)}`,
          headers: alice,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `/sections/${sectionId}/classmates?cursor=${encodeURIComponent(firstPage.json().page.nextCursor)}`,
          headers: bob,
        })
      ).statusCode,
    ).toBe(400);

    const archivedBob = await app.inject({
      method: "PATCH",
      url: `/plans/${bobPlanId}`,
      headers: { ...bob, "if-match": '"3"' },
      payload: { status: "archived" },
    });
    expect(archivedBob.statusCode).toBe(200);
    const afterArchive = await app.inject({
      url: `/sections/${sectionId}/classmates`,
      headers: alice,
    });
    expect(
      afterArchive
        .json()
        .items.map((item: { displayName: string }) => item.displayName),
    ).toEqual(["Charlie Alias"]);

    await app.inject({
      method: "DELETE",
      url: `/sections/${sectionId}/discoverability`,
      headers: alice,
    });
    expect(
      (
        await app.inject({
          url: `/sections/${sectionId}/classmates`,
          headers: alice,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});

test("sharing rejects draft and stale plans, expires tokens, and limits public reads", async () => {
  const app = await buildApp({ shareReadsPerMinute: 1 });
  try {
    await seed(app.mongo.db!);
    const draft = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "Draft", termCode },
    });
    const draftShare = await app.inject({
      method: "POST",
      url: `/plans/${draft.json().data.id}/shares`,
      headers: alice,
      payload: {},
    });
    expect(draftShare.statusCode).toBe(409);
    expect(draftShare.json().error.code).toBe("shareable_plan_required");

    const planId = await createActivePlan(app, alice);
    await app.mongo
      .db!.collection("sectionBundles")
      .updateOne(
        { bundleId, importBatchId: batch },
        { $set: { retiredAt: new Date().toISOString() } },
      );
    const stale = await app.inject({
      method: "POST",
      url: `/plans/${planId}/shares`,
      headers: alice,
      payload: {},
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("stale_reference");
    expect(await app.mongo.db!.collection("sharedPlans").countDocuments()).toBe(
      0,
    );
  } finally {
    await app.close();
  }
});

test("public share reads are rate limited and expired tokens are indistinguishable from missing ones", async () => {
  const app = await buildApp({ shareReadsPerMinute: 1 });
  try {
    await seed(app.mongo.db!);
    const planId = await createActivePlan(app, alice);
    const created = await app.inject({
      method: "POST",
      url: `/plans/${planId}/shares`,
      headers: alice,
      payload: { expiresInSeconds: 3600 },
    });
    const token = created.json().data.shareToken as string;
    const first = await app.inject({ url: `/shared-plans/${token}` });
    expect(first.statusCode).toBe(200);
    const limited = await app.inject({ url: `/shared-plans/${token}` });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeString();

    const second = await app.inject({
      method: "POST",
      url: `/plans/${planId}/shares`,
      headers: alice,
      payload: {},
    });
    const expiredToken = second.json().data.shareToken as string;
    await app.mongo.db!.collection("sharingRateLimits").deleteMany({});
    await app.mongo
      .db!.collection("sharedPlans")
      .updateOne(
        { tokenHash: createHash("sha256").update(expiredToken).digest("hex") },
        { $set: { expiresAt: new Date(0) } },
      );
    const expired = await app.inject({ url: `/shared-plans/${expiredToken}` });
    await app.mongo.db!.collection("sharingRateLimits").deleteMany({});
    const missing = await app.inject({
      url: `/shared-plans/${"x".repeat(43)}`,
    });
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error.code).toBe(missing.json().error.code);
  } finally {
    await app.close();
  }
});

test("share creation recovers the same operation after an expired lease", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const planId = await createActivePlan(app, alice);
    const db = app.mongo.db!;
    const records =
      db.collection<IdempotencyRecordDocument>("idempotencyRecords");
    const key = "share-recovery";
    const keyHash = createHash("sha256").update(key).digest("hex");
    const now = new Date();
    const expiresInSeconds = 3600;

    const catalog = new CourseCatalogRepository(db);
    const activeTerm = catalog.activeTerm.bind(catalog);
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let calls = 0;
    catalog.activeTerm = async (termCodeValue) => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await firstGate;
      }
      return activeTerm(termCodeValue);
    };
    const service = new SharingService(
      db,
      db.collection("coursePlans"),
      db.collection("sharedPlans"),
      records,
      catalog,
      {
        defaultExpirySeconds: 604800,
        maxExpirySeconds: 2592000,
        discoverabilityDefaultExpirySeconds: 1209600,
        discoverabilityMaxExpirySeconds: 7776000,
        replayKey: "test-share-replay-key-with-32-bytes!!",
        cursorKey: "test-signing-key-with-at-least-32-bytes",
        cursorTtlSeconds: 900,
        shareReadsPerMinute: 60,
        friendSearchesPerMinute: 30,
        idempotencyRetentionSeconds: 86400,
        now: () => now,
      },
    );

    const firstRequest = service.create(
      "alice",
      planId,
      { expiresInSeconds },
      key,
    );
    await started;
    const initialRecord = await records.findOne({
      idempotencyKeyHash: keyHash,
    });
    expect(initialRecord?.operationId).toBeString();
    await records.updateOne(
      { idempotencyKeyHash: keyHash },
      {
        $set: { leaseExpiresAt: new Date(now.getTime() - 1000).toISOString() },
      },
    );
    const recovered = await service.create(
      "alice",
      planId,
      { expiresInSeconds },
      key,
    );
    releaseFirst();
    const first = await firstRequest;

    expect(first).toEqual(recovered);
    expect(await db.collection("sharedPlans").countDocuments()).toBe(1);
    const record = await records.findOne({ idempotencyKeyHash: keyHash });
    expect(record?.operationId).toBe(initialRecord?.operationId);
    expect(record?.claimToken).not.toBe(initialRecord?.claimToken);
    expect(record?.state).toBe("completed");
  } finally {
    await app.close();
  }
});

test("share snapshots derive meetings from active sections when bundles lack a schedule", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const planId = await createActivePlan(app, alice);
    await app.mongo
      .db!.collection("sectionBundles")
      .updateOne(
        { bundleId, importBatchId: batch },
        { $unset: { derivedSchedule: "" } },
      );
    const created = await app.inject({
      method: "POST",
      url: `/plans/${planId}/shares`,
      headers: alice,
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.snapshot.selectedCourses[0]).toMatchObject({
      meetings: [
        {
          startDate: "2026-09-01",
          startTime: "10:00",
          timezone: "Asia/Hong_Kong",
        },
      ],
      room: "LT-A",
    });
  } finally {
    await app.close();
  }
});
