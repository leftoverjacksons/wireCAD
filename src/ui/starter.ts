import type { Graph } from '../core/graph.js';
import { autoLayout } from './layout.js';

/** The model a fresh install opens with: a bored block, fully parametric. */
export function buildStarterModel(graph: Graph): void {
  const width = graph.addNode('math.number', { label: 'Width', inputs: { value: 60 } });
  const depth = graph.addNode('math.number', { label: 'Depth', inputs: { value: 40 } });
  const height = graph.addNode('math.number', { label: 'Height', inputs: { value: 20 } });
  const boreRadius = graph.addNode('math.number', { label: 'Bore radius', inputs: { value: 8 } });

  const centreX = graph.addNode('math.divide', { label: 'Centre X', inputs: { b: 2 } });
  const centreY = graph.addNode('math.divide', { label: 'Centre Y', inputs: { b: 2 } });
  const boreDepth = graph.addNode('math.add', { label: 'Bore depth', inputs: { b: 4 } });

  const basePlane = graph.addNode('plane.xy', { label: 'Base plane' });
  const borePlane = graph.addNode('plane.offset', {
    label: 'Bore plane',
    inputs: { distance: -2 },
  });

  const bodyProfile = graph.addNode('sketch.rectangle', { label: 'Body profile' });
  const body = graph.addNode('solid.extrude', { label: 'Body' });
  const boreProfile = graph.addNode('sketch.circle', { label: 'Bore profile' });
  const bore = graph.addNode('solid.extrude', { label: 'Bore' });
  const result = graph.addNode('solid.cut', { label: 'Result' });

  graph.connect({ node: basePlane.id, port: 'plane' }, { node: borePlane.id, port: 'plane' });
  graph.connect({ node: basePlane.id, port: 'plane' }, { node: bodyProfile.id, port: 'plane' });
  graph.connect({ node: borePlane.id, port: 'plane' }, { node: boreProfile.id, port: 'plane' });

  graph.connect({ node: width.id, port: 'result' }, { node: bodyProfile.id, port: 'width' });
  graph.connect({ node: depth.id, port: 'result' }, { node: bodyProfile.id, port: 'height' });
  graph.connect({ node: bodyProfile.id, port: 'profile' }, { node: body.id, port: 'profile' });
  graph.connect({ node: height.id, port: 'result' }, { node: body.id, port: 'distance' });

  graph.connect({ node: width.id, port: 'result' }, { node: centreX.id, port: 'a' });
  graph.connect({ node: depth.id, port: 'result' }, { node: centreY.id, port: 'a' });
  graph.connect({ node: centreX.id, port: 'result' }, { node: boreProfile.id, port: 'u' });
  graph.connect({ node: centreY.id, port: 'result' }, { node: boreProfile.id, port: 'v' });
  graph.connect({ node: boreRadius.id, port: 'result' }, { node: boreProfile.id, port: 'radius' });

  graph.connect({ node: height.id, port: 'result' }, { node: boreDepth.id, port: 'a' });
  graph.connect({ node: boreProfile.id, port: 'profile' }, { node: bore.id, port: 'profile' });
  graph.connect({ node: boreDepth.id, port: 'result' }, { node: bore.id, port: 'distance' });

  graph.connect({ node: body.id, port: 'solid' }, { node: result.id, port: 'base' });
  graph.connect({ node: bore.id, port: 'solid' }, { node: result.id, port: 'tool' });

  autoLayout(graph);
}
