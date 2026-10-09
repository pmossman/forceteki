import GameFlowWrapper from '../../helpers/GameFlowWrapper';
import GameStateBuilder from '../../helpers/GameStateBuilder';
import { SandboxSession } from '../../../server/sandbox/SandboxSession';
import { HarnessGameLoader } from '../../../server/sandbox/loader/SandboxGameLoader';
import { SandboxCardIndex } from '../../../server/sandbox/cards/SandboxCardIndex';
import { sandboxPresets } from '../../../server/sandbox/SandboxPresets';
import { resolvePosition } from '../../../server/sandbox/position/PositionResolver';
import { formatPositionText, parsePositionText } from '../../../server/sandbox/position/PositionText';
import { cleanTokenText } from '../../../server/sandbox/stack/ResolutionStack';
import type { ISandboxSnapshot, Seat } from '../../../server/sandbox/SandboxTypes';

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

function card(session: SandboxSession, internalName: string, owner: Seat): any {
    return (session.currentGame as any).allCards.find((c: any) => c.internalName === internalName && c.owner.id === owner);
}

function clickButton(session: SandboxSession, text: string): ISandboxSnapshot {
    const snapshot = session.getSnapshot();
    const seat = snapshot.deciders[0];
    const button = snapshot.prompts[seat].buttons.find((b) => cleanTokenText(b.text) === text);
    expect(button)
        .withContext(`button '${text}' among ${JSON.stringify(snapshot.prompts[seat].buttons.map((b) => b.text))}`)
        .toBeDefined();
    const result = session.act({ command: 'menuButton', args: [button.arg] });
    expect(result.ok)
        .withContext(`click '${text}': ${(result as any).error}`)
        .toBeTrue();
    return result.snapshot;
}

function clickCard(session: SandboxSession, internalName: string, owner: Seat, seat?: Seat): ISandboxSnapshot {
    const result = session.act({ seat, command: 'cardClicked', args: [card(session, internalName, owner).uuid] });
    expect(result.ok)
        .withContext(`click ${internalName}: ${(result as any).error}`)
        .toBeTrue();
    return result.snapshot;
}

const kitchenSink = [
    '# Kitchen sink',
    'phase: action',
    'initiative: P2',
    'active: P1',
    '',
    '[P1]',
    'leader: Iden Versio, Inferno Squad Commander [deployed, damage 2]',
    '  + Shield',
    'base: Dagobah Swamp [damage 5]',
    'ground: Wampa [damage 1, exhausted]',
    '  + Experience',
    '  + Shield',
    'ground: Battlefield Marine [owner P2]',
    'space: Green Squadron A-Wing',
    'resource: 3x Underworld Thug',
    'resource: 2x Underworld Thug [exhausted]',
    'hand: Wampa',
    'deck: Pyke Sentinel',
    'deck: Moisture Farmer',
    'discard: Moisture Farmer',
    'discard: Pyke Sentinel',
    'credits: 2',
    'force: yes',
    '',
    '[P2]',
    'leader: Luke Skywalker, Faithful Friend [epic action used]',
    'base: Administrator\'s Tower',
    'ground: Consular Security Force',
    '  + Academy Training [owner P1]',
    '  captured: Rebel Pathfinder',
    'ground: 2x Battle Droid',
    'resource: 4x Underworld Thug',
    'deck: 3x Underworld Thug',
    '',
].join('\n');

