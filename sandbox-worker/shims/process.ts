// Copied from the browser-engine spike (scratch/browser-engine 0d3b7f756, browser-spike/), see SPIKE-browser-engine.md.
// Injected (esbuild `inject`) as the free variable `process` in every bundled module.
// `process.env.NODE_ENV` and `process.env.ENVIRONMENT` are also replaced at build time by `define`
// (see build.mjs); this object covers the remaining runtime references:
//   server/game/core/Game.ts:2115,2137  process.hrtime.bigint()   (rollback timing, logging only)
//   server/logger.ts:4                   process.env.AWS_EXECUTION_ENV
//   misc npm deps that probe process.env / process.nextTick
declare const __SPIKE_NODE_ENV__: string;
declare const __SPIKE_ENVIRONMENT__: string;

const env: Record<string, string | undefined> = {
    NODE_ENV: __SPIKE_NODE_ENV__,
    ENVIRONMENT: __SPIKE_ENVIRONMENT__,
    // optional host-provided overrides
    ...((globalThis as any).__SPIKE_ENV__ ?? {}),
};
const versions: Record<string, string> = {};

export const process = {
    env,
    hrtime: {
        bigint: (): bigint => BigInt(Math.round(performance.now() * 1e6)),
    },
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
    platform: 'browser',
    versions,
    cwd: () => '/',
};
