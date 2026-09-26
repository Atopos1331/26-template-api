import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import App from "../src/app.js";
import { EventError } from "../src/domain/events.js";
import { parseIcs } from "../src/domain/ics.js";
import { expandIcsSeries } from "../src/domain/ics-calendar.js";
import { EventRepository } from "../src/repositories/events.js";

const alice = { authorization: "Bearer alice-dev-token" };
const bob = { authorization: "Bearer bob-dev-token" };
const window = "from=2026-09-21&to=2026-10-20";

function calendar(events: string, timezone = "UTC") {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `X-WR-TIMEZONE:${timezone}`,
    events,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function single(uid: string, summary: string, start: string, end: string) {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
  ].join("\r\n");
}

function buildApp() {
  const app = Fastify({ pluginTimeout: 300_000 });
  onTestFinished(() => app.close());
  return app
    .register(fp(App), {
      mongoUri: undefined,
      mongoTestUri: undefined,
      test: true,
      authSkip: false,
      appTimezone: "America/Chicago",
      cursorSigningKey: "test-signing-key-with-at-least-32-bytes",
      calendarMaxWindowDays: 366,
      calendarMaxItems: 1000,
    })
    .then(async () => {
      await app.ready();
      return app;
    });
}

test("ICS parser normalizes DST all-day dates and deduplicates derived identities", () => {
  const input = calendar(
    [
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20260308",
      "SUMMARY:Holiday",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20260308",
      "SUMMARY:Holiday",
      "END:VEVENT",
    ].join("\r\n"),
    "America/Chicago",
  );
  const parsed = parseIcs(input, {
    timezone: "America/Chicago",
    from: "2026-03-08T06:00:00.000Z",
    to: "2026-03-09T05:00:00.000Z",
    defaultBlocksTime: true,
    maxOccurrences: 10,
  });
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0]?.startsAt, "2026-03-08T06:00:00.000Z");
  assert.equal(parsed.events[0]?.endsAt, "2026-03-09T05:00:00.000Z");
  assert.equal(parsed.events[0]?.identityQuality, "derived_identity");
  assert.deepEqual(parsed.rejected, [
    { reason: "duplicate_identical", count: 1 },
  ]);
});

test("ICS parser enforces recurrence limits and rejects exception-only UIDs", () => {
  const recurring = calendar(
    [
      "BEGIN:VEVENT",
      "UID:weekly",
      "DTSTART:20260302T100000Z",
      "DTEND:20260302T110000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260330T110000Z",
      "SUMMARY:Weekly",
      "END:VEVENT",
    ].join("\r\n"),
  );
  assert.throws(
    () =>
      parseIcs(recurring, {
        timezone: "UTC",
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-04-01T00:00:00.000Z",
        defaultBlocksTime: true,
        maxOccurrences: 2,
      }),
    (error: unknown) =>
      error instanceof EventError && error.fields?.ics === "max_occurrences",
  );
  const exceptionOnly = calendar(
    [
      "BEGIN:VEVENT",
      "UID:missing-master",
      "RECURRENCE-ID:20260302T100000Z",
      "DTSTART:20260302T120000Z",
      "DTEND:20260302T130000Z",
      "SUMMARY:Moved",
      "END:VEVENT",
    ].join("\r\n"),
  );
  assert.deepEqual(
    parseIcs(exceptionOnly, {
      timezone: "UTC",
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-04-01T00:00:00.000Z",
      defaultBlocksTime: true,
      maxOccurrences: 10,
    }).rejected,
    [{ reason: "exception_without_master", count: 1 }],
  );
});

test("ICS recurrence accepts a floating local UNTIL in the event timezone", () => {
  const parsed = parseIcs(
    calendar(
      [
        "BEGIN:VEVENT",
        "UID:local-until",
        "DTSTART;TZID=America/Chicago:20260921T100000",
        "DTEND;TZID=America/Chicago:20260921T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260928T110000",
        "SUMMARY:Local",
        "END:VEVENT",
      ].join("\r\n"),
    ),
    {
      timezone: "UTC",
      from: "2026-09-20T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      defaultBlocksTime: true,
      maxOccurrences: 10,
    },
  );
  assert.equal(parsed.events[0]?.recurrence?.until, "2026-09-28");
});

test("ICS parser accepts a DTSTART-less cancelled exception", () => {
  const input = calendar(
    [
      "BEGIN:VEVENT",
      "UID:series",
      "DTSTART:20260302T100000Z",
      "DTEND:20260302T110000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260330T110000Z",
      "SUMMARY:Weekly",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:series",
      "RECURRENCE-ID:20260309T100000Z",
      "STATUS:CANCELLED",
      "END:VEVENT",
    ].join("\r\n"),
  );
  const parsed = parseIcs(input, {
    timezone: "UTC",
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-04-01T00:00:00.000Z",
    defaultBlocksTime: true,
    maxOccurrences: 10,
  });
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[1]?.status, "CANCELLED");
  assert.equal(parsed.events[1]?.recurrenceId, "2026-03-09T10:00:00.000Z");
});

