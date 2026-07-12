import WebSocket from 'ws';
import { encodeControlMessage, decodeControlMessage, DecodedSensorData } from './proto';

export interface ConnectionLogger {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    /** Gated by the plugin's "Verbose Logging" setting - for high-frequency, low-value-by-default messages. */
    verbose(message: string): void;
}

type PendingRequest = {
    requestType: string;
    resolve: (statusMessage: string | undefined) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

// Special-cased because it's a non-fatal, expected condition: too many concurrent viewers on
// Nanit's backend, not a real failure. Retrying immediately in a loop against this error is what
// triggers the "app connections above limit" lockout in the first place, so back off well past the
// request timeout before trying again.
const CONNECTION_LIMIT_ERROR = 'Forbidden: Number of Mobile App connections above limit, declining connection';
const CONNECTION_LIMIT_BACKOFF_MS = 300_000;

const RECONNECT_BACKOFFS_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000];

/**
 * One WebSocket control-channel connection to a single camera
 * (wss://api.nanit.com/focus/cameras/{camera_uid}/user_connect). Reused across both the
 * local-streaming redirect (PUT_STREAMING) and incoming sensor pushes (PUT_SENSOR_DATA) so we
 * only ever hold one control connection per camera regardless of how many things need it.
 */
export class NanitControlConnection {
    private ws?: WebSocket;
    private keepaliveTimer?: ReturnType<typeof setInterval>;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private reconnectAttempt = 0;
    private lastRequestId = 0;
    private pending = new Map<number, PendingRequest>();
    private connectPromise?: Promise<void>;
    private disposed = false;
    private inFlightStreamingRequest?: { status: string, promise: Promise<void> };

    onSensorData?: (sensor: DecodedSensorData) => void;
    onAliveChange?: (alive: boolean) => void;

    constructor(
        private readonly cameraUid: string,
        private readonly getAccessToken: () => Promise<string>,
        private readonly logger: ConnectionLogger,
    ) {}

    get isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    async ensureConnected(): Promise<void> {
        if (this.disposed)
            throw new Error('control connection disposed');
        if (this.isConnected)
            return;
        if (!this.connectPromise)
            this.connectPromise = this.connectOnce().finally(() => this.connectPromise = undefined);
        return this.connectPromise;
    }

    private get logPrefix(): string {
        return `[control ${this.cameraUid}]`;
    }

