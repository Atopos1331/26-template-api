# Documentation index

These documents are split by what you are trying to do: understand the API, understand the system, or run it. The prose here explains intent; the generated OpenAPI document at `/documentation/json` and the route schemas in `src/routes/` are authoritative whenever the two disagree.

| Document | Scope |
| --- | --- |
| [API reference](api.md) | Authentication, endpoint matrix, request fields, response envelopes, pagination, ETags, and idempotency. |
| [Architecture](architecture.md) | Runtime layers, request and data flows, ownership boundaries, and consistency model. |
| [Feature rules](features.md) | Events, calendar, academic data, quotas, plans, auto-planning, ICS, sharing, and discovery. |
| [Operations](operations.md) | Local startup, Compose, environment, workers, imports, retention, recovery, and verification. |
| [Project directory](directory.md) | Source tree, module ownership, tests, frontend console, and operator tooling. |
| [Course-data tool](../tools/course-data/README.md) | CLI commands, provider limitations, verified bindings, and import safety rules. |

If you are new here, read this page, then [Architecture](architecture.md), then [Feature rules](features.md). The API reference is a lookup table rather than something to read end to end.

The dependency-free browser console at [`frontend/index.html`](../frontend/index.html) exercises the local API. It is a development tool, not a production web client.

## Conventions that apply everywhere

Every authenticated resource keys off `request.user.username`. There is no way to read another user's data, and no endpoint takes an owner parameter. A single resource comes back as `{ data, meta }`; a collection as `{ items, page, meta }`. Errors are `{ error: { code, message, requestId, fields? } }`. List limits and cursor behavior vary by endpoint, so the route schema is the place to check.
