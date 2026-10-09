import type { Game } from '../../game/core/Game';
import { ActionWindow } from '../../game/core/gameSteps/ActionWindow';
import type { SandboxCardIndex } from '../cards/SandboxCardIndex';
import type {
    ICapturedEntry,
    IIssue,
    ILeaderEntry,
    IPlayerPosition,
    IPosition,
    IUnitEntry,
    IUpgradeEntry,
    Seat
} from '../SandboxTypes';
import { emptyPlayerPosition } from './PositionText';

/**
 * Live game -> position object (god's-eye view: both hands and the whole deck, in order). Unlike the bug-report
 * `captureGameState`, this keeps the full deck, upgrade/unit owners, captured-card owners and the Epic Action state.
 */

function seatOf(player: any): Seat | undefined {
    const id = player?.id;
    return id === 'p1' || id === 'p2' ? id : undefined;
}

function deployAbilityUsed(leader: any, player: any): boolean {
    try {
        const deployAbility = leader.getActionAbilities?.().find((ability: any) => String(ability.getTitle()).includes('Deploy'));
        return !!deployAbility?.limit?.isAtMax(player);
    } catch {
        return false;
    }
}

function exportUpgrades(index: SandboxCardIndex, card: any, controllerSeat: Seat, warnings: IIssue[], path: string): IUpgradeEntry[] | undefined {
    const upgrades: any[] = card.upgrades ?? [];
    if (upgrades.length === 0) {
        return undefined;
    }
    return upgrades.map((upgrade, i) => {
        if (upgrade.isLeader?.()) {
            warnings.push({ path: `${path}.upgrades[${i}]`, message: `${upgrade.title} is a leader attached as a pilot: the position format can't express that yet, so it is exported as a plain upgrade` });
        }
        const entry: IUpgradeEntry = { card: index.nameFor(upgrade.internalName) };
        const owner = seatOf(upgrade.owner);
        if (owner && owner !== controllerSeat) {
            entry.owner = owner;
        }
        return entry;
    });
}

function exportCaptured(index: SandboxCardIndex, card: any, captorSeat: Seat): ICapturedEntry[] | undefined {
    const captured: any[] = card.capturedUnits ?? [];
    if (captured.length === 0) {
        return undefined;
    }
    return captured.map((unit) => {
        const entry: ICapturedEntry = { card: index.nameFor(unit.internalName) };
        const owner = seatOf(unit.owner);
        if (owner && owner === captorSeat) {
            entry.owner = owner;
        }
        return entry;
    });
}

function exportUnit(index: SandboxCardIndex, card: any, seat: Seat, warnings: IIssue[], path: string): IUnitEntry {
    const unit: IUnitEntry = { card: index.nameFor(card.internalName) };
    if (card.damage) {
        unit.damage = card.damage;
    }
    if (card.exhausted) {
        unit.exhausted = true;
    }
    const owner = seatOf(card.owner);
    if (owner && owner !== seat) {
        unit.owner = owner;
    }
    const upgrades = exportUpgrades(index, card, seat, warnings, path);
    if (upgrades) {
        unit.upgrades = upgrades;
    }
    const captured = exportCaptured(index, card, seat);
    if (captured) {
        unit.captured = captured;
    }
    return unit;
}

function exportPlayer(index: SandboxCardIndex, game: Game, seat: Seat, warnings: IIssue[]): IPlayerPosition {
    const player: any = game.getPlayerById(seat);
    const position = emptyPlayerPosition();

    const leaders: any[] = player.getAllDeckLeaders();
    const leaderCard = leaders[0];
    if (leaders.length > 1) {
        warnings.push({ path: `${seat}.leader`, message: 'Second leaders (Twin Suns formats) are not in the position format yet and were left out' });
    }
    if (leaderCard) {
        const leader: ILeaderEntry = { card: index.nameFor(leaderCard.internalName) };
        if (leaderCard.deployed) {
            leader.deployed = true;
            if (leaderCard.damage) {
                leader.damage = leaderCard.damage;
            }
            const upgrades = exportUpgrades(index, leaderCard, seat, warnings, `${seat}.leader`);
            if (upgrades) {
                leader.upgrades = upgrades;
            }
            const captured = exportCaptured(index, leaderCard, seat);
            if (captured) {
                leader.captured = captured;
            }
        } else if (deployAbilityUsed(leaderCard, player)) {
            leader.epicActionUsed = true;
        }
        if (leaderCard.exhausted) {
            leader.exhausted = true;
        }
        position.leader = leader;
    }

    const baseCard = player.base;
    if (baseCard) {
        position.base = { card: index.nameFor(baseCard.internalName) };
        if (baseCard.damage) {
            position.base.damage = baseCard.damage;
        }
        const upgrades = exportUpgrades(index, baseCard, seat, warnings, `${seat}.base`);
        if (upgrades) {
            position.base.upgrades = upgrades;
        }
        const captured = exportCaptured(index, baseCard, seat);
        if (captured) {
            position.base.captured = captured;
        }
    }

    const arenaUnits = (zone: any) => (zone.getCards({ controller: player }) as any[])
        .filter((card) => !card.isLeaderUnit?.() && !card.isAttached?.());
    position.ground = arenaUnits(game.groundArena).map((card, i) => exportUnit(index, card, seat, warnings, `${seat}.ground[${i}]`));
    position.space = arenaUnits(game.spaceArena).map((card, i) => exportUnit(index, card, seat, warnings, `${seat}.space[${i}]`));

    // the setup DSL places resources in reverse list order, so export them reversed to round-trip
    position.resources = ([...(player.resources ?? [])] as any[]).reverse().map((card) => (card.exhausted
        ? { card: index.nameFor(card.internalName), exhausted: true }
        : { card: index.nameFor(card.internalName) }));
    position.hand = (player.hand as any[]).map((card) => ({ card: index.nameFor(card.internalName) }));
    position.deck = ([...(player.drawDeck ?? [])] as any[]).map((card) => ({ card: index.nameFor(card.internalName) }));
    // the discard zone stores its top card last; the position format lists the top card first
    position.discard = ([...(player.discard ?? [])] as any[]).reverse().map((card) => ({ card: index.nameFor(card.internalName) }));

    if (player.creditTokenCount > 0) {
        position.credits = player.creditTokenCount;
    }
    if (player.hasTheForce) {
        position.force = true;
    }
    return position;
}

export function exportPosition(index: SandboxCardIndex, game: Game, title?: string): { position: IPosition; warnings: IIssue[] } {
    const warnings: IIssue[] = [];
    const phase = game.currentPhase;
    if (phase !== 'action' && phase !== 'regroup') {
        warnings.push({ path: 'phase', message: `The game is in the ${phase} phase, which positions can't express; exported as the action phase` });
    }

    const initiative = seatOf(game.initiativePlayer) ?? 'p1';
    const position: IPosition = {
        version: 1,
        phase: phase === 'regroup' ? 'regroup' : 'action',
        initiative,
        p1: exportPlayer(index, game, 'p1', warnings),
        p2: exportPlayer(index, game, 'p2', warnings),
    };
    if (title) {
        position.title = title;
    }
    const active = seatOf(game.actionPhaseActivePlayer);
    if (position.phase === 'action' && active && active !== initiative) {
        position.active = active;
    }

    const openPrompt: any = game.getCurrentOpenPrompt();
    const atActionWindow = openPrompt instanceof ActionWindow;
    if (!atActionWindow) {
        warnings.push({
            path: '',
            message: 'A prompt or triggered ability is pending: the export holds the board only, so the pending decision and stack are lost'
        });
    }
    return { position, warnings };
}
