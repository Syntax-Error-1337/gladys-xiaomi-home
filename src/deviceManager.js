// -----------------------------------------------------------------------------
// The integration itself: it owns the Xiaomi session, the device catalog and
// the two directions of the traffic.
//
//   Xiaomi -> Gladys : MQTT push (instant) + polling (safety net)
//   Gladys -> Xiaomi : prop/set and action over HTTPS
//
// `index.js` holds no logic: it wires the SDK callbacks to this class.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { MiHomeApi } from './xiaomi/api.js';
import { MiotMqttClient } from './xiaomi/mqtt.js';
import { SpecStore } from './xiaomi/spec.js';
import { OAUTH_REDIRECT_URL } from './xiaomi/constants.js';
import {
  exchangeCode,
  refreshToken as refreshOauthToken,
  secondsBeforeRefresh,
} from './xiaomi/oauth.js';
import { startQrLogin, waitForAuthorizationCode } from './xiaomi/qrLogin.js';
import { isAuthError } from './xiaomi/httpUtils.js';
import { buildFeatures } from './mapping/features.js';
import { authPatch, normalizeConfig, readAuth, readInstanceId } from './config.js';

const logger = createLogger({ name: 'xiaomi' });

/** External id namespace of a Xiaomi device. */
const DEVICE_TYPE = 'miot';

/** Max states per `publishStates` call (host API limit). */
const STATES_BATCH = 100;

/** Parallel spec downloads: the registry is public but not a CDN. */
const SPEC_CONCURRENCY = 5;

/** Refresh the OAuth token this many seconds before it expires. */
const REFRESH_MARGIN = 60;

export class XiaomiHomeManager {
  /**
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
   * @param {{ specStore?: SpecStore, createApi?: Function, createMqtt?: Function }} [deps]
   *   injected in the tests; the defaults are the real clients.
   */
  constructor(gladys, deps = {}) {
    this.gladys = gladys;
    this.specStore = deps.specStore ?? new SpecStore();
    this.createApi = deps.createApi ?? ((options) => new MiHomeApi(options));
    this.createMqtt = deps.createMqtt ?? ((options) => new MiotMqttClient(options));
    this.startQrLogin = deps.startQrLogin ?? startQrLogin;
    this.waitForAuthorizationCode = deps.waitForAuthorizationCode ?? waitForAuthorizationCode;
    this.config = normalizeConfig();
    this.auth = null;
    this.instanceId = null;
    this.api = null;
    this.mqtt = null;
    /** @type {Map<string, object>} did -> catalog entry */
    this.entries = new Map();
    /** @type {Map<string, object>} device external_id -> catalog entry */
    this.byDeviceId = new Map();
    /** @type {Map<string, object>} feature external_id -> { entry, feature } */
    this.byFeatureId = new Map();
    /** @type {Map<string, Array<object>>} `did:siid:piid` -> [{ entry, feature }] */
    this.byProp = new Map();
    /** @type {Map<string, Array<object>>} `did:siid:eiid` -> [{ entry, feature, value }] */
    this.byEvent = new Map();
    this.refreshTimer = null;
  }

  get linked() {
    return this.auth !== null;
  }

  // --- Session ---------------------------------------------------------------

  /** Load the configuration (user values + stored session). */
  applyConfig(rawConfig) {
    const previousRegion = this.config.cloud_server;
    this.config = normalizeConfig(rawConfig);
    this.auth = readAuth(rawConfig);
    this.instanceId = readInstanceId(rawConfig);
    if (this.auth && (this.api === null || previousRegion !== this.config.cloud_server)) {
      this.buildClients();
    } else if (this.auth) {
      this.api?.setAccessToken(this.auth.access_token);
      this.mqtt?.updateAccessToken(this.auth.access_token);
    }
    return this.config;
  }

  buildClients() {
    this.stopClients();
    this.api = this.createApi({
      cloudServer: this.config.cloud_server,
      accessToken: this.auth.access_token,
    });
    this.mqtt = this.createMqtt({
      cloudServer: this.config.cloud_server,
      instanceId: this.instanceId,
      accessToken: this.auth.access_token,
      onMessage: (message) => this.handlePush(message),
    });
  }

