import type {
    ISandboxInput,
    ISandboxTree,
    ISandboxTreeNode,
    ISerializedTree,
    ISerializedTreeNode,
    SandboxNodeKind,
    Seat
} from './SandboxTypes';

/** Deep equality for recorded inputs (plain JSON values). */
export function inputsEqual(a: ISandboxInput | undefined, b: ISandboxInput | undefined): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The analysis tree: the root is the loaded position, every edge is one recorded input. children[0] is the main line.
 * Pure data structure: the session owns replaying.
 */
export class SandboxTree {
    public static readonly rootId = 'root';

    private readonly nodes = new Map<string, ISandboxTreeNode>();
    private nextId = 1;

    public constructor() {
        this.nodes.set(SandboxTree.rootId, {
            id: SandboxTree.rootId,
            parentId: null,
            children: [],
            kind: 'root',
            label: 'Start position',
            actionNumber: 0,
            ply: 0,
        });
    }

    public get root(): ISandboxTreeNode {
        return this.nodes.get(SandboxTree.rootId);
    }

    public has(id: string): boolean {
        return this.nodes.has(id);
    }

    public get(id: string): ISandboxTreeNode | undefined {
        return this.nodes.get(id);
    }

    public findChild(parentId: string, input: ISandboxInput): ISandboxTreeNode | undefined {
        const parent = this.nodes.get(parentId);
        return parent?.children.map((id) => this.nodes.get(id)).find((child) => inputsEqual(child.input, input));
    }

    public addChild(parentId: string, props: { kind: SandboxNodeKind; seat: Seat; input: ISandboxInput; label: string; promptTitle?: string }, id?: string): ISandboxTreeNode {
        const parent = this.nodes.get(parentId);
        if (!parent) {
            throw new Error(`Unknown parent node ${parentId}`);
        }
        const nodeId = id ?? `n${this.nextId++}`;
        if (id) {
            const numeric = (/^n(\d+)$/).exec(id);
            if (numeric) {
                this.nextId = Math.max(this.nextId, Number(numeric[1]) + 1);
            }
        }
        const node: ISandboxTreeNode = {
            id: nodeId,
            parentId,
            children: [],
            kind: props.kind,
            seat: props.seat,
            input: props.input,
            label: props.label,
            actionNumber: parent.actionNumber + (props.kind === 'action' ? 1 : 0),
            ply: parent.ply + 1,
        };
        if (props.promptTitle) {
            node.promptTitle = props.promptTitle;
        }
        this.nodes.set(nodeId, node);
        parent.children.push(nodeId);
        return node;
    }

    /** Node ids from the root to `id`, inclusive of both. */
    public pathTo(id: string): string[] {
        const path: string[] = [];
        let node = this.nodes.get(id);
        while (node) {
            path.push(node.id);
            node = node.parentId ? this.nodes.get(node.parentId) : undefined;
        }
        return path.reverse();
    }

    public isAncestorOrSelf(ancestorId: string, id: string): boolean {
        return this.pathTo(id).includes(ancestorId);
    }

    /** Removes `id` and its subtree. Returns the removed ids. */
    public delete(id: string): string[] {
        if (id === SandboxTree.rootId) {
            throw new Error('The root position cannot be deleted');
        }
        const node = this.nodes.get(id);
        if (!node) {
            return [];
        }
        const parent = this.nodes.get(node.parentId);
        parent.children = parent.children.filter((childId) => childId !== id);
        const removed: string[] = [];
        const stack = [id];
        while (stack.length > 0) {
            const next = stack.pop();
            const current = this.nodes.get(next);
            if (current) {
                stack.push(...current.children);
                this.nodes.delete(next);
                removed.push(next);
            }
        }
        return removed;
    }

    /** Makes the line through `id` the main line (children[0] at every fork on the way). */
    public promote(id: string): void {
        let node = this.nodes.get(id);
        while (node?.parentId) {
            const parent = this.nodes.get(node.parentId);
            parent.children = [node.id, ...parent.children.filter((childId) => childId !== node.id)];
            node = parent;
        }
    }

    public mainLine(): string[] {
        const line: string[] = [SandboxTree.rootId];
        let node = this.root;
        while (node.children.length > 0) {
            node = this.nodes.get(node.children[0]);
            line.push(node.id);
        }
        return line;
    }

    public toView(): ISandboxTree {
        const nodes: Record<string, ISandboxTreeNode> = {};
        for (const [id, node] of this.nodes) {
            nodes[id] = { ...node, children: [...node.children] };
        }
        return { rootId: 'root', nodes, mainLine: this.mainLine() };
    }

    /** Parents before children, siblings in order. */
    public serializeNodes(): ISerializedTreeNode[] {
        const out: ISerializedTreeNode[] = [];
        const visit = (id: string) => {
            const node = this.nodes.get(id);
            out.push({
                id: node.id,
                parentId: node.parentId,
                input: node.input ?? null,
                label: node.label,
                kind: node.kind,
                ...(node.promptTitle ? { promptTitle: node.promptTitle } : {})
            });
            node.children.forEach(visit);
        };
        visit(SandboxTree.rootId);
        return out;
    }

    public static fromSerialized(serialized: ISerializedTree): SandboxTree {
        const tree = new SandboxTree();
        for (const node of serialized.nodes ?? []) {
            if (node.id === SandboxTree.rootId || node.parentId == null) {
                continue;
            }
            if (!tree.has(node.parentId)) {
                throw new Error(`Saved tree node ${node.id} refers to unknown parent ${node.parentId}`);
            }
            tree.addChild(node.parentId, {
                kind: (node.kind === 'action' ? 'action' : 'decision'),
                seat: node.input?.seat as Seat,
                input: node.input,
                label: node.label,
                promptTitle: node.promptTitle,
            }, node.id);
        }
        return tree;
    }
}
