// Copied from the browser-engine spike (scratch/browser-engine 0d3b7f756, browser-spike/), see SPIKE-browser-engine.md.
// Stand-in for Node built-ins that are imported at module load by files in the bundle but are only
// *called* on paths the browser build never takes:
//   fs    server/utils/cardData/LocalFolderCardDataGetter.ts, UnitTestCardDataGetter.ts (replaced by alias),
//         test/helpers/GameStateBuilder.js:6, DeckBuilder.js:1
//   path  same files, plus server/game/cards/Index.ts (replaced by a generated module)
//   http/https  server/Util.ts:1-2 (httpRequest / httpPostFormData, used by deck fetchers and Discord reports)
// Any call throws, so an accidental use is loud rather than silently wrong.
//
// The single exception is fs.existsSync('test/json'): GameStateBuilder's constructor
// (test/helpers/GameStateBuilder.js:13-16) checks that folder exists before constructing its card
// data getter, which the build aliases to the in-memory getter.

function unavailable(name: string): never {
    throw new Error(`[sandbox-worker] Node API '${name}' is not available in the browser bundle`);
}

export function existsSync(p: string): boolean {
    return p === 'test/json';
}
export const readFileSync = () => unavailable('fs.readFileSync');
export const readdirSync = () => unavailable('fs.readdirSync');
export const lstatSync = () => unavailable('fs.lstatSync');
export const writeFileSync = () => unavailable('fs.writeFileSync');
export const promises = { readFile: () => unavailable('fs.promises.readFile') };

export const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/');
export const resolve = (...parts: string[]) => join(...parts);
export const dirname = (p: string) => p.replace(/\/[^/]*$/, '');
export const basename = (p: string) => p.replace(/^.*\//, '');
export const sep = '/';

export const get = () => unavailable('http(s).get');
export const request = () => unavailable('http(s).request');

export default {
    existsSync, readFileSync, readdirSync, lstatSync, writeFileSync, promises,
    join, resolve, dirname, basename, sep,
    get, request,
};
