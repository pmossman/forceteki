import type {
    IBaseEntry,
    ICapturedEntry,
    ICardEntry,
    IIssue,
    ILeaderEntry,
    IParseResult,
    IPlayerPosition,
    IPosition,
    IResourceEntry,
    IUnitEntry,
    IUpgradeEntry,
    Seat
} from '../SandboxTypes';

/**
 * Position text <-> position object. Purely syntactic: card names are kept as written, no card lookup happens here
 * (see PositionResolver). The grammar is documented in POSITION-FORMAT.md.
 */

export function emptyPlayerPosition(): IPlayerPosition {
    return { ground: [], space: [], resources: [], hand: [], deck: [], discard: [] };
}

export function emptyPosition(): IPosition {
    return { version: 1, phase: 'action', initiative: 'p1', p1: emptyPlayerPosition(), p2: emptyPlayerPosition() };
}

type ZoneKey = 'leader' | 'base' | 'ground' | 'space' | 'resources' | 'hand' | 'deck' | 'discard';

const zoneAliases: Record<string, ZoneKey> = {
    leader: 'leader',
    base: 'base',
    ground: 'ground',
    groundarena: 'ground',
    space: 'space',
    spacearena: 'space',
    resource: 'resources',
    resources: 'resources',
    hand: 'hand',
    deck: 'deck',
    discard: 'discard',
};

interface IModifiers {
    damage?: number;
    exhausted?: boolean;
    deployed?: boolean;
    epicActionUsed?: boolean;
    flipped?: boolean;
    owner?: Seat;
}

interface ICardSpec {
    count: number;
    name: string;
    mods: IModifiers;
}

export function parseSeat(raw: string): Seat | null {
    const key = raw.trim().toLowerCase()
        .replace(/\s+/g, '');
    if (key === 'p1' || key === 'player1' || key === '1') {
        return 'p1';
    }
    if (key === 'p2' || key === 'player2' || key === '2') {
        return 'p2';
    }
    return null;
}

function seatText(seat: Seat): string {
    return seat === 'p1' ? 'P1' : 'P2';
}

function parseModifiers(raw: string, line: number, path: string, errors: IIssue[]): IModifiers {
    const mods: IModifiers = {};
    for (const part of raw.split(',')) {
        const mod = part.trim().toLowerCase()
            .replace(/\s+/g, ' ');
        if (mod.length === 0) {
            continue;
        }
        let match: RegExpExecArray | null;
        if ((match = (/^(?:damage|dmg|damaged)\s*:?\s*(-?\d+)$/).exec(mod))) {
            mods.damage = Number(match[1]);
            if (mods.damage < 0) {
                errors.push({ path, line, message: `Damage can't be negative (${mod})` });
            }
        } else if (mod === 'exhausted' || mod === 'exhaust') {
            mods.exhausted = true;
        } else if (mod === 'ready') {
            mods.exhausted = false;
        } else if (mod === 'deployed') {
            mods.deployed = true;
        } else if (mod === 'epic action used' || mod === 'epic used' || mod === 'epicactionused') {
            mods.epicActionUsed = true;
        } else if (mod === 'flipped') {
            mods.flipped = true;
        } else if ((match = (/^owner\s*:?\s*(.+)$/).exec(mod))) {
            const seat = parseSeat(match[1]);
            if (seat) {
                mods.owner = seat;
            } else {
                errors.push({ path, line, message: `Unknown owner '${match[1]}' (use P1 or P2)` });
            }
        } else {
            errors.push({ path, line, message: `Unknown modifier '${part.trim()}'` });
        }
    }
    return mods;
}

