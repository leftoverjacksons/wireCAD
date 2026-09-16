import { describe, expect, it } from 'vitest';
import { Evaluator } from '../core/evaluator.js';
import { Graph } from '../core/graph.js';
import { NodeRegistry } from '../core/registry.js';
import { planeNodes } from '../nodes/plane.js';
import {
  WORLD_XY,
  WORLD_XZ,
  WORLD_YZ,
  dot,
  length,
  makePlane,
  offsetPlane,
  planeYAxis,
  pointOnPlane,
  vec3,
} from './plane.js';

function close(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
}

describe('plane', () => {
  it('normalises the normal', () => {
    const plane = makePlane(vec3(0, 0, 0), vec3(0, 0, 7));
    close(length(plane.normal), 1);
    close(plane.normal.z, 1);
  });

  it('forces the x-axis into the plane', () => {
    const plane = makePlane(vec3(0, 0, 0), vec3(0, 0, 1), vec3(1, 0, 5));
    close(dot(plane.normal, plane.xAxis), 0);
    close(length(plane.xAxis), 1);
  });

  it('derives an x-axis when the requested one is parallel to the normal', () => {
    const plane = makePlane(vec3(0, 0, 0), vec3(0, 0, 1), vec3(0, 0, 3));
    close(dot(plane.normal, plane.xAxis), 0);
    close(length(plane.xAxis), 1);
  });

  it('keeps the frame right-handed', () => {
    for (const plane of [WORLD_XY, WORLD_XZ, WORLD_YZ]) {
      const y = planeYAxis(plane);
      close(length(y), 1);
      close(dot(y, plane.normal), 0);
      close(dot(y, plane.xAxis), 0);
    }
  });

  it('places in-plane coordinates in world space', () => {
    expect(pointOnPlane(WORLD_XY, 3, 4)).toEqual({ x: 3, y: 4, z: 0 });

    const onXZ = pointOnPlane(WORLD_XZ, 3, 4);
    close(onXZ.x, 3);
    close(onXZ.y, 0);
    close(onXZ.z, 4);

    const onYZ = pointOnPlane(WORLD_YZ, 3, 4);
    close(onYZ.x, 0);
    close(onYZ.y, 3);
    close(onYZ.z, 4);
  });

  it('offsets along the normal without rotating the frame', () => {
    const shifted = offsetPlane(WORLD_XY, -2);
    expect(shifted.origin).toEqual({ x: 0, y: 0, z: -2 });
    expect(shifted.normal).toEqual(WORLD_XY.normal);
    expect(shifted.xAxis).toEqual(WORLD_XY.xAxis);
    expect(pointOnPlane(shifted, 1, 1)).toEqual({ x: 1, y: 1, z: -2 });
  });

  it('evaluates datum and offset plane nodes through the graph', () => {
    const registry = new NodeRegistry();
    registry.registerAll(planeNodes);
    const graph = new Graph(registry);
    const evaluator = new Evaluator(registry);

    const base = graph.addNode('plane.xy');
    const offset = graph.addNode('plane.offset', { inputs: { distance: 12 } });
    graph.connect({ node: base.id, port: 'plane' }, { node: offset.id, port: 'plane' });

    const result = evaluator.evaluate(graph);

    expect(result.results.get(offset.id)?.outputs.plane).toEqual({
      kind: 'plane',
      origin: { x: 0, y: 0, z: 12 },
      normal: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 },
    });
  });

  it('treats a moved plane as a change, so dependents recompute', () => {
    const registry = new NodeRegistry();
    registry.registerAll(planeNodes);
    const graph = new Graph(registry);
    const evaluator = new Evaluator(registry);

    const base = graph.addNode('plane.xy');
    const offset = graph.addNode('plane.offset', { inputs: { distance: 5 } });
    graph.connect({ node: base.id, port: 'plane' }, { node: offset.id, port: 'plane' });

    evaluator.evaluate(graph);
    graph.setInput(offset.id, 'distance', 6);
    const second = evaluator.evaluate(graph);

    expect(second.stats.evaluated).toBe(1);
    expect(second.stats.cached).toBe(1);
  });
});
