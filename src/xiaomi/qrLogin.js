// -----------------------------------------------------------------------------
// QR sign-in: linking a Xiaomi account WITHOUT any browser redirect.
//
// Why this exists: Xiaomi validates the OAuth `redirect_uri` against the one
// registered for the client id, and only accepts
// `http(s)://homeassistant.local:8123/<anything>` — every other host, port or
// scheme is answered with "invalid redirect uri". A Gladys URL can therefore
// never be the redirect target (verified against the live endpoint).
//
// So the browser is taken out of the loop entirely: the same authorization
// page also offers a QR sign-in (`longPolling/loginUrl`), which Gladys shows
// to the user. The user approves it from the Xiaomi Home app / their phone,
// this module long-polls Xiaomi until the approval arrives, then walks the
// redirect chain SERVER-SIDE and reads the authorization code out of the final
// `302` — the address nobody can reach is never opened by anyone.
//
//   authorize  ->  login page (OAuth context: sid, qs, callback, _sign)
//              ->  longPolling/loginUrl  ->  QR image + long-poll URL
//              ->  [user scans and approves]
//              ->  location hop (account session cookies)
//              ->  authorize again, with the session  ->  302 …?code=XXX
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { buildAuthorizeUrl, authState } from './oauth.js';

const logger = createLogger({ name: 'qr-login' });

/** The Mi Home app user agent: the account endpoints expect an app client. */
const USER_AGENT = 'APP/com.xiaomi.mihome APPV/10.5.201';

const QR_LOGIN_URL = 'https://account.xiaomi.com/longPolling/loginUrl';

/** Hops allowed when walking a redirect chain by hand. */
const MAX_REDIRECTS = 10;

/** One long-poll request; Xiaomi holds it open until the QR is scanned. */
const POLL_TIMEOUT = 35000;

/** Minimal cookie jar: `fetch` has none, and the account flow needs one. */
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const separator = pair.indexOf('=');
      if (separator > 0) {
        const value = pair.slice(separator + 1).trim();
        const name = pair.slice(0, separator).trim();
        if (value === '' || value === 'EXPIRED') {
          this.cookies.delete(name);
        } else {
          this.cookies.set(name, value);
        }
      }
    }
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

async function httpGet(url, jar, { timeout = 30000, headers = {} } = {}) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, Cookie: jar.header(), ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  jar.store(response);
  return response;
}

/** Same as httpGet, form-encoded POST — used by the consent confirmation. */
async function httpPost(url, jar, body, { timeout = 30000, headers = {} } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': USER_AGENT,
      Cookie: jar.header(),
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(timeout),
  });
  jar.store(response);
  return response;
}

/** Xiaomi prefixes its JSON answers with an anti-hijacking marker. */
export function parseXiaomiJson(text) {
  const raw = String(text);
  for (const prefix of ['&&&START&&&', '@json:']) {
    if (raw.startsWith(prefix)) {
      return JSON.parse(raw.slice(prefix.length));
    }
  }
  return JSON.parse(raw);
}

/**
 * Walk a redirect chain by hand.
 * @returns {Promise<{ hit: URL | null, url: string }>} `hit` is the first
 *   location whose host matches `stopHost` (never requested), `url` the last
 *   URL actually fetched.
 */
async function walkRedirects(startUrl, jar, stopHost) {
  let url = startUrl;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const target = new URL(url);
    if (target.host === stopHost) {
      logger.debug(
        `hop ${hop}: ${target.host} is the redirect target, stopping and reading the code`,
      );
      return { hit: target, url };
    }
    const response = await httpGet(url, jar);
    const location = response.headers.get('location');
    logger.debug(
      `hop ${hop}: ${target.host}${target.pathname} -> ${response.status}${
        location ? ` ${new URL(location, url).host}` : ' (no redirect)'
      }`,
    );
    if (!location) {
      return { hit: null, url };
    }
    url = new URL(location, url).href;
  }
  return { hit: null, url };
}

