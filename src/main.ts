import { AudioSensor, AudioVolumeControl, AudioVolumes, Battery, Brightness, Camera, Device, DeviceCreator, DeviceCreatorSettings, DeviceProvider, FFmpegInput, HumiditySensor, Intercom, MediaObject, MediaStreamOptions, MotionSensor, OnOff, PictureOptions, Reboot, ResponseMediaStreamOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, TemperatureUnit, Thermometer, VideoCamera } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings"
import axios, { AxiosRequestConfig } from 'axios'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { NanitControlConnection } from './nanit/control-connection';
import { LocalRtmpServer } from './nanit/local-rtmp-server';
import { DecodedSensorData, DecodedSettings } from './nanit/proto';
import { withTimestamps } from './nanit/timestamped-console';

const { deviceManager, mediaManager } = sdk;

// How long a non-persistent (on-demand) local stream / control connection is kept around after
// the last viewer disconnects, before we tear it down and go back to fully idle. Absorbs quick
// reconnects (e.g. HomeKit re-requesting the stream a few seconds later) without re-paying the
// PUT_STREAMING + camera redirect round trip every time.
const ON_DEMAND_TEARDOWN_GRACE_MS = 15_000;

interface NanitBaby {
    uid: string;
    name: string;
    camera_uid: string;
}

class NanitCameraDevice extends ScryptedDeviceBase implements Intercom, Camera, VideoCamera, MotionSensor, AudioSensor, Battery, Thermometer, HumiditySensor, Settings, Reboot, DeviceProvider {
    settingsStorage = new StorageSettings(this, {
        persistentLocalStream: {
            title: 'Keep Local Stream Connected',
            description: 'Off (default): the local stream and its cloud control/signaling connection are only requested while something is actively viewing (matches this plugin\'s original Battery-camera behavior - lower footprint, no background motion/sound detection). On: the control connection stays open continuously so the local stream loads near-instantly and motion/sound detection work in the background. Only the lightweight control channel touches Nanit\'s cloud continuously either way - video itself stays on the LAN whenever a local stream is active.',
            type: 'boolean',
            defaultValue: false,
            onPut: async () => this.plugin.applyDeviceMode(this.nativeId!),
        },
        reportClimateSensors: {
            title: 'Report Temperature/Humidity',
            description: 'Off (default): temperature/humidity are not exposed and no connection is opened just for them. On: exposes this camera\'s temperature and humidity readings to HomeKit. Independent of "Keep Local Stream Connected" - if that\'s off, this keeps just the lightweight cloud control/signaling connection open on its own (no local video streaming triggered by this alone) so sensor readings keep updating in the background. Note: Nanit\'s temperature/humidity sensor lives in the camera stand, not the camera body - this has no effect if the camera isn\'t seated in a stand with a working sensor.',
            type: 'boolean',
            defaultValue: false,
            onPut: async () => this.plugin.applyDeviceMode(this.nativeId!),
        },
    });

    constructor(public plugin: NanitCameraPlugin, nativeId: string) {
        super(nativeId);
    }

    // Timestamp of the most recent NIGHT sensor push (IR-cut relay / night-vision toggle). Used to
    // suppress MOTION/SOUND/CRY events that share this exact timestamp, since the IR-cut relay's
    // physical switch (or the IR flood light flicker) can itself spuriously trigger those sensors -
    // see isIcrArtifact() below.
    private lastNightEventTimestamp?: number;

    private _timestampedConsole?: Console;
    get console(): Console {
        if (!this._timestampedConsole)
            this._timestampedConsole = withTimestamps(super.console);
        return this._timestampedConsole;
    }

    get persistentLocalStream(): boolean {
        return !!this.settingsStorage.values.persistentLocalStream;
    }

    get reportClimateSensors(): boolean {
        return !!this.settingsStorage.values.reportClimateSensors;
    }

    async getSettings(): Promise<Setting[]> {
        return this.settingsStorage.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.settingsStorage.putSetting(key, value);
    }

    async takePicture(options?: PictureOptions): Promise<MediaObject> {
        this.console.log("trying to take a photo")
        const ffmpegInputVal = await this.buildFfmpegInput(options, true);
        return mediaManager.createMediaObject(Buffer.from(JSON.stringify(ffmpegInputVal)), ScryptedMimeTypes.FFmpegInput);
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        // can optionally provide the different resolutions of images that are available.
        // used by homekit, if available.
        return;
    }

    async getVideoStream(options?: MediaStreamOptions): Promise<MediaObject> {
        this.console.log("Attempting to confirm access token to retrieve video stream")
        await this.plugin.tryLogin();
        this.console.log("Login Succeeded. Returning video stream")
        const ffmpegInputVal = await this.buildFfmpegInput(options);
        return mediaManager.createMediaObject(Buffer.from(JSON.stringify(ffmpegInputVal)), ScryptedMimeTypes.FFmpegInput);
    }

    // Shared by getVideoStream() and takePicture(): prefers a local RTMP source and transparently
    // falls back to the existing cloud RTMPS relay when local push isn't available. This is also
    // what makes snapshots reliable - once a local low-latency source exists, the same "-vframes 1"
    // ffmpeg args used for takePicture() work against it instead of the slow cloud
    // handshake.
    async buildFfmpegInput(options?: MediaStreamOptions, forSnapshot = false): Promise<FFmpegInput> {
        if (!this.nativeId) {
            throw new Error("missing nativeId");
        }
        if (!this.plugin.access_token) {
            throw new Error("missing access token");
        }

        this.console.log(`[${this.nativeId}] attempting local stream before falling back to cloud`);
        const localUrl = await this.plugin.ensureLocalStream(this.nativeId);
        const url = localUrl ?? this.cloudStreamUrl();

        if (localUrl)
            this.console.log(`[${this.nativeId}] using LOCAL stream: ${localUrl}`);
        else
            this.console.log(`[${this.nativeId}] using CLOUD stream (see preceding log line for why local wasn't used): ${this.cloudStreamUrl().replace(this.plugin.access_token, '<redacted>')}`);

        // Snapshot grabs were consistently getting killed by Scrypted's own snapshot timeout
        // (~4-5s) before producing a frame. Our local RTMP source already sends header + cached
        // GOP data immediately on connect (node-media-server's GOP cache), so there's no need for
        // ffmpeg's much larger network-stream probing defaults for a single-frame grab - bound
        // them down so ffmpeg can commit to a frame quickly instead of over-analyzing first.
        const inputArguments = forSnapshot
            ? ['-analyzeduration', '1000000', '-probesize', '1000000', '-i', url]
            : ['-i', url];

        return {
            url: undefined,
            inputArguments,
        };
    }

    cloudStreamUrl(): string {
        return "rtmps://media-secured.nanit.com/nanit/" + this.nativeId! + "." + this.plugin.access_token;
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [{
            id: this.nativeId + "-stream",
            allowBatteryPrebuffer: false,
            video: {
                codec: 'h264',
            }
        }];
    }


    async startIntercom(media: MediaObject): Promise<void> {
        if (!this.nativeId)
            throw new Error('missing nativeId');
        await this.plugin.startTwoWayAudio(this.nativeId, media);
    }

    async stopIntercom(): Promise<void> {
        if (!this.nativeId)
            return;
        await this.plugin.stopTwoWayAudio(this.nativeId);
    }

    async reboot(): Promise<void> {
        if (!this.nativeId)
            throw new Error('missing nativeId');
        await this.plugin.requestCameraReboot(this.nativeId);
    }

    // Declaring DeviceProvider (and delegating straight through to the plugin, which already
    // handles every nativeId including this camera's own) lets HomeKit's generic camera accessory
    // builder treat this device as a DeviceProvider and merge its child devices (Sleep, Night
    // Light, etc.) onto the camera's own HomeKit accessory instead of a separate bridge accessory.
    async getDevice(nativeId: string) {
        return this.plugin.getDevice(nativeId);
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        return this.plugin.releaseDevice(id, nativeId);
    }

    // most cameras have have motion and doorbell press events, but dont notify when the event ends.
    // so set a timeout ourselves to reset the state.
    triggerAudioDetected() {
        this.audioDetected = true;
        setTimeout(() => this.audioDetected = false, 10000);
    }

    // most cameras have have motion and doorbell press events, but dont notify when the event ends.
    // so set a timeout ourselves to reset the state.
    triggerMotion() {
        this.motionDetected = true;
        setTimeout(() => this.motionDetected = false, 10000);
    }

    // A MOTION/SOUND/CRY push whose timestamp exactly matches the most recent NIGHT push is treated
    // as a spurious side effect of the IR-cut relay switching, not a real event, and suppressed.
    private isIcrArtifact(sensor: DecodedSensorData): boolean {
        return sensor.timestamp !== undefined && sensor.timestamp === this.lastNightEventTimestamp;
    }

