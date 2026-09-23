import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { MongoMemoryServer } from "mongodb-memory-server";
import App from "../../src/app.js";
import { ACADEMIC_SOURCE } from "../../src/domain/academic.js";

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
