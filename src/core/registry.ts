import type { NodeDefinition, PortDef, PortId } from './types.js';

export class NodeRegistry {
  private definitions = new Map<string, NodeDefinition>();

  register(definition: NodeDefinition): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`Node type already registered: ${definition.type}`);
    }
    this.definitions.set(definition.type, definition);
  }

  registerAll(definitions: readonly NodeDefinition[]): void {
    for (const definition of definitions) this.register(definition);
  }

  get(type: string): NodeDefinition | undefined {
    return this.definitions.get(type);
  }

  require(type: string): NodeDefinition {
    const definition = this.definitions.get(type);
    if (definition === undefined) throw new Error(`Unknown node type: ${type}`);
    return definition;
  }

  inputPort(type: string, portId: PortId): PortDef | undefined {
    return this.require(type).inputs.find((p) => p.id === portId);
  }

  outputPort(type: string, portId: PortId): PortDef | undefined {
    return this.require(type).outputs.find((p) => p.id === portId);
  }

  list(): NodeDefinition[] {
    return [...this.definitions.values()];
  }

  byCategory(): Map<string, NodeDefinition[]> {
    const grouped = new Map<string, NodeDefinition[]>();
    for (const definition of this.definitions.values()) {
      const bucket = grouped.get(definition.category);
      if (bucket) bucket.push(definition);
      else grouped.set(definition.category, [definition]);
    }
    return grouped;
  }
}
