import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import App from "../src/app.js";
import {
  ACADEMIC_SOURCE,
  type AcademicError,
  academicIdentity,
} from "../src/domain/academic.js";
import {
  FixtureQuotaSource,
  parseUstQuota,
  type QuotaObservation,
  QuotaProviderError,
  type QuotaSource,
  UstQuotaSource,
} from "../src/providers/ust-quota.js";
import {
  enqueueQuotaRefreshJob,
  recordQuotaFailure,
  saveQuotaObservation,
} from "../src/repositories/quotas.js";
import { AcademicService } from "../src/services/academic.js";
import { AcademicRefreshWorker } from "../src/workers/academic-refresh.js";

const termCode = "2530";
const offeringId = `${termCode}:COMP2611`;
const sectionId = `${offeringId}:12345`;
const timestamp = "2026-09-23T10:00:00.000Z";
const auth = { authorization: "Bearer alice-dev-token" };
let mongod: MongoMemoryServer;

test("academic IDs omit the source prefix and resolve source from the API", () => {
  expect(academicIdentity("2530:COMP2611", "offering")).toEqual({
    source: ACADEMIC_SOURCE,
    termCode: "2530",
  });
  expect(academicIdentity("2530:COMP2611:12345", "section")).toEqual({
    source: ACADEMIC_SOURCE,
    termCode: "2530",
  });
  expect(() =>
    academicIdentity("ust-class-schedule:2530:COMP2611", "offering"),
  ).toThrow("Invalid academic ID");
});

test("academic worker does not claim when shutdown has started", async () => {
  let sourceCalls = 0;
  const worker = new AcademicRefreshWorker(
    {} as Db,
    {
      fetchQuota: async () => {
        sourceCalls += 1;
        throw new Error("should not fetch during shutdown");
      },
    },
    {
      maxAttempts: 3,
      leaseSeconds: 60,
      failureCooldownSeconds: 3600,
      quotaMinIntervalSeconds: 300,
      shouldStop: () => true,
    },
  );

  expect(await worker.runOne()).toBe(false);
  expect(sourceCalls).toBe(0);
});

test("academic worker stops between watch scanning and job claiming", async () => {
  let stopping = false;
  const collections: string[] = [];
  const db = {
    collection(name: string) {
      collections.push(name);
      if (name !== "courseWatches")
        throw new Error(`unexpected collection access: ${name}`);
      return {
        find: () => ({
          toArray: async () => {
            stopping = true;
            return [];
          },
        }),
      };
    },
  } as unknown as Db;
  const worker = new AcademicRefreshWorker(
    db,
    {
      fetchQuota: async () => {
        throw new Error("should not fetch");
      },
    },
    {
      maxAttempts: 3,
      leaseSeconds: 60,
      failureCooldownSeconds: 3600,
      quotaMinIntervalSeconds: 300,
      shouldStop: () => stopping,
    },
  );

  expect(await worker.runOne()).toBe(false);
  expect(collections).toEqual(["courseWatches"]);
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
});
afterAll(async () => {
  await mongod?.stop();
});

async function buildApp(currentTermCode?: string) {
  const app = Fastify({ pluginTimeout: 300_000 });
  await app.register(fp(App), {
    mongoUri: mongod.getUri(`academic-${randomUUID()}`),
    mongoTestUri: undefined,
    authSkip: false,
    cursorSigningKey: "test-signing-key-with-at-least-32-bytes",
    academicCurrentTermCode: currentTermCode,
  });
  await app.ready();
  return app;
}

