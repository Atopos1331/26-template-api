# API reference

The generated OpenAPI document is the contract. Open `/documentation` for Swagger UI, `/reference` for Scalar, or `/documentation/json` for the raw document. This page records the conventions and endpoint shapes so you can understand the API without reading every route file first. If the two ever disagree, the generated document wins.

## Conventions

Business endpoints want `Authorization: Bearer <token>`. The exceptions are `GET /health`, `GET /example`, `GET /shared-plans/:shareToken`, Swagger, and Scalar. In development the tokens are `alice-dev-token` and `bob-dev-token`; in production they come from `AUTH_USERS`. Everything else is authenticated, including the auth example, timetable, academic, planning, watching, sharing management, and discovery routes.

A single resource comes back as `{ data, meta }`. A collection comes back as `{ items, page: { hasMore, nextCursor }, meta }`. Calendar occurrence listing is the one exception: it returns `items` and `page` at the top level alongside `meta`. Errors always look like `{ error: { code, message, requestId, fields? } }`, so you can switch on `code` and show `message`.

Query-parameter limits arrive as strings and are generally bounded to 1..100. Cursors are signed and bound to the filter that produced them, so a cursor from one query will not work on another; hand back `nextCursor` unchanged. They expire after `CURSOR_TTL_SECONDS`.

ETags are strong, quoted integer revisions. Send one as `If-Match: "<revision>"` on event and plan PATCH and DELETE, and on auto-plan apply. Omitting it returns `428`; sending a revision that is no longer current returns `409`. The second case means someone else got there first, so re-read and retry rather than retrying the same request.

Creation routes that accept `Idempotency-Key` scope the key to the authenticated owner and the route. Reuse it with the same body and you get the stored response back; reuse it with a different body and you get a conflict.

## Health and auth

| Method and path | Auth | Query/body | Result |
| --- | --- | --- | --- |
| `GET /health` | No | None | Readiness object after a Mongo ping. |
| `GET /auth-example` | Yes | None | The authenticated username; useful for checking a token. |

## Events and ICS

| Method and path | Query/path | Body or headers | Result |
| --- | --- | --- | --- |
| `POST /events` | None | Event JSON; optional `Idempotency-Key`. | `201` event in `data`, strong `ETag`. |
| `GET /events` | `limit`, `cursor`, `source`, `eventType`, `readonly`, `from`, `to`. | None. | Stored owner-scoped event masters and signed page. |
| `GET /events/:id` | Path `id`. | None. | One event and strong `ETag`. |
| `PATCH /events/:id` | Path `id`. | Partial event JSON and `If-Match`. | Updated event and strong `ETag`. |
| `DELETE /events/:id` | Path `id`. | `If-Match`. | `204`; imported read-only events cannot be deleted here. |
| `POST /events/import/ics` | Optional `from`, `to`, `defaultBlocksTime`. | `Content-Type: text/calendar`, optional `Idempotency-Key`. | Import manifest and counts. |
| `GET /events/imports` | None. | None. | Owner-scoped import manifests. |
| `DELETE /events/imports/:importId` | Path `importId`. | None. | `204`; active version fallback is handled by the service. |
| `GET /events.ics` | Optional `from`, `to`, `termCode`, `planId`. | None. | `text/calendar` download of the visible calendar. |

A create body needs `title` plus either `startsAt` and `endsAt` for a timed event, or `allDay`, `startDate`, and `endDate` for an all-day one. Everything else is optional: `description`, `location`, `timezone`, `color`, `recurrence`, `sourceName`, `externalId`, `eventType`, `blocksTime`, and `supersedesCalendarKey`. The `recurrence` object is `{ frequency: "weekly", interval: 1..8, weekdays: ["MO".."SU"], until: "YYYY-MM-DD" }`. PATCH does not accept the immutable source fields.

## Calendar

| Method and path | Query | Result |
| --- | --- | --- |
| `GET /calendar` | Optional `from`, `to`, `termCode`, `planId`. | Occurrence `items`, fixed `page`, and warning metadata. |
| `GET /calendar/conflicts` | Optional `from`, `to`, `termCode`, `planId`. | `{ data: { blocking, informational }, meta }`. |
| `GET /calendar/banner` | Optional `termCode`, `planId`. | `{ data: { state, item, minutesRemaining, minutesUntilStart, evaluatedAt }, meta }`. |

## Academic catalog and Common Core

| Method and path | Query/path | Result |
| --- | --- | --- |
| `GET /terms` | `limit`, `cursor`. | Term items with selectable/current flags and freshness metadata. |
| `GET /terms/:termCode/courses` | Path `termCode`; `limit`, `cursor`, `search`, `subject`, `catalogNumber`. | Course offering summaries and page metadata. |
| `GET /offerings/:offeringId` | Path `offeringId`. | Offering, course, term, sections, and bundle availability. |
| `GET /offerings/:offeringId/bundles` | Path `offeringId`. | Selectable bundle items and page metadata. |
| `GET /sections/:sectionId/quota` | Path `sectionId`. | Latest quota snapshot and freshness metadata; may return `503` when no observation exists. |
| `GET /sections/:sectionId/quota/trends` | Path `sectionId`; `window=7d|14d|term`, `limit`, `cursor`. | Latest quota, observations, trend, difficulty, and freshness. |
| `GET /common-core/presets` | Required `admissionYear=YYYY`, `termCode=YYSS`. | Versioned category presets and offered-code counts. |