function parseCardSpec(raw: string, line: number, path: string, errors: IIssue[]): ICardSpec | null {
    let text = raw.trim();
    let count = 1;
    const countMatch = (/^(\d+)\s*[x×]\s+(.*)$/i).exec(text);
    if (countMatch) {
        count = Number(countMatch[1]);
        text = countMatch[2];
        if (count < 1) {
            errors.push({ path, line, message: `Count must be at least 1 ('${raw.trim()}')` });
            return null;
        }
    }

    let mods: IModifiers = {};
    const modMatch = (/^(.*?)\s*\[([^\]]*)\]\s*$/).exec(text);
    if (modMatch) {
        text = modMatch[1];
        mods = parseModifiers(modMatch[2], line, path, errors);
    } else if (text.includes('[') || text.includes(']')) {
        errors.push({ path, line, message: `Unbalanced '[' or ']' in '${raw.trim()}'` });
        return null;
    }

    const name = text.trim();
    if (name.length === 0) {
        errors.push({ path, line, message: 'Missing card name' });
        return null;
    }
    return { count, name, mods };
}

function checkModsAllowed(spec: ICardSpec, allowed: (keyof IModifiers)[], what: string, line: number, path: string, errors: IIssue[]) {
    for (const key of Object.keys(spec.mods) as (keyof IModifiers)[]) {
        if (!allowed.includes(key)) {
            errors.push({ path, line, message: `Modifier '${key}' doesn't apply to ${what}` });
        }
    }
}

