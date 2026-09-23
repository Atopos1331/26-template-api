import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { MongoMemoryServer } from "mongodb-memory-server";
import App from "../../src/app.js";
import { ACADEMIC_SOURCE } from "../../src/domain/academic.js";
import { CommonCoreRepository } from "../../src/repositories/common-core.js";

const alice = { authorization: "Bearer alice-dev-token" };
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
    mongoUri: mongod.getUri(`common-core-${randomUUID()}`),
    mongoTestUri: undefined,
    authSkip: false,
    cursorSigningKey: "test-signing-key-with-at-least-32-bytes",
  });
  await app.ready();
  return app;
}

test("Common Core presets resolve term errors before catalog availability", async () => {
  const app = await buildApp();
  try {
    const unknown = await app.inject({
      url: "/common-core/presets?admissionYear=2026&termCode=2530",
      headers: alice,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");

    await app.mongo.db!.collection("academicTerms").insertOne({
      source: ACADEMIC_SOURCE,
      termCode: "2530",
      activeImportBatchId: null,
    });
    const unavailable = await app.inject({
      url: "/common-core/presets?admissionYear=2026&termCode=2530",
      headers: alice,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe("term_not_selectable");
  } finally {
    await app.close();
  }
});

test("Common Core activation is idempotent under concurrent imports", async () => {
  const app = await buildApp();
  try {
    const repository = new CommonCoreRepository(app.mongo.db!);
    const input = {
      sourceUrl: "https://example.edu/common-core.json",
      sourceTitle: "Common Core",
      sourceContentHash: "a".repeat(64),
      verifiedAt: "2026-09-23T00:00:00.000Z",
      verifier: "operator",
      evidence: "registrar source",
      schemes: [
        {
          schemeId: "2026",
          admissionYearFrom: 2026,
          admissionYearTo: 2029,
          categories: [
            {
              categoryId: "A",
              label: "Arts",
              courseCodes: ["HUMA1001"],
            },
          ],
        },
      ],
    };
    const now = new Date("2026-09-24T00:00:00.000Z");
    const results = await Promise.all([
      repository.activate(input, now),
      repository.activate(input, now),
    ]);
    expect(results).toHaveLength(2);
    expect(
      await app.mongo.db!.collection("commonCoreCatalogs").countDocuments(),
    ).toBe(1);
    expect(
      await app.mongo.db!.collection("commonCoreCatalogState").countDocuments(),
    ).toBe(1);
  } finally {
    await app.close();
  }
});
