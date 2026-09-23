import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert/strict";
import Fastify from "fastify";
import fp from "fastify-plugin";
import App from "../../src/app.js";
import type { CalendarOccurrence } from "../../src/domain/calendar.js";
import { EventRepository } from "../../src/repositories/events.js";
import {
  CalendarService,
  type CalendarSource,
  ManualCalendarSource,
} from "../../src/services/calendar.js";
import { EventService } from "../../src/services/events.js";

const alice = { authorization: "Bearer alice-dev-token" };
const bob = { authorization: "Bearer bob-dev-token" };
const monday = {
  title: "Weekly meeting",
  startsAt: "2026-09-21T10:00:00Z",
  endsAt: "2026-09-21T11:00:00Z",
  recurrence: {
    frequency: "weekly",
    interval: 1,
    weekdays: ["MO"],
    until: "2026-10-05",
  },
};

async function buildApp(overrides: Record<string, unknown> = {}) {
  const app = Fastify({ pluginTimeout: 300_000 });
  onTestFinished(() => app.close());
  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri: undefined,
    test: true,
    authSkip: false,
    appTimezone: "Asia/Hong_Kong",
    cursorSigningKey: "test-signing-key-with-at-least-32-bytes",
    calendarMaxWindowDays: 366,
    calendarMaxItems: 1000,
    calendarMaxConflicts: 10000,
    timeBannerUpcomingHours: 24,
    ...overrides,
  });
  await app.ready();
  return app;
}

async function create(
  app: Awaited<ReturnType<typeof buildApp>>,
  payload: object,
) {
  const result = await app.inject({
    method: "POST",
    url: "/events",
    headers: alice,
    payload,
  });
  assert.equal(result.statusCode, 201, result.payload);
  return result.json().data;
}

test("calendar expands owner-scoped weekly events and filters stored masters by occurrence", async () => {
  const app = await buildApp();
  const noAuth = await app.inject({
    url: "/calendar?from=2026-09-20&to=2026-10-07",
  });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.json().error.code, "unauthorized");
  await create(app, monday);
  const window = "from=2026-09-20&to=2026-10-07";
  const calendar = await app.inject({
    url: `/calendar?${window}`,
    headers: alice,
  });
  assert.equal(calendar.statusCode, 200, calendar.payload);
  assert.deepEqual(
    calendar.json().items.map((item: CalendarOccurrence) => item.startsAt),
    [
      "2026-09-21T10:00:00.000Z",
      "2026-09-28T10:00:00.000Z",
      "2026-10-05T10:00:00.000Z",
    ],
  );
  assert.equal(
    new Set(
      calendar.json().items.map((item: CalendarOccurrence) => item.calendarKey),
    ).size,
    3,
  );
  assert.equal(calendar.json().items[0].source, "manual");
  assert.equal(calendar.json().page.hasMore, false);
  const other = await app.inject({ url: `/calendar?${window}`, headers: bob });
  assert.equal(other.json().items.length, 0);

  const stored = await app.inject({
    url: "/events?from=2026-09-28&to=2026-09-29",
    headers: alice,
  });
  assert.equal(stored.statusCode, 200, stored.payload);
  assert.equal(stored.json().items.length, 1);
  assert.equal(stored.json().items[0].title, "Weekly meeting");
  const outside = await app.inject({
    url: "/events?from=2026-09-22&to=2026-09-23",
    headers: alice,
  });
  assert.equal(outside.json().items.length, 0);
  const invalid = await app.inject({
    url: "/calendar?from=2026-09-20",
    headers: alice,
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "invalid_request");
  assert.equal(
    (
      await app.inject({
        url: "/calendar?from=2026-01-01&to=2028-01-01",
        headers: alice,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        url: "/calendar/banner?now=2026-09-21T10:00:00Z",
        headers: alice,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ url: "/calendar?planId=abc", headers: alice }))
      .statusCode,
    400,
  );
  const docs = await app.inject({ url: "/documentation/json" });
  assert.ok(
    Object.keys(docs.json().paths).some((path) =>
      path.includes("/calendar/conflicts"),
    ),
  );
});

