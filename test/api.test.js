// -----------------------------------------------------------------------------
// The MiHome HTTP client: request shapes and error semantics.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MiHomeApi, normalizeDevice } from '../src/xiaomi/api.js';
import { OAUTH2_CLIENT_ID } from '../src/xiaomi/constants.js';

/** Replace global fetch with a recorder answering canned envelopes. */
function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const call = {
      url: new URL(url),
      options,
      body: options?.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    const answer = handler(call);
    return new Response(JSON.stringify(answer.body ?? { code: 0, result: {} }), {
      status: answer.status ?? 200,
    });
  };
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

const api = () => new MiHomeApi({ cloudServer: 'cn', accessToken: 'TOKEN' });

test('requests carry the bearer token in the format Xiaomi expects', async () => {
  await withFetch(
    () => ({ body: { code: 0, result: [] } }),
    async (calls) => {
      await api().getProps([{ did: '1', siid: 2, piid: 1 }]);
      const { options, url } = calls[0];
      assert.equal(url.host, 'ha.api.io.mi.com');
      // No space after `Bearer`: the server rejects the standard spelling.
      assert.equal(options.headers.Authorization, 'BearerTOKEN');
      assert.equal(options.headers['X-Client-BizId'], 'haapi');
      assert.equal(options.headers['X-Client-AppId'], OAUTH2_CLIENT_ID);
    },
  );
});

test('reads are split in batches of 150 properties', async () => {
  const props = Array.from({ length: 320 }, (_, index) => ({ did: 'd', siid: 1, piid: index }));
  await withFetch(
    (call) => ({
      body: { code: 0, result: call.body.params.map((param) => ({ ...param, value: 1, code: 0 })) },
    }),
    async (calls) => {
      const results = await api().getProps(props);
      assert.deepEqual(
        calls.map((call) => call.body.params.length),
        [150, 150, 20],
      );
      assert.equal(results.length, 320);
    },
  );
});

test('a property the device could not read is dropped, not published as garbage', async () => {
  await withFetch(
    () => ({
      body: {
        code: 0,
        result: [
          { did: 'd', siid: 2, piid: 1, value: 42, code: 0 },
          { did: 'd', siid: 2, piid: 2, code: -4003 },
        ],
      },
    }),
    async () => {
      const results = await api().getProps([{ did: 'd', siid: 2, piid: 1 }]);
      assert.deepEqual(results, [{ did: 'd', siid: 2, piid: 1, value: 42, code: 0 }]);
    },
  );
});

test('an action sends bare input values, as this API expects', async () => {
  await withFetch(
    () => ({ body: { code: 0, result: { did: 'd', siid: 4, aiid: 1, code: 0, out: [] } } }),
    async (calls) => {
      await api().action({ did: 'd', siid: 4, aiid: 1, args: ['hello'] });
      assert.deepEqual(calls[0].body, { params: { did: 'd', siid: 4, aiid: 1, in: ['hello'] } });
    },
  );
});

test('a refused command rejects so Gladys marks it failed', async () => {
  await withFetch(
    () => ({ body: { code: 0, result: [{ did: 'd', siid: 2, piid: 1, code: -704010000 }] } }),
    async () => {
      await assert.rejects(
        api().setProps([{ did: 'd', siid: 2, piid: 1, value: true }]),
        /unavailable/,
      );
    },
  );
});

test('an expired token surfaces as an authentication error', async () => {
  await withFetch(
    () => ({ status: 401, body: {} }),
    async () => {
      await assert.rejects(api().getProps([{ did: 'd', siid: 1, piid: 1 }]), /unauthorized/);
    },
  );
});

test('the device list is paged and enriched with the room name', async () => {
  let page = 0;
  await withFetch(
    (call) => {
      if (call.url.pathname.endsWith('gethome')) {
        return {
          body: {
            code: 0,
            result: {
              homelist: [
                {
                  id: '1',
                  name: 'Home',
                  uid: 42,
                  dids: ['a'],
                  roomlist: [{ id: '10', name: 'Kitchen', dids: ['b'] }],
                },
              ],
            },
          },
        };
      }
      page += 1;
      return page === 1
        ? {
            body: {
              code: 0,
              result: {
                list: [
                  {
                    did: 'a',
                    name: 'Lamp',
                    model: 'yeelink.light.lamp4',
                    spec_type: 'urn:a',
                    isOnline: true,
                  },
                ],
                has_more: true,
                next_start_did: 'a',
              },
            },
          }
        : {
            body: {
              code: 0,
              result: {
                list: [
                  {
                    did: 'b',
                    name: 'Plug',
                    model: 'cuco.plug.v3',
                    spec_type: 'urn:b',
                    isOnline: false,
                  },
                ],
                has_more: false,
              },
            },
          };
    },
    async () => {
      const devices = await api().getDevices();
      assert.deepEqual(
        devices.map((device) => [device.did, device.name, device.online, device.room]),
        [
          ['a', 'Lamp', true, null],
          ['b', 'Plug', false, 'Kitchen'],
        ],
      );
    },
  );
});

test('devices this API cannot drive are filtered out of the catalog', () => {
  assert.equal(
    normalizeDevice({
      did: 'miwifi.1',
      name: 'Router',
      model: 'xiaomi.router',
      spec_type: 'urn:x',
    }),
    null,
  );
  assert.equal(
    normalizeDevice({ did: '1', name: 'IR', model: 'chuangmi.ir.v2', spec_type: 'urn:x' }),
    null,
    'models known not to work must not be published',
  );
  assert.equal(normalizeDevice({ did: '1', name: 'No spec', model: 'a.b.c' }), null);
  assert.equal(
    normalizeDevice({
      did: 1,
      name: ' Lamp ',
      model: 'yeelink.light.lamp4',
      spec_type: 'urn:x',
      isOnline: true,
    }).name,
    'Lamp',
  );
});
