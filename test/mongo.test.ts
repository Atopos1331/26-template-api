// Proves the MongoDB wiring: without MONGO_TEST_URI, the app uses an
// in-memory server; an explicit test URI selects a separate test database.
//
// The app plugin is wrapped in `fastify-plugin` at the registration site (the
// same pattern the production dev scripts use) so the decorators added by the
// autoloaded plugins (`fastify.collections`, `fastify.mongo`) collapse onto
// this root instance: fastify-cli's `helper.build` keeps them scoped inside
// the autoloader, invisible to the instance it returns.

import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import App from "../src/app.js";
import { loadOptions } from "../src/options.js";

const { mongoTestUri } = loadOptions();

test("the example collection roundtrips documents in the test MongoDB", async () => {
  // pluginTimeout covers the first-run download of the in-memory MongoDB
  // binary, which can outlast Fastify's 10s default.
  const app = Fastify({ pluginTimeout: 5 * 60 * 1000 });
  onTestFinished(() => app.close());

  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri,
    test: true,
    authSkip: true,
  });
  await app.ready();

  const inserted = await app.collections.example.insertOne({ example: 42 });
  try {
    const found = await app.collections.example.findOne({
      _id: inserted.insertedId,
    });
    assert.equal(found?.example, 42);
  } finally {
    await app.collections.example.deleteOne({ _id: inserted.insertedId });
  }
});

test("the app reports ready with the collections decorated", async () => {
  const app = Fastify({ pluginTimeout: 5 * 60 * 1000 });
  onTestFinished(() => app.close());

  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri,
    test: true,
    authSkip: true,
  });
  await app.ready();

  assert.ok(app.collections);
  assert.ok(typeof app.withAuth === "function");
});
