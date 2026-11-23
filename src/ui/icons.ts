/**
 * The toolbar's icons, each a small drawing of what its feature does — and,
 * while the pointer is on it, a few seconds of the feature doing it.
 *
 * An icon at rest shows the result, because that is what has to be recognised
 * at a glance. The motion is for the person who does not yet know the word:
 * hovering Fillet shows a sharp edge turning round, which "fillet" alone does
 * not say to anyone who has not used a CAD program.
 *
 * Everything is drawn through one isometric projection, so every solid sits
 * under the same camera as the others and as the viewport's opening view.
 * The motion is SMIL declared inside each drawing and started by
 * `attachIconMotion`; that keeps an icon one self-contained string, with no
 * per-icon script to keep in step with it.
 */

type P = readonly [number, number];
type V = readonly [number, number, number];

/** Pixels per model unit, and where the model origin lands, in a 64 × 52 box. */
const S = 11;
const CX = 32;
const CY = 32;
const COS30 = Math.sqrt(3) / 2;

function iso([x, y, z]: V): P {
  return [CX + (x - y) * COS30 * S, CY + (x + y) * 0.5 * S - z * S];
}

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

function pts(points: readonly V[]): string {
  return points
    .map(iso)
    .map(([a, b]) => `${fmt(a)},${fmt(b)}`)
    .join(' ');
}

/** A path through model points: `M` for the first, `L` for the rest, closed. */
function path(points: readonly V[]): string {
  return (
    points
      .map(iso)
      .map(([a, b], index) => `${index === 0 ? 'M' : 'L'}${fmt(a)} ${fmt(b)}`)
      .join(' ') + ' Z'
  );
}

/** One loop of an animation: from the start, to the result, a pause, and back. */
const LOOP = {
  dur: '2.8s',
  keyTimes: '0;0.38;0.78;1',
  keySplines: '0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1',
};

/**
 * An animated attribute. Its resting value is the result, so whatever the
 * animation is doing when the pointer leaves, letting go of it leaves the icon
 * saying what the feature makes.
 */
function animate(attribute: string, from: string, to: string): string {
  return (
    `<animate attributeName="${attribute}" values="${from};${to};${to};${from}" ` +
    `keyTimes="${LOOP.keyTimes}" keySplines="${LOOP.keySplines}" calcMode="spline" ` +
    `dur="${LOOP.dur}" begin="indefinite" repeatCount="indefinite"/>`
  );
}

function animateTranslate(from: P, to: P): string {
  const a = `${fmt(from[0])},${fmt(from[1])}`;
  const b = `${fmt(to[0])},${fmt(to[1])}`;
  return (
    `<animateTransform attributeName="transform" type="translate" values="${a};${b};${b};${a}" ` +
    `keyTimes="${LOOP.keyTimes}" keySplines="${LOOP.keySplines}" calcMode="spline" ` +
    `dur="${LOOP.dur}" begin="indefinite" repeatCount="indefinite"/>`
  );
}

/** The three faces of a box the camera sees: top, and the two facing it. */
interface Box {
  top: V[];
  left: V[];
  right: V[];
}

function box([x, y, z]: V, [dx, dy, dz]: V): Box {
  const X = x + dx;
  const Y = y + dy;
  const Z = z + dz;
  return {
    top: [
      [x, y, Z],
      [X, y, Z],
      [X, Y, Z],
      [x, Y, Z],
    ],
    left: [
      [x, Y, z],
      [X, Y, z],
      [X, Y, Z],
      [x, Y, Z],
    ],
    right: [
      [X, y, z],
      [X, Y, z],
      [X, Y, Z],
      [X, y, Z],
    ],
  };
}

/** A solid box, optionally growing from `from` to `to` while hovered. */
function solid(to: Box, from?: Box, extra = ''): string {
  const face = (name: keyof Box, cls: string): string => {
    const motion = from === undefined ? '' : animate('points', pts(from[name]), pts(to[name]));
    return `<polygon class="${cls}" points="${pts(to[name])}">${motion}</polygon>`;
  };
  return `<g ${extra}>${face('left', 'ic-front')}${face('right', 'ic-side')}${face('top', 'ic-top')}</g>`;
}

