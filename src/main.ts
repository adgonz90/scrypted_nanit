import { AudioSensor, Battery, Camera, Device, DeviceCreator, DeviceCreatorSettings, DeviceProvider, FFmpegInput, HumiditySensor, Intercom, MediaObject, MediaStreamOptions, MotionSensor, PictureOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, TemperatureUnit, Thermometer, VideoCamera } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings"
import axios, { AxiosRequestConfig } from 'axios'
import { NanitControlConnection } from './nanit/control-connection';
import { LocalRtmpServer } from './nanit/local-rtmp-server';
import { DecodedSensorData } from './nanit/proto';
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

class NanitCameraDevice extends ScryptedDeviceBase implements Intercom, Camera, VideoCamera, MotionSensor, AudioSensor, Battery, Thermometer, HumiditySensor, Settings {
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
        ffmpegInputVal.videoDecoderArguments = ['-vframes', '1', '-q:v', '2']
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
        // Two-way audio (speaking to the camera) isn't implemented - the protocol for it hasn't
        // been reverse-engineered yet.
        throw new Error('not implemented');
    }

    async stopIntercom(): Promise<void> {
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

class NanitCameraPlugin extends ScryptedDeviceBase implements DeviceProvider, Settings, DeviceCreator {
    devices = new Map<string, NanitCameraDevice>();
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
                ScryptedInterface.Settings,
                ScryptedInterface.Battery,
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
        const devices: Device[] = [];
        for (const camera of babies) {
            const nativeId = camera.uid;
            const interfaces = [
                ScryptedInterface.Camera,
                ScryptedInterface.VideoCamera,
                ScryptedInterface.Settings,
                ScryptedInterface.Battery,
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
            devices.push(device);
        }

        await deviceManager.onDevicesChanged({
            devices,
        });
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
            ScryptedInterface.Settings,
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
            this.console.log(`[${nativeId}] camera_uid not cached yet, fetching /babies`);
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
}

export default NanitCameraPlugin;