/**
 * Open the authorization page and turn it into a QR sign-in session.
 * @param {{ instanceId: string, redirectUrl: string }} options
 * @returns {Promise<{ qrImageUrl: string, loginUrl: string, session: object }>}
 */
export async function startQrLogin({ instanceId, redirectUrl }) {
  const jar = new CookieJar();
  const authorizeUrl = buildAuthorizeUrl({ instanceId, redirectUrl });

  // 1. Follow the authorization URL to the sign-in page: its query carries the
  //    OAuth context (sid, qs, callback, _sign) the QR session must reuse.
  let url = authorizeUrl;
  let loginPage = null;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const response = await httpGet(url, jar);
    const location = response.headers.get('location');
    if (!location) {
      loginPage = url;
      break;
    }
    url = new URL(location, url).href;
  }
  if (!loginPage) {
    throw new Error('Xiaomi did not return its sign-in page');
  }
  const context = new URL(loginPage).searchParams;
  if (!context.get('sid')) {
    throw new Error('Xiaomi answered an unexpected sign-in page (no OAuth context)');
  }

  // 2. Ask for a QR session inside that context.
  const qrUrl = new URL(QR_LOGIN_URL);
  for (const [key, value] of Object.entries({
    _qrsize: '240',
    qs: context.get('qs') ?? '',
    callback: context.get('callback') ?? '',
    _hasLogo: 'false',
    sid: context.get('sid'),
    serviceParam: context.get('serviceParam') ?? '',
    _locale: 'en_US',
    _json: 'true',
    _dc: String(Date.now()),
    _sign: context.get('_sign') ?? context.get('_ssign') ?? '',
  })) {
    qrUrl.searchParams.set(key, value);
  }
  const response = await httpGet(qrUrl.href, jar);
  const body = parseXiaomiJson(await response.text());
  if (!body?.qr || !body?.lp) {
    throw new Error(`Xiaomi refused to start a QR sign-in (code ${body?.code ?? '?'})`);
  }
  logger.info('QR sign-in session opened, waiting for the user to scan it');
  return {
    qrImageUrl: body.qr,
    loginUrl: body.loginUrl,
    session: {
      jar,
      lpUrl: body.lp,
      timeoutSeconds: Number(body.timeout) || 300,
      instanceId,
      redirectUrl,
    },
  };
}

/**
 * Read and validate the authorization code out of the redirect Gladys can
 * never receive (its host is unreachable by design — that is the whole point).
 */
function codeFromRedirect(target, instanceId) {
  const code = target.searchParams.get('code');
  if (!code) {
    throw new Error(
      `Xiaomi refused the authorization (${target.searchParams.get('error') ?? 'no code'})`,
    );
  }
  const state = target.searchParams.get('state');
  if (state && state !== authState(instanceId)) {
    throw new Error(
      'the authorization answer does not match this Gladys installation (state mismatch)',
    );
  }
  return code;
}

/**
 * Walk a redirect chain and stop AT the unreachable redirect address, reading
 * the code out of it. The chain is only followed further while it stays on
 * Xiaomi: the redirect host is matched before any request is made, so it is
 * never fetched.
 * @returns {Promise<{ code: string | null, landed: string }>} `code` is null
 *   when the chain ends on a page (the consent screen) instead of the redirect;
 *   `landed` is where it stopped — the input of the confirmation ladder.
 */
async function walkForCode(startUrl, session, what) {
  const { hit, url } = await walkRedirects(
    startUrl,
    session.jar,
    new URL(session.redirectUrl).host,
  );
  if (hit) {
    return { code: codeFromRedirect(hit, session.instanceId), landed: url };
  }
  // Visible at the default log level: this is the line that says where the
  // real-world chain stopped, when it ever stops somewhere unexpected.
  logger.warn(`${what}: the chain ended on ${url} without reaching the code redirect`);
  return { code: null, landed: url };
}