test("ICS parser accepts a cancelled exception with DTSTART but no DTEND", () => {
  const parsed = parseIcs(
    calendar(
      [
        "BEGIN:VEVENT",
        "UID:series-with-marker",
        "DTSTART:20260921T100000Z",
        "DTEND:20260921T110000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260928T110000Z",
        "SUMMARY:Weekly",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:series-with-marker",
        "RECURRENCE-ID:20260928T100000Z",
        "DTSTART:20260928T100000Z",
        "STATUS:CANCELLED",
        "END:VEVENT",
      ].join("\r\n"),
    ),
    {
      timezone: "UTC",
      from: "2026-09-20T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      defaultBlocksTime: true,
      maxOccurrences: 10,
    },
  );
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[1]?.status, "CANCELLED");
});

test("ICS resolves a fixed custom VTIMEZONE and overlays exceptions consistently", () => {
  const input = calendar(
    [
      "BEGIN:VTIMEZONE",
      "TZID:Campus/Fixed",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0530",
      "TZOFFSETTO:+0530",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:series",
      "DTSTART;TZID=Campus/Fixed:20260921T100000",
      "DTEND;TZID=Campus/Fixed:20260921T110000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260928T110000Z",
      "SUMMARY:Weekly",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:series",
      "RECURRENCE-ID;TZID=Campus/Fixed:20260928T100000",
      "DTSTART;TZID=Campus/Fixed:20260928T120000",
      "DTEND;TZID=Campus/Fixed:20260928T130000",
      "SUMMARY:Moved",
      "END:VEVENT",
    ].join("\r\n"),
  );
  const parsed = parseIcs(input, {
    timezone: "UTC",
    from: "2026-09-20T00:00:00.000Z",
    to: "2026-10-01T00:00:00.000Z",
    defaultBlocksTime: true,
    maxOccurrences: 10,
  });
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0]?.timezone, "+05:30");
  const rows = parsed.events.map((event, index) => ({
    _id: new ObjectId(index.toString(16).padStart(24, "0")),
    ownerUsername: "alice",
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    timezone: event.timezone,
    source: "ics",
    externalId: event.uid,
    importId: new ObjectId("f".repeat(24)),
    recurrenceId: event.recurrenceId ?? null,
    ...(event.recurrence ? { recurrence: event.recurrence } : {}),
    ...(event.status ? { recurrenceStatus: event.status } : {}),
    eventType: "other" as const,
    blocksTime: event.blocksTime,
    readonly: true,
    revision: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  }));
  const items = expandIcsSeries(
    rows,
    { from: "2026-09-20T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
    10,
  );
  assert.deepEqual(
    items.map((item) => [item.title, item.startsAt]),
    [
      ["Weekly", "2026-09-21T04:30:00.000Z"],
      ["Moved", "2026-09-28T06:30:00.000Z"],
    ],
  );
});

test("ICS import rejects an oversized validation window", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/events/import/ics?from=2026-01-01&to=2028-01-01",
    headers: { ...alice, "content-type": "text/calendar" },
    payload: calendar(
      single("wide", "Wide", "20260101T100000Z", "20260101T110000Z"),
    ),
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
});

test("ICS import idempotency keys reject payload reuse and replay the result", async () => {
  const app = await buildApp();
  const payload = calendar(
    single("idempotent", "First", "20260922T150000Z", "20260922T160000Z"),
  );
  const headers = {
    ...alice,
    "content-type": "text/calendar",
    "idempotency-key": "ics-import-1",
  };
  const first = await app.inject({
    method: "POST",
    url: "/events/import/ics",
    headers,
    payload,
  });
  assert.equal(first.statusCode, 201, first.payload);
  const replay = await app.inject({
    method: "POST",
    url: "/events/import/ics",
    headers,
    payload,
  });
  assert.equal(replay.statusCode, 201, replay.payload);
  assert.deepEqual(replay.json(), first.json());
  const reused = await app.inject({
    method: "POST",
    url: "/events/import/ics",
    headers,
    payload: calendar(
      single("idempotent", "Changed", "20260922T150000Z", "20260922T160000Z"),
    ),
  });
  assert.equal(reused.statusCode, 409, reused.payload);
  assert.equal(reused.json().error.code, "idempotency_key_reused");
});

