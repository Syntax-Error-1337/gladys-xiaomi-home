// -----------------------------------------------------------------------------
// The spec -> feature mapping: what the user actually sees in Gladys.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { buildFeatures } from '../src/mapping/features.js';
import { COVER_STATE, VACUUM_CLEANER_STATE } from '../src/mapping/gladysValues.js';
import { createProperty, createService, createSpec } from './helpers/fakeGladys.js';

const find = (features, key) => features.find((feature) => feature.key === key);

test('a light service exposes on/off, brightness and color temperature', () => {
  const spec = createSpec([
    createService({
      properties: [
        createProperty({ iid: 1, name: 'on', description: 'Power' }),
        createProperty({
          iid: 2,
          name: 'brightness',
          description: 'Brightness',
          format: 'uint8',
          unit: 'percentage',
          valueRange: { min: 1, max: 100, step: 1 },
        }),
        createProperty({
          iid: 3,
          name: 'color-temperature',
          description: 'Color Temperature',
          format: 'uint32',
          unit: 'kelvin',
          valueRange: { min: 2700, max: 6500, step: 1 },
        }),
      ],
    }),
  ]);

  const features = buildFeatures(spec);
  const power = find(features, 'p_2_1');
  assert.equal(power.category, CATEGORIES.LIGHT);
  assert.equal(power.type, TYPES.LIGHT.BINARY);
  assert.equal(power.read_only, false);

  const brightness = find(features, 'p_2_2');
  assert.equal(brightness.type, TYPES.LIGHT.BRIGHTNESS);
  assert.equal(brightness.unit, UNITS.PERCENT);
  assert.deepEqual([brightness.min, brightness.max], [0, 100]);

  const temperature = find(features, 'p_2_3');
  assert.equal(temperature.type, TYPES.LIGHT.TEMPERATURE);
  // The Kelvin bounds of THIS bulb travel with the feature.
  assert.deepEqual([temperature.min, temperature.max], [2700, 6500]);
});

test('brightness is rescaled between the device range and percent', () => {
  const spec = createSpec([
    createService({
      properties: [
        createProperty({
          iid: 2,
          name: 'brightness',
          description: 'Brightness',
          format: 'uint8',
          valueRange: { min: 0, max: 255, step: 1 },
        }),
      ],
    }),
  ]);
  const brightness = find(buildFeatures(spec), 'p_2_2');

  assert.equal(brightness.fromMiot(255), 100);
  assert.equal(brightness.fromMiot(0), 0);
  assert.equal(brightness.toMiot(100), 255);
  assert.equal(brightness.toMiot(0), 0);
  // Round trip: a 50 % command comes back as 50 %.
  assert.equal(brightness.fromMiot(brightness.toMiot(50)), 50);
});

test('a contact sensor keeps the Gladys opening convention (closed = 1)', () => {
  const spec = createSpec([
    createService({
      iid: 2,
      name: 'magnet-sensor',
      description: 'Magnet Sensor',
      properties: [
        createProperty({
          iid: 1,
          name: 'contact-state',
          description: 'Contact State',
          format: 'bool',
          access: { read: true, write: false, notify: true },
        }),
      ],
    }),
  ]);
  const contact = find(buildFeatures(spec), 'p_2_1');

  assert.equal(contact.category, CATEGORIES.OPENING_SENSOR);
  assert.equal(contact.read_only, true);
  assert.equal(contact.fromMiot(true), 1);
  assert.equal(contact.fromMiot(false), 0);
});

