import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import App from "../../src/app.js";
import { ACADEMIC_SOURCE } from "../../src/domain/academic.js";

const alice = { authorization: "Bearer alice-dev-token" };
const bob = { authorization: "Bearer bob-dev-token" };
const termCode = "2530";
const batch = "batch-1";
const offeringId = `${ACADEMIC_SOURCE}:${termCode}:COMP2611:UNKNOWN`;
const bundleId = `${offeringId}:12345`;
const offering2 = `${ACADEMIC_SOURCE}:${termCode}:COMP2612:UNKNOWN`;
const bundle2 = `${offering2}:12346`;
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
});
afterAll(async () => {
  await mongod?.stop();
});

async function buildApp() {
  const app = Fastify({ pluginTimeout: 300_000 });
  await app.register(fp(App), {
    mongoUri: mongod.getUri(`plans-${randomUUID()}`),
    mongoTestUri: undefined,
    authSkip: false,
    cursorSigningKey: "test-signing-key-with-at-least-32-bytes",
    appTimezone: "Asia/Hong_Kong",
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
    lastSuccessfulImportAt: "2026-09-23T10:00:00.000Z",
  };
  await db.collection("academicTerms").insertOne({
    source: ACADEMIC_SOURCE,
    termCode,
    activeImportBatchId: batch,
    importFence: 1,
    displayName: "2025-26 Spring",
    localizedName: "2025-26 Spring",
    season: "spring",
    academicYearStart: 2025,
    academicYearEnd: 2026,
    sortKey: 202530,
    timezone: "Asia/Hong_Kong",
  });
  await db.collection("courses").insertMany([
    {
      ...key,
      courseId: "COMP2611",
      courseCode: "COMP2611",
      title: "Computer Organization",
      credits: 3,
    },
    {
      ...key,
      courseId: "COMP2612",
      courseCode: "COMP2612",
      title: "Algorithms",
      credits: 3,
    },
  ]);
  await db.collection("courseOfferings").insertMany([
    { ...key, offeringId, courseId: "COMP2611", academicCareer: "UNKNOWN" },
    {
      ...key,
      offeringId: offering2,
      courseId: "COMP2612",
      academicCareer: "UNKNOWN",
    },
  ]);
  await db.collection("classSections").insertMany([
    {
      ...key,
      sectionId: `${offeringId}:12345`,
      offeringId,
      classNbr: "12345",
      sectionCode: "L1",
      meetings: [],
      componentType: "LEC",
    },
    {
      ...key,
      sectionId: `${offering2}:12346`,
      offeringId: offering2,
      classNbr: "12346",
      sectionCode: "L1",
      meetings: [],
      componentType: "LEC",
    },
  ]);
  await db.collection("sectionBundles").insertMany([
    {
      ...key,
      bundleId,
      offeringId,
      leadClassNbr: "12345",
      componentClassNbrs: ["12345"],
      componentTypes: ["LEC"],
      sectionLabels: ["L1"],
      derivedSchedule: { meetings: [] },
      source: ACADEMIC_SOURCE,
    },
    {
      ...key,
      bundleId: bundle2,
      offeringId: offering2,
      leadClassNbr: "12346",
      componentClassNbrs: ["12346"],
      componentTypes: ["LEC"],
      sectionLabels: ["L1"],
      derivedSchedule: { meetings: [] },
      source: ACADEMIC_SOURCE,
    },
  ]);
}

async function seedConflictingMeetings(db: Db) {
  const meeting = {
    startDate: "2026-09-01",
    endDate: "2026-12-01",
    weekdays: ["TU"],
    startTime: "10:00",
    endTime: "11:00",
    timezone: "Asia/Hong_Kong",
  };
  await db
    .collection("sectionBundles")
    .updateOne(
      { bundleId },
      { $set: { derivedSchedule: { meetings: [meeting] } } },
    );
  await db
    .collection("sectionBundles")
    .updateOne(
      { bundleId: bundle2 },
      { $set: { derivedSchedule: { meetings: [meeting] } } },
    );
}

test("course plans support owner-scoped CAS item mutations", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const created = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "Spring plan", termCode },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    const planId = created.json().data.id;

    const missing = await app.inject({
      method: "POST",
      url: `/plans/${planId}/items`,
      headers: alice,
      payload: { offeringId, bundleId },
    });
    expect(missing.statusCode).toBe(428);

    const added = await app.inject({
      method: "POST",
      url: `/plans/${planId}/items`,
      headers: { ...alice, "if-match": '"1"' },
      payload: { offeringId, bundleId, note: "Main section" },
    });
    expect(added.statusCode).toBe(200);
    expect(added.headers.etag).toBe('"2"');
    expect(added.json().data.items[0]).toMatchObject({
      courseCodeSnapshot: "COMP2611",
      sectionLabelsSnapshot: ["L1"],
      referenceState: "active",
      status: "selected",
    });

    const stale = await app.inject({
      method: "POST",
      url: `/plans/${planId}/items`,
      headers: { ...alice, "if-match": '"1"' },
      payload: { offeringId: offering2, bundleId: bundle2 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("concurrent_modification");

    const bobResult = await app.inject({
      url: `/plans/${planId}`,
      headers: bob,
    });
    expect(bobResult.statusCode).toBe(404);

    const listed = await app.inject({ url: "/plans", headers: alice });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items[0].itemCount).toBe(1);
  } finally {
    await app.close();
  }
});

