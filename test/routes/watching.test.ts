import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import App from "../../src/app.js";
import { ACADEMIC_SOURCE } from "../../src/domain/academic.js";
import { WatchingService } from "../../src/services/watching.js";

const alice = { authorization: "Bearer alice-dev-token" };
const bob = { authorization: "Bearer bob-dev-token" };
const termCode = "2530";
const courseId = "COMP2611";
const offeringId = `${termCode}:${courseId}`;
const sectionId = `${offeringId}:12345`;
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
    mongoUri: mongod.getUri(`watching-${randomUUID()}`),
    mongoTestUri: undefined,
    authSkip: false,
    cursorSigningKey: "test-signing-key-with-at-least-32-bytes",
  });
  await app.ready();
  return app;
}

async function seed(db: Db) {
  const key = {
    source: ACADEMIC_SOURCE,
    termCode,
    importBatchId: "active",
    retiredAt: null,
  };
  await db.collection("academicTerms").insertOne({
    source: ACADEMIC_SOURCE,
    termCode,
    activeImportBatchId: "active",
    importFence: 1,
  });
  await db.collection("courses").insertOne({
    ...key,
    courseId,
    courseCode: courseId,
    subject: "COMP",
    catalogNumber: "2611",
  });
  await db.collection("courseOfferings").insertOne({
    ...key,
    offeringId,
    courseId,
  });
  await db.collection("classSections").insertOne({
    ...key,
    sectionId,
    offeringId,
    classNbr: "12345",
    meetings: [],
  });
}

