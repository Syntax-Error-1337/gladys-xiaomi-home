// -----------------------------------------------------------------------------
// Consistency between the manifest and the code. The store validates the
// manifest itself; what it cannot know is whether the form the user fills in
// matches what the integration actually implements.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, POLL_FREQUENCIES_SECONDS, normalizeConfig } from '../src/config.js';
import { CLOUD_SERVERS } from '../src/xiaomi/constants.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const field = (key) => manifest.config_schema.find((entry) => entry.key === key);

test('the defaults shown in the form are the ones the code applies', () => {
  for (const entry of manifest.config_schema) {
    if (entry.default !== undefined) {
      // A `select` field's default is a schema-mandated STRING even when the
      // code keeps the value as a number (poll_frequency): compare the
      // stringified form, so only a real mismatch fails this test.
      assert.equal(
        String(DEFAULT_CONFIG[entry.key]),
        String(entry.default),
        `DEFAULT_CONFIG.${entry.key} must match the manifest default`,
      );
    }
  }
});

test('every region offered in the form is a region the client can reach', () => {
  const offered = field('cloud_server').options.map((option) => option.value);
  assert.deepEqual(offered.sort(), Object.keys(CLOUD_SERVERS).sort());
  for (const region of offered) {
    assert.equal(normalizeConfig({ cloud_server: region }).cloud_server, region);
  }
});

test('an unknown region falls back instead of building an unreachable host', () => {
  assert.equal(
    normalizeConfig({ cloud_server: 'atlantis' }).cloud_server,
    DEFAULT_CONFIG.cloud_server,
  );
});

test('the refresh interval can only be a value Gladys accepts for poll_frequency', () => {
  // Gladys stores poll_frequency as a DB enum (60000, 30000, 15000, 10000,
  // 2000, 1000 ms): anything else is rejected by publishDiscoveredDevices
  // with "invalid poll frequency", so the manifest offers only those.
  const offered = field('poll_frequency').options.map((option) => Number(option.value));
  assert.deepEqual(
    offered.sort((a, b) => a - b),
    POLL_FREQUENCIES_SECONDS,
  );
  assert.equal(field('poll_frequency').type, 'select');
  assert.equal(
    normalizeConfig({ poll_frequency: 600 }).poll_frequency,
    DEFAULT_CONFIG.poll_frequency,
  );
  assert.equal(normalizeConfig({ poll_frequency: 15 }).poll_frequency, 15);
});

test('the account is linked through a button with no redirect back', () => {
  // Xiaomi only accepts its own registered redirect URI, so the standard
  // `oauth2` field (which hands Gladys the callback) cannot work here.
  assert.equal(field('xiaomi_account').type, 'account_link');
  assert.equal(field('xiaomi_account').default, undefined, 'account_link fields store no default');
});

test('the manifest declares only the transport the integration implements', () => {
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('section blocks stay presentational and store no value', () => {
  const sections = manifest.config_schema.filter((entry) => entry.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.ok(section.label.en);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});