test("active plan uniqueness and archive immutability are enforced", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const first = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "First", termCode },
    });
    const id = first.json().data.id;
    const active = await app.inject({
      method: "PATCH",
      url: `/plans/${id}`,
      headers: { ...alice, "if-match": '"1"' },
      payload: { status: "active" },
    });
    expect(active.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "Second", termCode },
    });
    expect(second.statusCode).toBe(201);
    const secondActive = await app.inject({
      method: "PATCH",
      url: `/plans/${second.json().data.id}`,
      headers: { ...alice, "if-match": '"1"' },
      payload: { status: "active" },
    });
    expect(secondActive.statusCode).toBe(409);
    expect(secondActive.json().error.code).toBe("active_plan_exists");

    const archived = await app.inject({
      method: "DELETE",
      url: `/plans/${id}`,
      headers: { ...alice, "if-match": '"2"' },
    });
    expect(archived.statusCode).toBe(204);
    const immutable = await app.inject({
      method: "PATCH",
      url: `/plans/${id}`,
      headers: { ...alice, "if-match": '"3"' },
      payload: { name: "changed" },
    });
    expect(immutable.statusCode).toBe(409);
    expect(immutable.json().error.code).toBe("readonly_resource");
  } finally {
    await app.close();
  }
});

test("promoting an alternative rejects a conflict with another selected bundle", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    await seedConflictingMeetings(app.mongo.db!);
    const created = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "Conflict", termCode },
    });
    const id = created.json().data.id;
    const selected = await app.inject({
      method: "POST",
      url: `/plans/${id}/items`,
      headers: { ...alice, "if-match": '"1"' },
      payload: { offeringId, bundleId },
    });
    expect(selected.statusCode).toBe(200);
    const alternative = await app.inject({
      method: "POST",
      url: `/plans/${id}/items`,
      headers: { ...alice, "if-match": '"2"' },
      payload: {
        offeringId: offering2,
        bundleId: bundle2,
        status: "alternative",
      },
    });
    expect(alternative.statusCode).toBe(200);
    const itemId = alternative
      .json()
      .data.items.find(
        (item: { bundleId: string }) => item.bundleId === bundle2,
      ).itemId;
    const promoted = await app.inject({
      method: "PATCH",
      url: `/plans/${id}/items/${itemId}`,
      headers: { ...alice, "if-match": '"3"' },
      payload: { status: "selected" },
    });
    expect(promoted.statusCode).toBe(409);
    expect(promoted.json().error.code).toBe("conflict_detected");
  } finally {
    await app.close();
  }
});