async function seed(db: Db) {
  await db.collection("academicTerms").insertOne({
    source: ACADEMIC_SOURCE,
    termCode,
    activeImportBatchId: "active",
    importFence: 1,
    displayName: "2025-26 Spring",
    localizedName: "2025-26 Spring",
    season: "spring",
    academicYearStart: 2025,
    academicYearEnd: 2026,
    sortKey: 202530,
    timezone: "Asia/Hong_Kong",
    providerCurrent: true,
    providerSelectable: true,
    providerSignalsObservedAt: new Date().toISOString(),
    lastSuccessfulImportAt: timestamp,
  });
  for (const batch of ["active", "staged"]) {
    const key = {
      source: ACADEMIC_SOURCE,
      termCode,
      importBatchId: batch,
      retiredAt: null,
      lastSuccessfulImportAt: timestamp,
      updatedAt: timestamp,
    };
    await db.collection("courses").insertMany([
      {
        ...key,
        courseId: "COMP2611",
        courseCode: "COMP2611",
        subject: "COMP",
        catalogNumber: "2611",
        title: batch === "active" ? "Computer Organization" : "Staged title",
        credits: 3,
        description: null,
        longDescription: null,
        prerequisites: [],
        corequisites: [],
        exclusions: [],
        previousCourseCode: null,
        attributes: {},
      },
      {
        ...key,
        courseId: "COMP2612",
        courseCode: "COMP2612",
        subject: "COMP",
        catalogNumber: "2612",
        title: "Algorithms",
        credits: 3,
      },
    ]);
    await db.collection("courseOfferings").insertMany([
      {
        ...key,
        offeringId,
        courseId: "COMP2611",
        sourceCourseId: "COMP2611",
      },
      {
        ...key,
        offeringId: `${termCode}:COMP2612`,
        courseId: "COMP2612",
        sourceCourseId: "COMP2612",
      },
    ]);
    await db.collection("classSections").insertOne({
      ...key,
      sectionId,
      offeringId,
      classNbr: "12345",
      sectionCode: "L2",
      classType: null,
      componentType: "LEC",
      associatedClass: null,
      instructors: [],
      meetings: [],
      consentRequired: null,
      remarks: null,
    });
    await db.collection("sectionBundles").insertOne({
      ...key,
      bundleId: `${offeringId}:12345`,
      offeringId,
      leadClassNbr: "12345",
      componentClassNbrs: ["12345"],
      componentTypes: ["LEC"],
      sectionLabels: ["L2"],
      bindingGroup: null,
      derivedSchedule: { meetings: [] },
    });
  }
}

function observation(observedAt: string, remaining = 20): QuotaObservation {
  return {
    snapshotId: `${sectionId}@${observedAt}`,
    sectionId,
    source: ACADEMIC_SOURCE,
    capacity: 120,
    enrolled: 120 - remaining,
    remaining,
    waitlisted: 0,
    reserveCapacity: null,
    observedAt,
  };
}

function service(db: Db, now: () => Date) {
  return new AcademicService(db, {
    structureTtlSeconds: 86400,
    quotaTtlSeconds: 900,
    cursorKey: "test-signing-key-with-at-least-32-bytes",
    cursorTtlSeconds: 900,
    now,
  });
}

function worker(db: Db, source: QuotaSource, now: () => Date, maxAttempts = 3) {
  return new AcademicRefreshWorker(db, source, {
    maxAttempts,
    leaseSeconds: 60,
    failureCooldownSeconds: 3600,
    quotaMinIntervalSeconds: 300,
    now,
  });
}

test("quota parser selects the matching course and ignores nested detail text", async () => {
  const html = await Bun.file(
    new URL("../tools/course-data/fixtures/sample.html", import.meta.url),
  ).text();
  const target = {
    termCode,
    subject: "COMP",
    courseCode: "COMP2611",
    sectionId,
    classNbr: "12345",
  };
  expect(parseUstQuota(html, target, timestamp).remaining).toBe(20);
  expect(() =>
    parseUstQuota(html, { ...target, courseCode: "COMP2612" }, timestamp),
  ).toThrow("SECTION_NOT_IN_PROVIDER");
  const detail = html.replace(
    "<td>120</td>",
    '<td>120<span class="quotadetail">hidden 999</span></td>',
  );
  expect(parseUstQuota(detail, target, timestamp).capacity).toBe(120);
});