Freshness is reported as `{ asOf, isStale, source, lastAttemptAt, nextRefreshAt, state }`. Stale structure data is still readable. A quota read that finds nothing current queues refresh work instead of crawling the provider inside your request, so the first caller may get a `503` and the next one will not.

## Course plans and auto-planning

| Method and path | Query/path | Body or headers | Result |
| --- | --- | --- | --- |
| `POST /plans` | None | `{ name, termCode, description? }`. | `201` plan with `revision` and `ETag`. |
| `GET /plans` | `termCode`, `status=draft|active|archived`, `limit`, `cursor`. | None. | Plan collection and signed page. |
| `GET /plans/:id` | Path `id`. | None. | Plan with items and `ETag`. |
| `PATCH /plans/:id` | Path `id`. | `{ name?, description?, status? }` and `If-Match`. | Updated plan and `ETag`. |
| `DELETE /plans/:id` | Path `id`. | `If-Match`. | Archives the plan and returns `204`. |
| `POST /plans/:id/items` | Path `id`. | `{ offeringId, bundleId, status?, note?, colorOverride? }` and `If-Match`. | Updated plan and `ETag`. |
| `PATCH /plans/:id/items/:itemId` | Path `id`, `itemId`. | `{ status?, note?, colorOverride? }` and `If-Match`. | Updated plan and `ETag`. |
| `DELETE /plans/:id/items/:itemId` | Path `id`, `itemId`. | `If-Match`. | Updated plan and `ETag`. |
| `POST /plans/:id/recommendations` | Path `id`. | Recommendation body. | Read-only ranked bundle suggestions. |
| `POST /plans/:id/auto-plans` | Path `id`. | Auto-plan request. | Read-only signed options and diagnostics. |
| `POST /plans/:id/auto-plans/apply` | Path `id`. | `{ optionToken }`, `If-Match`, `Idempotency-Key`. | Applied plan and new `ETag`. |

`DELETE /plans/:id` archives rather than deletes, and archiving cannot be undone. See [Feature rules](features.md) for the full lifecycle.

Academic IDs are built from the term and course: offerings are `termCode:courseCode`, and sections and bundles append the class number, as in `2530:COMP2611` or `2530:COMP2611:12345`. The source is stored separately on each record. `/terms` returns the four newest terms with active data; older terms are not selectable through catalog, plan, or watch APIs.

A recommendation body accepts `targetCourseId`, `excludedCourseIds`, `minCredits`, `maxCredits`, `unavailableWindows`, `preferredWindows`, `avoidWeekdays`, `allowWaitlist`, and `maxRecommendations` (1..50). Time windows are `{ weekdays, startTime, endTime, startDate?, endDate? }`.

An auto-plan body accepts `courses`, `groups`, `includeCurrentSelected`, `constraints`, `mode`, `weights`, `fill`, `allowFullWaitlist`, `unknownQuotaPolicy`, `resultLimit`, and `minDifferentBundles`. Each course entry carries `courseCode`, `required`, `priority`, either `lockedBundleId` or `lockedSectionIds`, and lists of excluded sections and instructors. The response returns `searchStatus`, `planId`, `planRevision`, `normalizedRequest`, `options`, and `diagnostics`; every option includes the signed `optionToken` you pass to apply. Quota data has enrolled, capacity, remaining, and waitlisted counts. There is no open/closed flag, and the API does not invent one.

`allowFullWaitlist` allows sections whose cached `remaining` value is zero. It does not establish that a waitlist is open or that enrollment will succeed.

## Watching, discovery, and sharing

| Method and path | Query/path | Body or headers | Result |
| --- | --- | --- | --- |
| `POST /courses/:courseId/watch` | Path `courseId`; required `termCode`. | Optional `{ notificationPreference: "none"|"in_app" }`. | Watch record. |
| `DELETE /courses/:courseId/watch` | Path `courseId`; required `termCode`. | None. | `204`. |
| `POST /sections/:sectionId/watch` | Path `sectionId`. | Optional notification preference. | Watch record. |
| `DELETE /sections/:sectionId/watch` | Path `sectionId`. | None. | `204`. |
| `GET /watching` | `termCode`, `targetType`, `limit`, `cursor`. | None. | Watch collection. |
| `GET /watching/notifications` | `unreadOnly`, `limit`, `cursor`. | None. | Notification collection. |
| `PATCH /watching/notifications/:notificationId` | Path `notificationId`. | `{ "read": true }`. | Acknowledged notification. |
| `POST /sections/:sectionId/discoverability` | Path `sectionId`. | `{ displayName, expiresInSeconds? }`. | Opt-in record. |
| `DELETE /sections/:sectionId/discoverability` | Path `sectionId`. | None. | `204`. |
| `GET /sections/:sectionId/classmates` | Path `sectionId`; `limit`, `cursor`. | None. | Opted-in planning matches. |
| `POST /plans/:id/shares` | Path `id`. | `{ expiresInSeconds? }`, optional `Idempotency-Key`. | Share metadata and one-time token. |
| `GET /plans/:id/shares` | Path `id`. | None. | Share metadata, excluding replay secrets. |
| `DELETE /plans/:id/shares/:shareId` | Path `id`, `shareId`. | None. | `204`. |
| `GET /shared-plans/:shareToken` | Path `shareToken`. | No auth. | Sanitized, fixed plan snapshot; rate-limited. |
