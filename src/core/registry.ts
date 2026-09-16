import type { NodeDefinition, NodeSchema, PortDef, PortId } from './types.js';

/** What the graph needs in order to validate wiring: ports, not implementations. */
export interface PortLookup {
  require(type: string): NodeSchema;
  inputPort(type: string, portId: PortId): PortDef | undefined;
  outputPort(type: string, portId: PortId): PortDef | undefined;
}

export class NodeRegistry<T extends NodeSchema = NodeDefinition> implements PortLookup {
  private definitions = new Map<string, T>();

  register(definition: T): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`Node type already registered: ${definition.type}`);
    }
    this.definitions.set(definition.type, definition);
  }

  registerAll(definitions: readonly T[]): void {
    for (const definition of definitions) this.register(definition);
  }

  get(type: string): T | undefined {
    return this.definitions.get(type);
  }

  require(type: string): T {
    const definition = this.definitions.get(type);
    if (definition === undefined) throw new Error(`Unknown node type: ${type}`);
    return definition;
  }

  inputPort(type: string, portId: PortId): PortDef | undefined {
    return this.require(type).inputs.find((port) => port.id === portId);
  }

  outputPort(type: string, portId: PortId): PortDef | undefined {
    return this.require(type).outputs.find((port) => port.id === portId);
  }

  list(): T[] {
    return [...this.definitions.values()];
  }

  byCategory(): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    for (const definition of this.definitions.values()) {
      const bucket = grouped.get(definition.category);
      if (bucket) bucket.push(definition);
      else grouped.set(definition.category, [definition]);
    }
    return grouped;
  }
}
