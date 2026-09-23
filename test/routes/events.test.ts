import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert/strict";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import App from "../../src/app.js";
import type { EventDocument } from "../../src/plugins/init-mongo.js";

const alice = { authorization: "Bearer alice-dev-token" };
const bob = { authorization: "Bearer bob-dev-token" };
const timed = {
  title: "Study group",
  startsAt: "2026-09-24T10:00:00Z",
  endsAt: "2026-09-24T11:00:00Z",
};

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

test("events enforce ownership, strict input and revision preconditions", async () => {
  const app = await buildApp();
  const health = await app.inject({ url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, "ok");
  const openapi = await app.inject({ url: "/documentation/json" });
  assert.equal(openapi.statusCode, 200);
  const documentedPaths = Object.keys(openapi.json().paths);
  assert.ok(
    documentedPaths.some((path) => path === "/events" || path === "/events/"),
    documentedPaths.join(", "),
  );
  assert.ok(
    documentedPaths.some((path) => path.includes("/events/{id}")),
    documentedPaths.join(", "),
  );
  const unauthorized = await app.inject({
    method: "POST",
    url: "/events",
    payload: timed,
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.json().error.code, "unauthorized");
  assert.ok(unauthorized.json().error.requestId);

  const spoofed = await app.inject({
    method: "POST",
    url: "/events",
    headers: alice,
    payload: { ...timed, ownerUsername: "bob" },
  });
  assert.equal(spoofed.statusCode, 400);
  assert.equal(spoofed.json().error.fields.ownerUsername, "is not allowed");

  const created = await app.inject({
    method: "POST",
    url: "/events",
    headers: alice,
    payload: timed,
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().data.id as string;
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(created.headers.etag, '"1"');
  assert.equal(created.json().data.blocksTime, true);
  assert.equal(created.json().data.ownerUsername, undefined);

  const bobGet = await app.inject({ url: `/events/${id}`, headers: bob });
  assert.equal(bobGet.statusCode, 404);
  assert.equal(bobGet.json().error.code, "not_found");
  const bobPatch = await app.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: { ...bob, "if-match": '"1"' },
    payload: { title: "Changed" },
  });
  assert.equal(bobPatch.statusCode, 404);
  const badId = await app.inject({ url: "/events/ABC", headers: alice });
  assert.equal(badId.statusCode, 400);

  const noEtag = await app.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: alice,
    payload: { title: "Changed" },
  });
  assert.equal(noEtag.statusCode, 428);
  assert.equal(noEtag.json().error.code, "precondition_required");
  const changed = await app.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: { ...alice, "if-match": '"1"' },
    payload: { title: "Changed" },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.headers.etag, '"2"');
  const stale = await app.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: { ...alice, "if-match": '"1"' },
    payload: { title: "Lost" },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "concurrent_modification");
  const bobDelete = await app.inject({
    method: "DELETE",
    url: `/events/${id}`,
    headers: { ...bob, "if-match": '"2"' },
  });
  assert.equal(bobDelete.statusCode, 404);
  const deleted = await app.inject({
    method: "DELETE",
    url: `/events/${id}`,
    headers: { ...alice, "if-match": '"2"' },
  });
  assert.equal(deleted.statusCode, 204);
  assert.equal(
    (await app.inject({ url: `/events/${id}`, headers: alice })).statusCode,
    404,
  );
});

test("events validate date unions, recurrence and readonly imports", async () => {
  const app = await buildApp();
  const invalid = [
    { ...timed, endsAt: timed.startsAt },
    { ...timed, startDate: "2026-09-24" },
    { ...timed, allDay: true, startDate: "2026-09-24", endDate: "2026-09-25" },
    {
      title: "Bad",
      allDay: true,
      startDate: "2026-09-25",
      endDate: "2026-09-24",
    },
    { ...timed, supersedesCalendarKey: "some-key" },
    {
      ...timed,
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: ["MO", "MO"],
        until: "2026-10-01",
      },
    },
  ];
  for (const payload of invalid) {
    const result = await app.inject({
      method: "POST",
      url: "/events",
      headers: alice,
      payload,
    });
    assert.equal(result.statusCode, 400, JSON.stringify(payload));
  }

  const allDay = await app.inject({
    method: "POST",
    url: "/events",
    headers: alice,
    payload: {
      title: "Holiday",
      allDay: true,
      startDate: "2026-09-24",
      endDate: "2026-09-25",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: ["TH"],
        until: "2026-10-31",
      },
    },
  });
  assert.equal(allDay.statusCode, 201);
  assert.equal(allDay.json().data.startsAt, "2026-09-23T16:00:00.000Z");
  assert.equal(allDay.json().data.blocksTime, false);
  const id = allDay.json().data.id as string;
  const badSwitch = await app.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: { ...alice, "if-match": '"1"' },
    payload: {
      allDay: false,
      startsAt: timed.startsAt,
      endsAt: timed.endsAt,
      startDate: "2026-09-24",
    },
  });
  assert.equal(badSwitch.statusCode, 400);
  const switched = await app.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: { ...alice, "if-match": '"1"' },
    payload: {
      allDay: false,
      startsAt: timed.startsAt,
      endsAt: timed.endsAt,
    },
  });
  assert.equal(switched.statusCode, 200);
  assert.equal(switched.json().data.startDate, undefined);

  const document = await app.collections.events.findOne({
    _id: new ObjectId(id),
  });
  assert.ok(document);
  await app.collections.events.insertOne({
    ...document,
    _id: new ObjectId(),
    source: "ics",
    readonly: true,
    externalId: undefined,
    operationId: undefined,
  } as EventDocument & { _id: ObjectId });
  const imported = await app.collections.events.findOne({
    ownerUsername: "alice",
    source: "ics",
  });
  assert.ok(imported);
  const importedId = imported._id.toHexString();
  const visible = await app.inject({
    url: `/events?source=ics&readonly=true`,
    headers: alice,
  });
  assert.equal(visible.statusCode, 200);
  assert.equal(visible.json().items.length, 1);
  const rejected = await app.inject({
    method: "DELETE",
    url: `/events/${importedId}`,
    headers: { ...alice, "if-match": '"2"' },
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().error.code, "readonly_resource");
});

