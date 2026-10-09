import type { Game } from '../../game/core/Game';
import { GamePipeline } from '../../game/core/GamePipeline';
import { AbilityResolver } from '../../game/core/gameSteps/AbilityResolver';
import { EventWindow } from '../../game/core/event/EventWindow';
import { TriggerWindowBase } from '../../game/core/gameSteps/abilityWindow/TriggerWindowBase';
import type { TriggeredAbilityContext } from '../../game/core/ability/TriggeredAbilityContext';
import type { Player } from '../../game/core/Player';

/**
 * READ-ONLY access to engine internals that the resolution-stack view needs.
 *
 * Every private/protected engine field the sandbox reads is read HERE and nowhere else, so an upstream rename breaks
 * exactly one file (and the sandbox spec). Nothing here mutates engine state.
 *
 *   GamePipeline.pipeline                          (private)  the step stack; last element = current step
 *   EventWindow._triggeredAbilityWindow            (protected)
 *   TriggerWindowBase.unresolved                   (protected) Map<Player, TriggeredAbilityContext[]>
 *   TriggerWindowBase.resolved                     (protected) {ability, event}[]
 *   TriggerWindowBase.resolvePlayerOrder           (private)  Player[] | null
 *   TriggerWindowBase.choosePlayerResolutionOrderComplete (protected)
 *   TriggerWindowBase.triggeringEvents             (protected)
 *   PlayerOrCardAbility.properties.abilityIdentifier (protected) e.g. 'cad-bane#impressed-now_keyword_plot_3'
 */

export type ChainLink =
  | { kind: 'resolver'; resolver: AbilityResolver }
  | { kind: 'eventWindow'; window: EventWindow }
  | { kind: 'triggerWindow'; window: TriggerWindowBase; started: boolean };

export interface ITriggerWindowState {
    unresolved: Map<Player, TriggeredAbilityContext[]>;
    resolved: { ability: any; event: any }[];
    resolvePlayerOrder: Player[] | null;
    playerOrderChosen: boolean;
    triggeringEvents: any[];
}

function pipelineSteps(pipeline: GamePipeline): any[] {
    return ((pipeline as any).pipeline ?? []) as any[];
}

export function triggerWindowState(window: TriggerWindowBase): ITriggerWindowState {
    const w = window as any;
    return {
        unresolved: w.unresolved ?? new Map(),
        resolved: w.resolved ?? [],
        resolvePlayerOrder: w.resolvePlayerOrder ?? null,
        playerOrderChosen: !!w.choosePlayerResolutionOrderComplete,
        triggeringEvents: w.triggeringEvents ?? [],
    };
}

function eventWindowTriggerWindow(window: EventWindow): TriggerWindowBase | null {
    return ((window as any)._triggeredAbilityWindow ?? null) as TriggerWindowBase | null;
}

function hasItems(window: TriggerWindowBase): boolean {
    const state = triggerWindowState(window);
    return [...state.unresolved.values()].some((list) => list.length > 0) || state.resolved.length > 0;
}

/**
 * Walks the pipeline from the game root down through each current step, outermost first, collecting the steps that
 * matter for "what is resolving": ability resolvers, event windows and trigger windows (each trigger window once).
 */
export function walkResolutionChain(game: Game): ChainLink[] {
    const chain: ChainLink[] = [];
    const seenTriggerWindows = new Set<TriggerWindowBase>();

    let pipeline: GamePipeline | null = game.pipeline;
    let guard = 0;
    while (pipeline && guard++ < 200) {
        const steps = pipelineSteps(pipeline);
        if (steps.length === 0) {
            break;
        }
        const current = steps[steps.length - 1];

        // trigger windows queued in this pipeline (below the current step, or the current step itself)
        for (const step of steps) {
            if (step instanceof TriggerWindowBase && !seenTriggerWindows.has(step)) {
                seenTriggerWindows.add(step);
                if (hasItems(step) || step === current) {
                    chain.push({ kind: 'triggerWindow', window: step, started: true });
                }
            }
        }

        if (current instanceof AbilityResolver) {
            chain.push({ kind: 'resolver', resolver: current });
        } else if (current instanceof EventWindow) {
            chain.push({ kind: 'eventWindow', window: current });
            const ownTriggerWindow = eventWindowTriggerWindow(current);
            const queuedInside = current.pipeline && pipelineSteps(current.pipeline).includes(ownTriggerWindow);
            if (ownTriggerWindow && !queuedInside && !seenTriggerWindows.has(ownTriggerWindow) && hasItems(ownTriggerWindow)) {
                seenTriggerWindows.add(ownTriggerWindow);
                chain.push({ kind: 'triggerWindow', window: ownTriggerWindow, started: false });
            }
        }

        pipeline = current && typeof current !== 'function' && current.pipeline instanceof GamePipeline ? current.pipeline : null;
    }

    return chain;
}

/** The keyword ('plot', 'ambush', 'shielded', ...) a triggered ability implements, if it is a keyword ability. */
export function abilityKeyword(ability: any): string | undefined {
    if (typeof ability?.keyword === 'string') {
        return ability.keyword;
    }
    const identifier = String(ability?.properties?.abilityIdentifier ?? '');
    const match = (/_keyword_([a-z]+)_\d+$/).exec(identifier);
    return match ? match[1] : undefined;
}
