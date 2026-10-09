import GameFlowWrapper from '../../helpers/GameFlowWrapper';
import GameStateBuilder from '../../helpers/GameStateBuilder';
import { SandboxSession } from '../../../server/sandbox/SandboxSession';
import { HarnessGameLoader } from '../../../server/sandbox/loader/SandboxGameLoader';
import { SandboxCardIndex } from '../../../server/sandbox/cards/SandboxCardIndex';
import { sandboxPresets } from '../../../server/sandbox/SandboxPresets';
import { resolvePosition } from '../../../server/sandbox/position/PositionResolver';
import { cleanTokenText } from '../../../server/sandbox/stack/ResolutionStack';
import type { ISandboxSnapshot, IStackFrame, Seat } from '../../../server/sandbox/SandboxTypes';

/**
 * Engine-level acceptance test for the sandbox: the Krennic (LAW 008) deploy + Cad Bane (SEC 034) Plot position,
 * played in BOTH trigger orders through the transport-agnostic SandboxSession, checking the resolution-stack snapshots,
 * the outcomes, branching via replay, determinism, tree serialisation and position export.
 */

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

const presetText = sandboxPresets.find((preset) => preset.id === 'krennic-cad-bane').text;

function uuidOf(session: SandboxSession, internalName: string, seat?: Seat): string {
    const card = (session.currentGame as any).allCards.find((c: any) => c.internalName === internalName && (!seat || c.owner.id === seat));
    expect(card).withContext(`card ${internalName}`)
        .toBeDefined();
    return card.uuid;
}

function cardOf(session: SandboxSession, internalName: string, seat: Seat): any {
    return (session.currentGame as any).allCards.find((c: any) => c.internalName === internalName && c.owner.id === seat);
}

function clickCard(session: SandboxSession, internalName: string, seat?: Seat): ISandboxSnapshot {
    const result = session.act({ command: 'cardClicked', args: [uuidOf(session, internalName, seat)] });
    expect(result.ok).withContext(`click ${internalName}: ${(result as any).error}`)
        .toBeTrue();
    return result.snapshot;
}

function clickButton(session: SandboxSession, text: string): ISandboxSnapshot {
    const snapshot = session.getSnapshot();
    const seat = snapshot.deciders[0];
    const button = snapshot.prompts[seat].buttons.find((b) => cleanTokenText(b.text) === text);
    expect(button).withContext(`button '${text}' among ${JSON.stringify(snapshot.prompts[seat].buttons.map((b) => b.text))}`)
        .toBeDefined();
    // pass a stale prompt uuid on purpose: the session fills in the current one
    const result = session.act({ command: 'menuButton', args: [button.arg, 'stale-uuid'] });
    expect(result.ok).withContext(`click '${text}': ${(result as any).error}`)
        .toBeTrue();
    return result.snapshot;
}

function buttonTexts(snapshot: ISandboxSnapshot, seat: Seat = 'p1') {
    return snapshot.prompts[seat].buttons.map((b) => cleanTokenText(b.text));
}

function layerItems(frame: IStackFrame) {
    return (frame.items ?? []).map((item) => `${item.label}|${item.sourceCard?.name}|${item.status}`);
}

/** Deploys Krennic from the preset's root and returns the snapshot at the trigger-order decision. */
async function loadAndDeploy(session: SandboxSession): Promise<ISandboxSnapshot> {
    const loaded = await session.loadAsync({ position: presetText });
    expect(loaded.ok).withContext(JSON.stringify((loaded as any).errors))
        .toBeTrue();
    clickCard(session, 'director-krennic#amidst-my-achievement', 'p1');
    return clickButton(session, 'Deploy Director Krennic');
}