/** An arrowhead at `tip`, pointing away from `tail`. */
function arrow(tail: P, tip: P, cls = 'ic-arrow'): string {
  const dx = tip[0] - tail[0];
  const dy = tip[1] - tail[1];
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const back: P = [tip[0] - ux * 5, tip[1] - uy * 5];
  const left: P = [back[0] - uy * 3, back[1] + ux * 3];
  const right: P = [back[0] + uy * 3, back[1] - ux * 3];
  return (
    `<line class="${cls}" x1="${fmt(tail[0])}" y1="${fmt(tail[1])}" x2="${fmt(back[0])}" y2="${fmt(back[1])}"/>` +
    `<polygon class="${cls}-head" points="${fmt(tip[0])},${fmt(tip[1])} ${fmt(left[0])},${fmt(left[1])} ${fmt(right[0])},${fmt(right[1])}"/>`
  );
}

/** A flat sheet in the ground plane: where a sketch lives. */
function ground(half = 1.7): string {
  return `<polygon class="ic-plane" points="${pts([
    [-half, -half, 0],
    [half, -half, 0],
    [half, half, 0],
    [-half, half, 0],
  ])}"/>`;
}

// ---------------------------------------------------------------- the icons

function extrude(): string {
  const base: V = [-1.1, -1.1, 0];
  const size: V = [2.2, 2.2, 1.3];
  const flat: V = [2.2, 2.2, 0.01];
  const guides = [
    [-1.1, 1.1],
    [1.1, 1.1],
    [1.1, -1.1],
  ]
    .map(([x, y]) => {
      const [a, b] = iso([x!, y!, 0]);
      const [, top] = iso([x!, y!, size[2]]);
      return `<line class="ic-guide" x1="${fmt(a)}" y1="${fmt(b)}" x2="${fmt(a)}" y2="${fmt(top)}"/>`;
    })
    .join('');
  const sketch = `<polygon class="ic-sketch" points="${pts(box(base, flat).top)}"/>`;
  const tail = iso([0, 0, 1.3]);
  const tip = iso([0, 0, 2.6]);
  return (
    sketch +
    guides +
    solid(box(base, size), box(base, flat)) +
    `<g>${arrow(tail, tip)}${animateTranslate([0, 10], [0, 0])}</g>`
  );
}

/** The edge that a fillet or a chamfer works on: front, along X, at the top. */
const EDGE = { x: -1.2, y: -1.0, z: 0, X: 1.2, Y: 1.0, Z: 1.5 };

function fillet(): string {
  const { x, y, z, X, Y, Z } = EDGE;
  const k = 0.5523;
  const shape = (r: number) => {
    const at = (p: V) => iso(p).map(fmt).join(' ');
    // The right face's outline, with its top-front corner rounded by r.
    const right =
      `M${at([X, y, z])} L${at([X, Y, z])} L${at([X, Y, Z - r])} ` +
      `C${at([X, Y, Z - r + k * r])} ${at([X, Y - r + k * r, Z])} ${at([X, Y - r, Z])} ` +
      `L${at([X, y, Z])} Z`;
    // The rounding itself, running the length of the edge.
    const strip =
      `M${at([x, Y, Z - r])} L${at([X, Y, Z - r])} ` +
      `C${at([X, Y, Z - r + k * r])} ${at([X, Y - r + k * r, Z])} ${at([X, Y - r, Z])} ` +
      `L${at([x, Y - r, Z])} ` +
      `C${at([x, Y - r + k * r, Z])} ${at([x, Y, Z - r + k * r])} ${at([x, Y, Z - r])} Z`;
    const top = pts([
      [x, y, Z],
      [X, y, Z],
      [X, Y - r, Z],
      [x, Y - r, Z],
    ]);
    const left = pts([
      [x, Y, z],
      [X, Y, z],
      [X, Y, Z - r],
      [x, Y, Z - r],
    ]);
    return { right, strip, top, left };
  };
  const sharp = shape(0);
  const round = shape(0.75);
  return (
    `<polygon class="ic-front" points="${round.left}">${animate('points', sharp.left, round.left)}</polygon>` +
    `<path class="ic-side" d="${round.right}">${animate('d', sharp.right, round.right)}</path>` +
    `<polygon class="ic-top" points="${round.top}">${animate('points', sharp.top, round.top)}</polygon>` +
    `<path class="ic-feature" d="${round.strip}">${animate('d', sharp.strip, round.strip)}</path>`
  );
}