  /** Store a fresh OAuth session and rebuild the clients around it. */
  async useAuth(auth) {
    this.auth = auth;
    await this.gladys.setConfig(authPatch(auth));
    if (this.api) {
      this.api.setAccessToken(auth.access_token);
      this.mqtt?.updateAccessToken(auth.access_token);
    } else {
      this.buildClients();
    }
    this.scheduleRefresh();
  }

  /**
   * Start a QR sign-in: returns the QR image URL Gladys opens for the user,
   * plus the promise that settles once they approved it on their phone and
   * the account is linked. Nothing ever redirects a browser anywhere.
   * @returns {Promise<{ qrImageUrl: string, completion: Promise<number> }>}
   */
  async beginQrLogin() {
    if (!this.instanceId) {
      throw new Error('the installation id is missing');
    }
    const redirectUrl = redirectUrlFor(this.instanceId);
    const { qrImageUrl, session } = await this.startQrLogin({
      instanceId: this.instanceId,
      redirectUrl,
    });
    const completion = (async () => {
      const code = await this.waitForAuthorizationCode(session);
      const auth = await exchangeCode({
        cloudServer: this.config.cloud_server,
        instanceId: this.instanceId,
        redirectUrl,
        code,
      });
      await this.useAuth(auth);
      return this.loadDevices();
    })();
    return { qrImageUrl, completion };
  }

  /** Renew the token when it is about to expire; returns true when renewed. */
  async refreshIfNeeded(force = false) {
    if (!this.auth || !this.instanceId) {
      return false;
    }
    if (!force && secondsBeforeRefresh(this.auth) > REFRESH_MARGIN) {
      return false;
    }
    logger.info('refreshing the Xiaomi access token');
    const auth = await refreshOauthToken({
      cloudServer: this.config.cloud_server,
      redirectUrl: redirectUrlFor(this.instanceId),
      refreshToken: this.auth.refresh_token,
    });
    await this.useAuth(auth);
    return true;
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (!this.auth) {
      return;
    }
    const delay = Math.max(30, secondsBeforeRefresh(this.auth) - REFRESH_MARGIN);
    this.refreshTimer = setTimeout(() => {
      this.refreshIfNeeded(true).catch((err) => {
        logger.error(`token refresh failed: ${err.message}`);
        this.gladys
          .setConnectionStatus(false, {
            en: 'The Xiaomi session expired, please connect your account again.',
            fr: 'La session Xiaomi a expiré, reconnectez votre compte Xiaomi.',
          })
          .catch(() => {});
      });
    }, delay * 1000);
    this.refreshTimer.unref?.();
  }

  // --- Catalog ----------------------------------------------------------------

  /**
   * Fetch the account devices, their specs, and rebuild the whole catalog.
   * @returns {Promise<number>} number of devices known after the refresh
   */
  async loadDevices() {
    if (!this.api) {
      throw new Error('the Xiaomi account is not linked yet');
    }
    await this.refreshIfNeeded();
    const cloudDevices = await this.withAuthRetry(() => this.api.getDevices());
    const entries = new Map();
    for (const batch of splitEvery(cloudDevices, SPEC_CONCURRENCY)) {
      const built = await Promise.all(batch.map((device) => this.buildEntry(device)));
      for (const entry of built) {
        if (entry) {
          entries.set(entry.device.did, entry);
        }
      }
    }
    this.entries = entries;
    this.reindex();
    this.mqtt?.setDevices([...entries.keys()]);
    logger.info(`catalog: ${entries.size} devices, ${this.byFeatureId.size} features`);
    return entries.size;
  }

  async buildEntry(device) {
    let spec;
    try {
      spec = await this.specStore.get(device.urn);
    } catch (err) {
      logger.warn(`skipping ${device.name} (${device.model}): spec unavailable — ${err.message}`);
      return null;
    }
    const features = buildFeatures(spec, {
      exposeUnmapped: this.config.expose_unmapped,
      exposeActions: this.config.expose_actions,
    });
    if (features.length === 0) {
      logger.debug(`skipping ${device.name} (${device.model}): no usable feature`);
      return null;
    }
    const ids = this.gladys.externalIds(DEVICE_TYPE, device.did);
    return { device, spec, features, ids };
  }