test("HTTP quota source retries transient errors and bounds response size", async () => {
  const html = await Bun.file(
    new URL("../tools/course-data/fixtures/sample.html", import.meta.url),
  ).text();
  const target = {
    termCode,
    subject: "COMP",
    courseCode: "COMP2611",
    sectionId,
    classNbr: "12345",
  };
  let calls = 0;
  const source = new UstQuotaSource({
    minIntervalMs: 0,
    retries: 1,
    sleep: async () => {},
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response("busy", { status: 429 })
        : new Response(html);
    },
  });
  expect((await source.fetchQuota(target)).remaining).toBe(20);
  expect(calls).toBe(2);
  const oversized = new UstQuotaSource({
    maxBytes: 10,
    retries: 0,
    fetchImpl: async () => new Response(html),
  });
  await expect(oversized.fetchQuota(target)).rejects.toMatchObject({
    code: "RESPONSE_TOO_LARGE",
    retryable: false,
  });
});

test("academic routes enforce auth and read one active batch", async () => {
  const app = await buildApp(termCode);
  try {
    expect(
      (await app.inject({ url: `/terms/${termCode}/courses`, headers: auth }))
        .statusCode,
    ).toBe(503);
    await seed(app.mongo.db!);
    expect((await app.inject({ url: "/terms" })).statusCode).toBe(401);
    const terms = await app.inject({ url: "/terms", headers: auth });
    expect(terms.statusCode).toBe(200);
    expect(terms.json().items[0].displayName).toBe("2025-26 Spring");
    expect(terms.json().items[0].isCurrent).toBe(true);
    const first = await app.inject({
      url: `/terms/${termCode}/courses?limit=1`,
      headers: auth,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items[0].title).toBe("Computer Organization");
    expect(first.json().items[0].sectionCount).toBe(1);
    expect(first.json().page.hasMore).toBe(true);
    const cursor = first.json().page.nextCursor;
    const next = await app.inject({
      url: `/terms/${termCode}/courses?limit=1&cursor=${encodeURIComponent(cursor)}`,
      headers: auth,
    });
    expect(next.json().items[0].courseCode).toBe("COMP2612");
    expect(next.json().items[0].sectionCount).toBe(0);
    const changedFilter = await app.inject({
      url: `/terms/${termCode}/courses?cursor=${encodeURIComponent(cursor)}&subject=MATH`,
      headers: auth,
    });
    expect(changedFilter.statusCode).toBe(400);
    const offering = await app.inject({
      url: `/offerings/${offeringId}`,
      headers: auth,
    });
    expect(offering.statusCode).toBe(200);
    expect(offering.json().data.course.title).toBe("Computer Organization");
    expect(offering.json().data.sections[0].classNbr).toBe("12345");
    const bundles = await app.inject({
      url: `/offerings/${offeringId}/bundles`,
      headers: auth,
    });
    expect(bundles.json().items).toHaveLength(1);
    expect(bundles.json().items[0].source).toBe("derived");
    await app.mongo.db!.collection("sectionBundles").updateOne(
      { offeringId, importBatchId: "active" },
      {
        $set: {
          bindingSource: "operator-verified",
          bindingEvidence: "Registrar check",
        },
      },
    );
    const verifiedBundles = await app.inject({
      url: `/offerings/${offeringId}/bundles`,
      headers: auth,
    });
    expect(verifiedBundles.json().items[0]).toMatchObject({
      source: "operator-verified",
      bindingEvidence: "Registrar check",
    });
    const filtered = await app.inject({
      url: `/terms/${termCode}/courses?subject=COMP&catalogNumber=2612&search=algo`,
      headers: auth,
    });
    expect(
      filtered
        .json()
        .items.map((item: { courseCode: string }) => item.courseCode),
    ).toEqual(["COMP2612"]);
    await app.mongo
      .db!.collection("academicTerms")
      .updateOne(
        { source: ACADEMIC_SOURCE, termCode },
        { $set: { activeImportBatchId: "staged" } },
      );
    const switched = await app.inject({
      url: `/offerings/${offeringId}`,
      headers: auth,
    });
    expect(switched.json().data.course.title).toBe("Staged title");
    const stagedSearch = await app.inject({
      url: `/terms/${termCode}/courses?search=staged`,
      headers: auth,
    });
    expect(stagedSearch.json().items).toHaveLength(1);
    const literalSearch = await app.inject({
      url: `/terms/${termCode}/courses?search=2611%20computer`,
      headers: auth,
    });
    expect(literalSearch.json().items).toHaveLength(0);
    const punctuation = await app.inject({
      url: `/terms/${termCode}/courses?search=comp.`,
      headers: auth,
    });
    expect(punctuation.json().items).toHaveLength(0);
    expect(
      (await app.inject({ url: "/terms/2630/courses", headers: auth }))
        .statusCode,
    ).toBe(404);
    const openapi = (await app.inject({ url: "/documentation/json" })).json();
    expect(
      Object.keys(openapi.paths).some((path) => path.includes("refresh")),
    ).toBe(false);
  } finally {
    await app.close();
  }
});

test("mixed batches expose stale resources in page and offering metadata", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    const old = "2026-09-20T10:00:00.000Z";
    await db
      .collection("courseOfferings")
      .updateOne(
        { offeringId, importBatchId: "active" },
        { $set: { lastSuccessfulImportAt: old } },
      );
    await db
      .collection("classSections")
      .updateOne(
        { sectionId, importBatchId: "active" },
        { $set: { lastSuccessfulImportAt: old } },
      );
    await db
      .collection("sectionBundles")
      .updateOne(
        { offeringId, importBatchId: "active" },
        { $set: { lastSuccessfulImportAt: old } },
      );
    const api = service(db, () => new Date("2026-09-23T10:01:00.000Z"));
    expect(
      (await api.listCourses(termCode, { limit: 10 })).meta.freshness.isStale,
    ).toBe(true);
    await db
      .collection("courseOfferings")
      .updateOne(
        { offeringId, importBatchId: "active" },
        { $set: { lastSuccessfulImportAt: timestamp } },
      );
    const page = await api.listCourses(termCode, { limit: 10 });
    expect(page.items[0]?.freshness.isStale).toBe(true);
    expect(page.meta.freshness.isStale).toBe(true);
    expect((await api.getOffering(offeringId)).meta.freshness.isStale).toBe(
      true,
    );
    expect((await api.listBundles(offeringId)).meta.freshness.isStale).toBe(
      true,
    );
    const terms = await api.listTerms(10);
    expect(terms.meta.freshness.isStale).toBe(false);
    await db
      .collection("classSections")
      .updateOne(
        { sectionId, importBatchId: "active" },
        { $set: { lastSuccessfulImportAt: "invalid-date" } },
      );
    const invalid = await api.listCourses(termCode, { limit: 10 });
    expect(invalid.items[0]?.freshness).toMatchObject({
      asOf: null,
      isStale: true,
    });
    expect((await api.getOffering(offeringId)).meta.freshness.asOf).toBeNull();
  } finally {
    await app.close();
  }
});

