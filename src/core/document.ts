import type { SerializedGraph } from './graph.js';

export const DOCUMENT_FORMAT = 'wirecad';
export const DOCUMENT_VERSION = 1;

export interface WireCadDocument {
  format: typeof DOCUMENT_FORMAT;
  version: number;
  savedAt: string;
  graph: SerializedGraph;
}

export function serializeDocument(graph: SerializedGraph): WireCadDocument {
  return {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    savedAt: new Date().toISOString(),
    graph,
  };
}

/** Parse a saved document, refusing anything this build cannot faithfully load. */
export function parseDocument(text: string): SerializedGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('That file does not contain a document');
  }

  const document = parsed as Partial<WireCadDocument>;
  if (document.format !== DOCUMENT_FORMAT) {
    throw new Error('That file was not saved by wireCAD');
  }
  if (document.version !== DOCUMENT_VERSION) {
    throw new Error(
      `Document version ${String(document.version)} is not supported by this build (expected ${DOCUMENT_VERSION})`,
    );
  }

  const graph = document.graph;
  if (
    typeof graph !== 'object' ||
    graph === null ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    throw new Error('That document is missing its graph');
  }

  return graph;
}

export function documentToText(graph: SerializedGraph): string {
  return JSON.stringify(serializeDocument(graph), null, 2);
}
