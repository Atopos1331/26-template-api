# template-api

A Fastify + TypeScript service with MongoDB, run by Bun and kept tidy by Biome.

The nicest thing about it: with no configuration at all, dev and tests spin up a throwaway in-memory MongoDB. `bun install && bun run dev` really is the whole setup.

## What you need

Bun 1.4.2 or newer. Older versions break the MongoDB driver, and 1.3.14 will not work at all. Docker is optional; Compose runs the API alongside a persistent MongoDB when you want that.

## Running it

```sh
bun install
bun run dev
```

That serves http://localhost:3000. The first run downloads an in-memory MongoDB binary, roughly 150 MB, and caches it, so only the first start is slow.

For a persistent API and MongoDB:

```sh
docker compose up --build -d
curl http://localhost:3000/health
```

## API test console

There is a small dependency-free browser console in the repo for exercising the API locally. Start the API with `bun run dev`, the console with `bun run frontend`, then open http://localhost:4173.

It defaults to `http://localhost:3000`, accepts the development Alice/Bob tokens or a Bearer token you paste in, and covers events, calendar, academic data, plans, auto-planning, watching, sharing, discoverability, and ICS import/export. Each endpoint has an in-page guide, and there are presets for common requests plus worked event, planning, and ICS examples.

Response IDs and ETags are kept in a session context, so follow-up calls such as auto-plan apply, plan item updates, and event patches can be prepared without copying identifiers between tools.

## Academic data tool

`tools/course-data` is a separate operator package that fetches, validates, and loads HKUST Class Schedule data. It has its own dependencies and MongoDB client. The API never starts a full-term crawl in response to a user request; see its [README](tools/course-data/README.md) for the commands and the source's limitations.

## Academic API and quota worker

Import a term with `tools/course-data` before reading `/terms`, `/terms/:termCode/courses`, `/offerings/:offeringId`, or `/offerings/:offeringId/bundles`. Those authenticated routes read only the active import batch.

Stale structural data shows up in `meta.freshness` and waits for the next operator-run import. An HTTP request never crawls a term. Every term with an active batch is selectable for personal planning, historical ones included. `isCurrent` is true only for the term named by `ACADEMIC_CURRENT_TERM_CODE`; set nothing and no term is marked current.

`GET /sections/:sectionId/quota` returns the latest cached observation and, when that is stale, queues one durable, deduplicated section refresh. If there is no observation yet the route returns `503` while the separate worker fetches one. To process jobs, point `MONGO_URI` at the same persistent database the API uses:

```sh
bun run worker:academic-refresh
```

`bun run worker:academic-refresh --once` processes at most one job. Compose starts the worker as its own service; outside Compose, use the command above. Failed quota fetches back off, and permanent failures get a cooldown. There is no public refresh endpoint. `GET /sections/:sectionId/quota/trends` returns bounded historical observations, deterministic trend slopes, and the versioned enrollment-difficulty heuristic.

Authenticated users can create term-scoped course or section watches with `POST /courses/:courseId/watch` and `POST /sections/:sectionId/watch`. See the current watches at `GET /watching`, and list or acknowledge in-app notifications at `GET /watching/notifications` and `PATCH /watching/notifications/:notificationId`. The worker expands course watches, skips retired sections, applies the provider-wide quota throttle, and projects observations asynchronously.

`GET /common-core/presets?admissionYear=YYYY&termCode=YYSS` reads the active, operator-loaded Common Core classification. It reports source and version metadata and counts distinct offered course codes. It does not claim degree eligibility.

## Plan sharing and section discovery

Share an active plan with a revocable capability token using `POST /plans/:id/shares`. The public `GET /shared-plans/:shareToken` route returns only the fixed snapshot, and the token comes back at creation and on a valid idempotent replay.

Opted-in users can find other opted-in users through `POST /sections/:sectionId/discoverability` and `GET /sections/:sectionId/classmates`. Those results are planning matches, not verified enrollment.

## Environment

Copy `.env.example` to `.env` for local configuration.

Three secrets are required once `NODE_ENV=production`: `CURSOR_SIGNING_KEY`, `AUTO_PLAN_TOKEN_SIGNING_KEY`, and `SHARE_TOKEN_REPLAY_ENCRYPTION_KEY`. Use unique random secrets of at least 32 bytes, and keep them stable across API instances, or tokens minted by one instance will be rejected by another.

Production also requires `AUTH_USERS`, a JSON array of explicit users with unique bearer tokens of at least 32 bytes. The built-in Alice/Bob tokens exist only outside production, and production rejects `AUTH_SKIP=true`. Compose is a localhost-only development setup and uses process-local keys by default.