test("course cursor keeps offerings of the same course in order", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    let now = new Date("2026-09-23T10:01:00.000Z");
    const api = service(db, () => now);
    const first = await api.listCourses(termCode, {
      limit: 1,
    });
    expect(first.items.map((row) => row.offeringId)).toEqual([offeringId]);
    const second = await api.listCourses(termCode, {
      limit: 1,
      cursor: first.page.nextCursor!,
    });
    expect(second.items.map((row) => row.offeringId)).toEqual([
      `${termCode}:COMP2612`,
    ]);
    expect(second.page.hasMore).toBe(false);
    await expect(
      api.listCourses(termCode, { limit: 1, cursor: "a".repeat(2049) }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    now = new Date(now.getTime() + 900_000);
    await expect(
      api.listCourses(termCode, {
        limit: 1,
        cursor: first.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  } finally {
    await app.close();
  }
});

test("only the four newest active terms remain selectable regardless of freshness", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    await db.collection("academicTerms").updateOne(
      { source: ACADEMIC_SOURCE, termCode },
      {
        $set: {
          providerSignalsObservedAt: "2026-09-20T10:00:00.000Z",
          lastSuccessfulImportAt: "2026-09-23T10:00:00.000Z",
        },
      },
    );
    await db.collection("academicTerms").insertMany([
      {
        source: ACADEMIC_SOURCE,
        termCode: "2810",
        activeImportBatchId: "newest-active",
        displayName: "2028-29 Fall",
        sortKey: 202810,
        lastSuccessfulImportAt: timestamp,
      },
      {
        source: ACADEMIC_SOURCE,
        termCode: "2610",
        activeImportBatchId: "fall-active",
        displayName: "2026-27 Fall",
        sortKey: 202610,
        lastSuccessfulImportAt: timestamp,
      },
      {
        source: ACADEMIC_SOURCE,
        termCode: "2710",
        activeImportBatchId: "middle-active",
        displayName: "2027-28 Fall",
        sortKey: 202710,
        lastSuccessfulImportAt: timestamp,
      },
      {
        source: ACADEMIC_SOURCE,
        termCode: "2730",
        activeImportBatchId: "future-active",
        displayName: "2027-28 Spring",
        sortKey: 202730,
        lastSuccessfulImportAt: timestamp,
      },
    ]);
    const api = service(db, () => new Date("2026-09-23T10:01:00.000Z"));
    const terms = await api.listTerms(10);
    expect(terms.items.every((row) => !row.isCurrent && row.isSelectable)).toBe(
      true,
    );
    expect(terms.items).toHaveLength(4);
    expect(terms.items.some((row) => row.termCode === termCode)).toBe(false);
    await expect(api.getOffering(offeringId)).rejects.toMatchObject({
      code: "term_not_selectable",
    });
    const configured = new AcademicService(db, {
      structureTtlSeconds: 86400,
      quotaTtlSeconds: 900,
      cursorKey: "test-signing-key-with-at-least-32-bytes",
      cursorTtlSeconds: 900,
      currentTermCode: termCode,
      now: () => new Date("2026-09-23T10:01:00.000Z"),
    });
    const ordered = await configured.listTerms(10);
    expect(ordered.items.map((row) => row.termCode)).toEqual([
      "2810",
      "2730",
      "2710",
      "2610",
    ]);
    expect(ordered.items).toHaveLength(4);
    expect(ordered.items.every((row) => !row.isCurrent)).toBe(true);
    expect(ordered.items.every((row) => row.isSelectable)).toBe(true);
    await db.collection("academicTerms").updateOne(
      { source: ACADEMIC_SOURCE, termCode },
      {
        $set: {
          activeImportBatchId: "staged",
          lastSuccessfulImportAt: "2026-01-01T00:00:00.000Z",
        },
      },
    );
    await expect(api.getOffering(offeringId)).rejects.toMatchObject({
      code: "term_not_selectable",
    });
  } finally {
    await app.close();
  }
});

test("unverified multi-component offerings remain visible without selectable bundles", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    await db
      .collection("sectionBundles")
      .deleteMany({ offeringId, importBatchId: "active" });
    await db.collection("classSections").insertOne({
      source: ACADEMIC_SOURCE,
      termCode,
      importBatchId: "active",
      retiredAt: null,
      lastSuccessfulImportAt: timestamp,
      offeringId,
      sectionId: `${offeringId}:12346`,
      classNbr: "12346",
      sectionCode: "LA1",
      componentType: "LAB",
      associatedClass: null,
      meetings: [],
    });
    const response = await app.inject({
      url: `/offerings/${offeringId}`,
      headers: auth,
    });
    expect(response.json().data.bundleAvailability).toBe("unverified_binding");
    expect(response.json().data.sections).toHaveLength(2);
    const bundles = await app.inject({
      url: `/offerings/${offeringId}/bundles`,
      headers: auth,
    });
    expect(bundles.json().items).toEqual([]);
    await db
      .collection("classSections")
      .updateMany({ offeringId, importBatchId: "active" }, [
        { $set: { associatedClass: "$classNbr" } },
      ]);
    const incomplete = await app.inject({
      url: `/offerings/${offeringId}`,
      headers: auth,
    });
    expect(incomplete.json().data.bundleAvailability).toBe(
      "unverified_binding",
    );
  } finally {
    await app.close();
  }
});