test("auto-plan apply does not revive a rejected bundle item", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const created = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "Rejected", termCode },
    });
    const id = created.json().data.id;
    const alternative = await app.inject({
      method: "POST",
      url: `/plans/${id}/items`,
      headers: { ...alice, "if-match": '"1"' },
      payload: { offeringId, bundleId, status: "alternative", note: "old" },
    });
    const itemId = alternative.json().data.items[0].itemId;
    const rejected = await app.inject({
      method: "PATCH",
      url: `/plans/${id}/items/${itemId}`,
      headers: { ...alice, "if-match": '"2"' },
      payload: { status: "rejected" },
    });
    expect(rejected.statusCode).toBe(200);
    const generated = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans`,
      headers: alice,
      payload: {
        includeCurrentSelected: false,
        courses: [{ courseCode: "COMP2611", required: true }],
      },
    });
    const token = generated.json().data.options[0].optionToken;
    const applied = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans/apply`,
      headers: {
        ...alice,
        "if-match": '"3"',
        "idempotency-key": "apply-rejected-1",
      },
      payload: { optionToken: token },
    });
    expect(applied.statusCode).toBe(200);
    const selected = applied
      .json()
      .data.items.find(
        (item: { bundleId: string; status: string }) =>
          item.bundleId === bundleId && item.status === "selected",
      );
    expect(selected.itemId).not.toBe(itemId);
    expect(selected.note).toBeUndefined();
  } finally {
    await app.close();
  }
});

