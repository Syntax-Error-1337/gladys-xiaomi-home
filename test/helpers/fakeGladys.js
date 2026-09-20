// -----------------------------------------------------------------------------
// In-memory stand-in for the Gladys SDK object and for the Xiaomi clients.
// It reproduces the only surface the integration relies on, so the tests run
// without a Gladys server and without touching the Xiaomi cloud.
// -----------------------------------------------------------------------------

export function createFakeGladys(config = {}) {
  const published = [];
  const discovered = [];
  const transports = [];
  const connectionStatuses = [];
  const stored = { ...config };

  return {
    published,
    discovered,
    transports,
    connectionStatuses,
    stored,

    externalIds(type, platformId) {
      const device = `ext:xiaomi:${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },
    async publishDiscoveredDevices(devices) {
      discovered.push(devices);
      return { success: true, count: devices.length };
    },
    async publishStates(states) {
      published.push(...states);
      return { success: true };
    },
    async publishTransports(entries) {
      transports.push(...entries);
      return { success: true };
    },
    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
      return { success: true };
    },
    async getConfig() {
      return { ...stored };
    },
    async setConfig(patch) {
      Object.assign(stored, patch);
      return { success: true };
    },
  };
}

/** Fake MiHome API: records the calls, answers canned values. */
export function createFakeApi({ devices = [], props = [] } = {}) {
  return {
    accessToken: 'token',
    calls: [],
    devices,
    props,
    setAccessToken(token) {
      this.accessToken = token;
    },
    async getDevices() {
      this.calls.push({ method: 'getDevices' });
      return this.devices;
    },
    async getProps(params) {
      this.calls.push({ method: 'getProps', params });
      return this.props;
    },
    async setProps(params) {
      this.calls.push({ method: 'setProps', params });
      return params.map((param) => ({ ...param, code: 0 }));
    },
    async action(params) {
      this.calls.push({ method: 'action', params });
      return [];
    },
  };
}

/** Fake MQTT client: exposes the sink so a test can inject a push message. */
export function createFakeMqtt() {
  const client = {
    connected: false,
    dids: [],
    onMessage: null,
    connect() {
      this.connected = true;
    },
    setDevices(dids) {
      this.dids = [...dids];
    },
    updateAccessToken() {},
    disconnect() {
      this.connected = false;
    },
  };
  return client;
}

/** Minimal MIoT spec instance, in the shape `SpecStore` returns. */
export function createSpec(services) {
  return {
    urn: 'urn:miot-spec-v2:device:light:0000A001:test-bulb:1',
    name: 'light',
    description: 'Test bulb',
    services,
  };
}

/** Helper building one spec property with sane defaults. */
export function createProperty(overrides) {
  return {
    iid: 1,
    urn: `urn:miot-spec-v2:property:${overrides.name ?? 'on'}:00000006:test:1`,
    name: 'on',
    description: 'Switch Status',
    format: 'bool',
    access: { read: true, write: true, notify: true },
    unit: null,
    valueRange: null,
    valueList: [],
    proprietary: false,
    ...overrides,
  };
}

/** Helper building one spec service with sane defaults. */
export function createService(overrides) {
  return {
    iid: 2,
    urn: 'urn:miot-spec-v2:service:light:00007802:test:1',
    name: 'light',
    description: 'Light',
    properties: [],
    actions: [],
    events: [],
    ...overrides,
  };
}