function chamfer(): string {
  const { x, y, z, X, Y, Z } = EDGE;
  const shape = (r: number) => ({
    left: pts([
      [x, Y, z],
      [X, Y, z],
      [X, Y, Z - r],
      [x, Y, Z - r],
    ]),
    right: pts([
      [X, y, z],
      [X, Y, z],
      [X, Y, Z - r],
      [X, Y - r, Z],
      [X, y, Z],
    ]),
    top: pts([
      [x, y, Z],
      [X, y, Z],
      [X, Y - r, Z],
      [x, Y - r, Z],
    ]),
    bevel: pts([
      [x, Y, Z - r],
      [X, Y, Z - r],
      [X, Y - r, Z],
      [x, Y - r, Z],
    ]),
  });
  const sharp = shape(0);
  const cut = shape(0.75);
  const face = (cls: string, key: keyof typeof cut) =>
    `<polygon class="${cls}" points="${cut[key]}">${animate('points', sharp[key], cut[key])}</polygon>`;
  return face('ic-front', 'left') + face('ic-side', 'right') + face('ic-top', 'top') + face('ic-feature', 'bevel');
}

function shell(): string {
  const outer = box([-1.2, -1.2, 0], [2.4, 2.4, 1.4]);
  const w = 0.35;
  const Z = 1.4;
  const depth = 1.1;
  // The opening, inset evenly; at an inset of half the box it is a point.
  const opening = (inset: number): V[] => [
    [-1.2 + inset, -1.2 + inset, Z],
    [1.2 - inset, -1.2 + inset, Z],
    [1.2 - inset, 1.2 - inset, Z],
    [-1.2 + inset, 1.2 - inset, Z],
  ];
  const hole = opening(w);
  const closed = opening(1.2);
  // The inside of the far two walls, which is what an open box shows of itself.
  const wall = (d: number) => ({
    back: pts([
      [-1.2 + w, -1.2 + w, Z],
      [1.2 - w, -1.2 + w, Z],
      [1.2 - w, -1.2 + w, Z - d],
      [-1.2 + w, -1.2 + w, Z - d],
    ]),
    side: pts([
      [-1.2 + w, -1.2 + w, Z],
      [-1.2 + w, 1.2 - w, Z],
      [-1.2 + w, 1.2 - w, Z - d],
      [-1.2 + w, -1.2 + w, Z - d],
    ]),
  });
  const shallow = wall(0);
  const deep = wall(depth);
  return (
    solid(outer) +
    `<polygon class="ic-cavity" points="${pts(hole)}">${animate('points', pts(closed), pts(hole))}</polygon>` +
    `<polygon class="ic-inner" points="${deep.back}">${animate('points', shallow.back, deep.back)}</polygon>` +
    `<polygon class="ic-inner-dim" points="${deep.side}">${animate('points', shallow.side, deep.side)}</polygon>` +
    `<polygon class="ic-rim" points="${pts(hole)}">${animate('points', pts(closed), pts(hole))}</polygon>`
  );
}

function move(): string {
  const origin = iso([0, 0, 0.6]);
  const axes =
    arrow(origin, iso([2.3, 0, 0.6])) + arrow(origin, iso([0, 2.3, 0.6])) + arrow(origin, iso([0, 0, 2.6]));
  const cube = solid(box([-0.6, -0.6, 0], [1.2, 1.2, 1.2]));
  const up = iso([0, 0, 1.2]);
  return (
    axes +
    `<g>${cube}<animateTransform attributeName="transform" type="translate" ` +
    `values="0,0;0,${fmt(up[1] - origin[1] - 0)};0,0;${fmt(iso([1, 0, 0])[0] - CX)},${fmt(iso([1, 0, 0])[1] - CY)};0,0" ` +
    `keyTimes="0;0.25;0.5;0.75;1" dur="3.2s" begin="indefinite" repeatCount="indefinite"/></g>`
  );
}