describe('Sandbox positions', function () {
    it('parses and formats position text losslessly', function () {
        const parsed = parsePositionText(kitchenSink);
        expect(parsed.errors).toEqual([]);
        expect(formatPositionText(parsed.position)).toBe(kitchenSink);
        expect(parsed.position.p2.ground.length).toBe(3);
        expect(parsed.position.p2.ground[0].upgrades).toEqual([jasmine.objectContaining({ card: 'Academy Training', owner: 'p1' })]);
        expect(parsed.position.p1.leader).toEqual(jasmine.objectContaining({ deployed: true, damage: 2 }));
    });

    it('accepts set codes, internal names and loose spelling, and writes canonical names back', function () {
        const { index } = deps();
        const result = resolvePosition(index, {
            text: '[P1]\nleader: director krennic amidst my achievement\nresource: SEC 034\nresource: cad-bane#impressed-now\nground: atst\n'
        });
        expect(result.errors).toEqual([]);
        expect(result.canonicalText).toContain('leader: Director Krennic, Amidst My Achievement');
        expect(result.canonicalText).toContain('resource: 2x Cad Bane, Impressed Now?');
        expect(result.canonicalText).toContain('ground: AT-ST');
    });

    it('builds every position feature in the engine and exports exactly the same text', async function () {
        const session = new SandboxSession(deps());
        const loaded = await session.loadAsync({ position: kitchenSink });
        expect(loaded.ok)
            .withContext(JSON.stringify((loaded as any).errors))
            .toBeTrue();
        expect(session.getSnapshot().engineErrors).toBeUndefined();

        // stolen unit, opponent-owned upgrade, captured card, tokens, credits, force, epic action, active player
        expect(card(session, 'battlefield-marine', 'p2').controller.id).toBe('p1');
        const academyTraining = card(session, 'academy-training', 'p1');
        expect(academyTraining.parentCard.internalName).toBe('consular-security-force');
        expect(card(session, 'rebel-pathfinder', 'p1').zoneName).toBe('capture');
        const iden = card(session, 'iden-versio#inferno-squad-commander', 'p1');
        expect(iden.upgrades.map((u: any) => u.internalName)).toEqual(['shield']);
        expect((session.currentGame as any).getPlayerById('p1').creditTokenCount).toBe(2);
        expect((session.currentGame as any).getPlayerById('p1').hasTheForce).toBeTrue();
        expect(session.getSnapshot().deciders).toEqual(['p1']);

        const canonical = resolvePosition(deps().index, { text: kitchenSink }).canonicalText;
        expect(canonical).toBe(kitchenSink);
        expect(session.exportPosition().text).toBe(canonical);
    });

    it('loads every preset', async function () {
        for (const preset of sandboxPresets) {
            const session = new SandboxSession(deps());
            const loaded = await session.loadAsync({ position: preset.text });
            expect(loaded.ok)
                .withContext(`${preset.id}: ${JSON.stringify((loaded as any).errors)}`)
                .toBeTrue();
            expect(session.getSnapshot().deciders).toEqual(['p1']);
            expect(session.exportPosition().text).toBe(resolvePosition(deps().index, { text: preset.text }).canonicalText);
        }
    });

    it('hotseat: attributes the opponent\'s decision inside a nested layer and routes seat-less input to it (Krayt Dragon)', async function () {
        const session = new SandboxSession(deps());
        await session.loadAsync({ position: sandboxPresets.find((preset) => preset.id === 'iden-plot-krayt').text });
        clickCard(session, 'iden-versio#inferno-squad-commander', 'p1');
        let snapshot = clickButton(session, 'Deploy Iden Versio');
        expect(snapshot.stack[0].items.length).toBe(3);

        clickButton(session, 'Play Cad Bane using Plot');
        snapshot = clickButton(session, 'Trigger');

        // Cad Bane's When Played (P1) and Krayt Dragon's trigger (P2) are in the same nested layer: P1 (active) picks the player order
        const nested = snapshot.stack[0];
        expect(nested.nestedUnder?.title).toContain('Plot');
        expect(nested.chooser).toEqual(jasmine.objectContaining({ seat: 'p1', choosing: 'playerOrder' }));
        expect(new Set(nested.items.map((item) => item.controller))).toEqual(new Set<Seat>(['p1', 'p2']));
        snapshot = clickButton(session, 'You');

        clickCard(session, 'battlefield-marine', 'p2');
        snapshot = session.getSnapshot();
        expect(snapshot.deciders).toEqual(['p2']);
        expect(snapshot.prompts.p2.deciding).toBeTrue();
        expect(snapshot.prompts.p1.deciding).toBeFalse();

        // no seat given: goes to P2, the only decider
        const base = (session.currentGame as any).getPlayerById('p1').base;
        const result = session.act({ command: 'cardClicked', args: [base.uuid] });
        expect(result.ok).toBeTrue();
        expect(base.damage).toBe(5);
        expect((result as any).snapshot.tree.nodes[(result as any).nodeId].seat).toBe('p2');
    });
});