test("an expired ICS idempotency key can be reused for a new payload", async () => {
  const app = await buildApp();
  const key = "ics-expired-key";
  await app.collections.idempotencyRecords.insertOne({
    ownerScope: "alice",
    routeKey: "POST /events/import/ics",
    idempotencyKeyHash: createHash("sha256").update(key).digest("hex"),
    requestHash: "expired-request-hash",
    operationId: "expired-operation",
    state: "completed",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000),
  });
  const response = await app.inject({
    method: "POST",
    url: "/events/import/ics",
    headers: {
      ...alice,
      "content-type": "text/calendar",
      "idempotency-key": key,
    },
    payload: calendar(
      single(
        "reused-key",
        "New payload",
        "20260922T150000Z",
        "20260922T160000Z",
      ),
    ),
  });
  assert.equal(response.statusCode, 201, response.payload);
  assert.equal(response.json().data.created, 1);
  const record = await app.collections.idempotencyRecords.findOne({
    ownerScope: "alice",
    routeKey: "POST /events/import/ics",
    idempotencyKeyHash: createHash("sha256").update(key).digest("hex"),
  });
  assert.equal(record?.state, "completed");
  assert.notEqual(record?.requestHash, "expired-request-hash");
});

test("ICS imports replace complete effective UIDs, restore older versions, and export at /events.ics", async () => {
  const app = await buildApp();
  const first = calendar(
    single("series", "Original", "20260921T150000Z", "20260921T160000Z"),
  );
  const second = calendar(
    single("series", "Updated", "20260921T170000Z", "20260921T180000Z"),
  );
  const post = (payload: string) =>
    app.inject({
      method: "POST",
      url: "/events/import/ics",
      headers: { ...alice, "content-type": "text/calendar" },
      payload,
    });
  const importedFirst = await post(first);
  assert.equal(importedFirst.statusCode, 201, importedFirst.payload);
  assert.equal((await post(first)).statusCode, 200);
  const importedSecond = await post(second);
  assert.equal(importedSecond.statusCode, 201, importedSecond.payload);
  const newest = await app.inject({
    url: `/events?source=ics&${window}`,
    headers: alice,
  });
  assert.equal(newest.statusCode, 200);
  assert.equal(newest.json().items.length, 1);
  assert.equal(newest.json().items[0].title, "Updated");
  assert.equal(
    (
      await app.inject({ url: `/events?source=ics&${window}`, headers: bob })
    ).json().items.length,
    0,
  );
  const exportResult = await app.inject({
    url: `/events.ics?${window}`,
    headers: alice,
  });
  assert.equal(exportResult.statusCode, 200, exportResult.payload);
  assert.match(exportResult.headers["content-type"] ?? "", /^text\/calendar/);
  assert.match(exportResult.payload, /SUMMARY:Updated/);
  assert.doesNotMatch(exportResult.payload, /SUMMARY:Original/);

  const secondImportId = importedSecond.json().data.importId as string;
  const deleted = await app.inject({
    method: "DELETE",
    url: `/events/imports/${secondImportId}`,
    headers: alice,
  });
  assert.equal(deleted.statusCode, 204, deleted.payload);
  const restored = await app.inject({
    url: `/events?source=ics&${window}`,
    headers: alice,
  });
  assert.equal(restored.json().items.length, 1);
  assert.equal(restored.json().items[0].title, "Original");
});

test("a newer ICS import replaces only its overlapping UIDs", async () => {
  const app = await buildApp();
  const post = (events: string) =>
    app.inject({
      method: "POST",
      url: "/events/import/ics?from=2026-09-24&to=2026-09-27",
      headers: { ...alice, "content-type": "text/calendar" },
      payload: calendar(events),
    });
  const original = await post(
    [
      single("shared", "Old version", "20260925T100000Z", "20260925T110000Z"),
      single("retained", "Retained", "20260925T120000Z", "20260925T130000Z"),
    ].join("\r\n"),
  );
  assert.equal(original.statusCode, 201, original.payload);
  const updated = await post(
    single("shared", "New version", "20260925T140000Z", "20260925T150000Z"),
  );
  assert.equal(updated.statusCode, 201, updated.payload);

  const events = await app.inject({
    url: "/events?source=ics&from=2026-09-25&to=2026-09-26",
    headers: alice,
  });
  assert.equal(events.statusCode, 200);
  assert.deepEqual(
    events.json().items.map((item: { title: string }) => item.title),
    ["Retained", "New version"],
  );
  const repository = new EventRepository(
    app.collections.events,
    app.collections.eventImports,
  );
  assert.deepEqual(
    (await repository.activeImportedEvents("alice"))
      .map((event) => event.title)
      .sort(),
    ["New version", "Retained"],
  );
});

test("deleting a processing ICS manifest returns conflict without changing it", async () => {
  const app = await buildApp();
  const id = new ObjectId();
  const now = new Date().toISOString();
  await app.collections.eventImports.insertOne({
    _id: id,
    ownerUsername: "alice",
    source: "ics",
    contentHash: "processing-hash",
    optionsHash: "processing-options",
    importWindowFrom: now,
    importWindowTo: now,
    defaultBlocksTime: true,
    importedAt: now,
    processingLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    rejectedCount: 0,
    status: "processing",
  });
  const response = await app.inject({
    method: "DELETE",
    url: `/events/imports/${id.toHexString()}`,
    headers: alice,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "import_in_progress");
  assert.equal(
    (await app.collections.eventImports.findOne({ _id: id }))?.status,
    "processing",
  );
});