| Variable | What it does |
| --- | --- |
| `MONGO_URI` | MongoDB URI for dev. Unset means in-memory. |
| `MONGO_TEST_URI` | Dedicated database for full-app MongoDB tests. Unset means in-memory; do not point it at the app database. |
| `AUTH_SKIP` | Set to `true` to turn auth off locally. |
| `AUTH_USERS` | JSON array of `{username,name,token}` users; required in production. Tokens must be unique and at least 32 bytes there. |
| `APP_TIMEZONE` | IANA timezone for timetable/calendar features. Defaults to `Asia/Hong_Kong`; invalid values fail startup. |
| `CURSOR_SIGNING_KEY` | Signs event list cursors; required in production. |
| `CURSOR_TTL_SECONDS` | Cursor lifetime, default 900. |
| `SHARE_TOKEN_REPLAY_ENCRYPTION_KEY` | Encrypts one-time share tokens stored for idempotent replay; required in production. |
| `SHARE_DEFAULT_EXPIRY_SECONDS` | Default share lifetime, 604800 seconds. |
| `SHARE_MAX_EXPIRY_SECONDS` | Maximum share lifetime, 2592000 seconds. |
| `SHARE_READS_PER_MINUTE` | Per-IP shared snapshot read limit, default 60. |
| `DISCOVERABILITY_DEFAULT_EXPIRY_SECONDS` | Default section opt-in lifetime, 1209600 seconds. |
| `DISCOVERABILITY_MAX_EXPIRY_SECONDS` | Maximum section opt-in lifetime, 7776000 seconds. |
| `FRIEND_SEARCHES_PER_MINUTE` | Per-user and per-IP classmate search limit, default 30. |
| `AUTO_PLAN_TOKEN_SIGNING_KEY` | Signs auto-plan option tokens; required in production. |
| `AUTO_PLAN_TOKEN_TTL_SECONDS` | Auto-plan option token lifetime, default 600. |
| `AUTO_PLAN_MAX_DESIRED_COURSES` / `AUTO_PLAN_MAX_SELECTED_COURSES` | Bounds requested and selected course counts, defaults 20 / 12. |
| `AUTO_PLAN_MAX_CANDIDATE_BUNDLES` | Candidate bundle cap, default 600. |
| `AUTO_PLAN_MAX_CANDIDATE_OCCURRENCES` | Expanded occurrence cap, default 50000. |
| `AUTO_PLAN_MAX_CONFLICT_EDGES` | Solver conflict-edge cap, default 100000. |
| `AUTO_PLAN_MAX_HORIZON_DAYS` | Scheduling horizon cap, default 240 days. |
| `AUTO_PLAN_MAX_REQUEST_BYTES` / `AUTO_PLAN_MAX_OPTION_TOKEN_BYTES` | Input and signed-token byte caps, defaults 32768 / 131072. |
| `AUTO_PLAN_SOLVER_TIMEOUT_MS` / `AUTO_PLAN_SOLVER_CONCURRENCY` | Solver timeout and process concurrency, defaults 8000 ms / 2. |
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
| `ACADEMIC_CURRENT_TERM_CODE` | Optional actual ongoing UST term code (for example `2610`); only controls the `isCurrent` display flag. |
| `ACADEMIC_QUOTA_TTL_SECONDS` | Quota freshness lifetime, default 900. |
| `ACADEMIC_QUOTA_MIN_INTERVAL_SECONDS` | Minimum time between successful quota refreshes, default 300. |
| `ACADEMIC_QUOTA_MAX_JOBS_PER_POLL` | Maximum overdue watched sections enqueued by one worker scan, default 100. |
| `REFRESH_FAILURE_COOLDOWN_SECONDS` | Permanent-failure cooldown and retry backoff cap, default 3600. |
| `REFRESH_MAX_ATTEMPTS` | Maximum worker attempts per quota job, default 3. |
| `REFRESH_LEASE_SECONDS` | Worker claim and resource lease lifetime, default 60. |
| `ACADEMIC_PROVIDER_BASE_URL` | HKUST Class Schedule base URL for the worker. |
| `COMMON_CORE_MAX_AGE_DAYS` | Maximum age of the active Common Core verification, default 365. |
| `API_BIND_ADDRESS` | Bind address for the API, `0.0.0.0` by default. Set `127.0.0.1` to keep it inside WSL. |
| `API_PORT` | Host port for Compose, default 3000. |
| `FRONTEND_HOST` / `FRONTEND_PORT` | Bind address and port for the request console, defaults `0.0.0.0` / 4173. |

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | Dev server on all interfaces, watch mode, debug logs |
| `bun run start` | Same without watch, info logs |
| `bun run frontend` | Static API console on `0.0.0.0:4173` |
| `bun run worker:academic-refresh` | Process queued section-quota refreshes in a separate process |
| `bun run worker:ics-import-recovery` | Mark expired ICS imports failed and remove their staged event rows; schedule this one-shot command separately |
| `bun run test` | Tests, with coverage |
| `bun run compile` | Type-check `src` and `test` with `tsc` |
| `bun run check` | Read-only formatting + lint check |
| `bun run lint` | Auto-fix lint issues |
| `bun run fmt` | Auto-format the repo |

## Auth

Users and their tokens live in `src/auth/users.ts`. There are two sample users, alice and bob. Their tokens work as passwords, so replace them before deploying anything real. Protected routes want a bearer header:

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

