import { EventEmitter } from 'events';

// node-media-server ships no first-party type declarations.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeMediaServer = require('node-media-server');

// Reaches past node-media-server's declared public entry point (src/index.js, which only exposes
// a handful of connection-lifecycle events) into its internal Context singleton - the only way to
// get per-packet freshness data or to forcibly evict a dead publisher session, neither of which is
// part of the package's public API/semver contract. See patchBroadcastForFreshness()/
// checkForStalePublishers() below for why this is needed. Wrapped in try/catch so a future
// node-media-server release that moves this file degrades gracefully (freshness watchdog disabled,
// logged once) instead of breaking local streaming entirely.
let Context: any;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Context = require('node-media-server/src/core/context');
}
catch {
    Context = undefined;
}

export interface RtmpServerLogger {
    log(message: string): void;
    warn(message: string): void;
}

// Fixed app name for every published stream, matching the RTMP path convention the camera expects
// when told where to publish. The stream key underneath it is the Nanit baby UID.
const RTMP_APP = 'local';

// How often to check for stalled publishers, and how long a publisher can go without sending a
// single A/V packet before we consider it dead. A camera that loses power or network connectivity
// mid-stream never sends a TCP FIN, so node-media-server's own donePublish never fires - observed
// in practice as a downstream consumer's own read timeout firing repeatedly with zero corresponding
// disconnect on our side, and reliably reproduced by power-cycling the camera mid-stream. These
// values are first-guess defaults but have proven reliable (100% detection/recovery) across
// extended real-world runs.
const STALE_CHECK_INTERVAL_MS = 5_000;
const STALE_THRESHOLD_MS = 30_000;

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
    private lastPacketTime = new Map<string, number>();
    private patchedBroadcasts = new WeakSet<object>();
    private staleCheckTimer?: ReturnType<typeof setInterval>;

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
            this.lastPacketTime.set(session.streamName, Date.now());
            this.patchBroadcastForFreshness(session.streamName);
            this.logger.log(`local RTMP publisher connected for stream key ${session.streamName}`);
            this.emit('alive', session.streamName);
        });

        this.nms.on('donePublish', (session: RtmpSession) => {
            if (session.streamApp !== RTMP_APP || !session.streamName)
                return;
            this.aliveStreamKeys.delete(session.streamName);
            this.lastPacketTime.delete(session.streamName);
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

        if (Context)
            this.staleCheckTimer = setInterval(() => this.checkForStalePublishers(), STALE_CHECK_INTERVAL_MS);
        else
            this.logger.warn('local RTMP server: could not reach node-media-server internals - stale-publisher detection disabled, only clean disconnects will be noticed');

        this.nms.run();
        this.logger.log(`local RTMP server listening on port ${this.port}`);
    }

    // Wraps this stream key's BroadcastServer.broadcastMessage so every A/V packet it relays
    // updates a freshness timestamp, letting checkForStalePublishers() notice a publisher that
    // stays TCP-connected but stops sending data - donePublish never fires for that case (see the
    // top-of-file comment). BroadcastServer instances are reused across reconnects for the same
    // stream path, so patchedBroadcasts guards against wrapping the same instance twice.
    private patchBroadcastForFreshness(streamKey: string) {
        const broadcast = Context?.broadcasts?.get(`/${RTMP_APP}/${streamKey}`);
        if (!broadcast || this.patchedBroadcasts.has(broadcast))
            return;
        this.patchedBroadcasts.add(broadcast);
        const original = broadcast.broadcastMessage;
        broadcast.broadcastMessage = (packet: unknown) => {
            this.lastPacketTime.set(streamKey, Date.now());
            original(packet);
        };
    }

    // A camera that loses power mid-stream never sends a TCP FIN, so the dead session just sits
    // forever as the stream's publisher - node-media-server rejects any fresh publish attempt for
    // the same stream path with "already has a publisher" until that zombie session is evicted.
    // Destroying its socket directly (rather than the graceful session.close()/socket.end(), which
    // can hang waiting for a FIN-ACK a truly dead peer will never send) forces an immediate local
    // close, which flows through node-media-server's normal donePublish path - the existing
    // 'donePublish' handler above does the rest (clears our own tracking, emits 'unhealthy').
    private checkForStalePublishers() {
        const now = Date.now();
        for (const streamKey of this.aliveStreamKeys) {
            const last = this.lastPacketTime.get(streamKey);
            if (last === undefined || now - last < STALE_THRESHOLD_MS)
                continue;
            this.logger.warn(`local RTMP publisher for stream key ${streamKey} sent no data for ${now - last}ms - evicting stale session`);
            const publisher = Context?.broadcasts?.get(`/${RTMP_APP}/${streamKey}`)?.publisher;
            if (!publisher?.socket) {
                // Shouldn't happen if aliveStreamKeys says this stream has a publisher - logged
                // loudly since a silent no-op here would otherwise just repeat this same staleness
                // warning forever with no indication that eviction itself is the broken part.
                this.logger.warn(`local RTMP publisher for stream key ${streamKey} marked stale but no publisher session/socket found to evict - stale-publisher detection may be broken (node-media-server internals changed?)`);
                continue;
            }
            publisher.socket.destroy();
            this.logger.log(`local RTMP publisher for stream key ${streamKey} evicted, waiting for a fresh publish`);
        }
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
        this.lastPacketTime.clear();
        if (this.staleCheckTimer) {
            clearInterval(this.staleCheckTimer);
            this.staleCheckTimer = undefined;
        }
    }
}
