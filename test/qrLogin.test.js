// -----------------------------------------------------------------------------
// QR sign-in: the flow that keeps the browser (and homeassistant.local) out of
// the account linking. Xiaomi is replaced by a scripted endpoint set that
// reproduces the chain observed with a real account:
//
//   long-poll (approved) -> sts hop -> /oauth2/authorize (session established)
//     -> 302 fe/service/oauth2/authorize?...&confirmed=null   <- consent page
//     -> re-request with confirmed=true                       <- the "Confirm" click
//     -> 302 <redirect_uri>?code=...                          <- never fetched
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authState } from '../src/xiaomi/oauth.js';
import { startQrLogin, waitForAuthorizationCode } from '../src/xiaomi/qrLogin.js';

const INSTANCE = '0123456789abcdef0123456789abcdef';
const REDIRECT = `http://homeassistant.local:8123/api/webhook/${INSTANCE}`;

/**
 * @param {object} options
 * @param {boolean} options.approved the long-poll reports a scan
 * @param {boolean} options.chainCarriesCode the approval hands the code over
 *   without any consent screen (the sts hop chains straight into a confirmed
 *   authorize call)
 */
function installFakeXiaomi({ approved = true, chainCarriesCode = false } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  const jarSeen = [];
  let sessionEstablished = false;

  const answer = (status, headers = {}, body = '') =>
    new Response(body, { status, headers: { ...headers } });

  /** The consent page URL Xiaomi redirects to, once the session exists. */
  const consentPage = (params, extra = {}) => {
    const url = new URL('https://account.xiaomi.com/fe/service/oauth2/authorize');
    for (const [key, value] of Object.entries({ ...params, ...extra })) {
      url.searchParams.set(key, value);
    }
    return url;
  };

  const codeRedirectUrl = (params) => {
    const target = new URL(params.redirect_uri);
    target.searchParams.set('code', 'QR-CODE-42');
    target.searchParams.set('state', params.state ?? '');
    return target.href;
  };

  const codeRedirect = (params) => answer(302, { location: codeRedirectUrl(params) });

  let lastConfirmBody = null;
  let pendingState = '';
  const headersSeen = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push(url);
    jarSeen.push(init.headers?.Cookie ?? '');
    headersSeen.push(init.headers ?? {});

    // 1. The authorize API: login redirect, consent redirect, or the code.
    if (url.pathname === '/oauth2/authorize') {
      const params = Object.fromEntries(url.searchParams);
      if (!sessionEstablished) {
        return answer(302, {
          location:
            'https://account.xiaomi.com/fe/service/login?sid=oauth2.0&qs=%3Fcallback%3Dhttps%253A%252F%252Fx' +
            '&callback=https%3A%2F%2Faccount.xiaomi.com%2Fsts%2Foauth%3Fsign%3Dabc&_sign=2%26V1_oauth2.0%26sig',
          'set-cookie': 'pass_ua=web; Path=/',
        });
      }
      // The confirmation info fetch: the consent page's own "Confirm" button
      // re-requests this same endpoint in its JSON form.
      if (url.searchParams.get('_json') === 'true') {
        if (params.confirmed === 'true') {
          return answer(
            200,
            {},
            JSON.stringify({ code: 302, data: { redirectUrl: codeRedirectUrl(params) } }),
          );
        }
        return answer(
          200,
          {},
          JSON.stringify({
            code: 0,
            data: {
              pt: 0,
              device_id: params.device_id,
              followup: `https://account.xiaomi.com/sts/oauth?sign=confirm&_json=true`,
              scope_id: 'scope-1',
              redirect_uri: params.redirect_uri,
              client_id: params.client_id,
              _ssign: 'SIGNED-CONTINUATION',
            },
          }),
        );
      }
      if (params.confirmed === 'true') {
        return codeRedirect(params);
      }
      // Session known, confirmation pending: to the consent page.
      return answer(302, {
        location: consentPage(params, {
          userId: '6838578055',
          nonce: 'Ujq3QS5R8WUBxzJ+',
          confirmed: 'null',
          from_login: 'false',
          sign: 'sXetimiEUP0w/RN03RThhNNOJeM=',
        }).href,
      });
    }
    // The confirmation click itself.
    if (url.pathname === '/oauth2/userAuthorization') {
      const body = new URLSearchParams(await new Response(init.body).text());
      lastConfirmBody = Object.fromEntries(body);
      if (
        body.get('device_id') &&
        body.get('redirect_uri') &&
        body.get('client_id') &&
        body.get('_ssign') === 'SIGNED-CONTINUATION'
      ) {
        return answer(
          200,
          {},
          JSON.stringify({
            code: 0,
            data: {
              followup: `${codeRedirectUrl({ ...Object.fromEntries(body), state: pendingState })}&_json=true`,
            },
          }),
        );
      }
      return answer(200, {}, JSON.stringify({ code: -1, desc: 'unexpected confirmation body' }));
    }
    // The consent page itself: a client-side app, always answers 200 with no
    // Location — its "Confirm" button calls /oauth2/authorize?_json=true and
    // /oauth2/userAuthorization instead of navigating this URL.
    if (url.pathname === '/fe/service/oauth2/authorize') {
      return answer(200, {}, '<html>confirm?</html>');
    }
    // 2. The sign-in page itself.
    if (url.pathname === '/fe/service/login') {
      return answer(200, {}, '<html>login</html>');
    }
    // 3. The QR session.
    if (url.pathname === '/longPolling/loginUrl') {
      return answer(
        200,
        {},
        '&&&START&&&' +
          JSON.stringify({
            code: 0,
            qr: 'https://account.xiaomi.com/pass/qr/login?ticket=lp_1',
            loginUrl: 'https://sgp.account.xiaomi.com/longPolling/login?ticket=lp_1',
            lp: 'https://sgp.lp.account.xiaomi.com/lp/s?k=lp_1',
            timeout: 5,
          }),
      );
    }
    // 4. The long-poll.
    if (url.hostname === 'sgp.lp.account.xiaomi.com') {
      if (!approved) {
        return answer(400);
      }
      return answer(
        200,
        {},
        '&&&START&&&' +
          JSON.stringify({
            code: 0,
            userId: 42,
            passToken: 'PASS',
            ssecurity: 'SEC',
            location: 'https://account.xiaomi.com/sts/oauth?sign=abc',
          }),
      );
    }
    // 5. The sts hop: establishes the account session, then chains into the
    //    authorize call (with the confirmation already done in the
    //    chainCarriesCode mode, matching an approval that needs no consent).
    if (url.pathname === '/sts/oauth') {
      sessionEstablished = true;
      const authorize = new URL('https://account.xiaomi.com/oauth2/authorize');
      authorize.searchParams.set('redirect_uri', REDIRECT);
      authorize.searchParams.set('client_id', '2882303761520251711');
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('device_id', `ha.${INSTANCE}`);
      authorize.searchParams.set('state', authState(INSTANCE));
      authorize.searchParams.set('skip_confirm', 'False');
      if (chainCarriesCode) {
        authorize.searchParams.set('confirmed', 'true');
      }
      return answer(302, { 'set-cookie': 'serviceToken=ST; Path=/', location: authorize.href });
    }
    throw new Error(`unexpected call to ${url.href}`);
  };

  return {
    calls,
    jarSeen,
    headersSeen,
    confirmBody: () => lastConfirmBody,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('the Connect button hands out a QR image, never a redirect to Gladys', async () => {
  const fake = installFakeXiaomi();
  try {
    const { qrImageUrl, loginUrl, session } = await startQrLogin({
      instanceId: INSTANCE,
      redirectUrl: REDIRECT,
    });
    assert.match(qrImageUrl, /^https:\/\/account\.xiaomi\.com\/pass\/qr\/login\?ticket=/);
    assert.match(loginUrl, /longPolling\/login\?ticket=/);
    assert.equal(session.timeoutSeconds, 5);

    // The QR session must be opened inside the OAuth context of the sign-in
    // page, otherwise the approval yields no authorization code.
    const qrCall = fake.calls.find((url) => url.pathname === '/longPolling/loginUrl');
    assert.equal(qrCall.searchParams.get('sid'), 'oauth2.0');
    assert.equal(qrCall.searchParams.get('_sign'), '2&V1_oauth2.0&sig');
    assert.ok(qrCall.searchParams.get('callback').includes('/sts/oauth'));
  } finally {
    fake.restore();
  }
});

test('an approval that carries the code needs no confirmation', async () => {
  const fake = installFakeXiaomi({ chainCarriesCode: true });
  try {
    const { session } = await startQrLogin({ instanceId: INSTANCE, redirectUrl: REDIRECT });
    const code = await waitForAuthorizationCode(session);
    assert.equal(code, 'QR-CODE-42');

    assert.equal(
      fake.calls.filter((url) => url.hostname === 'homeassistant.local').length,
      0,
      'the redirect target must never be fetched',
    );
    assert.equal(
      fake.calls.filter((url) => url.pathname === '/fe/service/oauth2/authorize').length,
      0,
      'no consent page is involved',
    );
  } finally {
    fake.restore();
  }
});

test('the consent screen is confirmed the way the browser button does', async () => {
  const fake = installFakeXiaomi();
  try {
    const { session } = await startQrLogin({ instanceId: INSTANCE, redirectUrl: REDIRECT });
    const code = await waitForAuthorizationCode(session);
    assert.equal(code, 'QR-CODE-42');

    // The approval landed on the consent page…
    const consent = fake.calls.find((url) => url.pathname === '/fe/service/oauth2/authorize');
    assert.ok(consent, 'the chain reaches the consent page');
    assert.equal(consent.searchParams.get('confirmed'), 'null');
    assert.equal(consent.searchParams.get('userId'), '6838578055');
    assert.ok(consent.searchParams.get('sign'));

    // …the info fetch replays that page's own query in JSON form…
    const infoFetch = fake.calls.find(
      (url) => url.pathname === '/oauth2/authorize' && url.searchParams.get('_json') === 'true',
    );
    assert.ok(infoFetch, 'GET /oauth2/authorize?..._json=true is called');
    assert.equal(infoFetch.searchParams.get('nonce'), 'Ujq3QS5R8WUBxzJ+');

    // …and the confirmation POSTs exactly the seven signed fields, nothing more.
    assert.deepEqual(fake.confirmBody(), {
      pt: '0',
      device_id: `ha.${INSTANCE}`,
      followup: 'https://account.xiaomi.com/sts/oauth?sign=confirm&_json=true',
      scope_id: 'scope-1',
      redirect_uri: REDIRECT,
      client_id: '2882303761520251711',
      _ssign: 'SIGNED-CONTINUATION',
      _json: 'true',
    });

    // Both confirmation calls carry the page context a real browser would
    // send, which a signature check tied to the calling page can require.
    const confirmHeaders = fake.headersSeen.at(-1);
    assert.equal(confirmHeaders.Origin, 'https://account.xiaomi.com');
    assert.ok(confirmHeaders.Referer?.includes('/fe/service/oauth2/authorize'));

    // The unreachable Home Assistant address is never requested.
    assert.equal(
      fake.calls.filter((url) => url.hostname === 'homeassistant.local').length,
      0,
      'the redirect target must never be fetched',
    );
    // The session cookie set by the sts hop carries through the whole chain.
    assert.ok(
      fake.jarSeen.at(-1).includes('serviceToken=ST'),
      'the session cookies must be replayed on the confirmation',
    );
  } finally {
    fake.restore();
  }
});

test('an expired QR code fails with an explicit message instead of hanging', async () => {
  const fake = installFakeXiaomi({ approved: false });
  try {
    const { session } = await startQrLogin({ instanceId: INSTANCE, redirectUrl: REDIRECT });
    session.timeoutSeconds = 0.2;
    await assert.rejects(waitForAuthorizationCode(session), /expired/);
  } finally {
    fake.restore();
  }
});

test('a code answered for another installation is rejected', async () => {
  const fake = installFakeXiaomi();
  const scripted = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    // Corrupt the state the userAuthorization confirmation hands back.
    if (url.pathname === '/oauth2/userAuthorization') {
      const target = new URL(REDIRECT);
      target.searchParams.set('code', 'X');
      target.searchParams.set('state', 'someone-else');
      return new Response(
        JSON.stringify({ code: 0, data: { followup: `${target.href}&_json=true` } }),
        {
          status: 200,
        },
      );
    }
    return scripted(input, init);
  };
  try {
    const { session } = await startQrLogin({ instanceId: INSTANCE, redirectUrl: REDIRECT });
    await assert.rejects(waitForAuthorizationCode(session), /state mismatch/);
    assert.notEqual(authState(INSTANCE), 'someone-else');
  } finally {
    globalThis.fetch = scripted;
    fake.restore();
  }
});
