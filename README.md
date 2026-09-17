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
  groups are *Create* (Extrude), *Combine* (Cut, Union, Intersect), *Modify*
  (Fillet, Chamfer, Shell) and *Construct* (XY/XZ/YZ datum planes, Offset
  Plane). Each button opens a dialog.
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
- **Files** — *New*, *Open* (Ctrl+O) and *Save* (Ctrl+S) work on a `.json`
  document containing the whole graph. The document also autosaves to browser
  storage as you work, so a refresh resumes where you left off rather than
  reopening the starter model. *New* is an ordinary edit, so Ctrl+Z brings the
  previous model back.
- **Fillet** rounds the edges you pick, at one radius, and **Chamfer** bevels
  them at one distance. Press either, then click edges in the 3D view — they
  light up as you hover and turn blue once taken; clicking a picked edge again
  drops it. Both read the same Edge Selection node, so a set picked for one can
  be rewired into the other. Picking nothing and wiring a solid straight into
  the node still takes every edge, which is what these nodes did before
  selections existed. **Shell** hollows it to
  a wall thickness, leaving open whichever face you click — the opening is
  stored as the same normal-and-rank reference a face plane uses, so it survives
  the model changing underneath it.
- **Filleting before shelling** is the usual order for a moulded part, and it
  works: the wall stays uniform through the corners and each inner radius comes
  out as the outer radius minus the wall. The one rule is that every fillet
  radius has to be larger than the wall thickness, since an inner radius of zero
  or less has nowhere to go. Shell says so rather than guessing when it cannot.
- **Export** — *STL* writes a binary mesh for printing, *STEP* writes the actual
  B-rep for other CAD tools, both in millimetres. Exports cover the selected
  body, or every visible body when nothing is selected; sketches are excluded.

When the kernel refuses an operation the node says so and the rest of the model
stays cached, so it is cheap to adjust a radius and try again.
- **Viewport** — orbit with the left mouse button, zoom with the wheel, click a
  body to select it. Edge picking only ever hits solids, so a profile lying in
  the same place cannot swallow a click meant for the body underneath it.
- **Showing and hiding** — a result that something downstream consumes steps out
  of the way, so extruding a profile takes the profile off screen and leaves the
  body. The ◉ on a node's header overrides that either way, and the glyph shows
  what is actually being drawn rather than what was asked for. The setting is
  part of the document, so it saves and undoes with everything else.
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
| `npm run verify:shell` | Builds fillet-and-shell bodies in Chromium and checks the hollowed volumes |
| `npm run verify:edges` | Checks per-edge fillet selection, and that a selection survives a resize |

Both `verify:` scripts need `npm run dev` already running. Set `CHROMIUM_PATH`
if Playwright's bundled browser is not available.

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

## Hollowing a filleted body

Shell has two implementations, and which one runs depends on the input.

The first is the kernel's own `BRepOffsetAPI_MakeThickSolid`, one call that
hollows a solid and drops the chosen face. It gives the cleanest topology, and
on an unfilleted body it is what runs.

It cannot run on a filleted body in this build. OpenCASCADE's offset algorithm
uses C++ exceptions for internal control flow, and `opencascade.js` compiles the
kernel with exception catching disabled — `make.py` has the
`DISABLE_EXCEPTION_CATCHING=0` flag commented out — so the throw lands in a
runtime that cannot dispatch it and the call dies with `___cxa_can_catch is not
defined` or `wasmTable.get(...) is not a function`. Every fillet-then-shell
combination fails this way: both join types, radii from 1 to 5 mm, walls from 1
to 2 mm, tolerances from 1e-6 to 1e-2. The 2.0 beta behaves identically. This is
a property of the published WebAssembly build rather than of OpenCASCADE, which
is why other applications on the same kernel hollow filleted parts routinely.

So when the first path fails, Shell models the hollow instead:

1. offset the body inward by the wall thickness, giving the cavity;
2. subtract the cavity from the body;
3. sweep the cavity's own opening face back out by the wall thickness and
   subtract that, which removes the wall over the opening and nothing else.

Every step is a boolean or a plain offset, and those survive the missing
exception runtime. The wall is uniform by construction, since the cavity *is*
the body offset inward.

Two measured details make this safe. `MakeOffsetShape` returns a bare
`TopoDS_Shell` rather than a solid on filleted input, and a boolean against a
shell reports not-done instead of raising, so the shell is wrapped and
re-oriented before use. And when the wall is at least as thick as the smallest
fillet radius — where the inner radius would be zero or negative — the offset
still reports success while returning several disconnected open shells enclosing
no volume. Nothing raises; the result is silently empty. Shell checks for a
single closed shell of positive volume and refuses with a reason instead.

`npm run verify:shell` pins this down against the real kernel: it builds each
case, measures the hollowed volume from the triangulation and checks it against
the solid it came from, so a path that quietly returns the unhollowed body or an
empty shape fails the run.

## Referring to an edge

Edges have the same naming problem faces do, and a worse version of it: there is
no normal to sort them by. A stored selection holds, per edge, the midpoint by
arc length, the chord direction, and the length — but the midpoint is kept as a
*fraction of the body's bounding box* rather than in millimetres.

That is what makes a selection survive editing. Widening a 60 mm box to 80 mm
moves the midpoint of every vertical edge, so an absolute position would go
looking in the wrong place; the fraction does not move at all. Matching then
takes the nearest candidate in that fractional space, after discarding any whose
chord points a different way, and refuses rather than guessing when the nearest
is still too far. `npm run verify:edges` holds this to account: it fillets four
vertical edges, then widens and heightens the body underneath the selection and
checks the volume against what those four rounded corners should leave.

The selection lives in its own `Edge Selection` node, so the set is visible in
the graph and can be rewired into another operation later rather than being
buried in the fillet.

## Known gaps

- A sketch cannot be reopened and redrawn; its points are editable on the node,
  but there is no "edit sketch" mode yet.
- Profiles are single closed loops, so a shape with a hole in it needs a boolean
  rather than an inner loop.

- No sketch constraint solver; sketches are parametric rectangles and circles.
- One radius per Fillet node and one distance per Chamfer node. Varying the
  amount across edges means a second node, rather than a list of groups in one
  dialog. Chamfers are symmetric; there is no two-distance or distance-and-angle
  form yet.
- No draft, sweep, loft, or patterns yet.
- Feature dialogs do not preview: nothing changes until you press Create.
- The kernel's own failure reasons do not survive this WebAssembly build, so a
  refused operation reports the likely cause rather than what OpenCASCADE said.
  The same missing piece — `opencascade.js` compiles OpenCASCADE with C++
  exception catching turned off — is why Shell carries a second implementation:
  see *Hollowing a filleted body* below.
- The bundled kernel is the full OpenCASCADE build (14 MB gzipped). A trimmed
  custom build would cut first-load cost substantially.
- Geometry is verified in the browser rather than in the unit suite, because the
  kernel's Emscripten glue cannot be loaded from an ES module under Node.
