import fs from 'fs';
import path from 'path';
import type { Express, Request, Response } from 'express';
import type { Server as IOServer, Socket } from 'socket.io';
import { SandboxCardIndex } from '../cards/SandboxCardIndex';
import type { ICardDataJson } from '../../utils/cardData/CardDataInterfaces';
import { HarnessGameLoader } from '../loader/SandboxGameLoader';
import { SandboxPositions } from '../SandboxSession';
import { SandboxDispatcher, sandboxMethods } from '../SandboxDispatcher';
import { sandboxPresets } from '../SandboxPresets';

/**
 * Node adapter for the sandbox module: HTTP routes on the game server's express app, plus a socket.io namespace
 * (`/sandbox`, one session per connection). This is the ONLY sandbox file that knows about express, socket.io, fs
 * or the compiled test harness; a Web Worker adapter would replace it. Wired in by one hook in GameServer.ts.
 */

export interface ISandboxAdapterDeps {
    cardDataGetter: any;

    /** the dev server's GameStateBuilder instance (test/helpers/GameStateBuilder.js) */
    testGameBuilder: any;
}

// built once per card data source (servers in tests are constructed many times)
const indexCache = new WeakMap<object, SandboxCardIndex>();

function buildCardIndex(cardDataGetter: any): SandboxCardIndex {
    const cached = indexCache.get(cardDataGetter);
    if (cached) {
        return cached;
    }
    const cards: ICardDataJson[] = [];
    for (const id of cardDataGetter.cardIds as string[]) {
        try {
            cards.push(cardDataGetter.getCardSync(id));
        } catch {
            // skip unreadable card data
        }
    }
    const index = SandboxCardIndex.fromCardData(cards);
    indexCache.set(cardDataGetter, index);
    return index;
}

let cardIndexFileWritten = false;

function safeAck(ack: unknown): (result: unknown) => void {
    return typeof ack === 'function' ? (ack as (result: unknown) => void) : () => undefined;
}

export function attachSandbox(app: Express, io: IOServer, deps: ISandboxAdapterDeps): void {
    const started = Date.now();
    const index = buildCardIndex(deps.cardDataGetter);
    const positions = new SandboxPositions(index);
    const indexJson = index.toJson();

    // static artifact for the client (and a future static site): build/sandbox/card-index.json
    if (!cardIndexFileWritten) {
        cardIndexFileWritten = true;
        try {
            const outDir = path.resolve(__dirname, '../../../sandbox');
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, 'card-index.json'), JSON.stringify(indexJson));
        } catch (error) {
            console.warn('SANDBOX: could not write card-index.json', error);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const GameFlowWrapper = require(path.resolve(__dirname, '../../../test/helpers/GameFlowWrapper.js'));
    const loader = new HarnessGameLoader({ GameFlowWrapper, builder: deps.testGameBuilder, cardDataGetter: deps.cardDataGetter });

    // ---------------------------------------------------------------- HTTP
    app.get('/api/sandbox/cards', (_req: Request, res: Response) => {
        res.json(indexJson);
    });

    app.get('/api/sandbox/presets', (_req: Request, res: Response) => {
        res.json({ presets: sandboxPresets });
    });

    app.post('/api/sandbox/position/validate', (req: Request, res: Response) => {
        try {
            const body = req.body ?? {};
            res.json(positions.validate({ text: body.text, position: body.position }));
        } catch (error) {
            res.status(400).json({ ok: false, errors: [{ path: '', message: String((error as Error)?.message ?? error) }], warnings: [] });
        }
    });

    // ---------------------------------------------------------------- socket.io
    const namespace = io.of('/sandbox');
    namespace.on('connection', (socket: Socket) => {
        // one session per connection; the dispatcher serialises calls and never throws
        const dispatcher = new SandboxDispatcher({ index, loader });
        const unsubscribe = dispatcher.onSnapshot((snapshot) => socket.emit('snapshot', snapshot));
        for (const method of sandboxMethods) {
            socket.on(method, (payload: any, ack: unknown) => {
                const reply = safeAck(ack);
                void dispatcher.call(method, payload).then(reply);
            });
        }
        socket.on('disconnect', () => unsubscribe());
    });

    console.log(`SANDBOX: ready (${index.entries.length} cards indexed in ${Date.now() - started}ms): HTTP /api/sandbox/*, socket.io namespace /sandbox`);
}
