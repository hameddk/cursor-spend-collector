# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-08

### Added
- Initial release.
- `runCollector({ apiKey, from, to, fetch? })` factory.
- Calls Cursor's `/teams/usage-events` for granular per-event usage with
  model name, token counts, and cost in cents.
- Optional `/teams/members` lookup for member email/name resolution.
- HTTP Basic auth using the Cursor Admin API key.
- Page-number-based pagination (`page` query param), driven transparently.
- Errors: `CursorSpendError`, `CursorSpendConfigError`, `CursorSpendAuthError`,
  `CursorSpendRateLimitError`, `CursorSpendApiError`.
- Auth failure (401/403) surfaces as `errorType: 'auth'` with an explicit hint
  about Cursor team-admin role and API key location. **No log-scraper
  fallback** — single collection mode.
- Zero dependencies, ESM, Node ≥ 18.

### Notes
- This module replaces a log-scraping approach (parsing local Cursor IDE log
  files). Log scraping is **not** available as a fallback. If the Admin API
  key is missing or invalid, the collector fails loudly rather than silently
  returning incomplete data.
