/**
 * @hameddk/cursor-spend-collector — pull spend and usage events from
 * Cursor's Admin API.
 *
 * Pure data-fetcher. Caller supplies the Admin API key.
 * No DB, no filesystem, no business logic, no log-scraper fallback.
 */

const DEFAULT_BASE = 'https://api.cursor.com';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CursorSpendError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'CursorSpendError';
    if (cause) this.cause = cause;
  }
}

export class CursorSpendConfigError extends CursorSpendError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'CursorSpendConfigError';
  }
}

export class CursorSpendAuthError extends CursorSpendError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { cause });
    this.name = 'CursorSpendAuthError';
    this.status = status;
    this.body = body;
  }
}

export class CursorSpendRateLimitError extends CursorSpendError {
  constructor(message, { retryAfter, body, cause } = {}) {
    super(message, { cause });
    this.name = 'CursorSpendRateLimitError';
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

export class CursorSpendApiError extends CursorSpendError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { cause });
    this.name = 'CursorSpendApiError';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY_HINT =
  'Cursor Admin API key required. Generate at cursor.com/dashboard → Settings → Cursor Admin API Keys (team admin role only).';

function isoDateOnly(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s));
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function classifyHttpError(status, body, endpoint) {
  if (status === 401 || status === 403) {
    return new CursorSpendAuthError(
      `Cursor auth failed (${status}) calling ${endpoint}. ${ADMIN_KEY_HINT}`,
      { status, body }
    );
  }
  if (status === 429) {
    return new CursorSpendRateLimitError(`Cursor rate limited (${status}) calling ${endpoint}`, {
      retryAfter: null,
      body,
    });
  }
  return new CursorSpendApiError(`Cursor API error ${status} calling ${endpoint}`, {
    status,
    body,
  });
}

function basicAuthHeader(apiKey) {
  // Cursor uses HTTP Basic with the API key as username and an empty password.
  const token = Buffer.from(`${String(apiKey).trim()}:`).toString('base64');
  return `Basic ${token}`;
}

function utcDateFromIsoOrUnix(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: Cursor returns Unix milliseconds for event timestamps.
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pagination driver
// ---------------------------------------------------------------------------

/**
 * Drive a page-number-based pagination loop. Stops when:
 *   - response has empty array of items, or
 *   - response indicates no more pages (`hasMore: false`, missing `pagination.next`,
 *     or returned-page-size < requested-page-size).
 *
 * @returns {Promise<{ items: object[], pages: number, lastResponse: object }>}
 */
async function paginatePages({ baseUrl, path, query, headers, fetchImpl, endpointLabel, itemsKey, pageSize }) {
  const items = [];
  let page = 1;
  let lastResponse = null;
  for (;;) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));

    let res;
    try {
      res = await fetchImpl(url.toString(), { method: 'GET', headers });
    } catch (cause) {
      throw new CursorSpendApiError(`Network error calling ${endpointLabel}: ${cause.message}`, {
        cause,
      });
    }

    const text = await safeReadText(res);
    if (!res.ok) {
      throw classifyHttpError(res.status, text, endpointLabel);
    }

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (cause) {
      throw new CursorSpendApiError(`${endpointLabel} returned non-JSON (${res.status})`, {
        status: res.status,
        body: text,
        cause,
      });
    }
    lastResponse = payload;

    const pageItems = Array.isArray(payload[itemsKey]) ? payload[itemsKey] : [];
    items.push(...pageItems);

    // Stop conditions: empty page, hasMore=false, or items < pageSize.
    if (pageItems.length === 0) break;
    if (payload.hasMore === false) break;
    if (pageItems.length < pageSize) break;

    page++;
    // Hard safety cap to avoid infinite loops on malformed APIs.
    if (page > 1000) break;
  }
  return { items, pages: page, lastResponse };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CollectorRow
 * @property {string} date              ISO YYYY-MM-DD (UTC).
 * @property {string|null} identity     Member email (preferred) or member id.
 * @property {'email'|'user_id'|'aggregate'} identityType
 * @property {string|null} tool         Model name from the event.
 * @property {number} tokens_input
 * @property {number} tokens_output
 * @property {number|null} cost_usd     Converted from event-level cents.
 * @property {number} session_minutes   Always 0 for this collector.
 * @property {object} raw               Original event payload.
 */

/**
 * @typedef {Object} RunArgs
 * @property {string} apiKey          Required. Cursor Admin API key.
 * @property {string} from            Required. ISO YYYY-MM-DD (UTC, inclusive).
 * @property {string} to              Required. ISO YYYY-MM-DD (UTC, inclusive).
 * @property {number} [pageSize=200]  Items per page (Cursor max varies; 200 is safe).
 * @property {string} [baseUrl]       Override Cursor host (testing only).
 * @property {typeof fetch} [fetch]   Override fetch (testing only).
 */

/**
 * Run the collector for a date range.
 *
 * @param {RunArgs} args
 */