test("auto-plan generation is read-only and apply is signed, conditional, and replayable", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const created = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "Auto", termCode },
    });
    const id = created.json().data.id;
    const generated = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans`,
      headers: alice,
      payload: {
        courses: [
          { courseCode: "COMP2611", required: true },
          { courseCode: "COMP2612" },
        ],
        mode: "coverage_first",
      },
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().data.options.length).toBeGreaterThan(0);
    expect(generated.json().data.options[0].fillerStatus).toBe("not_requested");
    expect(generated.json().data.planRevision).toBe(1);
    const token = generated.json().data.options[0].optionToken;
    const applied = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans/apply`,
      headers: {
        ...alice,
        "if-match": '"1"',
        "idempotency-key": "apply-auto-1",
      },
      payload: { optionToken: token },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.headers.etag).toBe('"2"');
    expect(applied.json().data.revision).toBe(2);
    expect(applied.json().data.items.length).toBeGreaterThan(0);
    expect(applied.json().data.items[0]).toMatchObject({
      referenceState: "active",
      course: { courseCode: "COMP2611" },
    });

    const applyRecord = await app.mongo
      .db!.collection("idempotencyRecords")
      .findOne({
        ownerScope: "alice",
        routeKey: "POST /plans/:id/auto-plans/apply",
      });
    expect(applyRecord).not.toBeNull();
    await app.mongo.db!.collection("idempotencyRecords").updateOne(
      { _id: applyRecord!._id },
      {
        $set: { state: "failed" },
        $unset: { responseBody: "", responseStatus: "", leaseExpiresAt: "" },
      },
    );
    await app.mongo
      .db!.collection("academicTerms")
      .updateOne(
        { termCode },
        { $set: { activeImportBatchId: "batch-next", importFence: 2 } },
      );

    const replay = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans/apply`,
      headers: {
        ...alice,
        "if-match": '"1"',
        "idempotency-key": "apply-auto-1",
      },
      payload: { optionToken: token },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(applied.json());
  } finally {
    await app.close();
  }
});

test("apply rechecks conflicts between selected bundles", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const created = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "Changing schedule", termCode },
    });
    const id = created.json().data.id;
    const generated = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans`,
      headers: alice,
      payload: {
        includeCurrentSelected: false,
        courses: [
          { courseCode: "COMP2611", required: true },
          { courseCode: "COMP2612", required: true },
        ],
      },
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().data.options[0].selected).toHaveLength(2);
    const token = generated.json().data.options[0].optionToken;
    await seedConflictingMeetings(app.mongo.db!);
    const applied = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans/apply`,
      headers: {
        ...alice,
        "if-match": '"1"',
        "idempotency-key": "apply-conflict-1",
      },
      payload: { optionToken: token },
    });
    expect(applied.statusCode).toBe(409);
    expect(applied.json().error.code).toBe("stale_recommendation");
  } finally {
    await app.close();
  }
});

test("applying an auto-plan rejects a newly imported blocking ICS event", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    await seedConflictingMeetings(app.mongo.db!);
    const created = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "ICS conflict", termCode },
    });
    const id = created.json().data.id;
    const generated = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans`,
      headers: alice,
      payload: {
        includeCurrentSelected: false,
        courses: [{ courseCode: "COMP2611", required: true }],
      },
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().data.options.length).toBeGreaterThan(0);
    const token = generated.json().data.options[0].optionToken;

    const imported = await app.inject({
      method: "POST",
      url: "/events/import/ics?from=2026-09-01&to=2026-12-02",
      headers: { ...alice, "content-type": "text/calendar" },
      payload: [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:blocking-class-time",
        "DTSTART:20261006T020000Z",
        "DTEND:20261006T030000Z",
        "SUMMARY:Imported class conflict",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    });
    expect(imported.statusCode).toBe(201);

    const applied = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans/apply`,
      headers: {
        ...alice,
        "if-match": '"1"',
        "idempotency-key": "apply-imported-ics-conflict",
      },
      payload: { optionToken: token },
    });
    expect(applied.statusCode).toBe(409);
    expect(applied.json().error.code).toBe("stale_recommendation");
  } finally {
    await app.close();
  }
});

test("recommendations omit an unavailable quota component from the score denominator", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const created = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "Recommendation", termCode },
    });
    const result = await app.inject({
      method: "POST",
      url: `/plans/${created.json().data.id}/recommendations`,
      headers: alice,
      payload: { targetCourseId: "COMP2611" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.items[0].score).toBe(85);
    expect(result.json().data.meta.scoreVersion).toBe(
      "recommendation-score-v2-quota-history-phase8",
    );
  } finally {
    await app.close();
  }
});

test("auto-plan diagnostics identify a valid course that is not offered this term", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    await app.mongo.db!.collection("courses").insertOne({
      source: ACADEMIC_SOURCE,
      termCode: "2430",
      importBatchId: "old-batch",
      retiredAt: null,
      courseId: "COMP3999",
      courseCode: "COMP3999",
      title: "Old course",
      credits: 3,
    });
    const created = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "Unavailable", termCode },
    });
    const result = await app.inject({
      method: "POST",
      url: `/plans/${created.json().data.id}/auto-plans`,
      headers: alice,
      payload: {
        includeCurrentSelected: false,
        courses: [{ courseCode: "COMP3999", required: true }],
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.searchStatus).toBe("infeasible");
    expect(result.json().data.diagnostics).toContainEqual(
      expect.objectContaining({ code: "course_not_offered" }),
    );
  } finally {
    await app.close();
  }
});

test("zero remaining without capacity is unknown quota, not a full section", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    await app.mongo.db!.collection("latestQuotas").insertOne({
      source: ACADEMIC_SOURCE,
      sectionId: `${offeringId}:12345`,
      snapshotId: "quota-unknown-capacity",
      remaining: 0,
      capacity: null,
      open: true,
    });
    const created = await app.inject({
      method: "POST",
      url: "/plans",
      headers: alice,
      payload: { name: "Unknown quota", termCode },
    });
    const id = created.json().data.id;
    const excluded = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans`,
      headers: alice,
      payload: {
        allowFullWaitlist: true,
        unknownQuotaPolicy: "exclude",
        courses: [{ courseCode: "COMP2611", required: true }],
      },
    });
    expect(excluded.statusCode).toBe(200);
    expect(excluded.json().data.searchStatus).toBe("infeasible");

    const allowed = await app.inject({
      method: "POST",
      url: `/plans/${id}/auto-plans`,
      headers: alice,
      payload: {
        allowFullWaitlist: true,
        unknownQuotaPolicy: "allow",
        courses: [{ courseCode: "COMP2611", required: true }],
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().data.options).toHaveLength(1);
    expect(allowed.json().data.options[0].quotaBottlenecks[0].unknown).toBe(
      true,
    );
  } finally {
    await app.close();
  }
});
