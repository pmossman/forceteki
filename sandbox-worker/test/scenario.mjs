// Transport-independent acceptance scenario for the sandbox protocol: Krennic + Cad Bane, both trigger orders,
// a branch, a jump back, export. `call(method, payload)` must resolve with the dispatcher's result.
// Returns { passed, failed, log } and never throws on assertion failure.

const clean = (text) => String(text).replace(/\{(\w+):([^}]+)\}/g, (_m, _k, v) => v[0].toUpperCase() + v.slice(1));

export async function runScenario(call) {
    const log = [];
    let passed = 0;
    let failed = 0;
    const check = (label, condition, detail) => {
        if (condition) {
            passed++;
            log.push(`ok   ${label}`);
        } else {
            failed++;
            log.push(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
        }
    };

    const t0 = performance.now();
    const presets = (await call('getPresets', {})).presets;
    const preset = presets.find((p) => p.id === 'krennic-cad-bane');
    const loaded = await call('load', { position: preset.text });
    check('load preset', loaded.ok, loaded.errors);
    let snap = loaded.snapshot;
    const timings = { loadMs: performance.now() - t0 };

    const uuid = (name, owner) => {
        const views = snap.godView.players;
        for (const seat of ['p1', 'p2']) {
            const player = views[seat];
            const piles = [...Object.values(player.cardPiles).flat(), ...(player.leaders ?? []), player.base];
            const card = piles.find((c) => c && c.name === name && (!owner || c.ownerId === owner));
            if (card) {
                return card.uuid;
            }
        }
        return null;
    };
    const act = async (command, args, label) => {
        const r = await call('act', { command, args });
        check(label, r.ok, r.error);
        if (r.snapshot) {
            snap = r.snapshot;
        }
        return r;
    };
    const button = async (text) => {
        const seat = snap.deciders[0];
        const b = snap.prompts[seat].buttons.find((x) => clean(x.text) === text);
        check(`button '${text}' offered`, !!b, snap.prompts[seat].buttons.map((x) => x.text));
        return act('menuButton', [b?.arg], `click '${text}'`);
    };
    const items = (frame) => (frame?.items ?? []).map((i) => `${i.label}|${i.sourceCard?.name}|${i.status}`).sort();

    await act('cardClicked', [uuid('Director Krennic')], 'click Krennic');
    await button('Deploy Director Krennic');
    const fork = snap.nodeId;
    check('frame A: one layer + action', snap.stack.length === 2 && snap.stack[1].kind === 'action', snap.stack.map((f) => f.kind));
    check('frame A: P1 orders', snap.stack[0].chooser?.seat === 'p1' && snap.stack[0].chooser?.choosing === 'abilityOrder', snap.stack[0].chooser);
    check('frame A: items', JSON.stringify(items(snap.stack[0])) === JSON.stringify(['Plot|Cad Bane|pending', 'When Deployed|Director Krennic|pending']), items(snap.stack[0]));

    // Plot first
    await button('Play Cad Bane using Plot');
    await button('Trigger');
    check('frame B: nested When Played on top', snap.stack[0].nestedUnder?.title?.includes('Plot') && items(snap.stack[0])[0] === 'When Played|Cad Bane|resolving', snap.stack[0]);
    await act('cardClicked', [uuid('Battlefield Marine', 'p2')], 'Cad Bane defeats Battlefield Marine');
    await act('cardClicked', [uuid('Cad Bane')], 'Krennic picks Cad Bane');
    await act('cardClicked', [uuid('Consular Security Force')], 'Cad Bane deals 4 to CSF');
    const csfPlot = snap.godView.players.p2.cardPiles.groundArena.find((c) => c.name === 'Consular Security Force');
    check('Plot first: CSF survives with 4 damage', csfPlot && csfPlot.damage === 4, csfPlot);
    check('Plot first: P2 to act', JSON.stringify(snap.deciders) === '["p2"]', snap.deciders);
    const plotLeaf = snap.nodeId;
    const plotExport = (await call('exportPosition', {})).text;

    // back to the fork, Krennic first
    const t1 = performance.now();
    const back = await call('goto', { nodeId: fork });
    timings.gotoForkMs = performance.now() - t1;
    snap = back.snapshot;
    check('goto fork', back.ok && snap.nodeId === fork, back.error);
    await button('Another friendly unit deals damage equal to its power to an enemy unit');
    await act('cardClicked', [uuid('AT-ST')], 'Krennic picks AT-ST');
    await act('cardClicked', [uuid('Consular Security Force')], 'AT-ST deals 6 to CSF');
    await button('Trigger');
    await act('cardClicked', [uuid('Consular Security Force')], 'Cad Bane defeats CSF');
    check('Krennic first: CSF defeated', snap.godView.players.p2.cardPiles.discard.some((c) => c.name === 'Consular Security Force'));
    check('fork has two branches', snap.tree.nodes[fork].children.length === 2, snap.tree.nodes[fork].children);

    const t2 = performance.now();
    const again = await call('goto', { nodeId: plotLeaf });
    timings.gotoPlotLeafMs = performance.now() - t2;
    check('switch back to Plot-first leaf', again.ok && (await call('exportPosition', {})).text === plotExport);

    const tree = await call('serializeTree', {});
    check('serialised tree', tree.format === 'karabast-sandbox-tree' && tree.nodes.length > 10, tree.nodes?.length);
    timings.totalMs = performance.now() - t0;
    return { passed, failed, log, timings };
}
