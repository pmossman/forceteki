import type { SandboxCardIndex } from './cards/SandboxCardIndex';
import type { ISandboxGameLoader } from './loader/SandboxGameLoader';
import { SandboxPositions, SandboxSession } from './SandboxSession';
import { sandboxPresets } from './SandboxPresets';
import type { ISandboxSnapshot } from './SandboxTypes';

/**
 * The sandbox's wire protocol, shared by every transport (socket.io adapter, Web Worker): one method name plus one
 * JSON payload in, one JSON result out, plus `snapshot` events. Calls are serialised: a goto rebuilds the game
 * asynchronously and nothing may act on it meanwhile. See CONTRACT.md §1 and §3.
 */

export const sandboxMethods = [
    'parsePosition', 'formatPosition', 'validatePosition',
    'load', 'act', 'goto', 'deleteNode', 'promoteNode',
    'exportPosition', 'serializeTree', 'getSnapshot',
    'getPresets', 'getCardIndex',
] as const;

export type SandboxMethod = typeof sandboxMethods[number];

const noSession = { ok: false, error: 'no session: call load first' };

export class SandboxDispatcher {
    public readonly session: SandboxSession;
    private readonly positions: SandboxPositions;
    private queue: Promise<unknown> = Promise.resolve();

    public constructor(private readonly deps: { index: SandboxCardIndex; loader: ISandboxGameLoader }) {
        this.session = new SandboxSession(deps);
        this.positions = new SandboxPositions(deps.index);
    }

    public onSnapshot(listener: (snapshot: ISandboxSnapshot) => void): () => void {
        return this.session.onSnapshot(listener);
    }

    /** Runs one call after all earlier calls have finished. Never rejects: failures come back as `{ ok: false, error }`. */
    public call(method: string, payload: any): Promise<unknown> {
        const run = this.queue.then(async () => {
            try {
                return await this.dispatch(method, payload ?? {});
            } catch (error) {
                return { ok: false, error: String((error as Error)?.message ?? error) };
            }
        });
        this.queue = run;
        return run;
    }

    private dispatch(method: string, p: any): unknown {
        const session = this.session;
        switch (method as SandboxMethod) {
            case 'parsePosition':
                return this.positions.parse(String(p.text ?? ''));
            case 'formatPosition':
                return { text: this.positions.format(p.position) };
            case 'validatePosition':
                return this.positions.validate({ text: p.text, position: p.position });
            case 'load':
                return session.loadAsync(p);
            case 'act':
                return session.actAsync(p);
            case 'goto':
                return session.gotoAsync(String(p.nodeId));
            case 'deleteNode':
                return session.deleteNodeAsync(String(p.nodeId));
            case 'promoteNode':
                return session.promoteNodeAsync(String(p.nodeId));
            case 'exportPosition':
                return session.isLoaded ? session.exportPosition() : noSession;
            case 'serializeTree':
                return session.isLoaded ? session.serializeTree() : noSession;
            case 'getSnapshot':
                return session.isLoaded ? { ok: true, snapshot: session.getSnapshot() } : noSession;
            case 'getPresets':
                return { presets: sandboxPresets };
            case 'getCardIndex':
                return this.deps.index.toJson();
            default:
                return { ok: false, error: `Unknown sandbox method '${method}'` };
        }
    }
}
