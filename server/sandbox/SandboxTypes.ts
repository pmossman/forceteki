/**
 * Shared types for the Karabast sandbox (board editor + analysis tree).
 *
 * The sandbox is a transport-agnostic module: nothing in `server/sandbox/` (apart from `adapters/`) may depend on
 * lobbies, sockets, users, express or Node-only APIs, so the same code can later run in a browser Web Worker.
 * See CONTRACT.md / POSITION-FORMAT.md in the board-editor stream folder.
 */

export type Seat = 'p1' | 'p2';
export const Seats: readonly Seat[] = ['p1', 'p2'];

export function otherSeat(seat: Seat): Seat {
    return seat === 'p1' ? 'p2' : 'p1';
}

export function seatLabel(seat: Seat): string {
    return seat === 'p1' ? 'P1' : 'P2';
}

// ---------------------------------------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------------------------------------

export interface IIssue {
    path: string;
    message: string;
    line?: number;
}

export interface ICardEntry {
    card: string;

    /** 1-based text line this entry came from (parser only; never serialised by the formatter) */
    line?: number;
}

export interface IResourceEntry extends ICardEntry {
    exhausted?: boolean;
}

export interface IUpgradeEntry extends ICardEntry {
    owner?: Seat;
}

export interface ICapturedEntry extends ICardEntry {
    owner?: Seat;
}

export interface IUnitEntry extends ICardEntry {
    damage?: number;
    exhausted?: boolean;
    owner?: Seat;
    upgrades?: IUpgradeEntry[];
    captured?: ICapturedEntry[];
}

export interface ILeaderEntry extends ICardEntry {
    deployed?: boolean;
    exhausted?: boolean;
    damage?: number;
    epicActionUsed?: boolean;
    flipped?: boolean;
    upgrades?: IUpgradeEntry[];
    captured?: ICapturedEntry[];
}

export interface IBaseEntry extends ICardEntry {
    damage?: number;
    upgrades?: IUpgradeEntry[];
    captured?: ICapturedEntry[];
}

export interface IPlayerPosition {
    leader?: ILeaderEntry;
    base?: IBaseEntry;
    ground: IUnitEntry[];
    space: IUnitEntry[];
    resources: IResourceEntry[];
    hand: ICardEntry[];
    deck: ICardEntry[];
    discard: ICardEntry[];
    credits?: number;
    force?: boolean;
}

export type SandboxPhase = 'action' | 'regroup';

export interface IPosition {
    version: 1;
    title?: string;
    phase: SandboxPhase;
    initiative: Seat;
    active?: Seat;
    p1: IPlayerPosition;
    p2: IPlayerPosition;
}

export interface IParseResult {
    position?: IPosition;
    errors: IIssue[];
    warnings: IIssue[];
}

export interface IValidateResult {
    ok: boolean;
    position?: IPosition;
    canonicalText?: string;
    errors: IIssue[];
    warnings: IIssue[];
}

/** The engine's `setupTestAsync` / test-game schema, with internal names. Loosely typed on purpose. */
export interface ISetupDsl {
    phase: SandboxPhase;
    autoSingleTarget: boolean;
    player1: Record<string, any>;
    player2: Record<string, any>;
}

/** Things the setup DSL can't express, applied by the loader after the board is built. */
export interface IPostSetupAdjustments {
    activePlayer?: Seat;
    epicActionUsed?: Seat[];
}

export interface IResolvedPosition {
    position: IPosition;
    setup: ISetupDsl;
    adjustments: IPostSetupAdjustments;
    canonicalText: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs, tree
// ---------------------------------------------------------------------------------------------------------------------

export type SandboxCommand = 'cardClicked' | 'menuButton' | 'perCardMenuButton' | 'statefulPromptResults';

export interface ISandboxInput {
    seat?: Seat;
    command: SandboxCommand | string;
    args: any[];
}

export type SandboxNodeKind = 'root' | 'action' | 'decision';

export interface ISandboxTreeNode {
    id: string;
    parentId: string | null;
    children: string[];
    kind: SandboxNodeKind;
    seat?: Seat;
    input?: ISandboxInput;
    label: string;
    promptTitle?: string;
    actionNumber: number;
    ply: number;
}

export interface ISandboxTree {
    rootId: 'root';
    nodes: Record<string, ISandboxTreeNode>;
    mainLine: string[];
}

export interface ISerializedTreeNode {
    id: string;
    parentId: string | null;
    input: ISandboxInput | null;
    label: string;
    kind: string;
    promptTitle?: string;
}

export interface ISerializedTree {
    format: 'karabast-sandbox-tree';
    version: 1;
    root: { positionText: string; seed: string };
    nodes: ISerializedTreeNode[];
    currentNodeId: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------------------------------

export interface ICardRef {
    uuid: string;
    name: string;
    internalName: string;
    setId?: { set: string; number?: number };
    controller?: Seat;
}

export interface IStackItem {
    id: string;
    title: string;
    label: string;
    engineTitle: string;
    sourceCard: ICardRef;
    controller: Seat;
    status: 'resolving' | 'pending' | 'resolved';
    optional: boolean;
    hasLegalEffects: boolean;
    count?: number;
    fromHiddenZone?: boolean;
}

export interface IStackFrame {
    id: string;
    kind: 'action' | 'ability' | 'triggerLayer';
    depth: number;
    title: string;
    controller?: Seat;
    sourceCard?: ICardRef;
    status: 'resolving' | 'waiting' | 'collecting';
    waitingReason?: string;
    triggeredBy?: string[];
    nestedUnder?: { frameId: string; itemId?: string; title: string };
    chooser?: { seat: Seat; choosing: 'playerOrder' | 'abilityOrder'; text: string } | null;
    items?: IStackItem[];
    rulesHint?: { text: string; refs: string[] };
    engine: { step: string; detail: string };
}

export interface IPromptInfo {
    seat: Seat;
    deciding: boolean;
    menuTitle: string;
    promptTitle: string;
    promptType: string;
    buttons: { text: string; arg: string; command: string }[];
    selectableCardUuids: string[];
}

export interface ISandboxSnapshot {
    nodeId: string;
    tree: ISandboxTree;
    views: { p1: any; p2: any };
    godView: any;
    deciders: Seat[];
    prompts: { p1: IPromptInfo; p2: IPromptInfo };
    stack: IStackFrame[];
    log: string[];
    gameOver?: { winners: string[] };
    engineErrors?: string[];
}

export interface ILoadRequest {
    position?: string | IPosition;
    seed?: string;
    tree?: ISerializedTree;
}

export type ILoadResult =
  | { ok: true; snapshot: ISandboxSnapshot; warnings: IIssue[] }
  | { ok: false; errors: IIssue[]; warnings: IIssue[] };

export type IActResult =
  | { ok: true; snapshot: ISandboxSnapshot; nodeId: string; reusedExistingNode: boolean }
  | { ok: false; error: string; snapshot?: ISandboxSnapshot };

export type IGotoResult =
  | { ok: true; snapshot: ISandboxSnapshot }
  | { ok: false; error: string; snapshot?: ISandboxSnapshot };

export interface IExportResult {
    text: string;
    position: IPosition;
    warnings: IIssue[];
}
