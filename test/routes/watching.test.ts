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
const courseId = "COMP2611";
const offeringId = `${ACADEMIC_SOURCE}:${termCode}:${courseId}:UNKNOWN`;
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
    academicCareer: "UNKNOWN",
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
      latestQuota: null,
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
