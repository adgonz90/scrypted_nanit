const TIMESTAMPED_METHODS = new Set(['log', 'warn', 'error', 'info', 'debug', 'trace']);

/**
 * Wraps a Console so every log/warn/error/etc call gets a local-time timestamp prefix, matching
 * the style node-media-server's own logger already uses (e.g. "7/7/2026, 12:03:57 AM") so lines
 * from different parts of the plugin can be correlated by eye in the Scrypted console.
 */
export function withTimestamps(console: Console): Console {
    return new Proxy(console, {
        get(target, prop, receiver) {
            const original = Reflect.get(target, prop, receiver);
            if (typeof original !== 'function' || typeof prop !== 'string' || !TIMESTAMPED_METHODS.has(prop))
                return original;

            return (...args: unknown[]) => original.apply(target, [`[${new Date().toLocaleString()}]`, ...args]);
        },
    });
}
