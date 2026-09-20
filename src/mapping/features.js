// -----------------------------------------------------------------------------
// MIoT-Spec-V2 -> Gladys features.
//
// This is the heart of the integration: nothing is hard-coded per model, every
// feature is derived from the device spec published by Xiaomi.
//
// Resolution order for one property, from the most specific to the fallback:
//   1. a SERVICE + PROPERTY rule (`on` inside a `light` service is a light,
//      inside an `outlet` service it is a switch);
//   2. a PROPERTY rule (`temperature`, `battery-level`, `contact-state`...);
//   3. the generic rule, driven by format/access/value-list/value-range:
//        writable bool        -> switch
//        writable enum        -> text select (options from the spec)
//        writable string      -> text
//        read-only bool       -> binary sensor (category unknown)
//        read-only enum/string-> text
//        read-only number     -> numeric sensor (category unknown)
//      The generic numeric/binary fallbacks only run when the user asks for
//      them (`expose_unmapped`), otherwise a device would carry dozens of
//      cryptic vendor properties.
//
// Actions without argument become write-only "command" switches; the events of
// a service become a button, a doorbell or a motion feature.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { toGladysUnit } from './units.js';
import { isProprietary } from '../xiaomi/spec.js';
import {
  AC_FAN_SPEED,
  AC_MODE,
  BUTTON_STATUS,
  COVER_STATE,
  FAN_MODE,
  THERMOSTAT_MODE,
  VACUUM_CLEANER_STATE,
} from './gladysValues.js';

// --- Service families ---------------------------------------------------------

const LIGHT_SERVICES = new Set([
  'light',
  'ambient-light',
  'night-light',
  'white-light',
  'indicator-light',
  'light-strip',
]);
const FAN_SERVICES = new Set(['fan', 'fan-control', 'ceiling-fan', 'air-fresh', 'air-purifier']);
const COVER_SERVICES = new Set(['curtain', 'window-opener', 'motor-controller', 'airer']);
const AC_SERVICES = new Set(['air-conditioner', 'air-condition-outlet']);
const THERMOSTAT_SERVICES = new Set([
  'thermostat',
  'heater',
  'electric-blanket',
  'ptc-bath-heater',
]);
const WATER_HEATER_SERVICES = new Set(['water-heater']);
const VACUUM_SERVICES = new Set(['vacuum', 'robot-cleaner', 'sweep']);
const SIREN_SERVICES = new Set(['siren', 'alarm']);

// --- Numeric sensor properties -------------------------------------------------
// `range` is the fallback bound pair used when the spec declares none: Gladys
// requires min and max on every feature.

