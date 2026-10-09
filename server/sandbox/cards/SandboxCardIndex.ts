import type { ICardDataJson } from '../../utils/cardData/CardDataInterfaces';

/** One card in the editor's card index. See CONTRACT.md §4. */
export interface ICardIndexEntry {
    internalName: string;
    name: string;
    title: string;
    subtitle?: string;
    needsSetCode: boolean;
    setId: { set: string; number?: number };
    setCode?: string;
    id: string;
    types: string[];
    arena?: 'ground' | 'space';
    cost?: number;
    power?: number;
    hp?: number;
    upgradePower?: number;
    upgradeHp?: number;
    aspects: string[];
    traits: string[];
    keywords: string[];
    unique: boolean;
    text?: string;
    deployBox?: string;
    epicAction?: string;
    pilotText?: string;
    isToken: boolean;
    isLeader: boolean;
}

export interface ICardIndexJson {
    format: 'karabast-sandbox-cards';
    version: 1;
    count: number;
    cards: ICardIndexEntry[];
}

export type CardLookupResult =
  | { ok: true; entry: ICardIndexEntry }
  | { ok: false; message: string; candidates: string[] };

/** Lower-cases, strips accents and everything that isn't a letter or digit. */
export function nameKey(name: string): string {
    return name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function fullName(title: string, subtitle?: string): string {
    return subtitle ? `${title}, ${subtitle}` : title;
}

function setCodeString(set: string, number?: number): string | undefined {
    if (number == null) {
        return undefined;
    }
    return `${set.toUpperCase()}_${String(number).padStart(3, '0')}`;
}

function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

/**
 * Names-first card lookup for the position format. Pure: built from plain card JSON, no engine or file access.
 */
export class SandboxCardIndex {
    public readonly entries: ICardIndexEntry[];

    private readonly byInternalName = new Map<string, ICardIndexEntry>();
    private readonly byFullKey = new Map<string, ICardIndexEntry[]>();
    private readonly byTitleKey = new Map<string, ICardIndexEntry[]>();
    private readonly bySetCode = new Map<string, ICardIndexEntry>();

    public static fromCardData(cards: Iterable<ICardDataJson>): SandboxCardIndex {
        return new SandboxCardIndex(Array.from(cards));
    }

    public static fromIndexJson(json: ICardIndexJson): SandboxCardIndex {
        return new SandboxCardIndex(null, json.cards);
    }

    private constructor(cards: ICardDataJson[] | null, prebuilt?: ICardIndexEntry[]) {
        const raw = prebuilt ?? cards.map((card) => SandboxCardIndex.toEntry(card));
        const setCodesByInternalName = new Map<string, string[]>();
        if (cards) {
            for (const card of cards) {
                setCodesByInternalName.set(
                    card.internalName,
                    (card.setCodes ?? [card.setId]).map((code) => setCodeString(code.set, code.number)).filter((code) => !!code)
                );
            }
        }

        // collision analysis first, then canonical names
        for (const entry of raw) {
            this.byInternalName.set(entry.internalName, entry);
            this.push(this.byFullKey, nameKey(fullName(entry.title, entry.subtitle)), entry);
            this.push(this.byTitleKey, nameKey(entry.title), entry);
            for (const code of setCodesByInternalName.get(entry.internalName) ?? [entry.setCode].filter((c) => !!c)) {
                if (!this.bySetCode.has(code)) {
                    this.bySetCode.set(code, entry);
                }
            }
        }

        for (const entry of raw) {
            const full = fullName(entry.title, entry.subtitle);
            const titleShared = (this.byTitleKey.get(nameKey(entry.title)) ?? []).length > 1;
            const fullShared = (this.byFullKey.get(nameKey(full)) ?? []).length > 1;
            entry.needsSetCode = fullShared;
            if (fullShared) {
                entry.name = `${full} (${entry.setId.set} ${String(entry.setId.number ?? '').padStart(3, '0')})`;
            } else if (titleShared || !entry.subtitle) {
                entry.name = full;
            } else {
                entry.name = entry.title;
            }
        }

        this.entries = raw.sort((a, b) => a.name.localeCompare(b.name));
    }

    private push(map: Map<string, ICardIndexEntry[]>, key: string, entry: ICardIndexEntry) {
        const list = map.get(key);
        if (list) {
            list.push(entry);
        } else {
            map.set(key, [entry]);
        }
    }

    private static toEntry(card: ICardDataJson): ICardIndexEntry {
        const types = card.types ?? [];
        const arena = card.arena === 'ground' || card.arena === 'space' ? card.arena : undefined;
        return {
            internalName: card.internalName,
            name: fullName(card.title, card.subtitle), // replaced after collision analysis
            title: card.title,
            subtitle: card.subtitle || undefined,
            needsSetCode: false,
            setId: { set: card.setId?.set, number: numberOrUndefined(card.setId?.number) },
            setCode: setCodeString(card.setId?.set ?? '', numberOrUndefined(card.setId?.number)),
            id: card.id,
            types,
            arena,
            cost: numberOrUndefined(card.cost),
            power: numberOrUndefined(card.power),
            hp: numberOrUndefined(card.hp),
            upgradePower: numberOrUndefined(card.upgradePower),
            upgradeHp: numberOrUndefined(card.upgradeHp),
            aspects: card.aspects ?? [],
            traits: card.traits ?? [],
            keywords: card.keywords ?? [],
            unique: !!card.unique,
            text: card.text || undefined,
            deployBox: card.deployBox || undefined,
            epicAction: card.epicAction || undefined,
            pilotText: card.pilotText || undefined,
            isToken: types.includes('token'),
            isLeader: types.includes('leader'),
        };
    }

    public toJson(): ICardIndexJson {
        return { format: 'karabast-sandbox-cards', version: 1, count: this.entries.length, cards: this.entries };
    }

    public getByInternalName(internalName: string): ICardIndexEntry | undefined {
        return this.byInternalName.get(internalName);
    }

    /** Canonical position-format name for an engine internal name (falls back to the internal name). */
    public nameFor(internalName: string): string {
        return this.byInternalName.get(internalName)?.name ?? internalName;
    }

    public lookup(rawName: string): CardLookupResult {
        const name = (rawName ?? '').trim();
        if (name.length === 0) {
            return { ok: false, message: 'Missing card name', candidates: [] };
        }

        // engine internal name
        const byInternal = this.byInternalName.get(name) ?? this.byInternalName.get(name.toLowerCase());
        if (byInternal) {
            return { ok: true, entry: byInternal };
        }

        // "Name (SET 123)" disambiguator
        const disambiguated = (/^(.*)\(\s*([A-Za-z0-9]{2,5})[\s_-]*0*(\d{1,4})\s*\)\s*$/).exec(name);
        if (disambiguated) {
            const code = setCodeString(disambiguated[2], Number(disambiguated[3]));
            const entry = code ? this.bySetCode.get(code) : undefined;
            if (entry) {
                return { ok: true, entry };
            }
        }

        const key = nameKey(name);

        // exact full name ("Title, Subtitle", or "Title" for cards without a subtitle)
        const byFull = this.byFullKey.get(key) ?? [];
        if (byFull.length === 1) {
            return { ok: true, entry: byFull[0] };
        }
        if (byFull.length > 1) {
            return {
                ok: false,
                message: `Ambiguous card name '${name}': add a set code`,
                candidates: byFull.map((entry) => entry.name)
            };
        }

        // unique title
        const byTitle = this.byTitleKey.get(key) ?? [];
        if (byTitle.length === 1) {
            return { ok: true, entry: byTitle[0] };
        }
        if (byTitle.length > 1) {
            return {
                ok: false,
                message: `Ambiguous card name '${name}': several cards are called that, add the subtitle`,
                candidates: byTitle.map((entry) => entry.name)
            };
        }

        // set code: "SEC 034", "SEC_034", "sec-34"
        const setCodeMatch = (/^([A-Za-z0-9]{2,5}?)[\s_-]*0*(\d{1,4})$/).exec(name);
        if (setCodeMatch) {
            const code = setCodeString(setCodeMatch[1], Number(setCodeMatch[2]));
            const entry = code ? this.bySetCode.get(code) : undefined;
            if (entry) {
                return { ok: true, entry };
            }
        }

        return { ok: false, message: `Unknown card '${name}'`, candidates: this.suggest(name) };
    }

    public suggest(rawName: string, limit = 5): string[] {
        const key = nameKey(rawName);
        if (key.length === 0) {
            return [];
        }
        const scored: { entry: ICardIndexEntry; score: number }[] = [];
        for (const entry of this.entries) {
            const titleKey = nameKey(entry.title);
            const full = nameKey(fullName(entry.title, entry.subtitle));
            let score = 0;
            if (full.startsWith(key) || titleKey.startsWith(key)) {
                score = 3;
            } else if (full.includes(key)) {
                score = 2;
            } else if (key.includes(titleKey) && titleKey.length >= 4) {
                score = 1;
            }
            if (score > 0) {
                scored.push({ entry, score });
            }
        }
        scored.sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length);
        return scored.slice(0, limit).map((item) => item.entry.name);
    }
}
