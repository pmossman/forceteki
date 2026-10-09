import type { Game } from '../../game/core/Game';
import { UndoMode } from '../../game/core/snapshot/SnapshotManager';
import type { IPostSetupAdjustments, ISetupDsl, Seat } from '../SandboxTypes';
import { sandboxPlayerNames } from '../position/PositionResolver';

/** What the engine calls on its "router" (normally the Lobby). The session implements it. */
export interface ISandboxRouter {
    id: string;
    handleError(game: Game, error: Error, severity?: unknown): void;
    handleSerializationFailure(game: Game, error: Error): never;
    handleGameEnd(): void;
    handleUndoGameEnd(): void;
}

/** Builds a live engine Game from a setup DSL. The session depends only on this interface. */
export interface ISandboxGameLoader {
    loadAsync(setup: ISetupDsl, adjustments: IPostSetupAdjustments, seed: string, router: ISandboxRouter): Promise<Game>;
}

/**
 * The pieces of forceteki's test harness that build a board from the setup DSL. Passed in rather than imported, so
 * the session module doesn't depend on `test/` (the Node adapter `require`s the compiled harness; a browser build would
 * bundle it).
 */
export interface IHarnessDeps {

    /** `test/helpers/GameFlowWrapper.js` class */
    GameFlowWrapper: new (cardDataGetter: any, router: any, p1: any, p2: any, undoMode?: UndoMode) => { game: Game };

    /** a `test/helpers/GameStateBuilder.js` instance (only `attachTestInfoToObj` and `setupGameStateAsync` are used) */
    builder: {
        attachTestInfoToObj(ctx: any, gameFlowWrapper: any, player1Name: string, player2Name: string): void;
        setupGameStateAsync(ctx: any, setup: any): Promise<void>;
    };

    /** the card data getter the Game will use (must be synchronous: ISynchronousCardDataGetter) */
    cardDataGetter: any;
}

export const sandboxPlayerIds: Record<Seat, string> = { p1: 'p1', p2: 'p2' };

/**
 * Loads positions through forceteki's own test-setup code (`GameStateBuilder.setupGameStateAsync`), so the sandbox
 * builds boards exactly the way the engine's specs and the dev test-game path do.
 */
export class HarnessGameLoader implements ISandboxGameLoader {
    public constructor(private readonly deps: IHarnessDeps) {}

    public async loadAsync(setup: ISetupDsl, adjustments: IPostSetupAdjustments, seed: string, router: ISandboxRouter): Promise<Game> {
        const { GameFlowWrapper, builder, cardDataGetter } = this.deps;
        const wrapper = new GameFlowWrapper(
            cardDataGetter,
            router,
            { id: sandboxPlayerIds.p1, username: sandboxPlayerNames.p1 },
            { id: sandboxPlayerIds.p2, username: sandboxPlayerNames.p2 },
            UndoMode.Free
        );

        // seed BEFORE setup: the setup phase itself draws on the RNG, and replays must match exactly
        wrapper.game.setRandomSeed(seed);

        const ctx: any = {};
        builder.attachTestInfoToObj(ctx, wrapper, sandboxPlayerNames.p1, sandboxPlayerNames.p2);

        // The harness ends setup by snapshotting an 'action' timepoint, which reads the action phase's active player.
        // In the regroup phase there is none (forceteki's own specs never set up a regroup position with undo on), so
        // that one call would throw. Skip it for regroup positions; every later timepoint snapshots as usual.
        const snapshots = (wrapper.game as any).snapshotManager;
        if (setup.phase === 'regroup' && snapshots) {
            const moveToNextTimepoint = snapshots.moveToNextTimepoint;
            snapshots.moveToNextTimepoint = function (timepoint: string) {
                if (timepoint === 'action' && !(wrapper.game as any).actionPhaseActivePlayer) {
                    return;
                }
                return moveToNextTimepoint.call(this, timepoint);
            };
        }

        // the harness mutates its options object, so always hand it a fresh copy
        try {
            await builder.setupGameStateAsync(ctx, JSON.parse(JSON.stringify(setup)));
        } finally {
            if (snapshots && Object.prototype.hasOwnProperty.call(snapshots, 'moveToNextTimepoint')) {
                delete snapshots.moveToNextTimepoint;
            }
        }

        const game = wrapper.game;
        let changed = false;

        for (const seat of adjustments.epicActionUsed ?? []) {
            const player = game.getPlayerById(sandboxPlayerIds[seat]);
            const leader: any = player.getAllDeckLeaders()[0];
            const deployAbility = leader?.getActionAbilities?.().find((ability: any) => String(ability.getTitle()).includes('Deploy'));
            if (deployAbility?.limit) {
                deployAbility.limit.increment(player);
                changed = true;
            }
        }

        for (const seat of ['p1', 'p2'] as const) {
            const tokens = adjustments.leaderTokenUpgrades?.[seat];
            if (tokens?.length) {
                const wrapperForSeat = seat === 'p1' ? ctx.player1 : ctx.player2;
                const leader: any = game.getPlayerById(sandboxPlayerIds[seat]).getAllDeckLeaders()[0];
                wrapperForSeat.setCardUpgrades(leader, tokens);
                changed = true;
            }
        }

        if (adjustments.activePlayer) {
            const wrapperForSeat = adjustments.activePlayer === 'p1' ? ctx.player1 : ctx.player2;
            wrapperForSeat.setActivePlayer();
            changed = true;
        }

        if (changed) {
            game.resolveGameState(true);
            // re-run the open prompt so both players' prompt states reflect the change
            game.continue();
        }

        return game;
    }
}
