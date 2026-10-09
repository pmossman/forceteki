import type { ICardIndexEntry, SandboxCardIndex } from '../cards/SandboxCardIndex';
import type {
    IBaseEntry,
    ICapturedEntry,
    ICardEntry,
    IIssue,
    ILeaderEntry,
    IPlayerPosition,
    IPosition,
    IPostSetupAdjustments,
    IResolvedPosition,
    ISetupDsl,
    IUnitEntry,
    IUpgradeEntry,
    IValidateResult,
    Seat
} from '../SandboxTypes';
import { seatLabel } from '../SandboxTypes';
import { emptyPlayerPosition, formatPositionText, parsePositionText, stripLines } from './PositionText';

/**
 * Position object -> validated, canonical position + engine setup DSL. Pure apart from the card index.
 */

const defaultLeaders: Record<Seat, string> = { p1: 'darth-vader#dark-lord-of-the-sith', p2: 'luke-skywalker#faithful-friend' };
const defaultBases: Record<Seat, string> = { p1: 'kestro-city', p2: 'administrators-tower' };

/** The DSL keys each player by name; the sandbox names its players P1 and P2. */
export const sandboxPlayerNames: Record<Seat, string> = { p1: 'P1', p2: 'P2' };

interface IContext {
    index: SandboxCardIndex;
    errors: IIssue[];
    warnings: IIssue[];
}

function issue(list: IIssue[], path: string, message: string, entry?: ICardEntry) {
    const item: IIssue = { path, message };
    if (entry?.line != null) {
        item.line = entry.line;
    }
    list.push(item);
}

function resolveCard(ctx: IContext, entry: ICardEntry, path: string): ICardIndexEntry | null {
    const result = ctx.index.lookup(entry.card);
    if (result.ok === false) {
        const suggestion = result.candidates.length > 0 ? ` Did you mean: ${result.candidates.join(' / ')}?` : '';
        issue(ctx.errors, `${path}.card`, `${result.message}.${suggestion}`, entry);
        return null;
    }
    entry.card = result.entry.name;
    return result.entry;
}

function isUnitCard(card: ICardIndexEntry) {
    return card.types.includes('unit') && !card.isLeader;
}

function isUpgradeLike(card: ICardIndexEntry) {
    return card.types.includes('upgrade') || (card.types.includes('unit') && !!card.pilotText);
}

function isZoneCard(card: ICardIndexEntry) {
    return !card.isToken && !card.isLeader && !card.types.includes('base');
}

function totalHp(card: ICardIndexEntry, upgrades: ICardIndexEntry[]): number | undefined {
    if (card.hp == null) {
        return undefined;
    }
    return card.hp + upgrades.reduce((sum, upgrade) => sum + (upgrade.upgradeHp ?? 0), 0);
}

function checkDamage(ctx: IContext, card: ICardIndexEntry, upgrades: ICardIndexEntry[], damage: number | undefined, path: string, entry: ICardEntry) {
    if (damage == null || damage === 0) {
        return;
    }
    if (!Number.isInteger(damage) || damage < 0) {
        issue(ctx.errors, `${path}.damage`, `Damage must be a whole number, 0 or more (got ${damage})`, entry);
        return;
    }
    const hp = totalHp(card, upgrades);
    if (hp != null && damage >= hp) {
        issue(ctx.errors, `${path}.damage`, `${card.name} has ${hp} HP, so ${damage} damage would defeat it at once (CR 1.9.6)`, entry);
    }
}

function resolveUpgrades(ctx: IContext, holder: ICardIndexEntry | null, upgrades: IUpgradeEntry[] | undefined, path: string, holderIsBase: boolean) {
    const resolved: ICardIndexEntry[] = [];
    (upgrades ?? []).forEach((upgrade, i) => {
        const upgradePath = `${path}.upgrades[${i}]`;
        const card = resolveCard(ctx, upgrade, upgradePath);
        if (!card) {
            return;
        }
        if (!isUpgradeLike(card)) {
            issue(ctx.errors, `${upgradePath}.card`, `${card.name} is not an upgrade (or a pilot)`, upgrade);
            return;
        }
        const fortify = card.keywords.includes('fortify');
        if (holderIsBase && !fortify) {
            issue(ctx.errors, `${upgradePath}.card`, `Only Fortify upgrades can be attached to a base, and ${card.name} doesn't have Fortify`, upgrade);
        } else if (!holderIsBase && fortify) {
            issue(ctx.errors, `${upgradePath}.card`, `${card.name} has Fortify, so it can only be attached to a base`, upgrade);
        }
        resolved.push(card);
    });
    return resolved;
}