test("calendar conflicts distinguish blocking, informational and adjacent events", async () => {
  const app = await buildApp();
  await create(app, {
    title: "Class A",
    startsAt: "2026-09-24T10:00:00Z",
    endsAt: "2026-09-24T11:00:00Z",
  });
  await create(app, {
    title: "Class B",
    startsAt: "2026-09-24T10:30:00Z",
    endsAt: "2026-09-24T11:30:00Z",
  });
  await create(app, {
    title: "Adjacent",
    startsAt: "2026-09-24T11:30:00Z",
    endsAt: "2026-09-24T12:30:00Z",
  });
  await create(app, {
    title: "Deadline",
    startsAt: "2026-09-24T10:15:00Z",
    endsAt: "2026-09-24T10:45:00Z",
    eventType: "deadline",
  });
  const result = await app.inject({
    url: "/calendar/conflicts?from=2026-09-24&to=2026-09-25",
    headers: alice,
  });
  assert.equal(result.statusCode, 200, result.payload);
  assert.equal(result.json().data.blocking.length, 1);
  assert.equal(result.json().data.informational.length, 2);
  assert.equal(result.json().data.blocking[0].kind, "time_overlap");
  assert.equal(result.json().data.blocking[0].severity, "blocking");
  assert.equal(
    (
      await app.inject({
        url: "/calendar/conflicts?from=2026-09-24&to=2026-09-25",
        headers: bob,
      })
    ).json().data.blocking.length,
    0,
  );
});

test("windowed event pages skip nonmatching masters without losing cursor position", async () => {
  const app = await buildApp();
  await create(app, {
    title: "Old",
    startsAt: "2026-09-01T10:00:00Z",
    endsAt: "2026-09-01T11:00:00Z",
  });
  await create(app, monday);
  await create(app, {
    title: "Other day",
    startsAt: "2026-09-22T10:00:00Z",
    endsAt: "2026-09-22T11:00:00Z",
  });
  await create(app, {
    title: "Monday second",
    startsAt: "2026-09-28T12:00:00Z",
    endsAt: "2026-09-28T13:00:00Z",
  });
  const filter = "from=2026-09-28&to=2026-09-29&limit=1";
  const first = await app.inject({ url: `/events?${filter}`, headers: alice });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().items.length, 1);
  assert.equal(first.json().page.hasMore, true);
  const cursor = first.json().page.nextCursor as string;
  const second = await app.inject({
    url: `/events?${filter}&cursor=${cursor}`,
    headers: alice,
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().items.length, 1);
  assert.equal(second.json().page.hasMore, false);
  assert.notEqual(second.json().items[0].id, first.json().items[0].id);
  const wrongWindow = await app.inject({
    url: `/events?from=2026-09-29&to=2026-09-30&limit=1&cursor=${cursor}`,
    headers: alice,
  });
  assert.equal(wrongWindow.statusCode, 400);
  assert.equal(wrongWindow.json().error.code, "invalid_cursor");
});

