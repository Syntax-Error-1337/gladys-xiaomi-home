// -----------------------------------------------------------------------------
// MIoT-Spec-V2 unit -> Gladys unit.
//
// The spec unit vocabulary is loose (the same unit is spelled `watt`, `w` or
// `W` depending on the vendor), so the table normalizes the spellings seen in
// the wild. An unknown unit maps to `null`: Gladys then shows a raw number,
// which is better than a rejected feature.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_UNITS as UNITS } from '@gladysassistant/integration-sdk';

const UNIT_MAP = new Map(
  Object.entries({
    percentage: UNITS.PERCENT,
    percent: UNITS.PERCENT,
    '%': UNITS.PERCENT,
    celsius: UNITS.CELSIUS,
    '℃': UNITS.CELSIUS,
    fahrenheit: UNITS.FAHRENHEIT,
    kelvin: UNITS.KELVIN,
    k: UNITS.KELVIN,
    lux: UNITS.LUX,
    lx: UNITS.LUX,
    ppm: UNITS.PPM,
    ppb: UNITS.PPB,
    'mg/m3': UNITS.MILLIGRAM_PER_CUBIC_METER,
    'μg/m3': UNITS.MICROGRAM_PER_CUBIC_METER,
    'ug/m3': UNITS.MICROGRAM_PER_CUBIC_METER,
    pascal: UNITS.PASCAL,
    pa: UNITS.PASCAL,
    kilopascal: UNITS.KILO_PASCAL,
    kpa: UNITS.KILO_PASCAL,
    hectopascal: UNITS.HECTO_PASCAL,
    hpa: UNITS.HECTO_PASCAL,
    bar: UNITS.BAR,
    watt: UNITS.WATT,
    w: UNITS.WATT,
    kilowatt: UNITS.KILOWATT,
    kw: UNITS.KILOWATT,
    'w/h': UNITS.WATT_HOUR,
    wh: UNITS.WATT_HOUR,
    'watt-hour': UNITS.WATT_HOUR,
    kwh: UNITS.KILOWATT_HOUR,
    'kw/h': UNITS.KILOWATT_HOUR,
    ampere: UNITS.AMPERE,
    a: UNITS.AMPERE,
    ma: UNITS.MILLI_AMPERE,
    volt: UNITS.VOLT,
    v: UNITS.VOLT,
    mv: UNITS.MILLI_VOLT,
    millimeter: UNITS.MM,
    mm: UNITS.MM,
    centimeter: UNITS.CM,
    cm: UNITS.CM,
    meter: UNITS.M,
    m: UNITS.M,
    kilometer: UNITS.KM,
    km: UNITS.KM,
    liter: UNITS.LITER,
    l: UNITS.LITER,
    ml: UNITS.MILLILITER,
    m3: UNITS.CUBIC_METER,
    arcdegrees: UNITS.DEGREE,
    degree: UNITS.DEGREE,
    db: UNITS.DECIBEL,
    decibel: UNITS.DECIBEL,
    seconds: UNITS.SECONDS,
    second: UNITS.SECONDS,
    s: UNITS.SECONDS,
    minutes: UNITS.MINUTES,
    minute: UNITS.MINUTES,
    min: UNITS.MINUTES,
    hours: UNITS.HOURS,
    hour: UNITS.HOURS,
    h: UNITS.HOURS,
    days: UNITS.DAYS,
    day: UNITS.DAYS,
    ph: UNITS.PH,
    'km/h': UNITS.KILOMETER_PER_HOUR,
    'm/s': UNITS.METER_PER_SECOND,
  }),
);

/**
 * Gladys unit of a MIoT unit, or `null` when there is no equivalent.
 * @param {string | null} miotUnit
 */
export function toGladysUnit(miotUnit) {
  if (!miotUnit) {
    return null;
  }
  return UNIT_MAP.get(String(miotUnit).trim().toLowerCase()) ?? null;
}
