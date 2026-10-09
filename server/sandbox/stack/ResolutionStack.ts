import type { Game } from '../../game/core/Game';
import { SubStepCheck } from '../../game/core/Constants';
import type { AbilityResolver } from '../../game/core/gameSteps/AbilityResolver';
import type { TriggerWindowBase } from '../../game/core/gameSteps/abilityWindow/TriggerWindowBase';
import type { ICardRef, IStackFrame, IStackItem, Seat } from '../SandboxTypes';
import { seatLabel } from '../SandboxTypes';
import type { ChainLink } from './EngineIntrospection';
import { abilityKeyword, triggerWindowState, walkResolutionChain } from './EngineIntrospection';

/**
 * Builds a read-only, plain-language view of what is resolving: the player's action at the bottom, each layer of
 * triggered abilities (with who orders them and what triggered them), and nested layers above the ability whose
 * resolution caused them. See CONTRACT.md "Resolution stack". Frames are returned TOP FIRST.
 */

const keywordReminders: Record<string, string> = {
    plot: 'you may play {card} from your resources, paying its cost; then replace it with the top card of your deck',
    ambush: 'you may ready {card} and have it attack an enemy unit',
    shielded: 'give a Shield token to {card}',
    restore: 'heal damage from your base',
    support: 'another unit you play gets the Support bonus',
    saboteur: 'defeat the defender\'s Shield tokens',
    bounty: 'the opponent may collect {card}\'s bounty',
};

const hiddenZones = new Set(['resource', 'hand', 'deck']);

function seatOf(player: any): Seat | undefined {
    const id = player?.id;
    return id === 'p1' || id === 'p2' ? id : undefined;
}

function capitalize(text: string) {
    return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

/** "{keyword:plot}" -> "Plot", "{aspect:villainy}" -> "Villainy", etc. */
export function cleanTokenText(text: string): string {
    return String(text ?? '').replace(/\{(\w+):([^}]+)\}/g, (_match, _kind, value) => capitalize(String(value).replace(/-/g, ' ')));
}

export function cardRef(card: any): ICardRef | undefined {
    if (!card || typeof card.uuid !== 'string') {
        return undefined;
    }
    const ref: ICardRef = {
        uuid: card.uuid,
        name: card.title ?? card.name ?? card.internalName,
        internalName: card.internalName,
    };
    if (card.setId) {
        ref.setId = { set: card.setId.set, number: card.setId.number };
    }
    const controller = seatOf(card.controller);
    if (controller) {
        ref.controller = controller;
    }
    return ref;
}

function safeTitle(ability: any, context?: any): string {
    try {
        return String(context ? ability.getTitle(context) : ability.getTitle());
    } catch {
        return String(ability?.title ?? 'ability');
    }
}

function eventLabel(event: any): string | null {
    if (!event) {
        return null;
    }
    const card = event.card?.title;
    switch (event.name) {
        case 'onLeaderDeployed':
            return `${card} was deployed`;
        case 'onCardPlayed':
            return `${card} was played`;
        case 'onUnitEntersPlay':
            return `${card} entered play`;
        case 'onCardDefeated':
            return `${card} was defeated`;
        case 'onAttackDeclared':
            return `${event.attack?.attacker?.title ?? card ?? 'a unit'} attacked`;
        case 'onAttackCompleted':
            return `${event.attack?.attacker?.title ?? card ?? 'a unit'} finished attacking`;
        case 'onDamageDealt':
            return `${card} was dealt damage`;
        case 'onCardExhausted':
            return `${card} was exhausted`;
        case 'onCardReadied':
            return `${card} was readied`;
        case 'onCardDrawn':
            return 'a card was drawn';
        case 'onPhaseStarted':
            return `the ${event.phase ?? ''} phase started`.replace(/\s+/g, ' ');
        case 'onPhaseEnded':
            return `the ${event.phase ?? ''} phase ended`.replace(/\s+/g, ' ');
        case 'onCardCaptured':
            return `${card} was captured`;
        case 'onCardDiscarded':
            return `${card} was discarded`;
        case 'onTokensCreated':
            return 'tokens were created';
        default:
            return card ? `${event.name} (${card})` : String(event.name);
    }
}

