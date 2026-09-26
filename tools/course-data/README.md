# Course data tool

An operator CLI for importing HKUST Class Schedule data. It is standalone: it does not start Fastify and it does not serve user requests. Run these commands from this directory after `bun install`.

```bash
bun run fetch -- --term 2530 --subject COMP
bun run normalize -- --input data/raw/<file>.json
bun run normalize -- --input data/raw/<file>.json --bindings data/verified-bindings.json
bun run fixture -- --input data/normalized/<file>.json --output fixtures/sample.json
MONGO_URI=mongodb://localhost:27018/template-api bun run load -- --input data/normalized/<file>.json
MONGO_URI=mongodb://localhost:27018/template-api bun run refresh -- --term 2530
MONGO_URI=mongodb://localhost:27018/template-api bun src/cli.ts rollback --term 2530 --batch <batch-id>
```

## The pipeline

`fetch` writes complete raw pages under `data/raw/`, which is gitignored. `normalize` turns those into `course-data-v1` under `data/normalized/`, also gitignored.

There is one trap worth knowing before you run `fetch`: a fetch filtered by subject is a partial snapshot and **cannot initialize a term**. To create a term you need an unfiltered fetch, which discovers every advertised subject and follows same-subject pagination to the end. If a page comes back missing or duplicated, the result cannot be normalized as complete, and the tool will say so rather than quietly producing a half-populated term.

Scheduled imports belong in cron or another controlled job. Do not put this behind an HTTP route, and point `MONGO_URI` at the same database the API reads.

## What the source cannot tell you

The public schedule page does not reliably publish exact meeting date ranges, and it does not state which class is associated with which. Treat those as unknowns, not as fields you forgot to map. The tool also does not record an academic-career field, and it does not infer whether a term is current from a season name or a homepage selection.

That last point has a consequence worth stating: every term with an active import batch is available for personal planning, historical terms included. The API marks a term current only when an operator sets `ACADEMIC_CURRENT_TERM_CODE`, so importing a term never makes it current on its own.

IDs are built from the term: an offering is `termCode:courseCode`, and a section appends the class number, as in `2530:COMP2611:12345`. The API serves at most the four most recent imported terms.

## How bundles get built

Component types have to line up before a bundle can be offered.

When two component types share the same numeric group labels, the normalizer records a `derived-label` bundle and emits an `INFERRED_LABEL_BINDING` warning. That warning is the tool telling you it guessed at a relationship the source did not state.

Lettered sections such as `T01A` and `T01B` are alternatives inside group `01`, so a bundle contains one of them together with `L01`. They are never both required. Component types must have exactly matching sets of group numbers. Any layout that stays ambiguous is left as `bundleAvailability: unverified_binding` with no selectable bundle, rather than being filled in with a guess.

Seat data is capacity, enrolled, remaining, waitlisted, and reserve capacity. There is no open/closed flag, and the tool does not invent one.

## Verified bindings

When the source is ambiguous but you know the real answer, you can hand the tool independently verified combinations through `--bindings`. Keep that file outside the repository and record where the matching was confirmed:

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

Each listed combination must contain exactly one section per component type and must not contain a time conflict. A lecture is allowed to appear in more than one verified combination. Combinations you leave out stay unavailable; operator bindings take precedence over the label-derived path, and the API reports both the source and the evidence you recorded.

A later import carries verified combinations forward only while the referenced section IDs, labels, component types, association, and meetings are all unchanged. To withdraw verification for an offering, supply an entry for it with `"combinations": []` and non-empty evidence. When sections change, the affected bundles are retired and the import run records a warning. Bundle provenance is stored as `bindingSource` so it does not overwrite the upstream provider identity kept in `source`.

## Loading and rollback

The loader validates its input, keeps previous batches, and changes one term pointer atomically under a fenced lease, so a reader sees the old batch or the new one and never a half-written state.

A partial import copies untouched records forward. A complete import marks records missing from the new batch as retired, and a large complete-scope drop needs `--allow-destructive-reconciliation` after you have inspected what would be lost. `rollback` switches the pointer and the stored term metadata together. It does not roll back newer quota observations, because those were observed after the batch you are reverting to.

Never commit raw responses, authentication state, or full production exports.
