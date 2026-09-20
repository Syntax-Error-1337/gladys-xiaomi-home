// -----------------------------------------------------------------------------
// Integration configuration.
//
// Two kinds of keys live in the Gladys configuration store:
//   - the ones declared in the manifest `config_schema`, filled in by the user
//     (region, polling interval, exposure options);
//   - internal keys written by the integration itself (`xiaomi_*`): the OAuth
//     tokens and the installation id. They are NOT in the schema, so they never
//     show up in the UI, and they are what makes the login survive a restart.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { CLOUD_SERVERS } from './xiaomi/constants.js';

// The Gladys device model stores `poll_frequency` as a DB enum
// (server/models/device.js), not an arbitrary integer: only these millisecond
// values are accepted (server/utils/constants.js DEVICE_POLL_FREQUENCIES). Any
// other value is rejected by `publishDiscoveredDevices` with "invalid poll
// frequency" — the manifest select below only ever offers these.
export const POLL_FREQUENCIES_SECONDS = [1, 2, 10, 15, 30, 60];

export const DEFAULT_CONFIG = {
  cloud_server: 'cn',
  poll_frequency: 60, // seconds; converted to ms and restricted, see above
  expose_actions: true,
  expose_unmapped: false,
};

/** Keys holding the OAuth session, stored outside the manifest schema. */
export const AUTH_KEYS = {
  accessToken: 'xiaomi_access_token',
  refreshToken: 'xiaomi_refresh_token',
  expiresTs: 'xiaomi_expires_ts',
  instanceId: 'xiaomi_instance_id',
};

/** Merge the user configuration with the defaults and force the types. */
export function normalizeConfig(raw = {}) {
  const cloudServer = String(raw.cloud_server ?? DEFAULT_CONFIG.cloud_server);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    cloud_server: cloudServer in CLOUD_SERVERS ? cloudServer : DEFAULT_CONFIG.cloud_server,
    poll_frequency: POLL_FREQUENCIES_SECONDS.includes(Number(raw.poll_frequency))
      ? Number(raw.poll_frequency)
      : DEFAULT_CONFIG.poll_frequency,
    expose_actions: raw.expose_actions !== false,
    expose_unmapped: raw.expose_unmapped === true,
  };
}

/** The OAuth session held in the configuration, or `null` when not linked. */
export function readAuth(config = {}) {
  const accessToken = config[AUTH_KEYS.accessToken];
  const refreshToken = config[AUTH_KEYS.refreshToken];
  if (!accessToken || !refreshToken) {
    return null;
  }
  return {
    access_token: String(accessToken),
    refresh_token: String(refreshToken),
    expires_ts: Number(config[AUTH_KEYS.expiresTs] ?? 0),
  };
}

/** Configuration patch persisting an OAuth session. */
export function authPatch(auth) {
  return {
    [AUTH_KEYS.accessToken]: auth.access_token,
    [AUTH_KEYS.refreshToken]: auth.refresh_token,
    [AUTH_KEYS.expiresTs]: auth.expires_ts,
  };
}

/**
 * Stable id of this installation. It is part of the OAuth `device_id`, of the
 * anti-CSRF state and of the MQTT client id, so it must never change once the
 * account is linked.
 */
export function readInstanceId(config = {}) {
  const stored = config[AUTH_KEYS.instanceId];
  return typeof stored === 'string' && stored.length === 32 ? stored : null;
}

/** Generate the installation id (32 hexadecimal characters). */
export function generateInstanceId() {
  return randomBytes(16).toString('hex');
}