function resolveCaptured(ctx: IContext, captured: ICapturedEntry[] | undefined, path: string) {
    (captured ?? []).forEach((entry, i) => {
        const capturedPath = `${path}.captured[${i}]`;
        const card = resolveCard(ctx, entry, capturedPath);
        if (card && (!isUnitCard(card) || card.isToken)) {
            issue(ctx.errors, `${capturedPath}.card`, `Only non-token units can be captured (${card.name})`, entry);
        }
    });
}

interface IResolvedUnit {
    entry: IUnitEntry;
    card: ICardIndexEntry;
    upgrades: ICardIndexEntry[];
}

function resolvePlayer(ctx: IContext, seat: Seat, player: IPlayerPosition) {
    const units: IResolvedUnit[] = [];
    const uniques = new Map<string, number>();
    const countUnique = (card: ICardIndexEntry | null, controller: Seat) => {
        if (card?.unique && controller === seat) {
            uniques.set(card.internalName, (uniques.get(card.internalName) ?? 0) + 1);
        }
    };

    // leader
    let leaderCard: ICardIndexEntry | null = null;
    if (!player.leader) {
        const fallback = ctx.index.getByInternalName(defaultLeaders[seat]);
        player.leader = { card: fallback?.name ?? defaultLeaders[seat] };
        issue(ctx.warnings, `${seat}.leader`, `${seatLabel(seat)} has no leader: using ${player.leader.card}`);
    }
    leaderCard = resolveCard(ctx, player.leader, `${seat}.leader`);
    if (leaderCard && !leaderCard.isLeader) {
        issue(ctx.errors, `${seat}.leader.card`, `${leaderCard.name} is not a leader`, player.leader);
    }
    const leaderUpgrades = resolveUpgrades(ctx, leaderCard, player.leader.upgrades, `${seat}.leader`, false);
    resolveCaptured(ctx, player.leader.captured, `${seat}.leader`);
    if (!player.leader.deployed) {
        if (player.leader.damage) {
            issue(ctx.errors, `${seat}.leader.damage`, 'A leader can only have damage while deployed', player.leader);
        }
        if ((player.leader.upgrades?.length ?? 0) > 0) {
            issue(ctx.errors, `${seat}.leader.upgrades`, 'A leader can only have upgrades while deployed', player.leader);
        }
        if ((player.leader.captured?.length ?? 0) > 0) {
            issue(ctx.errors, `${seat}.leader.captured`, 'A leader can only capture cards while deployed', player.leader);
        }
    } else if (leaderCard) {
        checkDamage(ctx, leaderCard, leaderUpgrades, player.leader.damage, `${seat}.leader`, player.leader);
    }

    // base
    if (!player.base) {
        const fallback = ctx.index.getByInternalName(defaultBases[seat]);
        player.base = { card: fallback?.name ?? defaultBases[seat] };
        issue(ctx.warnings, `${seat}.base`, `${seatLabel(seat)} has no base: using ${player.base.card}`);
    }
    const baseCard = resolveCard(ctx, player.base, `${seat}.base`);
    if (baseCard && !baseCard.types.includes('base')) {
        issue(ctx.errors, `${seat}.base.card`, `${baseCard.name} is not a base`, player.base);
    }
    const baseUpgrades = resolveUpgrades(ctx, baseCard, player.base.upgrades, `${seat}.base`, true);
    resolveCaptured(ctx, player.base.captured, `${seat}.base`);
    if (baseCard) {
        checkDamage(ctx, baseCard, baseUpgrades, player.base.damage, `${seat}.base`, player.base);
    }

    // arenas
    for (const zone of ['ground', 'space'] as const) {
        player[zone].forEach((unit, i) => {
            const path = `${seat}.${zone}[${i}]`;
            const card = resolveCard(ctx, unit, path);
            const upgrades = resolveUpgrades(ctx, card, unit.upgrades, path, false);
            resolveCaptured(ctx, unit.captured, path);
            if (!card) {
                return;
            }
            if (card.isLeader) {
                issue(ctx.errors, `${path}.card`, `${card.name} is a leader: put it on the 'leader:' line with [deployed]`, unit);
                return;
            }
            if (!isUnitCard(card)) {
                issue(ctx.errors, `${path}.card`, `${card.name} is not a unit, so it can't be in an arena`, unit);
                return;
            }
            if (card.arena && card.arena !== zone) {
                issue(ctx.errors, `${path}.card`, `${card.name} is a ${card.arena} unit, not a ${zone} unit`, unit);
            }
            if (unit.owner && card.isToken && unit.owner !== seat) {
                // stolen tokens are fine in principle, but the DSL can't express them
                issue(ctx.errors, `${path}.owner`, 'Stolen token units are not supported', unit);
            }
            checkDamage(ctx, card, upgrades, unit.damage, path, unit);
            units.push({ entry: unit, card, upgrades });
            countUnique(card, seat);
        });
    }

    // hidden zones
    for (const zone of ['resources', 'hand', 'deck', 'discard'] as const) {
        (player[zone] as ICardEntry[]).forEach((entry, i) => {
            const path = `${seat}.${zone}[${i}]`;
            const card = resolveCard(ctx, entry, path);
            if (card && !isZoneCard(card)) {
                const what = card.isToken ? 'a token' : card.isLeader ? 'a leader' : 'a base';
                issue(ctx.errors, `${path}.card`, `${card.name} is ${what}, so it can't be in ${zone === 'resources' ? 'the resource zone' : `the ${zone}`}`, entry);
            }
        });
    }

    if (player.credits != null && (!Number.isInteger(player.credits) || player.credits < 0)) {
        issue(ctx.errors, `${seat}.credits`, `Credits must be a whole number (got ${player.credits})`);
    }

    if (player.deck.length === 0) {
        issue(ctx.warnings, `${seat}.deck`, `${seatLabel(seat)}'s deck is empty: drawing will deal damage to their base`);
    }

    for (const [internalName, count] of uniques) {
        if (count > 1) {
            issue(ctx.errors, `${seat}`, `${seatLabel(seat)} controls ${count} copies of the unique ${ctx.index.nameFor(internalName)} (CR 8.30)`);
        }
    }

    return { leaderCard, baseCard, units };
}

