import GameFlowWrapper from '../../helpers/GameFlowWrapper';
import GameStateBuilder from '../../helpers/GameStateBuilder';
import { SandboxSession } from '../../../server/sandbox/SandboxSession';
import { HarnessGameLoader } from '../../../server/sandbox/loader/SandboxGameLoader';
import { SandboxCardIndex } from '../../../server/sandbox/cards/SandboxCardIndex';
import { resolvePosition } from '../../../server/sandbox/position/PositionResolver';

// Regression: an upgrade (or a captured card) on a base or a deployed leader must not take a copy of the same card
// that the position puts in hand, discard or resources. The harness attaches those upgrades after the hidden zones are set up
// and searched every zone for the card, so the hand copy moved onto the base and the hand came up one card short
// (found by the client's real-replay suite: a Verdant Fortress in hand while another is on the base). Cards captured
// by a deployed leader had no card of their own at all (the harness only creates captures on bases and arena units).

let index: SandboxCardIndex;
let loader: HarnessGameLoader;

function deps() {
    if (!index) {
        const builder: any = new GameStateBuilder();
        const cards = (builder.cardDataGetter.cardIds as string[]).map((id) => builder.cardDataGetter.getCardSync(id));
        index = SandboxCardIndex.fromCardData(cards);
        loader = new HarnessGameLoader({ GameFlowWrapper: GameFlowWrapper as any, builder, cardDataGetter: builder.cardDataGetter });
    }
    return { index, loader };
}

const position = [
    'phase: action',
    'initiative: P1',
    '',
    '[P1]',
    'leader: Luke Skywalker, Faithful Friend [deployed]',
    '  + Academy Training',
    '  captured: Wampa',
    'base: Dagobah Swamp',
    '  + Alliance Shield Generator',
    '  + Bacta Tank',
    'resource: Bacta Tank',
    'resource: 2x Battlefield Marine',
    'hand: Alliance Shield Generator',
    'hand: Academy Training',
    'discard: Alliance Shield Generator',
    'deck: Wampa',
    '',
    '[P2]',
    'leader: Director Krennic, Amidst My Achievement',
    'base: Administrator\'s Tower',
    '  + Alliance Shield Generator',
    'resource: Battlefield Marine',
    'hand: Alliance Shield Generator',
    'hand: Wampa',
    'deck: Wampa',
    '',
].join('\n');

const names = (cards: any[]) => cards.map((c: any) => c.internalName).sort();

describe('Sandbox upgrades on bases and leaders', function () {
    it('come from outside the game, never from the same card in hand, discard or resources (captured cards too)', async function () {
        const session = new SandboxSession(deps());
        const loaded = await session.loadAsync({ position });
        expect(loaded.ok)
            .withContext(JSON.stringify((loaded as any).errors))
            .toBeTrue();

        const game: any = session.currentGame;
        const p1 = game.getPlayerById('p1');
        const p2 = game.getPlayerById('p2');
        expect(names(p1.handZone.cards)).toEqual(['academy-training', 'alliance-shield-generator']);
        expect(names(p1.discardZone.cards)).toEqual(['alliance-shield-generator']);
        expect(names(p1.resourceZone.cards)).toEqual(['bacta-tank', 'battlefield-marine', 'battlefield-marine']);
        expect(names(p1.base.upgrades)).toEqual(['alliance-shield-generator', 'bacta-tank']);
        const luke = p1.getAllDeckLeaders()[0];
        expect(names(luke.upgrades)).toEqual(['academy-training']);
        expect(names(luke.captureZone.cards)).toEqual(['wampa']);
        expect(names(p2.handZone.cards)).toEqual(['alliance-shield-generator', 'wampa']);
        expect(names(p2.base.upgrades)).toEqual(['alliance-shield-generator']);
        // the card Luke captured is P2's (the default owner), and P2's deck is still just the one Wampa
        expect(luke.captureZone.cards[0].owner).toBe(p2);
        expect(p2.drawDeck.map((c: any) => c.internalName)).toEqual(['wampa']);
        expect(p1.drawDeck.map((c: any) => c.internalName)).toEqual(['wampa']);

        // and the export gives back the position as written
        expect(session.exportPosition().text).toBe(resolvePosition(deps().index, { text: position }).canonicalText);
    });
});
