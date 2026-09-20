// -----------------------------------------------------------------------------
// The push channel decoder: what arrives on the wire, and what it means.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMessage, topicsForDevice } from '../src/xiaomi/mqtt.js';

const encode = (object) => Buffer.from(JSON.stringify(object), 'utf8');

test('a device is followed on its property, event and state topics', () => {
  assert.deepEqual(topicsForDevice('123'), [
    'device/123/up/properties_changed/#',
    // Xiaomi's own typo, on the wire since day one.
    'device/123/up/event_occured/#',
    'device/123/state/#',
  ]);
});

test('a property change is decoded with its instance ids', () => {
  const decoded = decodeMessage(
    'device/123/up/properties_changed/2/1',
    encode({ params: { did: '123', siid: 2, piid: 1, value: true } }),
  );
  assert.deepEqual(decoded, { type: 'property', did: '123', siid: 2, piid: 1, value: true });
});

test('an event is decoded with its arguments', () => {
  const decoded = decodeMessage(
    'device/123/up/event_occured/5/1',
    encode({ params: { did: '123', siid: 5, eiid: 1, arguments: [{ piid: 1, value: 3 }] } }),
  );
  assert.deepEqual(decoded, {
    type: 'event',
    did: '123',
    siid: 5,
    eiid: 1,
    arguments: [{ piid: 1, value: 3 }],
  });
});

test('the online/offline topic drives the reachability of the device', () => {
  assert.deepEqual(
    decodeMessage('device/123/state/online', encode({ device_id: '123', event: 'online' })),
    {
      type: 'state',
      did: '123',
      online: true,
    },
  );
  assert.deepEqual(
    decodeMessage('device/123/state/offline', encode({ device_id: '123', event: 'offline' })),
    {
      type: 'state',
      did: '123',
      online: false,
    },
  );
});

test('a message about another device is ignored', () => {
  assert.equal(
    decodeMessage('device/123/state/online', encode({ device_id: '999', event: 'online' })),
    null,
  );
});

test('malformed payloads never crash the client', () => {
  assert.equal(
    decodeMessage('device/123/up/properties_changed/2/1', Buffer.from('not json')),
    null,
  );
  assert.equal(
    decodeMessage('device/123/up/properties_changed/2/1', encode({ params: { siid: 2 } })),
    null,
  );
  assert.equal(decodeMessage('something/else', encode({ params: {} })), null);
});
