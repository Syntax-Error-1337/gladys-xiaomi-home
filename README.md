# Xiaomi Home — Gladys Assistant integration

External integration bringing the devices of a **Xiaomi Home** account into
[Gladys Assistant](https://gladysassistant.com): lights, plugs, sensors,
covers, climate, purifiers, vacuums…

It speaks the same cloud protocol as the official
[Xiaomi Home integration for Home Assistant](https://github.com/XiaoMi/ha_xiaomi_home)
(the `haapi` surface of the Xiaomi cloud), and maps the **MIoT-Spec-V2**
description of each device onto Gladys features. There is no per-model table:
a device Xiaomi releases tomorrow is supported the day it appears in your
account.

User documentation: [`docs/en.md`](docs/en.md) · [`docs/fr.md`](docs/fr.md).

## How it works

```
Xiaomi account ──OAuth2──▶ tokens (stored in the Gladys config, off-schema)
                              │
        ┌─────────────────────┼──────────────────────────┐
        ▼                     ▼                          ▼
  HTTPS haapi           miot-spec.org               MQTT (TLS 8883)
  device list,          MIoT-Spec-V2 of             device/<did>/up/...
  prop get/set,         each device model           properties, events,
  actions               (cached in /data)           online state
        │                     │                          │
        └────────► src/mapping/features.js ◄─────────────┘
                              │
                      Gladys devices & features
```

| Direction       | Channel                                                   |
| --------------- | --------------------------------------------------------- |
| Xiaomi → Gladys | MQTT push (instant) + polling (safety net, configurable)  |
| Gladys → Xiaomi | `POST /app/v2/miotspec/prop/set` and `/action` over HTTPS |

### Project structure

```
.
├─ index.js                          # SDK wiring only (handlers -> manager)
├─ src/
│  ├─ deviceManager.js               # session, catalog, commands, polling, push
│  ├─ config.js                      # defaults + the off-schema token storage
│  ├─ xiaomi/
│  │  ├─ constants.js                # client id, hosts per region, limits
│  │  ├─ oauth.js                    # authorize URL, code exchange, refresh
│  │  ├─ api.js                      # MiHome HTTP API (devices, props, actions)
│  │  ├─ spec.js                     # MIoT-Spec-V2 fetch, parse, disk cache
│  │  ├─ qrLogin.js                  # QR sign-in: linking without any redirect
│  │  ├─ mqtt.js                     # cloud push channel (read-only)
│  │  └─ httpUtils.js                # fetch + timeout + typed errors
│  └─ mapping/
│     ├─ features.js                 # MIoT spec -> Gladys features (the core)
│     ├─ gladysValues.js             # Gladys enum values (cover, AC, vacuum…)
│     └─ units.js                    # MIoT unit -> Gladys unit
├─ docs/{en,fr}.md                   # user documentation (re-hosted by Gladys)
├─ gladys-assistant-integration.json # manifest
└─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
```

## The mapping, in one table

Resolution goes from the most specific rule to the generic fallback
(`src/mapping/features.js`):

| MIoT input                                                                                                                                             | Gladys feature                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `on` in a `light` service                                                                                                                              | `light` / `binary`                              |
| `brightness` with a value range                                                                                                                        | `light` / `brightness`, rescaled to percent     |
| `color-temperature`                                                                                                                                    | `light` / `temperature`, Kelvin bounds kept     |
| `color` (uint32 RGB)                                                                                                                                   | `light` / `color`                               |
| `on` elsewhere                                                                                                                                         | `switch` / `binary`                             |
| `temperature`, `relative-humidity`, `illumination`, `pm2.5-density`, `co2-density`, `battery-level`, `voltage`, `electric-power`, `power-consumption`… | the matching sensor category, unit converted    |
| `contact-state`, `motion-state`, `occupancy-status`, `submersion-state`, `smoke`                                                                       | the matching binary sensor category             |
| `motor-control` value list (open/close/pause)                                                                                                          | `curtain` / `state` (`COVER_STATE`)             |
| `target-position`                                                                                                                                      | `curtain` / `position`                          |
| `mode` of an air conditioner                                                                                                                           | `air-conditioning` / `mode` (`AC_MODE`)         |
| `target-temperature`                                                                                                                                   | `air-conditioning` or `thermostat` setpoint     |
| vacuum `status` value list                                                                                                                             | `vacuum-cleaner` / `state`                      |
| `charging-state` value list                                                                                                                            | `battery` / `charging`                          |
| any other enum (writable)                                                                                                                              | `text` / `select` with `supported_options`      |
| any other enum or string (read-only)                                                                                                                   | `text` / `text`                                 |
| an action with no argument                                                                                                                             | write-only `switch` / `binary` command          |
| `click` / `double-click` / `long-press` events                                                                                                         | one `button` / `click` feature per service      |
| `doorbell-ring`, `motion-detected` events                                                                                                              | `doorbell` / `ring`, `motion-sensor` / `binary` |
| anything else                                                                                                                                          | hidden, unless "Expose every property" is on    |

An enum whose values have no Gladys equivalent degrades to a text select
rather than losing them; a vendor value inside a mapped enum (a curtain
"auto" mode) is dropped from the options instead of disabling the mapping.

## Account linking: a QR code, not a redirect

Xiaomi validates the OAuth `redirect_uri` against the one registered for its
client id and accepts nothing but `http(s)://homeassistant.local:8123/<any
path>` — every other host, port or scheme (a Gladys address included) is
answered with `invalid redirect uri`. The browser is therefore taken out of
the loop: the manifest declares an `account_link` field (SDK v0.12, "a QR
sign-in approved in the vendor app" — literally this case), and "Connect"
opens a QR code. The user approves it from their phone; the integration
long-polls Xiaomi until then, walks the redirect chain **server-side** and
reads the authorization code out of the `302` that no browser can reach
(`src/xiaomi/qrLogin.js`). A manual sign-in link + paste action remains as
the fallback for a user who cannot scan.

Tokens are stored as configuration keys outside the manifest schema
(`xiaomi_access_token`…): never rendered in the UI, refreshed automatically
60 s before expiry (and once more, on the fly, if Xiaomi answers `401`).

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="xiaomi-home" \
XIAOMI_DATA_DIR="./data" \
LOG_LEVEL=debug \
npm start
```

`XIAOMI_DATA_DIR` is where the MIoT spec cache lives (`/data` in the
container, the only writable path of the sandbox). A read-only volume only
costs a re-download at each start.

### Run the container

The image reproduces the Gladys sandbox: non-root user, read-only rootfs,
`/data` as the only writable path.

```bash
docker build -t gladys-xiaomi-home:test .
docker run --rm --read-only --tmpfs /tmp \
  -v "$PWD/data:/data" \
  -e GLADYS_HOST_API_URL="http://host.docker.internal:1443" \
  -e GLADYS_INTEGRATION_TOKEN="<token>" \
  -e GLADYS_INTEGRATION_SELECTOR="xiaomi-home" \
  gladys-xiaomi-home:test
```

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test
```

The tests cover the mapping decisions (what the user ends up seeing), the wire
format of the Xiaomi calls, the push decoder and the manager behaviour
(discovery payload, commands, polling, token retry) — the Xiaomi cloud is
replaced by fakes, so the suite runs offline.

Before tagging a release, replay the store checks locally:

```bash
npx github:GladysAssistant/integration-store .
```

## Publish

```bash
git push -u origin main
```

Then, on GitHub: add the repository topic `gladys-assistant-integration`, and
run **Actions → Release → Run workflow** (`patch`/`minor`/`major`). The
workflow bumps `package.json` + the manifest `version`/`docker_image`, pushes
the `vX.Y.Z` tag and builds the `linux/amd64` + `linux/arm64` image to
`ghcr.io/syntax-error-1337/gladys-xiaomi-home`. Make the GHCR package
**public** once (Packages → package settings), otherwise the store rejects the
manifest with "image is not publicly pullable". The hourly indexer then picks
the manifest up.

## Scope

- **Cloud only.** The manifest declares `transports: ["cloud"]`. Local control
  (LAN miIO or a Xiaomi central hub gateway) is not implemented: the cloud API
  exposes every property, event and command, and the sandboxed container has
  no LAN broadcast anyway.
- **Devices the API cannot drive are skipped** (`miwifi.*`, `chuangmi.ir.v2`
  and the models Xiaomi lists as unsupported).
- **Actions with arguments are not exposed**: Gladys has no generic way to ask
  the user for them.

## Credits

Protocol constants and behaviour (endpoints, header quirks, topic names,
per-item result codes) were derived from
[XiaoMi/ha_xiaomi_home](https://github.com/XiaoMi/ha_xiaomi_home), Apache-2.0.

## License

Apache-2.0
