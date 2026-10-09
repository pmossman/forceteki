// Copied from the browser-engine spike (scratch/browser-engine 0d3b7f756, browser-spike/), see SPIKE-browser-engine.md.
// In-memory card data for the browser build.
//
// Upstream reads card JSON from disk (server/utils/cardData/LocalFolderCardDataGetter.ts,
// UnitTestCardDataGetter.ts). Here the whole card set (or a subset) arrives as one JSON "card blob"
// produced by sandbox-worker/tools/pack-cards.mjs from test/json, either fetched from a static URL
// or posted to the worker. InMemoryCardDataGetter extends the upstream abstract CardDataGetter, so
// the engine sees the same interface.

import { CardDataGetter } from '../../server/utils/cardData/CardDataGetter';
import type { ICardDataJson, ICardMapJson } from '../../server/utils/cardData/CardDataInterfaces';
import type { ISynchronousCardDataGetter } from '../../server/utils/cardData/ISynchronousCardDataGetter';

export interface ICardBlob {
    format: 'forceteki-card-blob';
    version: 1;
    cardDataHash?: string;
    cards: ICardDataJson[];
    cardMap: ICardMapJson;
    setCodeMap: Record<string, string>;
    allNonLeaderCardTitles: string[];
    playableCardTitles: string[];
    leaderNames: { name: string; id: string; subtitle?: string }[];
}

// Arrays shared with the virtual modules that replace test/json/_allNonLeaderCardTitles.json and
// _playableCardTitles.json (required statically by test/helpers/GameFlowWrapper.js:7-8). They are
// filled in place when a blob is registered, because GameFlowWrapper captures the array references
// at module-evaluation time.
export const sharedCardLists = {
    allNonLeaderCardTitles: [] as string[],
    playableCardTitles: [] as string[],
};

let registeredBlob: ICardBlob | null = null;

export function registerCardBlob(blob: ICardBlob) {
    if (blob?.format !== 'forceteki-card-blob' || blob.version !== 1) {
        throw new Error('Not a forceteki card blob (expected format "forceteki-card-blob", version 1)');
    }
    registeredBlob = blob;
    sharedCardLists.allNonLeaderCardTitles.splice(0, Infinity, ...blob.allNonLeaderCardTitles);
    sharedCardLists.playableCardTitles.splice(0, Infinity, ...blob.playableCardTitles);
}

export function getRegisteredCardBlob(): ICardBlob {
    if (!registeredBlob) {
        throw new Error('No card blob registered; call registerCardBlob() first');
    }
    return registeredBlob;
}

export class InMemoryCardDataGetter extends CardDataGetter implements ISynchronousCardDataGetter {
    private readonly cardsByInternalName: Map<string, ICardDataJson>;

    public constructor(blob: ICardBlob) {
        const byName = new Map<string, ICardDataJson>();
        for (const card of blob.cards) {
            byName.set(card.internalName, card);
        }
        const tokenData = CardDataGetter.getTokenCardsDataSync((internalName) => {
            const card = byName.get(internalName);
            if (!card) {
                throw new Error(`Token card '${internalName}' missing from card blob`);
            }
            return card;
        });

        super(blob.cardMap, tokenData, blob.allNonLeaderCardTitles, blob.playableCardTitles, blob.setCodeMap, blob.leaderNames);
        this.cardsByInternalName = byName;
    }

    private getByInternalName(internalName: string): ICardDataJson {
        const card = this.cardsByInternalName.get(internalName);
        if (!card) {
            throw new Error(`Card '${internalName}' missing from card blob`);
        }
        return card;
    }

    protected override getRelativePathFromInternalName(internalName: string) {
        return internalName;
    }

    protected override getCardInternalAsync(internalName: string): Promise<ICardDataJson> {
        return Promise.resolve(this.getByInternalName(internalName));
    }

    public getCardSync(id: string): ICardDataJson {
        return this.getByInternalName(this.getInternalName(id));
    }

    public getCardByNameSync(internalName: string): ICardDataJson {
        this.checkInternalName(internalName);
        return this.getByInternalName(internalName);
    }

    public getSetCodeMapSync(): Map<string, string> {
        return this.setCodeMap;
    }
}