    // Fed by the camera's control-channel PUT_SENSOR_DATA pushes (only received while a control
    // connection is open - i.e. reliably in "Keep Local Stream Connected" mode). TEMPERATURE/
    // HUMIDITY are confirmed working. MOTION/SOUND are kept for protocol completeness but haven't
    // been observed firing in practice - motion/sound notifications appear to be delivered through
    // a separate push-notification channel instead, not this control connection. The gating below
    // (value/valueMilli for MOTION, no isAlert check for either) reflects reverse-engineered
    // protocol behavior rather than a guess, in case that assumption turns out to be wrong.
    handleSensorData(sensor: DecodedSensorData) {
        if (this.plugin.verboseLogging)
            this.console.log(`[${this.nativeId}] sensor data: ${JSON.stringify(sensor)}`);
        if (sensor.sensorType === 'NIGHT') {
            this.lastNightEventTimestamp = sensor.timestamp;
            // Confirmed against the decompiled app (ControlSocketMessageHandler.analyzeSensorData():
            // NIGHT's value field is a plain boolean signal, not a magnitude - value === 1 means IR
            // is currently engaged, dispatched there to the app's own "IR" event. Used to keep the
            // Night Vision "On" child switch's displayed state live while Automatic mode is engaged.
            if (this.nativeId)
                this.plugin.updateNightVisionLiveState(this.nativeId, sensor.value === 1);
        }
        // isAlert isn't a reliable gate for MOTION - instead this requires value === 2 (a discrete
        // detection-level code, not a magnitude) and valueMilli < 350000 (likely a duration/score
        // threshold in ms). Neither field is otherwise displayed or interpreted as a measurement.
        else if (sensor.sensorType === 'MOTION' && !this.isIcrArtifact(sensor)
            && sensor.value === 2 && (sensor.valueMilli ?? 0) < 350000) {
            this.console.log(`[${this.nativeId}] triggering motion from sensor data`);
            this.triggerMotion();
        }
        // isAlert isn't a reliable gate for SOUND either - just the ICR-artifact suppression above
        // (a per-user notification-preference check would normally apply too, but this plugin has
        // no equivalent setting for that).
        else if (sensor.sensorType === 'SOUND' && !this.isIcrArtifact(sensor)) {
            this.console.log(`[${this.nativeId}] triggering audio detected from sensor data`);
            this.triggerAudioDetected();
        }
        else if (sensor.sensorType === 'TEMPERATURE' && sensor.valueMilli !== undefined) {
            // valueMilli is a milli-units reading (i.e. divide by 1000 for the actual value).
            // Confirmed against real hardware readings; the range check below just guards against
            // the -1000/-1000000 "no data" sentinel this field can also carry, so HomeKit doesn't
            // show a nonsensical -1000C reading.
            const celsius = sensor.valueMilli / 1000;
            if (celsius > -50 && celsius < 80)
                this.temperature = celsius;
        }
        else if (sensor.sensorType === 'HUMIDITY' && sensor.valueMilli !== undefined) {
            const percent = sensor.valueMilli / 1000;
            if (percent >= 0 && percent <= 100)
                this.humidity = percent;
        }
    }

    async setTemperatureUnit(temperatureUnit: TemperatureUnit): Promise<void> {
        // Display preference only - Thermometer.temperature is always reported in Celsius
        // regardless of this setting.
        this.temperatureUnit = temperatureUnit;
    }
}

// Boolean camera Settings fields exposed as simple child OnOff switches, one Scrypted device per
// field. Child devices (nativeId `${babyUid}:${slug}`, providerNativeId pointing at the camera)
// rather than extra interfaces on the camera device itself, since a single device can only
// implement OnOff once - three independent booleans need three separate devices to each get their
// own HomeKit accessory / Home Assistant switch entity.
const BOOLEAN_SETTING_CHILD_DEVICES: { slug: string; name: string; settingsField: 'sleepMode' | 'statusLightOn' | 'micMuteOn'; invert?: boolean }[] = [
    // Display name is "Camera Active" and the polarity is inverted from the raw wire field - this
    // is Nanit's own camera standby toggle, confirmed against the decompiled app
    // (ControlSocketMessageHandler.setStandbyMode, strings.xml camera_standby_is_off_description):
    // "All video and sound capturing, Insights collection and notifications are suspended." Not a
    // mild pause - it's a full off switch. The wire field (sleepMode=true means "camera off") reads
    // backwards as a HomeKit/HA switch ("turn the switch on to turn the camera off"), so this
    // device inverts it: on=true means the camera is actively monitoring, on=false means standby -
    // matches how every other power switch behaves. slug/settingsField stay as-is (internal
    // identifiers, changing the slug would trigger a device recreate - see the syncDevices() note
    // on scoped onDevicesChanged calls).
    { slug: 'sleep', name: 'Camera Active', settingsField: 'sleepMode', invert: true },
    { slug: 'statuslight', name: 'Status Light', settingsField: 'statusLightOn' },
    // Confirmed via decompiled app (AudioSettings.java -> strings.xml settings_description_sound):
    // muting this also stops sound notifications (cry/sound alerts), not just the two-way-talk mic.
    { slug: 'micmute', name: 'Mic Mute', settingsField: 'micMuteOn' },
];

/** A single boolean camera Settings field (sleepMode/statusLightOn/micMuteOn), exposed as an OnOff switch. */
class NanitSettingSwitch extends ScryptedDeviceBase implements OnOff {
    on?: boolean;

    constructor(
        public plugin: NanitCameraPlugin,
        nativeId: string,
        public readonly cameraNativeId: string,
        public readonly settingsField: 'sleepMode' | 'statusLightOn' | 'micMuteOn',
        public readonly invert: boolean = false,
    ) {
        super(nativeId);
    }

    async turnOn(): Promise<void> {
        await this.plugin.updateCameraBooleanSetting(this.cameraNativeId, this.settingsField, !this.invert);
        this.on = true;
    }

    async turnOff(): Promise<void> {
        await this.plugin.updateCameraBooleanSetting(this.cameraNativeId, this.settingsField, this.invert);
        this.on = false;
    }

    /** Pulls the current value from the camera - called on first load so the switch doesn't start undefined. */
    async refresh(): Promise<void> {
        const settings = await this.plugin.fetchCameraSettings(this.cameraNativeId);
        const value = settings?.[this.settingsField];
        if (typeof value === 'boolean')
            this.on = this.invert ? !value : value;
    }
}

const NIGHT_LIGHT_SLUG = 'nightlight';

/**
 * The physical night light (Settings.nightLightBr), exposed as a dimmable Light - OnOff at
 * brightness 0, Brightness for the level. The camera has no separate on/off bit for this, just a
 * brightness value where 0 means off.
 *
 * nightLightBr's real-world scale isn't confirmed against a live camera (the decompiled app's own
 * UI code is obfuscated, same limitation as PUT_REBOOT's `force` field) - this assumes it's already
 * 0-100, matching Scrypted's own Brightness range, and passes the value straight through. Worth
 * verifying once deployed (requestSettings() after setting a known value) and adjusting the mapping
 * here if the camera actually expects a different scale.
 */
class NanitNightLightDevice extends ScryptedDeviceBase implements OnOff, Brightness {
    on?: boolean;
    brightness?: number;

    constructor(public plugin: NanitCameraPlugin, nativeId: string, public readonly cameraNativeId: string) {
        super(nativeId);
    }

    async turnOn(): Promise<void> {
        await this.setBrightness(this.brightness && this.brightness > 0 ? this.brightness : 100);
    }

    async turnOff(): Promise<void> {
        await this.setBrightness(0);
    }

    async setBrightness(brightness: number): Promise<void> {
        await this.plugin.updateCameraSettings(this.cameraNativeId, { nightLightBr: brightness });
        this.brightness = brightness;
        this.on = brightness > 0;
    }

    /** Pulls the current value from the camera - called on first load so the light doesn't start undefined. */
    async refresh(): Promise<void> {
        const settings = await this.plugin.fetchCameraSettings(this.cameraNativeId);
        if (typeof settings?.nightLightBr === 'number') {
            this.brightness = settings.nightLightBr;
            this.on = settings.nightLightBr > 0;
        }
    }
}

const NIGHT_VISION_AUTO_SLUG = 'nightvision-auto';
const NIGHT_VISION_ON_SLUG = 'nightvision-on';

/**
 * Two switches reducing Settings.nightVision's 3-state enum (OFF/AUTOMATIC/ON) to independent
 * booleans, coordinated through the plugin (see setNightVision()/updateNightVisionLiveState()):
 * - Automatic: on = nightVision AUTOMATIC. Off = freezes whatever the On switch is currently
 *   (live-)showing as an explicit ON/OFF value, so turning off Automatic doesn't silently change
 *   the picture.
 * - On (manual): always sets nightVision to ON/OFF explicitly and turns Automatic off - pressing
 *   this is always an override. While Automatic is on, this switch's displayed state instead
 *   live-reflects the camera's actual current IR-cut state, fed by NIGHT sensor pushes - see the
 *   comment in handleSensorData() for how that's confirmed against the decompiled app.
 */
