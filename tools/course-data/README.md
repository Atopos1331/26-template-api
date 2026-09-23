# Course data tool

Independent operator CLI for HKUST Class Schedule imports. It does not start Fastify or serve user requests. Run commands from this directory after `bun install`.

```bash
bun run fetch -- --term 2530 --subject COMP
bun run normalize -- --input data/raw/<file>.json
bun run normalize -- --input data/raw/<file>.json --bindings data/verified-bindings.json
bun run fixture -- --input data/normalized/<file>.json --output fixtures/sample.json
MONGO_URI=mongodb://localhost:27018/template-api bun run load -- --input data/normalized/<file>.json
MONGO_URI=mongodb://localhost:27018/template-api bun run refresh -- --term 2530
MONGO_URI=mongodb://localhost:27018/template-api bun src/cli.ts rollback --term 2530 --batch <batch-id>
```

`fetch` saves complete raw pages under ignored `data/raw/`. `normalize` produces `course-data-v1` in ignored `data/normalized/`. A subject-filtered fetch is partial and cannot initialize a term. An unfiltered fetch discovers every advertised subject and follows same-subject pagination to the end; missing or repeated pages cannot be normalized as complete.

The public page does not reliably publish exact meeting date ranges, career, or section binding. The tool never infers dates or current-term status from a season or homepage selection. Every term with an active import batch is available for personal planning, including historical terms; the API marks a term current only when the operator sets `ACADEMIC_CURRENT_TERM_CODE`. Multi-component offerings without binding evidence expose `bundleAvailability: unverified_binding` and have no selectable bundle. Scheduled imports should be run by cron or a controlled job, not by an HTTP route. Set `MONGO_URI` to the same database as the API. Never commit raw responses, auth state, or full production exports.

An operator can supply independently verified exact combinations to `normalize` or `refresh` using `--bindings`. Keep this file outside the repository and record where the matching was confirmed:

```json
{
  "termCode": "2530",
  "offerings": [{
    "courseCode": "COMP2611",
    "evidence": "SIS enrollment rules checked 2026-09-23",
    "combinations": [["12345", "12346", "12347"]]
  }]
}
```

Every listed combination must contain exactly one section per component type and have no time conflict. A lecture may appear in multiple verified combinations. Omitted combinations remain unavailable; labels alone never authorize a bundle. The API includes the bundle's source and evidence for operator-verified records.

Keep `--bindings` outside the repository. A later import without an entry for an offering carries its verified combinations forward only while all referenced section IDs, labels, component types, association and meetings remain unchanged. To withdraw prior verification, supply an entry for that offering with `"combinations": []` and nonempty evidence. Changed sections retire affected bundles; the import run records a warning. Bundle provenance is stored as `bindingSource` so it does not overwrite the upstream provider identity in `source`.

The loader validates input, retains previous batches, and atomically changes one term pointer under a fenced lease. A partial import copies untouched records forward. A complete import marks missing records retired. Large complete-scope drops require `--allow-destructive-reconciliation` after operator inspection. `rollback` switches the pointer and stored term metadata together; it does not roll back newer quota observations.
