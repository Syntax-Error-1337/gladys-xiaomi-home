// -----------------------------------------------------------------------------
// MiHome HTTP API client ("haapi" surface of the Xiaomi cloud).
//
// Everything is a POST with a JSON body, answered by the envelope
// `{ code, message, result }`. Authentication is a plain bearer token — note
// the missing space after `Bearer`, which is what the Xiaomi servers expect.
// -----------------------------------------------------------------------------

import {
  CONTROL_TIMEOUT,
  DEVICE_GONE_CODES,
  DEVICE_LIST_PAGE_LIMIT,
  GET_PROP_MAX_BATCH,
  HTTP_TIMEOUT,
  OAUTH2_CLIENT_ID,
  UNSUPPORTED_MODELS,
  apiHost,
} from './constants.js';
import { XiaomiHttpError, chunk, fetchJson } from './httpUtils.js';

export class MiHomeApi {
  /**
   * @param {{ cloudServer: string, accessToken: string }} options
   */
  constructor({ cloudServer, accessToken }) {
    this.cloudServer = cloudServer;
    this.host = apiHost(cloudServer);
    this.accessToken = accessToken;
  }

  /** Swap the bearer token after an OAuth refresh. */
  setAccessToken(accessToken) {
    this.accessToken = accessToken;
  }

  get headers() {
    return {
      Host: this.host,
      'X-Client-BizId': 'haapi',
      'Content-Type': 'application/json',
      // No space after `Bearer`: that is the wire format of this API.
      Authorization: `Bearer${this.accessToken}`,
      'X-Client-AppId': OAUTH2_CLIENT_ID,
    };
  }

  async post(path, payload, timeout = HTTP_TIMEOUT) {
    const body = await fetchJson(`https://${this.host}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
      timeout,
    });
    if (body.code !== 0) {
      throw new XiaomiHttpError(
        `Xiaomi API error on ${path}: ${body.code} ${body.message ?? ''}`.trim(),
        {
          code: body.code,
        },
      );
    }
    return body.result;
  }

  /**
   * Homes and rooms of the account. Also the only source of the user id.
   * @returns {Promise<{ uid: string, rooms: Map<string, string>, homes: Map<string, string> }>}
   *   `rooms` maps a device id to its room name, `homes` to its home name.
   */
  async getHomeInfos() {
    const result = await this.post('/app/v2/homeroom/gethome', {
      limit: 150,
      fetch_share: true,
      fetch_share_dev: true,
      plat_form: 0,
      app_ver: 9,
    });
    const rooms = new Map();
    const homes = new Map();
    let uid = '';
    const homeLists = [result?.homelist, result?.share_home_list];
    for (const list of homeLists) {
      for (const home of Array.isArray(list) ? list : []) {
        if (!home?.id || !home?.name) {
          continue;
        }
        if (uid === '' && home.uid !== undefined) {
          uid = String(home.uid);
        }
        for (const did of home.dids ?? []) {
          homes.set(String(did), home.name);
        }
        for (const room of home.roomlist ?? []) {
          for (const did of room?.dids ?? []) {
            homes.set(String(did), home.name);
            if (room.name) {
              rooms.set(String(did), room.name);
            }
          }
        }
      }
    }
    return { uid, rooms, homes };
  }

  /**
   * Every device of the account, hydrated page by page.
   * Sub-devices (`<did>.s<n>`) are folded into their parent as `subDevices`.
   * @returns {Promise<Array<object>>}
   */
  async getDevices() {
    const { rooms, homes } = await this.getHomeInfos();
    const devices = [];
    let startDid = null;
    do {
      const payload = {
        limit: DEVICE_LIST_PAGE_LIMIT,
        get_split_device: true,
        get_third_device: true,
      };
      if (startDid) {
        payload.start_did = startDid;
      }
      const result = await this.post('/app/v2/home/device_list_page', payload);
      for (const raw of result?.list ?? []) {
        const device = normalizeDevice(raw);
        if (device) {
          device.room = rooms.get(device.did) ?? null;
          device.home = homes.get(device.did) ?? null;
          devices.push(device);
        }
      }
      startDid = result?.has_more ? (result?.next_start_did ?? null) : null;
    } while (startDid);
    return devices;
  }

  /**
   * Read properties. `props` is a list of `{ did, siid, piid }`; the call is
   * split in batches of 150, the maximum the API accepts.
   * @returns {Promise<Array<{did: string, siid: number, piid: number, value: unknown, code: number}>>}
   */
  async getProps(props) {
    if (props.length === 0) {
      return [];
    }
    const batches = chunk(props, GET_PROP_MAX_BATCH);
    const results = await Promise.all(
      batches.map((params) => this.post('/app/v2/miotspec/prop/get', { datasource: 1, params })),
    );
    return results.flat().filter((item) => item && item.code === 0 && item.value !== undefined);
  }

  /**
   * Write properties. Throws when the device refuses or is unreachable, so the
   * SDK acknowledges the command as failed in Gladys.
   * @param {Array<{did: string, siid: number, piid: number, value: unknown}>} params
   */
  async setProps(params) {
    const result = await this.post('/app/v2/miotspec/prop/set', { params }, CONTROL_TIMEOUT);
    for (const item of Array.isArray(result) ? result : []) {
      assertItemCode(item?.code, `${item?.did} ${item?.siid}.${item?.piid}`);
    }
    return result;
  }

  /**
   * Run an action. `args` is the ordered list of the input values (the API
   * expects bare values, not `{ piid, value }` pairs).
   */
  async action({ did, siid, aiid, args = [] }) {
    const result = await this.post(
      '/app/v2/miotspec/action',
      { params: { did, siid, aiid, in: args } },
      CONTROL_TIMEOUT,
    );
    assertItemCode(result?.code, `${did} action ${siid}.${aiid}`);
    return result?.out ?? [];
  }
}

/** A per-item code of 0 or 1 means success; some codes mean "device gone". */
function assertItemCode(code, what) {
  if (code === 0 || code === 1 || code === undefined) {
    return;
  }
  if (DEVICE_GONE_CODES.includes(code)) {
    throw new XiaomiHttpError(`device unavailable (${what}): it is offline or was removed`, {
      code,
    });
  }
  throw new XiaomiHttpError(`Xiaomi refused the command (${what}): code ${code}`, { code });
}

/** Map one raw cloud record to the device shape used by the integration. */
export function normalizeDevice(raw) {
  const did = raw?.did ? String(raw.did) : null;
  if (!did || !raw.name || !raw.spec_type || !raw.model) {
    return null;
  }
  if (did.startsWith('miwifi.') || UNSUPPORTED_MODELS.includes(raw.model)) {
    return null;
  }
  return {
    did,
    name: String(raw.name).trim(),
    model: raw.model,
    urn: raw.spec_type,
    manufacturer: String(raw.model).split('.')[0],
    online: raw.isOnline === true,
    firmware: raw.extra?.fw_version ?? null,
    localIp: raw.local_ip ?? null,
    parentId: raw.parent_id ?? null,
    room: null,
    home: null,
  };
}