test("fresh quota stays cached; concurrent stale reads enqueue one durable job", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    let clock = new Date("2026-09-23T10:01:00.000Z");
    const api = service(db, () => clock);
    await saveQuotaObservation(db, termCode, observation(timestamp), 300);
    expect((await api.getQuota(sectionId)).meta.freshness.state).toBe("fresh");
    expect(await db.collection("refreshJobs").countDocuments()).toBe(0);
    clock = new Date("2026-09-23T10:20:00.000Z");
    const reads = await Promise.all(
      Array.from({ length: 5 }, () => api.getQuota(sectionId)),
    );
    expect(
      reads.every(
        (row) =>
          row.meta.freshness.state === "refreshing" &&
          row.data.remaining === 20,
      ),
    ).toBe(true);
    expect(await db.collection("refreshJobs").countDocuments()).toBe(1);
    const source = new FixtureQuotaSource(
      new Map([[sectionId, observation(clock.toISOString(), 12)]]),
    );
    expect(await worker(db, source, () => clock).runOne()).toBe(true);
    expect(source.calls).toHaveLength(1);
    expect((await api.getQuota(sectionId)).data.remaining).toBe(12);
    expect(
      (await db.collection("refreshJobs").findOne({ targetId: sectionId }))
        ?.status,
    ).toBe("succeeded");
  } finally {
    await app.close();
  }
});

