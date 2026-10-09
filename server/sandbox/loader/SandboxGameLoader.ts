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

        // Upgrades and captured cards on bases and deployed leaders are attached by setBaseStatus / setLeaderStatus
        // AFTER hand, discard and resources are placed, and they look for the card in every zone ('any'): with the same
        // card also in a hand (say), that copy was moved onto the base and the hand came up a card short. Every card
        // the setup names starts outside the game, so during setup an 'any' search means that zone (arena units'
        // upgrades and captured cards already pass it explicitly). Token upgrades are generated, so they are unaffected.
        const patched = ['setCardUpgrades', 'setCapturedUnits'];
        const players = [ctx.player1, ctx.player2].filter((p: any) => p && patched.every((m) => typeof p[m] === 'function'));
        for (const player of players) {
            for (const method of patched) {
                const original = player[method];
                player[method] = function (card: any, cards: any, prevZones: string | string[] = 'any') {
                    return original.call(this, card, cards, prevZones === 'any' ? ['outsideTheGame'] : prevZones);
                };
            }
        }

        // the harness mutates its options object, so always hand it a fresh copy
        const dsl = JSON.parse(JSON.stringify(setup));

        // Cards captured by a deployed leader: the harness creates cards for captures on bases and arena units only, so
        // a leader's capture had no card of its own (it took a copy from another zone, or failed to load). Each one is
        // put at the bottom of its owner's deck in the DSL, which gives it a card, and moved under the leader after setup.
        const leaderCaptures: { captor: Seat; owner: Seat; card: string }[] = [];
        for (const captor of ['p1', 'p2'] as const) {
            const leader = dsl[captor === 'p1' ? 'player1' : 'player2']?.leader;
            if (!leader || typeof leader !== 'object' || !Array.isArray(leader.capturedUnits) || !leader.capturedUnits.length) {
                continue;
            }
            for (const entry of leader.capturedUnits) {
                const card: string = typeof entry === 'string' ? entry : entry.card;
                const owner: Seat = typeof entry === 'object' && entry.owner
                    ? (entry.owner === sandboxPlayerNames.p1 ? 'p1' : 'p2')
                    : (captor === 'p1' ? 'p2' : 'p1');
                const ownerDsl = dsl[owner === 'p1' ? 'player1' : 'player2'];
                ownerDsl.deck = [...(Array.isArray(ownerDsl.deck) ? ownerDsl.deck : []), card];
                leaderCaptures.push({ captor, owner, card });
            }
            delete leader.capturedUnits;
        }

        try {
            await builder.setupGameStateAsync(ctx, dsl);
        } finally {
            if (snapshots && Object.prototype.hasOwnProperty.call(snapshots, 'moveToNextTimepoint')) {
                delete snapshots.moveToNextTimepoint;
            }
            for (const player of players) {
                for (const method of patched) {
                    Reflect.deleteProperty(player, method);
                }
            }
        }

        const game = wrapper.game;
        let changed = false;

        for (const { captor, owner, card } of leaderCaptures) {
            const leader: any = game.getPlayerById(sandboxPlayerIds[captor]).getAllDeckLeaders()[0];
            const deck: any[] = (game.getPlayerById(sandboxPlayerIds[owner]) as any).drawDeck;
            const captive = [...deck].reverse().find((c: any) => c.internalName === card);
            if (!captive || !leader?.captureZone) {
                throw new Error(`could not put ${card} under ${captor.toUpperCase()}'s leader`);
            }
            captive.moveToCaptureZone(leader.captureZone);
            changed = true;
        }

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
