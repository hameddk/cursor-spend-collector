import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  runCollector,
  CursorSpendError,
  CursorSpendConfigError,
  CursorSpendAuthError,
  CursorSpendRateLimitError,
  CursorSpendApiError,
} from '../src/index.js';
import { makeScriptedFetch, makeMembersPayload, makeEventsPayload, makeEvent } from './_helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

describe('error class hierarchy', () => {
  it('all extend CursorSpendError and Error', () => {
    assert.ok(new CursorSpendConfigError('x') instanceof CursorSpendError);
    assert.ok(new CursorSpendAuthError('x') instanceof CursorSpendError);
    assert.ok(new CursorSpendRateLimitError('x') instanceof CursorSpendError);
    assert.ok(new CursorSpendApiError('x') instanceof CursorSpendError);
    assert.ok(new CursorSpendError('x') instanceof Error);
  });
});

describe('config validation', () => {
  it('errorType=config when args missing', async () => {
    const r = await runCollector();
    assert.equal(r.errorType, 'config');
  });

  it('errorType=config when apiKey missing', async () => {
    const r = await runCollector({ from: '2026-04-01', to: '2026-04-02' });
    assert.equal(r.errorType, 'config');
  });

  it('errorType=config on bad date', async () => {
    const r = await runCollector({ apiKey: 'k', from: 'not-a-date', to: '2026-04-02' });
    assert.equal(r.errorType, 'config');
  });

  it('errorType=config when from > to', async () => {
    const r = await runCollector({ apiKey: 'k', from: '2026-05-01', to: '2026-04-01' });
    assert.equal(r.errorType, 'config');
  });
});

describe('auth — basic auth header', () => {
  it('sends Basic auth header with API key as username + empty password', async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: makeMembersPayload([]) },
      { status: 200, body: makeEventsPayload([]) },
    ]);
    await runCollector({
      apiKey: 'cur_key_test_123',
      from: '2026-04-01',
      to: '2026-04-02',
      fetch,
    });
    const auth = calls[0].options.headers.Authorization;
    assert.match(auth, /^Basic /);
    const decoded = Buffer.from(auth.replace('Basic ', ''), 'base64').toString('utf8');
    assert.equal(decoded, 'cur_key_test_123:');
  });

  it('401 from members → fatal auth error (no fallback)', async () => {
    const { fetch } = makeScriptedFetch([{ status: 401, body: { error: 'invalid' } }]);
    const r = await runCollector({
      apiKey: 'k',
      from: '2026-04-01',
      to: '2026-04-02',
      fetch,
    });
    assert.equal(r.errorType, 'auth');
    assert.match(r.error, /Cursor Admin API key/);
  });

  it('401 from usage-events → fatal auth error (no log-scraper fallback)', async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: makeMembersPayload([]) },
      { status: 401, body: { error: 'invalid' } },
    ]);
    const r = await runCollector({
      apiKey: 'k',
      from: '2026-04-01',
      to: '2026-04-02',
      fetch,
    });
    assert.equal(r.errorType, 'auth');
  });
});