    private async connectOnce(): Promise<void> {
        const token = await this.getAccessToken();
        const url = `wss://api.nanit.com/focus/cameras/${this.cameraUid}/user_connect`;
        this.logger.log(`${this.logPrefix} connecting to ${url}`);

        await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
            this.ws = ws;
            let opened = false;

            ws.once('open', () => {
                opened = true;
                this.reconnectAttempt = 0;
                this.startKeepalive();
                this.onAliveChange?.(true);
                this.logger.log(`${this.logPrefix} connected`);
                resolve();
                // The camera may only start pushing PUT_SENSOR_DATA updates once something has
                // asked, rather than doing so unprompted, so request it right after connecting.
                this.requestSensorData();
            });

            ws.on('message', (data: Buffer, isBinary: boolean) => this.handleRawMessage(data, isBinary));

            ws.once('error', (err: Error) => {
                if (!opened)
                    reject(err);
                else
                    this.logger.error(`control websocket error: ${err.message}`);
            });

            ws.once('close', () => {
                this.stopKeepalive();
                this.onAliveChange?.(false);
                this.failAllPending(new Error('control websocket closed'));
                if (!this.disposed)
                    this.scheduleReconnect();
                if (!opened)
                    reject(new Error('control websocket closed before connecting'));
            });
        });
    }

    private scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        const delay = RECONNECT_BACKOFFS_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFFS_MS.length - 1)];
        this.reconnectAttempt++;
        this.logger.warn(`${this.logPrefix} disconnected, reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.ensureConnected().catch(err => {
                this.logger.error(`control websocket reconnect failed: ${err.message}`);
                this.scheduleReconnect();
            });
        }, delay);
    }

    private startKeepalive() {
        this.keepaliveTimer = setInterval(() => {
            try {
                this.ws?.send(encodeControlMessage({ type: 'KEEPALIVE' }));
            }
            catch (err) {
                this.logger.warn(`failed to send keepalive: ${(err as Error).message}`);
            }
        }, 20_000);
    }

    private stopKeepalive() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = undefined;
        }
    }

    private handleRawMessage(data: Buffer, isBinary: boolean) {
        if (!isBinary) {
            // Every message we send/expect is our protobuf Message envelope, sent as a binary
            // frame. A text frame is something else entirely (e.g. a plain heartbeat/ping string) -
            // don't even try to protobuf-decode it, just log it for visibility.
            this.logger.warn(`${this.logPrefix} received non-binary control message, ignoring: ${data.toString('utf8').slice(0, 200)}`);
            return;
        }

        let message;
        try {
            message = decodeControlMessage(data);
        }
        catch (err) {
            this.logger.warn(`${this.logPrefix} received malformed binary control message (${data.length} bytes, hex: ${data.toString('hex').slice(0, 200)}): ${(err as Error).message}`);
            return;
        }

        if (message.type === 'RESPONSE' && message.response) {
            const { requestId, requestType, statusCode, statusMessage } = message.response;
            const pending = this.pending.get(requestId);
            if (pending && pending.requestType === requestType) {
                clearTimeout(pending.timer);
                this.pending.delete(requestId);
                if (statusCode === 200)
                    pending.resolve(statusMessage);
                else
                    pending.reject(new Error(statusMessage || `unexpected status code ${statusCode}`));
            }
            return;
        }

        if (message.type === 'REQUEST' && message.request?.type === 'PUT_SENSOR_DATA') {
            for (const sensor of message.request.sensorData ?? []) {
                this.logger.verbose(`${this.logPrefix} received sensor data: ${JSON.stringify(sensor)}`);
                this.onSensorData?.(sensor);
            }
        }

        // Diagnostic-only for now - just observing when/how often this shows up before deciding
        // whether it's a reliable enough signal to act on. Not gated by verbose logging: it's rare
        // and we specifically want it visible in normal captures while we're still characterizing it.
        if (message.type === 'REQUEST' && message.request?.type === 'STREAM_STATUS_NOTICE') {
            const detail = message.request.streamStatusNotice?.detail;
            this.logger.log(`${this.logPrefix} received stream status notice: code=${detail?.code}, reason=${detail?.reason}`);
        }
    }

    /** Asks the camera to start sending sensor data (motion, sound, temperature, etc) pushes. */
    async requestSensorData(): Promise<void> {
        try {
            await this.sendRequest('GET_SENSOR_DATA', { getSensorData: { all: true } }, 10_000);
            this.logger.log(`${this.logPrefix} requested sensor data`);
        }
        catch (err) {
            this.logger.warn(`${this.logPrefix} GET_SENSOR_DATA request failed: ${(err as Error).message}`);
        }
    }

    private sendRequest(requestType: string, body: Record<string, unknown>, timeoutMs: number): Promise<string | undefined> {
        const id = ++this.lastRequestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('Request timeout'));
            }, timeoutMs);

            this.pending.set(id, { requestType, resolve, reject, timer });

            try {
                if (!this.isConnected)
                    throw new Error('control websocket is not connected');
                this.ws!.send(encodeControlMessage({ type: 'REQUEST', request: { id, type: requestType, ...body } }));
            }
            catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err as Error);
            }
        });
    }

    /**
     * Requests that the camera publish (or stop publishing) its RTMP stream to rtmpUrl, with a
     * single non-fatal retry on the "too many mobile app connections" error.
     *
     * Concurrent callers requesting the same status share the one in-flight request instead of
     * each sending their own PUT_STREAMING - sending several redundant requests for the same
     * camera in quick succession is itself what triggers Nanit's per-camera connection limit.
     */
    async requestLocalStreaming(rtmpUrl: string, status: 'STARTED' | 'STOPPED' | 'PAUSED'): Promise<void> {
        if (this.inFlightStreamingRequest?.status === status) {
            this.logger.log(`${this.logPrefix} PUT_STREAMING ${status} already in flight, joining it instead of sending a duplicate request`);
            return this.inFlightStreamingRequest.promise;
        }

        const promise = this.requestLocalStreamingOnce(rtmpUrl, status).finally(() => {
            if (this.inFlightStreamingRequest?.promise === promise)
                this.inFlightStreamingRequest = undefined;
        });
        this.inFlightStreamingRequest = { status, promise };
        return promise;
    }

    private async requestLocalStreamingOnce(rtmpUrl: string, status: 'STARTED' | 'STOPPED' | 'PAUSED'): Promise<void> {
        this.logger.log(`${this.logPrefix} requesting PUT_STREAMING ${status} -> ${rtmpUrl}`);
        await this.ensureConnected();

        for (;;) {
            try {
                await this.sendRequest('PUT_STREAMING', {
                    streaming: { id: 'MOBILE', status, rtmpUrl, attempts: 1 },
                }, 30_000);
                this.logger.log(`${this.logPrefix} camera acknowledged PUT_STREAMING ${status}`);
                return;
            }
            catch (err) {
                if ((err as Error).message === CONNECTION_LIMIT_ERROR) {
                    this.logger.warn(`${this.logPrefix} too many Nanit app connections, retrying local streaming request in ${CONNECTION_LIMIT_BACKOFF_MS}ms`);
                    await new Promise(r => setTimeout(r, CONNECTION_LIMIT_BACKOFF_MS));
                    continue;
                }
                this.logger.warn(`${this.logPrefix} PUT_STREAMING ${status} rejected: ${(err as Error).message}`);
                throw err;
            }
        }
    }

    dispose() {
        this.disposed = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.stopKeepalive();
        this.failAllPending(new Error('control connection disposed'));
        this.ws?.removeAllListeners();
        this.ws?.close();
    }

    private failAllPending(err: Error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(err);
        }
        this.pending.clear();
    }
}
