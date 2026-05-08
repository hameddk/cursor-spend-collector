export function makeScriptedFetch(script) {
  const queue = [...script];
  const calls = [];
  async function fetchImpl(url, options) {
    calls.push({ url, options });
    const next = queue.shift();
    if (!next) {
      throw new Error(`scripted fetch exhausted at call #${calls.length} (${url})`);
    }
    if (typeof next === 'function') return next({ url, options });
    if (next.throws) throw next.throws;
    const bodyText = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
    return makeResponse(next.status ?? 200, bodyText, next.headers);
  }
  return { fetch: fetchImpl, calls, queue };
}

function makeResponse(status, bodyText, extraHeaders) {
  const map = new Map(Object.entries(extraHeaders || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => map.get(String(n).toLowerCase()) ?? null },
    async text() {
      return bodyText;
    },
  };
}

export function makeMembersPayload(members, hasMore = false) {
  return { teamMembers: members, hasMore };
}

export function makeEventsPayload(events, hasMore = false) {
  return { usageEvents: events, hasMore };
}

/** Build a usage event with sensible defaults. */
export function makeEvent({ timestamp, userId, model, inputTokens = 0, outputTokens = 0, costCents = 0 }) {
  return {
    timestamp: typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString(),
    userId,
    model,
    inputTokens,
    outputTokens,
    costCents,
  };
}
