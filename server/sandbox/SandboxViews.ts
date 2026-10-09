import type { Game } from '../game/core/Game';
import type { IPromptInfo, Seat } from './SandboxTypes';
import { Seats } from './SandboxTypes';
import { cleanTokenText } from './stack/ResolutionStack';

/** Per-seat views, the merged "god view", prompt attribution and the plain-text log. */

const selectionKeys = ['selectable', 'selected', 'unselectable', 'order'];
const hiddenPiles = ['hand', 'resources', 'capturedZone', 'outsideTheGame'];

export function getDeciders(game: Game): Seat[] {
    if (game.isEnded) {
        return [];
    }
    const prompt: any = game.getCurrentOpenPrompt();
    const deciders: Seat[] = [];
    for (const seat of Seats) {
        const player: any = game.getPlayerById(seat);
        if (!player) {
            continue;
        }
        let active = false;
        try {
            active = prompt ? !!prompt.activeCondition(player) : false;
        } catch {
            active = false;
        }
        const state = player.promptState;
        const looksWaiting = String(state.menuTitle ?? '').startsWith('Waiting for') &&
          (state.buttons ?? []).length === 0 && (state.selectableCards ?? []).length === 0;
        if (active && !looksWaiting) {
            deciders.push(seat);
        }
    }
    return deciders;
}

export function getPromptInfo(game: Game, seat: Seat, deciders: Seat[]): IPromptInfo {
    const player: any = game.getPlayerById(seat);
    const state = player.promptState;
    return {
        seat,
        deciding: deciders.includes(seat),
        menuTitle: String(state.menuTitle ?? ''),
        promptTitle: String(state.promptTitle ?? ''),
        promptType: String(state.promptType ?? ''),
        buttons: (state.buttons ?? []).map((button: any) => ({ text: String(button.text), arg: button.arg, command: button.command ?? 'menuButton' })),
        selectableCardUuids: (state.selectableCards ?? []).map((card: any) => card.uuid),
    };
}

function copySelection(from: any, to: any) {
    if (!from || !to) {
        return;
    }
    for (const key of selectionKeys) {
        // undefined (rather than delete) so JSON.stringify drops it
        to[key] = key in from ? from[key] : undefined;
    }
}

/**
 * Both hands face up. Starts from the deciding seat's view (P1's when nobody or both decide) so selection flags are
 * the decider's, then swaps in each player's own unmasked hidden piles, carrying the decider's selection flags over.
 */
export function buildGodView(views: { p1: any; p2: any }, deciders: Seat[]): any {
    const baseSeat: Seat = deciders.length === 1 ? deciders[0] : 'p1';
    const god = JSON.parse(JSON.stringify(views[baseSeat] ?? {}));
    if (!god.players) {
        return god;
    }
    for (const seat of Seats) {
        const own = views[seat]?.players?.[seat];
        const target = god.players[seat];
        if (!own || !target) {
            continue;
        }
        target.cardPiles = target.cardPiles ?? {};
        for (const pile of hiddenPiles) {
            const ownPile: any[] = own.cardPiles?.[pile];
            if (!Array.isArray(ownPile)) {
                continue;
            }
            const basePile: any[] = target.cardPiles[pile] ?? [];
            const byUuid = new Map(basePile.filter((card) => card?.uuid).map((card) => [card.uuid, card]));
            target.cardPiles[pile] = ownPile.map((card, i) => {
                const copy = JSON.parse(JSON.stringify(card));
                copySelection(byUuid.get(card.uuid) ?? basePile[i], copy);
                return copy;
            });
        }
        target.promptState = own.promptState ?? target.promptState;
        if (own.topCardOfDeck) {
            target.topCardOfDeck = own.topCardOfDeck;
        }
    }
    return god;
}

function chatItemToString(item: any): string {
    if (item == null) {
        return '';
    }
    if (Array.isArray(item)) {
        return item.map(chatItemToString).join('');
    }
    if (typeof item === 'object') {
        if (item.name != null) {
            return String(item.name);
        }
        if (item.message != null) {
            return chatItemToString(item.message);
        }
        if (item.label != null) {
            return String(item.label);
        }
        return '';
    }
    return String(item);
}

export function getLog(game: Game): string[] {
    const messages: any[] = (game as any).messages ?? [];
    return messages.map((entry) => {
        const message = entry?.message?.alert ? entry.message.alert.message : entry?.message;
        return cleanTokenText(chatItemToString(message)).replace(/\s+/g, ' ')
            .trim();
    });
}
