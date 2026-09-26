# Feature rules

This page covers the behavior that is easy to get wrong when you use the API. Endpoint shapes are in the [API reference](api.md). When this page and a route schema disagree, the schema wins; the same goes for the domain modules on validation limits.

## Events and calendar

A timed event needs UTC `startsAt` and `endsAt` timestamps ending in `Z`. An all-day event needs an inclusive `startDate`, an exclusive `endDate`, and `allDay: true`; it will not accept timed fields.

A weekly event is stored as one master record with a bounded `until` date, not as a row per occurrence. Recurrence keeps the local wall-clock time, so a 10:00 class stays at 10:00 across a DST change. Two edge cases fall out of that: a local time that does not exist on a given day is skipped, and a time that occurs twice takes the earlier offset.

`GET /calendar` is a read-only projection. It merges three sources: your manual events, the effective imported ICS events, and the bundles selected in your plans. `GET /calendar/conflicts` uses half-open time ranges and keeps blocking timed overlaps separate from informational all-day and day-level overlaps, since those are not the same kind of problem. `GET /calendar/banner` captures the server clock once and reports `current`, `upcoming`, or `free`; a client cannot supply its own clock.

Calendar windows, occurrence counts, and conflict pairs are all capped. When a request would exceed a cap it fails explicitly rather than returning a partial answer you might mistake for complete.

A manual event can set `supersedesCalendarKey` to point at a course occurrence or imported event you own. That hides the projection from calendar and conflict output while your manual replacement stays visible. Imported events are read-only through normal event CRUD.

## ICS import and export

`POST /events/import/ics` takes a `text/calendar` body. It validates the occurrence expansion within a bound, resolves supported time zones and fixed VTIMEZONE definitions, and stores the result as a versioned manifest. The newest active import supplies each UID; delete it and an older active version takes over when one exists. An import that is still processing holds a lease, and `worker:ics-import-recovery` can clean up one that was abandoned.

The response reports how many occurrences were created, updated, skipped, and rejected. An `Idempotency-Key` replays the completed response for the same payload, and rejects reuse with different content until retention expires. `GET /events.ics` exports your visible calendar, optionally filtered by date, term, or plan.

## Academic catalog and quota

Term codes look like `YY10`, `YY20`, `YY30`, or `YY40`. Only the four newest terms with active import batches are selectable. `ACADEMIC_CURRENT_TERM_CODE` does not affect selectability; it only controls the `isCurrent` display flag. Structural responses carry freshness metadata: source, state, timestamps, and whether the data is stale.

Offerings reference versioned courses, sections, and bundles rather than copying them. When component types share the same numeric group labels, the importer builds `derived-label` bundles and emits a warning, because it is inferring a relationship the source page did not state. Lettered labels such as `T01A` and `T01B` are alternatives inside group `01`, so each bundle includes exactly one of them alongside `L01`; they are never required together. Component types must have matching sets of group numbers. Anything still ambiguous stays visible as `unverified_binding` with no selectable bundle until an operator supplies the exact combinations by hand.

`GET /sections/:sectionId/quota` returns the latest cached observation. If that observation is stale or missing, the request queues one refresh job; while no observation exists at all, the route returns `503` until a worker produces the first one. `GET /sections/:sectionId/quota/trends` returns bounded observations, deterministic slopes, data-quality notes, and a versioned difficulty heuristic. Treat quota and waitlist numbers as risk signals. They are not enrollment probabilities and they are not guarantees.

## Watching and notifications

You can watch a term-scoped course or a single section, with `notificationPreference` set to `none` or `in_app`. A course watch is expanded to the current sections during each worker scan, and retired sections are skipped. Notifications are listed with signed cursors and only move to read through the acknowledge endpoint; there is no way to mark one unread again. The worker coalesces refresh jobs and projects quota changes asynchronously.

Each watch also carries a `quotaSummary`. For a course watch it reports a remaining range per component type (`LEC`, `TUT`, `LAB`) plus counts of observed, missing, stale, and full sections. A section counts as full only when its capacity is known and positive and its remaining count is zero; a section without usable capacity is reported as `unknown` rather than counted as full. A section watch uses the same shape. Freshness is stale when any section is missing or stale.

## Plans and items

A plan stores `offeringId` and `bundleId` references. It does not copy the catalog documents, so a plan stays small and always reflects the current batch.

A plan moves `draft` → `active` or `archived`, and one owner can have only one active plan per term. Two things about that lifecycle are worth knowing before you click anything: archiving is terminal, and archived plans are read-only. You cannot un-archive a plan, rename it, or edit its items afterwards. Creating a new plan is the only way back.

Items are `selected`, `alternative`, or `rejected`. A plan cannot hold the same bundle twice, and it cannot select two bundles for the same course. Promoting an alternative and applying an auto-plan both re-check those invariants, along with your current calendar conflicts.

Every plan response carries a `revision` and a strong `ETag`. Plan writes, item writes, and auto-plan apply all require `If-Match`. The parent plan revision is the compare-and-set boundary even for item changes, which is what stops two concurrent clients from quietly overwriting each other.

## Recommendations and auto-planning

Recommendations rank selectable bundles for one target course, weighing schedule constraints, preferred windows, excluded weekdays, credit bounds, quota freshness, and waitlist uncertainty. Unverified section bindings do not produce selectable bundles. The response is read-only and can be stale the moment it is generated.

Auto-planning takes requested courses, optional course groups, your current selection, hard and preferred time constraints, credit bounds, fill rules, quota policy, scoring mode, and a result limit. It builds a bounded MILP model and returns `completed`, `time_limited`, or `infeasible` along with diagnostics. `coverage_first`, `seat_safety`, and `balanced` are built in. `custom` needs integer weights that sum to 100, with at least 10 of those points on coverage.

The solver is bounded on every axis that could otherwise blow up: desired and selected courses, candidate bundles, expanded occurrences, conflict edges, horizon days, request bytes, signed-token bytes, timeout, and concurrency. Apply needs the signed `optionToken`, a current plan revision, and an idempotency key. It revalidates the active catalog batch, the Common Core version, the current quota policy, and current blocking calendar items before it writes anything.

## Common Core

Common Core classifications are loaded by an operator and versioned by term and admission cohort. The API reports where the data came from, which version it is, and how many distinct course codes are offered. It does not decide degree eligibility and it does not promise that a category satisfies your program's requirements.

## Sharing and discovery

`POST /plans/:id/shares` creates an expiring, revocable capability token for a sanitized snapshot of a plan. The public read route returns that snapshot and nothing else: no owner username, no private notes, no custom events, no tokens, and no reference to the live plan. Share creation supports scoped idempotent replay. Reads are rate-limited per IP.

Section discovery requires explicit opt-in with a display name and an expiry. Classmate results expose an alias, the section context, and a coarse opt-in date. Those results mean "someone else is planning this section". They are not verified enrollment, not a social graph, and not contact information.
