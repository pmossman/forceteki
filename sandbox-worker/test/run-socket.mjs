// Runs the same protocol scenario over the socket.io adapter of a running server (default http://localhost:9600).
import { io } from 'socket.io-client';
import { runScenario } from './scenario.mjs';

const url = process.argv[2] ?? 'http://localhost:9600';
const socket = io(`${url}/sandbox`, { path: '/ws', transports: ['websocket'] });
await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
});
let snapshots = 0;
socket.on('snapshot', () => snapshots++);
const result = await runScenario((method, payload) => new Promise((resolve) => socket.emit(method, payload, resolve)));
socket.disconnect();
console.log(result.log.join('\n'));
console.log(`socket.io (${url}): ${result.passed} passed, ${result.failed} failed, ${snapshots} snapshot events`, JSON.stringify(result.timings));
process.exit(result.failed === 0 ? 0 : 1);