/**
 * Complete the OAuth consent screen server-side, reproducing exactly what the
 * account.xiaomi.com "Confirm" button does — the consent page
 * (`fe/service/oauth2/authorize?...&confirmed=null&nonce=…&sign=…`) is a pure
 * client-side app: no GET parameter on it ever turns its response into a
 * redirect, only its own JavaScript can complete the authorization. That
 * JavaScript (module `15553`/`73329` of the page bundle, downloaded and
 * disassembled for this integration) does exactly two calls:
 *
 *   1. GET  /oauth2/authorize?<the consent page's own query>&_json=true
 *      -> `{ code: 302, data: { redirectUrl } }` when nothing else is needed,
 *      -> `{ code: 0 | 96020, data: { pt, device_id, followup, scope_id,
 *                                     redirect_uri, client_id, _ssign, ... } }`
 *         for a normal, single-account sign-in still pending confirmation;
 *   2. POST /oauth2/userAuthorization (form-encoded), with EXACTLY the seven
 *      fields above from that `data` (plus `_json=true`)
 *      -> `{ code: 0, data: { followup } }`, `followup` (minus its own
 *         `&_json=true` suffix) being the final hop to the code redirect.
 *
 * @returns {Promise<string | null>} the code, or null when Xiaomi answers
 *   something other than the two shapes above (logged for diagnosis).
 */
async function confirmAuthorization(landedUrl, session) {
  if (!landedUrl) {
    return null;
  }
  const landed = new URL(landedUrl);
  // A real browser running the consent page's own JavaScript sends these on
  // every same-origin call it makes; a signature check tied to the page
  // context (a common anti-CSRF pattern on this domain) would see a bare
  // server-to-server request as suspicious without them.
  const browserHeaders = { Referer: landed.href, Origin: 'https://account.xiaomi.com' };

  const infoUrl = new URL('https://account.xiaomi.com/oauth2/authorize');
  for (const [key, value] of landed.searchParams) {
    infoUrl.searchParams.set(key, value);
  }
  infoUrl.searchParams.set('_json', 'true');

  let info;
  try {
    info = parseXiaomiJson(
      await (await httpGet(infoUrl.href, session.jar, { headers: browserHeaders })).text(),
    );
  } catch (err) {
    logger.warn(`the confirmation: /oauth2/authorize did not answer JSON (${err.message})`);
    return null;
  }

  if (info.code === 302 && info.data?.redirectUrl) {
    const result = await walkForCode(info.data.redirectUrl, session, 'the confirmation redirect');
    return result.code;
  }
  // 0 and 96020 both mean "here is the confirmation data" for a normal,
  // single-account sign-in (the page's own component renders its consent
  // form on either); 70016 is a different, multi-account scenario this
  // integration does not exercise (it would redirect to `oauthLoginUrl`
  // instead of carrying `data`).
  if ((info.code !== 0 && info.code !== 96020) || !info.data) {
    logger.warn(
      `the confirmation: /oauth2/authorize answered code ${info.code}` +
        `${info.desc || info.description ? ` (${info.desc ?? info.description})` : ''}, expected 0, 302 or 96020`,
    );
    return null;
  }
  // The page itself does not trust the response's own `client_id` on this
  // path: it overwrites it with the value it originally requested with.
  info.data.client_id = landed.searchParams.get('client_id') ?? info.data.client_id;

  const confirmParams = new URLSearchParams();
  for (const key of [
    'pt',
    'device_id',
    'followup',
    'scope_id',
    'redirect_uri',
    'client_id',
    '_ssign',
  ]) {
    if (info.data[key] !== undefined) {
      confirmParams.set(key, info.data[key]);
    }
  }
  confirmParams.set('_json', 'true');
  logger.debug(`the confirmation: posting ${confirmParams.toString()}`);

  let confirmed;
  try {
    confirmed = parseXiaomiJson(
      await (
        await httpPost(
          'https://account.xiaomi.com/oauth2/userAuthorization',
          session.jar,
          confirmParams.toString(),
          { headers: browserHeaders },
        )
      ).text(),
    );
  } catch (err) {
    logger.warn(`the confirmation: /oauth2/userAuthorization did not answer JSON (${err.message})`);
    return null;
  }
  if (confirmed.code !== 0 || !confirmed.data?.followup) {
    logger.warn(
      `the confirmation: /oauth2/userAuthorization answered code ${confirmed.code}` +
        `${confirmed.desc || confirmed.description ? ` (${confirmed.desc ?? confirmed.description})` : ''}`,
    );
    return null;
  }

  const followup = confirmed.data.followup.replace('&_json=true', '');
  const result = await walkForCode(followup, session, 'the confirmed followup');
  return result.code;
}