function cut(): string {
  const block = solid(box([-1.4, -0.6, 0], [2.4, 1.8, 1.3]));
  const tool = box([-0.2, 0.1, 0.4], [1.2, 1.6, 1.2]);
  const outline = (b: Box) =>
    `<polygon class="ic-tool" points="${pts(b.left)}"/><polygon class="ic-tool" points="${pts(b.right)}"/>` +
    `<polygon class="ic-tool" points="${pts(b.top)}"/>`;
  const away = iso([0, 1.5, 0]);
  return (
    block +
    `<g>${outline(tool)}${animateTranslate([away[0] - CX, away[1] - CY], [0, 0])}</g>`
  );
}

function union(): string {
  const a = solid(box([-1.6, -0.6, 0], [1.6, 1.2, 1.2]));
  const b = solid(box([0, -0.6, 0], [1.4, 1.2, 1.6]), undefined, 'class="ic-joined"');
  const apart = iso([0.9, 0, 0]);
  return (
    `<g>${a}${animateTranslate([-(apart[0] - CX), -(apart[1] - CY)], [0, 0])}</g>` +
    `<g>${b}${animateTranslate([apart[0] - CX, apart[1] - CY], [0, 0])}</g>`
  );
}

function intersect(): string {
  const a = box([-1.6, -0.8, 0], [2, 1.6, 1.3]);
  const b = box([-0.4, -1.2, 0.3], [2, 1.6, 1.4]);
  const common = box([-0.4, -0.8, 0.3], [0.8, 1.2, 1.0]);
  const ghost = (x: Box) =>
    `<polygon class="ic-ghost" points="${pts(x.left)}"/><polygon class="ic-ghost" points="${pts(x.right)}"/>` +
    `<polygon class="ic-ghost" points="${pts(x.top)}"/>`;
  return (
    `<g>${ghost(a)}${ghost(b)}${animate('opacity', '1', '0.25')}</g>` +
    `<g class="ic-glow">${solid(common, undefined, 'class="ic-result"')}${animate('opacity', '0.35', '1')}</g>`
  );
}

/** A square sheet on one of the three origin planes, sweeping out from one edge. */
function datum(corners: (t: number) => V[], axes: Array<[V, V]>): string {
  const lines = axes.map(([a, b]) => arrow(iso(a), iso(b), 'ic-axis')).join('');
  const full = corners(1);
  const edge = corners(0.02);
  // The grid is drawn at rest and fades in as the sheet arrives.
  const grid = [0.33, 0.66]
    .map((f) => {
      const [p0, p1, p2, p3] = full;
      const mix = (a: V, b: V): V => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      const one = [mix(p0!, p1!), mix(p3!, p2!)];
      const two = [mix(p0!, p3!), mix(p1!, p2!)];
      return [one, two]
        .map(([u, v]) => {
          const [a, b] = iso(u!);
          const [c, d] = iso(v!);
          return `<line class="ic-grid" x1="${fmt(a)}" y1="${fmt(b)}" x2="${fmt(c)}" y2="${fmt(d)}"/>`;
        })
        .join('');
    })
    .join('');
  return (
    lines +
    `<polygon class="ic-sheet" points="${pts(full)}">${animate('points', pts(edge), pts(full))}</polygon>` +
    `<g>${grid}${animate('opacity', '0', '1')}</g>`
  );
}

function planeXY(): string {
  return datum(
    (t) => [
      [-1.2, -1.2, 0],
      [1.2, -1.2, 0],
      [1.2, -1.2 + 2.4 * t, 0],
      [-1.2, -1.2 + 2.4 * t, 0],
    ],
    [
      [[-1.2, 1.2, 0], [1.9, 1.2, 0]],
      [[-1.2, 1.2, 0], [-1.2, -1.9, 0]],
    ],
  );
}

function planeXZ(): string {
  return datum(
    (t) => [
      [-1.2, 0, 0],
      [1.2, 0, 0],
      [1.2, 0, 2.4 * t],
      [-1.2, 0, 2.4 * t],
    ],
    [
      [[-1.2, 0, 0], [1.9, 0, 0]],
      [[-1.2, 0, 0], [-1.2, 0, 3]],
    ],
  );
}

function planeYZ(): string {
  return datum(
    (t) => [
      [0, -1.2, 0],
      [0, 1.2, 0],
      [0, 1.2, 2.4 * t],
      [0, -1.2, 2.4 * t],
    ],
    [
      [[0, -1.2, 0], [0, 1.9, 0]],
      [[0, -1.2, 0], [0, -1.2, 3]],
    ],
  );
}

