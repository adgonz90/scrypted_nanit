# Fork notes: `@scrypted/nanit`

What this fork changes relative to upstream `scryptedapp/nanit`, and the non-obvious things
learned building it. Read this before changing streaming, sensor, or device-mode code.

Upstream is **dormant**: `upstream/main` is `9adb360`, which is exactly where this fork
branched, and it has had no commits since. Everything below is local work.

For the wider picture (network setup, how this plugin fits with Rebroadcast/HomeKit, deployment)
see `../AGENT_CONTEXT.md` in the parent workspace. For patches to Scrypted itself, see
`FORK.md` in the scrypted checkout.

---

## 1. What the fork adds

Upstream pulls video only through Nanit's cloud relay. This fork:

- pulls video **directly over the LAN**, with automatic cloud fallback;
- detects and recovers a local publish that has gone **silently stale** (TCP up, no data);
- adds **two-way audio** (HomeKit talkback), local-only;
- reports **temperature / humidity / motion / sound / cry** where the protocol delivers it;
- exposes **camera settings** (night vision, night light, sleep, status light, mic mute,
  speaker volume) as child devices, plus `Reboot`;
- fixes **snapshots**, which were completely broken upstream.

Motivation: Nanit's own app already does this local handoff — confirmed by watching the router's
NAT table while using it, where the camera connects straight to the viewing device's LAN IP on
port 1935. This brings the same capability into Scrypted.

## 2. Divergence from upstream — 19 commits

### Original feature work

| | |
|---|---|
| `c6976a6` | Local RTMP streaming with cloud fallback |
| `f974845` | Temperature/humidity sensors; reactive prebuffer safety |
| `4b2e305` | Fix `.gitignore` left with merge conflict markers |
| `af03b74` | Verbose logging setting; decode the camera's stream-status message |
| `aeeaa44` | Packet-freshness watchdog for stalled local RTMP publishers |
| `5bb6172` | `AudioSensor` instead of `BinarySensor` for sound; version reset to 0.1.0 |
| `ab060a3` | Correct protobuf schema and sensor gating against verified field data |
| `d958846` | Log every decoded control-channel message under verbose logging |
| `2c248db` | Local two-way audio for HomeKit `Intercom` |

### Settings, child devices, toolchain

| | |
|---|---|
| `33890f1` | Build against the local Scrypted SDK checkout; `@types/node` 26; tsconfig `Node16` |
| `44990d2` | Camera settings, 8 child devices, `Reboot` (`proto.ts`, `control-connection.ts`, `main.ts`) |

### Later fixes

| | |
|---|---|
| `33e485c` | **Share the in-flight `GET_SETTINGS`** — 8 children were each issuing their own request on every plugin load; now 1 |
| `e41cc7f` | Docstring fix: `requestLocalStreaming` retries indefinitely, it never retried "once" |
| `1bf722c` | **Don't wait out the stream timeout while the camera is refusing to stream** — every snapshot was burning 8s during a 5-minute backoff |
| `560cdef` | Declare the real audio/video stream parameters |
| `f6ad0ad` | **Poll child devices** (`Refresh`, 300s) so changes made in the Nanit app are noticed |
| `2549b05` | Stop declaring a video bitrate — measured once, then observed to change |
| `989b18f` → `279f961` | Declared `container: 'rtmp'` to bypass Rebroadcast's ffmpeg remux — **reverted**, see §4 |

## 3. Where the code lives

- `src/main.ts` — the whole plugin: `NanitCameraDevice` (per-camera) and `NanitCameraPlugin`
  (provider, auth, settings, local streaming, two-way audio), plus the settings child-device
  classes. One big file on purpose, matching upstream's structure.
- `src/nanit/control-connection.ts` — WebSocket client for the per-camera control channel
  (`wss://api.nanit.com/focus/cameras/{camera_uid}/user_connect`): connect/reconnect, keepalive,
  `PUT_STREAMING`, `PUT_AUDIO_STREAMING`, `GET_SETTINGS`/`PUT_SETTINGS`, `PUT_REBOOT`, sensor
  subscription and incoming pushes.
- `src/nanit/proto.ts` — protobuf schema for that channel (`protobufjs`).
- `src/nanit/local-rtmp-server.ts` — `node-media-server` wrapper, used both directions: camera
  publishes video (app `local`), we publish talkback audio (app `2wa`). Same port for both, so
  no extra firewall rule for audio.
- `src/nanit/timestamped-console.ts` — timestamps every log line, which is what makes
  correlating against Rebroadcast/HomeKit logs possible at all.

## 4. Hard-won knowledge

### Protocol

