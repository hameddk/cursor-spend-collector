import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runCollector } from '../src/index.js';
import { makeScriptedFetch, makeMembersPayload, makeEventsPayload, makeEvent } from './_helpers.js';

describe('pagination', () => {
  it('follows page-number cursor until empty', async () => {
    const { fetch, calls } = makeScriptedFetch([
      // Members: single page
      { status: 200, body: makeMembersPayload([{ id: 'u1', email: 'a@example.com' }]) },
      // Events: 3 pages — first two pass hasMore: true; third returns 0 items (terminator)
      {
        status: 200,
        body: makeEventsPayload(
          [
            makeEvent({ timestamp: '2026-04-01T00:00:00Z', userId: 'u1', model: 'm', inputTokens: 100, outputTokens: 50, costCents: 5 }),
            makeEvent({ timestamp: '2026-04-01T01:00:00Z', userId: 'u1', model: 'm', inputTokens: 100, outputTokens: 50, costCents: 5 }),
          ],
          true
        ),
      },
      {
        status: 200,
        body: makeEventsPayload(
          [
            makeEvent({ timestamp: '2026-04-02T00:00:00Z', userId: 'u1', model: 'm', inputTokens: 100, outputTokens: 50, costCents: 5 }),
            makeEvent({ timestamp: '2026-04-02T01:00:00Z', userId: 'u1', model: 'm', inputTokens: 100, outputTokens: 50, costCents: 5 }),
          ],
          true
        ),
      },
      { status: 200, body: makeEventsPayload([], false) }, // empty page → stop
    ]);
    const r = await runCollector({
      apiKey: 'k',
      from: '2026-04-01',
      to: '2026-04-30',
      pageSize: 2,
      fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(r.meta.events_aggregated, 4);
    // 1 members call + 3 events pages = 4 calls
    assert.equal(calls.length, 4);
    // Verify page param incremented
    assert.match(calls[1].url, /page=1/);
    assert.match(calls[2].url, /page=2/);
    assert.match(calls[3].url, /page=3/);
  });

  it('stops when hasMore=false even if items array equals pageSize', async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: makeMembersPayload([]) },
      {
        status: 200,
        body: { usageEvents: [makeEvent({ timestamp: '2026-04-01T00:00:00Z', userId: 'u1', model: 'm', inputTokens: 1, outputTokens: 1, costCents: 1 })], hasMore: false },
      },
    ]);
    await runCollector({
      apiKey: 'k',
      from: '2026-04-01',
      to: '2026-04-02',
      pageSize: 1, // matches items.length but hasMore: false
      fetch,
    });
    assert.equal(calls.length, 2, 'no extra page fetch when hasMore: false');
  });

  it('handles 90+ day range with 5+ event pages', async () => {
    const events = [];
    const start = Date.parse('2026-04-01T00:00:00Z');
    for (let d = 0; d < 90; d++) {
      events.push(
        makeEvent({
          timestamp: new Date(start + d * 86400000).toISOString(),
          userId: 'u1',
          model: 'm',
          inputTokens: 1000,
          outputTokens: 500,
          costCents: 25,
        })
      );
    }

    // Split into 5 pages of 18 events each.
    const pageSize = 18;
    const pages = [];
    for (let i = 0; i < 5; i++) {
      pages.push(events.slice(i * pageSize, (i + 1) * pageSize));
    }

    const { fetch } = makeScriptedFetch([
      { status: 200, body: makeMembersPayload([]) },
      ...pages.map((p, idx) => ({
        status: 200,
        body: makeEventsPayload(p, idx < pages.length - 1), // hasMore: true for all but last
      })),
      { status: 200, body: makeEventsPayload([], false) }, // terminator
    ]);

    const r = await runCollector({
      apiKey: 'k',
      from: '2026-04-01',
      to: '2026-06-29',
      pageSize,
      fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(r.meta.events_aggregated, 90);
    // 90 distinct dates × 1 member × 1 model = 90 rows
    assert.equal(r.rows.length, 90);

    const totalCost = r.rows.reduce((s, row) => s + (row.cost_usd ?? 0), 0);
    // 90 × $0.25 = $22.50 (with possible float drift)
    assert.ok(Math.abs(totalCost - 90 * 0.25) < 1e-6);
  });
});
