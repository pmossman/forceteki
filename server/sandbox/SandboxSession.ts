import type { Game } from '../game/core/Game';
import type { SandboxCardIndex } from './cards/SandboxCardIndex';
import type { ISandboxGameLoader, ISandboxRouter } from './loader/SandboxGameLoader';
import { exportPosition } from './position/PositionExporter';
import { resolvePosition } from './position/PositionResolver';
import { formatPositionText, parsePositionText } from './position/PositionText';
import { SandboxTree } from './SandboxTree';
import type {
    IActResult,
    IExportResult,
    IGotoResult,
    IIssue,
    ILoadRequest,
    ILoadResult,
    IParseResult,
    IPosition,
    IResolvedPosition,
    ISandboxInput,
    ISandboxSnapshot,
    ISerializedTree,
    IValidateResult,
    SandboxNodeKind,
    Seat
} from './SandboxTypes';
import { seatLabel } from './SandboxTypes';
import { buildGodView, getDeciders, getLog, getPromptInfo } from './SandboxViews';
import { buildResolutionStack, cleanTokenText } from './stack/ResolutionStack';

/**
 * One sandbox: a root position, the analysis tree of inputs played from it, and the live engine Game at the current
 * node. Transport-agnostic: callers (socket adapter today, a Web Worker later) call these methods and ship the plain
 * JSON results. See CONTRACT.md.
 */

const recordedCommands = new Set(['cardClicked', 'menuButton', 'perCardMenuButton', 'statefulPromptResults']);
const ignoredCommands = new Set(['resetActionTimer']);

export interface ISandboxSessionDeps {
    index: SandboxCardIndex;
    loader: ISandboxGameLoader;
}

type Listener = (snapshot: ISandboxSnapshot) => void;

