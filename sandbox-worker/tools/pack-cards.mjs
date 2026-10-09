// Packs test/json (written by `npm run get-cards` in the repo root) into one "card blob" for the browser build:
//   build/sandbox-worker/cards.json
// Adapted from the browser-engine spike (browser-spike/tools/pack-cards.mjs).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const workerDir = path.resolve(import.meta.dirname, '..');
const jsonDir = path.resolve(workerDir, '../test/json');
const distDir = path.resolve(workerDir, '../build/sandbox-worker');
fs.mkdirSync(distDir, { recursive: true });

const read = (rel) => JSON.parse(fs.readFileSync(path.join(jsonDir, rel), 'utf8'));
const cardMap = read('_cardMap.json');
const cards = cardMap.map((e) => read(`Card/${e.internalName}.json`));

const blob = {
    format: 'forceteki-card-blob',
    version: 1,
    cardDataHash: fs.existsSync(path.join(jsonDir, 'card-data-hash.txt')) ? fs.readFileSync(path.join(jsonDir, 'card-data-hash.txt'), 'utf8').trim() : undefined,
    cards,
    cardMap,
    setCodeMap: read('_setCodeMap.json'),
    allNonLeaderCardTitles: read('_allNonLeaderCardTitles.json'),
    playableCardTitles: read('_playableCardTitles.json'),
    leaderNames: read('_leaderNames.json'),
};

const text = JSON.stringify(blob);
fs.writeFileSync(path.join(distDir, 'cards.json'), text);
console.log(`build/sandbox-worker/cards.json: ${cards.length} cards, ${text.length} bytes raw, ${zlib.gzipSync(text, { level: 9 }).length} gzip`);
