import GameFlowWrapper from '../../helpers/GameFlowWrapper';
import GameStateBuilder from '../../helpers/GameStateBuilder';
import { SandboxSession } from '../../../server/sandbox/SandboxSession';
import { HarnessGameLoader } from '../../../server/sandbox/loader/SandboxGameLoader';
import { SandboxCardIndex } from '../../../server/sandbox/cards/SandboxCardIndex';
import { resolvePosition } from '../../../server/sandbox/position/PositionResolver';
import { cleanTokenText } from '../../../server/sandbox/stack/ResolutionStack';

// Regroup-phase positions (POSITION-FORMAT `phase: regroup`): the board as it stands at the start of the
// resource step, after the regroup draw. Used by the client's SWU Forge replay import ("pick up from here").

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

const regroup = [
    'phase: regroup',
    'initiative: P2',
    '',
    '[P1]',
    'leader: Director Krennic, Amidst My Achievement [exhausted]',
    'base: Dagobah Swamp [damage 3]',
    'ground: AT-ST [damage 1, exhausted]',
    'resource: 2x Battlefield Marine [exhausted]',
    'hand: Wampa',
    'hand: Pyke Sentinel',
    'deck: Consular Security Force',
    'deck: Battlefield Marine',
    '',
    '[P2]',
    'leader: Luke Skywalker, Faithful Friend',
    'base: Administrator\'s Tower',
    'resource: Battlefield Marine',
    'hand: Battlefield Marine',
    'deck: Wampa',
    'deck: Pyke Sentinel',
    '',
].join('\n');

describe('Sandbox regroup positions', function () {
    it('load at the resource step with the board as written, and play on into the next action phase', async function () {
        const session = new SandboxSession(deps());
        const loaded = await session.loadAsync({ position: regroup });
        expect(loaded.ok)
            .withContext(JSON.stringify((loaded as any).errors))
            .toBeTrue();

        const game: any = session.currentGame;
        expect(game.currentPhase).toBe('regroup');
        const p1 = game.getPlayerById('p1');
        expect(p1.handZone.cards.map((c: any) => c.internalName)).toEqual(['wampa', 'pyke-sentinel']);
        expect(p1.drawDeck.map((c: any) => c.internalName)).toEqual(['consular-security-force', 'battlefield-marine']);

        // both players are choosing resources
        let snapshot = session.getSnapshot();
        expect(snapshot.deciders.sort()).toEqual(['p1', 'p2']);
        expect(snapshot.prompts.p1.menuTitle).toContain('resource');
        expect(session.exportPosition().text).toBe(resolvePosition(deps().index, { text: regroup }).canonicalText);

        // both skip: the ready step readies everything and the next action phase starts with P2 (initiative)
        for (const seat of ['p1', 'p2'] as const) {
            const skip = session.getSnapshot().prompts[seat].buttons.find((b) => (/skip|done|confirm/i).test(cleanTokenText(b.text)));
            expect(skip).withContext(JSON.stringify(session.getSnapshot().prompts[seat].buttons))
                .toBeDefined();
            const result = session.act({ seat, command: 'menuButton', args: [skip.arg] });
            expect(result.ok).withContext((result as any).error)
                .toBeTrue();
        }
        snapshot = session.getSnapshot();
        expect(game.currentPhase).toBe('action');
        expect(snapshot.deciders).toEqual(['p2']);
        const atst = game.allCards.find((c: any) => c.internalName === 'atst');
        expect(atst.exhausted).toBeFalse();
    });
});
