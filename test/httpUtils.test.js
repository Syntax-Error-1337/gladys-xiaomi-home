// -----------------------------------------------------------------------------
// fetchJson: JSON envelope handling and the network-transport retry.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../src/xiaomi/httpUtils.js';

function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test('a transient network failure is retried instead of failing the call', async () => {
  let attempts = 0;
  await withFetch(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      }
      return new Response(JSON.stringify({ code: 0, result: {} }), { status: 200 });
    },
    async () => {
      const body = await fetchJson('https://example.test/app/v2/ha/oauth/get_token');
      assert.deepEqual(body, { code: 0, result: {} });
    },
  );
  assert.equal(attempts, 3);
});

test('a network failure that never recovers is surfaced with its cause, not retried forever', async () => {
  let attempts = 0;
  await withFetch(
    async () => {
      attempts += 1;
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    },
    () =>
      assert.rejects(
        fetchJson('https://example.test/app/v2/ha/oauth/get_token'),
        /network error calling \/app\/v2\/ha\/oauth\/get_token: fetch failed \(ENOTFOUND\)/,
      ),
  );
  assert.equal(attempts, 3);
});

test('an HTTP error response is surfaced immediately, never retried', async () => {
  let attempts = 0;
  await withFetch(
    async () => {
      attempts += 1;
      return new Response('', { status: 500 });
    },
    () => assert.rejects(fetchJson('https://example.test/x'), /invalid HTTP status 500/),
  );
  assert.equal(attempts, 1);
});