export function parsePositionText(text: string): IParseResult {
    const errors: IIssue[] = [];
    const warnings: IIssue[] = [];
    const position = emptyPosition();
    let sawActive = false;

    let currentSeat: Seat | null = null;
    // the entry that attachment lines (+ upgrade / captured:) attach to
    let attachTarget: { entry: IUnitEntry | ILeaderEntry | IBaseEntry; path: string } | null = null;
    let firstComment: string | null = null;
    let sawContent = false;

    const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const rawLine = lines[i];
        const trimmed = rawLine.trim();

        if (trimmed.length === 0) {
            continue;
        }
        if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
            if (!sawContent && firstComment == null) {
                firstComment = trimmed.replace(/^(#|\/\/)\s*/, '');
            }
            continue;
        }
        sawContent = true;

        const indented = (/^\s/).test(rawLine);

        // [P1] / [P2] headers (also "P1:" on its own)
        const header = (/^\[\s*([^\]]+)\s*\]$/).exec(trimmed) ?? (/^(p1|p2|player\s*1|player\s*2):$/i).exec(trimmed);
        if (header && !indented) {
            const seat = parseSeat(header[1]);
            if (!seat) {
                errors.push({ path: '', line: lineNo, message: `Unknown section '${trimmed}' (use [P1] or [P2])` });
            }
            currentSeat = seat;
            attachTarget = null;
            continue;
        }

        // attachment lines
        if (indented && (trimmed.startsWith('+') || (/^captured\s*:/i).test(trimmed))) {
            if (!attachTarget) {
                errors.push({ path: '', line: lineNo, message: 'Attachment line has no card above it to attach to' });
                continue;
            }
            if (trimmed.startsWith('+')) {
                const upgradesPath = `${attachTarget.path}.upgrades`;
                const spec = parseCardSpec(trimmed.slice(1), lineNo, upgradesPath, errors);
                if (!spec) {
                    continue;
                }
                checkModsAllowed(spec, ['owner'], 'upgrades', lineNo, upgradesPath, errors);
                attachTarget.entry.upgrades = attachTarget.entry.upgrades ?? [];
                for (let n = 0; n < spec.count; n++) {
                    const upgrade: IUpgradeEntry = { card: spec.name, line: lineNo };
                    if (spec.mods.owner) {
                        upgrade.owner = spec.mods.owner;
                    }
                    attachTarget.entry.upgrades.push(upgrade);
                }
            } else {
                const capturedPath = `${attachTarget.path}.captured`;
                const spec = parseCardSpec(trimmed.replace(/^captured\s*:/i, ''), lineNo, capturedPath, errors);
                if (!spec) {
                    continue;
                }
                checkModsAllowed(spec, ['owner'], 'captured cards', lineNo, capturedPath, errors);
                attachTarget.entry.captured = attachTarget.entry.captured ?? [];
                for (let n = 0; n < spec.count; n++) {
                    const captured: ICapturedEntry = { card: spec.name, line: lineNo };
                    if (spec.mods.owner) {
                        captured.owner = spec.mods.owner;
                    }
                    attachTarget.entry.captured.push(captured);
                }
            }
            continue;
        }

        const kv = (/^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/).exec(trimmed);
        if (!kv) {
            errors.push({ path: '', line: lineNo, message: `Can't read line '${trimmed}' (expected 'key: value')` });
            continue;
        }
        const key = kv[1].toLowerCase().replace(/\s+/g, '');
        const value = kv[2].trim();

        if (currentSeat == null) {
            // globals
            switch (key) {
                case 'version':
                case 'swuposition':
                    if (value !== '1') {
                        warnings.push({ path: 'version', line: lineNo, message: `Unknown format version '${value}', reading it as version 1` });
                    }
                    break;
                case 'title':
                    position.title = value;
                    break;
                case 'phase': {
                    const phase = value.toLowerCase();
                    if (phase === 'action' || phase === 'regroup') {
                        position.phase = phase;
                    } else {
                        errors.push({ path: 'phase', line: lineNo, message: `Unknown phase '${value}' (use action or regroup)` });
                    }
                    break;
                }
                case 'initiative': {
                    const seat = parseSeat(value);
                    if (seat) {
                        position.initiative = seat;
                    } else {
                        errors.push({ path: 'initiative', line: lineNo, message: `Unknown player '${value}' (use P1 or P2)` });
                    }
                    break;
                }
                case 'active':
                case 'activeplayer': {
                    const seat = parseSeat(value);
                    if (seat) {
                        position.active = seat;
                        sawActive = true;
                    } else {
                        errors.push({ path: 'active', line: lineNo, message: `Unknown player '${value}' (use P1 or P2)` });
                    }
                    break;
                }
                default:
                    if (zoneAliases[key] || key === 'credits' || key === 'force') {
                        errors.push({ path: '', line: lineNo, message: `'${kv[1]}' must be inside a [P1] or [P2] section` });
                    } else {
                        errors.push({ path: '', line: lineNo, message: `Unknown key '${kv[1]}'` });
                    }
            }
            continue;
        }

        const player = position[currentSeat];

        if (key === 'credits') {
            const credits = Number(value);
            if (!Number.isInteger(credits) || credits < 0) {
                errors.push({ path: `${currentSeat}.credits`, line: lineNo, message: `Credits must be a whole number (got '${value}')` });
            } else {
                player.credits = credits;
            }
            continue;
        }
        if (key === 'force' || key === 'forcetoken' || key === 'theforce') {
            const flag = value.toLowerCase();
            if (['yes', 'true', 'y', '1'].includes(flag)) {
                player.force = true;
            } else if (['no', 'false', 'n', '0'].includes(flag)) {
                player.force = false;
            } else {
                errors.push({ path: `${currentSeat}.force`, line: lineNo, message: `Use 'force: yes' or 'force: no' (got '${value}')` });
            }
            continue;
        }

        const zone = zoneAliases[key];
        if (!zone) {
            errors.push({ path: '', line: lineNo, message: `Unknown zone '${kv[1]}'` });
            continue;
        }
        if (value.length === 0) {
            // an empty zone line is allowed and means nothing
            attachTarget = null;
            continue;
        }

        attachTarget = null;
        if (zone === 'leader' || zone === 'base') {
            const path = `${currentSeat}.${zone}`;
            const spec = parseCardSpec(value, lineNo, path, errors);
            if (!spec) {
                continue;
            }
            if (spec.count !== 1) {
                errors.push({ path, line: lineNo, message: `A player has exactly one ${zone}` });
            }
            if (player[zone]) {
                errors.push({ path, line: lineNo, message: `${seatText(currentSeat)} already has a ${zone}` });
                continue;
            }
            if (zone === 'leader') {
                checkModsAllowed(spec, ['deployed', 'exhausted', 'damage', 'epicActionUsed', 'flipped'], 'a leader', lineNo, path, errors);
                const leader: ILeaderEntry = { card: spec.name, line: lineNo };
                Object.assign(leader, spec.mods);
                player.leader = leader;
                attachTarget = { entry: leader, path };
            } else {
                checkModsAllowed(spec, ['damage'], 'a base', lineNo, path, errors);
                const base: IBaseEntry = { card: spec.name, line: lineNo };
                if (spec.mods.damage != null) {
                    base.damage = spec.mods.damage;
                }
                player.base = base;
                attachTarget = { entry: base, path };
            }
            continue;
        }

        const list = player[zone];
        const spec = parseCardSpec(value, lineNo, `${currentSeat}.${zone}[${list.length}]`, errors);
        if (!spec) {
            continue;
        }
        const path = `${currentSeat}.${zone}[${list.length}]`;
        if (zone === 'ground' || zone === 'space') {
            checkModsAllowed(spec, ['damage', 'exhausted', 'owner'], 'units', lineNo, path, errors);
            for (let n = 0; n < spec.count; n++) {
                const unit: IUnitEntry = { card: spec.name, line: lineNo };
                Object.assign(unit, spec.mods);
                (list as IUnitEntry[]).push(unit);
                // attachments after an "Nx" line attach to the last copy
                attachTarget = { entry: unit, path: `${currentSeat}.${zone}[${list.length - 1}]` };
            }
        } else if (zone === 'resources') {
            checkModsAllowed(spec, ['exhausted'], 'resources', lineNo, path, errors);
            for (let n = 0; n < spec.count; n++) {
                const resource: IResourceEntry = { card: spec.name, line: lineNo };
                if (spec.mods.exhausted) {
                    resource.exhausted = true;
                }
                (list as IResourceEntry[]).push(resource);
            }
        } else {
            checkModsAllowed(spec, [], `cards in ${zone}`, lineNo, path, errors);
            for (let n = 0; n < spec.count; n++) {
                (list as ICardEntry[]).push({ card: spec.name, line: lineNo });
            }
        }
    }

    if (position.title == null && firstComment) {
        position.title = firstComment;
    }
    if (sawActive && position.active === position.initiative) {
        delete position.active;
    }

    return { position, errors, warnings };
}