test("refresh worker drains pending projections alongside a refresh backlog", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    const clock = new Date("2026-09-23T10:20:00.000Z");
    await saveQuotaObservation(db, termCode, observation(timestamp), 300);
    await enqueueQuotaRefreshJob(
      db,
      ACADEMIC_SOURCE,
      termCode,
      sectionId,
      clock,
    );
    const source = new FixtureQuotaSource(
      new Map([[sectionId, observation(clock.toISOString(), 12)]]),
    );
    expect(await worker(db, source, () => clock).runOne()).toBe(true);
    expect(source.calls).toHaveLength(1);
    expect(
      await db.collection("quotaSnapshots").countDocuments({
        projectionStatus: "done",
      }),
    ).toBe(1);
    expect(
      (await db.collection("refreshJobs").findOne({ targetId: sectionId }))
        ?.status,
    ).toBe("succeeded");
  } finally {
    await app.close();
  }
});

test("watched-section scan expands courses, skips retired sections, and coalesces jobs", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    const clock = new Date("2026-09-23T10:20:00.000Z");
    await db.collection("latestQuotas").insertOne({
      source: ACADEMIC_SOURCE,
      sectionId,
      snapshotId: "old",
      capacity: 120,
      enrolled: 120,
      remaining: 0,
      waitlisted: 0,
      observedAt: timestamp,
      nextRefreshAt: timestamp,
    });
    await db.collection("classSections").insertOne({
      source: ACADEMIC_SOURCE,
      termCode,
      importBatchId: "active",
      retiredAt: "2026-09-23T09:00:00.000Z",
      sectionId: "retired-section",
      offeringId,
      classNbr: "99999",
    });
    const watch = {
      ownerUsername: "alice",
      termCode,
      notificationPreference: "none",
      baselineRecordedAt: timestamp,
      baselineBySection: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db.collection("courseWatches").insertMany([
      {
        ...watch,
        watchId: "course-watch",
        targetType: "course",
        targetId: "COMP2611",
      },
      {
        ...watch,
        watchId: "section-watch",
        targetType: "section",
        targetId: sectionId,
      },
      {
        ...watch,
        watchId: "retired-watch",
        targetType: "section",
        targetId: "retired-section",
      },
    ]);
    const source = new FixtureQuotaSource(
      new Map([[sectionId, observation(clock.toISOString(), 12)]]),
    );
    const runner = new AcademicRefreshWorker(db, source, {
      maxAttempts: 3,
      leaseSeconds: 60,
      failureCooldownSeconds: 3600,
      quotaMinIntervalSeconds: 300,
      quotaTtlSeconds: 900,
      maxWatchedJobsPerPoll: 10,
      now: () => clock,
    });
    expect(await runner.scanWatchedSections()).toBe(1);
    expect(await runner.scanWatchedSections()).toBe(0);
    expect(await db.collection("refreshJobs").countDocuments()).toBe(1);
    expect((await db.collection("refreshJobs").findOne({}))?.targetId).toBe(
      sectionId,
    );
    expect(await runner.runOne()).toBe(true);
    expect(source.calls).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("provider throttle survives a failed refresh", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    const clock = new Date("2026-09-23T10:20:00.000Z");
    const secondSectionId = `${offeringId}:99999`;
    await enqueueQuotaRefreshJob(
      db,
      ACADEMIC_SOURCE,
      termCode,
      sectionId,
      clock,
    );
    await enqueueQuotaRefreshJob(
      db,
      ACADEMIC_SOURCE,
      termCode,
      secondSectionId,
      clock,
    );
    let calls = 0;
    const source: QuotaSource = {
      async fetchQuota() {
        calls += 1;
        throw new QuotaProviderError(true, "TEMPORARY");
      },
    };
    const runner = new AcademicRefreshWorker(db, source, {
      maxAttempts: 3,
      leaseSeconds: 60,
      failureCooldownSeconds: 3600,
      quotaMinIntervalSeconds: 300,
      now: () => clock,
    });
    expect(await runner.runOne()).toBe(true);
    expect(await runner.runOne()).toBe(true);
    expect(calls).toBe(1);
    expect(
      (
        await db.collection("refreshLeases").findOne({
          leaseKey: `${ACADEMIC_SOURCE}:quota-provider`,
        })
      )?.nextAllowedAt,
    ).toEqual(new Date("2026-09-23T10:25:00.000Z"));
  } finally {
    await app.close();
  }
});

