# @hameddk/cursor-spend-collector

Pull **spend** and **usage events** from Cursor's Admin API. Granular
per-event data with model, token counts, and cost in cents — aggregated
into per-(date, member, model) rows.

- Calls `/teams/usage-events` for the canonical usage stream
- Calls `/teams/members` for email/name resolution
- HTTP Basic auth using your Cursor Admin API key
- Page-number-based pagination, driven transparently
- Caller supplies the API key — no DB, no filesystem, no business logic
- **No log-scraper fallback**: if the API key is missing or invalid,
  the collector fails loudly with `errorType: 'auth'`
- Zero dependencies, ESM, Node ≥ 18

> Status: 0.1.0 — early. Public API is stable for the documented surface.

## Why

Cursor's local IDE log files are not a reliable usage source — they don't
record cost, the format changes between releases, and team-wide visibility
is impossible without copying logs from every developer's machine. The
Admin API (introduced in 2026) exposes the same data Cursor uses to
generate its own dashboards.

## Install

```bash
npm install @hameddk/cursor-spend-collector
```

## Quick start

```js
import { runCollector } from '@hameddk/cursor-spend-collector';

const result = await runCollector({
  apiKey: process.env.CURSOR_ADMIN_KEY,
  from: '2026-04-01',
  to:   '2026-04-30',
});

if (!result.ok) {
  console.error(`[${result.errorType}] ${result.error}`);
  process.exit(1);
}

for (const row of result.rows) {
  console.log(`${row.date}  ${row.identity}  ${row.tool}  $${row.cost_usd?.toFixed(4)}`);
}
```

## API

```js
runCollector({
  apiKey: string,           // required — Cursor Admin API key
  from: 'YYYY-MM-DD',       // required — UTC inclusive
  to:   'YYYY-MM-DD',       // required — UTC inclusive
  pageSize?: number,        // default 200; per-page item cap
  baseUrl?: string,         // testing only
  fetch?: typeof fetch,     // testing only
})
```

### Success result

```ts
{
  ok: true,
  rows: Array<{
    date: 'YYYY-MM-DD',
    identity: string | null,        // member email (preferred) or member id
    identityType: 'email' | 'user_id' | 'aggregate',
    tool: string | null,            // model from the event
    tokens_input: number,
    tokens_output: number,
    cost_usd: number | null,        // converted from event-level cents
    session_minutes: 0,
    raw: { event_count: number, sample: ... }
  }>,
  meta: {
    via: 'admin_api/usage-events',
    pages_fetched: number,
    events_aggregated: number,
    members_resolved: number,
    warnings: string[],
  }
}
```

### Error result

```ts
{
  ok: false,
  error: string,
  errorType: 'auth' | 'rate_limit' | 'not_found' | 'network' | 'parse' | 'config',
}
```

## Authentication

Generate a Cursor Admin API key:
**cursor.com/dashboard → Settings → Cursor Admin API Keys**.

Only **team admin** roles can create API keys. Standard team members
cannot — their tokens will return 401, which this collector surfaces as
`errorType: 'auth'` with an explicit hint.

The key is sent as HTTP Basic auth with the API key as the username and
an empty password — the collector handles this for you.

## Pagination

`/teams/usage-events` and `/teams/members` use page-number pagination
(`page=1`, `page=2`, ...). The collector follows pages until any of:

- the response items array is empty,
- the response sets `hasMore: false`,
- the response items count is less than the requested `pageSize`.

A hard safety cap (1000 pages) prevents runaway loops on malformed
responses. Tested with 90-day ranges spanning 5+ pages — see
`test/pagination.test.js`.

## Members resolution

The collector calls `/teams/members` first to build a map of
`memberId → email`. Each event's `userId` is then resolved to the
member's email if available; otherwise the raw `userId` is used as the
identity.

If `/teams/members` fails for a non-auth reason (e.g. 500), the collector
**continues** with `userId`-only identity — `meta.warnings` notes the
fallback. If `/teams/members` returns 401/403, the failure is fatal because
the usage-events call would also fail.

## Aggregation

Granular events are aggregated by `(date, identity, model)`. Multiple
events on the same day from the same member to the same model become one
row with summed tokens and cost. The original event count is preserved
on `row.raw.event_count`.

## v0.1.0 scope

- `/teams/usage-events` — primary data source ✓
- `/teams/members` — best-effort identity resolution ✓
- `/teams/spend` — not used in v0.1.0 (would only duplicate cycle-to-date
  totals). Track for future versions if cross-checking is needed.

## Errors

```js
import {
  CursorSpendError,           // base
  CursorSpendConfigError,     // bad args
  CursorSpendAuthError,       // 401/403 — fatal, no fallback
  CursorSpendRateLimitError,  // 429
  CursorSpendApiError,        // other HTTP / parse failures
} from '@hameddk/cursor-spend-collector';
```

## Testing hooks

For testing only:

```js
runCollector({
  ...,
  baseUrl: 'http://localhost:8080',
  fetch: customFetch,
})
```

## What this library does **not** do

- Doesn't read local IDE log files. The API is the only mode.
- Doesn't write to a database — return value is rows; persist them yourself.
- Doesn't translate user IDs to display names beyond what `/teams/members`
  returns. If your dashboard wants additional mapping, layer it on top.
- Doesn't fall back to local pricing tables — `cost_usd` comes from the
  event's `costCents` or is `null`.

## License

MIT © 2026 Hamed Sattari
