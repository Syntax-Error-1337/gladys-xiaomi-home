// -----------------------------------------------------------------------------
// Tiny fetch wrapper: timeout + JSON parsing + typed errors.
// Node >= 20 ships `fetch` and `AbortSignal.timeout`, so there is no HTTP
// dependency in this integration.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT } from './constants.js';

/** Error carrying the HTTP status, so callers can react to a 401. */
export class XiaomiHttpError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'XiaomiHttpError';
    this.status = status;
    this.code = code;
  }
}

/** True when the error means "the access token is not valid anymore". */
export function isAuthError(err) {
  return err instanceof XiaomiHttpError && err.status === 401;
}

/** Delays, in ms, between attempts after a pure network-transport failure
 * (DNS, connection refused/reset, TLS) — never after an HTTP response, even
 * an error one. Xiaomi never saw the request in that case, so retrying a
 * transient blip is safe and turns it invisible instead of failing a whole
 * login or command. */
const NETWORK_RETRY_DELAYS_MS = [300, 900];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET/POST a URL and parse the JSON body.
 * @param {string | URL} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: string, timeout?: number }} options
 */
export async function fetchJson(
  url,
  { method = 'GET', headers = {}, body, timeout = HTTP_TIMEOUT } = {},
) {
  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
      break;
    } catch (err) {
      if (attempt >= NETWORK_RETRY_DELAYS_MS.length) {
        const cause = err.cause?.code ?? err.cause?.message;
        throw new XiaomiHttpError(
          `network error calling ${new URL(url).pathname}: ${err.message}` +
            (cause ? ` (${cause})` : ''),
        );
      }
      await sleep(NETWORK_RETRY_DELAYS_MS[attempt]);
    }
  }
  if (response.status === 401) {
    throw new XiaomiHttpError('unauthorized (401): the Xiaomi access token is not valid anymore', {
      status: 401,
    });
  }
  if (!response.ok) {
    throw new XiaomiHttpError(
      `invalid HTTP status ${response.status} calling ${new URL(url).pathname}`,
      {
        status: response.status,
      },
    );
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new XiaomiHttpError(`invalid JSON answer from ${new URL(url).pathname}`, {
      status: response.status,
    });
  }
}

/** Split an array into chunks of at most `size` items. */
export function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