/**
 * Wait for the user to approve the QR sign-in, then mint the OAuth code.
 *
 * After the approval, Xiaomi answers the long-poll with a `location` whose
 * redirect chain carries the signed authorization continuation: following it
 * (with the session cookies) ends on `302 <redirectUrl>?code=…`. The code is
 * read out of that hop WITHOUT requesting it — nobody can, that address does
 * not exist here.
 *
 * When the chain stops on the consent screen instead (the shape observed with
 * a real account: `fe/service/oauth2/authorize?...&confirmed=null`), the
 * confirmation is completed server-side — see confirmAuthorization.
 *
 * @param {object} session the `session` returned by startQrLogin
 * @returns {Promise<string>} the authorization code
 */
export async function waitForAuthorizationCode(session) {
  const { lpUrl, timeoutSeconds } = session;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastAnswer = 'no answer';
  const reported = new Set();
  while (Date.now() < deadline) {
    let response;
    try {
      response = await httpGet(lpUrl, session.jar, { timeout: POLL_TIMEOUT });
    } catch {
      // The long-poll simply expired: ask again until the QR itself expires.
      continue;
    }
    if (response.status !== 200) {
      lastAnswer = `HTTP ${response.status}`;
      continue;
    }
    let body;
    try {
      body = parseXiaomiJson(await response.text());
    } catch {
      lastAnswer = 'non-JSON answer';
      continue;
    }
    if (body?.code !== 0 || !body?.location) {
      // Keep the reason: it is what the logs need if a login ever fails.
      lastAnswer = `code ${body?.code ?? '?'}${body?.description ? ` (${body.description})` : ''}`;
      // Once per distinct answer, at the default log level: a repeating
      // "waiting" answer stays quiet, anything else (expired, cancelled,
      // unexpected shape) is visible in docker logs without LOG_LEVEL=debug.
      if (!reported.has(lastAnswer)) {
        reported.add(lastAnswer);
        logger.warn(`long-poll answered but is not an approval: ${lastAnswer}`);
      } else {
        logger.debug(`long-poll not usable yet: ${lastAnswer}`);
      }
      continue;
    }
    logger.info('QR sign-in approved, collecting the authorization code');

    // 1. The approval sometimes carries the code directly: walk the signed
    //    continuation and stop at the unreachable redirect.
    const fromApproval = await walkForCode(body.location, session, 'the approval continuation');
    if (fromApproval.code) {
      logger.info('authorization code collected from the sign-in continuation');
      return fromApproval.code;
    }

    // 2. The chain stopped on the consent screen: the account session is
    //    established (the hops set the cookies), the authorization only waits
    //    for the "Confirm" click a browser would make. Click it server-side.
    const confirmed = await confirmAuthorization(fromApproval.landed, session);
    if (confirmed) {
      return confirmed;
    }
    throw new Error(
      `Xiaomi did not return an authorization code after the approval: the consent screen ` +
        `at ${fromApproval.landed} could not be completed automatically`,
    );
  }
  throw new Error(`the QR sign-in did not complete before it expired (${lastAnswer})`);
}