test("conflict pair limit returns an error instead of a partial list", async () => {
  const app = await buildApp({ calendarMaxConflicts: 1 });
  for (const title of ["A", "B", "C"]) {
    await create(app, {
      title,
      startsAt: "2026-09-24T10:00:00Z",
      endsAt: "2026-09-24T11:00:00Z",
    });
  }
  const response = await app.inject({
    url: "/calendar/conflicts?from=2026-09-24&to=2026-09-25",
    headers: alice,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "calendar_window_too_dense");
});

test("calendar and conflict overflow fail explicitly, and banner uses server time", async () => {
  const app = await buildApp({ calendarMaxItems: 2, calendarMaxConflicts: 1 });
  await create(app, monday);
  const crowded = await app.inject({
    url: "/calendar?from=2026-09-20&to=2026-10-07",
    headers: alice,
  });
  assert.equal(crowded.statusCode, 400);
  assert.equal(crowded.json().error.code, "calendar_window_too_dense");

  const now = Date.now();
  const active = await create(app, {
    title: "Current",
    startsAt: new Date(now - 5 * 60_000).toISOString(),
    endsAt: new Date(now + 30 * 60_000).toISOString(),
  });
  const banner = await app.inject({ url: "/calendar/banner", headers: alice });
  assert.equal(banner.statusCode, 200, banner.payload);
  assert.equal(banner.json().data.state, "current");
  assert.equal(banner.json().data.item.sourceId, active.id);
  assert.equal(
    (await app.inject({ url: "/calendar/banner", headers: bob })).json().data
      .state,
    "free",
  );
});

test("manual suppression requires an owned non-manual target and hides only its key", async () => {
  const app = await buildApp();
  const window = {
    from: "2026-09-24T00:00:00.000Z",
    to: "2026-09-25T00:00:00.000Z",
  };
  const manual = new ManualCalendarSource(
    new EventRepository(app.collections.events),
  );
  const course: CalendarOccurrence = {
    calendarKey: "course:section-1",
    source: "course",
    sourceId: "section-1",
    title: "Official class",
    startsAt: "2026-09-24T10:00:00.000Z",
    endsAt: "2026-09-24T11:00:00.000Z",
    localStartsAt: "2026-09-24T18:00:00+08:00[Asia/Hong_Kong]",
    localEndsAt: "2026-09-24T19:00:00+08:00[Asia/Hong_Kong]",
    allDay: false,
    timezone: "Asia/Hong_Kong",
    blocksTime: true,
    readonly: true,
  };
  let targetVisible = true;
  const fakeSource: CalendarSource = {
    source: "course",
    load: async (owner) => (owner === "alice" && targetVisible ? [course] : []),
    resolvesCalendarKey: async (owner, key) =>
      owner === "alice" && targetVisible && key === course.calendarKey,
  };
  const calendar = new CalendarService(manual, [manual, fakeSource], {
    timezone: "Asia/Hong_Kong",
    maxItems: 10,
    maxConflicts: 10,
    upcomingHours: 24,
  });
  assert.equal(await calendar.canSupersede("alice", course.calendarKey), true);
  assert.equal(await calendar.canSupersede("bob", course.calendarKey), false);
  const manualEvent = await create(app, {
    title: "Replacement",
    startsAt: "2026-09-24T10:00:00Z",
    endsAt: "2026-09-24T11:00:00Z",
  });
  const invalidManual = await app.inject({
    method: "POST",
    url: "/events",
    headers: alice,
    payload: {
      title: "Invalid",
      startsAt: "2026-09-24T10:00:00Z",
      endsAt: "2026-09-24T11:00:00Z",
      supersedesCalendarKey: (
        await app.inject({
          url: "/calendar?from=2026-09-24&to=2026-09-25",
          headers: alice,
        })
      ).json().items[0].calendarKey,
    },
  });
  assert.equal(invalidManual.statusCode, 400);
  assert.equal(
    invalidManual.json().error.fields.supersedesCalendarKey,
    "must reference a visible non-manual calendar item",
  );
  const service = new EventService(
    new EventRepository(app.collections.events),
    app.collections.idempotencyRecords,
    {
      timezone: "Asia/Hong_Kong",
      maxSpanDays: 1461,
      cursorKey: "test-signing-key-with-at-least-32-bytes",
      cursorTtlSeconds: 900,
      idempotencyRetentionSeconds: 86400,
    },
    (owner, key) => calendar.canSupersede(owner, key),
  );
  const override = {
    title: "Override",
    startsAt: "2026-09-24T12:00:00Z",
    endsAt: "2026-09-24T13:00:00Z",
    supersedesCalendarKey: course.calendarKey,
    externalId: "override-1",
  };
  const replacement = await service.create(
    "alice",
    override,
    "override-request",
  );
  assert.equal(replacement.status, 201);
  const projected = await calendar.list("alice", window);
  assert.equal(
    projected.some((item) => item.calendarKey === course.calendarKey),
    false,
  );
  assert.equal(
    projected.some((item) => item.sourceId === manualEvent.id),
    true,
  );
  assert.equal(
    projected.some((item) => item.sourceId === replacement.body.data.id),
    true,
  );
  targetVisible = false;
  const keyedReplay = await service.create(
    "alice",
    override,
    "override-request",
  );
  assert.deepEqual(keyedReplay, replacement);
  const externalReplay = await service.create("alice", override);
  assert.equal(externalReplay.status, 200);
  assert.equal(externalReplay.body.data.id, replacement.body.data.id);
  assert.equal(
    (await calendar.list("alice", window)).some(
      (item) => item.sourceId === replacement.body.data.id,
    ),
    true,
  );
});
