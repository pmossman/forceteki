// Runs the protocol scenario against build/sandbox-worker/sandbox.mjs in plain Node (no server, no socket).
import fs from 'node:fs';
import path from 'node:path';
import { runScenario } from './scenario.mjs';

const dist = path.resolve(import.meta.dirname, '../../build/sandbox-worker');
const { loadCardBlob, createDispatcher } = await import(path.join(dist, 'sandbox.mjs'));
const t0 = performance.now();
loadCardBlob(JSON.parse(fs.readFileSync(path.join(dist, 'cards.json'), 'utf8')));
const dispatcher = createDispatcher();
console.log(`cards loaded in ${Math.round(performance.now() - t0)} ms`);
const result = await runScenario((method, payload) => dispatcher.call(method, payload));
console.log(result.log.join('\n'));
console.log(`node: ${result.passed} passed, ${result.failed} failed`, JSON.stringify(result.timings));
process.exit(result.failed === 0 ? 0 : 1);
