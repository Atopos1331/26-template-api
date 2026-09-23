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
| `API_PORT` | Host port for Compose, default 3000. |

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | Dev server, watch mode, debug logs |
| `bun run start` | Same without watch, info logs |
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
`source`, `eventType`, and `readonly` filters. It does not expand occurrences
or filter recurring masters by a calendar window yet; those are Phase 04 work.
`supersedesCalendarKey` is rejected until calendar targets can be verified.

Single-resource responses include a strong `ETag`. Send it as `If-Match` for
PATCH and DELETE; a missing header returns 428 and a stale revision returns
409. Repeating a POST with the same `Idempotency-Key` and body replays the
original response within the configured retention window. A matching
`externalId` also returns the existing manual event; different content is a
409 conflict. Imported events may be read but cannot be changed through these
routes.

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
    health/             # Public DB readiness check
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
