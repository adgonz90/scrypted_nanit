import { EventEmitter } from 'events';

// node-media-server ships no first-party type declarations.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeMediaServer = require('node-media-server');

export interface RtmpServerLogger {
    log(message: string): void;
    warn(message: string): void;
}

// Fixed app name for every published stream, matching the RTMP path convention the camera expects
// when told where to publish. The stream key underneath it is the Nanit baby UID.
const RTMP_APP = 'local';

interface RtmpSession {
    streamApp?: string;
    streamName?: string;
}

/**
 * Thin wrapper around a single shared node-media-server instance that acts purely as a local
 * RTMP ingest point - no HTTP/HLS/flv surface is enabled, since Scrypted's own ffmpeg process
 * reads the stream directly over RTMP, the same way it reads the cloud RTMPS URL.
 *
 * Shared across every camera device (one TCP listener, one port), so per-stream-key state is
 * tracked here and callers key off the Nanit baby UID used as the RTMP stream name.
 *
 * Events:
 *  - 'alive' (streamKey)              - a publisher started publishing this stream key
 *  - 'unhealthy' (streamKey)          - the publisher for this stream key disconnected
 *  - 'subscribers' (streamKey, count) - the number of local players/subscribers changed
 */
export class LocalRtmpServer extends EventEmitter {
    private nms?: any;
    private aliveStreamKeys = new Set<string>();
    private subscriberCounts = new Map<string, number>();

    constructor(private readonly port: number, private readonly logger: RtmpServerLogger) {
        super();
    }

    start() {
        if (this.nms)
            return;

        this.nms = new NodeMediaServer({
            bind: '0.0.0.0',
            rtmp: {
                port: this.port,
            },
            // No http/https/auth sections: this keeps the API/JWT/express surface entirely
            // disabled, since node-media-server only starts those servers when the corresponding
            // config section is present.
        });

        this.nms.on('postPublish', (session: RtmpSession) => {
            if (session.streamApp !== RTMP_APP || !session.streamName)
                return;
            this.aliveStreamKeys.add(session.streamName);
            this.logger.log(`local RTMP publisher connected for stream key ${session.streamName}`);
            this.emit('alive', session.streamName);
        });

        this.nms.on('donePublish', (session: RtmpSession) => {
            if (session.streamApp !== RTMP_APP || !session.streamName)
                return;
            this.aliveStreamKeys.delete(session.streamName);
            this.logger.warn(`local RTMP publisher disconnected for stream key ${session.streamName}`);
            this.emit('unhealthy', session.streamName);
        });

        this.nms.on('postPlay', (session: RtmpSession) => {
            if (session.streamApp !== RTMP_APP || !session.streamName)
                return;
            const count = (this.subscriberCounts.get(session.streamName) ?? 0) + 1;
            this.subscriberCounts.set(session.streamName, count);
            this.logger.log(`local RTMP subscriber attached for stream key ${session.streamName} (${count} now watching)`);
            this.emit('subscribers', session.streamName, count);
        });

        this.nms.on('donePlay', (session: RtmpSession) => {
            if (session.streamApp !== RTMP_APP || !session.streamName)
                return;
            const count = Math.max((this.subscriberCounts.get(session.streamName) ?? 1) - 1, 0);
            this.subscriberCounts.set(session.streamName, count);
            this.logger.log(`local RTMP subscriber detached for stream key ${session.streamName} (${count} now watching)`);
            this.emit('subscribers', session.streamName, count);
        });

        this.nms.run();
        this.logger.log(`local RTMP server listening on port ${this.port}`);
    }

    isAlive(streamKey: string): boolean {
        return this.aliveStreamKeys.has(streamKey);
    }

    subscriberCount(streamKey: string): number {
        return this.subscriberCounts.get(streamKey) ?? 0;
    }

    /** Resolves true once streamKey starts publishing, or false if timeoutMs elapses first. */
    waitForAlive(streamKey: string, timeoutMs: number): Promise<boolean> {
        if (this.isAlive(streamKey))
            return Promise.resolve(true);

        this.logger.log(`waiting up to ${timeoutMs}ms for local RTMP publisher for stream key ${streamKey}`);

        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.logger.warn(`timed out after ${timeoutMs}ms waiting for local RTMP publisher for stream key ${streamKey}`);
                finish(false);
            }, timeoutMs);
            const onAlive = (key: string) => {
                if (key === streamKey)
                    finish(true);
            };
            const finish = (result: boolean) => {
                clearTimeout(timer);
                this.off('alive', onAlive);
                resolve(result);
            };
            this.on('alive', onAlive);
        });
    }

    /** URL the camera should be told (via PUT_STREAMING) to publish to. */
    getPublishUrl(publicHost: string, streamKey: string): string {
        return `rtmp://${publicHost}:${this.port}/${RTMP_APP}/${streamKey}`;
    }

    /** URL Scrypted's own ffmpeg process reads from, always loopback since it runs alongside this server. */
    getLocalPlaybackUrl(streamKey: string): string {
        return `rtmp://127.0.0.1:${this.port}/${RTMP_APP}/${streamKey}`;
    }

    stop() {
        // node-media-server v4 has no public stop()/close() API on the top-level class; reach into
        // its RTMP server and close the underlying TCP listener directly so a plugin reload doesn't
        // leave the port bound.
        this.nms?.rtmpServer?.tcpServer?.close();
        this.nms = undefined;
        this.aliveStreamKeys.clear();
        this.subscriberCounts.clear();
    }
}
