# Xiaomi Home

Control the Xiaomi, Mijia and Aqara devices of your Xiaomi Home account from
Gladys: lights, plugs, sensors, curtains, air conditioners, purifiers, robot
vacuums… Everything goes through the official Xiaomi cloud API used by the
Xiaomi Home integration for Home Assistant, so nothing has to be flashed,
rooted or paired again.

## What you get

The integration reads the **MIoT specification** of every device of your
account and converts it into Gladys features — there is no per-model list, a
device released tomorrow works the same day:

| Xiaomi device                 | What appears in Gladys                             |
| ----------------------------- | -------------------------------------------------- |
| Bulbs, strips, ceiling lights | On/off, brightness, colour temperature, colour     |
| Plugs and switches            | On/off, power, energy, voltage, current            |
| Motion, door, leak sensors    | Binary sensors (motion, opening, leak, smoke)      |
| Thermometers, air monitors    | Temperature, humidity, PM2.5, CO2, VOC, pressure   |
| Curtains and blinds           | Open/close/stop and position                       |
| Air conditioners, heaters     | On/off, mode, target temperature, fan speed, swing |
| Fans, purifiers, humidifiers  | On/off, speed, mode, filter life                   |
| Robot vacuums                 | State, battery, start/stop/charge commands         |
| Buttons and doorbells         | Click, double click, long press, ring              |

Anything Gladys has no category for (vendor specific properties) is exposed as
a text feature, so no information is lost. Device actions without argument
(start cleaning, reset filter…) appear as command switches.

State changes arrive **in real time**: the integration subscribes to the
Xiaomi push channel (MQTT). Polling runs in the background as a safety net.

## Prerequisites

- A Xiaomi Home account with your devices already added in the Xiaomi Home
  mobile application (this integration never pairs devices, it drives the ones
  your account already owns).
- The **region** of that account: China, Europe, India, Russia, Singapore or
  United States. Account data is isolated per region — the wrong region shows
  an empty device list.
- An Internet connection: control goes through the Xiaomi cloud.

## Configuration

1. Install the integration and open its **Configuration** tab.
2. Pick your **Xiaomi region** and save.
3. Click **Connect** next to "Xiaomi account": a **QR code** opens in a new
   tab.
4. Scan it with your phone — the **Xiaomi Home app** (profile → scan), the
   **Xiaomi Account** section of a Xiaomi phone, or any camera app — and
   approve the sign-in there.
5. That's it. Gladys completes the login by itself, downloads your devices and
   publishes them. They show up in the **Discovery** tab, ready to be added to
   your dashboard.

Nothing has to be copied, and your browser is never sent to another address.

**The QR page stays still after the scan — that is normal.** It is a static
image on Xiaomi's server; it will never redirect anywhere. What moves is the
connection indicator of the Configuration screen: it turns green by itself a
few seconds after you approve on your phone. If it turns red instead, the
message under it says exactly what Xiaomi answered.

### If you cannot scan the QR code

Xiaomi refuses to redirect a sign-in anywhere but
`http://homeassistant.local:8123` — the address registered for the Home
Assistant integration this one derives from. A Gladys address (
`http://gladysassistant.local`, an IP, anything else) is answered with
_"invalid redirect uri"_, which is why the QR path exists. The manual fallback
replays that historical flow:

1. Run the **"Get a manual sign-in link"** action and open the URL it returns.
2. Sign in and approve.
3. Xiaomi sends your browser to `http://homeassistant.local:8123/...?code=...`,
   which **fails to load** — expected, nothing is listening there.
4. Copy that whole address from the address bar.
5. Paste it in the **"Finish the login"** action.

Two optional settings:

- **Refresh interval** — how often each device is re-read from the cloud, picked
  from a fixed list (1 s to 1 minute; default 1 minute — Gladys only accepts
  these values). The push channel already reports changes instantly; lower it
  only if you have a device that never pushes.
- **Expose every property** — also create features for the vendor properties
  Gladys has no category for. Useful to debug an exotic device, noisy
  otherwise.

## Day-to-day

- **Refresh the device list** — run this action after adding, renaming or
  removing a device in the Xiaomi Home app.
- **Disconnect the account** — forgets the stored tokens. Use it before linking
  another Xiaomi account, or to revoke this Gladys instance.

The session is renewed automatically: the access token is refreshed before it
expires, without any action from you.

## Troubleshooting

**"No device found" after linking.** The account is almost always linked to
another region. Change the region, save, then run "Refresh the device list".

**The QR code expired.** It is valid for 5 minutes. Click **Connect** again to
get a fresh one.

**The QR code was scanned but nothing happens.** Approve the sign-in on the
phone (Xiaomi asks for a confirmation after the scan), and keep the region
setting matching the account. The integration reports the failure in its
connection status and in the logs.

**The pasted address is refused.** The address must come from the browser tab
where you just signed in, and it must contain `code=`. If you signed in twice,
only the last address is valid — a code can be exchanged once.

**A device is missing.** Devices the Xiaomi cloud API cannot drive are skipped:
Xiaomi routers (`miwifi.*`), infrared remotes (`chuangmi.ir.v2`) and a few
models Xiaomi itself lists as unsupported. Bluetooth devices connected through
a gateway are supported as long as the gateway reports them to the cloud.

**A device shows an "unreachable" badge.** Xiaomi reports it as offline. Check
it in the Xiaomi Home app: it is a device or network problem, not a Gladys one.

**"The Xiaomi session expired".** The refresh token was revoked (password
change, account signed out everywhere, another client took the session). Click
Connect and redo the login.

**Reading the logs.** The integration logs every call it makes. Set the
`LOG_LEVEL` environment variable to `debug` (or read the integration logs from
the Gladys UI) to see the device list, the spec downloads and the commands.