  reindex() {
    this.byDeviceId = new Map();
    this.byFeatureId = new Map();
    this.byProp = new Map();
    this.byEvent = new Map();
    for (const entry of this.entries.values()) {
      this.byDeviceId.set(entry.ids.device, entry);
      for (const feature of entry.features) {
        const externalId = entry.ids.feature(feature.key);
        this.byFeatureId.set(externalId, { entry, feature, externalId });
        if (feature.prop) {
          pushTo(this.byProp, `${entry.device.did}:${feature.prop.siid}:${feature.prop.piid}`, {
            entry,
            feature,
            externalId,
          });
        }
        for (const [eiid, value] of feature.events ?? []) {
          pushTo(
            this.byEvent,
            `${entry.device.did}:${feature.prop?.siid ?? eventSiid(feature)}:${eiid}`,
            {
              entry,
              feature,
              externalId,
              value,
            },
          );
        }
      }
    }
  }

  /** The discovery payload: one Gladys device per Xiaomi device. */
  buildDiscoveredDevices() {
    return [...this.entries.values()].map((entry) => ({
      name: entry.device.name,
      external_id: entry.ids.device,
      // Polling is the safety net behind the MQTT push channel.
      poll_frequency: this.config.poll_frequency * 1000,
      params: [
        { name: 'model', value: entry.device.model },
        { name: 'did', value: entry.device.did },
        { name: 'room', value: entry.device.room ?? '' },
        { name: 'firmware', value: entry.device.firmware ?? '' },
      ],
      features: entry.features.map((feature) => ({
        name: feature.name,
        external_id: entry.ids.feature(feature.key),
        category: feature.category,
        type: feature.type,
        ...(feature.unit ? { unit: feature.unit } : {}),
        min: feature.min,
        max: feature.max,
        ...(feature.step ? { step: feature.step } : {}),
        read_only: feature.read_only,
        has_feedback: feature.has_feedback,
        keep_history: feature.keep_history,
        ...(feature.supported_options ? { supported_options: feature.supported_options } : {}),
      })),
    }));
  }

  /** Transport badge: cloud, or unreachable when Xiaomi reports it offline. */
  buildTransportEntries() {
    return [...this.entries.values()].map((entry) => ({
      external_id: entry.ids.device,
      transport: entry.device.online ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.UNREACHABLE,
    }));
  }

  // --- Gladys -> Xiaomi ----------------------------------------------------------

  /**
   * Run a user command on one feature.
   * @param {object} device Gladys device
   * @param {object} deviceFeature Gladys feature
   * @param {number|string} value
   */
  async setValue(device, deviceFeature, value) {
    if (!this.api) {
      throw new Error('the Xiaomi account is not linked yet');
    }
    const target = this.byFeatureId.get(deviceFeature.external_id);
    if (!target) {
      throw new Error(`unknown feature ${deviceFeature.external_id}`);
    }
    const { entry, feature } = target;
    const did = entry.device.did;
    await this.refreshIfNeeded();
    if (feature.action) {
      logger.info(`action ${feature.name} on ${entry.device.name}`);
      await this.withAuthRetry(() =>
        this.api.action({ did, siid: feature.action.siid, aiid: feature.action.aiid, args: [] }),
      );
      return;
    }
    const miotValue = feature.toMiot(value);
    logger.info(
      `set ${feature.name} of ${entry.device.name} (${feature.prop.siid}.${feature.prop.piid}) = ${miotValue}`,
    );
    await this.withAuthRetry(() =>
      this.api.setProps([
        { did, siid: feature.prop.siid, piid: feature.prop.piid, value: miotValue },
      ]),
    );
    // The device confirms asynchronously over MQTT; publish the accepted value
    // right away so the UI does not wait for the next push.
    if (feature.has_feedback) {
      await this.publishFeature(target, miotValue);
    }
  }