export async function runCollector(args) {
  try {
    if (!args || typeof args !== 'object') {
      throw new CursorSpendConfigError('runCollector: args object is required');
    }
    if (!args.apiKey || typeof args.apiKey !== 'string') {
      throw new CursorSpendConfigError('apiKey is required');
    }
    if (!isoDateOnly(args.from)) {
      throw new CursorSpendConfigError('from must be ISO YYYY-MM-DD');
    }
    if (!isoDateOnly(args.to)) {
      throw new CursorSpendConfigError('to must be ISO YYYY-MM-DD');
    }
    if (args.from > args.to) {
      throw new CursorSpendConfigError(`from (${args.from}) must be <= to (${args.to})`);
    }
  } catch (err) {
    if (err instanceof CursorSpendConfigError) {
      return { ok: false, error: err.message, errorType: 'config' };
    }
    throw err;
  }

  const fetchImpl = args.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      error: 'fetch is not a function (and globalThis.fetch is unavailable)',
      errorType: 'config',
    };
  }

  const baseUrl = (args.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const headers = {
    Authorization: basicAuthHeader(args.apiKey),
    Accept: 'application/json',
  };
  const pageSize = Number.isInteger(args.pageSize) && args.pageSize > 0 ? args.pageSize : 200;

  // --- Members lookup (best-effort — failure is non-fatal) ---
  let memberMap = new Map();
  try {
    const members = await paginatePages({
      baseUrl,
      path: '/teams/members',
      query: {},
      headers,
      fetchImpl,
      endpointLabel: '/teams/members',
      itemsKey: 'teamMembers',
      pageSize,
    });
    for (const m of members.items) {
      const id = m?.id ?? m?.userId ?? m?.user_id ?? null;
      if (id != null) memberMap.set(String(id), m);
    }
  } catch (err) {
    if (err instanceof CursorSpendAuthError) {
      // Auth failure is fatal — the usage-events call would also fail.
      return mapErrorToResult(err);
    }
    // Other failures: continue without member resolution.
  }

  // --- Usage events ---
  let events;
  let totalPages = 0;
  try {
    const r = await paginatePages({
      baseUrl,
      path: '/teams/usage-events',
      query: { startDate: args.from, endDate: args.to },
      headers,
      fetchImpl,
      endpointLabel: '/teams/usage-events',
      itemsKey: 'usageEvents',
      pageSize,
    });
    events = r.items;
    totalPages += r.pages;
  } catch (err) {
    return mapErrorToResult(err);
  }

  // --- Aggregate by (date, member, model) ---
  const byKey = new Map();
  for (const ev of events) {
    const date = utcDateFromIsoOrUnix(ev?.timestamp ?? ev?.createdAt ?? ev?.date);
    if (!date) continue;
    if (date < args.from || date > args.to) continue;

    const memberId = ev?.userId ?? ev?.user_id ?? ev?.memberId ?? null;
    const member = memberId != null ? memberMap.get(String(memberId)) : null;
    const email = member?.email ?? ev?.userEmail ?? ev?.email ?? null;
    const identity = email ?? (memberId != null ? String(memberId) : null);
    const identityType = email ? 'email' : memberId != null ? 'user_id' : 'aggregate';

    const model = ev?.model ?? ev?.modelName ?? null;
    const key = `${date}|${identity ?? ''}|${model ?? ''}`;

    const tokensInput = Number(ev?.inputTokens ?? ev?.tokensInput ?? ev?.input_tokens ?? 0) || 0;
    const tokensOutput = Number(ev?.outputTokens ?? ev?.tokensOutput ?? ev?.output_tokens ?? 0) || 0;
    const costCents = Number(ev?.costCents ?? ev?.cost_cents ?? ev?.spendCents ?? NaN);

    const existing = byKey.get(key);
    if (existing) {
      existing.tokens_input += tokensInput;
      existing.tokens_output += tokensOutput;
      if (Number.isFinite(costCents)) {
        existing.costCents = (existing.costCents ?? 0) + costCents;
      }
      existing.eventCount++;
    } else {
      byKey.set(key, {
        date,
        identity,
        identityType,
        model,
        tokens_input: tokensInput,
        tokens_output: tokensOutput,
        costCents: Number.isFinite(costCents) ? costCents : null,
        eventCount: 1,
        firstRaw: ev,
      });
    }
  }

  const rows = [...byKey.values()].map((r) => ({
    date: r.date,
    identity: r.identity,
    identityType: r.identityType,
    tool: r.model,
    tokens_input: r.tokens_input,
    tokens_output: r.tokens_output,
    cost_usd: r.costCents != null ? r.costCents / 100 : null,
    session_minutes: 0,
    raw: { event_count: r.eventCount, sample: r.firstRaw },
  }));

  return {
    ok: true,
    rows,
    meta: {
      via: 'admin_api/usage-events',
      pages_fetched: totalPages,
      events_aggregated: events.length,
      members_resolved: memberMap.size,
      warnings: [],
    },
  };
}

function mapErrorToResult(err) {
  if (err instanceof CursorSpendAuthError) {
    return { ok: false, error: err.message, errorType: 'auth' };
  }
  if (err instanceof CursorSpendRateLimitError) {
    return { ok: false, error: err.message, errorType: 'rate_limit' };
  }
  if (err instanceof CursorSpendApiError) {
    if (err.status === 404) return { ok: false, error: err.message, errorType: 'not_found' };
    if (/^Network error/.test(err.message)) {
      return { ok: false, error: err.message, errorType: 'network' };
    }
    return { ok: false, error: err.message, errorType: 'parse' };
  }
  return { ok: false, error: err.message || String(err), errorType: 'network' };
}
