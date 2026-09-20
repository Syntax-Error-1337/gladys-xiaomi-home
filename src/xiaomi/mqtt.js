// -----------------------------------------------------------------------------
// Xiaomi cloud MQTT: the real-time push channel.
//
// The broker publishes every property change, every event and every
// online/offline transition of the account devices. It is READ-ONLY: control
// always goes through the HTTP API.
//
// Credentials are trivial: username = the OAuth client id, password = the
// access token. Nothing is signed. The session is not persistent
// (`clean: true`), so every (re)connection re-subscribes.
// -----------------------------------------------------------------------------

import mqtt from 'mqtt';
import { createLogger } from '@gladysassistant/integration-sdk';
import { BROKER_PORT, MQTT_KEEPALIVE, OAUTH2_CLIENT_ID, brokerHost } from './constants.js';

const logger = createLogger({ name: 'mqtt' });

/** Topics subscribed for one device. */
export function topicsForDevice(did) {
  return [
    `device/${did}/up/properties_changed/#`,
    // Xiaomi's own typo, on the wire since day one.
    `device/${did}/up/event_occured/#`,
    `device/${did}/state/#`,
  ];
}

/**
 * Decode one broker message.
 * @returns {{ type: 'property', did: string, siid: number, piid: number, value: unknown }
 *          | { type: 'event', did: string, siid: number, eiid: number, arguments: Array<object> }
 *          | { type: 'state', did: string, online: boolean }
 *          | null}
 */
export function decodeMessage(topic, payload) {
  let message;
  try {
    message = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  const segments = String(topic).split('/');
  const did = segments[1];
  if (!did) {
    return null;
  }
  if (segments[2] === 'state') {
    if (message.device_id !== undefined && String(message.device_id) !== did) {
      return null;
    }
    return { type: 'state', did, online: message.event === 'online' };
  }
  const params = message?.params;
  if (!params) {
    return null;
  }
  if (segments[3] === 'properties_changed') {
    if (
      typeof params.siid !== 'number' ||
      typeof params.piid !== 'number' ||
      params.value === undefined
    ) {
      return null;
    }
    return { type: 'property', did, siid: params.siid, piid: params.piid, value: params.value };
  }
  if (segments[3] === 'event_occured') {
    if (typeof params.siid !== 'number' || typeof params.eiid !== 'number') {
      return null;
    }
    return {
      type: 'event',
      did,
      siid: params.siid,
      eiid: params.eiid,
      arguments: Array.isArray(params.arguments) ? params.arguments : [],
    };
  }
  return null;
}

/**
 * Push client. One instance per Xiaomi account (region + token).
 */
export class MiotMqttClient {
  /**
   * @param {object} options
   * @param {string} options.cloudServer region key (cn, de, i2, ru, sg, us)
   * @param {string} options.instanceId stable id of this installation
   * @param {string} options.accessToken OAuth access token (used as password)
   * @param {(message: object) => void} options.onMessage decoded message sink
   */
  constructor({ cloudServer, instanceId, accessToken, onMessage }) {
    this.cloudServer = cloudServer;
    this.instanceId = instanceId;
    this.accessToken = accessToken;
    this.onMessage = onMessage;
    this.client = null;
    this.dids = new Set();
  }

  get connected() {
    return this.client?.connected === true;
  }

  /** Open the connection (idempotent). */
  connect() {
    if (this.client) {
      return;
    }
    const url = `mqtts://${brokerHost(this.cloudServer)}:${BROKER_PORT}`;
    this.client = mqtt.connect(url, {
      clientId: `ha.${this.instanceId}`,
      username: OAUTH2_CLIENT_ID,
      password: this.accessToken,
      protocolVersion: 5,
      clean: true,
      keepalive: MQTT_KEEPALIVE,
      reconnectPeriod: 10000,
      connectTimeout: 30000,
      resubscribe: false,
    });

    this.client.on('connect', () => {
      logger.info(`connected to ${url}`);
      // Nothing is persisted server-side: re-subscribe everything.
      this.subscribeTopics([...this.dids].flatMap(topicsForDevice));
    });
    this.client.on('error', (err) => logger.warn(`broker error: ${err.message}`));
    this.client.on('close', () => logger.debug('broker connection closed'));
    this.client.on('message', (topic, payload) => {
      const decoded = decodeMessage(topic, payload);
      if (decoded) {
        this.onMessage(decoded);
      }
    });
  }

  subscribeTopics(topics) {
    if (topics.length === 0 || !this.client?.connected) {
      return;
    }
    this.client.subscribe(topics, { qos: 2 }, (err) => {
      if (err) {
        logger.warn(`subscription failed: ${err.message}`);
      } else {
        logger.debug(`subscribed to ${topics.length} topics`);
      }
    });
  }

  /** Follow exactly this set of device ids (diffed against the current one). */
  setDevices(dids) {
    const wanted = new Set(dids);
    const added = [...wanted].filter((did) => !this.dids.has(did));
    const removed = [...this.dids].filter((did) => !wanted.has(did));
    this.dids = wanted;
    this.subscribeTopics(added.flatMap(topicsForDevice));
    if (removed.length > 0 && this.client?.connected) {
      this.client.unsubscribe(removed.flatMap(topicsForDevice));
    }
  }

  /**
   * Apply a refreshed OAuth token. The password is only read at connection
   * time, so the session is restarted to actually use the new one.
   */
  updateAccessToken(accessToken) {
    if (this.accessToken === accessToken) {
      return;
    }
    this.accessToken = accessToken;
    if (this.client) {
      const dids = [...this.dids];
      this.disconnect();
      this.connect();
      this.dids = new Set(dids);
    }
  }

  disconnect() {
    if (!this.client) {
      return;
    }
    this.client.removeAllListeners();
    this.client.end(true);
    this.client = null;
  }
}
