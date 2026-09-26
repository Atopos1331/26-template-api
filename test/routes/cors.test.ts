// The web console is served from a different origin than the API, so every
// call it makes is cross-origin. A browser will not send a PATCH or DELETE
// whose preflight does not allow that method: the request never reaches the
// server, `fetch` rejects, and the UI reports a network failure with no hint
// that CORS is the cause.
//
// This started as a real bug: the CORS registration set only `origin`, so
// @fastify/cors advertised the default `GET,HEAD,POST`. Every mutating route
// on the API was unreachable from the browser.

import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert/strict";
import Fastify from "fastify";
import fp from "fastify-plugin";
import App from "../../src/app.js";

const ORIGIN = "http://localhost:4173";

async function buildApp() {
  const app = Fastify({ pluginTimeout: 300_000 });
  onTestFinished(() => app.close());
  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri: undefined,
    test: true,
    authSkip: false,
    appTimezone: "Asia/Hong_Kong",
    cursorSigningKey: "test-signing-key-with-at-least-32-bytes",
    cursorTtlSeconds: 900,
    recurrenceMaxSpanDays: 1461,
    idempotencyRetentionSeconds: 86400,
  });
  await app.ready();
  return app;
}

function allowedMethods(header: string | undefined): string[] {
  return (header ?? "")
    .split(",")
    .map((method) => method.trim().toUpperCase())
    .filter(Boolean);
}

test("CORS preflight allows every mutating method the API exposes", async () => {
  const app = await buildApp();

  // A preflight for a real route, including the custom headers the console
  // sends on writes. `if-match` is what makes the request non-simple, so a
  // preflight is mandatory rather than optional.
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/plans/000000000000000000000000",
    headers: {
      origin: ORIGIN,
      "access-control-request-method": "PATCH",
      "access-control-request-headers": "content-type,if-match,idempotency-key",
    },
  });

  assert.ok(
    preflight.statusCode === 200 || preflight.statusCode === 204,
    `preflight should succeed, got ${preflight.statusCode}`,
  );
  assert.equal(
    preflight.headers["access-control-allow-origin"],
    "*",
    "the console runs on a different origin",
  );

  const allowed = allowedMethods(
    preflight.headers["access-control-allow-methods"] as string | undefined,
  );
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    assert.ok(
      allowed.includes(method),
      `preflight must allow ${method}; got [${allowed.join(", ")}]`,
    );
  }

  // The write path also sends If-Match and Idempotency-Key. If either is
  // missing from the allow list the browser blocks the request before it is
  // sent, which surfaces as an unexplained network error in the UI.
  const allowedHeaders = String(
    preflight.headers["access-control-allow-headers"] ?? "",
  )
    .split(",")
    .map((header) => header.trim().toLowerCase());
  for (const header of ["content-type", "if-match", "idempotency-key"]) {
    assert.ok(
      allowedHeaders.includes(header),
      `preflight must allow the ${header} header; got [${allowedHeaders.join(", ")}]`,
    );
  }
});