/** The kind of trigger, in rules words: "When Deployed", "When Played", "Plot", ... */
function triggerLabel(context: any): string {
    const ability = context.ability;
    const keyword = abilityKeyword(ability);
    if (keyword) {
        return capitalize(keyword);
    }
    const types: string[] = ability?.standardTriggerTypes ?? [];
    if (types.includes('whenPlayedUsingSmuggle')) {
        return 'When Played using Smuggle';
    }
    if (types.includes('whenPlayed')) {
        return 'When Played';
    }
    if (types.includes('whenDefeated')) {
        return 'When Defeated';
    }
    if (types.includes('onAttack')) {
        return 'On Attack';
    }
    if (types.includes('onDefense')) {
        return 'On Defense';
    }
    const event = context.event;
    if (event?.name === 'onLeaderDeployed' && event.card === context.source) {
        return 'When Deployed';
    }
    if (event?.name === 'onCardPlayed' && event.card === context.source) {
        return 'When Played';
    }
    if (event?.name === 'onCardDefeated' && event.card === context.source) {
        return 'When Defeated';
    }
    return 'Triggered';
}

function itemTitle(label: string, engineTitle: string, sourceTitle: string, keyword?: string): string {
    const clean = cleanTokenText(engineTitle);
    if (keyword && keywordReminders[keyword]) {
        return `${label}: ${keywordReminders[keyword].replace(/\{card\}/g, sourceTitle)}`;
    }
    if (label === 'Triggered' || clean.toLowerCase().startsWith(label.toLowerCase())) {
        return clean;
    }
    return `${label}: ${clean}`;
}

function hasLegalEffects(context: any): boolean {
    try {
        return !!context.ability.hasAnyLegalEffects(context, SubStepCheck.All);
    } catch {
        return true;
    }
}

function resolverMatchesContext(resolver: AbilityResolver, context: any): boolean {
    const resolving: any = resolver.context;
    return resolving === context || (resolving?.ability === context.ability && resolving?.event === context.event);
}

function buildItem(context: any, id: string, status: IStackItem['status']): IStackItem {
    const engineTitle = safeTitle(context.ability, context);
    const label = triggerLabel(context);
    const source = context.source;
    const item: IStackItem = {
        id,
        title: itemTitle(label, engineTitle, source?.title ?? '', abilityKeyword(context.ability)),
        label,
        engineTitle,
        sourceCard: cardRef(source),
        controller: seatOf(context.player) ?? seatOf(source?.controller) ?? 'p1',
        status,
        optional: !!context.ability?.optional,
        hasLegalEffects: status === 'resolved' ? true : hasLegalEffects(context),
    };
    if (source && hiddenZones.has(source.zoneName) && status !== 'resolved') {
        item.fromHiddenZone = true;
    }
    return item;
}

function resolverTitle(resolver: AbilityResolver): string {
    const context: any = resolver.context;
    const ability: any = context.ability;
    const source = context.source;
    if (typeof ability?.isAttackAction === 'function' && ability.isAttackAction()) {
        return `Attack with ${source?.title ?? 'a unit'}`;
    }
    const title = cleanTokenText(safeTitle(ability, context));
    if (ability?.isEpicAction) {
        return `${title} (Epic Action)`;
    }
    return title;
}

interface IBuildState {
    frames: IStackFrame[]; // bottom first while building
    nextId: number;
}