const SENSOR_PROPS = new Map(
  Object.entries({
    temperature: {
      category: CATEGORIES.TEMPERATURE_SENSOR,
      unit: UNITS.CELSIUS,
      range: [-50, 150],
    },
    'relative-humidity': {
      category: CATEGORIES.HUMIDITY_SENSOR,
      unit: UNITS.PERCENT,
      range: [0, 100],
    },
    humidity: { category: CATEGORIES.HUMIDITY_SENSOR, unit: UNITS.PERCENT, range: [0, 100] },
    illumination: { category: CATEGORIES.LIGHT_SENSOR, unit: UNITS.LUX, range: [0, 100000] },
    'battery-level': {
      category: CATEGORIES.BATTERY,
      type: TYPES.BATTERY.INTEGER,
      unit: UNITS.PERCENT,
      range: [0, 100],
    },
    'pm2.5-density': {
      category: CATEGORIES.PM25_SENSOR,
      unit: UNITS.MICROGRAM_PER_CUBIC_METER,
      range: [0, 1000],
    },
    'pm10-density': {
      category: CATEGORIES.PM10_SENSOR,
      unit: UNITS.MICROGRAM_PER_CUBIC_METER,
      range: [0, 1000],
    },
    'co2-density': { category: CATEGORIES.CO2_SENSOR, unit: UNITS.PPM, range: [0, 10000] },
    'co-density': { category: CATEGORIES.CO_SENSOR, unit: UNITS.PPM, range: [0, 1000] },
    'tvoc-density': { category: CATEGORIES.VOC_SENSOR, unit: null, range: [0, 10000] },
    'voc-density': { category: CATEGORIES.VOC_SENSOR, unit: null, range: [0, 10000] },
    'formaldehyde-density': {
      category: CATEGORIES.FORMALDEHYD_SENSOR,
      unit: null,
      range: [0, 1000],
    },
    'air-quality-index': {
      category: CATEGORIES.AIRQUALITY_SENSOR,
      type: TYPES.AIRQUALITY_SENSOR.AQI,
      unit: UNITS.AQI,
      range: [0, 500],
    },
    'atmospheric-pressure': {
      category: CATEGORIES.PRESSURE_SENSOR,
      unit: UNITS.PASCAL,
      range: [0, 200000],
    },
    noise: { category: CATEGORIES.NOISE_SENSOR, unit: UNITS.DECIBEL, range: [0, 150] },
    voltage: {
      category: CATEGORIES.ENERGY_SENSOR,
      type: TYPES.ENERGY_SENSOR.VOLTAGE,
      unit: UNITS.VOLT,
      range: [0, 500],
    },
    'electric-current': {
      category: CATEGORIES.ENERGY_SENSOR,
      type: TYPES.ENERGY_SENSOR.CURRENT,
      unit: UNITS.AMPERE,
      range: [0, 100],
    },
    'electric-power': {
      category: CATEGORIES.ENERGY_SENSOR,
      type: TYPES.ENERGY_SENSOR.POWER,
      unit: UNITS.WATT,
      range: [0, 10000],
    },
    power: {
      category: CATEGORIES.ENERGY_SENSOR,
      type: TYPES.ENERGY_SENSOR.POWER,
      unit: UNITS.WATT,
      range: [0, 10000],
    },
    'surge-power': {
      category: CATEGORIES.ENERGY_SENSOR,
      type: TYPES.ENERGY_SENSOR.POWER,
      unit: UNITS.WATT,
      range: [0, 10000],
    },
    'power-consumption': {
      category: CATEGORIES.ENERGY_SENSOR,
      type: TYPES.ENERGY_SENSOR.ENERGY,
      unit: UNITS.WATT_HOUR,
      range: [0, 1000000],
    },
    'filter-life-level': {
      category: CATEGORIES.HEPA_FILTER_MONITORING,
      type: TYPES.FILTER_MONITORING.FILTER_LIFE_REMAINING,
      unit: UNITS.PERCENT,
      range: [0, 100],
    },
    'brush-life-level': {
      category: CATEGORIES.MAINTENANCE,
      type: TYPES.MAINTENANCE.LIFE_REMAINING,
      unit: UNITS.PERCENT,
      range: [0, 100],
    },
    'soil-ec': { category: CATEGORIES.SOIL_MOISTURE_SENSOR, unit: UNITS.PERCENT, range: [0, 100] },
  }),
);

// --- Boolean sensor properties --------------------------------------------------

const BINARY_PROPS = new Map(
  Object.entries({
    // Xiaomi reports `true` when the contact is CLOSED, which is exactly the
    // Gladys opening-sensor convention (OPEN: 0, CLOSE: 1).
    'contact-state': { category: CATEGORIES.OPENING_SENSOR },
    'motion-state': { category: CATEGORIES.MOTION_SENSOR },
    'occupancy-status': { category: CATEGORIES.PRESENCE_SENSOR },
    'submersion-state': { category: CATEGORIES.LEAK_SENSOR },
    'water-immersion': { category: CATEGORIES.LEAK_SENSOR },
    smoke: { category: CATEGORIES.SMOKE_SENSOR },
    'smoke-state': { category: CATEGORIES.SMOKE_SENSOR },
    'tamper-state': { category: CATEGORIES.TAMPER },
    'vibration-state': {
      category: CATEGORIES.VIBRATION_SENSOR,
      type: TYPES.VIBRATION_SENSOR.BINARY,
    },
  }),
);

// --- Value-list name maps -------------------------------------------------------
// The item `name` is the slug of the English spec description, which is what
// makes these tables portable across vendors.

const COVER_CONTROL_NAMES = {
  open: COVER_STATE.OPEN,
  up: COVER_STATE.OPEN,
  rise: COVER_STATE.OPEN,
  close: COVER_STATE.CLOSE,
  down: COVER_STATE.CLOSE,
  descend: COVER_STATE.CLOSE,
  pause: COVER_STATE.STOP,
  stop: COVER_STATE.STOP,
};

const AC_MODE_NAMES = {
  auto: AC_MODE.AUTO,
  cool: AC_MODE.COOLING,
  cooling: AC_MODE.COOLING,
  heat: AC_MODE.HEATING,
  heating: AC_MODE.HEATING,
  dry: AC_MODE.DRYING,
  drying: AC_MODE.DRYING,
  dehumidification: AC_MODE.DRYING,
  fan: AC_MODE.FAN,
  wind: AC_MODE.FAN,
  ventilate: AC_MODE.FAN,
};

