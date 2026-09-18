import { LruCache } from './cache.js';
import type { Graph } from './graph.js';
import { hash64, stableStringify } from './hash.js';
import type { NodeRegistry } from './registry.js';
import { passThroughOf } from './rewire.js';
import type { NodeDefinition, NodeId, PortId, Value } from './types.js';

export type NodeStatus = 'evaluated' | 'cached' | 'error' | 'skipped' | 'suppressed';

export interface NodeResult {
  readonly status: NodeStatus;
  readonly hash: string;
  readonly outputs: Record<PortId, Value>;
  readonly error?: string;
}

export interface EvalStats {
  evaluated: number;
  cached: number;
  errored: number;
  skipped: number;
  /** Held back, and so handed on rather than computed. */
  suppressed: number;
}

export interface EvalResult {
  readonly results: Map<NodeId, NodeResult>;
  readonly order: NodeId[];
  readonly stats: EvalStats;
}

export class Evaluator {
  constructor(
    private readonly registry: NodeRegistry<NodeDefinition>,
    readonly cache: LruCache = new LruCache(),
  ) {}

  evaluate(graph: Graph): EvalResult {
    this.cache.beginGeneration();
    const order = graph.topologicalOrder();
    const results = new Map<NodeId, NodeResult>();
    const stats: EvalStats = { evaluated: 0, cached: 0, errored: 0, skipped: 0, suppressed: 0 };

    for (const nodeId of order) {
      const node = graph.requireNode(nodeId);
      const definition = this.registry.require(node.type);
      const schema = graph.schemaOf(nodeId);
      // An output that only repeats an input is filled here, so a node never has
      // to restate its own dimensions to publish them.
      const echoed = schema.outputs.filter((port) => port.echoes !== undefined);

      const inputs: Record<PortId, Value> = {};
      const hashParts: string[] = [node.type];
      let blocked = false;

      for (const port of schema.inputs) {
        const edge = graph.incomingEdge(nodeId, port.id);
        if (edge === undefined) {
          const literal = graph.inputValue(nodeId, port.id);
          inputs[port.id] = literal;
          // A cosmetic input says nothing about the result, so it says nothing
          // about the hash either: moving a dimension is not a rebuild.
          if (port.cosmetic !== true) hashParts.push(`${port.id}=l:${stableStringify(literal)}`);
          continue;
        }

        const upstream = results.get(edge.from.node);
        if (upstream === undefined || upstream.status === 'error' || upstream.status === 'skipped') {
          blocked = true;
          break;
        }
        inputs[port.id] = upstream.outputs[edge.from.port] ?? null;
        hashParts.push(`${port.id}=w:${upstream.hash}:${edge.from.port}`);
      }

      if (blocked) {
        results.set(nodeId, { status: 'skipped', hash: '', outputs: {} });
        stats.skipped++;
        continue;
      }

      // A suppressed feature does not happen. What went into it comes out of
      // it, so everything built on it goes on standing — on the body as it was
      // before this feature touched it. Nothing is computed and nothing is
      // cached: the value handed on is the one upstream already owns, and
      // giving it a second owner is how a shape gets disposed of twice.
      if (node.suppressed === true) {
        const through = passThroughOf(graph, nodeId);
        if (through === null) {
          // Nothing of the kind it makes goes in, so there is nothing to hand
          // on: an extrude held back produces no solid at all.
          results.set(nodeId, { status: 'skipped', hash: '', outputs: {} });
          stats.skipped++;
          continue;
        }

        const outputs: Record<PortId, Value> = { [through.output]: inputs[through.input] ?? null };
        // Its dimensions are still worth reading — a held-back fillet still
        // says what radius it would round at.
        for (const port of echoed) outputs[port.id] = inputs[port.echoes!] ?? null;

        // Distinct from the same node unsuppressed, so downstream keys apart.
        results.set(nodeId, {
          status: 'suppressed',
          hash: hash64(`${hashParts.join('|')}|suppressed`),
          outputs,
        });
        stats.suppressed++;
        continue;
      }

      const hash = hash64(hashParts.join('|'));
      const entry = this.cache.get(hash);

      if (entry !== undefined) {
        if (entry.error !== null) {
          results.set(nodeId, { status: 'error', hash, outputs: {}, error: entry.error });
          stats.errored++;
        } else {
          results.set(nodeId, { status: 'cached', hash, outputs: entry.outputs ?? {} });
          stats.cached++;
        }
        continue;
      }

      try {
        const outputs = definition.evaluate(inputs);
        for (const port of echoed) outputs[port.id] = inputs[port.echoes!] ?? null;
        this.cache.set(hash, { outputs, error: null });
        results.set(nodeId, { status: 'evaluated', hash, outputs });
        stats.evaluated++;
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown.message : String(thrown);
        this.cache.set(hash, { outputs: null, error });
        results.set(nodeId, { status: 'error', hash, outputs: {}, error });
        stats.errored++;
      }
    }

    return { results, order, stats };
  }
}