// ---------------------------------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------------------------------

function formatMods(mods: string[]): string {
    return mods.length > 0 ? ` [${mods.join(', ')}]` : '';
}

function unitMods(entry: IUnitEntry, controller: Seat): string[] {
    const mods: string[] = [];
    if (entry.damage) {
        mods.push(`damage ${entry.damage}`);
    }
    if (entry.exhausted) {
        mods.push('exhausted');
    }
    if (entry.owner && entry.owner !== controller) {
        mods.push(`owner ${seatText(entry.owner)}`);
    }
    return mods;
}

function attachmentLines(entry: { upgrades?: IUpgradeEntry[]; captured?: ICapturedEntry[] }, controller: Seat): string[] {
    const lines: string[] = [];
    for (const group of groupConsecutive(entry.upgrades ?? [], (u) => `${u.card}|${u.owner && u.owner !== controller ? u.owner : ''}`)) {
        const upgrade = group[0];
        const mods = upgrade.owner && upgrade.owner !== controller ? [`owner ${seatText(upgrade.owner)}`] : [];
        lines.push(`  + ${countPrefix(group.length)}${upgrade.card}${formatMods(mods)}`);
    }
    for (const group of groupConsecutive(entry.captured ?? [], (c) => `${c.card}|${c.owner ?? ''}`)) {
        const captured = group[0];
        const mods = captured.owner && captured.owner === controller ? [`owner ${seatText(captured.owner)}`] : [];
        lines.push(`  captured: ${countPrefix(group.length)}${captured.card}${formatMods(mods)}`);
    }
    return lines;
}

