# Course data tool

Independent operator CLI for HKUST Class Schedule imports. It does not start Fastify or serve user requests. Run commands from this directory after `bun install`.

```bash
bun run fetch -- --term 2530 --subject COMP
bun run normalize -- --input data/raw/<file>.json
bun run fixture -- --input data/normalized/<file>.json --output fixtures/sample.json
MONGO_URI=mongodb://localhost:27018/template-api bun run load -- --input data/normalized/<file>.json
MONGO_URI=mongodb://localhost:27018/template-api bun run refresh -- --term 2530
MONGO_URI=mongodb://localhost:27018/template-api bun src/cli.ts rollback --term 2530 --batch <batch-id>
```

`fetch` saves complete raw pages under ignored `data/raw/`. `normalize` produces `course-data-v1` in ignored `data/normalized/`. A subject-filtered fetch is partial and cannot initialize a term. An unfiltered fetch discovers every advertised subject and follows same-subject pagination to the end; missing or repeated pages cannot be normalized as complete.

The public page does not reliably publish exact meeting date ranges, career, section binding, or a current/selectable term signal. Those fields remain unknown; multi-component offerings without binding evidence have no selectable bundle. The tool never infers dates from the season or treats the page's selected term as the university's current term. Scheduled imports should be run by cron or a controlled job, not by an HTTP route. Set `MONGO_URI` to the same database as the API. Never commit raw responses, auth state, or full production exports.

The loader validates input, retains previous batches, and atomically changes one term pointer under a fenced lease. A partial import copies untouched records forward. A complete import marks missing records retired. Large complete-scope drops require `--allow-destructive-reconciliation` after operator inspection. `rollback` switches the pointer and stored term metadata together; it does not roll back newer quota observations.