function upgradeToDsl(index: SandboxCardIndex, upgrade: IUpgradeEntry, controller: Seat) {
    const internalName = internalNameOf(index, upgrade.card);
    if (upgrade.owner && upgrade.owner !== controller) {
        return { card: internalName, ownerAndController: sandboxPlayerNames[upgrade.owner] };
    }
    return internalName;
}

function capturedToDsl(index: SandboxCardIndex, captured: ICapturedEntry, captorController: Seat) {
    const internalName = internalNameOf(index, captured.card);
    // default owner of a captured card is the captor's opponent
    if (captured.owner && captured.owner === captorController) {
        return { card: internalName, owner: sandboxPlayerNames[captured.owner] };
    }
    return internalName;
}

function internalNameOf(index: SandboxCardIndex, name: string): string {
    const result = index.lookup(name);
    return result.ok === true ? result.entry.internalName : name;
}

function playerToDsl(index: SandboxCardIndex, seat: Seat, player: IPlayerPosition, hasInitiative: boolean) {
    const dsl: Record<string, any> = {};
    if (hasInitiative) {
        dsl.hasInitiative = true;
    }

    const leader: ILeaderEntry = player.leader;
    const leaderDsl: Record<string, any> = { card: internalNameOf(index, leader.card) };
    if (leader.deployed) {
        leaderDsl.deployed = true;
        if (leader.damage) {
            leaderDsl.damage = leader.damage;
        }
        if (leader.upgrades?.length) {
            leaderDsl.upgrades = leader.upgrades.map((upgrade) => upgradeToDsl(index, upgrade, seat));
        }
        if (leader.captured?.length) {
            leaderDsl.capturedUnits = leader.captured.map((captured) => capturedToDsl(index, captured, seat));
        }
    }
    if (leader.exhausted) {
        leaderDsl.exhausted = true;
    }
    if (leader.flipped) {
        leaderDsl.flipped = true;
    }
    dsl.leader = leaderDsl;

    const base: IBaseEntry = player.base;
    const baseDsl: Record<string, any> = { card: internalNameOf(index, base.card), damage: base.damage ?? 0 };
    if (base.upgrades?.length) {
        baseDsl.upgrades = base.upgrades.map((upgrade) => upgradeToDsl(index, upgrade, seat));
    }
    if (base.captured?.length) {
        baseDsl.capturedUnits = base.captured.map((captured) => capturedToDsl(index, captured, seat));
    }
    dsl.base = baseDsl;

    const unitToDsl = (unit: IUnitEntry) => {
        const unitDsl: Record<string, any> = { card: internalNameOf(index, unit.card) };
        if (unit.damage) {
            unitDsl.damage = unit.damage;
        }
        if (unit.exhausted) {
            unitDsl.exhausted = true;
        }
        if (unit.owner && unit.owner !== seat) {
            unitDsl.owner = sandboxPlayerNames[unit.owner];
        }
        if (unit.upgrades?.length) {
            unitDsl.upgrades = unit.upgrades.map((upgrade) => upgradeToDsl(index, upgrade, seat));
        }
        if (unit.captured?.length) {
            unitDsl.capturedUnits = unit.captured.map((captured) => capturedToDsl(index, captured, seat));
        }
        return unitDsl;
    };
    dsl.groundArena = player.ground.map(unitToDsl);
    dsl.spaceArena = player.space.map(unitToDsl);
    dsl.resources = player.resources.map((resource) => ({ card: internalNameOf(index, resource.card), exhausted: !!resource.exhausted }));
    dsl.hand = player.hand.map((entry) => internalNameOf(index, entry.card));
    dsl.deck = player.deck.map((entry) => internalNameOf(index, entry.card));
    dsl.discard = player.discard.map((entry) => internalNameOf(index, entry.card));
    if (player.credits) {
        dsl.credits = player.credits;
    }
    if (player.force) {
        dsl.hasForceToken = true;
    }
    return dsl;
}

