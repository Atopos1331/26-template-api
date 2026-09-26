# Project directory

The application root is `26-template-api/`. The API runs on Bun and TypeScript, with Fastify 5, TypeBox schemas, and MongoDB. The tree below shows ownership boundaries rather than listing every generated or dependency file, so you can tell where a change belongs.

```text
26-template-api/
├── src/
│   ├── app.ts                         Fastify app, CORS, OpenAPI, autoloaders
│   ├── options.ts                     Environment parsing and production validation
│   ├── auth/users.ts                  Development users and configured-user types
│   ├── plugins/                       Mongo, academic collections, auth, helpers
│   ├── routes/                        HTTP handlers grouped by resource
│   │   ├── events/                    Manual event CRUD and ICS import
│   │   ├── events-ics.ts              `/events.ics` export
│   │   ├── calendar/                  Occurrences, conflicts, and Time Banner
│   │   ├── terms/ and offerings/      Academic catalog reads
│   │   ├── sections/ and courses/     Quota, watches, and discovery
│   │   ├── common-core/               Common Core preset reads
│   │   ├── plans/                     Plans, items, recommendations, auto-plans, shares
│   │   ├── watching/                  Watch and notification lists
│   │   └── shared-plans/              Public capability-token snapshots
│   ├── domain/                        Pure validation, scheduling, scoring, and tokens
│   ├── services/                      Use-case orchestration
│   ├── repositories/                  Mongo queries and owner/CAS boundaries
│   ├── providers/ust-quota.ts         Provider HTTP client and quota parsing
│   ├── http/                          TypeBox academic schemas and API errors
│   └── workers/                       Quota refresh and ICS recovery processes
├── tools/course-data/                 Independent catalog import package
├── frontend/                          Dependency-free local API test console
├── test/                              Domain, repository, worker, and route tests
├── contracts/                         Versioned course-data contract schemas
├── docs/                              Handover documentation
├── compose.yaml                       API, MongoDB, and academic-worker topology
├── Dockerfile                         API container image
├── .env.example                       Configuration reference
├── package.json                        Scripts and dependencies
└── tsconfig.json                       API TypeScript configuration
```

The split between `domain/`, `services/`, and `repositories/` is the one worth internalizing. Domain code stays free of Fastify and MongoDB, which is what keeps it cheap to test. Services decide the order of operations. Repositories are the only place queries belong.

## Test organization

`test/*.test.ts` covers pure domain code, parsers, the solver, option handling, the Mongo bootstrap, and workers. `test/routes/*.test.ts` boots Fastify with its plugins and exercises the HTTP contract through injection, so no port is opened and no external service is needed.

Tests use an in-memory MongoDB by default. `MONGO_TEST_URI` exists for running the full app against a separate database, and it should never point at the development database.

## Frontend console

`frontend/index.html`, `frontend/app.js`, and `frontend/styles.css` make up a static request runner: no build step, no framework, no dependencies. It covers the current route registry, explains each endpoint, ships request presets and worked examples, accepts the Alice/Bob tokens or a custom bearer token, captures IDs and ETags from responses so follow-up calls can reuse them, and handles ICS text and file import plus download.

It is a development tool. It authenticates with a token you provide, and it is not a production client.

## Operator tool

`tools/course-data` is deliberately separate from `src/`. It has its own package, lockfile, TypeScript configuration, provider client, normalization pipeline, fixture output, and Mongo loader. It is the supported way to import a full term or load Common Core data.
