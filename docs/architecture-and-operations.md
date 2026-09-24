# Architecture and Operations

This service is a read-heavy timetable backend. Fastify autoloads plugins and
routes from `src/`; route handlers authenticate the request, services compose
the use case, domain modules validate and calculate, repositories perform
MongoDB reads and compare-and-set writes, and MongoDB stores the result.
Course data follows a separate path: the operator CLI fetches and normalizes a
versioned import, stages it, and atomically moves the term's active-batch
pointer. API requests only read that active batch. Quota refreshes are queued by
the API and fetched by a separate worker.

## Local startup

With Bun 1.4.2 or newer:

```sh
bun install
bun run dev
curl http://localhost:3000/health
```

Without `MONGO_URI`, development and tests create an in-memory MongoDB. Set
`MONGO_URI` when data must survive a process restart. The sample users and
bearer tokens in `src/auth/users.ts` are for the technical-test environment;
replace them before any real deployment.

## Compose topology

The default Compose stack has three services:

```text
api -> mongodb
academic-worker -> mongodb and the UST quota provider
mongodb -> mongo_data named volume
```

Start and stop it with:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f api academic-worker
docker compose stop
docker compose down -v       # also removes the local Mongo volume
```

The API and Mongo services expose only loopback ports by default. Mongo is
published on host port 27018 and the API on `API_PORT` (3000 by default). The
API health check calls `/health`, which checks the Mongo ping. Both application
containers use an init process so SIGTERM reaches Bun. The academic worker
also checks its stop callback before scanning and before claiming a refresh
job; a graceful shutdown therefore finishes an in-flight claim but does not
start another one.

The Compose worker is a long-running quota refresher. Full-term course imports
and Common Core catalog loads are one-shot operator jobs and must run outside
the API container, for example from a scheduler or a controlled release job.

## HTTP surface

Swagger is available at `/documentation` and Scalar at `/reference`. Protected
routes use `Authorization: Bearer <token>` and isolate records by the
authenticated username.

| Area | Routes |
| --- | --- |
| Health | `GET /health` |
| Events | `POST/GET /events`, `GET/PATCH/DELETE /events/:id` |
| ICS | `POST /events/import/ics`, `GET /events/imports`, `DELETE /events/imports/:importId`, `GET /events.ics` |
| Calendar | `GET /calendar`, `/calendar/conflicts`, `/calendar/banner` |
| Academic catalog | `GET /terms`, `/terms/:termCode/courses`, `/offerings/:offeringId`, `/offerings/:offeringId/bundles`, `/sections/:sectionId/quota`, `/sections/:sectionId/quota/trends` |
| Watching | `POST/DELETE /courses/:courseId/watch`, `POST/DELETE /sections/:sectionId/watch`, `GET /watching`, `GET /watching/notifications`, `PATCH /watching/notifications/:notificationId` |
| Common Core | `GET /common-core/presets` |
| Plans | `POST/GET /plans`, `GET/PATCH/DELETE /plans/:id`, and plan item, recommendation, auto-plan, compare, and apply routes under `/plans/:id` |
| Sharing | `POST/GET /plans/:id/shares`, `DELETE /plans/:id/shares/:shareId`, `GET /shared-plans/:shareToken` |
| Discovery | `POST/DELETE /sections/:sectionId/discoverability`, `GET /sections/:sectionId/classmates` |

The generated OpenAPI document is the authoritative request and response
schema. Plan writes use strong ETags and `If-Match`; event, import, and share
creation retries use scoped idempotency keys. Public share reads are
capability-token reads and never expose an owner username, notes, custom events,
or a complete timetable.

## Academic data lifecycle

Academic term codes are `YYSS`, where `SS` is `10` (spring), `20` (summer),
`30` (fall), or `40` (winter). Display labels and approximate seasonal ranges
come from the imported term metadata; a season is not evidence that a term is
currently offered. `ACADEMIC_CURRENT_TERM_CODE` is an operator-controlled
display signal. Every term with an active batch remains selectable for personal
planning, including historical terms.

The `tools/course-data` CLI performs bounded provider fetches, normalization,
validation, and Mongo loading. A load is staged under an `importBatchId`, then
activates the pointer under a fenced lease. Partial imports carry forward
untouched records; complete imports retire missing records after destructive
drop checks. `rollback` switches both the active pointer and effective term
metadata to a retained batch. Retired records remain available in older
batches for audit and rollback, but API reads use only the active batch.

The API never crawls the provider. Structural data can be marked stale while
remaining readable. Missing or stale quotas return the cached observation (or
`503` when no observation exists) and enqueue one deduplicated refresh job. The
worker owns per-section and provider-wide Mongo leases, renews them while a
provider call is in flight, and uses retry backoff plus a permanent-failure
cooldown. A stale lease can be reclaimed by a later worker.

## Planning and scoring

Plans reference canonical course, offering, bundle, and section IDs rather than
copying catalog documents. A plan moves from `draft` to `active` to
`archived`; active-plan uniqueness is term-scoped and archived plans are
read-only. Item changes use the parent plan revision as a compare-and-set
precondition.

One-course recommendations and whole-timetable auto-plans have different
contracts. Recommendations rank available bundles and report quota freshness
and uncertainty. Auto-plans build a bounded MILP candidate model, enforce hard
conflicts against current manual/ICS events, and return a signed option token.
The token is compared against the current revision, active catalog batch,
Common Core version, and event snapshot when applied. Solver timeout,
candidate, occurrence, conflict-edge, horizon, request-byte, token-byte, and
concurrency limits are controlled by `AUTO_PLAN_*` settings. Quota and
waitlist values are heuristic risk signals; they are not enrollment
probabilities or guarantees.

Common Core data is an operator-loaded, versioned classification selected by
admission year and term. It reports source/version provenance and offered
course-code counts. It does not determine degree eligibility.

## Retention and maintenance

- Idempotency records are retained for `IDEMPOTENCY_RETENTION_SECONDS` and
  removed by a Mongo TTL index. Their replay secrets are encrypted at rest.
- Public-read and classmate-search rate-limit buckets use short TTL indexes.
- Imported ICS events are read-only through normal event CRUD. The
  `worker:ics-import-recovery` command should run periodically (for example,
  every 5 minutes) to mark abandoned processing manifests failed and remove
  staged rows. If it is delayed, a later import request can reclaim an expired
  lease; the API does not depend on the cleanup job for ordinary retries.
- Academic refresh jobs and leases are recovered by expiry and do not require a
  user-facing refresh endpoint. Users cannot trigger a global catalog or quota
  refresh.
- Retired academic records and previous import batches are kept for rollback
  and operational audit. Cleanup of old batches is an operator policy, not an
  API request.

## Security and privacy

Use stable, unique secrets of at least 32 bytes for cursor signing, auto-plan
tokens, and share-token replay encryption in production. Rotate them through a
planned deployment because old cursors or encrypted idempotency replays become
invalid after rotation. Keep MongoDB and the Compose API bound to trusted
network interfaces, replace sample bearer users, and avoid logging capability
tokens or raw ICS payloads.

Sharing is opt-in, revocable, expiry-bounded, and snapshot-based. Discovery is
also opt-in and returns only an alias, section label, and coarse opt-in date;
it is a planning match, not verified enrollment. No email, token, contact
information, private event, or messaging graph is exposed.

## Verification

From a fresh checkout with no provider access:

```sh
bun install --frozen-lockfile
bun run compile
bun run check
bun test
docker compose config
docker compose up --build -d
curl http://localhost:3000/health
docker compose down
git diff --check
```

The test suite uses in-memory MongoDB unless `MONGO_TEST_URI` points to an
isolated test database. Provider access is only needed for an explicit
operator `fetch` or `refresh` command.
