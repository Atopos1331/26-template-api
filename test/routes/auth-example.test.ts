import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import AuthPlugin, { type AuthPluginOptions } from "../../src/plugins/auth.js";
import Sensible from "../../src/plugins/sensible.js";
import AuthExample from "../../src/routes/auth-example/index.js";
import Example from "../../src/routes/example/index.js";

// Register the internal auth plugin and the route plugins on a bare Fastify
// instance. `authSkip` defaults to false, so scoped requests must present one
// of the bearer tokens defined in src/auth/users.ts.
async function buildAuthApp(options: AuthPluginOptions = {}) {
  const app = Fastify();
  await app.register(AuthPlugin, options);
  await app.register(Sensible);
  await app.register(AuthExample, { prefix: "/auth-example" });
  await app.register(Example, { prefix: "/example" });
  await app.ready();
  return app;
}

test("protected route rejects missing credentials", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/auth-example",
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload, "Missing Authorization Header");
});

test("unknown tokens are rejected", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/auth-example",
    headers: { authorization: "Bearer not-a-known-token" },
  });
  assert.equal(res.statusCode, 401);
});

test("malformed authorization headers return a bad request", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/auth-example",
    headers: { authorization: "foo" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload, "Invalid Authorization Header");
});

test("valid bearer token reaches the handler", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/auth-example",
    headers: { authorization: "Bearer alice-dev-token" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload, "alice");
});

test("configured users authenticate and replace the development defaults", async () => {
  const token = "custom-production-token-".padEnd(32, "x");
  const app = await buildAuthApp({
    users: [{ username: "operator", name: "Operator", token }],
  });
  onTestFinished(() => app.close());

  const configured = await app.inject({
    url: "/auth-example",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(configured.statusCode, 200);
  assert.equal(configured.payload, "operator");

  const developmentDefault = await app.inject({
    url: "/auth-example",
    headers: { authorization: "Bearer alice-dev-token" },
  });
  assert.equal(developmentDefault.statusCode, 401);
});

test("public routes stay open while auth-example is protected", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/example",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload, "this is an example");
});

test("authSkip is a true bypass: any header authenticates as anonymous", async () => {
  const app = await buildAuthApp({ authSkip: true });
  onTestFinished(() => app.close());

  // No header at all.
  const noHeader = await app.inject({ url: "/auth-example" });
  assert.equal(noHeader.statusCode, 200);
  assert.equal(noHeader.payload, "anonymous");

  // A stale token left in an HTTP client must not 401 under skip.
  const staleToken = await app.inject({
    url: "/auth-example",
    headers: { authorization: "Bearer alice-dev-token" },
  });
  assert.equal(staleToken.statusCode, 200);
  assert.equal(staleToken.payload, "anonymous");

  // A garbage header must not 401 under skip either.
  const garbage = await app.inject({
    url: "/auth-example",
    headers: { authorization: "Bearer not-a-known-token" },
  });
  assert.equal(garbage.statusCode, 200);
  assert.equal(garbage.payload, "anonymous");

  assert.equal(noHeader.headers["x-auth-skip"], "true");
});