function offsetPlane(): string {
  const sheet = (z: number): V[] => [
    [-1.3, -1.3, z],
    [1.3, -1.3, z],
    [1.3, 1.3, z],
    [-1.3, 1.3, z],
  ];
  const lift = iso([0, 0, 1.6]);
  const from = iso([0, 0, 0]);
  return (
    `<polygon class="ic-plane" points="${pts(sheet(-0.3))}"/>` +
    `<g>${arrow(iso([0, 0, 0.1]), iso([0, 0, 1.2]))}${animate('opacity', '0', '1')}</g>` +
    `<g><polygon class="ic-sheet" points="${pts(sheet(1.3))}"/>` +
    animateTranslate([0, from[1] - lift[1]], [0, 0]) +
    `</g>`
  );
}

function createSketch(): string {
  const outline: V[] = [
    [-0.9, -0.9, 0],
    [0.9, -0.9, 0],
    [0.9, 0.4, 0],
    [0.1, 1.0, 0],
    [-0.9, 0.6, 0],
  ];
  const d = path(outline);
  return (
    ground() +
    `<path class="ic-stroke" pathLength="100" stroke-dasharray="100" stroke-dashoffset="0" d="${d}">` +
    `${animate('stroke-dashoffset', '100', '0')}</path>` +
    outline
      .map(iso)
      .map(([a, b]) => `<circle class="ic-vertex" cx="${fmt(a)}" cy="${fmt(b)}" r="1.4"/>`)
      .join('')
  );
}

function editSketch(): string {
  const at = (u: number): V[] => [
    [-1, -1, 0],
    [1, -1, 0],
    [1 + u, 1 + u, 0],
    [-1, 1, 0],
  ];
  const still = at(0);
  const pulled = at(0.45);
  const [hx, hy] = iso(pulled[2]!);
  const [sx, sy] = iso(still[2]!);
  return (
    ground() +
    `<polygon class="ic-stroke" points="${pts(pulled)}">${animate('points', pts(still), pts(pulled))}</polygon>` +
    `<circle class="ic-handle" cx="${fmt(hx)}" cy="${fmt(hy)}" r="2.4">` +
    `${animate('cx', fmt(sx), fmt(hx))}${animate('cy', fmt(sy), fmt(hy))}</circle>`
  );
}

function rectangle(): string {
  const corner: V = [-1.1, -1.1, 0];
  const rect = (u: number, v: number): V[] => [
    corner,
    [corner[0] + u, corner[1], 0],
    [corner[0] + u, corner[1] + v, 0],
    [corner[0], corner[1] + v, 0],
  ];
  const full = rect(2.2, 2.2);
  const start = rect(0.05, 0.05);
  const [fx, fy] = iso(full[2]!);
  const [sx, sy] = iso(start[2]!);
  return (
    ground() +
    `<polygon class="ic-stroke ic-fill" points="${pts(full)}">${animate('points', pts(start), pts(full))}</polygon>` +
    `<circle class="ic-vertex" cx="${fmt(iso(corner)[0])}" cy="${fmt(iso(corner)[1])}" r="1.6"/>` +
    `<circle class="ic-handle" cx="${fmt(fx)}" cy="${fmt(fy)}" r="2">` +
    `${animate('cx', fmt(sx), fmt(fx))}${animate('cy', fmt(sy), fmt(fy))}</circle>`
  );
}

function circle(): string {
  // A circle on the ground plane is, through this camera, an ellipse with its
  // long axis level: √(3/2) wide and √(1/2) tall per unit of radius.
  const [cx, cy] = iso([0, 0, 0]);
  const r = 1.2;
  const rx = r * S * Math.sqrt(1.5);
  const ry = r * S * Math.SQRT1_2;
  return (
    ground() +
    `<ellipse class="ic-stroke ic-fill" cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(rx)}" ry="${fmt(ry)}">` +
    `${animate('rx', '0.5', fmt(rx))}${animate('ry', '0.3', fmt(ry))}</ellipse>` +
    `<line class="ic-radius" x1="${fmt(cx)}" y1="${fmt(cy)}" x2="${fmt(cx + rx)}" y2="${fmt(cy)}">` +
    `${animate('x2', fmt(cx + 0.5), fmt(cx + rx))}</line>` +
    `<circle class="ic-vertex" cx="${fmt(cx)}" cy="${fmt(cy)}" r="1.6"/>`
  );
}

