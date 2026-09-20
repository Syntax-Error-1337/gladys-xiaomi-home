// -----------------------------------------------------------------------------
// The OAuth surface: what the user pastes back, and what we send to Xiaomi.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authState,
  buildAuthorizeUrl,
  exchangeCode,
  parseAuthorizationInput,
  refreshToken,
  secondsBeforeRefresh,
} from '../src/xiaomi/oauth.js';
import { OAUTH2_CLIENT_ID } from '../src/xiaomi/constants.js';

const INSTANCE = '0123456789abcdef0123456789abcdef';
const REDIRECT = 'http://homeassistant.local:8123/api/webhook/0123456789abcdef0123456789abcdef';

test('the authorization URL carries what Xiaomi requires', () => {
  const url = new URL(buildAuthorizeUrl({ instanceId: INSTANCE, redirectUrl: REDIRECT }));

  assert.equal(url.origin + url.pathname, 'https://account.xiaomi.com/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), OAUTH2_CLIENT_ID);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.searchParams.get('device_id'), `ha.${INSTANCE}`);
  assert.equal(url.searchParams.get('state'), authState(INSTANCE));
  // Xiaomi expects the Python-style capitalized boolean.
  assert.equal(url.searchParams.get('skip_confirm'), 'False');
});

test('the anti-CSRF state is derived from the installation, not random', () => {
  assert.equal(authState(INSTANCE), authState(INSTANCE));
  assert.notEqual(authState(INSTANCE), authState('ffffffffffffffffffffffffffffffff'));
});

test('the user can paste the whole redirected address, a query fragment or the bare code', () => {
  assert.deepEqual(parseAuthorizationInput(`${REDIRECT}?code=ABC123&state=xyz`), {
    code: 'ABC123',
    state: 'xyz',
  });
  assert.deepEqual(parseAuthorizationInput('?code=ABC123&state=xyz'), {
    code: 'ABC123',
    state: 'xyz',
  });
  assert.deepEqual(parseAuthorizationInput('  ABC123  '), { code: 'ABC123', state: null });
});

test('an address without a code is rejected instead of sending garbage to Xiaomi', () => {
  assert.throws(
    () => parseAuthorizationInput('http://homeassistant.local:8123/api/webhook/x'),
    /code/,
  );
  assert.throws(() => parseAuthorizationInput('   '), /empty/);
});

test('the token exchange posts the payload in the `data` query parameter', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    return new Response(
      JSON.stringify({
        code: 0,
        result: { access_token: 'access', refresh_token: 'refresh', expires_in: 1000 },
      }),
      { status: 200 },
    );
  };
  try {
    const auth = await exchangeCode({
      cloudServer: 'de',
      instanceId: INSTANCE,
      redirectUrl: REDIRECT,
      code: 'CODE',
    });
    assert.equal(auth.access_token, 'access');
    assert.equal(auth.refresh_token, 'refresh');
    // 70 % of the announced lifetime: the renewal happens well before expiry.
    const lifetime = auth.expires_ts - Math.floor(Date.now() / 1000);
    assert.ok(lifetime > 600 && lifetime <= 700, `unexpected lifetime ${lifetime}`);

    const [url] = calls;
    assert.equal(url.host, 'de.ha.api.io.mi.com');
    assert.equal(url.pathname, '/app/v2/ha/oauth/get_token');
    const raw = url.searchParams.get('data');
    // The client id is beyond Number.MAX_SAFE_INTEGER: it must reach Xiaomi
    // digit for digit, not rounded by a JavaScript number.
    assert.ok(raw.includes(`"client_id":${OAUTH2_CLIENT_ID}`), `client id mangled in ${raw}`);
    assert.deepEqual(JSON.parse(raw), {
      client_id: Number(OAUTH2_CLIENT_ID),
      redirect_uri: REDIRECT,
      code: 'CODE',
      device_id: `ha.${INSTANCE}`,
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('the refresh call sends the refresh token and no device id', async () => {
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    captured = new URL(url).searchParams.get('data');
    return new Response(
      JSON.stringify({
        code: 0,
        result: { access_token: 'a2', refresh_token: 'r2', expires_in: 100 },
      }),
      { status: 200 },
    );
  };
  try {
    await refreshToken({ cloudServer: 'cn', redirectUrl: REDIRECT, refreshToken: 'old-refresh' });
    assert.equal(
      captured,
      `{"client_id":${OAUTH2_CLIENT_ID},"redirect_uri":"${REDIRECT}","refresh_token":"old-refresh"}`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('an error envelope from Xiaomi is surfaced, not silently accepted', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: -10020, message: 'bad code' }), { status: 200 });
  try {
    await assert.rejects(
      exchangeCode({ cloudServer: 'cn', instanceId: INSTANCE, redirectUrl: REDIRECT, code: 'x' }),
      /-10020/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('secondsBeforeRefresh counts down to the stored deadline', () => {
  const now = 1_700_000_000_000;
  assert.equal(secondsBeforeRefresh({ expires_ts: 1_700_000_300 }, now), 300);
  assert.ok(secondsBeforeRefresh({ expires_ts: 1_699_999_000 }, now) < 0);
});
