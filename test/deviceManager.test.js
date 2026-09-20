// -----------------------------------------------------------------------------
// End-to-end behaviour of the manager, with the Xiaomi cloud replaced by fakes:
// discovery payload, commands, polling and push.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { XiaomiHomeManager } from '../src/deviceManager.js';
import { AUTH_KEYS } from '../src/config.js';
import { XiaomiHttpError } from '../src/xiaomi/httpUtils.js';
import {
  createFakeApi,
  createFakeGladys,
  createFakeMqtt,
  createProperty,
  createService,
} from './helpers/fakeGladys.js';

const LAMP = {
  did: '100',
  name: 'Bedroom lamp',
  model: 'yeelink.light.lamp4',
  urn: 'urn:miot-spec-v2:device:light:0000A001:test:1',
  manufacturer: 'yeelink',
  online: true,
  firmware: '1.0.0',
  localIp: null,
  parentId: null,
  room: 'Bedroom',
  home: 'Home',
};

const SPEC = {
  urn: LAMP.urn,
  name: 'light',
  description: 'Lamp',
  services: [
    createService({
      iid: 2,
      properties: [
        createProperty({ iid: 1, name: 'on', description: 'Power' }),
        createProperty({
          iid: 2,
          name: 'brightness',
          description: 'Brightness',
          format: 'uint8',
          valueRange: { min: 0, max: 200, step: 1 },
        }),
      ],
    }),
  ],
};

const CONFIG = {
  cloud_server: 'de',
  poll_frequency: 15,
  [AUTH_KEYS.accessToken]: 'access',
  [AUTH_KEYS.refreshToken]: 'refresh',
  [AUTH_KEYS.expiresTs]: Math.floor(Date.now() / 1000) + 86400,
  [AUTH_KEYS.instanceId]: '0123456789abcdef0123456789abcdef',
};

function setup({ devices = [LAMP], props = [], spec = SPEC } = {}) {
  const gladys = createFakeGladys(CONFIG);
  const api = createFakeApi({ devices, props });
  const mqtt = createFakeMqtt();
  const manager = new XiaomiHomeManager(gladys, {
    specStore: {
      async get() {
        return spec;
      },
    },
    createApi: () => api,
    createMqtt: (options) => {
      mqtt.onMessage = options.onMessage;
      return mqtt;
    },
  });
  manager.applyConfig(CONFIG);
  return { gladys, api, mqtt, manager };
}

test('the discovery payload describes the Xiaomi device and its features', async () => {
  const { manager } = setup();
  await manager.loadDevices();

  const [device] = manager.buildDiscoveredDevices();
  assert.equal(device.name, 'Bedroom lamp');
  assert.equal(device.external_id, 'ext:xiaomi:miot:100');
  // Polling is configured in seconds, Gladys schedules in milliseconds.
  assert.equal(device.poll_frequency, 15000);
  assert.equal(device.params.find((param) => param.name === 'room').value, 'Bedroom');
  assert.deepEqual(
    device.features.map((feature) => feature.external_id),
    ['ext:xiaomi:miot:100:p_2_1', 'ext:xiaomi:miot:100:p_2_2'],
  );
});

test('an offline device is badged unreachable', async () => {
  const { manager } = setup({ devices: [{ ...LAMP, online: false }] });
  await manager.loadDevices();

  assert.deepEqual(manager.buildTransportEntries(), [
    { external_id: 'ext:xiaomi:miot:100', transport: DEVICE_TRANSPORTS.UNREACHABLE },
  ]);
});

test('a device whose spec cannot be fetched is skipped, the others are kept', async () => {
  const gladys = createFakeGladys(CONFIG);
  const manager = new XiaomiHomeManager(gladys, {
    specStore: {
      async get(urn) {
        if (urn === 'urn:broken') {
          throw new Error('404');
        }
        return SPEC;
      },
    },
    createApi: () => createFakeApi({ devices: [{ ...LAMP, did: '1', urn: 'urn:broken' }, LAMP] }),
    createMqtt: () => createFakeMqtt(),
  });
  manager.applyConfig(CONFIG);

  assert.equal(await manager.loadDevices(), 1);
  assert.equal(manager.buildDiscoveredDevices()[0].external_id, 'ext:xiaomi:miot:100');
});