describe('happy path', () => {
  it('aggregates events into per-(date, member, model) rows', async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: fixture('members.json') },
      { status: 200, body: fixture('usage-events-3day.json') },
    ]);
    const r = await runCollector({
      apiKey: 'k',
      from: '2026-04-01',
      to: '2026-04-03',
      fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);

    // Day 1 alice claude-sonnet: 2 events merged → 3700 in, 1000 out, $0.30
    const day1Alice = r.rows.find(
      (row) =>
        row.date === '2026-04-01' &&
        row.identity === 'alice@example.com' &&
        row.tool === 'claude-sonnet-4.5'
    );
    assert.ok(day1Alice, 'day1 alice row should exist');
    assert.equal(day1Alice.tokens_input, 3700);
    assert.equal(day1Alice.tokens_output, 1000);
    assert.equal(day1Alice.cost_usd, 0.30);
    assert.equal(day1Alice.identityType, 'email');
    assert.equal(day1Alice.raw.event_count, 2);

    // Day 2 alice has 1 event
    const day2Alice = r.rows.find((row) => row.date === '2026-04-02' && row.identity === 'alice@example.com');
    assert.equal(day2Alice.cost_usd, 0.50);

    // Total events aggregated across all rows
    const totalEvents = r.rows.reduce((s, row) => s + row.raw.event_count, 0);
    assert.equal(totalEvents, 5);
    assert.equal(r.meta.events_aggregated, 5);
    assert.equal(r.meta.members_resolved, 2);
  });

  it('falls back to user_id identity when member email not in roster', async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: makeMembersPayload([]) }, // empty roster
      {
        status: 200,
        body: makeEventsPayload([makeEvent({ timestamp: '2026-04-01T00:00:00Z', userId: 'user_x', model: 'm1', inputTokens: 100, outputTokens: 50, costCents: 5 })]),
      },
    ]);
    const r = await runCollector({
      apiKey: 'k',
      from: '2026-04-01',
      to: '2026-04-02',
      fetch,
    });
    assert.equal(r.rows[0].identity, 'user_x');
    assert.equal(r.rows[0].identityType, 'user_id');
    assert.equal(r.rows[0].cost_usd, 0.05);
  });

  it('continues without member resolution on members fetch failure', async () => {
    const { fetch } = makeScriptedFetch([
      { status: 500, body: 'internal' }, // members fails
      {
        status: 200,
        body: makeEventsPayload([makeEvent({ timestamp: '2026-04-01T00:00:00Z', userId: 'u1', model: 'm1', inputTokens: 100, outputTokens: 50, costCents: 5 })]),
      },
    ]);
    const r = await runCollector({
      apiKey: 'k',
      from: '2026-04-01',
      to: '2026-04-02',
      fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(r.rows[0].identity, 'u1');
    assert.equal(r.meta.members_resolved, 0);
  });

  it('skips events outside the requested date range', async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: makeMembersPayload([]) },
      {
        status: 200,
        body: makeEventsPayload([
          makeEvent({ timestamp: '2026-03-25T00:00:00Z', userId: 'u1', model: 'm1', inputTokens: 100 }),
          makeEvent({ timestamp: '2026-04-15T00:00:00Z', userId: 'u1', model: 'm1', inputTokens: 200 }),
          makeEvent({ timestamp: '2026-05-10T00:00:00Z', userId: 'u1', model: 'm1', inputTokens: 300 }),
        ]),
      },
    ]);
    const r = await runCollector({
      apiKey: 'k',
      from: '2026-04-01',
      to: '2026-04-30',
      fetch,
    });
    assert.equal(r.rows.length, 1, 'only the 2026-04-15 event is in range');
    assert.equal(r.rows[0].tokens_input, 200);
  });

  it('handles events with no costCents (cost_usd: null)', async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: makeMembersPayload([]) },
      {
        status: 200,
        body: makeEventsPayload([
          { timestamp: '2026-04-01T00:00:00Z', userId: 'u1', model: 'm1', inputTokens: 100, outputTokens: 50 },
        ]),
      },
    ]);
    const r = await runCollector({
      apiKey: 'k',
      from: '2026-04-01',
      to: '2026-04-02',
      fetch,
    });
    assert.equal(r.rows[0].cost_usd, null);
  });
});

describe('error mapping', () => {
  it('429 from usage-events → errorType=rate_limit', async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: makeMembersPayload([]) },
      { status: 429, body: 'rate' },
    ]);
    const r = await runCollector({ apiKey: 'k', from: '2026-04-01', to: '2026-04-02', fetch });
    assert.equal(r.errorType, 'rate_limit');
  });

  it('500 → errorType=parse', async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: makeMembersPayload([]) },
      { status: 500, body: 'oops' },
    ]);
    const r = await runCollector({ apiKey: 'k', from: '2026-04-01', to: '2026-04-02', fetch });
    assert.equal(r.errorType, 'parse');
  });

  it('non-JSON → errorType=parse', async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: makeMembersPayload([]) },
      { status: 200, body: '<html/>' },
    ]);
    const r = await runCollector({ apiKey: 'k', from: '2026-04-01', to: '2026-04-02', fetch });
    assert.equal(r.errorType, 'parse');
  });

  it('network error → errorType=network', async () => {
    const { fetch } = makeScriptedFetch([{ throws: new Error('ECONNREFUSED') }]);
    const r = await runCollector({ apiKey: 'k', from: '2026-04-01', to: '2026-04-02', fetch });
    assert.equal(r.errorType, 'network');
  });
});
