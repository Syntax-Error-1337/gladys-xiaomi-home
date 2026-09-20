// -----------------------------------------------------------------------------
// MIoT-Spec-V2 instances.
//
// Every Xiaomi device declares a `spec_type` URN
// (`urn:<namespace>:device:<name>:<value>:<vendor-product>:<version>`), and the
// public spec registry answers with its services, properties, events and
// actions. That description is what this integration turns into Gladys
// features — nothing is hard-coded per model.
//
// The registry is public: no token, no signature, plain GET. A URN carries its
// version, so an instance never changes: it is cached forever on disk (/data).
// -----------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { fetchJson } from './httpUtils.js';

const logger = createLogger({ name: 'spec' });

const INSTANCE_URL = 'https://miot-spec.org/miot-spec-v2/instance';

/** Services that carry no controllable feature. */
const IGNORED_SERVICES = new Set(['device-information']);

/**
 * Lowercase, `_`-separated slug of a spec description — the identifier the
 * value-list items are matched on (`open`, `heat`, `go_charging`...).
 */
export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** `urn:miot-spec-v2:property:on:00000006:xxx:1` -> `on`. */
export function urnName(urn) {
  return String(urn).split(':')[3] ?? '';
}

/** A URN outside the `miot-spec-v2` namespace describes a vendor extension. */
export function isProprietary(urn) {
  return String(urn).split(':')[1] !== 'miot-spec-v2';
}

/** Spec descriptions are sometimes empty: fall back to the URN name. */
function cleanDescription(description, fallback) {
  const text = String(description ?? '').trim();
  return text === '' ? fallback : text;
}

function parseAccess(access) {
  const list = Array.isArray(access) ? access : [];
  return {
    read: list.includes('read'),
    write: list.includes('write'),
    notify: list.includes('notify'),
  };
}

function parseValueList(rawList) {
  const seen = new Map();
  const items = [];
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    if (raw?.value === undefined) {
      continue;
    }
    const description = String(raw.description ?? '').trim() || `v_${raw.value}`;
    let name = slugify(description) || `v_${raw.value}`;
    // Two items sharing a description would collide: suffix the duplicates.
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count > 1) {
      name = `${name}_${count}`;
    }
    items.push({ value: raw.value, name, description });
  }
  return items;
}

function parseProperty(raw) {
  if (raw?.iid === undefined || !raw.type || !raw.format || !raw.access) {
    return null;
  }
  const valueRange =
    Array.isArray(raw['value-range']) && raw['value-range'].length >= 2 ? raw['value-range'] : null;
  return {
    iid: raw.iid,
    urn: raw.type,
    name: urnName(raw.type),
    description: cleanDescription(raw.description, urnName(raw.type)),
    format: raw.format,
    access: parseAccess(raw.access),
    // `none` is how the spec spells "no unit".
    unit: raw.unit && raw.unit !== 'none' ? raw.unit : null,
    valueRange: valueRange
      ? { min: valueRange[0], max: valueRange[1], step: valueRange[2] ?? 1 }
      : null,
    valueList: parseValueList(raw['value-list']),
    proprietary: isProprietary(raw.type),
  };
}

function parseAction(raw) {
  if (raw?.iid === undefined || !raw.type || !Array.isArray(raw.in)) {
    return null;
  }
  return {
    iid: raw.iid,
    urn: raw.type,
    name: urnName(raw.type),
    description: cleanDescription(raw.description, urnName(raw.type)),
    in: raw.in,
    proprietary: isProprietary(raw.type),
  };
}

function parseEvent(raw) {
  if (raw?.iid === undefined || !raw.type) {
    return null;
  }
  return {
    iid: raw.iid,
    urn: raw.type,
    name: urnName(raw.type),
    description: cleanDescription(raw.description, urnName(raw.type)),
    arguments: Array.isArray(raw.arguments) ? raw.arguments : [],
    proprietary: isProprietary(raw.type),
  };
}

/** Turn the raw registry answer into the normalized instance used downstream. */
export function parseInstance(raw) {
  if (!raw || !raw.type || !Array.isArray(raw.services)) {
    throw new Error('invalid MIoT spec instance');
  }
  const services = [];
  for (const rawService of raw.services) {
    if (rawService?.iid === undefined || !rawService.type) {
      continue;
    }
    const name = urnName(rawService.type);
    if (IGNORED_SERVICES.has(name)) {
      continue;
    }
    services.push({
      iid: rawService.iid,
      urn: rawService.type,
      name,
      description: cleanDescription(rawService.description, name),
      properties: (rawService.properties ?? []).map(parseProperty).filter(Boolean),
      actions: (rawService.actions ?? []).map(parseAction).filter(Boolean),
      events: (rawService.events ?? []).map(parseEvent).filter(Boolean),
    });
  }
  return {
    urn: raw.type,
    name: urnName(raw.type),
    description: cleanDescription(raw.description, urnName(raw.type)),
    services,
  };
}

/**
 * Loader of MIoT spec instances: memory cache -> disk cache -> registry.
 */
export class SpecStore {
  /** @param {{ dataDir?: string }} options */
  constructor({ dataDir = process.env.XIAOMI_DATA_DIR ?? './data' } = {}) {
    this.cacheDir = path.join(dataDir, 'spec-cache');
    this.memory = new Map();
    this.diskAvailable = true;
  }

  cacheFile(urn) {
    return path.join(this.cacheDir, `${urn.replace(/[:/]/g, '_')}.json`);
  }

  async readDisk(urn) {
    if (!this.diskAvailable) {
      return null;
    }
    try {
      return JSON.parse(await readFile(this.cacheFile(urn), 'utf8'));
    } catch {
      return null;
    }
  }

  async writeDisk(urn, instance) {
    if (!this.diskAvailable) {
      return;
    }
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(this.cacheFile(urn), JSON.stringify(instance), 'utf8');
    } catch (err) {
      // A read-only /data is not fatal: the memory cache still works.
      this.diskAvailable = false;
      logger.warn(`spec cache disabled (${err.message})`);
    }
  }

  /**
   * Instance of a device type URN.
   * @param {string} urn
   * @returns {Promise<{urn: string, name: string, description: string, services: Array<object>}>}
   */
  async get(urn) {
    const cached = this.memory.get(urn);
    if (cached) {
      return cached;
    }
    const fromDisk = await this.readDisk(urn);
    if (fromDisk) {
      this.memory.set(urn, fromDisk);
      return fromDisk;
    }
    const url = new URL(INSTANCE_URL);
    url.searchParams.set('type', urn);
    logger.debug(`fetching spec ${urn}`);
    const instance = parseInstance(await fetchJson(url));
    this.memory.set(urn, instance);
    await this.writeDisk(urn, instance);
    return instance;
  }
}