const AC_FAN_SPEED_NAMES = {
  auto: AC_FAN_SPEED.AUTO,
  low: AC_FAN_SPEED.LOW,
  level1: AC_FAN_SPEED.LOW,
  medium: AC_FAN_SPEED.MID,
  middle: AC_FAN_SPEED.MID,
  mid: AC_FAN_SPEED.MID,
  level2: AC_FAN_SPEED.MID,
  high: AC_FAN_SPEED.HIGH,
  level3: AC_FAN_SPEED.HIGH,
  quiet: AC_FAN_SPEED.QUIET,
  silent: AC_FAN_SPEED.QUIET,
  sleep: AC_FAN_SPEED.QUIET,
  turbo: AC_FAN_SPEED.TURBO,
  strong: AC_FAN_SPEED.TURBO,
};

const THERMOSTAT_MODE_NAMES = {
  off: THERMOSTAT_MODE.OFF,
  close: THERMOSTAT_MODE.OFF,
  heat: THERMOSTAT_MODE.HEATING,
  heating: THERMOSTAT_MODE.HEATING,
  cool: THERMOSTAT_MODE.COOLING,
  cooling: THERMOSTAT_MODE.COOLING,
  auto: THERMOSTAT_MODE.AUTO,
};

const FAN_MODE_NAMES = {
  off: FAN_MODE.OFF,
  low: FAN_MODE.LOW,
  level1: FAN_MODE.LOW,
  medium: FAN_MODE.MEDIUM,
  middle: FAN_MODE.MEDIUM,
  mid: FAN_MODE.MEDIUM,
  level2: FAN_MODE.MEDIUM,
  high: FAN_MODE.HIGH,
  level3: FAN_MODE.HIGH,
  auto: FAN_MODE.AUTO,
};

const VACUUM_STATUS_NAMES = {
  idle: VACUUM_CLEANER_STATE.STOPPED,
  sleep: VACUUM_CLEANER_STATE.STOPPED,
  stopped: VACUUM_CLEANER_STATE.STOPPED,
  stop: VACUUM_CLEANER_STATE.STOPPED,
  standby: VACUUM_CLEANER_STATE.STOPPED,
  sweeping: VACUUM_CLEANER_STATE.RUNNING,
  cleaning: VACUUM_CLEANER_STATE.RUNNING,
  mopping: VACUUM_CLEANER_STATE.RUNNING,
  working: VACUUM_CLEANER_STATE.RUNNING,
  busy: VACUUM_CLEANER_STATE.RUNNING,
  paused: VACUUM_CLEANER_STATE.PAUSED,
  pause: VACUUM_CLEANER_STATE.PAUSED,
  error: VACUUM_CLEANER_STATE.ERROR,
  fault: VACUUM_CLEANER_STATE.ERROR,
  go_charging: VACUUM_CLEANER_STATE.RETURNING_TO_DOCK,
  back_home: VACUUM_CLEANER_STATE.RETURNING_TO_DOCK,
  returning: VACUUM_CLEANER_STATE.RETURNING_TO_DOCK,
  charging: VACUUM_CLEANER_STATE.CHARGING,
  charging_completed: VACUUM_CLEANER_STATE.DOCKED,
  full_charged: VACUUM_CLEANER_STATE.DOCKED,
  docked: VACUUM_CLEANER_STATE.DOCKED,
};

const BUTTON_EVENT_NAMES = {
  click: BUTTON_STATUS.CLICK,
  'single-press': BUTTON_STATUS.CLICK,
  'double-click': BUTTON_STATUS.DOUBLE_CLICK,
  'double-press': BUTTON_STATUS.DOUBLE_CLICK,
  'triple-click': BUTTON_STATUS.TRIPLE,
  'long-press': BUTTON_STATUS.LONG_CLICK,
  'long-click': BUTTON_STATUS.LONG_CLICK,
};

// --- Small helpers ---------------------------------------------------------------

const identity = (value) => value;