test("quota projection processes observations in observed-time order", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    const first = "2026-09-23T10:00:00.000Z";
    const second = "2026-09-23T10:01:00.000Z";
    await saveQuotaObservation(db, termCode, observation(first, 0), 300);
    await saveQuotaObservation(db, termCode, observation(second, 20), 300);
    const runner = new AcademicRefreshWorker(
      db,
      new FixtureQuotaSource(new Map()),
      {
        maxAttempts: 3,
        leaseSeconds: 60,
        failureCooldownSeconds: 3600,
        quotaMinIntervalSeconds: 300,
        now: () => new Date("2026-09-23T10:30:00.000Z"),
      },
    );
    await Promise.all([runner.projectOne(), runner.projectOne()]);
    for (let attempt = 0; attempt < 4; attempt++)
      if (!(await runner.projectOne())) break;
    expect(
      await db.collection("quotaSnapshots").countDocuments({
        projectionStatus: "done",
      }),
    ).toBe(2);
    expect(
      (await db.collection("watchProjectionCheckpoints").findOne({ sectionId }))
        ?.lastObservedAt,
    ).toBe(second);
  } finally {
    await app.close();
  }
});

test("cold quota failure is cooled down; retryable failure recovers", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    let clock = new Date("2026-09-23T10:20:00.000Z");
    const api = service(db, () => clock);
    await expect(api.getQuota(sectionId)).rejects.toMatchObject({
      code: "provider_unavailable",
      statusCode: 503,
    } satisfies Partial<AcademicError>);
    const missing = new FixtureQuotaSource(new Map());
    await worker(db, missing, () => clock).runOne();
    expect(
      (await db.collection("refreshJobs").findOne({ targetId: sectionId }))
        ?.status,
    ).toBe("permanently_failed");
    await api.getQuota(sectionId).catch(() => {});
    expect(await db.collection("refreshJobs").countDocuments()).toBe(1);
    clock = new Date("2026-09-23T11:21:00.000Z");
    await api.getQuota(sectionId).catch(() => {});
    expect(await db.collection("refreshJobs").countDocuments()).toBe(2);
    let calls = 0;
    const source: QuotaSource = {
      async fetchQuota() {
        calls++;
        if (calls === 1) throw new QuotaProviderError(true, "TEMPORARY");
        return observation(clock.toISOString(), 9);
      },
    };
    const runner = worker(db, source, () => clock);
    await runner.runOne();
    expect(
      (
        await db
          .collection("refreshJobs")
          .findOne({ status: "retryable_failed" })
      )?.lastErrorCode,
    ).toBe("TEMPORARY");
    clock = new Date("2026-09-23T11:27:00.000Z");
    await runner.runOne();
    expect((await api.getQuota(sectionId)).data.remaining).toBe(9);
  } finally {
    await app.close();
  }
});

