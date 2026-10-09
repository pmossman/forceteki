// Copied from the browser-engine spike (scratch/browser-engine 0d3b7f756, browser-spike/), see SPIKE-browser-engine.md.
// Browser replacement for `node:v8`, used only by the snapshot (undo) system:
//   server/game/core/snapshot/SnapshotFactory.ts:155   v8.serialize(this.game.state)
//   server/game/core/snapshot/GameStateManager.ts:140  v8.serialize(record of GameObject states)
//   server/game/core/snapshot/GameStateManager.ts:152  v8.deserialize(snapshot.gameState)
//   server/game/core/snapshot/GameStateManager.ts:154  v8.deserialize(snapshot.states)
//
// The engine only ever round-trips these values (it never inspects the Buffer), so a deep copy is
// enough. Node's v8.serialize and the browser's structuredClone both implement the HTML structured
// clone algorithm (V8's ValueSerializer), so the set of cloneable values and the errors on
// functions/class prototypes match. The difference is representation: the "serialized" value is a
// detached object graph instead of a compact Buffer, so snapshots use more heap.
//
// deserialize must clone again: a snapshot can be rolled back to more than once, and the restored
// object is mutated in place by the live game afterwards.

export function serialize(value: unknown): any {
    return structuredClone(value);
}

export function deserialize(value: unknown): any {
    return structuredClone(value);
}

export default { serialize, deserialize };
