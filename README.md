# template-api

A small Fastify + TypeScript service with MongoDB built in. Bun runs it and Biome keeps it tidy. With no configuration at all, dev and tests spin up a throwaway in-memory MongoDB, so `bun install && bun run dev` is genuinely all it takes to get going.

## What you need

Bun 1.4.2 or newer. Older versions break the MongoDB driver; 1.3.14 will not work. Docker is optional; Compose runs the API and persistent MongoDB together.

## Running it

```sh
bun install
bun run dev
```

That serves http://localhost:3000. The first run downloads an in-memory MongoDB binary, roughly 150 MB, once. After that it's cached and startup is quick. For a persistent API and MongoDB:

```sh
docker compose up --build -d
curl http://localhost:3000/health
```

## Academic data tool

`tools/course-data` is a separate operator package for fetching, validating,
and loading HKUST Class Schedule data. It uses its own dependencies and MongoDB
client; the API never starts a full-term crawl on a user request. See its
[README](tools/course-data/README.md) for commands and source limitations.

## Academic API and quota worker

Import a term with `tools/course-data` before reading `/terms`,
`/terms/:termCode/courses`, `/offerings/:offeringId`, or
`/offerings/:offeringId/bundles`. These authenticated routes read only the
active import batch. Stale structural data is marked in `meta.freshness` and
waits for the next operator-run import; an HTTP request never crawls a term.
Every term with an active batch, including historical terms, is selectable
for personal planning. `isCurrent` is true only for the optional
`ACADEMIC_CURRENT_TERM_CODE`; without it, no term is marked current.

`GET /sections/:sectionId/quota` returns the latest cached observation and
queues one durable, deduplicated section refresh when it is stale. A missing
quota returns `503` while the separate worker fetches it. To process jobs,
set `MONGO_URI` to the same persistent database as the API and run:

```sh
bun run worker:academic-refresh
```

Use `bun run worker:academic-refresh --once` to process at most one job.
The worker is started as a separate Compose service. Outside Compose, start it
with the command above. Failed quota fetches back
off; permanent failures have a cooldown. There is no public refresh endpoint.
`GET /sections/:sectionId/quota/trends` returns bounded historical observations,
deterministic trend slopes, and the versioned enrollment-difficulty heuristic.

Authenticated users can create term-scoped course or section watches with
`POST /courses/:courseId/watch` and `POST /sections/:sectionId/watch`. Watch
records are listed at `GET /watching`; in-app notifications are listed and
acknowledged at `GET /watching/notifications` and
`PATCH /watching/notifications/:notificationId`. The worker expands course
watches, skips retired sections, applies the provider-wide quota throttle, and
projects observations asynchronously.

`GET /common-core/presets?admissionYear=YYYY&termCode=YYSS` reads the active,
operator-loaded Common Core classification. It reports source/version metadata
and distinct offered course-code counts; it does not claim degree eligibility.

## Environment

Copy `.env.example` to `.env` for local configuration. `CURSOR_SIGNING_KEY` is
required when `NODE_ENV=production`; use a unique random secret of at least
32 bytes and keep it stable across API instances. Compose is a localhost-only
development setup and uses a process-local signing key by default.