  /** Read every readable property of one device and publish its states. */
  async poll(device) {
    const entry = this.byDeviceId.get(device.external_id);
    if (!entry) {
      logger.debug(`poll ignored: ${device.external_id} is not in the catalog`);
      return;
    }
    if (!this.api) {
      throw new Error('the Xiaomi account is not linked yet');
    }
    await this.refreshIfNeeded();
    const readable = entry.features.filter((feature) => feature.prop && feature.has_feedback);
    if (readable.length === 0) {
      return;
    }
    const params = readable.map((feature) => ({
      did: entry.device.did,
      siid: feature.prop.siid,
      piid: feature.prop.piid,
    }));
    const results = await this.withAuthRetry(() => this.api.getProps(params));
    const states = [];
    for (const result of results) {
      for (const target of this.byProp.get(`${result.did}:${result.siid}:${result.piid}`) ?? []) {
        const state = buildState(target, result.value);
        if (state) {
          states.push(state);
        }
      }
    }
    await this.publishStates(states);
  }

  /** Poll every device of the catalog (used right after a (re)connection). */
  async pollAll() {
    for (const entry of this.entries.values()) {
      try {
        await this.poll({ external_id: entry.ids.device });
      } catch (err) {
        logger.warn(`initial poll of ${entry.device.name} failed: ${err.message}`);
      }
    }
  }

  // --- Xiaomi -> Gladys ----------------------------------------------------------

  /** One decoded MQTT message. */
  handlePush(message) {
    if (message.type === 'state') {
      const entry = this.entries.get(message.did);
      if (entry) {
        entry.device.online = message.online;
        this.gladys
          .publishTransports([
            {
              external_id: entry.ids.device,
              transport: message.online ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.UNREACHABLE,
            },
          ])
          .catch((err) => logger.warn(`transport publish failed: ${err.message}`));
      }
      return;
    }
    if (message.type === 'property') {
      const targets = this.byProp.get(`${message.did}:${message.siid}:${message.piid}`) ?? [];
      const states = targets.map((target) => buildState(target, message.value)).filter(Boolean);
      this.publishStates(states).catch((err) =>
        logger.warn(`state publish failed: ${err.message}`),
      );
      return;
    }
    if (message.type === 'event') {
      const targets = this.byEvent.get(`${message.did}:${message.siid}:${message.eiid}`) ?? [];
      const states = targets.map((target) => ({
        device_feature_external_id: target.externalId,
        state: target.value,
      }));
      this.publishStates(states).catch((err) =>
        logger.warn(`event publish failed: ${err.message}`),
      );
    }
  }

  async publishFeature(target, rawValue) {
    const state = buildState(target, rawValue);
    if (state) {
      await this.publishStates([state]);
    }
  }

  async publishStates(states) {
    for (const batch of splitEvery(states, STATES_BATCH)) {
      if (batch.length > 0) {
        await this.gladys.publishStates(batch);
      }
    }
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Open the push channel (no-op when the account is not linked). */
  startPush() {
    if (this.mqtt && this.entries.size > 0) {
      this.mqtt.connect();
      this.mqtt.setDevices([...this.entries.keys()]);
    }
  }

  stopClients() {
    this.mqtt?.disconnect();
    this.mqtt = null;
    this.api = null;
  }

  stop() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.stopClients();
  }

  /**
   * Run a call, and retry it once with a freshly refreshed token when Xiaomi
   * answers 401 — an access token can be revoked before its announced expiry.
   */
  async withAuthRetry(call) {
    try {
      return await call();
    } catch (err) {
      if (!isAuthError(err)) {
        throw err;
      }
      logger.warn('Xiaomi rejected the token, refreshing it and retrying once');
      await this.refreshIfNeeded(true);
      return call();
    }
  }
}

/** Redirect URI of the OAuth flow: the origin registered at Xiaomi. */
export function redirectUrlFor(instanceId) {
  return `${OAUTH_REDIRECT_URL}/api/webhook/${instanceId}`;
}

/** Build the Gladys state payload of one feature. */
function buildState(target, rawValue) {
  const value = target.feature.fromMiot(rawValue);
  if (value === null || value === undefined) {
    return null;
  }
  return target.feature.text
    ? { device_feature_external_id: target.externalId, text: String(value) }
    : { device_feature_external_id: target.externalId, state: Number(value) };
}

/** Service iid of an event-only feature (`e_<siid>_<kind>`). */
function eventSiid(feature) {
  return Number(feature.key.split('_')[1]);
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function splitEvery(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