test("watch creation, owner isolation, missing quota quality, and deletion are consistent", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const created = await app.inject({
      method: "POST",
      url: `/courses/${courseId}/watch?termCode=${termCode}`,
      headers: alice,
      payload: { notificationPreference: "in_app" },
    });
    expect(created.statusCode).toBe(200);
    const first = created.json().data;
    expect(first).toMatchObject({
      targetType: "course",
      targetId: courseId,
      termCode,
      notificationPreference: "in_app",
    });

    const duplicate = await app.inject({
      method: "POST",
      url: `/courses/${courseId}/watch?termCode=${termCode}`,
      headers: alice,
      payload: { notificationPreference: "in_app" },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().data.watchId).toBe(first.watchId);

    const aliceList = await app.inject({
      url: "/watching",
      headers: alice,
    });
    expect(aliceList.statusCode).toBe(200);
    expect(aliceList.json().items).toHaveLength(1);
    expect(aliceList.json().items[0]).toMatchObject({
      watchId: first.watchId,
      quotaSummary: { sections: 1, missingSections: 1, observedSections: 0 },
      dataQuality: ["quota_missing"],
    });

    const bobList = await app.inject({ url: "/watching", headers: bob });
    expect(bobList.statusCode).toBe(200);
    expect(bobList.json().items).toHaveLength(0);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/courses/${courseId}/watch?termCode=${termCode}`,
      headers: alice,
    });
    expect(deleted.statusCode).toBe(204);
    const deletedAgain = await app.inject({
      method: "DELETE",
      url: `/courses/${courseId}/watch?termCode=${termCode}`,
      headers: alice,
    });
    expect(deletedAgain.statusCode).toBe(204);

    const sectionWatch = await app.inject({
      method: "POST",
      url: `/sections/${sectionId}/watch`,
      headers: alice,
      payload: {},
    });
    expect(sectionWatch.statusCode).toBe(200);
    expect(sectionWatch.json().data.targetType).toBe("section");
  } finally {
    await app.close();
  }
});

test("watch creation retries a duplicate insert and a concurrent deletion", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const initial = await app.inject({
      method: "POST",
      url: `/courses/${courseId}/watch?termCode=${termCode}`,
      headers: alice,
      payload: { notificationPreference: "none" },
    });
    expect(initial.statusCode).toBe(200);
    const db = app.mongo.db!;
    const watches = db.collection("courseWatches");
    const identity = {
      ownerUsername: "alice",
      termCode,
      targetType: "course",
      targetId: courseId,
    };
    const settings = {
      cursorKey: "test-signing-key-with-at-least-32-bytes",
      cursorTtlSeconds: 900,
      quotaTtlSeconds: 900,
    };
    let staleRead = true;
    const duplicateDb = {
      collection(name: string) {
        if (name !== "courseWatches") return db.collection(name);
        return {
          findOne: async () => {
            if (staleRead) {
              staleRead = false;
              return null;
            }
            return watches.findOne(identity);
          },
          insertOne: watches.insertOne.bind(watches),
          findOneAndUpdate: watches.findOneAndUpdate.bind(watches),
        };
      },
    } as unknown as Db;
    const activated = await new WatchingService(
      duplicateDb,
      settings,
    ).createCourseWatch("alice", courseId, termCode, "in_app");
    expect(activated.watchId).toBe(initial.json().data.watchId);
    expect(activated.notificationPreference).toBe("in_app");
    expect((await watches.findOne(identity))?.notificationPreference).toBe(
      "in_app",
    );

    const deletedDb = {
      collection(name: string) {
        if (name !== "courseWatches") return db.collection(name);
        return {
          findOne: watches.findOne.bind(watches),
          insertOne: watches.insertOne.bind(watches),
          findOneAndUpdate: async () => {
            await watches.deleteOne(identity);
            return null;
          },
        };
      },
    } as unknown as Db;
    const recreated = await new WatchingService(
      deletedDb,
      settings,
    ).createCourseWatch("alice", courseId, termCode, "none");
    expect(recreated.watchId).not.toBe(activated.watchId);
    expect(recreated.notificationPreference).toBe("none");
    expect(await watches.countDocuments(identity)).toBe(1);
  } finally {
    await app.close();
  }
});

test("watching cursors stay within their list and filters and expire on time", async () => {
  const app = await buildApp();
  try {
    await seed(app.mongo.db!);
    const now = new Date("2026-09-24T12:00:00.000Z");
    await app.mongo.db!.collection("courseWatches").insertMany([
      {
        watchId: "watch-course-1",
        ownerUsername: "alice",
        targetType: "course",
        targetId: courseId,
        termCode,
        notificationPreference: "none",
        baselineRecordedAt: now.toISOString(),
        baselineBySection: {},
        createdAt: "2026-09-24T11:00:01.000Z",
        updatedAt: now.toISOString(),
      },
      {
        watchId: "watch-course-2",
        ownerUsername: "alice",
        targetType: "course",
        targetId: "COMP2612",
        termCode,
        notificationPreference: "none",
        baselineRecordedAt: now.toISOString(),
        baselineBySection: {},
        createdAt: "2026-09-24T11:00:02.000Z",
        updatedAt: now.toISOString(),
      },
    ]);
    const first = await app.inject({
      url: "/watching?targetType=course&limit=1",
      headers: alice,
    });
    expect(first.statusCode).toBe(200);
    const cursor = first.json().page.nextCursor as string;
    expect(cursor).toBeTruthy();

    const next = await app.inject({
      url: `/watching?targetType=course&limit=1&cursor=${cursor}`,
      headers: alice,
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().items).toHaveLength(1);
    for (const url of [
      `/watching?limit=1&cursor=${cursor}`,
      `/watching?targetType=section&cursor=${cursor}`,
      `/watching/notifications?cursor=${cursor}`,
    ]) {
      const reused = await app.inject({ url, headers: alice });
      expect(reused.statusCode).toBe(400);
      expect(reused.json().error.code).toBe("invalid_cursor");
    }

    let clock = new Date();
    const service = new WatchingService(app.mongo.db!, {
      cursorKey: "test-signing-key-with-at-least-32-bytes",
      cursorTtlSeconds: 1,
      quotaTtlSeconds: 900,
      now: () => clock,
    });
    const page = await service.list("alice", { limit: 1 });
    clock = new Date(clock.getTime() + 1000);
    await expect(
      service.list("alice", { limit: 1, cursor: page.page.nextCursor! }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  } finally {
    await app.close();
  }
});

test("watching list propagates database failures during course lookup", async () => {
  const failure = new Error("academic term lookup failed");
  const db = {
    collection(name: string) {
      if (name === "courseWatches")
        return {
          find: () => ({
            sort: () => ({
              limit: () => ({
                toArray: async () => [
                  {
                    watchId: "watch-1",
                    ownerUsername: "alice",
                    targetType: "course",
                    targetId: courseId,
                    termCode,
                    notificationPreference: "none",
                    baselineRecordedAt: "2026-09-24T12:00:00.000Z",
                    baselineBySection: {},
                    createdAt: "2026-09-24T12:00:00.000Z",
                    updatedAt: "2026-09-24T12:00:00.000Z",
                  },
                ],
              }),
            }),
          }),
        };
      if (name === "academicTerms")
        return {
          findOne: async () => {
            throw failure;
          },
        };
      throw new Error(`Unexpected collection: ${name}`);
    },
  } as unknown as Db;
  const service = new WatchingService(db, {
    cursorKey: "test-signing-key-with-at-least-32-bytes",
    cursorTtlSeconds: 900,
    quotaTtlSeconds: 900,
  });
  await expect(service.list("alice", { limit: 1 })).rejects.toBe(failure);
});

test("a course watch summarizes quota per component instead of sampling one section", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    const key = {
      source: ACADEMIC_SOURCE,
      termCode,
      importBatchId: "active",
      retiredAt: null,
    };
    await db.collection("academicTerms").insertOne({
      source: ACADEMIC_SOURCE,
      termCode,
      activeImportBatchId: "active",
      importFence: 1,
    });
    await db.collection("courses").insertOne({
      ...key,
      courseId,
      courseCode: courseId,
      subject: "COMP",
      catalogNumber: "2611",
    });
    await db.collection("courseOfferings").insertOne({
      ...key,
      offeringId,
      courseId,
    });

    // Two lectures (one tight), three tutorials (one genuinely full, one whose
    // capacity is unknown) and two labs, one of which has no observation.
    const sections = [
      { classNbr: "1", componentType: "LEC", capacity: 100, remaining: 48 },
      { classNbr: "2", componentType: "LEC", capacity: 100, remaining: 2 },
      { classNbr: "3", componentType: "TUT", capacity: 30, remaining: 0 },
      { classNbr: "4", componentType: "TUT", capacity: 30, remaining: 25 },
      // Zero remaining without a capacity is unknown quota, not a full section.
      { classNbr: "5", componentType: "TUT", capacity: null, remaining: 0 },
      {
        classNbr: "6",
        componentType: "LAB",
        capacity: 20,
        remaining: 5,
        waitlisted: 3,
      },
      { classNbr: "7", componentType: "LAB", observed: false },
    ];
    await db.collection("classSections").insertMany(
      sections.map((section) => ({
        ...key,
        sectionId: `${offeringId}:${section.classNbr}`,
        offeringId,
        classNbr: section.classNbr,
        componentType: section.componentType,
        meetings: [],
      })),
    );
    const observedAt = "2026-09-24T12:00:00.000Z";
    await db.collection("latestQuotas").insertMany(
      sections
        .filter((section) => section.observed !== false)
        .map((section) => ({
          source: ACADEMIC_SOURCE,
          sectionId: `${offeringId}:${section.classNbr}`,
          snapshotId: `${offeringId}:${section.classNbr}@${observedAt}`,
          capacity: section.capacity,
          remaining: section.remaining,
          waitlisted: section.waitlisted ?? 0,
          observedAt,
        })),
    );

    const created = await app.inject({
      method: "POST",
      url: `/courses/${courseId}/watch?termCode=${termCode}`,
      headers: alice,
      payload: { notificationPreference: "in_app" },
    });
    expect(created.statusCode).toBe(200);

    const listed = await app.inject({
      url: `/watching?termCode=${termCode}`,
      headers: alice,
    });
    expect(listed.statusCode).toBe(200);
    const item = listed.json().items[0];

    // The unobserved lab remains in the coverage count.
    expect(item.quotaSummary.components).toMatchObject([
      {
        componentType: "LAB",
        sections: 2,
        observed: 1,
        missing: 1,
        full: 0,
        unknown: 0,
        remainingMin: 5,
        remainingMax: 5,
        waitlisted: 3,
      },
      {
        componentType: "LEC",
        sections: 2,
        observed: 2,
        missing: 0,
        full: 0,
        unknown: 0,
        remainingMin: 2,
        remainingMax: 48,
        waitlisted: 0,
      },
      {
        componentType: "TUT",
        sections: 3,
        observed: 3,
        missing: 0,
        full: 1,
        unknown: 1,
        remainingMin: 0,
        remainingMax: 25,
        waitlisted: 0,
      },
    ]);
    expect(item.quotaSummary).toMatchObject({
      sections: 7,
      observedSections: 6,
      missingSections: 1,
      full: 1,
      unknown: 1,
      remainingMin: 0,
      remainingMax: 48,
      waitlisted: 3,
      observedAt,
    });
    // The single-sample field was removed: reading it as a course total was the
    // bug this summary replaces.
    expect(item).not.toHaveProperty("latestQuota");
  } finally {
    await app.close();
  }
});

test("notification cursors respect unread filters and read timestamps are stable", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    const createdAt = "2026-09-24T12:00:00.000Z";
    await db.collection("watchNotifications").insertMany(
      ["notice-1", "notice-2"].map((notificationId) => ({
        notificationId,
        ownerUsername: "alice",
        watchId: "watch-1",
        termCode,
        targetType: "section",
        targetId: sectionId,
        changeType: "seats_available",
        beforeState: {},
        afterState: {},
        observedAt: createdAt,
        dedupeKey: notificationId,
        readAt: null,
        createdAt,
      })),
    );
    const first = await app.inject({
      url: "/watching/notifications?unreadOnly=true&limit=1",
      headers: alice,
    });
    expect(first.statusCode).toBe(200);
    const cursor = first.json().page.nextCursor as string;
    const reused = await app.inject({
      url: `/watching/notifications?cursor=${cursor}`,
      headers: alice,
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error.code).toBe("invalid_cursor");

    let now = new Date("2026-09-24T13:00:00.000Z");
    const service = new WatchingService(db, {
      cursorKey: "test-signing-key-with-at-least-32-bytes",
      cursorTtlSeconds: 900,
      quotaTtlSeconds: 900,
      now: () => now,
    });
    const acknowledged = await service.acknowledge("alice", "notice-1");
    now = new Date("2026-09-24T14:00:00.000Z");
    const repeated = await service.acknowledge("alice", "notice-1");
    expect(repeated.readAt).toBe(acknowledged.readAt);
    expect(repeated.readAt).toBe("2026-09-24T13:00:00.000Z");
    await expect(service.acknowledge("bob", "notice-1")).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    await app.close();
  }
});
