// Web Worker entry: the sandbox engine (server/sandbox) behind postMessage. One worker = one sandbox session.
//
// Page -> worker:  { id, method, payload }
//   method 'loadCards' { url?: string, blob?: ICardBlob }  must come first -> { cards, ms }
//   any SandboxDispatcher method (load, act, goto, deleteNode, promoteNode, exportPosition, serializeTree,
//   getSnapshot, parsePosition, formatPosition, validatePosition, getPresets, getCardIndex) with the same payload
//   as the socket.io event of the same name (CONTRACT.md §3).
// Worker -> page:  { id, ok: true, result }  |  { id, ok: false, error }      (transport-level; `result` may itself
//                                                                              be `{ ok: false, error }` as over the socket)
//                  { event: 'snapshot', data: ISandboxSnapshot }               after every state change
//                  { event: 'booted' }                                         once, when the script has loaded

import { createDispatcher, loadCardBlob } from './library';
import type { SandboxDispatcher } from '../../server/sandbox/SandboxDispatcher';

declare const self: any;

let dispatcher: SandboxDispatcher | null = null;

async function handle(method: string, payload: any): Promise<unknown> {
    if (method === 'loadCards') {
        const t0 = performance.now();
        let blob = payload?.blob;
        if (!blob) {
            const response = await fetch(payload.url);
            if (!response.ok) {
                throw new Error(`card data fetch failed: ${response.status} ${payload.url}`);
            }
            blob = await response.json();
        }
        const { cards } = loadCardBlob(blob);
        dispatcher = createDispatcher();
        dispatcher.onSnapshot((snapshot) => self.postMessage({ event: 'snapshot', data: snapshot }));
        return { cards, ms: performance.now() - t0 };
    }
    if (!dispatcher) {
        throw new Error('No card data: send loadCards first');
    }
    return dispatcher.call(method, payload);
}

// strictly one message at a time, in arrival order
let queue: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent) => {
    const { id, method, payload } = event.data ?? {};
    queue = queue.then(async () => {
        try {
            self.postMessage({ id, ok: true, result: await handle(method, payload) });
        } catch (error: any) {
            self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
        }
    });
};

self.postMessage({ event: 'booted' });