describe('Sandbox: Krennic deploy + Cad Bane Plot', function () {
    it('loads the preset position with the expected board and an empty stack', async function () {
        const session = new SandboxSession(deps());
        const loaded = await session.loadAsync({ position: presetText });
        expect(loaded.ok).withContext(JSON.stringify((loaded as any).errors))
            .toBeTrue();
        const snapshot = session.getSnapshot();
        expect(snapshot.stack).toEqual([]);
        expect(snapshot.deciders).toEqual(['p1']);
        expect(snapshot.prompts.p1.promptType).toBe('actionWindow');
        expect(snapshot.prompts.p2.deciding).toBeFalse();
        expect(cardOf(session, 'cad-bane#impressed-now', 'p1').zoneName).toBe('resource');
        expect(cardOf(session, 'battlefield-marine', 'p2').damage).toBe(1);
        // both hands are visible in the god view, neither in the opponent's seat view
        const godHandP2 = snapshot.godView.players.p2.cardPiles.hand;
        expect(godHandP2.length).toBe(1);
        expect(godHandP2[0].name).toBe('Wampa');
        expect(snapshot.views.p1.players.p2.cardPiles.hand[0].name).toBeUndefined();
    });

    it('Plot first: Cad Bane\'s When Played nests above the waiting Krennic trigger; Krennic can then use Cad Bane', async function () {
        const session = new SandboxSession(deps());
        let snapshot = await loadAndDeploy(session);

        // --- frame A: one layer, P1 orders Krennic's When Deployed and Cad Bane's Plot
        expect(buttonTexts(snapshot)).toEqual(jasmine.arrayWithExactContents([
            'Play Cad Bane using Plot',
            'Another friendly unit deals damage equal to its power to an enemy unit'
        ]));
        expect(snapshot.stack.length).toBe(2);
        const [layerA, actionA] = snapshot.stack;
        expect(layerA.kind).toBe('triggerLayer');
        expect(layerA.status).toBe('resolving');
        expect(layerA.chooser).toEqual(jasmine.objectContaining({ seat: 'p1', choosing: 'abilityOrder' }));
        expect(layerA.triggeredBy).toContain('Director Krennic was deployed');
        expect(layerItems(layerA)).toEqual(jasmine.arrayWithExactContents([
            'When Deployed|Director Krennic|pending',
            'Plot|Cad Bane|pending'
        ]));
        const plotItem = layerA.items.find((item) => item.label === 'Plot');
        expect(plotItem.optional).toBeTrue();
        expect(plotItem.fromHiddenZone).toBeTrue();
        expect(plotItem.controller).toBe('p1');
        expect(layerA.items.find((item) => item.label === 'When Deployed').title)
            .toBe('When Deployed: Another friendly unit deals damage equal to its power to an enemy unit');
        expect(actionA.kind).toBe('action');
        expect(actionA.title).toContain('Deploy Director Krennic');
        expect(actionA.status).toBe('waiting');

        // --- choose Plot
        snapshot = clickButton(session, 'Play Cad Bane using Plot');
        expect(buttonTexts(snapshot)).toEqual(['Trigger', 'Pass']);
        expect(layerItems(snapshot.stack[0])).toEqual(['Plot|Cad Bane|resolving', 'When Deployed|Director Krennic|pending']);
        expect(snapshot.stack[0].chooser).toBeNull();
        snapshot = clickButton(session, 'Trigger');

        // --- frame B: Cad Bane is in play; his When Played is a NESTED layer above the waiting Krennic trigger
        expect(cardOf(session, 'cad-bane#impressed-now', 'p1').zoneName).toBe('groundArena');
        expect(cardOf(session, 'pyke-sentinel', 'p1').zoneName).toBe('resource');
        expect(snapshot.prompts.p1.menuTitle).toContain('Defeat a unit with 2 or less remaining HP');
        const top = snapshot.stack[0];
        expect(top.kind).toBe('triggerLayer');
        expect(layerItems(top)).toEqual(['When Played|Cad Bane|resolving']);
        expect(top.nestedUnder?.title).toContain('Plot');
        expect(top.title).toContain('nested');
        expect(top.rulesHint.refs).toContain('7.6.11');
        const outer = snapshot.stack.find((frame) => frame !== top && frame.kind === 'triggerLayer');
        expect(outer.status).toBe('waiting');
        expect(layerItems(outer)).toEqual(['Plot|Cad Bane|resolving', 'When Deployed|Director Krennic|pending']);
        expect(snapshot.stack.indexOf(outer)).toBeGreaterThan(0);
        expect(snapshot.stack[snapshot.stack.length - 1].kind).toBe('action');

        // the nested When Played can only defeat the already-damaged Battlefield Marine (2 HP left)
        expect(snapshot.prompts.p1.selectableCardUuids).toEqual([uuidOf(session, 'battlefield-marine', 'p2')]);
        snapshot = clickCard(session, 'battlefield-marine', 'p2');
        expect(cardOf(session, 'battlefield-marine', 'p2').zoneName).toBe('discard');

        // --- back in layer 1: Krennic resolves; Cad Bane is now a legal "another friendly unit"
        expect(layerItems(snapshot.stack[0])).toEqual(jasmine.arrayWithExactContents([
            'When Deployed|Director Krennic|resolving',
            'Plot|Cad Bane|resolved'
        ]));
        expect(snapshot.prompts.p1.selectableCardUuids).toEqual(jasmine.arrayWithExactContents([
            uuidOf(session, 'atst', 'p1'),
            uuidOf(session, 'cad-bane#impressed-now', 'p1')
        ]));
        clickCard(session, 'cad-bane#impressed-now', 'p1');
        snapshot = clickCard(session, 'consular-security-force', 'p2');

        // --- outcome: Consular Security Force took 4 and survives; the action is over
        expect(cardOf(session, 'consular-security-force', 'p2').damage).toBe(4);
        expect(cardOf(session, 'consular-security-force', 'p2').zoneName).toBe('groundArena');
        expect(snapshot.stack).toEqual([]);
        expect(snapshot.deciders).toEqual(['p2']);
    });

    it('Krennic first: the AT-ST damages Consular Security Force, then Cad Bane\'s When Played defeats it', async function () {
        const session = new SandboxSession(deps());
        let snapshot = await loadAndDeploy(session);

        snapshot = clickButton(session, 'Another friendly unit deals damage equal to its power to an enemy unit');
        expect(layerItems(snapshot.stack[0])).toEqual(['When Deployed|Director Krennic|resolving', 'Plot|Cad Bane|pending']);
        // Cad Bane is still a resource, so the AT-ST is the only friendly unit that can deal the damage
        expect(snapshot.prompts.p1.selectableCardUuids).toEqual([uuidOf(session, 'atst', 'p1')]);
        clickCard(session, 'atst', 'p1');
        snapshot = clickCard(session, 'consular-security-force', 'p2');
        expect(cardOf(session, 'consular-security-force', 'p2').damage).toBe(6);

        // Plot is the only trigger left: straight to its "you may"
        expect(buttonTexts(snapshot)).toEqual(['Trigger', 'Pass']);
        expect(layerItems(snapshot.stack[0])).toEqual(['Plot|Cad Bane|resolving', 'When Deployed|Director Krennic|resolved']);
        snapshot = clickButton(session, 'Trigger');

        // nested When Played: Consular Security Force (1 HP left) and Battlefield Marine (2 HP left) are both targets
        expect(snapshot.stack[0].nestedUnder?.title).toContain('Plot');
        expect(layerItems(snapshot.stack[0])).toEqual(['When Played|Cad Bane|resolving']);
        expect(snapshot.prompts.p1.selectableCardUuids).toEqual(jasmine.arrayWithExactContents([
            uuidOf(session, 'consular-security-force', 'p2'),
            uuidOf(session, 'battlefield-marine', 'p2')
        ]));
        snapshot = clickCard(session, 'consular-security-force', 'p2');

        expect(cardOf(session, 'consular-security-force', 'p2').zoneName).toBe('discard');
        expect(cardOf(session, 'battlefield-marine', 'p2').zoneName).toBe('groundArena');
        expect(snapshot.stack).toEqual([]);
        expect(snapshot.deciders).toEqual(['p2']);
    });

    it('branches at the trigger-order decision and switches between both lines by replaying from the root', async function () {
        const session = new SandboxSession(deps());
        const frameA = await loadAndDeploy(session);
        const forkNode = frameA.nodeId;

        // line 1: Plot first
        clickButton(session, 'Play Cad Bane using Plot');
        clickButton(session, 'Trigger');
        clickCard(session, 'battlefield-marine', 'p2');
        clickCard(session, 'cad-bane#impressed-now', 'p1');
        const plotLeaf = clickCard(session, 'consular-security-force', 'p2');
        const plotLeafId = plotLeaf.nodeId;
        const plotExport = session.exportPosition().text;
        const plotCadBaneUuid = uuidOf(session, 'cad-bane#impressed-now', 'p1');

        // jump back to the fork: same frame A as before (deterministic replay)
        const back = await session.gotoAsync(forkNode);
        expect(back.ok).toBeTrue();
        expect(back.snapshot.stack).toEqual(frameA.stack);
        expect(back.snapshot.prompts).toEqual(frameA.prompts);

        // line 2: Krennic first -> a sibling branch at the fork
        clickButton(session, 'Another friendly unit deals damage equal to its power to an enemy unit');
        clickCard(session, 'atst', 'p1');
        clickCard(session, 'consular-security-force', 'p2');
        clickButton(session, 'Trigger');
        const krennicLeaf = clickCard(session, 'consular-security-force', 'p2');
        const tree = krennicLeaf.tree;
        expect(tree.nodes[forkNode].children.length).toBe(2);
        expect(tree.mainLine).toContain(plotLeafId);
        expect(tree.mainLine).not.toContain(krennicLeaf.nodeId);
        expect(cardOf(session, 'consular-security-force', 'p2').zoneName).toBe('discard');

        // re-taking an existing choice reuses the node instead of duplicating the branch
        await session.gotoAsync(forkNode);
        const again = session.act({ command: 'menuButton', args: [frameA.prompts.p1.buttons.find((b) => cleanTokenText(b.text).startsWith('Play Cad Bane')).arg] });
        expect(again.ok && again.reusedExistingNode).toBeTrue();

        // switch back to the Plot-first leaf: identical board, identical uuids
        const plotAgain = await session.gotoAsync(plotLeafId);
        expect(plotAgain.ok).toBeTrue();
        expect(session.exportPosition().text).toBe(plotExport);
        expect(uuidOf(session, 'cad-bane#impressed-now', 'p1')).toBe(plotCadBaneUuid);
        expect(cardOf(session, 'consular-security-force', 'p2').damage).toBe(4);

        // promote the Krennic-first line to the main line
        const promoted = await session.promoteNodeAsync(krennicLeaf.nodeId);
        expect(promoted.ok && promoted.snapshot.tree.mainLine.includes(krennicLeaf.nodeId)).toBeTrue();

        // serialise, restore into a fresh session, land on the same node with the same board
        const saved = JSON.parse(JSON.stringify(session.serializeTree()));
        const restored = new SandboxSession(deps());
        const reloaded = await restored.loadAsync({ tree: saved });
        expect(reloaded.ok).toBeTrue();
        expect(restored.currentNode).toBe(plotLeafId);
        expect(restored.exportPosition().text).toBe(plotExport);
        expect(Object.keys(restored.getSnapshot().tree.nodes).sort()).toEqual(Object.keys(session.getSnapshot().tree.nodes).sort());

        // deleting the current branch moves to its parent
        const deleted = await session.deleteNodeAsync(plotLeafId);
        expect(deleted.ok).toBeTrue();
        expect(deleted.snapshot.tree.nodes[plotLeafId]).toBeUndefined();
    });

    it('rejects input from the wrong seat and input with no effect, without adding tree nodes', async function () {
        const session = new SandboxSession(deps());
        await session.loadAsync({ position: presetText });
        const p2Click = session.act({ seat: 'p2', command: 'cardClicked', args: [uuidOf(session, 'consular-security-force', 'p2')] });
        expect(p2Click.ok).toBeFalse();
        const undo = session.act({ command: 'rollbackToSnapshot', args: [{ type: 'quick' }] });
        expect(undo.ok).toBeFalse();
        expect(Object.keys(session.getSnapshot().tree.nodes)).toEqual(['root']);
    });

    it('round-trips the position: text -> setup DSL -> engine -> export -> the same text', async function () {
        const { index } = deps();
        const session = new SandboxSession(deps());
        await session.loadAsync({ position: presetText });
        const canonical = resolvePosition(index, { text: presetText }).canonicalText;
        expect(session.exportPosition().text).toBe(canonical);
    });

    it('reports position errors with paths and line numbers', async function () {
        const session = new SandboxSession(deps());
        const result = await session.loadAsync({
            position: [
                '[P1]',
                'leader: Director Krennic',
                'ground: Wampa [damage 9]',
                'space: AT-ST',
                'hand: Shield',
                'resource: Cad Bane, Impressed Now? [sideways]',
            ].join('\n')
        });
        expect(result.ok).toBeFalse();
        const errors = (result as any).errors as { path: string; message: string; line?: number }[];
        const byLine = (line: number) => errors.filter((error) => error.line === line).map((error) => error.message)
            .join(' / ');
        expect(byLine(2)).toContain('Ambiguous');
        expect(byLine(3)).toContain('defeat it at once');
        expect(byLine(4)).toContain('ground unit');
        expect(byLine(5)).toContain('token');
        expect(byLine(6)).toContain('Unknown modifier');
    });
});