const DRAWINGS: Record<string, () => string> = {
  sketch: createSketch,
  'edit-sketch': editSketch,
  rectangle,
  circle,
  extrude,
  fillet,
  chamfer,
  shell,
  move,
  cut,
  union,
  intersect,
  xy: planeXY,
  xz: planeXZ,
  yz: planeYZ,
  offset: offsetPlane,
};

/** The icon for a toolbar feature, or null for one that has none yet. */
export function featureIcon(featureId: string): SVGSVGElement | null {
  const draw = DRAWINGS[featureId];
  if (draw === undefined) return null;
  return svg(draw(), 'feature-icon');
}

function svg(body: string, className: string, viewBox = '0 0 64 52'): SVGSVGElement {
  const holder = document.createElement('div');
  holder.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" class="${className}" ` +
    `aria-hidden="true" focusable="false">${body}</svg>`;
  return holder.firstElementChild as SVGSVGElement;
}

// ------------------------------------------------------------ small glyphs

/**
 * The file actions' glyphs. These are commands rather than operations on the
 * model, so they are drawn as the line icons people already know for them, and
 * they do not move.
 */
const GLYPHS: Record<string, string> = {
  new: '<path d="M5 2h6l4 4v12H5z"/><path d="M11 2v4h4"/><path d="M10 9v6M7 12h6"/>',
  open: '<path d="M2 6h6l2 2h8v9H2z"/><path d="M2 6V4h5l2 2"/>',
  save: '<path d="M3 3h11l3 3v11H3z"/><path d="M6 3v5h7V3"/><path d="M6 17v-5h8v5"/>',
  export: '<path d="M10 3v10"/><path d="M6 9l4 4 4-4"/><path d="M3 15v2h14v-2"/>',
  undo: '<path d="M7 5L3 9l4 4"/><path d="M3 9h9a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M13 5l4 4-4 4"/><path d="M17 9H8a5 5 0 0 0 0 10h3"/>',
};

export function actionGlyph(name: keyof typeof GLYPHS | string): SVGSVGElement | null {
  const body = GLYPHS[name];
  if (body === undefined) return null;
  return svg(body, 'action-glyph', '0 0 20 20');
}

/** The mark in the sidebar's header: a wireframe cube in a hexagon. */
export function brandMark(): SVGSVGElement {
  return svg(
    '<path class="brand-hex" d="M20 2l16 9v18l-16 9L4 29V11z"/>' +
      '<path class="brand-cube" d="M20 10l9 5v10l-9 5-9-5V15z"/>' +
      '<path class="brand-cube" d="M11 15l9 5 9-5M20 20v10"/>',
    'brand-mark',
    '0 0 40 40',
  );
}

// ------------------------------------------------------------------ motion

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Plays an icon's motion while the pointer or the keyboard is on its button,
 * and lets go of it when they leave — which puts the icon back at rest, since
 * every animation's resting value is the result. Someone who has asked their
 * system for less motion gets the resting icon and nothing else.
 */
export function attachIconMotion(button: HTMLElement): void {
  const animations = (): SVGAnimationElement[] => [
    ...button.querySelectorAll<SVGAnimationElement>('animate, animateTransform'),
  ];

  const start = (): void => {
    if (reducedMotion()) return;
    for (const animation of animations()) {
      try {
        animation.beginElement();
      } catch {
        // An icon that cannot move is still an icon.
      }
    }
  };
  const stop = (): void => {
    for (const animation of animations()) {
      try {
        animation.endElement();
      } catch {
        // Nothing was running.
      }
    }
  };

  button.addEventListener('pointerenter', start);
  button.addEventListener('pointerleave', stop);
  // Keyboard focus only. A click focuses the button too, and its icon would
  // then go on moving for as long as the dialog it opened stayed up.
  button.addEventListener('focus', () => {
    if (button.matches(':focus-visible')) start();
  });
  button.addEventListener('blur', stop);
}