function countPrefix(count: number): string {
    return count > 1 ? `${count}x ` : '';
}

function groupConsecutive<T>(items: T[], keyOf: (item: T) => string): T[][] {
    const groups: T[][] = [];
    let lastKey: string | null = null;
    for (const item of items) {
        const key = keyOf(item);
        if (groups.length > 0 && key === lastKey) {
            groups[groups.length - 1].push(item);
        } else {
            groups.push([item]);
            lastKey = key;
        }
    }
    return groups;
}

function formatPlayer(seat: Seat, player: IPlayerPosition): string[] {
    const lines: string[] = [`[${seatText(seat)}]`];

    if (player.leader) {
        const leader = player.leader;
        const mods: string[] = [];
        if (leader.deployed) {
            mods.push('deployed');
        }
        if (leader.damage) {
            mods.push(`damage ${leader.damage}`);
        }
        if (leader.exhausted) {
            mods.push('exhausted');
        }
        if (leader.epicActionUsed && !leader.deployed) {
            mods.push('epic action used');
        }
        if (leader.flipped) {
            mods.push('flipped');
        }
        lines.push(`leader: ${leader.card}${formatMods(mods)}`);
        lines.push(...attachmentLines(leader, seat));
    }
    if (player.base) {
        const base = player.base;
        lines.push(`base: ${base.card}${formatMods(base.damage ? [`damage ${base.damage}`] : [])}`);
        lines.push(...attachmentLines(base, seat));
    }

    for (const zone of ['ground', 'space'] as const) {
        // units with attachments are never grouped
        let uniqueKey = 0;
        const groups = groupConsecutive(player[zone], (unit) =>
            (((unit.upgrades?.length ?? 0) > 0 || (unit.captured?.length ?? 0) > 0)
                ? `#unique${uniqueKey++}`
                : `${unit.card}|${unitMods(unit, seat).join(',')}`)
        );
        for (const group of groups) {
            const unit = group[0];
            lines.push(`${zone}: ${countPrefix(group.length)}${unit.card}${formatMods(unitMods(unit, seat))}`);
            lines.push(...attachmentLines(unit, seat));
        }
    }

    for (const group of groupConsecutive(player.resources, (r) => `${r.card}|${r.exhausted ? 'x' : ''}`)) {
        lines.push(`resource: ${countPrefix(group.length)}${group[0].card}${formatMods(group[0].exhausted ? ['exhausted'] : [])}`);
    }
    for (const zone of ['hand', 'deck', 'discard'] as const) {
        for (const group of groupConsecutive(player[zone], (c) => c.card)) {
            lines.push(`${zone}: ${countPrefix(group.length)}${group[0].card}`);
        }
    }
    if (player.credits) {
        lines.push(`credits: ${player.credits}`);
    }
    if (player.force) {
        lines.push('force: yes');
    }
    return lines;
}

export function formatPositionText(position: IPosition): string {
    const lines: string[] = [];
    if (position.title) {
        lines.push(`# ${position.title}`);
    }
    lines.push(`phase: ${position.phase ?? 'action'}`);
    lines.push(`initiative: ${seatText(position.initiative ?? 'p1')}`);
    if (position.active && position.active !== (position.initiative ?? 'p1')) {
        lines.push(`active: ${seatText(position.active)}`);
    }
    lines.push('');
    lines.push(...formatPlayer('p1', position.p1 ?? emptyPlayerPosition()));
    lines.push('');
    lines.push(...formatPlayer('p2', position.p2 ?? emptyPlayerPosition()));
    return lines.join('\n') + '\n';
}

/** Deep copy without parser line numbers. */
export function stripLines<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, (key, val) => (key === 'line' ? undefined : val)));
}