class NanitNightVisionSwitch extends ScryptedDeviceBase implements OnOff {
    on?: boolean;

    constructor(
        public plugin: NanitCameraPlugin,
        nativeId: string,
        public readonly cameraNativeId: string,
        public readonly kind: 'automatic' | 'on',
    ) {
        super(nativeId);
    }

    async turnOn(): Promise<void> {
        await this.plugin.setNightVision(this.cameraNativeId, this.kind, true);
    }

    async turnOff(): Promise<void> {
        await this.plugin.setNightVision(this.cameraNativeId, this.kind, false);
    }

    /** Pulls the current value from the camera - called on first load so the switch doesn't start undefined. */
    async refresh(): Promise<void> {
        const settings = await this.plugin.fetchCameraSettings(this.cameraNativeId);
        if (!settings?.nightVision)
            return;
        if (this.kind === 'automatic')
            this.on = settings.nightVision === 'AUTOMATIC';
        else
            this.on = settings.nightVision === 'ON';
    }
}

const SPEAKER_VOLUME_SLUG = 'speakervolume';

/**
 * Speaker volume (Settings.volume), exposed via AudioVolumeControl - the proper interface for this,
 * only available once the SDK dependency was upgraded (it doesn't exist in the SDK version this
 * plugin was pinned to before that). Only the 'speaker' key is populated - this camera's protocol
 * has no separate microphone/intercom volume *level*; mic mute is a boolean (micMuteOn), already
 * its own child switch, not a level this interface would represent.
 *
 * volume's real-world scale isn't confirmed against a live camera - same caveat as nightLightBr's in
 * NanitNightLightDevice - this assumes it's already 0-100 and passes the value straight through.
 */
class NanitSpeakerVolumeDevice extends ScryptedDeviceBase implements AudioVolumeControl {
    audioVolumes?: AudioVolumes;

    constructor(public plugin: NanitCameraPlugin, nativeId: string, public readonly cameraNativeId: string) {
        super(nativeId);
    }

    async setAudioVolumes(audioVolumes: AudioVolumes): Promise<void> {
        if (typeof audioVolumes.speaker !== 'number')
            return;
        await this.plugin.updateCameraSettings(this.cameraNativeId, { volume: audioVolumes.speaker });
        this.audioVolumes = { speaker: audioVolumes.speaker };
    }

    /** Pulls the current value from the camera - called on first load so it doesn't start undefined. */
    async refresh(): Promise<void> {
        const settings = await this.plugin.fetchCameraSettings(this.cameraNativeId);
        if (typeof settings?.volume === 'number')
            this.audioVolumes = { speaker: settings.volume };
    }
}

const SPEAKER_VOLUME_LIGHT_SLUG = 'speakervolume-light';

/**
 * Same underlying Settings.volume field as NanitSpeakerVolumeDevice above, but exposed as a
 * dimmable Light (OnOff + Brightness) instead of AudioVolumeControl - purely a HomeKit workaround.
 * Apple's Home app doesn't render a standalone Service.Speaker outside TV/AirPlay contexts (the
 * "correct" AudioVolumeControl interface is confirmed invisible there), but Lightbulb+Brightness
 * is proven working (same trick NanitNightLightDevice already uses). Deliberately a separate
 * device from NanitSpeakerVolumeDevice, not dual interfaces on one device, so this stays
 * MQTT/HA-invisible by default (no extension enabled on it) without touching the already-working
 * AudioVolumeControl -> number entity in the mqtt fork.
 */
class NanitSpeakerVolumeLightDevice extends ScryptedDeviceBase implements OnOff, Brightness {
    on?: boolean;
    brightness?: number;

    constructor(public plugin: NanitCameraPlugin, nativeId: string, public readonly cameraNativeId: string) {
        super(nativeId);
    }

    async turnOn(): Promise<void> {
        await this.setBrightness(this.brightness && this.brightness > 0 ? this.brightness : 100);
    }

    async turnOff(): Promise<void> {
        await this.setBrightness(0);
    }

    async setBrightness(brightness: number): Promise<void> {
        await this.plugin.updateCameraSettings(this.cameraNativeId, { volume: brightness });
        this.brightness = brightness;
        this.on = brightness > 0;
    }

    /** Pulls the current value from the camera - called on first load so the light doesn't start undefined. */
    async refresh(): Promise<void> {
        const settings = await this.plugin.fetchCameraSettings(this.cameraNativeId);
        if (typeof settings?.volume === 'number') {
            this.brightness = settings.volume;
            this.on = settings.volume > 0;
        }
    }
}

class NanitCameraPlugin extends ScryptedDeviceBase implements DeviceProvider, Settings, DeviceCreator {
    devices = new Map<string, NanitCameraDevice>();
    settingSwitches = new Map<string, NanitSettingSwitch>();
    nightLightDevices = new Map<string, NanitNightLightDevice>();
    nightVisionSwitches = new Map<string, NanitNightVisionSwitch>();
    /** Best-known "IR currently engaged" state per camera nativeId, fed by NIGHT sensor pushes. */
    nightVisionLiveOn = new Map<string, boolean>();
    speakerVolumeDevices = new Map<string, NanitSpeakerVolumeDevice>();
    speakerVolumeLightDevices = new Map<string, NanitSpeakerVolumeLightDevice>();
    access_token = '';
    mfa_token = '';
    failedCount = 0;

    private _timestampedConsole?: Console;
    get console(): Console {
        if (!this._timestampedConsole)
            this._timestampedConsole = withTimestamps(super.console);
        return this._timestampedConsole;
    }

    cameraUidByNativeId = new Map<string, string>();
    controlConnections = new Map<string, NanitControlConnection>();
    teardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
    pendingLocalStreamRequests = new Map<string, Promise<string | undefined>>();
    rtmpServer?: LocalRtmpServer;
    twoWayAudioProcesses = new Map<string, ChildProcessWithoutNullStreams>();
    twoWayAudioSessionIds = new Map<string, string>();
    pendingTwoWayAudioRequests = new Map<string, Promise<void>>();

    settingsStorage = new StorageSettings(this, {
        email: {
            title: 'Email',
            onPut: async () => this.clearAndTrySyncDevices(),
        },
        password: {
            title: 'Password',
            type: 'password',
            onPut: async () => this.clearAndTrySyncDevices(),
        },
        twoFactorCode: {
            title: 'Two Factor Code',
            description: 'Optional: If 2 factor is enabled on your account, enter the code sent to your email or phone number.',
            type: "string",
            onPut: async (oldValue, newValue) => {
                await this.tryLogin(newValue);
                await this.syncDevices(0);
            },
            noStore: true,
        },
        refresh_token: {
            title: 'refresh_token'
        },
        access_token: {
            title: 'access_token'
        },
        expiration: {
            title: 'expiration',
            onPut: async () => this.syncDevices(0),
        },
        localStreamingEnabled: {
            title: 'Enable Local Streaming',
            description: 'When possible, receive the camera\'s video directly on the local network instead of round-tripping through Nanit\'s cloud relay. Requires "Local Stream Host" below and a firewall rule allowing the camera to reach this host. Falls back to the existing cloud stream automatically if local streaming cannot be established.',
            type: 'boolean',
            defaultValue: true,
            onPut: async () => this.restartRtmpServer(),
        },
        localStreamHost: {
            title: 'Local Stream Host',
            description: 'LAN IP address of this Scrypted host, as reachable by the camera (they may be on different VLANs/subnets). Leave blank to use the first address from Settings > General > "Scrypted Server Addresses".',
            type: 'string',
            combobox: true,
            onGet: async () => {
                const addresses = await sdk.endpointManager.getLocalAddresses() ?? [];
                return {
                    choices: addresses,
                    placeholder: addresses[0],
                };
            },
        },
        localStreamPort: {
            title: 'Local Stream Port',
            description: 'TCP port the local RTMP listener binds to, and that the camera is told to publish to.',
            type: 'number',
            defaultValue: 1935,
            onPut: async () => this.restartRtmpServer(),
        },
        localStreamTimeout: {
            title: 'Local Stream Confirm Timeout (ms)',
            description: 'How long to wait for the camera to start publishing locally before falling back to the cloud stream for this view request. A cold start (fresh control connection, e.g. right after a plugin restart) can take longer than a warm one - keep this generous, since timing out unnecessarily means paying for a slow cloud fallback on top of this wait.',
            type: 'number',
            defaultValue: 8000,
        },
        verboseLogging: {
            title: 'Verbose Logging',
            description: 'Off (default): only state-transition/meaningful events are logged (login, LOCAL vs CLOUD stream decisions, publisher connect/disconnect, device mode changes, warnings). On: also logs high-frequency framework-level scaffolding (every getDevice() call, every device event, every device sync) - noisy, only useful when actively debugging.',
            type: 'boolean',
            defaultValue: false,
        },
    });

