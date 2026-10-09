// Runs the protocol scenario in headless Chromium with the engine inside a Web Worker.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..'); // repo root: serves sandbox-worker/test and build/sandbox-worker
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.map': 'application/json' };
const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(9741, '127.0.0.1', resolve));
const browser = await chromium.launch();
let failed = 1;
try {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto('http://127.0.0.1:9741/sandbox-worker/test/index.html');
    await page.waitForFunction(() => typeof window.runSandboxCheck === 'function');
    const result = await page.evaluate(() => window.runSandboxCheck());
    console.log(result.log.join('\n'));
    console.log(`browser (Web Worker): ${result.passed} passed, ${result.failed} failed; boot ${Math.round(result.bootMs)} ms, cards ready ${Math.round(result.readyMs)} ms, ` +
        `${result.snapshots} snapshot events`, JSON.stringify(result.timings));
    failed = result.failed;
} finally {
    await browser.close();
    server.close();
}
process.exit(failed === 0 ? 0 : 1);
