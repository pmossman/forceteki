// Copied from the browser-engine spike (scratch/browser-engine 0d3b7f756, browser-spike/), see SPIKE-browser-engine.md.
// Alias target for server/utils/cardData/UnitTestCardDataGetter.ts in the browser build.
// GameStateBuilder's constructor does `new UnitTestCardDataGetter('test/json')`
// (test/helpers/GameStateBuilder.js:39); this version ignores the folder and serves the card blob
// registered with registerCardBlob() instead.
import { InMemoryCardDataGetter, getRegisteredCardBlob } from '../src/cardData';

export class UnitTestCardDataGetter extends InMemoryCardDataGetter {
    public constructor(_folderRoot?: string) {
        super(getRegisteredCardBlob());
    }
}
