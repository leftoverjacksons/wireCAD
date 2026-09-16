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

- **Toolbar** — Rectangle, Circle, Extrude, Cut, Union, Intersect. Each opens a
  dialog. Operands are chosen by clicking a body or sketch in the 3D view, by
  clicking a node in the graph, or from the dropdown. Selecting something before
  pressing a button pre-fills the first operand.
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

## Known gaps

- **No undo.** Cutting a wire or deleting a node is currently irreversible.
- No sketch constraint solver; sketches are parametric rectangles and circles.
- No fillet, chamfer, sweep, loft, or patterns yet.
- The bundled kernel is the full OpenCASCADE build (14 MB gzipped). A trimmed
  custom build would cut first-load cost substantially.
- Geometry is verified in the browser rather than in the unit suite, because the
  kernel's Emscripten glue cannot be loaded from an ES module under Node.