| Variable | What it does |
| --- | --- |
| `MONGO_URI` | MongoDB URI for dev. Unset means in-memory. |
| `MONGO_TEST_URI` | Dedicated database for full-app MongoDB tests. Unset means in-memory; do not point it at the app database. |
| `AUTH_SKIP` | Set to `true` to turn auth off locally. |
| `APP_TIMEZONE` | IANA timezone for timetable/calendar features. Defaults to `Asia/Hong_Kong`; invalid values fail startup. |
| `CURSOR_SIGNING_KEY` | Signs event list cursors; required in production. |
| `CURSOR_TTL_SECONDS` | Cursor lifetime, default 900. |
| `RECURRENCE_MAX_SPAN_DAYS` | Longest accepted weekly rule, default 1461. |
| `IDEMPOTENCY_RETENTION_SECONDS` | Replay window for keyed event creates, default 86400. |
| `CALENDAR_MAX_WINDOW_DAYS` | Largest calendar query window, default 366 local days. |
| `CALENDAR_MAX_ITEMS` | Maximum occurrence count per read, default 1000. |
| `CALENDAR_MAX_CONFLICTS` | Maximum conflict pairs, default 10000. |
| `TIME_BANNER_UPCOMING_HOURS` | Banner lookahead, default 24 hours. |
| `ICS_MAX_PAYLOAD_BYTES` | Maximum ICS request size, default 5242880 bytes. |
| `ICS_MAX_OCCURRENCES` | Maximum weekly occurrences validated per import, default 1000. |
| `ICS_DEFAULT_IMPORT_WINDOW_DAYS` | Default import validation window, default 366 days. |
| `ICS_IMPORT_PROCESSING_LEASE_SECONDS` | ICS import processing lease, default 120 seconds. |
| `ICS_IMPORT_RECOVERY_GRACE_SECONDS` | Extra age before recovery marks a stale import failed, default 3600 seconds. |
| `ACADEMIC_STRUCTURE_TTL_SECONDS` | Stale marker for imported term and structural records, default 86400. |
| `ACADEMIC_CURRENT_TERM_CODE` | Optional actual ongoing UST term code (for example `2610`); only controls `isCurrent` and term ordering. |
| `ACADEMIC_QUOTA_TTL_SECONDS` | Quota freshness lifetime, default 900. |
| `ACADEMIC_QUOTA_MIN_INTERVAL_SECONDS` | Minimum time between successful quota refreshes, default 300. |
| `ACADEMIC_QUOTA_MAX_JOBS_PER_POLL` | Maximum overdue watched sections enqueued by one worker scan, default 100. |
| `REFRESH_FAILURE_COOLDOWN_SECONDS` | Permanent-failure cooldown and retry backoff cap, default 3600. |
| `REFRESH_MAX_ATTEMPTS` | Maximum worker attempts per quota job, default 3. |
| `REFRESH_LEASE_SECONDS` | Worker claim and resource lease lifetime, default 60. |
| `ACADEMIC_PROVIDER_BASE_URL` | HKUST Class Schedule base URL for the worker. |
| `COMMON_CORE_MAX_AGE_DAYS` | Maximum age of the active Common Core verification, default 365. |
| `API_PORT` | Host port for Compose, default 3000. |

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | Dev server, watch mode, debug logs |
| `bun run start` | Same without watch, info logs |
| `bun run worker:academic-refresh` | Process queued section-quota refreshes in a separate process |
| `bun run worker:ics-import-recovery` | Mark expired ICS imports failed and remove their staged event rows; schedule this one-shot command separately |
| `bun run test` | Tests, with coverage |
| `bun run compile` | Type-check `src` and `test` with `tsc` |
| `bun run check` | Read-only formatting + lint check |
| `bun run lint` | Auto-fix lint issues |
| `bun run fmt` | Auto-format the repo |

## Auth

Users and their tokens live in `src/auth/users.ts`. There are two sample users, alice and bob, and their tokens act as passwords, so replace them before deploying anything real. Protected routes want a bearer header:

```sh
curl http://localhost:3000/auth-example
# 401 Missing Authorization Header

curl -H "Authorization: Bearer alice-dev-token" http://localhost:3000/auth-example
# alice
```

To protect your own routes, wrap them in a `fastify.withAuth` scope. Everything inside is protected, the auth error responses get documented for you, and `request.user` is typed non-null:

```typescript
const authExample: FastifyPluginAsync = async (
  fastify: FastifyTypebox,
): Promise<void> => {
  fastify.withAuth(async (fastify) => {
    fastify.get(
      "/",
      {
        schema: {
          summary: "Auth Example",
          tags: ["Auth"],
          security: [{ Auth: [] }],
          response: {
            200: Type.String({
              description: "The authenticated user's username.",
            }),
          },
        },
      },
      async (request) => request.user.username,
    );
  });
};
```

Setting `AUTH_SKIP=true` turns verification off completely. Scoped requests then come in as a fixed anonymous user (`{ username: "anonymous", name: null }`, plus an `X-Auth-Skip: true` response header), and stale tokens in your HTTP client stop causing mystery 401s.

## API docs

Swagger UI is at http://localhost:3000/documentation, Scalar at http://localhost:3000/reference.

## Events

`POST /events`, `GET /events`, `GET /events/:id`, `PATCH /events/:id`, and
`DELETE /events/:id` require a bearer token. For example:

```sh
curl -X POST http://localhost:3000/events \
  -H 'Authorization: Bearer alice-dev-token' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: first-study-group' \
  -d '{"title":"Study group","startsAt":"2026-09-24T10:00:00Z","endsAt":"2026-09-24T11:00:00Z"}'
```

Timed events use UTC `startsAt`/`endsAt`; all-day events use an inclusive
`startDate` and exclusive `endDate` with `allDay: true`. Weekly recurrence is
stored on the master event. `GET /events` returns stored records ordered by
`startsAt`, then `id`, with `limit` (1..100), a signed `cursor`, and optional
`source`, `eventType`, and `readonly` filters. Optional `from` and `to` must
be supplied together; the list still returns each stored master once when any
of its occurrences overlaps `[from, to)`. `supersedesCalendarKey` must refer
to a visible course or imported ICS projection. A manual event can then
replace that occurrence in calendar and conflict results.