test('polling publishes the converted states of every readable property', async () => {
  const { gladys, manager, api } = setup({
    props: [
      { did: '100', siid: 2, piid: 1, value: true, code: 0 },
      { did: '100', siid: 2, piid: 2, value: 100, code: 0 },
    ],
  });
  await manager.loadDevices();
  await manager.poll({ external_id: 'ext:xiaomi:miot:100' });

  assert.deepEqual(api.calls.at(-1).params, [
    { did: '100', siid: 2, piid: 1 },
    { did: '100', siid: 2, piid: 2 },
  ]);
  assert.deepEqual(gladys.published, [
    { device_feature_external_id: 'ext:xiaomi:miot:100:p_2_1', state: 1 },
    // 100 on a 0-200 device range is 50 %.
    { device_feature_external_id: 'ext:xiaomi:miot:100:p_2_2', state: 50 },
  ]);
});

test('a command is converted to the device scale and confirmed in Gladys', async () => {
  const { gladys, manager, api } = setup();
  await manager.loadDevices();

  await manager.setValue(
    { external_id: 'ext:xiaomi:miot:100' },
    { external_id: 'ext:xiaomi:miot:100:p_2_2' },
    25,
  );

  assert.deepEqual(api.calls.at(-1), {
    method: 'setProps',
    params: [{ did: '100', siid: 2, piid: 2, value: 50 }],
  });
  assert.deepEqual(gladys.published, [
    { device_feature_external_id: 'ext:xiaomi:miot:100:p_2_2', state: 25 },
  ]);
});

test('a command on an unknown feature fails loudly', async () => {
  const { manager } = setup();
  await manager.loadDevices();

  await assert.rejects(
    manager.setValue({ external_id: 'x' }, { external_id: 'ext:xiaomi:miot:100:p_9_9' }, 1),
    /unknown feature/,
  );
});

test('an action feature triggers the MIoT action instead of writing a property', async () => {
  const spec = {
    ...SPEC,
    services: [
      createService({
        iid: 3,
        actions: [
          {
            iid: 1,
            urn: 'urn:miot-spec-v2:action:toggle:1:test:1',
            name: 'toggle',
            description: 'Toggle',
            in: [],
          },
        ],
      }),
    ],
  };
  const { manager, api } = setup({ spec });
  await manager.loadDevices();

  await manager.setValue(
    { external_id: 'ext:xiaomi:miot:100' },
    { external_id: 'ext:xiaomi:miot:100:a_3_1' },
    1,
  );

  assert.deepEqual(api.calls.at(-1), {
    method: 'action',
    params: { did: '100', siid: 3, aiid: 1, args: [] },
  });
});

test('a pushed property change is published without polling', async () => {
  const { gladys, manager, mqtt } = setup();
  await manager.loadDevices();
  manager.startPush();

  mqtt.onMessage({ type: 'property', did: '100', siid: 2, piid: 1, value: true });
  await new Promise(setImmediate);

  assert.deepEqual(gladys.published, [
    { device_feature_external_id: 'ext:xiaomi:miot:100:p_2_1', state: 1 },
  ]);
  assert.deepEqual(mqtt.dids, ['100']);
});

test('a pushed offline transition updates the transport badge', async () => {
  const { gladys, manager, mqtt } = setup();
  await manager.loadDevices();
  manager.startPush();

  mqtt.onMessage({ type: 'state', did: '100', online: false });
  await new Promise(setImmediate);

  assert.deepEqual(gladys.transports, [
    { external_id: 'ext:xiaomi:miot:100', transport: DEVICE_TRANSPORTS.UNREACHABLE },
  ]);
});

test('an expired token is refreshed once and the call is retried', async () => {
  const { manager, api, gladys } = setup();
  await manager.loadDevices();

  let attempts = 0;
  api.getProps = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new XiaomiHttpError('unauthorized', { status: 401 });
    }
    return [{ did: '100', siid: 2, piid: 1, value: true, code: 0 }];
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        result: { access_token: 'access2', refresh_token: 'refresh2', expires_in: 3600 },
      }),
      { status: 200 },
    );
  try {
    await manager.poll({ external_id: 'ext:xiaomi:miot:100' });
  } finally {
    globalThis.fetch = originalFetch;
    manager.stop();
  }

  assert.equal(attempts, 2);
  assert.equal(gladys.stored[AUTH_KEYS.accessToken], 'access2');
  assert.deepEqual(gladys.published, [
    { device_feature_external_id: 'ext:xiaomi:miot:100:p_2_1', state: 1 },
  ]);
});