test("failed refresh preserves a stale quota and suppresses repeat jobs", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    await saveQuotaObservation(db, termCode, observation(timestamp), 300);
    const clock = new Date("2026-09-23T10:20:00.000Z");
    const api = service(db, () => clock);
    expect((await api.getQuota(sectionId)).meta.freshness.state).toBe(
      "refreshing",
    );
    await worker(db, new FixtureQuotaSource(new Map()), () => clock).runOne();
    const fallback = await api.getQuota(sectionId);
    expect(fallback.data.remaining).toBe(20);
    expect(fallback.meta.freshness.isStale).toBe(true);
    expect(fallback.meta.freshness.state).toBe("stale");
    expect(
      (await db.collection("latestQuotas").findOne({ sectionId }))
        ?.lastAttemptedAt,
    ).toBe(clock.toISOString());
    expect(await db.collection("refreshJobs").countDocuments()).toBe(1);
  } finally {
    await app.close();
  }
});

test("older observations and failures cannot replace a newer quota", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    const newer = "2026-09-23T10:20:00.000Z";
    await saveQuotaObservation(db, termCode, observation(newer, 7), 300);
    await saveQuotaObservation(db, termCode, observation(timestamp, 99), 300);
    await recordQuotaFailure(
      db,
      ACADEMIC_SOURCE,
      termCode,
      sectionId,
      new Date("2026-09-23T11:00:00.000Z"),
      "permanently_failed",
      new Date("2026-09-23T10:10:00.000Z"),
    );
    const latest = await db.collection("latestQuotas").findOne({ sectionId });
    expect(latest?.remaining).toBe(7);
    expect(latest?.lastRefreshStatus).toBe("succeeded");
    expect(latest?.nextRefreshAt).toBe("2026-09-23T10:25:00.000Z");
    expect(await db.collection("quotaSnapshots").countDocuments()).toBe(2);
  } finally {
    await app.close();
  }
});

test("expired worker claim cannot complete after a newer worker succeeds", async () => {
  const app = await buildApp();
  try {
    const db = app.mongo.db!;
    await seed(db);
    let clock = new Date("2026-09-23T10:20:00.000Z");
    await service(db, () => clock)
      .getQuota(sectionId)
      .catch(() => {});
    let release: ((value: QuotaObservation) => void) | undefined;
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow: QuotaSource = {
      fetchQuota: async () => {
        started?.();
        return new Promise<QuotaObservation>((resolve) => {
          release = resolve;
        });
      },
    };
    const first = worker(db, slow, () => clock).runOne();
    await entered;
    clock = new Date("2026-09-23T10:22:00.000Z");
    const fast = new FixtureQuotaSource(
      new Map([[sectionId, observation(clock.toISOString(), 7)]]),
    );
    await worker(db, fast, () => clock).runOne();
    expect(
      (await db.collection("latestQuotas").findOne({ sectionId }))?.remaining,
    ).toBeUndefined();
    clock = new Date("2026-09-23T10:26:00.000Z");
    await worker(db, fast, () => clock).runOne();
    release?.(observation("2026-09-23T10:23:00.000Z", 99));
    await first;
    expect(
      (await db.collection("latestQuotas").findOne({ sectionId }))?.remaining,
    ).toBe(7);
    expect(
      (await db.collection("refreshJobs").findOne({ targetId: sectionId }))
        ?.claimGeneration,
    ).toBe(3);
  } finally {
    await app.close();
  }
});