    get verboseLogging(): boolean {
        return !!this.settingsStorage.values.verboseLogging;
    }

    constructor() {
        super();
        this.console.log("calling syncDevices from constructor")
        this.syncDevices(0);
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'name',
                title: 'Name',
            },
            {
                key: 'baby_uid',
                title: 'baby_uid',
            }
        ];
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const nativeId = settings.baby_uid?.toString();

        await deviceManager.onDeviceDiscovered({
            nativeId,
            type: ScryptedDeviceType.Camera,
            interfaces: [
                ScryptedInterface.VideoCamera,
                ScryptedInterface.Camera,
                ScryptedInterface.Intercom,
                ScryptedInterface.Settings,
                ScryptedInterface.Battery,
                ScryptedInterface.Reboot,
                ScryptedInterface.DeviceProvider,
            ],
            name: settings.name?.toString(),
        });
        return nativeId;
    }

    onDeviceEvent(eventInterface: string, eventData: any): Promise<void> {
        if (this.verboseLogging)
            this.console.log("Device Event occured " + eventInterface)
        return Promise.resolve();
    }

    clearAndTrySyncDevices() {
        this.console.log("clearAndTrySyncDevices called");
        this.access_token = '';
        this.settingsStorage.putSetting("access_token", '');
        this.syncDevices(0);
    }

    async clearAndLogin() {
        this.console.log("clearAndLogin called");
        this.access_token = '';
        this.settingsStorage.putSetting("access_token", '');
        return this.tryLogin('');
    }

    // Plugin start fans out several concurrent callers that all just want "a valid access token"
    // (syncDevices, ensureLocalStream's camera_uid lookup, the control connection's auth callback,
    // etc). Without sharing the in-flight attempt, each independently hits Nanit's login/babies
    // endpoints at once, which measurably slowed down the cold-start local-stream path. Only the
    // plain "just make sure we're logged in" call (twoFactorCode omitted entirely) is deduped -
    // an explicit code (including clearAndLogin()'s forced-relogin call with '') is a distinct,
    // one-off action and must never silently piggyback on an unrelated in-flight attempt that
    // captured a stale token before it was cleared.
    private tryLoginPromise?: Promise<void>;

    async tryLogin(twoFactorCode?: string): Promise<void> {
        if (twoFactorCode === undefined) {
            if (!this.tryLoginPromise)
                this.tryLoginPromise = this.tryLoginInternal(twoFactorCode).finally(() => this.tryLoginPromise = undefined);
            return this.tryLoginPromise;
        }
        return this.tryLoginInternal(twoFactorCode);
    }

    private async tryLoginInternal(twoFactorCode?: string) {
        this.console.log("trying login...");

        const settings: Setting[] = await this.getSettings();
        const email: String = this.settingsStorage.getItem("email");
        const password: String = this.settingsStorage.getItem("password");
        let saved_access_token = this.settingsStorage.getItem("access_token")
        const expiration = this.settingsStorage.getItem("expiration")
        const refresh_token = this.settingsStorage.getItem("refresh_token")

        if (saved_access_token) {
            this.access_token = saved_access_token;
        }

        if (!email || !password) {
            this.console.log("Email and password required");
            throw new Error("Email and password required");
            return;
        }
        if ( this.access_token && expiration > Date.now()) {
            //we already have a good access token that isn't expired
            this.console.log("Access Token Already Exists and is not expired. Going to call babies api to ensure we are logged in")
            //verify we are actually logged in
            const authenticatedConfig:AxiosRequestConfig = {
                headers:{
                  "nanit-api-version": 1,
                  "Authorization": "Bearer " +  this.access_token
                },
                validateStatus: function (status) {
                    return (status >= 200 && status < 300) || status == 401; // default
                }
            };



            return axios.get("https://api.nanit.com/babies", authenticatedConfig).then((response) => {
                //we are authenticated nothing to do

                if (response.status == 401 &&  this.failedCount < 2) {
                    this.console.log('failed to auth but received 401 so will clear tokens and try again')
                    this.failedCount++;
                    return this.clearAndLogin()
                } else if (this.failedCount > 2){
                    return Promise.reject("Exceeded fail count");
                } else {
                    this.failedCount = 0;
                    this.console.log("Confirmed we are authenticated. Stream should Work")
                }
            }).catch((error) => {
                if (error.response.status == 401 &&  this.failedCount < 2) {
                    this.console.log('failed to auth but received 401 so will clear tokens and try again')
                    this.failedCount++;
                    return this.clearAndLogin()
                } else {
                    throw new Error("Failed to authenticate")
                }
            })
        }

        const config = {
            headers:{
              "nanit-api-version": 1
            }
          };
        if (refresh_token) {
            this.console.log("we have a refresh token...calling the token refresh api");
            return axios.post("https://api.nanit.com/tokens/refresh",{"refresh_token":refresh_token}, config).then((response) => {
                this.console.log("Received new access token");
                this.failedCount = 0;
                this.access_token = response.data.access_token;
                this.settingsStorage.putSetting("access_token", response.data.access_token)
                this.settingsStorage.putSetting("refresh_token", response.data.refresh_token)
                this.settingsStorage.putSetting("expiration",  Date.now() + (1000 * 60 * 60 * 4))
            }).catch((error) => {
                this.console.log("Failed to talk to nanit"+ error);
            });
        }

        if (!twoFactorCode || ! this.mfa_token) {
            this.console.log("calling the login api without mfa. will need to call again to get access/refresh token");
            return axios.post("https://api.nanit.com/login",{"email":email,"password":password},config).then((response) => {

                this.console.log("Login successful. setting mfa token and will recall login")
                this.mfa_token = response.data.mfa_token;
            }).catch((error) => {
                this.mfa_token = error.response.data.mfa_token;
                if ( this.mfa_token) {
                    this.console.log("response from email/pass login:" + error.response)
                } else {
                    this.console.log("Failed to talk to nanit"+ error);
                }

            });
        }

        this.console.log("calling the login api with mfa to get access and refresh token");

        return axios.post("https://api.nanit.com/login",{"email":email,"password":password, "mfa_token":  this.mfa_token, "mfa_code": twoFactorCode},config).then((response) => {
            this.failedCount = 0;
                this.console.log("response from email/pass/mfa login. Received new access token and refresh token")
                this.access_token = response.data.access_token;
                this.settingsStorage.putSetting("access_token", response.data.access_token)
                this.settingsStorage.putSetting("refresh_token", response.data.refresh_token)
                this.settingsStorage.putSetting("expiration",  Date.now() + (1000 * 60 * 60 * 4))
           }).catch((error) => {
                this.console.log("Failed to talk to nanit"+ error);
                throw new Error(error.message)
           });

    }

    getSettings(): Promise<Setting[]> {
        return this.settingsStorage.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.settingsStorage.putSetting(key, value);
    }

    // Same rationale as tryLoginPromise above: syncDevices() and ensureLocalStream()'s camera_uid
    // lookup can both want the babies list at the same moment on plugin start.
    private fetchBabiesPromise?: Promise<NanitBaby[]>;

    private async fetchBabies(): Promise<NanitBaby[]> {
        if (!this.fetchBabiesPromise)
            this.fetchBabiesPromise = this.fetchBabiesInternal().finally(() => this.fetchBabiesPromise = undefined);
        return this.fetchBabiesPromise;
    }

    private async fetchBabiesInternal(): Promise<NanitBaby[]> {
        this.console.log("fetching /babies");
        await this.tryLogin();
        const config = {
            headers:{
              "nanit-api-version": 1,
              "Authorization": "Bearer " +  this.access_token
            }
        };

        const babies: NanitBaby[] = (await axios.get("https://api.nanit.com/babies", config)).data.babies;
        for (const baby of babies)
            this.cameraUidByNativeId.set(baby.uid, baby.camera_uid);
        return babies;
    }

    async syncDevices(duration: number) {
        if (this.verboseLogging)
            this.console.log("Sync Devices")
        const babies = await this.fetchBabies();
        const cameraDevices: Device[] = [];
        const childDevicesByCamera = new Map<string, Device[]>();
        for (const camera of babies) {
            const nativeId = camera.uid;
            const interfaces = [
                ScryptedInterface.Camera,
                ScryptedInterface.VideoCamera,
                ScryptedInterface.Intercom,
                ScryptedInterface.Settings,
                ScryptedInterface.Battery,
                ScryptedInterface.Reboot,
                ScryptedInterface.DeviceProvider,
            ];

            const device: Device = {
                info: {
                    model: 'Nanit Cam',
                    manufacturer: 'Nanit',
                },
                nativeId,
                name: camera.name,

                type: ScryptedDeviceType.Camera,
                interfaces,
            };
            cameraDevices.push(device);

            const childDevices: Device[] = [];

            // Unprefixed - these are child devices of the camera (Scrypted's own UI nests them
            // under it, HomeKit merges them onto its accessory, and HA's MQTT discovery groups
            // them under it via via_device), so repeating the camera's name would be redundant
            // everywhere that matters. The one tradeoff: a second Nanit camera would produce
            // identically-named children, disambiguated only by that HA/Scrypted/HomeKit nesting,
            // not by the name itself.
            for (const spec of BOOLEAN_SETTING_CHILD_DEVICES) {
                childDevices.push({
                    nativeId: `${nativeId}:${spec.slug}`,
                    name: spec.name,
                    type: ScryptedDeviceType.Switch,
                    interfaces: [ScryptedInterface.OnOff],
                });
            }

            childDevices.push({
                nativeId: `${nativeId}:${NIGHT_LIGHT_SLUG}`,
                name: 'Night Light',
                type: ScryptedDeviceType.Light,
                interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Brightness],
            });

            childDevices.push({
                nativeId: `${nativeId}:${NIGHT_VISION_AUTO_SLUG}`,
                name: 'Night Vision Automatic',
                type: ScryptedDeviceType.Switch,
                interfaces: [ScryptedInterface.OnOff],
            });
            childDevices.push({
                nativeId: `${nativeId}:${NIGHT_VISION_ON_SLUG}`,
                name: 'Night Vision On',
                type: ScryptedDeviceType.Switch,
                interfaces: [ScryptedInterface.OnOff],
            });

            childDevices.push({
                nativeId: `${nativeId}:${SPEAKER_VOLUME_SLUG}`,
                name: 'Speaker Volume',
                type: ScryptedDeviceType.Speaker,
                interfaces: [ScryptedInterface.AudioVolumeControl],
            });

            // HomeKit-only workaround for the AudioVolumeControl device above not rendering in
            // Home app - see NanitSpeakerVolumeLightDevice. Same display name is fine; it's a
            // different device (different nativeId/type), distinguishable in Scrypted's own UI by
            // icon/type, and MQTT-invisible unless its extension is separately enabled.
            childDevices.push({
                nativeId: `${nativeId}:${SPEAKER_VOLUME_LIGHT_SLUG}`,
                name: 'Speaker Volume',
                type: ScryptedDeviceType.Light,
                interfaces: [ScryptedInterface.OnOff, ScryptedInterface.Brightness],
            });

            childDevicesByCamera.set(nativeId, childDevices);
        }

        // Cameras are registered first, in their own manifest (implicitly provided by this
        // plugin's own root device). Each camera's children are then pushed in a SEPARATE
        // onDevicesChanged call scoped to that camera via the manifest-level providerNativeId -
        // onDevicesChanged only respects providerNativeId at the manifest level, overwriting
        // it on every individual device in the call (see @scrypted/server's
        // PluginHostAPI.onDevicesChanged), so a per-device providerNativeId field is silently
        // ignored when devices are batched into one shared call. Splitting into one call per
        // camera is what actually establishes each child's providerId as the camera's device
        // id (rather than this plugin's own root device id), which HomeKit's DeviceProvider
        // child-merging (getChildDevices) depends on to find them.
        await deviceManager.onDevicesChanged({
            devices: cameraDevices,
        });

        for (const [nativeId, childDevices] of childDevicesByCamera) {
            await deviceManager.onDevicesChanged({
                providerNativeId: nativeId,
                devices: childDevices,
            });
        }

        if (this.verboseLogging)
            this.console.log('discovered devices');
    }

    // Recomputes and re-publishes a single device's declared interfaces after its
    // "Keep Local Stream Connected" setting changes: dropping Battery once we no longer
    // behave like an on-demand-only camera, and only claiming MotionSensor/AudioSensor once a
    // persistent control connection actually exists to feed them.
    async applyDeviceMode(nativeId: string) {
        const device = this.devices.get(nativeId);
        if (!device)
            return;

        // Battery is declared unless we're both in persistent mode AND local video is *currently*
        // confirmed alive - matches the original plugin's convention (Battery = on-demand/low-
        // footprint) and is also what Rebroadcast's prebuffer-mixin
        // (plugins/prebuffer-mixin/src/main.ts, shouldDisableBatteryPrebuffer()) keys off of
        // first: it returns null (falsy - prebuffer not disabled) the moment Battery isn't in the
        // interfaces list at all, without even looking at Charger/chargeState/batteryLevel. So no
        // Charger interface is needed here - it only matters for "Battery present but still want
        // continuous prebuffer", which isn't our case. batteryLevel is set unconditionally since
        // HomeKit's battery.ts only checks for the Battery interface's presence, not the level.
        //
        // Deliberately checking live RTMP health here, not just the persistentLocalStream setting:
        // if local streaming is down for an extended stretch (camera unreachable, firewall rule
        // dropped, etc) while persistent mode is on, telling Rebroadcast "no Battery, prebuffer me
        // continuously" would make it keep a prebuffer session alive by repeatedly calling our
        // getVideoStream() - each of which would silently fall back to the cloud URL, and
        // Rebroadcast would hold *that* ffmpeg process open continuously. That's exactly the
        // persistent-cloud-connection behavior this plugin exists to avoid, just reintroduced
        // through prebuffering instead of our own code. This is recomputed reactively whenever
        // local health changes (see the LocalRtmpServer 'alive'/'unhealthy' listeners below), not
        // just when the setting itself is toggled.
        const localHealthy = this.rtmpServer?.isAlive(nativeId) ?? false;
        const allowContinuousPrebuffer = device.persistentLocalStream && localHealthy;

        const interfaces = [
            ScryptedInterface.Camera,
            ScryptedInterface.VideoCamera,
            ScryptedInterface.Intercom,
            ScryptedInterface.Settings,
            ScryptedInterface.Reboot,
            ScryptedInterface.DeviceProvider,
        ];
        if (device.persistentLocalStream)
            // MotionSensor/AudioSensor are only ever fed by the control channel's sensor-data
            // pushes while a control connection is kept open continuously - that's independent of
            // whether local *video* happens to be healthy right now, so this stays tied to the
            // setting alone, unlike the Battery decision above.
            interfaces.push(ScryptedInterface.MotionSensor, ScryptedInterface.AudioSensor);
        if (!allowContinuousPrebuffer)
            interfaces.push(ScryptedInterface.Battery);

        // Independent of persistentLocalStream by design - "Report Temperature/Humidity" can keep
        // the control channel open purely for sensor telemetry even when local video streaming is
        // only requested on demand. See ensureSensorConnection().
        if (device.reportClimateSensors)
            interfaces.push(ScryptedInterface.Thermometer, ScryptedInterface.HumiditySensor);

        device.batteryLevel = 100;

        this.console.log(`[${nativeId}] applying device mode: persistentLocalStream=${device.persistentLocalStream}, reportClimateSensors=${device.reportClimateSensors}, interfaces=[${interfaces.join(', ')}]`);
        await deviceManager.onDeviceDiscovered({
            nativeId,
            type: ScryptedDeviceType.Camera,
            interfaces,
            name: device.name,
        });

        this.console.log(`[${nativeId}] device mode applied`);

        if (device.persistentLocalStream) {
            this.cancelScheduledTeardown(nativeId);
            this.ensureLocalStream(nativeId).catch(err =>
                this.console.warn(`failed to start persistent local stream for ${nativeId}: ${err.message}`));
        }
        else if (device.reportClimateSensors) {
            this.cancelScheduledTeardown(nativeId);
            this.ensureSensorConnection(nativeId).catch(err =>
                this.console.warn(`[${nativeId}] failed to start sensor-only control connection: ${err.message}`));
        }
        else if (!this.rtmpServer?.subscriberCount(nativeId)) {
            // Neither mode wants the connection kept alive, and nobody's currently watching -
            // nothing will otherwise trigger the on-demand teardown (that normally fires off a
            // donePlay event), so schedule it directly.
            this.scheduleTeardown(nativeId);
        }
    }

    async getDevice(nativeId: string) {
        if (this.verboseLogging)
            this.console.log("get device with id " + nativeId)

        const booleanSpec = BOOLEAN_SETTING_CHILD_DEVICES.find(spec => nativeId.endsWith(`:${spec.slug}`));
        if (booleanSpec) {
            if (!this.settingSwitches.has(nativeId)) {
                const cameraNativeId = nativeId.slice(0, -(booleanSpec.slug.length + 1));
                const child = new NanitSettingSwitch(this, nativeId, cameraNativeId, booleanSpec.settingsField, booleanSpec.invert);
                this.settingSwitches.set(nativeId, child);
                child.refresh().catch(err =>
                    this.console.warn(`[${nativeId}] failed to refresh initial state: ${err.message}`));
            }
            return this.settingSwitches.get(nativeId);
        }

        if (nativeId.endsWith(`:${NIGHT_LIGHT_SLUG}`)) {
            if (!this.nightLightDevices.has(nativeId)) {
                const cameraNativeId = nativeId.slice(0, -(NIGHT_LIGHT_SLUG.length + 1));
                const child = new NanitNightLightDevice(this, nativeId, cameraNativeId);
                this.nightLightDevices.set(nativeId, child);
                child.refresh().catch(err =>
                    this.console.warn(`[${nativeId}] failed to refresh initial state: ${err.message}`));
            }
            return this.nightLightDevices.get(nativeId);
        }

        const nightVisionKind = nativeId.endsWith(`:${NIGHT_VISION_AUTO_SLUG}`) ? 'automatic'
            : nativeId.endsWith(`:${NIGHT_VISION_ON_SLUG}`) ? 'on' : undefined;
        if (nightVisionKind) {
            if (!this.nightVisionSwitches.has(nativeId)) {
                const slug = nightVisionKind === 'automatic' ? NIGHT_VISION_AUTO_SLUG : NIGHT_VISION_ON_SLUG;
                const cameraNativeId = nativeId.slice(0, -(slug.length + 1));
                const child = new NanitNightVisionSwitch(this, nativeId, cameraNativeId, nightVisionKind);
                this.nightVisionSwitches.set(nativeId, child);
                child.refresh().catch(err =>
                    this.console.warn(`[${nativeId}] failed to refresh initial state: ${err.message}`));
            }
            return this.nightVisionSwitches.get(nativeId);
        }

        if (nativeId.endsWith(`:${SPEAKER_VOLUME_LIGHT_SLUG}`)) {
            if (!this.speakerVolumeLightDevices.has(nativeId)) {
                const cameraNativeId = nativeId.slice(0, -(SPEAKER_VOLUME_LIGHT_SLUG.length + 1));
                const child = new NanitSpeakerVolumeLightDevice(this, nativeId, cameraNativeId);
                this.speakerVolumeLightDevices.set(nativeId, child);
                child.refresh().catch(err =>
                    this.console.warn(`[${nativeId}] failed to refresh initial state: ${err.message}`));
            }
            return this.speakerVolumeLightDevices.get(nativeId);
        }

        if (nativeId.endsWith(`:${SPEAKER_VOLUME_SLUG}`)) {
            if (!this.speakerVolumeDevices.has(nativeId)) {
                const cameraNativeId = nativeId.slice(0, -(SPEAKER_VOLUME_SLUG.length + 1));
                const child = new NanitSpeakerVolumeDevice(this, nativeId, cameraNativeId);
                this.speakerVolumeDevices.set(nativeId, child);
                child.refresh().catch(err =>
                    this.console.warn(`[${nativeId}] failed to refresh initial state: ${err.message}`));
            }
            return this.speakerVolumeDevices.get(nativeId);
        }

        if (!this.devices.has(nativeId)) {
            const camera = new NanitCameraDevice(this, nativeId);

            this.devices.set(nativeId, camera);

            // syncDevices() always (re)registers devices with the on-demand/Battery interface set
            // regardless of the persisted "Keep Local Stream Connected" setting - without this,
            // a plugin restart would silently revert a persistent-mode camera's declared
            // interfaces back to Battery-only (dropping MotionSensor/AudioSensor) until the user
            // happened to toggle the setting again, which is the only other thing that calls
            // applyDeviceMode(). That mismatch is also why HomeKit Secure Video can disappear after
            // a restart+re-pair: HomeKit negotiates accessory capabilities, including whether it
            // has a motion sensor, at pairing time.
            this.applyDeviceMode(nativeId).catch(err =>
                this.console.warn(`[${nativeId}] failed to apply device mode on load: ${err.message}`));
        }
        return this.devices.get(nativeId);
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        if (this.settingSwitches.has(nativeId)) {
            this.settingSwitches.delete(nativeId);
            return;
        }
        if (this.nightLightDevices.has(nativeId)) {
            this.nightLightDevices.delete(nativeId);
            return;
        }
        if (this.nightVisionSwitches.has(nativeId)) {
            this.nightVisionSwitches.delete(nativeId);
            return;
        }
        if (this.speakerVolumeDevices.has(nativeId)) {
            this.speakerVolumeDevices.delete(nativeId);
            return;
        }
        if (this.speakerVolumeLightDevices.has(nativeId)) {
            this.speakerVolumeLightDevices.delete(nativeId);
            return;
        }
        this.cancelScheduledTeardown(nativeId);
        this.controlConnections.get(nativeId)?.dispose();
        this.controlConnections.delete(nativeId);
        this.devices.delete(nativeId);
    }

    // ---- Local streaming ----

    private getRtmpServer(): LocalRtmpServer {
        if (!this.rtmpServer) {
            const port = Number(this.settingsStorage.values.localStreamPort) || 1935;
            const server = new LocalRtmpServer(port, this.console);

            server.on('alive', (streamKey: string) => {
                // Local video just started (or resumed) publishing - re-evaluate whether it's now
                // safe to tell Rebroadcast's prebuffer-mixin it can prebuffer this camera
                // continuously (see the comment on the Battery decision in applyDeviceMode()).
                this.applyDeviceMode(streamKey).catch(err =>
                    this.console.warn(`[${streamKey}] failed to update device mode after becoming alive: ${err.message}`));
            });

            server.on('unhealthy', (streamKey: string) => {
                const device = this.devices.get(streamKey);
                if (!device)
                    return;
                // Camera's publish connection dropped. Recompute interfaces immediately so Battery
                // comes back the moment local health changes, not just when the "Keep Local Stream
                // Connected" setting itself is toggled - for persistent mode this also re-requests
                // the redirect as a side effect (see applyDeviceMode()), so only the on-demand
                // case with an active viewer needs its own explicit retry here.
                this.applyDeviceMode(streamKey).catch(err =>
                    this.console.warn(`[${streamKey}] failed to update device mode after publisher drop: ${err.message}`));

                if (!device.persistentLocalStream && server.subscriberCount(streamKey) > 0) {
                    this.console.log(`[${streamKey}] local stream: publisher dropped, re-requesting for active viewer`);
                    this.ensureLocalStream(streamKey).catch(err =>
                        this.console.warn(`[${streamKey}] local stream: failed to re-establish after drop: ${err.message}`));
                }
                else if (!device.persistentLocalStream) {
                    this.console.log(`[${streamKey}] local stream: publisher dropped, no active viewers - not re-requesting`);
                }
            });

            server.on('subscribers', (streamKey: string, count: number) => {
                if (count > 0)
                    this.cancelScheduledTeardown(streamKey);
                else
                    this.scheduleTeardown(streamKey);
            });

            server.start();
            this.rtmpServer = server;
        }
        return this.rtmpServer;
    }

    private restartRtmpServer() {
        if (this.rtmpServer) {
            this.rtmpServer.stop();
            this.rtmpServer = undefined;
        }
    }

    private getControlConnection(nativeId: string, cameraUid: string): NanitControlConnection {
        let connection = this.controlConnections.get(nativeId);
        if (!connection) {
            connection = new NanitControlConnection(cameraUid, async () => {
                await this.tryLogin();
                return this.access_token;
            }, {
                log: message => this.console.log(message),
                warn: message => this.console.warn(message),
                error: message => this.console.error(message),
                verbose: message => { if (this.verboseLogging) this.console.log(message); },
            });
            connection.onSensorData = sensor => this.devices.get(nativeId)?.handleSensorData(sensor);
            this.controlConnections.set(nativeId, connection);
        }
        return connection;
    }

    private scheduleTeardown(nativeId: string) {
        const device = this.devices.get(nativeId);
        if (device?.persistentLocalStream)
            return;
        this.cancelScheduledTeardown(nativeId);
        this.console.log(`[${nativeId}] local stream: no viewers, scheduling teardown in ${ON_DEMAND_TEARDOWN_GRACE_MS}ms if nothing else claims it first`);
        this.teardownTimers.set(nativeId, setTimeout(async () => {
            this.teardownTimers.delete(nativeId);
            const connection = this.controlConnections.get(nativeId);
            if (!connection)
                return;
            this.console.log(`[${nativeId}] local stream: teardown grace period elapsed, stopping local publish`);
            const server = this.rtmpServer;
            const host = await this.getLocalStreamHost();
            const publishUrl = server && host ? server.getPublishUrl(host, nativeId) : undefined;
            const stop = publishUrl ? connection.requestLocalStreaming(publishUrl, 'STOPPED') : Promise.resolve();
            stop
                .catch(err => this.console.warn(`failed to send STOPPED for ${nativeId}: ${err.message}`))
                .finally(() => {
                    // "Report Temperature/Humidity" independently needs this same connection kept
                    // alive even with no video viewers - only stop the local video publish above,
                    // leave the control channel itself open in that case.
                    if (this.devices.get(nativeId)?.reportClimateSensors) {
                        this.console.log(`[${nativeId}] local stream: keeping control connection open for climate sensor reporting`);
                        return;
                    }
                    connection.dispose();
                    this.controlConnections.delete(nativeId);
                });
        }, ON_DEMAND_TEARDOWN_GRACE_MS));
    }

    private cancelScheduledTeardown(nativeId: string) {
        const timer = this.teardownTimers.get(nativeId);
        if (timer) {
            clearTimeout(timer);
            this.teardownTimers.delete(nativeId);
            this.console.log(`[${nativeId}] local stream: scheduled teardown cancelled`);
        }
    }

    // Falls back to Scrypted's own "Scrypted Server Addresses" (Settings > General) when the
    // plugin's own Local Stream Host override is left blank, since that list already reflects
    // the addresses this host is meant to be reached at.
    private async getLocalStreamHost(): Promise<string | undefined> {
        const configured = this.settingsStorage.values.localStreamHost as string;
        if (configured)
            return configured;
        const addresses = await sdk.endpointManager.getLocalAddresses();
        return addresses?.[0];
    }

    private async getCameraUid(nativeId: string): Promise<string | undefined> {
        let cameraUid = this.cameraUidByNativeId.get(nativeId);
        if (!cameraUid) {
            await this.fetchBabies();
            cameraUid = this.cameraUidByNativeId.get(nativeId);
        }
        return cameraUid;
    }

    /**
     * Ensures the control channel is connected purely for sensor telemetry (motion/temperature/
     * humidity), independent of local video streaming - "Report Temperature/Humidity" can be on
     * while "Keep Local Stream Connected" is off, in which case this is the only thing keeping
     * the control WebSocket open. Never touches the local RTMP server or sends PUT_STREAMING;
     * the camera starts pushing sensor data on its own once GET_SENSOR_DATA has been sent, which
     * NanitControlConnection already does automatically as soon as it connects.
     */
    private async ensureSensorConnection(nativeId: string): Promise<void> {
        const cameraUid = await this.getCameraUid(nativeId);
        if (!cameraUid) {
            this.console.warn(`[${nativeId}] climate sensors: no camera_uid known, cannot connect`);
            return;
        }
        const connection = this.getControlConnection(nativeId, cameraUid);
        try {
            await connection.ensureConnected();
        }
        catch (err) {
            this.console.warn(`[${nativeId}] climate sensors: failed to connect: ${(err as Error).message}`);
        }
    }

    /**
     * Attempts to get the camera to publish its RTMP stream directly to this host's local RTMP
     * listener. Returns the local rtmp:// URL Scrypted's ffmpeg should read from once
     * publishing is confirmed, or undefined if local streaming is disabled, unconfigured, or
     * doesn't come up within the configured timeout - callers should fall back to the cloud
     * stream URL in that case.
     *
     * Concurrent callers for the same camera (e.g. Scrypted prefetching a snapshot for several
     * consumers at once on plugin load) share a single in-flight attempt instead of each firing
     * their own PUT_STREAMING request - independent concurrent requests are exactly what tripped
     * Nanit's "too many mobile app connections" limit in practice.
     */
    async ensureLocalStream(nativeId: string): Promise<string | undefined> {
        const pending = this.pendingLocalStreamRequests.get(nativeId);
        if (pending)
            return pending;

        const promise = this.ensureLocalStreamInternal(nativeId).finally(() => {
            this.pendingLocalStreamRequests.delete(nativeId);
        });
        this.pendingLocalStreamRequests.set(nativeId, promise);
        return promise;
    }

    private async ensureLocalStreamInternal(nativeId: string): Promise<string | undefined> {
        const prefix = `[${nativeId}] local stream:`;

        if (!this.settingsStorage.values.localStreamingEnabled) {
            this.console.log(`${prefix} disabled in plugin settings, skipping (will use cloud)`);
            return undefined;
        }

        const host = await this.getLocalStreamHost();
        if (!host) {
            this.console.warn(`${prefix} no Local Stream Host configured, and none could be auto-detected from Scrypted Server Addresses - falling back to cloud`);
            return undefined;
        }

        const cameraUid = await this.getCameraUid(nativeId);
        if (!cameraUid) {
            this.console.warn(`${prefix} no camera_uid known for this device - falling back to cloud`);
            return undefined;
        }

        const rtmp = this.getRtmpServer();
        this.cancelScheduledTeardown(nativeId);

        if (rtmp.isAlive(nativeId)) {
            this.console.log(`${prefix} already publishing locally, reusing existing stream`);
            return rtmp.getLocalPlaybackUrl(nativeId);
        }

        const timeoutMs = Number(this.settingsStorage.values.localStreamTimeout) || 8000;
        const connection = this.getControlConnection(nativeId, cameraUid);
        const publishUrl = rtmp.getPublishUrl(host, nativeId);

        this.console.log(`${prefix} requesting camera to publish to ${publishUrl} (camera_uid ${cameraUid}, timeout ${timeoutMs}ms)`);
        const alivePromise = rtmp.waitForAlive(nativeId, timeoutMs);
        connection.requestLocalStreaming(publishUrl, 'STARTED').catch(err =>
            this.console.warn(`${prefix} PUT_STREAMING request failed: ${err.message}`));

        const becameAlive = await alivePromise;
        if (becameAlive) {
            this.console.log(`${prefix} camera is now publishing locally`);
            return rtmp.getLocalPlaybackUrl(nativeId);
        }

        this.console.warn(`${prefix} camera did not start publishing within ${timeoutMs}ms - falling back to cloud`);
        return undefined;
    }

    // ---- Reboot ----

    async requestCameraReboot(nativeId: string): Promise<void> {
        const cameraUid = await this.getCameraUid(nativeId);
        if (!cameraUid)
            throw new Error(`[${nativeId}] reboot: no camera_uid known for this device`);
        const connection = this.getControlConnection(nativeId, cameraUid);
        await connection.requestReboot();
    }

    // ---- Camera Settings (night vision, night light, sleep mode, status LED, mic mute, volume) ----
    // Shared by the boolean child switches, the night light dimmer, and the night vision switches -
    // all of these are just different views onto the same camera Settings message.

    async fetchCameraSettings(cameraNativeId: string): Promise<DecodedSettings | undefined> {
        const cameraUid = await this.getCameraUid(cameraNativeId);
        if (!cameraUid)
            throw new Error(`[${cameraNativeId}] settings: no camera_uid known for this device`);
        const connection = this.getControlConnection(cameraNativeId, cameraUid);
        return connection.requestSettings();
    }

    async updateCameraSettings(cameraNativeId: string, partial: DecodedSettings): Promise<void> {
        const cameraUid = await this.getCameraUid(cameraNativeId);
        if (!cameraUid)
            throw new Error(`[${cameraNativeId}] settings: no camera_uid known for this device`);
        const connection = this.getControlConnection(cameraNativeId, cameraUid);
        await connection.updateSettings(partial);
    }

    async updateCameraBooleanSetting(cameraNativeId: string, field: 'sleepMode' | 'statusLightOn' | 'micMuteOn', value: boolean): Promise<void> {
        await this.updateCameraSettings(cameraNativeId, { [field]: value });
    }

    /**
     * Coordinates the Automatic/On night vision switch pair (see NanitNightVisionSwitch) - both
     * ultimately just set Settings.nightVision, but which value depends on the other switch's
     * current state, and both switches' displayed `on` need updating together since only one of
     * them caused this call.
     */
    async setNightVision(cameraNativeId: string, kind: 'automatic' | 'on', value: boolean): Promise<void> {
        const autoSwitch = this.nightVisionSwitches.get(`${cameraNativeId}:${NIGHT_VISION_AUTO_SLUG}`);
        const onSwitch = this.nightVisionSwitches.get(`${cameraNativeId}:${NIGHT_VISION_ON_SLUG}`);

        if (kind === 'automatic') {
            if (value) {
                await this.updateCameraSettings(cameraNativeId, { nightVision: 'AUTOMATIC' });
            }
            else {
                // Freeze whatever the On switch is currently (live-)showing as an explicit value,
                // rather than letting turning off Automatic silently change the picture.
                const frozen = onSwitch?.on ?? this.nightVisionLiveOn.get(cameraNativeId) ?? false;
                await this.updateCameraSettings(cameraNativeId, { nightVision: frozen ? 'ON' : 'OFF' });
                if (onSwitch)
                    onSwitch.on = frozen;
            }
            if (autoSwitch)
                autoSwitch.on = value;
        }
        else {
            // Manual override - always exits Automatic, matching how "manual" should behave.
            await this.updateCameraSettings(cameraNativeId, { nightVision: value ? 'ON' : 'OFF' });
            this.nightVisionLiveOn.set(cameraNativeId, value);
            if (onSwitch)
                onSwitch.on = value;
            if (autoSwitch)
                autoSwitch.on = false;
        }
    }

    /** Fed by NIGHT sensor pushes (handleSensorData()) - keeps the On switch's displayed state live while Automatic is engaged. */
    updateNightVisionLiveState(cameraNativeId: string, irEngaged: boolean) {
        this.nightVisionLiveOn.set(cameraNativeId, irEngaged);
        const autoSwitch = this.nightVisionSwitches.get(`${cameraNativeId}:${NIGHT_VISION_AUTO_SLUG}`);
        const onSwitch = this.nightVisionSwitches.get(`${cameraNativeId}:${NIGHT_VISION_ON_SLUG}`);
        if (autoSwitch?.on && onSwitch)
            onSwitch.on = irEngaged;
    }

    // ---- Two-way audio ----

    // Confirmed against real HomeKit behavior: startIntercom()/stopIntercom() are called once per
    // camera-view session (open/close), not once per tap of the Home app's talk button. Toggling
    // talk on/off mid-session never reaches this plugin at all - HomeKit just stops/resumes
    // feeding RTP packets into the local RTSP relay it already handed us in media, which we only
    // ever see indirectly as our own ffmpeg process stalling and resuming (visible in its verbose
    // progress log as a gap in timestamps and a "speed=" far below 1.0x right after). So a single
    // start/stop pair spanning several talk toggles is expected, not a sign anything was missed.
    //
    // Also confirmed: HomeKit runs one independent streaming session per paired controller (each
    // phone/HomeHub viewing this camera gets its own RTP session - see Scrypted's own HomeKit
    // plugin, camera-streaming.ts), and each one calls startIntercom()/stopIntercom() on this same
    // device independently with no coordination between them. Only one session's audio can
    // actually be flowing here at a time (this plugin, like every other Scrypted camera plugin
    // that implements Intercom - Ring, UniFi Protect, ONVIF, bticino - keeps a single shared
    // "current session" slot, not one per caller), so a second concurrent viewer starting an
    // intercom session silently tears down and replaces whatever the first one had going, with no
    // signal back to the first caller that it was pre-empted. This matches the de facto standard
    // across the whole Scrypted plugin ecosystem - nothing in Intercom's own interface definition
    // or HomeKit's session handling addresses concurrent callers, and no existing plugin does
    // anything more sophisticated - so it's left as-is rather than inventing a new pattern. A
    // single camera speaker can only usefully play one talker's audio at once anyway.

    /**
     * Starts publishing media (an Intercom audio source, e.g. HomeKit's own RTP mic bridge) to
     * the camera - the reverse of ensureLocalStream() above: there the camera publishes video to
     * us, here we publish audio and tell the camera where to connect and play it. Local-only for
     * now, with no cloud/remote fallback - unlike video, publishing audio through Nanit's own
     * relay hasn't been attempted, so this simply fails if local delivery isn't possible.
     *
     * Concurrent callers for the same device share the one in-flight attempt instead of each
     * spawning their own ffmpeg process and sending their own PUT_AUDIO_STREAMING - same reasoning
     * as ensureLocalStream()'s equivalent guard: independent concurrent starts would each publish
     * their own audio and hand the camera a different session ID, leaking whichever ffmpeg process
     * loses the race to have its state overwritten and leaving the camera uncertain which session
     * is actually current.
     */
    async startTwoWayAudio(nativeId: string, media: MediaObject): Promise<void> {
        const pending = this.pendingTwoWayAudioRequests.get(nativeId);
        if (pending) {
            this.console.log(`[${nativeId}] two-way audio: start already in flight, joining it instead of starting a duplicate session`);
            return pending;
        }

        const promise = this.startTwoWayAudioInternal(nativeId, media).finally(() => {
            this.pendingTwoWayAudioRequests.delete(nativeId);
        });
        this.pendingTwoWayAudioRequests.set(nativeId, promise);
        return promise;
    }

    private async startTwoWayAudioInternal(nativeId: string, media: MediaObject): Promise<void> {
        this.console.log(`[${nativeId}] two-way audio: starting`);
        await this.stopTwoWayAudio(nativeId);

        if (!this.settingsStorage.values.localStreamingEnabled)
            throw new Error(`[${nativeId}] two-way audio: local streaming is disabled in plugin settings`);

        const cameraUid = await this.getCameraUid(nativeId);
        if (!cameraUid)
            throw new Error(`[${nativeId}] two-way audio: no camera_uid known for this device`);
        const host = await this.getLocalStreamHost();
        if (!host)
            throw new Error(`[${nativeId}] two-way audio: no Local Stream Host configured`);

        const rtmp = this.getRtmpServer();
        const sessionId = randomUUID();
        const publishUrl = rtmp.getTwoWayAudioPublishUrl(nativeId);
        const playUrl = rtmp.getTwoWayAudioPlayUrl(host, nativeId);

        const ffmpegInput = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);
        const ffmpegPath = await mediaManager.getFFmpegPath();
        if (this.verboseLogging)
            this.console.log(`[${nativeId}] two-way audio: received ffmpeg input: ${JSON.stringify(ffmpegInput)}`);

        // ffmpegInput.inputArguments is a complete, ready-to-use ffmpeg input clause (includes its
        // own -i) - Scrypted's HomeKit plugin already terminates the SRTP session from the Home
        // app itself and re-serves the audio as a local RTSP stream, with the correct -acodec
        // (almost always Opus - Scrypted forces Opus over AAC-ELD for talkback by default) already
        // included. So the *input* codec here isn't something we choose or need to guess.
        //
        // The *output* format below (AAC/44100Hz/mono) is what we transcode to for the camera's
        // side - that part isn't confirmed for this direction specifically, but it's not a blind
        // guess either: the camera's own downstream audio (the RTMP video stream's audio track) is
        // aac/44100Hz/mono/24kbps, and Nanit's own two-way audio mic capture also records at
        // 44100Hz mono - both independently pointing at the same format, unlike the original 8kHz
        // guess this comment used to describe.
        const args = [
            '-hide_banner',
            ...(ffmpegInput.inputArguments ?? []),
            '-vn', '-sn', '-dn',
            '-acodec', 'aac',
            '-ar', '44100',
            '-ac', '1',
            '-b:a', '24k',
            '-f', 'flv',
            publishUrl,
        ];

        this.console.log(`[${nativeId}] two-way audio: starting ffmpeg publish to ${publishUrl}`);
        if (this.verboseLogging)
            this.console.log(`[${nativeId}] two-way audio: ffmpeg args: ${JSON.stringify(args)}`);
        const ffmpeg = spawn(ffmpegPath, args);
        this.twoWayAudioProcesses.set(nativeId, ffmpeg);
        ffmpeg.stderr.on('data', data => {
            if (this.verboseLogging)
                this.console.log(`[${nativeId}] two-way audio ffmpeg: ${data}`);
        });
        ffmpeg.on('error', err => {
            this.console.warn(`[${nativeId}] two-way audio: ffmpeg process error: ${err.message}`);
        });
        ffmpeg.on('exit', code => {
            this.console.log(`[${nativeId}] two-way audio ffmpeg exited (code ${code})`);
            if (this.twoWayAudioProcesses.get(nativeId) === ffmpeg)
                this.twoWayAudioProcesses.delete(nativeId);
        });

        const connection = this.getControlConnection(nativeId, cameraUid);
        this.twoWayAudioSessionIds.set(nativeId, sessionId);
        try {
            // requestTwoWayAudio() already logs the camera's own confirmation once it resolves -
            // nothing more to add at this layer.
            await connection.requestTwoWayAudio(playUrl, sessionId, 'STARTED');
        }
        catch (err) {
            this.console.warn(`[${nativeId}] two-way audio: failed to start: ${(err as Error).message}`);
            await this.stopTwoWayAudio(nativeId);
            throw err;
        }
    }

    /** Stops any in-progress two-way audio session for this device, if one exists. Safe to call even if none is active. */
    async stopTwoWayAudio(nativeId: string): Promise<void> {
        const ffmpeg = this.twoWayAudioProcesses.get(nativeId);
        const sessionId = this.twoWayAudioSessionIds.get(nativeId);
        if (!ffmpeg && !sessionId) {
            if (this.verboseLogging)
                this.console.log(`[${nativeId}] two-way audio: stop requested but nothing is active`);
            return;
        }

        this.console.log(`[${nativeId}] two-way audio: stopping`);
        if (ffmpeg) {
            this.twoWayAudioProcesses.delete(nativeId);
            ffmpeg.kill();
        }

        this.twoWayAudioSessionIds.delete(nativeId);
        if (!sessionId)
            return;

        const connection = this.controlConnections.get(nativeId);
        const host = await this.getLocalStreamHost();
        if (!connection || !this.rtmpServer || !host) {
            this.console.warn(`[${nativeId}] two-way audio: stopping locally, but could not notify the camera (missing control connection, RTMP server, or local stream host) - it may keep trying to pull audio until its own timeout`);
            return;
        }
        const playUrl = this.rtmpServer.getTwoWayAudioPlayUrl(host, nativeId);
        await connection.requestTwoWayAudio(playUrl, sessionId, 'STOPPED').catch(err =>
            this.console.warn(`[${nativeId}] two-way audio: failed to send STOPPED: ${(err as Error).message}`));
    }
}

export default NanitCameraPlugin;
