// -----------------------------------------------------------------------------
// Enumerated Gladys feature values.
//
// Mirror of the enums of the Gladys core (`server/utils/constants.js`): the SDK
// exports the categories, the types and the units, but not the VALUES an
// enum-like feature accepts. They are reproduced here so the mapping never
// publishes a number Gladys cannot interpret.
// -----------------------------------------------------------------------------

/** curtain / shutter `state`. */
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };

/** air-conditioning `mode`. */
export const AC_MODE = { AUTO: 0, COOLING: 1, HEATING: 2, DRYING: 3, FAN: 4 };

/** air-conditioning `fan-speed`. */
export const AC_FAN_SPEED = {
  AUTO: 0,
  LOW: 1,
  LOW_MID: 2,
  MID: 3,
  MID_HIGH: 4,
  HIGH: 5,
  QUIET: 6,
  TURBO: 7,
};

// air-conditioning `swing-horizontal` / `swing-vertical` are plain booleans in
// Gladys (0 = off, 1 = swinging), so a MIoT bool swing maps straight onto them.

/** thermostat `mode`. */
export const THERMOSTAT_MODE = { OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 };

/** fan `mode`. */
export const FAN_MODE = { OFF: 0, LOW: 1, MEDIUM: 2, HIGH: 3, AUTO: 4 };

/** vacuum-cleaner `state`. */
export const VACUUM_CLEANER_STATE = {
  STOPPED: 0,
  RUNNING: 1,
  PAUSED: 2,
  ERROR: 3,
  RETURNING_TO_DOCK: 4,
  CHARGING: 5,
  DOCKED: 6,
};

/** button `click` codes. */
export const BUTTON_STATUS = {
  CLICK: 1,
  DOUBLE_CLICK: 2,
  LONG_CLICK_PRESS: 3,
  LONG_CLICK_RELEASE: 4,
  LONG_CLICK: 6,
  TRIPLE: 18,
  SHAKE: 22,
  ROTATE_LEFT: 30,
  ROTATE_RIGHT: 31,
};