function layerFrame(state: IBuildState, window: TriggerWindowBase, started: boolean, chain: ChainLink[], game: Game): IStackFrame {
    const windowState = triggerWindowState(window);
    const frameId = `f${state.nextId++}`;
    const resolvers = chain.filter((link) => link.kind === 'resolver').map((link) => (link as { resolver: AbilityResolver }).resolver);

    const items: IStackItem[] = [];
    let itemIndex = 0;
    const pendingBySeat = new Map<Seat, IStackItem[]>();
    const resolvingItems: IStackItem[] = [];
    const triggeredBy: string[] = [];

    const order = windowState.resolvePlayerOrder ?? [...windowState.unresolved.keys()];
    const players = [...new Set([...order, ...windowState.unresolved.keys()])];
    for (const player of players) {
        for (const context of windowState.unresolved.get(player) ?? []) {
            const resolving = resolvers.some((resolver) => resolverMatchesContext(resolver, context));
            const item = buildItem(context, `${frameId}.i${itemIndex++}`, resolving ? 'resolving' : 'pending');
            const label = eventLabel((context as any).event);
            if (label && !triggeredBy.includes(label)) {
                triggeredBy.push(label);
            }
            if (resolving) {
                resolvingItems.push(item);
            } else {
                const seat = item.controller;
                const list = pendingBySeat.get(seat) ?? [];
                // group identical pending triggers (x n)
                const twin = list.find((other) => other.engineTitle === item.engineTitle && other.sourceCard?.internalName === item.sourceCard?.internalName);
                if (twin) {
                    twin.count = (twin.count ?? 1) + 1;
                } else {
                    list.push(item);
                }
                pendingBySeat.set(seat, list);
            }
        }
    }
    items.push(...resolvingItems);
    for (const player of players) {
        const seat = seatOf(player);
        if (seat) {
            items.push(...(pendingBySeat.get(seat) ?? []));
        }
    }
    for (const entry of windowState.resolved) {
        const ability = entry.ability;
        const source = ability?.card;
        const label = triggerLabel({ ability, event: entry.event, source });
        const engineTitle = safeTitle(ability);
        items.push({
            id: `${frameId}.i${itemIndex++}`,
            title: itemTitle(label, engineTitle, source?.title ?? '', abilityKeyword(ability)),
            label,
            engineTitle,
            sourceCard: cardRef(source),
            controller: seatOf(source?.controller) ?? 'p1',
            status: 'resolved',
            optional: !!ability?.optional,
            hasLegalEffects: true,
        });
    }

    // who chooses
    let chooser: IStackFrame['chooser'] = null;
    const seatsWithPending = players.filter((player) => (windowState.unresolved.get(player) ?? []).length > 0);
    if (started && !windowState.playerOrderChosen && seatsWithPending.length > 1) {
        const active = seatOf(game.getActivePlayer?.());
        if (active) {
            chooser = {
                seat: active,
                choosing: 'playerOrder',
                text: `${seatLabel(active)} (the active player) picks which player resolves all of their abilities first (CR 7.6.10)`
            };
        }
    } else if (started && resolvingItems.length === 0) {
        const current = seatOf(windowState.resolvePlayerOrder?.[0]);
        const pendingChoices = current ? (pendingBySeat.get(current) ?? []).length : 0;
        if (current && pendingChoices > 1) {
            chooser = { seat: current, choosing: 'abilityOrder', text: `${seatLabel(current)} picks which ability resolves first (CR 7.6.9)` };
        }
    }

    const controllers = [...new Set(items.map((item) => item.controller))];
    const frame: IStackFrame = {
        id: frameId,
        kind: 'triggerLayer',
        depth: state.frames.length,
        title: '', // filled in once the layer number is known
        status: started ? 'resolving' : 'collecting',
        triggeredBy,
        chooser,
        items,
        engine: {
            step: window.constructor?.name ?? 'TriggerWindow',
            detail: `${String(window)}; player order ${windowState.playerOrderChosen ? 'chosen' : 'not chosen'}; ` +
              `unresolved: ${items.filter((i) => i.status !== 'resolved').map((i) => `${i.sourceCard?.name ?? '?'}: ${i.engineTitle}`)
                  .join(' | ') || 'none'}`
        }
    };
    if (controllers.length === 1) {
        frame.controller = controllers[0];
    }
    if (!started) {
        frame.waitingReason = 'These abilities triggered during the current action or ability and resolve once it is complete (CR 7.6.8)';
    }
    if (chooser?.choosing === 'playerOrder') {
        frame.rulesHint = {
            text: 'When both players have triggered abilities at the same time, the active player chooses which player resolves all of theirs first.',
            refs: ['7.6.10']
        };
    } else if (chooser?.choosing === 'abilityOrder') {
        frame.rulesHint = {
            text: 'A player who must resolve several triggered abilities at the same time chooses the order.',
            refs: ['7.6.9']
        };
    }
    return frame;
}

