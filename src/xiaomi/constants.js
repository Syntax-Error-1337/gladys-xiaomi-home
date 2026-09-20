// -----------------------------------------------------------------------------
// Constants of the Xiaomi Home (MIoT) cloud protocol.
//
// Every value here is the one used by the official Xiaomi Home integration for
// Home Assistant (github.com/XiaoMi/ha_xiaomi_home), which is the reference
// implementation of this "haapi" surface of the Xiaomi cloud.
// -----------------------------------------------------------------------------

/** OAuth 2.0 client id of the Xiaomi Home integration surface. */
export const OAUTH2_CLIENT_ID = '2882303761520251711';

/** Xiaomi account authorization endpoint (region independent). */
export const OAUTH2_AUTH_URL = 'https://account.xiaomi.com/oauth2/authorize';

/**
 * Redirect URI registered at Xiaomi for OAUTH2_CLIENT_ID. Xiaomi validates the
 * origin, so it CANNOT be replaced by a Gladys URL: the browser lands on a page
 * that does not resolve and the user copies the resulting address back into
 * Gladys (see the `login` action). Any path under that origin is accepted.
 */
export const OAUTH_REDIRECT_URL = 'http://homeassistant.local:8123';

/** Base host of the MiHome HTTP API (prefixed by the region, except `cn`). */
export const DEFAULT_API_HOST = 'ha.api.io.mi.com';

/** Base host of the MiHome MQTT broker (always prefixed by the region). */
export const DEFAULT_BROKER_HOST = 'ha.mqtt.io.mi.com';

/** MQTT broker port (TLS, system trust store, no client certificate). */
export const BROKER_PORT = 8883;

/** MQTT keepalive, in seconds. */
export const MQTT_KEEPALIVE = 60;

/** Xiaomi cloud regions: the account data is isolated per region. */
export const CLOUD_SERVERS = {
  cn: 'China',
  de: 'Europe',
  i2: 'India',
  ru: 'Russia',
  sg: 'Singapore',
  us: 'United States',
};

/** Default HTTP timeout, in milliseconds. */
export const HTTP_TIMEOUT = 30000;

/** HTTP timeout of the control calls (prop/set, action), in milliseconds. */
export const CONTROL_TIMEOUT = 15000;

/**
 * Fraction of the token lifetime after which the token is considered expired.
 * The refresh is then triggered 60 s before that deadline.
 */
export const TOKEN_EXPIRES_RATIO = 0.7;

/** Max number of properties read in one `prop/get` call. */
export const GET_PROP_MAX_BATCH = 150;

/** Max number of device ids hydrated in one `device_list_page` call. */
export const DEVICE_LIST_PAGE_LIMIT = 200;

/** Models the cloud lists but that cannot be driven through this API. */
export const UNSUPPORTED_MODELS = [
  'chuangmi.ir.v2',
  'era.airp.cwb03',
  'hmpace.motion.v6nfc',
  'k0918.toothbrush.t700',
];

/** Per-item result codes of prop/set and action meaning "device unavailable". */
export const DEVICE_GONE_CODES = [-704010000, -704042011];

/**
 * Host of the MiHome HTTP API for a region. `cn` uses the bare host, every
 * other region prefixes it — the MQTT host does NOT follow that rule.
 */
export function apiHost(cloudServer) {
  return cloudServer === 'cn' ? DEFAULT_API_HOST : `${cloudServer}.${DEFAULT_API_HOST}`;
}

/** Host of the MiHome MQTT broker for a region (every region is prefixed). */
export function brokerHost(cloudServer) {
  return `${cloudServer}-${DEFAULT_BROKER_HOST}`;
}