test('a curtain motor-control becomes a cover state, ignoring vendor extras', () => {
  const spec = createSpec([
    createService({
      iid: 2,
      name: 'curtain',
      description: 'Curtain',
      properties: [
        createProperty({
          iid: 2,
          name: 'motor-control',
          description: 'Motor Control',
          format: 'uint8',
          access: { read: false, write: true, notify: false },
          valueList: [
            { value: 0, name: 'pause', description: 'Pause' },
            { value: 1, name: 'open', description: 'Open' },
            { value: 2, name: 'close', description: 'Close' },
            { value: 3, name: 'auto', description: 'Auto' },
          ],
        }),
      ],
    }),
  ]);
  const control = find(buildFeatures(spec), 'p_2_2');

  assert.equal(control.category, CATEGORIES.CURTAIN);
  assert.equal(control.type, TYPES.CURTAIN.STATE);
  assert.equal(control.toMiot(COVER_STATE.OPEN), 1);
  assert.equal(control.toMiot(COVER_STATE.CLOSE), 2);
  assert.equal(control.toMiot(COVER_STATE.STOP), 0);
  // `auto` has no Gladys equivalent and must not reach the options.
  assert.deepEqual(
    control.supported_options.map((option) => option.value).sort(),
    [COVER_STATE.CLOSE, COVER_STATE.STOP, COVER_STATE.OPEN].sort(),
  );
});

test('a cover keeps only the writable position', () => {
  const spec = createSpec([
    createService({
      iid: 2,
      name: 'curtain',
      description: 'Curtain',
      properties: [
        createProperty({
          iid: 3,
          name: 'current-position',
          description: 'Current Position',
          format: 'uint8',
          access: { read: true, write: false, notify: true },
          valueRange: { min: 0, max: 100, step: 1 },
        }),
        createProperty({
          iid: 7,
          name: 'target-position',
          description: 'Target Position',
          format: 'uint8',
          access: { read: true, write: true, notify: true },
          valueRange: { min: 0, max: 100, step: 1 },
        }),
      ],
    }),
  ]);
  const positions = buildFeatures(spec).filter(
    (feature) => feature.type === TYPES.CURTAIN.POSITION,
  );

  assert.equal(positions.length, 1);
  assert.equal(positions[0].key, 'p_2_7');
  assert.equal(positions[0].read_only, false);
});

test('an enum with no Gladys equivalent becomes a text select, not a lost property', () => {
  const spec = createSpec([
    createService({
      properties: [
        createProperty({
          iid: 4,
          name: 'mode',
          description: 'Mode',
          format: 'uint8',
          valueList: [
            { value: 0, name: 'reading', description: 'Reading' },
            { value: 1, name: 'candle', description: 'Candle' },
          ],
        }),
      ],
    }),
  ]);
  const mode = find(buildFeatures(spec), 'p_2_4');

  assert.equal(mode.category, CATEGORIES.TEXT);
  assert.equal(mode.type, TYPES.TEXT.SELECT);
  assert.equal(mode.text, true);
  assert.deepEqual(mode.supported_options, [
    { value: 'reading', label: 'Reading' },
    { value: 'candle', label: 'Candle' },
  ]);
  assert.equal(mode.toMiot('candle'), 1);
  assert.equal(mode.fromMiot(0), 'reading');
});

test('a vacuum status becomes the Gladys vacuum state', () => {
  const spec = {
    urn: 'urn:miot-spec-v2:device:vacuum:0000A006:test:1',
    name: 'vacuum',
    description: 'Robot',
    services: [
      createService({
        iid: 2,
        name: 'vacuum',
        description: 'Robot Cleaner',
        properties: [
          createProperty({
            iid: 1,
            name: 'status',
            description: 'Status',
            format: 'uint8',
            access: { read: true, write: false, notify: true },
            valueList: [
              { value: 1, name: 'sweeping', description: 'Sweeping' },
              { value: 2, name: 'idle', description: 'Idle' },
              { value: 5, name: 'charging', description: 'Charging' },
              { value: 9, name: 'upgrading', description: 'Upgrading' },
            ],
          }),
        ],
      }),
    ],
  };
  const status = find(buildFeatures(spec), 'p_2_1');

  assert.equal(status.category, CATEGORIES.VACUUM_CLEANER);
  assert.equal(status.type, TYPES.VACUUM_CLEANER.STATE);
  assert.equal(status.read_only, true);
  assert.equal(status.fromMiot(1), VACUUM_CLEANER_STATE.RUNNING);
  assert.equal(status.fromMiot(5), VACUUM_CLEANER_STATE.CHARGING);
  // An unknown vendor state publishes nothing rather than a wrong state.
  assert.equal(status.fromMiot(9), null);
});

