// Copied from the browser-engine spike (scratch/browser-engine 0d3b7f756, browser-spike/), see SPIKE-browser-engine.md.
// Browser replacement for the `winston` package. Only server/logger.ts imports winston; the engine
// imports `logger` from there (Game.ts:74, Player.ts:48, Card.ts:46, snapshot/GameStateManager.ts:8).
// winston itself pulls in fs/os/util/http/zlib transports, so it is replaced wholesale with a
// console-backed logger that supports the subset of the API logger.ts calls at module load.

type LogFn = (message: unknown, ...meta: unknown[]) => void;

const identityFormat = (..._args: unknown[]) => ({ transform: (info: unknown) => info });

export const format = {
    printf: identityFormat,
    combine: identityFormat,
    timestamp: identityFormat,
    errors: identityFormat,
    json: identityFormat,
    colorize: identityFormat,
    simple: identityFormat,
};

// a constructible stand-in for winston.transports.Console
function Console(this: unknown, _options?: unknown) {
    return this;
}

export const transports = { Console };

export function createLogger(_options?: unknown) {
    const log = (level: 'error' | 'warn' | 'info' | 'debug'): LogFn => (message, ...meta) => {
        // eslint-disable-next-line no-console
        console[level](`[engine ${level}]`, message, ...meta);
    };
    return {
        error: log('error'),
        warn: log('warn'),
        info: log('info'),
        http: log('debug'),
        verbose: log('debug'),
        debug: log('debug'),
        silly: log('debug'),
        log: (level: string, message: unknown, ...meta: unknown[]) => log('info')(`${level}: ${String(message)}`, ...meta),
    };
}

export default { format, transports, createLogger };
