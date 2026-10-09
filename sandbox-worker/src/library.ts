// The sandbox engine as a plain library: register a card blob, then create dispatchers (one per sandbox session).
// Same SandboxDispatcher protocol as the socket.io adapter (server/sandbox/adapters/SandboxNodeAdapter.ts), so a
// client can swap transports without touching UI code. Used by the Web Worker entry (worker.ts) and runnable in Node.

import { registerCardBlob, getRegisteredCardBlob } from './cardData';
import type { ICardBlob } from './cardData';
import GameStateBuilder from '../../test/helpers/GameStateBuilder';
import GameFlowWrapper from '../../test/helpers/GameFlowWrapper';
import { SandboxCardIndex } from '../../server/sandbox/cards/SandboxCardIndex';
import { HarnessGameLoader } from '../../server/sandbox/loader/SandboxGameLoader';
import { SandboxDispatcher, sandboxMethods } from '../../server/sandbox/SandboxDispatcher';

export { sandboxMethods };
export type { ICardBlob };

interface IEngineDeps {
    index: SandboxCardIndex;
    loader: HarnessGameLoader;
}

let deps: IEngineDeps | null = null;

/** Registers the card data and builds the shared card index and board loader. Call once before createDispatcher(). */
export function loadCardBlob(blob: ICardBlob): { cards: number } {
    registerCardBlob(blob);
    // GameStateBuilder's `new UnitTestCardDataGetter('test/json')` resolves to the in-memory getter in this build
    const builder: any = new (GameStateBuilder as any)();
    const cardDataGetter = builder.cardDataGetter;
    const index = SandboxCardIndex.fromCardData(getRegisteredCardBlob().cards);
    const loader = new HarnessGameLoader({ GameFlowWrapper: GameFlowWrapper as any, builder, cardDataGetter });
    deps = { index, loader };
    return { cards: blob.cards.length };
}

export function createDispatcher(): SandboxDispatcher {
    if (!deps) {
        throw new Error('No card data: call loadCardBlob() first');
    }
    return new SandboxDispatcher(deps);
}