test("external IDs, persisted idempotency and signed cursors", async () => {
  const app = await buildApp();
  const payload = { ...timed, externalId: "caller-1" };
  const first = await app.inject({
    method: "POST",
    url: "/events",
    headers: { ...alice, "idempotency-key": "op-1" },
    payload,
  });
  assert.equal(first.statusCode, 201);
  const replay = await app.inject({
    method: "POST",
    url: "/events",
    headers: { ...alice, "idempotency-key": "op-1" },
    payload,
  });
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.json(), first.json());
  const reused = await app.inject({
    method: "POST",
    url: "/events",
    headers: { ...alice, "idempotency-key": "op-1" },
    payload: { ...payload, title: "Different" },
  });
  assert.equal(reused.statusCode, 409);
  assert.equal(reused.json().error.code, "idempotency_key_reused");
  const externalReplay = await app.inject({
    method: "POST",
    url: "/events",
    headers: alice,
    payload,
  });
  assert.equal(externalReplay.statusCode, 200);
  const externalConflict = await app.inject({
    method: "POST",
    url: "/events",
    headers: alice,
    payload: { ...payload, title: "Different" },
  });
  assert.equal(externalConflict.statusCode, 409);
  assert.equal(externalConflict.json().error.code, "external_id_conflict");
  const second = await app.inject({
    method: "POST",
    url: "/events",
    headers: alice,
    payload: { ...timed, title: "Second" },
  });
  assert.equal(second.statusCode, 201);
  const page = await app.inject({ url: "/events?limit=1", headers: alice });
  assert.equal(page.statusCode, 200);
  assert.equal(page.json().page.hasMore, true);
  const cursor = page.json().page.nextCursor as string;
  const next = await app.inject({
    url: `/events?limit=1&cursor=${cursor}`,
    headers: alice,
  });
  assert.equal(next.statusCode, 200);
  assert.notEqual(next.json().items[0].id, page.json().items[0].id);
  const tampered = `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}`;
  for (const url of [
    `/events?limit=1&cursor=${tampered}`,
    `/events?limit=1&cursor=${cursor}&eventType=class`,
  ]) {
    const invalid = await app.inject({ url, headers: alice });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "invalid_cursor");
  }
  const otherOwner = await app.inject({
    url: `/events?limit=1&cursor=${cursor}`,
    headers: bob,
  });
  assert.equal(otherOwner.statusCode, 400);
});

test("a retry recovers the original response after a committed write", async () => {
  const app = await buildApp();
  const headers = { ...alice, "idempotency-key": "recover-after-write" };
  const created = await app.inject({
    method: "POST",
    url: "/events",
    headers,
    payload: timed,
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().data.id as string;
  await app.collections.idempotencyRecords.updateOne(
    { ownerScope: "alice", routeKey: "POST /events" },
    { $set: { state: "processing" } },
  );
  const changed = await app.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: { ...alice, "if-match": '"1"' },
    payload: { title: "Edited later" },
  });
  assert.equal(changed.statusCode, 200);
  const replay = await app.inject({
    method: "POST",
    url: "/events",
    headers,
    payload: timed,
  });
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.json(), created.json());

  const inProgress = await app.collections.idempotencyRecords.findOne({
    ownerScope: "alice",
  });
  assert.equal(inProgress?.state, "completed");
  const another = await app.inject({
    method: "POST",
    url: "/events",
    headers: { ...alice, "idempotency-key": "new-lease" },
    payload: timed,
  });
  assert.equal(another.statusCode, 201);
  await app.collections.idempotencyRecords.updateOne(
    {
      ownerScope: "alice",
      idempotencyKeyHash: { $ne: inProgress?.idempotencyKeyHash },
    },
    { $set: { state: "processing" } },
  );
  const activeLease = await app.inject({
    method: "POST",
    url: "/events",
    headers: { ...alice, "idempotency-key": "new-lease" },
    payload: timed,
  });
  assert.equal(activeLease.statusCode, 201);
  assert.deepEqual(activeLease.json(), another.json());
});