test('vendor properties stay hidden unless the user asks for them', () => {
  const spec = createSpec([
    createService({
      iid: 5,
      name: 'custom-service',
      description: 'Custom',
      properties: [
        createProperty({
          iid: 1,
          name: 'rfid-tag-id',
          description: 'RFID counter',
          format: 'uint32',
          access: { read: true, write: false, notify: false },
        }),
      ],
    }),
  ]);

  assert.equal(buildFeatures(spec).length, 0);
  const exposed = buildFeatures(spec, { exposeUnmapped: true });
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].category, CATEGORIES.UNKNOWN);
});

test('vendor-namespace properties and actions are opt-in too', () => {
  const spec = createSpec([
    createService({
      iid: 6,
      urn: 'urn:xiaomi-spec:service:custom:00000001:test:1',
      name: 'custom',
      description: 'Vendor',
      properties: [
        createProperty({
          iid: 1,
          urn: 'urn:xiaomi-spec:property:cola:00000001:test:1',
          name: 'cola',
          description: 'Vendor blob',
          format: 'string',
          access: { read: true, write: true, notify: false },
          proprietary: true,
        }),
      ],
      actions: [
        {
          iid: 1,
          urn: 'urn:xiaomi-spec:action:debug:00000001:test:1',
          name: 'debug',
          description: 'Vendor debug',
          in: [],
          proprietary: true,
        },
      ],
    }),
  ]);

  assert.equal(buildFeatures(spec).length, 0, 'a device is not buried under vendor diagnostics');
  assert.equal(buildFeatures(spec, { exposeUnmapped: true }).length, 2);
});

test('argument-less actions become command switches, actions with arguments are skipped', () => {
  const spec = createSpec([
    createService({
      iid: 3,
      name: 'vacuum',
      description: 'Robot',
      actions: [
        {
          iid: 1,
          urn: 'urn:miot-spec-v2:action:start-sweep:1:test:1',
          name: 'start-sweep',
          description: 'Start',
          in: [],
        },
        {
          iid: 2,
          urn: 'urn:miot-spec-v2:action:say:2:test:1',
          name: 'say',
          description: 'Say',
          in: [1],
        },
      ],
    }),
  ]);
  const features = buildFeatures(spec);

  assert.equal(features.length, 1);
  assert.equal(features[0].key, 'a_3_1');
  assert.equal(features[0].read_only, false);
  assert.equal(features[0].has_feedback, false);
  assert.deepEqual(features[0].action, { siid: 3, aiid: 1 });

  assert.equal(buildFeatures(spec, { exposeActions: false }).length, 0);
});

test('button events are folded into one button feature carrying the click codes', () => {
  const spec = createSpec([
    createService({
      iid: 4,
      name: 'switch',
      description: 'Button',
      events: [
        {
          iid: 1,
          urn: 'urn:miot-spec-v2:event:click:1:test:1',
          name: 'click',
          description: 'Click',
          arguments: [],
        },
        {
          iid: 2,
          urn: 'urn:miot-spec-v2:event:double-click:2:test:1',
          name: 'double-click',
          description: 'Double Click',
          arguments: [],
        },
      ],
    }),
  ]);
  const features = buildFeatures(spec);

  assert.equal(features.length, 1);
  assert.equal(features[0].category, CATEGORIES.BUTTON);
  assert.equal(features[0].type, TYPES.BUTTON.CLICK);
  assert.deepEqual(
    [...features[0].events.entries()],
    [
      [1, 1],
      [2, 2],
    ],
  );
});

test('features of two identical services get distinguishable names', () => {
  const twoGang = [1, 2].map((index) =>
    createService({
      iid: index + 1,
      name: 'switch',
      description: `Switch ${index}`,
      properties: [createProperty({ iid: 1, name: 'on', description: 'Switch Status' })],
    }),
  );
  const names = buildFeatures({ ...createSpec(twoGang), name: 'switch' }).map(
    (feature) => feature.name,
  );

  assert.equal(new Set(names).size, names.length);
});