/** FNV-1a, hex. Deterministic default seed for a root position. */
function hashString(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/** Stateless position helpers (no session needed). */
export class SandboxPositions {
    public constructor(private readonly index: SandboxCardIndex) {}

    public parse(text: string): IParseResult {
        return parsePositionText(text);
    }

    public format(position: IPosition): string {
        return formatPositionText(position);
    }

    public validate(input: { text?: string; position?: IPosition }): IValidateResult {
        const { resolved: _resolved, ...result } = resolvePosition(this.index, input);
        return result;
    }
}

export class SandboxSession implements ISandboxRouter {
    public readonly id = 'sandbox';

    private game: Game | null = null;
    private resolved: IResolvedPosition | null = null;
    private rootText = '';
    private seed = '';
    private tree = new SandboxTree();
    private currentNodeId = SandboxTree.rootId;
    private engineErrors: string[] = [];
    private readonly listeners: Listener[] = [];

    public constructor(private readonly deps: ISandboxSessionDeps) {}

    // ----------------------------------------------------------------------------------------------------------------
    // ISandboxRouter: what the engine calls back into
    // ----------------------------------------------------------------------------------------------------------------

    public handleError(_game: Game, error: Error): void {
        this.engineErrors.push(errorMessage(error));
    }

    public handleSerializationFailure(_game: Game, error: Error): never {
        throw error;
    }

    public handleGameEnd(): void {
        // nothing to do: the snapshot reports the winners
    }

    public handleUndoGameEnd(): void {
        // engine undo is not used in the sandbox
    }

    // ----------------------------------------------------------------------------------------------------------------
    // events
    // ----------------------------------------------------------------------------------------------------------------

    public onSnapshot(listener: Listener): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) {
                this.listeners.splice(i, 1);
            }
        };
    }

    private emit(snapshot: ISandboxSnapshot): ISandboxSnapshot {
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch {
                // a listener's failure must not break the session
            }
        }
        return snapshot;
    }

    public get isLoaded(): boolean {
        return this.game != null;
    }

    public get currentGame(): Game | null {
        return this.game;
    }

    // ----------------------------------------------------------------------------------------------------------------
    // load
    // ----------------------------------------------------------------------------------------------------------------

    public async loadAsync(request: ILoadRequest): Promise<ILoadResult> {
        const warnings: IIssue[] = [];
        let positionInput: { text?: string; position?: IPosition };
        let tree: SandboxTree | null = null;
        let targetNode = SandboxTree.rootId;
        let seed = request?.seed;

        if (request?.tree) {
            if (request.tree.format !== 'karabast-sandbox-tree') {
                return { ok: false, errors: [{ path: 'tree', message: 'Not a karabast-sandbox-tree' }], warnings };
            }
            positionInput = { text: request.tree.root?.positionText ?? '' };
            seed = request.tree.root?.seed ?? seed;
            try {
                tree = SandboxTree.fromSerialized(request.tree);
            } catch (error) {
                return { ok: false, errors: [{ path: 'tree', message: errorMessage(error) }], warnings };
            }
            targetNode = tree.has(request.tree.currentNodeId) ? request.tree.currentNodeId : SandboxTree.rootId;
        } else if (typeof request?.position === 'string') {
            positionInput = { text: request.position };
        } else if (request?.position && typeof request.position === 'object') {
            positionInput = { position: request.position };
        } else {
            return { ok: false, errors: [{ path: 'position', message: 'Provide a position (text or object) or a saved tree' }], warnings };
        }

        const result = resolvePosition(this.deps.index, positionInput);
        warnings.push(...result.warnings);
        if (!result.ok || !result.resolved) {
            return { ok: false, errors: result.errors, warnings };
        }

        const resolved = result.resolved;
        const rootSeed = seed || `root-${hashString(resolved.canonicalText)}`;

        this.engineErrors = [];
        let game: Game;
        try {
            game = await this.buildRootGameAsync(resolved, rootSeed);
        } catch (error) {
            return { ok: false, errors: [{ path: '', message: `The engine couldn't build this position: ${errorMessage(error)}` }], warnings };
        }

        this.game = game;
        this.resolved = resolved;
        this.rootText = resolved.canonicalText;
        this.seed = rootSeed;
        this.tree = tree ?? new SandboxTree();
        this.currentNodeId = SandboxTree.rootId;

        if (targetNode !== SandboxTree.rootId) {
            const replay = await this.replayPathAsync(this.tree.pathTo(targetNode).slice(1));
            if (!replay.ok) {
                warnings.push({ path: 'tree', message: `Couldn't replay the saved line to ${targetNode}: ${replay.error}` });
            }
        }

        return { ok: true, snapshot: this.emit(this.buildSnapshot()), warnings };
    }

    private async buildRootGameAsync(resolved: IResolvedPosition, seed: string): Promise<Game> {
        const game = await this.deps.loader.loadAsync(resolved.setup, resolved.adjustments, seed, this);
        game.continue();
        return game;
    }

    // ----------------------------------------------------------------------------------------------------------------
    // input
    // ----------------------------------------------------------------------------------------------------------------

    private requireGame(): Game {
        if (!this.game) {
            throw new Error('no session: call load first');
        }
        return this.game;
    }

    private fingerprint(game: Game): string {
        const parts: any[] = [(game as any).messages?.length ?? 0, game.currentPhase, game.isEnded];
        for (const seat of ['p1', 'p2'] as const) {
            const player: any = game.getPlayerById(seat);
            const state = player.promptState;
            parts.push(
                state.promptUuid,
                state.menuTitle,
                (state.buttons ?? []).map((b: any) => `${b.text}:${b.arg}:${b.disabled ? 1 : 0}`).join(','),
                (state.selectableCards ?? []).map((c: any) => c.uuid).join(','),
                (state.selectedCards ?? []).map((c: any) => c.uuid).join(','),
                JSON.stringify(state.distributeAmongTargets ?? null),
                JSON.stringify(state.batchTriggerResolution ?? null)
            );
        }
        return JSON.stringify(parts);
    }

    private resolveSeat(game: Game, input: ISandboxInput): Seat {
        if (input.seat === 'p1' || input.seat === 'p2') {
            return input.seat;
        }
        if (input.seat != null) {
            throw new Error(`Unknown seat '${input.seat}' (use 'p1' or 'p2')`);
        }
        const deciders = getDeciders(game);
        if (deciders.length === 1) {
            return deciders[0];
        }
        if (deciders.length === 0) {
            throw new Error('Nobody is being asked to decide right now');
        }
        throw new Error('Both players are deciding: say which seat is acting');
    }

    /** Recorded form of an input: prompt uuids stripped, seat explicit. */
    private recordInput(seat: Seat, input: ISandboxInput): ISandboxInput {
        const args = Array.isArray(input.args) ? [...input.args] : [];
        switch (input.command) {
            case 'cardClicked':
                return { seat, command: 'cardClicked', args: [args[0]] };
            case 'menuButton':
                return { seat, command: 'menuButton', args: args.length > 2 && args[2] != null ? [args[0], null, args[2]] : [args[0]] };
            case 'perCardMenuButton':
                return { seat, command: 'perCardMenuButton', args: args.length > 3 && args[3] != null ? [args[0], args[1], null, args[3]] : [args[0], args[1]] };
            case 'statefulPromptResults':
                return { seat, command: 'statefulPromptResults', args: [args[0]] };
            default:
                throw new Error(`Command '${input.command}' is not allowed in the sandbox`);
        }
    }

    /** Applies a recorded input to the live game, filling in the seat's current prompt uuid. */
    private applyInput(game: Game, input: ISandboxInput): void {
        const seat = input.seat as Seat;
        const player: any = game.getPlayerById(seat);
        const promptUuid = player.promptState.promptUuid;
        const args = input.args;
        switch (input.command) {
            case 'cardClicked':
                game.cardClicked(seat, args[0]);
                break;
            case 'menuButton':
                game.menuButton(seat, args[0], promptUuid, args[2]);
                break;
            case 'perCardMenuButton':
                game.perCardMenuButton(seat, args[0], args[1], promptUuid, args[3]);
                break;
            case 'statefulPromptResults':
                game.statefulPromptResults(seat, args[0], promptUuid);
                break;
            default:
                throw new Error(`Command '${input.command}' is not allowed in the sandbox`);
        }
        game.continue();
    }

    /** Applies and checks that something changed. Throws if the input was rejected or had no effect. */
    private applyAndCheck(game: Game, input: ISandboxInput): void {
        const before = this.fingerprint(game);
        try {
            this.applyInput(game, input);
        } catch (error) {
            const message = errorMessage(error);
            if ((/is not active for this prompt/).test(message)) {
                throw new Error(`${seatLabel(input.seat as Seat)} is not the one deciding right now`);
            }
            throw new Error(message);
        }
        if (this.fingerprint(game) === before) {
            throw new Error('That input had no effect');
        }
    }

    private describeInput(game: Game, input: ISandboxInput): { label: string; kind: SandboxNodeKind; promptTitle: string } {
        const seat = input.seat as Seat;
        const who = seatLabel(seat);
        const player: any = game.getPlayerById(seat);
        const state = player.promptState;
        const promptTitle = cleanTokenText(state.menuTitle || state.promptTitle || '');
        const inActionWindow = state.promptType === 'actionWindow';
        const kind: SandboxNodeKind = inActionWindow ? 'action' : 'decision';
        const cardName = (uuid: string) => (game as any).findAnyCardInAnyList?.(uuid)?.title ?? uuid;

        let label: string;
        switch (input.command) {
            case 'cardClicked':
                label = inActionWindow ? `${who}: ${cardName(input.args[0])}` : `${who} chose ${cardName(input.args[0])}`;
                break;
            case 'menuButton': {
                const button = (state.buttons ?? []).find((b: any) => String(b.arg) === String(input.args[0]));
                const text = button ? cleanTokenText(button.text) : String(input.args[0]);
                label = `${who}: ${text}`;
                break;
            }
            case 'perCardMenuButton': {
                const button = (state.perCardButtons ?? []).find((b: any) => String(b.arg) === String(input.args[0]));
                const text = button ? cleanTokenText(button.text) : String(input.args[0]);
                label = `${who}: ${text} (${cardName(input.args[1])})`;
                break;
            }
            case 'statefulPromptResults':
                label = `${who}: confirmed ${promptTitle || 'choice'}`;
                break;
            default:
                label = `${who}: ${input.command}`;
        }
        return { label, kind, promptTitle };
    }

    public actAsync(input: ISandboxInput): Promise<IActResult> {
        return Promise.resolve(this.act(input));
    }

    public act(input: ISandboxInput): IActResult {
        let game: Game;
        try {
            game = this.requireGame();
        } catch (error) {
            return { ok: false, error: errorMessage(error) };
        }
        if (!input || typeof input.command !== 'string') {
            return { ok: false, error: 'Input needs a command', snapshot: this.buildSnapshot() };
        }
        if (ignoredCommands.has(input.command)) {
            return { ok: true, snapshot: this.buildSnapshot(), nodeId: this.currentNodeId, reusedExistingNode: true };
        }
        if (!recordedCommands.has(input.command)) {
            return {
                ok: false,
                error: `Command '${input.command}' is not available in the sandbox` +
                  (input.command === 'rollbackToSnapshot' ? ': use goto on the tree instead of undo' : ''),
                snapshot: this.buildSnapshot()
            };
        }

        let recorded: ISandboxInput;
        let description: { label: string; kind: SandboxNodeKind; promptTitle: string };
        try {
            const seat = this.resolveSeat(game, input);
            recorded = this.recordInput(seat, input);
            description = this.describeInput(game, recorded);
            this.engineErrors = [];
            this.applyAndCheck(game, recorded);
        } catch (error) {
            return { ok: false, error: errorMessage(error), snapshot: this.buildSnapshot() };
        }

        const existing = this.tree.findChild(this.currentNodeId, recorded);
        const node = existing ?? this.tree.addChild(this.currentNodeId, {
            kind: description.kind,
            seat: recorded.seat as Seat,
            input: recorded,
            label: description.label,
            promptTitle: description.promptTitle || undefined,
        });
        this.currentNodeId = node.id;
        return { ok: true, snapshot: this.emit(this.buildSnapshot()), nodeId: node.id, reusedExistingNode: !!existing };
    }

    // ----------------------------------------------------------------------------------------------------------------
    // tree navigation
    // ----------------------------------------------------------------------------------------------------------------

    /** Plays the given node ids (each a child of the previous / of the current node) on the live game. */
    private replayPathAsync(nodeIds: string[]): Promise<{ ok: boolean; error?: string }> {
        const game = this.requireGame();
        for (const nodeId of nodeIds) {
            const node = this.tree.get(nodeId);
            if (!node?.input) {
                return Promise.resolve({ ok: false, error: `Node ${nodeId} has no input` });
            }
            try {
                this.applyAndCheck(game, node.input);
            } catch (error) {
                return Promise.resolve({ ok: false, error: `Replay diverged at ${nodeId} (${node.label}): ${errorMessage(error)}` });
            }
            this.currentNodeId = nodeId;
        }
        return Promise.resolve({ ok: true });
    }

    public async gotoAsync(nodeId: string): Promise<IGotoResult> {
        if (!this.game || !this.resolved) {
            return { ok: false, error: 'no session: call load first' };
        }
        if (!this.tree.has(nodeId)) {
            return { ok: false, error: `Unknown node '${nodeId}'`, snapshot: this.buildSnapshot() };
        }
        if (nodeId === this.currentNodeId) {
            return { ok: true, snapshot: this.emit(this.buildSnapshot()) };
        }

        this.engineErrors = [];
        const path = this.tree.pathTo(nodeId);
        const currentIndex = path.indexOf(this.currentNodeId);
        let remaining: string[];
        if (currentIndex >= 0) {
            // target is a descendant: just play forward
            remaining = path.slice(currentIndex + 1);
        } else {
            try {
                this.game = await this.buildRootGameAsync(this.resolved, this.seed);
            } catch (error) {
                return { ok: false, error: `Couldn't rebuild the root position: ${errorMessage(error)}` };
            }
            this.currentNodeId = SandboxTree.rootId;
            remaining = path.slice(1);
        }

        const replay = await this.replayPathAsync(remaining);
        const snapshot = this.emit(this.buildSnapshot());
        if (!replay.ok) {
            return { ok: false, error: replay.error, snapshot };
        }
        return { ok: true, snapshot };
    }

    public async deleteNodeAsync(nodeId: string): Promise<IGotoResult> {
        if (!this.game) {
            return { ok: false, error: 'no session: call load first' };
        }
        if (nodeId === SandboxTree.rootId) {
            return { ok: false, error: 'The root position cannot be deleted', snapshot: this.buildSnapshot() };
        }
        const node = this.tree.get(nodeId);
        if (!node) {
            return { ok: false, error: `Unknown node '${nodeId}'`, snapshot: this.buildSnapshot() };
        }
        const currentInside = this.tree.isAncestorOrSelf(nodeId, this.currentNodeId);
        const parentId = node.parentId;
        if (currentInside) {
            const moved = await this.gotoAsync(parentId);
            if (!moved.ok) {
                return moved;
            }
        }
        this.tree.delete(nodeId);
        return { ok: true, snapshot: this.emit(this.buildSnapshot()) };
    }

    public promoteNodeAsync(nodeId: string): Promise<IGotoResult> {
        if (!this.game) {
            return Promise.resolve({ ok: false, error: 'no session: call load first' });
        }
        if (!this.tree.has(nodeId)) {
            return Promise.resolve({ ok: false, error: `Unknown node '${nodeId}'`, snapshot: this.buildSnapshot() });
        }
        this.tree.promote(nodeId);
        return Promise.resolve({ ok: true, snapshot: this.emit(this.buildSnapshot()) });
    }

    // ----------------------------------------------------------------------------------------------------------------
    // export / serialise / snapshot
    // ----------------------------------------------------------------------------------------------------------------

    public exportPosition(): IExportResult {
        const game = this.requireGame();
        const { position, warnings } = exportPosition(this.deps.index, game, this.resolved?.position?.title);
        return { text: formatPositionText(position), position, warnings };
    }

    public serializeTree(): ISerializedTree {
        this.requireGame();
        return {
            format: 'karabast-sandbox-tree',
            version: 1,
            root: { positionText: this.rootText, seed: this.seed },
            nodes: this.tree.serializeNodes(),
            currentNodeId: this.currentNodeId,
        };
    }

    public get currentNode(): string {
        return this.currentNodeId;
    }

    public getSnapshot(): ISandboxSnapshot {
        this.requireGame();
        return this.buildSnapshot();
    }

    private buildSnapshot(): ISandboxSnapshot {
        const game = this.requireGame();
        const deciders = getDeciders(game);
        const views = { p1: game.getState('p1'), p2: game.getState('p2') };
        const snapshot: ISandboxSnapshot = {
            nodeId: this.currentNodeId,
            tree: this.tree.toView(),
            views,
            godView: buildGodView(views, deciders),
            deciders,
            prompts: { p1: getPromptInfo(game, 'p1', deciders), p2: getPromptInfo(game, 'p2', deciders) },
            stack: buildResolutionStack(game),
            log: getLog(game),
        };
        if (game.isEnded) {
            snapshot.gameOver = { winners: [...game.winnerNames] };
        }
        if (this.engineErrors.length > 0) {
            snapshot.engineErrors = [...this.engineErrors];
        }
        return snapshot;
    }
}
