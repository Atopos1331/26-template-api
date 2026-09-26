# Operations

## Local startup

You need Bun 1.4.2 or newer. `bun run dev` starts Fastify on port 3000 in watch mode.

Outside production, if `MONGO_URI` is unset the app starts a temporary in-memory MongoDB for you. That is the fastest way to get going, and it is worth knowing the catch up front: the data lives only as long as the process, so restarting the server gives you an empty database again.

```sh
bun install
bun run dev
bun run frontend
curl http://localhost:3000/health
```

Open `http://localhost:4173` for the request console. Both the API and the console bind to `0.0.0.0`, so a Windows browser can reach them over the WSL IP when localhost forwarding is not available. Find that address with `hostname -I` and use `http://<wsl-ip>:4173`, then set the console's API field to the matching `http://<wsl-ip>:3000`.

To keep data across restarts, set `MONGO_URI` before starting the API. Something persistent and local is:

```sh
MONGO_URI=mongodb://localhost:27018/template-api bun run dev
```

The Alice and Bob bearer tokens are development credentials. They are useful for poking at the API and must not reach a real deployment.

## Compose

The default topology is `api -> mongodb`, `academic-worker -> mongodb` plus the UST quota provider, and `mongodb -> mongo_data`. The API is published on `API_PORT`, 3000 by default.

Set `API_BIND_ADDRESS=127.0.0.1` when the API should stay reachable only from inside WSL. The default `0.0.0.0` allows Windows or LAN access, subject to the host firewall.

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f api academic-worker
docker compose stop
docker compose down -v
```

The Compose academic worker runs continuously. Full-term catalog and Common Core imports are operator jobs, not something the API does: run them outside the API container, from a scheduler or a controlled release job.

## Configuration

`.env.example` lists every supported variable. There are four things production will not start without:

- stable secrets of at least 32 bytes for `CURSOR_SIGNING_KEY`, `AUTO_PLAN_TOKEN_SIGNING_KEY`, and `SHARE_TOKEN_REPLAY_ENCRYPTION_KEY`. Keep them identical across API instances, or cursors and tokens minted by one instance will be rejected by another;
- `AUTH_USERS`, a JSON array of explicit users with unique bearer tokens.

Production also rejects `AUTH_SKIP=true`.

| Group | Variables | Default or rule |
| --- | --- | --- |
| Database and auth | `MONGO_URI`, `MONGO_TEST_URI`, `AUTH_SKIP`, `AUTH_USERS`, `APP_TIMEZONE` | In-memory Mongo outside production; `Asia/Hong_Kong`; explicit users and no auth bypass in production. |
| Cursors and sharing | `CURSOR_SIGNING_KEY`, `CURSOR_TTL_SECONDS`, `SHARE_TOKEN_REPLAY_ENCRYPTION_KEY`, `SHARE_*`, `DISCOVERABILITY_*`, `FRIEND_SEARCHES_PER_MINUTE` | 900-second cursors; share default 7 days, max 30 days; discovery default 14 days, max 90 days. |
| Auto-plan safety | `AUTO_PLAN_TOKEN_*`, `AUTO_PLAN_MAX_*`, `AUTO_PLAN_SOLVER_*` | Signed options expire after 600 seconds; bounded candidates, occurrences, conflicts, horizon, request size, timeout, and concurrency. |
| Events and calendar | `RECURRENCE_MAX_SPAN_DAYS`, `IDEMPOTENCY_RETENTION_SECONDS`, `CALENDAR_*`, `TIME_BANNER_UPCOMING_HOURS` | 1461-day recurrence, 86400-second replay retention, 366-day windows, 1000 occurrences, 10000 conflicts, 24-hour lookahead. |
| ICS | `ICS_MAX_PAYLOAD_BYTES`, `ICS_MAX_OCCURRENCES`, `ICS_DEFAULT_IMPORT_WINDOW_DAYS`, `ICS_IMPORT_PROCESSING_LEASE_SECONDS`, `ICS_IMPORT_RECOVERY_GRACE_SECONDS` | 5 MiB payload, 1000 occurrences, 366-day default window, 120-second lease, 3600-second recovery grace. |
| Academic | `ACADEMIC_STRUCTURE_TTL_SECONDS`, `ACADEMIC_CURRENT_TERM_CODE`, `ACADEMIC_QUOTA_*`, `REFRESH_*`, `ACADEMIC_PROVIDER_BASE_URL`, `COMMON_CORE_MAX_AGE_DAYS` | 1-day structure freshness, optional current term, 15-minute quota freshness, provider and worker limits documented in `.env.example`. |
| Host | `API_PORT` | 3000 in Compose. |

## Workers

Run the quota worker against the same persistent database the API uses. Point it at the app database, not the test one, or it will happily refresh quotas nobody reads.

```sh
MONGO_URI=mongodb://localhost:27018/template-api bun run worker:academic-refresh
MONGO_URI=mongodb://localhost:27018/template-api bun run worker:academic-refresh --once
```

`--once` processes at most one job and exits, which is what you want in a scheduler. Run ICS recovery on its own schedule, every five minutes or so:

```sh
MONGO_URI=mongodb://localhost:27018/template-api bun run worker:ics-import-recovery
```

Both workers use leases, so a crashed process does not strand its work. The quota worker retries transient failures and backs off on permanent ones. ICS recovery marks abandoned manifests failed and removes the rows they staged.

## Course-data imports

The CLI has its own [README](../tools/course-data/README.md). A normal run is `fetch`, then `normalize`, optionally with verified bindings, then `load`, with `rollback` available later if you need it.

Loads are staged as a batch and activated atomically, so a reader sees either the old batch or the new one and never a half-written state. A partial import carries untouched records forward. A complete import retires records that are missing from the new batch, and doing that at scale requires `--allow-destructive-reconciliation` after you have looked at what would be dropped.

Never commit raw provider responses, authentication state, production exports, or verified binding files. The API reads only the active batch; older batches stay available for rollback and audit until your retention policy removes them.

## Retention and verification

Mongo TTL indexes clean up idempotency records and short-lived rate-limit buckets. Previous academic batches and retired records stick around for rollback until an operator cleanup policy removes them.

Capability tokens, raw ICS payloads, and bearer tokens must not be logged. MongoDB and the Compose ports should stay on trusted interfaces.

```sh
bun install --frozen-lockfile
bun run compile
bun run check
bun run test
docker compose config
git diff --check
```