export function buildResolutionStack(game: Game): IStackFrame[] {
    let chain: ChainLink[];
    try {
        chain = walkResolutionChain(game);
    } catch (error) {
        return [{
            id: 'f0', kind: 'ability', depth: 0, title: 'Stack unavailable', status: 'resolving',
            engine: { step: 'error', detail: String((error as Error)?.message ?? error) }
        }];
    }

    const state: IBuildState = { frames: [], nextId: 0 };
    const layerFrames: IStackFrame[] = [];

    // resolvers that are resolving an item of a trigger window are shown as that item, not as their own frame
    const itemResolvers = new Set<AbilityResolver>();
    const triggerWindows = chain.filter((link) => link.kind === 'triggerWindow').map((link) => (link as { window: TriggerWindowBase }).window);
    for (const link of chain) {
        if (link.kind !== 'resolver') {
            continue;
        }
        for (const window of triggerWindows) {
            const windowState = triggerWindowState(window);
            const contexts = [...windowState.unresolved.values()].flat();
            if (contexts.some((context) => resolverMatchesContext(link.resolver, context))) {
                itemResolvers.add(link.resolver);
            }
        }
    }

    for (const link of chain) {
        if (link.kind === 'triggerWindow') {
            const frame = layerFrame(state, link.window, link.started, chain, game);
            // a window with nothing left (all resolved and nothing resolving) is only noise
            if ((frame.items ?? []).length === 0) {
                continue;
            }
            state.frames.push(frame);
            layerFrames.push(frame);
        } else if (link.kind === 'resolver' && !itemResolvers.has(link.resolver)) {
            const context: any = link.resolver.context;
            const isBottom = state.frames.length === 0;
            const controller = seatOf(context.player);
            const title = resolverTitle(link.resolver);
            state.frames.push({
                id: `f${state.nextId++}`,
                kind: isBottom ? 'action' : 'ability',
                depth: state.frames.length,
                title: isBottom ? `${controller ? seatLabel(controller) + '\'s action' : 'Action'}: ${title}` : title,
                controller,
                sourceCard: cardRef(context.source),
                status: 'resolving',
                engine: {
                    step: 'AbilityResolver',
                    detail: `${context.ability?.constructor?.name ?? 'ability'} '${safeTitle(context.ability, context)}' from ${context.source?.internalName ?? '?'}`
                },
                ...(isBottom ? { rulesHint: { text: 'Abilities that trigger during an action wait until the action is complete, then resolve (CR 7.6.8).', refs: ['7.6.8', '6.4.0.g'] } } : {})
            });
        }
    }

    // titles, nesting, status
    let layerNumber = 0;
    for (let i = 0; i < state.frames.length; i++) {
        const frame = state.frames[i];
        frame.depth = i;
        if (frame.kind === 'triggerLayer') {
            layerNumber++;
            // nested under the nearest resolving item (or ability) below this layer
            let nestedUnder: IStackFrame['nestedUnder'];
            for (let j = i - 1; j >= 0 && !nestedUnder; j--) {
                const below = state.frames[j];
                const resolvingItem = below.items?.find((item) => item.status === 'resolving');
                if (resolvingItem) {
                    nestedUnder = { frameId: below.id, itemId: resolvingItem.id, title: `${resolvingItem.label} (${resolvingItem.sourceCard?.name ?? '?'})` };
                } else if (below.kind === 'ability') {
                    nestedUnder = { frameId: below.id, title: below.title };
                }
            }
            const cause = frame.triggeredBy?.length ? `triggered when ${frame.triggeredBy.join(', ')}` : 'triggered abilities';
            if (nestedUnder) {
                frame.nestedUnder = nestedUnder;
                frame.title = `Layer ${layerNumber} · nested: ${cause}, while resolving ${nestedUnder.title}`;
                frame.rulesHint = {
                    text: 'Abilities triggered while another ability resolves are nested: the new layer must be fully resolved before returning to the abilities waiting in earlier layers.' +
                      (frame.rulesHint ? ' ' + frame.rulesHint.text : ''),
                    refs: ['7.6.11', '7.6.12', '7.1.6.e', ...(frame.rulesHint?.refs ?? [])]
                };
            } else {
                frame.title = `Layer ${layerNumber} · ${cause}`;
            }
        }
    }

    const top = state.frames.length - 1;
    for (let i = 0; i < state.frames.length; i++) {
        const frame = state.frames[i];
        if (i === top) {
            if (frame.status !== 'collecting') {
                frame.status = 'resolving';
            }
            continue;
        }
        if (frame.status === 'collecting') {
            continue;
        }
        frame.status = 'waiting';
        if (frame.kind === 'triggerLayer') {
            frame.waitingReason = 'Waits until the nested layer above is finished (CR 7.6.11)';
            for (const item of frame.items ?? []) {
                if (item.status === 'resolving') {
                    // still mid-resolution: its nested abilities resolve first
                    item.status = 'resolving';
                }
            }
        } else {
            frame.waitingReason = 'Waits for everything above it to finish';
        }
    }

    return state.frames.reverse();
}