Setting `AUTH_SKIP=true` turns verification off completely. Scoped requests then arrive as a fixed anonymous user (`{ username: "anonymous", name: null }`, plus an `X-Auth-Skip: true` response header), which stops stale tokens in your HTTP client from producing mystery 401s.

## API docs

Swagger UI is at http://localhost:3000/documentation, Scalar at http://localhost:3000/reference.

The route matrix, architecture, Docker topology, worker lifecycle, retention policy, academic import procedure, solver limits, privacy rules, and project directory live in the [documentation index](docs/README.md).

## Events

`POST /events`, `GET /events`, `GET /events/:id`, `PATCH /events/:id`, and `DELETE /events/:id` all need a bearer token. For example:

```sh
curl -X POST http://localhost:3000/events \
  -H 'Authorization: Bearer alice-dev-token' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: first-study-group' \
  -d '{"title":"Study group","startsAt":"2026-09-24T10:00:00Z","endsAt":"2026-09-24T11:00:00Z"}'
```

A timed event uses UTC `startsAt`/`endsAt`. An all-day event uses an inclusive `startDate` and an exclusive `endDate` with `allDay: true`. Weekly recurrence is stored on the master event rather than expanded into rows.

`GET /events` returns stored records ordered by `startsAt`, then `id`, with `limit` (1..100), a signed `cursor`, and optional `source`, `eventType`, and `readonly` filters. Optional `from` and `to` must be supplied together. The list still returns each stored master once when any of its occurrences overlaps `[from, to)`.

`supersedesCalendarKey` must refer to a visible course or imported ICS projection. A manual event can then replace that occurrence in calendar and conflict results.

Single-resource responses include a strong `ETag`. Send it as `If-Match` for PATCH and DELETE; a missing header returns 428 and a stale revision returns 409. Repeating a POST with the same `Idempotency-Key` and body replays the original response within the configured retention window. A matching `externalId` also returns the existing manual event, while different content is a 409 conflict. Imported events can be read but not changed through these routes.

`POST /events/import/ics` accepts a `text/calendar` body. Optional `from` and `to` parameters set the occurrence validation window, accept local dates or UTC timestamps, and are bounded by `CALENDAR_MAX_WINDOW_DAYS`. `defaultBlocksTime` defaults to `true` for timed events; all-day imports stay informational. The response reports created, updated, skipped, and rejected counts. `Idempotency-Key` makes retries replay the completed response, and it cannot be reused for different content while retention lasts.

Imports are stored as versions. The newest active version supplies each UID, and deleting an import restores an older active version when one exists. Use `GET /events/imports` to list versions and `DELETE /events/imports/:importId` to remove one. `GET /events.ics` exports the visible calendar and accepts the same `from`/`to` window plus optional `termCode` and `planId` filters.

## Calendar

`GET /calendar` returns individual occurrences, weekly repeats included. `GET /calendar/conflicts` separates blocking overlaps from informational ones. `GET /calendar/banner` reports a single `current`, `upcoming`, or `free` state. All three are owner-scoped and take the same bearer token as `/events`.

```sh
curl -H 'Authorization: Bearer alice-dev-token' \
  'http://localhost:3000/calendar?from=2026-09-01&to=2026-10-01'
```

`from` and `to` are both optional, but supply both if you want a custom window. They accept `YYYY-MM-DD` in `APP_TIMEZONE` or UTC timestamps ending in `Z`. The default runs from today's local midnight to the first day of next month. The window is half-open and capped at 366 local days by default.

When a result would be too dense, the API fails with `400 calendar_window_too_dense` instead of returning partial data. Weekly recurrence keeps the original local start time and duration: nonexistent DST times are skipped, and an ambiguous time takes the earlier offset. All-day dates have an exclusive end. The Banner captures server time once and only considers blocking timed items, so a client cannot set its clock.

Manual events, effective imported ICS events, and course-plan selections all feed the calendar. `termCode` and `planId` filter the course-plan projections. Conflict checks used by planner apply re-read current blocking manual and imported ICS events, which is why an event imported after you generated a recommendation can make its signed option stale.

## Documentation and project layout

The source tree and module ownership map are in [docs/directory.md](docs/directory.md). The API, architecture, feature, and operations documents are indexed in [docs/README.md](docs/README.md).

## Tests

`bun run test` runs everything. Route tests exercise each plugin on a bare Fastify instance. The Mongo test boots the whole app with plugins autoloaded and collections created; it uses an in-memory server by default, or the dedicated database named by `MONGO_TEST_URI` when set. Collection and index tests always use an isolated in-memory MongoDB. Nothing external is needed by default.

## Adding your own stuff

New routes go in a folder under `src/routes/`. Fastify autoload uses the folder name as the prefix unless the module exports `prefixOverride`.

New core collections and indexes belong in `src/plugins/init-mongo.ts`. Academic collections belong in `src/plugins/academic-collections.ts` and are exposed through the typed Fastify decorations.