function toNumber(raw) {
  if (typeof raw === 'boolean') {
    return raw ? 1 : 0;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Decimals implied by the spec step (0.5 -> 1 decimal, 1 -> 0 decimal). */
function precisionOf(step) {
  if (!Number.isFinite(step) || Number.isInteger(step)) {
    return 0;
  }
  return String(step).split('.')[1]?.length ?? 0;
}

function isIntegerFormat(format) {
  return /^u?int\d+$/.test(String(format));
}

/** Linear rescaling between two ranges, clamped to the target range. */
function scale(value, from, to) {
  if (from.max === from.min) {
    return to.min;
  }
  const ratio = (value - from.min) / (from.max - from.min);
  return Math.min(to.max, Math.max(to.min, to.min + ratio * (to.max - to.min)));
}

/**
 * Translate a value-list into Gladys enum values through a name table.
 *
 * Strict by default: one unknown item and the whole property falls back to a
 * text select, which never loses a choice. `required` switches to the tolerant
 * mode used by the controls whose vocabulary vendors extend freely (a curtain
 * adding "auto" next to open/close): the listed Gladys values must be there,
 * the extra ones are dropped.
 *
 * @returns {{ options: Array<{value:number,label:string}>, fromMiot: Function, toMiot: Function } | null}
 */
function mapValueList(valueList, nameTable, { required = null } = {}) {
  if (!valueList || valueList.length === 0) {
    return null;
  }
  const toGladys = new Map();
  const toMiotValue = new Map();
  const options = [];
  for (const item of valueList) {
    const gladysValue = nameTable[item.name];
    if (gladysValue === undefined) {
      if (required === null) {
        return null;
      }
      continue;
    }
    toGladys.set(item.value, gladysValue);
    if (!toMiotValue.has(gladysValue)) {
      toMiotValue.set(gladysValue, item.value);
      options.push({ value: gladysValue, label: item.description });
    }
  }
  if (options.length === 0 || (required ?? []).some((value) => !toMiotValue.has(value))) {
    return null;
  }
  return {
    options,
    fromMiot: (raw) => (toGladys.has(raw) ? toGladys.get(raw) : null),
    toMiot: (value) => (toMiotValue.has(value) ? toMiotValue.get(value) : value),
  };
}

// --- Feature factories -------------------------------------------------------------

function propKey(prop) {
  return `p_${prop.siid}_${prop.iid}`;
}

function baseFeature(prop, service, overrides) {
  return {
    key: propKey({ siid: service.iid, iid: prop.iid }),
    name: prop.description,
    serviceName: service.description,
    unit: null,
    min: 0,
    max: 1,
    step: null,
    read_only: !prop.access.write,
    has_feedback: prop.access.read || prop.access.notify,
    keep_history: true,
    supported_options: null,
    text: false,
    prop: { siid: service.iid, piid: prop.iid },
    action: null,
    events: null,
    fromMiot: toNumber,
    toMiot: identity,
    ...overrides,
  };
}

function binaryFeature(prop, service, { category, type = TYPES.SENSOR.BINARY, invert = false }) {
  return baseFeature(prop, service, {
    category,
    type,
    min: 0,
    max: 1,
    keep_history: true,
    fromMiot: (raw) => {
      const value = raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0;
      return invert ? 1 - value : value;
    },
    toMiot: (value) => {
      const on = Number(value) === 1;
      return invert ? !on : on;
    },
  });
}

function numericFeature(prop, service, { category, type, unit, range, percentScale = false }) {
  const specRange = prop.valueRange;
  const bounds = percentScale
    ? { min: 0, max: 100 }
    : {
        min: specRange ? specRange.min : range[0],
        max: specRange ? specRange.max : range[1],
      };
  const decimals = specRange ? precisionOf(specRange.step) : isIntegerFormat(prop.format) ? 0 : 2;
  const featureType = type ?? (decimals === 0 ? TYPES.SENSOR.INTEGER : TYPES.SENSOR.DECIMAL);
  return baseFeature(prop, service, {
    category,
    type: featureType,
    unit,
    min: bounds.min,
    max: bounds.max,
    step: specRange && !percentScale ? specRange.step : null,
    fromMiot: (raw) => {
      const value = toNumber(raw);
      if (value === null) {
        return null;
      }
      if (percentScale && specRange) {
        return Math.round(scale(value, specRange, bounds));
      }
      return round(value, decimals);
    },
    toMiot: (value) => {
      const numeric = Number(value);
      if (percentScale && specRange) {
        const scaled = scale(numeric, bounds, specRange);
        return isIntegerFormat(prop.format)
          ? Math.round(scaled)
          : round(scaled, precisionOf(specRange.step));
      }
      return isIntegerFormat(prop.format) ? Math.round(numeric) : numeric;
    },
  });
}

/** Enum rendered with Gladys integer values (AC mode, cover state...). */
function enumFeature(prop, service, { category, type, mapped }) {
  return baseFeature(prop, service, {
    category,
    type,
    min: Math.min(...mapped.options.map((option) => option.value)),
    max: Math.max(...mapped.options.map((option) => option.value)),
    supported_options: mapped.options,
    fromMiot: mapped.fromMiot,
    toMiot: mapped.toMiot,
  });
}

/** Enum with no Gladys equivalent: a text select keeps every choice. */
function textSelectFeature(prop, service) {
  const toMiotValue = new Map(prop.valueList.map((item) => [item.name, item.value]));
  const toName = new Map(prop.valueList.map((item) => [item.value, item.name]));
  return baseFeature(prop, service, {
    category: CATEGORIES.TEXT,
    type: TYPES.TEXT.SELECT,
    text: true,
    keep_history: false,
    supported_options: prop.valueList.map((item) => ({
      value: item.name,
      label: item.description,
    })),
    fromMiot: (raw) => toName.get(raw) ?? String(raw),
    toMiot: (value) => (toMiotValue.has(value) ? toMiotValue.get(value) : value),
  });
}

/** Read-only enum or string: a plain text feature. */
function textFeature(prop, service) {
  const toDescription = new Map(
    (prop.valueList ?? []).map((item) => [item.value, item.description]),
  );
  return baseFeature(prop, service, {
    category: CATEGORIES.TEXT,
    type: TYPES.TEXT.TEXT,
    text: true,
    keep_history: false,
    fromMiot: (raw) => toDescription.get(raw) ?? String(raw),
    toMiot: identity,
  });
}

// --- Property resolution ------------------------------------------------------------

function resolveLightProperty(prop, service) {
  switch (prop.name) {
    case 'on':
      return binaryFeature(prop, service, { category: CATEGORIES.LIGHT, type: TYPES.LIGHT.BINARY });
    case 'brightness':
      if (prop.valueRange) {
        return numericFeature(prop, service, {
          category: CATEGORIES.LIGHT,
          type: TYPES.LIGHT.BRIGHTNESS,
          unit: UNITS.PERCENT,
          range: [0, 100],
          percentScale: true,
        });
      }
      return null;
    case 'color-temperature':
      if (prop.valueRange) {
        // Kept in Kelvin: the bounds travel with the feature, so the Gladys
        // slider spans exactly what the bulb supports.
        return numericFeature(prop, service, {
          category: CATEGORIES.LIGHT,
          type: TYPES.LIGHT.TEMPERATURE,
          unit: UNITS.KELVIN,
          range: [2700, 6500],
        });
      }
      return null;
    case 'color':
      return baseFeature(prop, service, {
        category: CATEGORIES.LIGHT,
        type: TYPES.LIGHT.COLOR,
        min: 0,
        max: 16777215,
        fromMiot: (raw) => {
          const value = toNumber(raw);
          return value === null ? null : value & 0xffffff;
        },
        toMiot: (value) => Number(value) & 0xffffff,
      });
    default:
      return null;
  }
}

function resolveCoverProperty(prop, service) {
  const category = service.name === 'curtain' ? CATEGORIES.CURTAIN : CATEGORIES.SHUTTER;
  const types = category === CATEGORIES.CURTAIN ? TYPES.CURTAIN : TYPES.SHUTTER;
  if (prop.name === 'motor-control' && prop.access.write) {
    const mapped = mapValueList(prop.valueList, COVER_CONTROL_NAMES, {
      required: [COVER_STATE.OPEN, COVER_STATE.CLOSE],
    });
    if (mapped) {
      return enumFeature(prop, service, { category, type: types.STATE, mapped });
    }
    return null;
  }
  if (prop.name === 'target-position' && prop.access.write) {
    return numericFeature(prop, service, {
      category,
      type: types.POSITION,
      unit: UNITS.PERCENT,
      range: [0, 100],
      percentScale: true,
    });
  }
  if (prop.name === 'current-position') {
    const feature = numericFeature(prop, service, {
      category,
      type: types.POSITION,
      unit: UNITS.PERCENT,
      range: [0, 100],
      percentScale: true,
    });
    feature.read_only = true;
    return feature;
  }
  return null;
}

function resolveClimateProperty(prop, service, spec) {
  const isAc = AC_SERVICES.has(service.name) || AC_SERVICES.has(spec.name);
  const category = isAc ? CATEGORIES.AIR_CONDITIONING : CATEGORIES.THERMOSTAT;
  if (prop.name === 'on' && isAc) {
    return binaryFeature(prop, service, {
      category: CATEGORIES.AIR_CONDITIONING,
      type: TYPES.AIR_CONDITIONING.BINARY,
    });
  }
  if (prop.name === 'target-temperature' && prop.access.write) {
    return numericFeature(prop, service, {
      category,
      type: isAc ? TYPES.AIR_CONDITIONING.TARGET_TEMPERATURE : TYPES.THERMOSTAT.TARGET_TEMPERATURE,
      unit: toGladysUnit(prop.unit) ?? UNITS.CELSIUS,
      range: [5, 35],
    });
  }
  if (prop.name === 'mode' && prop.access.write) {
    const mapped = mapValueList(prop.valueList, isAc ? AC_MODE_NAMES : THERMOSTAT_MODE_NAMES);
    if (mapped) {
      return enumFeature(prop, service, {
        category,
        type: isAc ? TYPES.AIR_CONDITIONING.MODE : TYPES.THERMOSTAT.MODE,
        mapped,
      });
    }
    return null;
  }
  if (isAc && prop.name === 'fan-level' && prop.access.write) {
    const mapped = mapValueList(prop.valueList, AC_FAN_SPEED_NAMES);
    if (mapped) {
      return enumFeature(prop, service, {
        category: CATEGORIES.AIR_CONDITIONING,
        type: TYPES.AIR_CONDITIONING.FAN_SPEED,
        mapped,
      });
    }
    return null;
  }
  if (isAc && prop.access.write && prop.format === 'bool') {
    if (prop.name === 'vertical-swing') {
      return binaryFeature(prop, service, {
        category: CATEGORIES.AIR_CONDITIONING,
        type: TYPES.AIR_CONDITIONING.SWING_VERTICAL,
      });
    }
    if (prop.name === 'horizontal-swing') {
      return binaryFeature(prop, service, {
        category: CATEGORIES.AIR_CONDITIONING,
        type: TYPES.AIR_CONDITIONING.SWING_HORIZONTAL,
      });
    }
  }
  return null;
}

function resolveFanProperty(prop, service) {
  if (prop.name === 'fan-level' && prop.access.write) {
    if (prop.valueRange) {
      return numericFeature(prop, service, {
        category: CATEGORIES.FAN,
        type: TYPES.FAN.PERCENT,
        unit: UNITS.PERCENT,
        range: [0, 100],
        percentScale: true,
      });
    }
    if (prop.valueList.length > 0) {
      return baseFeature(prop, service, {
        category: CATEGORIES.FAN,
        type: TYPES.FAN.SPEED,
        min: Math.min(...prop.valueList.map((item) => Number(item.value))),
        max: Math.max(...prop.valueList.map((item) => Number(item.value))),
        supported_options: prop.valueList.map((item) => ({
          value: Number(item.value),
          label: item.description,
        })),
      });
    }
  }
  if (prop.name === 'mode' && prop.access.write) {
    const mapped = mapValueList(prop.valueList, FAN_MODE_NAMES);
    if (mapped) {
      return enumFeature(prop, service, { category: CATEGORIES.FAN, type: TYPES.FAN.MODE, mapped });
    }
  }
  return null;
}

function resolveVacuumProperty(prop, service) {
  if (prop.name === 'status' && !prop.access.write) {
    const mapped = mapValueList(prop.valueList, VACUUM_STATUS_NAMES, {
      required: [VACUUM_CLEANER_STATE.RUNNING],
    });
    if (mapped) {
      const feature = enumFeature(prop, service, {
        category: CATEGORIES.VACUUM_CLEANER,
        type: TYPES.VACUUM_CLEANER.STATE,
        mapped,
      });
      feature.read_only = true;
      return feature;
    }
  }
  return null;
}

/** `charging-state` is an enum everywhere, a boolean in Gladys. */
function resolveChargingState(prop, service) {
  if (prop.name !== 'charging-state' || prop.valueList.length === 0) {
    return null;
  }
  const charging = new Set(
    prop.valueList
      .filter((item) => item.name.includes('charging') && !item.name.startsWith('not_'))
      .map((item) => item.value),
  );
  return baseFeature(prop, service, {
    category: CATEGORIES.BATTERY,
    type: TYPES.BATTERY.CHARGING,
    min: 0,
    max: 1,
    read_only: true,
    fromMiot: (raw) => (charging.has(raw) ? 1 : 0),
  });
}

/** True when the spec item comes from a vendor namespace, not the standard. */
function isVendorSpecific(item, service) {
  return item.proprietary === true || isProprietary(service.urn);
}

/**
 * Resolve ONE property to a Gladys feature, or `null` when it has no
 * expressible equivalent.
 */
export function resolveProperty(prop, service, spec, { exposeUnmapped = false } = {}) {
  if (!prop.access.read && !prop.access.write && !prop.access.notify) {
    return null;
  }

  // 1. Service-aware rules.
  const serviceRules = [
    LIGHT_SERVICES.has(service.name) ? resolveLightProperty : null,
    COVER_SERVICES.has(service.name) ? resolveCoverProperty : null,
    AC_SERVICES.has(service.name) ||
    THERMOSTAT_SERVICES.has(service.name) ||
    WATER_HEATER_SERVICES.has(service.name) ||
    AC_SERVICES.has(spec.name) ||
    THERMOSTAT_SERVICES.has(spec.name)
      ? resolveClimateProperty
      : null,
    FAN_SERVICES.has(service.name) ? resolveFanProperty : null,
    VACUUM_SERVICES.has(service.name) || VACUUM_SERVICES.has(spec.name)
      ? resolveVacuumProperty
      : null,
  ].filter(Boolean);
  for (const rule of serviceRules) {
    const feature = rule(prop, service, spec);
    if (feature) {
      return feature;
    }
  }

  // 2. Property rules.
  const charging = resolveChargingState(prop, service);
  if (charging) {
    return charging;
  }
  const sensor = SENSOR_PROPS.get(prop.name);
  if (sensor && !prop.access.write) {
    return numericFeature(prop, service, {
      category: sensor.category,
      type: sensor.type,
      unit: toGladysUnit(prop.unit) ?? sensor.unit,
      range: sensor.range,
    });
  }
  const binary = BINARY_PROPS.get(prop.name);
  if (binary && !prop.access.write && (prop.format === 'bool' || isIntegerFormat(prop.format))) {
    return binaryFeature(prop, service, binary);
  }
  if (prop.name === 'on' && prop.format === 'bool' && prop.access.write) {
    const category = SIREN_SERVICES.has(service.name) ? CATEGORIES.SIREN : CATEGORIES.SWITCH;
    const type = category === CATEGORIES.SIREN ? TYPES.SIREN.BINARY : TYPES.SWITCH.BINARY;
    return binaryFeature(prop, service, { category, type });
  }
  if (prop.name === 'physical-controls-locked' && prop.format === 'bool') {
    return binaryFeature(prop, service, {
      category: CATEGORIES.CHILD_LOCK,
      type: TYPES.CHILD_LOCK.BINARY,
    });
  }

  // 3. Generic rules. A property carrying a VENDOR urn (outside the
  // `miot-spec-v2` namespace) that reached this point is a diagnostic or a
  // proprietary setting: exposing it by default buries the real features of
  // the device under dozens of cryptic ones, so it waits for the option.
  if (isVendorSpecific(prop, service) && !exposeUnmapped) {
    return null;
  }
  if (prop.access.write) {
    if (prop.format === 'bool') {
      return binaryFeature(prop, service, {
        category: CATEGORIES.SWITCH,
        type: TYPES.SWITCH.BINARY,
      });
    }
    if (prop.valueList.length > 0) {
      return textSelectFeature(prop, service);
    }
    if (prop.format === 'string') {
      return textFeature(prop, service);
    }
    // A writable number with no range has no safe Gladys representation.
    return null;
  }
  if (prop.valueList.length > 0 || prop.format === 'string') {
    return textFeature(prop, service);
  }
  if (!exposeUnmapped) {
    return null;
  }
  if (prop.format === 'bool') {
    return binaryFeature(prop, service, {
      category: CATEGORIES.UNKNOWN,
      type: TYPES.SENSOR.BINARY,
    });
  }
  return numericFeature(prop, service, {
    category: CATEGORIES.UNKNOWN,
    unit: toGladysUnit(prop.unit),
    range: [-1000000, 1000000],
  });
}

/** An argument-less action becomes a write-only command switch. */
function actionFeature(action, service) {
  return {
    key: `a_${service.iid}_${action.iid}`,
    name: action.description,
    serviceName: service.description,
    category: CATEGORIES.SWITCH,
    type: TYPES.SWITCH.BINARY,
    unit: null,
    min: 0,
    max: 1,
    step: null,
    read_only: false,
    // Fire and forget: the device does not report "the action ran".
    has_feedback: false,
    keep_history: false,
    supported_options: null,
    text: false,
    prop: null,
    action: { siid: service.iid, aiid: action.iid },
    events: null,
    fromMiot: toNumber,
    toMiot: identity,
  };
}

/** Events of one service, folded into button / doorbell / motion features. */
function eventFeatures(service, { hasMotionProperty }) {
  const features = [];
  const clicks = new Map();
  for (const event of service.events) {
    const code = BUTTON_EVENT_NAMES[event.name];
    if (code !== undefined) {
      clicks.set(event.iid, code);
    }
  }
  if (clicks.size > 0) {
    features.push({
      key: `e_${service.iid}_button`,
      name: `${service.description} button`,
      serviceName: service.description,
      category: CATEGORIES.BUTTON,
      type: TYPES.BUTTON.CLICK,
      unit: null,
      min: 0,
      max: 104,
      step: null,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      supported_options: null,
      text: false,
      prop: null,
      action: null,
      events: clicks,
      fromMiot: toNumber,
      toMiot: identity,
    });
  }
  const doorbell = service.events.find((event) => event.name === 'doorbell-ring');
  if (doorbell) {
    features.push({
      key: `e_${service.iid}_doorbell`,
      name: doorbell.description,
      serviceName: service.description,
      category: CATEGORIES.DOORBELL,
      type: TYPES.DOORBELL.RING,
      unit: null,
      min: 0,
      max: 1,
      step: null,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      supported_options: null,
      text: false,
      prop: null,
      action: null,
      events: new Map([[doorbell.iid, 1]]),
      fromMiot: toNumber,
      toMiot: identity,
    });
  }
  const motion = new Map();
  for (const event of service.events) {
    if (event.name === 'motion-detected') {
      motion.set(event.iid, 1);
    }
    if (event.name === 'no-motion') {
      motion.set(event.iid, 0);
    }
  }
  // A `motion-state` property already carries the information as a state.
  if (motion.size > 0 && !hasMotionProperty) {
    features.push({
      key: `e_${service.iid}_motion`,
      name: `${service.description} motion`,
      serviceName: service.description,
      category: CATEGORIES.MOTION_SENSOR,
      type: TYPES.SENSOR.BINARY,
      unit: null,
      min: 0,
      max: 1,
      step: null,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      supported_options: null,
      text: false,
      prop: null,
      action: null,
      events: motion,
      fromMiot: toNumber,
      toMiot: identity,
    });
  }
  return features;
}

/**
 * Every Gladys feature of a device spec.
 * @param {object} spec parsed MIoT instance
 * @param {{ exposeUnmapped?: boolean, exposeActions?: boolean }} options
 * @returns {Array<object>} mapped features (see the module header)
 */
export function buildFeatures(spec, { exposeUnmapped = false, exposeActions = true } = {}) {
  const features = [];
  const hasMotionProperty = spec.services.some((service) =>
    service.properties.some((prop) => prop.name === 'motion-state'),
  );
  for (const service of spec.services) {
    for (const prop of service.properties) {
      const feature = resolveProperty(prop, service, spec, { exposeUnmapped });
      if (feature) {
        features.push(feature);
      }
    }
    if (exposeActions) {
      for (const action of service.actions) {
        // Same rule as the properties: a vendor action is opt-in.
        if (action.in.length === 0 && (exposeUnmapped || !isVendorSpecific(action, service))) {
          features.push(actionFeature(action, service));
        }
      }
    }
    features.push(...eventFeatures(service, { hasMotionProperty }));
  }
  return dedupeNames(dropShadowedPositions(features));
}

/**
 * A cover exposes both `current-position` (read) and `target-position`
 * (write), which map onto the SAME Gladys feature type. Keeping both would
 * give the user two sliders, one of them inert: the writable one wins, and it
 * is readable anyway.
 */
function dropShadowedPositions(features) {
  const writable = new Set(
    features
      .filter((feature) => !feature.read_only && feature.type === TYPES.CURTAIN.POSITION)
      .map((feature) => feature.category),
  );
  return features.filter(
    (feature) =>
      !(
        feature.read_only &&
        feature.type === TYPES.CURTAIN.POSITION &&
        writable.has(feature.category)
      ),
  );
}

/**
 * Two services often expose the same property name ("Switch Status" on a
 * two-gang switch): prefix the duplicates with their service name so the user
 * can tell them apart.
 */
function dedupeNames(features) {
  const counts = new Map();
  for (const feature of features) {
    counts.set(feature.name, (counts.get(feature.name) ?? 0) + 1);
  }
  const used = new Set();
  for (const feature of features) {
    if (counts.get(feature.name) > 1) {
      feature.name = `${feature.serviceName} ${feature.name}`;
    }
    let name = feature.name;
    let index = 2;
    while (used.has(name)) {
      name = `${feature.name} ${index}`;
      index += 1;
    }
    feature.name = name;
    used.add(name);
    delete feature.serviceName;
  }
  return features;
}
