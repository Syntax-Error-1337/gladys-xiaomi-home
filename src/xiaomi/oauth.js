// -----------------------------------------------------------------------------
// Xiaomi account OAuth 2.0 client.
//
// Flow, as implemented by the official Xiaomi Home integration:
//   1. the user opens `buildAuthorizeUrl()` in a browser and signs in;
//   2. Xiaomi redirects to the registered redirect URI (an address that does
//      NOT resolve outside Home Assistant) with `?code=...&state=...`;
//   3. `exchangeCode()` turns that code into an access/refresh token pair;
//   4. `refreshToken()` renews it before `expires_ts`.
//
// The token endpoint is a GET whose whole payload rides in a single `data`
// query parameter (JSON encoded) — unusual, but that is the wire format.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { OAUTH2_AUTH_URL, OAUTH2_CLIENT_ID, TOKEN_EXPIRES_RATIO, apiHost } from './constants.js';
import { fetchJson } from './httpUtils.js';

/** Device id sent to Xiaomi: stable per installation. */
export function deviceId(instanceId) {
  return `ha.${instanceId}`;
}

/**
 * Anti-CSRF state, derived from the device id exactly like the reference
 * implementation does, so it can be recomputed instead of being persisted.
 */
export function authState(instanceId) {
  return createHash('sha1')
    .update(`d=${deviceId(instanceId)}`, 'utf8')
    .digest('hex');
}

/**
 * Authorization URL of the Xiaomi account.
 * @param {object} params
 * @param {string} params.instanceId stable id of this Gladys installation
 * @param {string} params.redirectUrl redirect URI registered at Xiaomi
 */
export function buildAuthorizeUrl({ instanceId, redirectUrl }) {
  const query = new URLSearchParams({
    redirect_uri: redirectUrl,
    client_id: OAUTH2_CLIENT_ID,
    response_type: 'code',
    device_id: deviceId(instanceId),
    state: authState(instanceId),
    // Python's urlencode renders the boolean capitalized; Xiaomi expects it.
    // Always false: the consent screen is never actually skippable (see
    // confirmAuthorization in qrLogin.js), so there is nothing to toggle.
    skip_confirm: 'False',
  });
  return `${OAUTH2_AUTH_URL}?${query.toString()}`;
}

/**
 * Extract the authorization code from what the user pasted back: either the
 * bare code, or the whole address the browser was redirected to.
 * @returns {{ code: string, state: string | null }}
 */
export function parseAuthorizationInput(input) {
  const trimmed = String(input ?? '').trim();
  if (trimmed === '') {
    throw new Error('empty authorization code');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    if (!code) {
      throw new Error('this address carries no `code` parameter');
    }
    return { code, state: url.searchParams.get('state') };
  }
  // A bare `code=...&state=...` fragment is accepted too.
  if (trimmed.includes('code=')) {
    const params = new URLSearchParams(trimmed.replace(/^[?#]/, ''));
    const code = params.get('code');
    if (code) {
      return { code, state: params.get('state') };
    }
  }
  return { code: trimmed, state: null };
}

/**
 * Serialize the token payload. `client_id` MUST travel as a JSON number, and
 * 2882303761520251711 is beyond Number.MAX_SAFE_INTEGER: going through a JS
 * number would send 2882303761520252000 and Xiaomi would reject the call. The
 * digits are therefore injected verbatim into the serialized payload.
 */
export function serializeTokenPayload(payload) {
  const placeholder = '__XIAOMI_CLIENT_ID__';
  return JSON.stringify({ client_id: placeholder, ...payload }).replace(
    `"${placeholder}"`,
    OAUTH2_CLIENT_ID,
  );
}

async function callTokenEndpoint(cloudServer, payload) {
  const url = new URL(`https://${apiHost(cloudServer)}/app/v2/ha/oauth/get_token`);
  url.searchParams.set('data', serializeTokenPayload(payload));
  const body = await fetchJson(url, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (body.code !== 0 || !body.result) {
    throw new Error(`Xiaomi OAuth error ${body.code}: ${body.message ?? 'unknown'}`);
  }
  const {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
  } = body.result;
  if (!accessToken || !refreshToken || typeof expiresIn !== 'number') {
    throw new Error('Xiaomi OAuth error: incomplete token response');
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    // Deliberate 30 % safety margin, like the reference implementation.
    expires_ts: Math.floor(Date.now() / 1000 + expiresIn * TOKEN_EXPIRES_RATIO),
  };
}

/** Exchange the authorization code for a token pair. */
export function exchangeCode({ cloudServer, instanceId, redirectUrl, code }) {
  return callTokenEndpoint(cloudServer, {
    redirect_uri: redirectUrl,
    code,
    device_id: deviceId(instanceId),
  });
}

/** Renew a token pair. Xiaomi returns a NEW refresh token: store it. */
export function refreshToken({ cloudServer, redirectUrl, refreshToken: token }) {
  return callTokenEndpoint(cloudServer, {
    redirect_uri: redirectUrl,
    refresh_token: token,
  });
}

/** Seconds left before the token must be renewed (may be negative). */
export function secondsBeforeRefresh(auth, now = Date.now()) {
  return Math.floor((auth?.expires_ts ?? 0) - now / 1000);
}