function normalizePosition(input: IPosition): IPosition {
    const position: IPosition = stripLines(input);
    position.version = 1;
    position.phase = position.phase === 'regroup' ? 'regroup' : 'action';
    position.initiative = position.initiative === 'p2' ? 'p2' : 'p1';
    for (const seat of ['p1', 'p2'] as const) {
        position[seat] = { ...emptyPlayerPosition(), ...(position[seat] ?? {}) };
    }
    return position;
}

export interface IResolveResult extends IValidateResult {
    resolved?: IResolvedPosition;
}

/** Validates a position and converts it to the engine setup DSL. `input` may be position text or an object. */
export function resolvePosition(index: SandboxCardIndex, input: { text?: string; position?: IPosition }): IResolveResult {
    let position: IPosition;
    const ctx: IContext = { index, errors: [], warnings: [] };

    if (typeof input.text === 'string') {
        const parsed = parsePositionText(input.text);
        ctx.errors.push(...parsed.errors);
        ctx.warnings.push(...parsed.warnings);
        position = parsed.position;
        if (!position) {
            return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
        }
    } else if (input.position && typeof input.position === 'object') {
        position = normalizePosition(input.position);
    } else {
        return { ok: false, errors: [{ path: '', message: 'Provide position text or a position object' }], warnings: [] };
    }

    if (position.phase !== 'action' && position.phase !== 'regroup') {
        issue(ctx.errors, 'phase', `Unknown phase '${position.phase}'`);
    }
    if (position.active && position.phase !== 'action') {
        issue(ctx.errors, 'active', 'An active player can only be set in the action phase');
    }

    resolvePlayer(ctx, 'p1', position.p1);
    resolvePlayer(ctx, 'p2', position.p2);

    const canonical = stripLines(position);
    if (canonical.active === canonical.initiative) {
        delete canonical.active;
    }
    const canonicalText = formatPositionText(canonical);

    if (ctx.errors.length > 0) {
        return { ok: false, position: canonical, canonicalText, errors: ctx.errors, warnings: ctx.warnings };
    }

    const setup: ISetupDsl = {
        phase: canonical.phase,
        autoSingleTarget: false,
        player1: playerToDsl(index, 'p1', canonical.p1, canonical.initiative === 'p1'),
        player2: playerToDsl(index, 'p2', canonical.p2, canonical.initiative === 'p2'),
    };
    const adjustments: IPostSetupAdjustments = {};
    if (canonical.active && canonical.active !== canonical.initiative) {
        adjustments.activePlayer = canonical.active;
    }
    const epicUsed = (['p1', 'p2'] as const).filter((seat) => canonical[seat].leader?.epicActionUsed && !canonical[seat].leader?.deployed);
    if (epicUsed.length > 0) {
        adjustments.epicActionUsed = epicUsed;
    }

    return {
        ok: true,
        position: canonical,
        canonicalText,
        errors: [],
        warnings: ctx.warnings,
        resolved: { position: canonical, setup, adjustments, canonicalText }
    };
}