**`camera_uid` and baby `uid` are different IDs.** The REST API (`/babies`) and the cloud RTMPS
path use the baby `uid` (also this plugin's `nativeId`). The control WebSocket uses `camera_uid`,
a separate field in the same response. Mixing them up connects to a nonexistent URL.

**`proto.ts` is verified against Nanit's real Android app, not guessed from captures.** The
decompiled app lives in the parent workspace at `../apk/` (jadx and its output are checked in
there; see `../AGENT_CONTEXT.md` §8). The schema comes from:

```
../apk/export/sources/com/nanit/baby/Nanit.java          <- protobuf, *_FIELD_NUMBER / *_VALUE
../apk/export/sources/com/nanit/baby/websocket/ControlSocketMessageHandler.java
../apk/export/sources/com/nanit/baby/new_settings/sound/widgets/AudioSettings.java
../apk/export/resources/res/values/strings.xml           <- what a setting actually does
```

Reading the compiled protobuf class's constants directly corrected several things:
`SensorType` gained `SAFETY(6)`/`CRY(7)`/`UNKNOWN_8(8)`; what we had called
`STREAM_STATUS_NOTICE` is really `PUT_WEBRTC_SERVICE_MESSAGE` (a WebRTC signaling channel this
plugin doesn't otherwise use — only its `streamStopped` case is decoded); and several
`RequestType` values were added. **If a "malformed control message" warning ever appears,
decompiling the current app again is faster and far more reliable than guessing (the APK in `../apk/` is from 2026-07-14 - re-pull if the protocol appears to have moved).**

**The `RequestType` and `SensorType` enums must stay complete even though few values are acted
on.** protobufjs fails to decode an entire message when a required enum field's wire value
matches no declared entry — it does not degrade to "unknown". Trimming these caused spurious
"malformed control message" warnings, because the camera routinely sends responses for request
types we never issue.

**`GET_SENSOR_DATA` alone does not produce continuous sensor pushes.** It returns a one-time
snapshot; `PUT_CONTROL` with `sensorDataTransferEn` is also required. Nanit's own app sends both
back to back on every connect, and so does this plugin
(`requestSensorData()` + `requestSensorDataTransfer()`).

**MOTION/SOUND gating does not use `isAlert`.** From the decompiled app's own notification code:
MOTION requires `value === 2` (a discrete detection-level code, not a magnitude) and
`valueMilli < 350000`; SOUND has no value gate at all. Neither checks `isAlert`. Separately, a
MOTION/SOUND/CRY push whose `timestamp` exactly matches the latest NIGHT push is an artifact of
the IR-cut relay physically switching, and is suppressed (`isIcrArtifact()`).

**The temperature/humidity sensor is in the camera stand, not the camera body.** Values read as
a `-1000` sentinel until a working stand is connected. Missing climate data is almost always a
hardware/seating issue, not a plugin bug.

### Streaming and device modes

**Concurrent requests race Nanit's API or leak resources unless deduplicated.** `tryLogin()`,
`fetchBabies()`, `ensureLocalStream()`/`requestLocalStreaming()`, `startTwoWayAudio()` and
`fetchCameraSettings()` all share in-flight promises per device. Without it for streaming,
concurrent `PUT_STREAMING` requests triggered Nanit's "too many mobile app connections"; without
it for talkback, two `startIntercom()` calls each spawned an ffmpeg process and handed the camera
a different session ID, leaking whichever lost the race. `fetchCameraSettings()` is in-flight
sharing **only, with no TTL cache** — `PUT_SETTINGS` doesn't reliably echo the new value back, so
callers confirm writes by re-reading, and a cache would serve them stale data.

**"Too many Nanit app connections" is usually Nanit's own app being open.** The camera then
declines `PUT_STREAMING` with a 403 and the plugin backs off for 5 minutes
(`CONNECTION_LIMIT_BACKOFF_MS`), silently serving cloud in the meantime. **Close the Nanit app on
every device before testing local streaming**, or you will measure the cloud path without knowing
it. The backoff is now visible to callers via `getStreamingRetryAfter()` so `ensureLocalStream()`
falls straight through to cloud instead of waiting out its timeout.

**Rebroadcast decides whether to prebuffer continuously from the `Battery` interface, live.**
`shouldDisableBatteryPrebuffer()` (in `@scrypted/prebuffer-mixin`, not here) returns "don't
disable" the instant `Battery` is absent from the declared interfaces — it doesn't even look at
`chargeState`/`batteryLevel` in that case. So this plugin declares `Battery` *unless* both "Keep
Local Stream Connected" is on **and** local video is confirmed alive (`rtmp.isAlive()`), checked
on every alive/unhealthy transition. Without that, a prolonged local outage would have Rebroadcast
holding a persistent **cloud** connection open — the exact behavior this project exists to avoid,
one layer removed.

**`batteryLevel` unset reads as "low battery", not "not applicable".** The check is
`batteryLevel == null || batteryLevel < 20`. Never clear it to signal "not battery powered"; it
does the opposite. It is always set to `100`; only the *interface's presence* toggles.

**Declared interfaces silently revert on every plugin restart.** `syncDevices()` (run from the
constructor) re-registers devices with a hardcoded interface set regardless of persisted
settings, so `getDevice()` calls `applyDeviceMode()` for every device on load to correct it. This
was the root cause of HKSV silently disappearing after a restart plus re-pair.

**Declaring a `ScryptedInterface` isn't enough, and re-pairing may also be needed.** A class can
implement an interface with working methods and still not expose it unless the
`ScryptedInterface` is in the `interfaces` array passed to `onDeviceDiscovered`/
`onDevicesChanged`. And **HomeKit negotiates accessory capabilities at pairing time** — the talk
button, HKSV, and newly added child devices do not appear until the camera is removed and
re-paired in the Home app.

**Snapshot and live view are the same path** (`buildFfmpegInput()`), differentiated by a
`forSnapshot` flag that bounds ffmpeg's probing. Don't reintroduce a separate snapshot
implementation.

### Two-way audio

**It is architecturally the reverse of video.** For video the camera publishes to us; for
talkback *we* publish RTMP to the `2wa` app namespace and tell the camera to connect and play it
via `PUT_AUDIO_STREAMING` — mirroring how Nanit's own app does local talkback. The `media` object
handed to `startIntercom()` already has SRTP decrypted and re-served as local RTSP by Scrypted's
HomeKit plugin, with the correct input `-acodec` in `inputArguments`, so no SRTP work is needed
here. The **output** format (AAC/44100/mono/24kbps toward the camera) is an educated guess that
matches the camera's own downstream spec and the app's mic capture rate, but is unverified.

**Talkback depends on the same camera-to-host firewall path as local video.** While that path was
blocked it failed to connect here *and in Nanit's own app* — which is the tell that it's a network
problem, not a plugin one.

**HomeKit calls `startIntercom()`/`stopIntercom()` once per camera-view session, not per tap of
the talk button**, and runs one independent RTP session per paired controller, with no
coordination between them. Toggling talk mid-session never reaches this plugin; it shows up only
as our ffmpeg stalling and resuming.

### Why `container: 'rtmp'` was tried and reverted (`989b18f` → `279f961`)

Rebroadcast picks its ingest path from the declared container. With none declared it falls back
to an `ffmpeg -fflags +genpts -i rtmp://… -f rtsp` remux. Declaring `container: 'rtmp'` (plus
`url`) instead selects `startRtmpSession()`, Scrypted's in-process RTMP depacketizer — no ffmpeg,
no remux.

It worked, and then broke audio completely: `rtmp-session.ts` builds its RTSP SDP from a **static
template with the AAC parameters hardcoded to 16 kHz** (`config=1408`). This camera is 44100 Hz
(`config=1208`), so every packet failed to decode. Reverted.

Two lasting conclusions: that path is **local-only** by construction (the cloud fallback is
`rtmps://`, TLS, which the parser can't open), so it could never fix a problem affecting both;
and it stays unusable until that parser derives the sample rate from the stream's AAC sequence
header.

## 5. Open items

- **Duplicate Speaker Volume exposure.** `:speakervolume` (`Speaker`/`AudioVolumeControl`) and
  `:speakervolume-light` (`Light`/`OnOff`+`Brightness`) both write `Settings.volume`. The Light is
  a deliberate fake, because `AudioVolumeControl` didn't render in the Home app. The scrypted
  fork's `mergeVolumeDevicesByType` may make it redundant — but it's marked experimental, and
  neither currently appears in HomeKit. Resolve by enabling the HomeKit mixin on **one at a time**
  and re-pairing, then deleting the loser.
- **`nightLightBr` scale is unverified.** Assumed 0–100 and passed through. Now trivially checkable
  with `GET_SETTINGS`.
- **Snapshot cadence is aggressive** — roughly every 4 seconds, each attaching an RTMP subscriber.
  Cheap while local is healthy, but more often than anything needs.
- **No cloud/remote two-way audio.** Local delivery only; publishing through Nanit's relay was
  deliberately never attempted.
- **No talkback session queueing.** A second `startIntercom()` silently replaces the first. Every
  Scrypted camera plugin implementing `Intercom` does the same, and one speaker can only play one
  talker anyway.

## 6. Before restructuring `applyDeviceMode()`, `ensureLocalStream()`, `startTwoWayAudio()`, or the `LocalRtmpServer` wiring

These carry a lot of interdependent, non-obvious behavior. Several things that look simplifiable
— "why not always declare `Battery`", "why not skip the control connection when nobody's
watching", "why not let a second `startIntercom()` wait for `stopTwoWayAudio()`" — were built this
way after a simpler version was ruled out for a concrete, tested reason. One of them (a naive
concurrency guard on `stopTwoWayAudio()`) would have deadlocked. Read the inline comments first;
§4 covers the rest.
