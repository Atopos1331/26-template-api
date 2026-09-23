import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import type { Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import App from "../src/app.js";
import { ACADEMIC_SOURCE, type AcademicError } from "../src/domain/academic.js";
import {
  FixtureQuotaSource,
  parseUstQuota,
  type QuotaObservation,
  QuotaProviderError,
  type QuotaSource,
  UstQuotaSource,
} from "../src/providers/ust-quota.js";
import {
  recordQuotaFailure,
  saveQuotaObservation,
} from "../src/repositories/quotas.js";
import { AcademicService } from "../src/services/academic.js";
import { AcademicRefreshWorker } from "../src/workers/academic-refresh.js";

const termCode = "2530";
const offeringId = `${ACADEMIC_SOURCE}:${termCode}:COMP2611:UNKNOWN`;
const sectionId = `${offeringId}:12345`;
const timestamp = "2026-09-23T10:00:00.000Z";
const auth = { authorization: "Bearer alice-dev-token" };
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
    mongoUri: mongod.getUri(`academic-${randomUUID()}`),
    mongoTestUri: undefined,
    authSkip: false,
    cursorSigningKey: "test-signing-key-with-at-least-32-bytes",
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
        academicCareer: "UNKNOWN",
        sourceCourseId: "COMP2611",
      },
      {
        ...key,
        offeringId: `${ACADEMIC_SOURCE}:${termCode}:COMP2612:UNKNOWN`,
        courseId: "COMP2612",
        academicCareer: "UNKNOWN",
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
      open: null,
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
    open: null,
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
  const app = await buildApp();
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
    expect(first.json().page.hasMore).toBe(true);
    const cursor = first.json().page.nextCursor;
    const next = await app.inject({
      url: `/terms/${termCode}/courses?limit=1&cursor=${encodeURIComponent(cursor)}`,
      headers: auth,
    });
    expect(next.json().items[0].courseCode).toBe("COMP2612");
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
    clock = new Date("2026-09-23T11:22:00.000Z");
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
    release?.(observation("2026-09-23T10:23:00.000Z", 99));
    await first;
    expect(
      (await db.collection("latestQuotas").findOne({ sectionId }))?.remaining,
    ).toBe(7);
    expect(
      (await db.collection("refreshJobs").findOne({ targetId: sectionId }))
        ?.claimGeneration,
    ).toBe(2);
  } finally {
    await app.close();
  }
});