Single-resource responses include a strong `ETag`. Send it as `If-Match` for
PATCH and DELETE; a missing header returns 428 and a stale revision returns
409. Repeating a POST with the same `Idempotency-Key` and body replays the
original response within the configured retention window. A matching
`externalId` also returns the existing manual event; different content is a
409 conflict. Imported events may be read but cannot be changed through these
routes.

`POST /events/import/ics` accepts a `text/calendar` body. Optional `from` and
`to` parameters set the occurrence validation window; both accept local dates
or UTC timestamps and the window is bounded by `CALENDAR_MAX_WINDOW_DAYS`.
`defaultBlocksTime` defaults to `true` for timed events; all-day imports remain
informational. The import response reports created, updated, skipped, and
rejected counts. `Idempotency-Key` makes retries replay the completed response
and cannot be reused for different content during its retention period.

Imports are stored as versions. The newest active version supplies each UID;
deleting an import restores an older active version when one exists. Use
`GET /events/imports` to list versions and `DELETE /events/imports/:importId`
to remove one. `GET /events.ics` exports the visible calendar and accepts the
same `from`/`to` window, plus optional `termCode` and `planId` filters.

## Calendar

`GET /calendar` returns individual occurrences, including weekly repeats;
`GET /calendar/conflicts` separates blocking from informational overlaps;
`GET /calendar/banner` reports one `current`, `upcoming`, or `free` state.
All are owner-scoped and require the same bearer token as `/events`.

```sh
curl -H 'Authorization: Bearer alice-dev-token' \
  'http://localhost:3000/calendar?from=2026-09-01&to=2026-10-01'
```

`from` and `to` are both optional; supply both for a custom window. They
accept `YYYY-MM-DD` in `APP_TIMEZONE` or UTC timestamps ending in `Z`.
The default runs from today's local midnight to the first day of next month.
The window is half-open and at most 366 local days by default. Oversized
occurrence or conflict results fail with `400 calendar_window_too_dense`
instead of returning partial data. Weekly recurrence keeps the original
local start time and duration: nonexistent DST times are skipped, and an
ambiguous time takes the earlier offset. All-day dates have an exclusive end.
The Banner captures server time once and only considers blocking timed items;
clients cannot set its clock.

Manual events, effective imported ICS events, and course-plan selections feed
the calendar. `termCode` and `planId` filter course-plan projections. Conflict
checks used by planner apply re-read current blocking manual and imported ICS
events, so an event imported after recommendation generation can make its
signed option stale.

## Where things live

```
src/
  app.ts                # Fastify app: options, plugins, routes
  options.ts            # Environment variable parsing
  plugins/
    auth.ts             # Bearer-token auth plugin + withAuth scope
    init-mongo.ts       # Typed collections and index bootstrap
    sensible.ts         # @fastify/sensible error helpers
  auth/
    users.ts            # Users and tokens
  routes/
    example/            # Public example route
    auth-example/       # Protected example route
    events/             # Authenticated event CRUD
    events-ics.ts       # ICS export and shared calendar projections
    calendar/           # Occurrences, conflicts, Time Banner
    health/             # Public DB readiness check
  domain/
    ics.ts              # ICS parsing and normalization
    ics-calendar.ts     # Recurrence expansion and exception overlays
  workers/
    ics-import-recovery.ts # Stale import cleanup
test/
  routes/               # Route tests
  auth-schema.test.ts   # withAuth schema-merging contract tests
  init-mongo.test.ts    # MongoDB URI-defaulting tests
  mongo-collections.test.ts # Event/idempotency indexes and uniqueness
  mongo.test.ts         # Full-app boot + in-memory MongoDB wiring
  options.test.ts       # Env parsing tests
```

## Tests

`bun run test` runs everything. Route tests exercise each plugin on a bare Fastify instance; the Mongo test boots the whole app, plugins autoloaded and collections created. It uses an in-memory server by default, or the dedicated database named by `MONGO_TEST_URI` when set. Collection/index tests always use an isolated in-memory MongoDB. No external service is needed by default.

## Adding your own stuff

New routes go in a folder under `src/routes/`; the autoload picks them up, and an exported `autoPrefix` controls the URL prefix if you want one. New collections and their indexes go in `src/plugins/init-mongo.ts`, following the `example` pattern, and show up as `fastify.collections.<name>`.
