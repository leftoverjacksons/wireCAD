# wireCAD

A parametric CAD experiment: the feature history is a node-and-wire graph, and
the graph and the CAD interface are two views of one document. Build with the
toolbar and the wire diagram records what you did; rewire the diagram and the
model follows.

## Running it

Requires Node 22 (or 20.19+). The first install downloads the OpenCASCADE
kernel, which is a 66 MB WebAssembly build, so expect it to take a minute.

```sh
npm install
npm run dev
```

Then open the URL Vite prints (by default <http://localhost:5173>).

The kernel compiles in the browser on first load — the sidebar reports when it
is ready, typically around two seconds.

## Using it

- **Toolbar** — a **Sketch** tab (Rectangle, Circle) and a **Solid** tab, whose
  groups are *Create* (Extrude), *Combine* (Cut, Union, Intersect) and
  *Construct* (XY/XZ/YZ datum planes, Offset Plane). Each button opens a dialog.
  Operands are chosen by clicking a body or sketch in the 3D view, by clicking a
  node in the graph, or from the dropdown. Selecting something before pressing a
  button pre-fills the first operand.
- **Planes** — sketches sit on a plane rather than at a world Z offset, and an
  extrude follows its profile's normal. A rectangle drawn on the XZ plane
  extrudes along −Y. Sketch dimensions are in the plane's own U/V axes.
- **Sketching on a face** — start a sketch, then click a flat face of a solid in
  the 3D view. That creates a `Face Plane` node holding the reference, and the
  sketch rides the face when the model changes underneath it.
- **Sketch mode** — *Create Sketch* asks for a plane or a face, then aligns the
  camera to it, dims everything else and gives you Line, Rectangle and Circle.
  Points snap to a 1 mm grid. A polyline closes by clicking its first point or
  pressing Enter; Escape cancels and creates nothing. Finishing emits a profile
  node already wired to its plane.
- **Undo** — Ctrl+Z and Ctrl+Shift+Z, or the toolbar buttons. A slider drag is
  one undo step.
- **Viewport** — orbit with the left mouse button, zoom with the wheel, click a
  body to select it.
- **Node editor** — drag the background to pan, wheel to zoom, drag a node by its
  header. Drag between ports to wire them; drag away from a connected input to
  detach it; click a wire to cut it. Unwired numeric inputs are editable in
  place. Delete removes the selected node.
- **Sidebar sliders** — drive the same ports the node editor exposes, so moving
  one updates the other.

Each node header is tinted by what the last solve did with it: orange for
recomputed, blue for served from cache, red for failed.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm test` | Graph and evaluator unit tests |
| `npm run typecheck` | TypeScript, no emit |
| `npm run build` | Production build |
| `npm run verify:browser` | Drives a running dev server in Chromium and reports solve statistics |

`verify:browser` needs `npm run dev` already running. Set `CHROMIUM_PATH` if
Playwright's bundled browser is not available.

## How it is put together

```
src/core/      graph document, node registry, content-addressed evaluator
src/geometry/  OpenCASCADE loading, tessellation, shape disposal
src/nodes/     node definitions (arithmetic, sketches, solids)
src/worker/    kernel + evaluator in a Web Worker, mesh transfer protocol
src/ui/        node editor canvas, CAD feature dialogs, layout
```

The graph is the only source of truth. Evaluation is content-addressed rather
than dirty-flagged: a node's cache key hashes its type, its unwired literal
inputs, and the hashes of its upstream producers. Node identity, position and
label are excluded, so moving nodes around costs nothing and structurally
identical subgraphs share results. Editing a parameter recomputes only its
downstream cone.

The kernel, the graph replica and the evaluator all live in a Web Worker. The
main thread posts the whole document on every change — affordable precisely
because unchanged nodes are a hash lookup — and gets back per-node status plus
tessellated meshes as transferred buffers.

## Referring to a face

Naming a face so it survives a rebuild is the topological naming problem: face
ordering is not stable across kernel rebuilds, so "face 7" silently becomes a
different face the moment the model changes.

A `Face Plane` node stores a reference direction and a rank instead, and
re-resolves on every solve: among the planar faces pointing that way, take the
n-th counting from the furthest along the normal. The top of a box stays the top
of a box when the box is resized, and a boss added on top takes rank 0 while the
original top becomes rank 1 rather than being confused with it.

Two properties matter more than the heuristic itself. The reference is an
ordinary node with ordinary numeric inputs, so a wrong match is visible in the
graph and can be corrected by editing a field. And when nothing matches, the
node fails loudly — `Rank 5 is out of range: only 1 face(s) face that way` —
instead of quietly attaching to whatever face happens to be there.

The stronger approach is to name faces by provenance, using the kernel's own
`Modified`/`Generated` history to track which operation produced which face.
That can replace the matching rule without changing the graph.

## Known gaps

- No sketch constraint solver; sketches are parametric rectangles and circles.
- No fillet, chamfer, sweep, loft, or patterns yet.
- The bundled kernel is the full OpenCASCADE build (14 MB gzipped). A trimmed
  custom build would cut first-load cost substantially.
- Geometry is verified in the browser rather than in the unit suite, because the
  kernel's Emscripten glue cannot be loaded from an ES module under Node.
