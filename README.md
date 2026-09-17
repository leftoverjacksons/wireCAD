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

- **Toolbar** — a **Sketch** tab (Create Sketch, Edit Sketch, and parametric
  Rectangle and Circle) and a **Solid** tab, whose
  groups are *Create* (Extrude), *Combine* (Cut, Union, Intersect), *Modify*
  (Fillet, Chamfer, Shell) and *Construct* (XY/XZ/YZ datum planes, Offset
  Plane). Each button opens a dialog.
  Operands are chosen by clicking a body or sketch in the 3D view, by clicking a
  node in the graph, or from the dropdown. Selecting something before pressing a
  button pre-fills the first operand.
- **Extrude** — one node makes bodies and takes them away. *Operation* says what
  it does to the body wired into *Target*: **New body**, **Join**, **Cut** or
  **Intersect**. A bore is the same node as the block it goes through, pointed at
  it, so the starter model is four nodes rather than a block, a plug and a
  boolean. The *Combine* buttons are still there for putting two bodies that
  already exist together.
- **Planes** — sketches sit on a plane rather than at a world Z offset, and an
  extrude follows its profile's normal. A rectangle drawn on the XZ plane
  extrudes along −Y. Sketch dimensions are in the plane's own U/V axes.
- **Sketching on a face** — start a sketch, then click a flat face of a solid in
  the 3D view. That creates a `Face Plane` node holding the reference, and the
  sketch rides the face when the model changes underneath it.
- **Sketching** — *Create Sketch* asks for a plane or a face, aligns the camera
  to it, dims everything else and opens a session. It stays open until you press
  *Finish*: draw as many things as you like, constrain and dimension them as you
  go, in any order. The tools are Line, Rectangle, Circle and Point, with Select
  for picking what is already there. Points snap to a 1 mm grid, and a click
  landing on a point already drawn reuses it, which is how edges join. A line
  chain carries on until Enter or Escape ends it; clicking back on its first
  point closes it. Escape backs out one step at a time — the chain, then the
  tool, then the picks, then the session. Everything drawn is written to the
  node as it happens, so leaving is not what commits the work, and a sketch
  nobody drew in is removed rather than left behind reporting that it is empty.
- **Constraining and dimensioning** — with Select, click points and edges in the
  3D view, then apply a relation — Horizontal, Vertical, Parallel,
  Perpendicular, Equal, Coincident, Concentric, On line, Midpoint — or press
  *Dimension*, which reads what you picked: a line gives a length, a circle a
  radius, two points a distance, two lines an angle. *Delete* removes what is
  picked, along with every rule that referred to it. The panel says how many
  degrees of freedom are left, lists every rule with its number editable in
  place, and removes one with ×. A relation that would contradict what is
  already there is refused and rolled back rather than leaving the sketch in a
  state the solver cannot make sense of. Press *Edit Sketch* with a Sketch node
  selected to reopen the same session later.
- **What a drawing asserts** — only what it shows: an edge drawn flat is
  horizontal, one drawn upright is vertical, and points clicked on top of each
  other are the same point. Never a length. Inventing lengths would put
  contradictions in a sketch nobody asked to over-constrain, so a fresh drawing
  comes out under-constrained, which is what it honestly is, and the dimension
  tool is how it stops being.
- **Several outlines in one sketch** — a sketch is not one profile. Whatever it
  closes around becomes material and whatever is drawn inside that becomes a
  hole, as deep as you like: a ring drawn inside a hole is solid again. Two
  outlines side by side extrude into two bodies. Nesting decides which is which,
  not drawing order, so a plate with a bore is one sketch rather than a boolean.
- **Profiles are one node** — however complicated the shape, it is a single node
  carrying its own dimensions, named and listed: `originU`, `originV`, then
  whatever the dimension tool added, growing with the drawing. Each is an
  ordinary port, so it can be typed in, driven from a parameter node, or read by
  something else, and each defaults to the value it was drawn at.
- **Reading the graph** — every node says what it makes: Body, Profile, Plane,
  Edges or Value, on a badge in its header, with an accent bar and port colours
  from the same palette.
- **Dimensions are readable as well as writable** — every dimension a node holds
  is offered as an output too, so a bore's radius can drive the fillet that
  breaks its edge without a parameter node standing in between. Drag from the
  dimension on the right of one node to the dimension on the left of another.
- **Renaming** — double-click a node's name to change it. Clearing the field
  puts the type's own name back.
- **Dimensions live on their node** by default, in a field you can type into.
  Pulling one out to a Number node earns you a sidebar slider and lets two
  features share it, and the graph is there for that — but it is something you
  choose, not what drawing a box costs. Nothing in a new document is wired to a
  parameter.
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
| `npm run verify:profile` | Checks a profile's named dimensions drive its geometry, typed or wired |
| `npm run verify:extrude` | Checks an extrude cuts and intersects its target, and that a new document wires no parameters |
| `npm run verify:links` | Checks one node's dimension can drive another's, and that renaming sticks |
| `npm run verify:constraints` | Checks a constrained sketch solves to the size its dimensions ask for |

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

## Dimensions as outputs

Every numeric input a node has is also published as an output of the same name,
so one dimension can drive another directly. A node never restates these when it
evaluates: the output carries `echoes`, naming the input it repeats, and the
evaluator fills it in. That keeps the geometry code about geometry, and means a
node type gets this by being wrapped in `echoDimensions` rather than by
remembering to return its own inputs.

An echoed output sits on its input's own row, so a dimension always reads across
— Radius in on the left, Radius out on the right — however many other outputs
the node has. Echoes claim their rows first and the node's real outputs take
what is left, from the top; a row with nothing on one side stays empty rather
than closing up, because closing it up is exactly what would put a dimension
next to the wrong label.

## Solving a sketch

A `Sketch` node holds points, the lines and circles joining them, and the rules
those have to satisfy. The shape is whatever satisfies the rules, so the node's
dimensions are the handles: every dimension the sketch names becomes a port,
editable in place or driven from elsewhere, and the solver decides where the
geometry lands.

Constraints come in two kinds. Dimensions carry a number — distance, horizontal
or vertical distance, radius, angle, and locking a point's U or V. Relations
carry none — coincident, horizontal, vertical, parallel, perpendicular, equal,
concentric, point-on-line and midpoint.

The solver is least squares. Each constraint contributes residuals that are zero
when it holds, and Levenberg-Marquardt moves the points and radii until they all
are: Gauss-Newton where that converges, damped towards gradient descent where it
does not, which is what stops a half-drawn sketch flying apart on the first step.
Sketches are small, tens of unknowns, so the Jacobian is dense and built by
central differences — one extra pair of evaluations per unknown, in exchange for
not hand-differentiating every constraint, which is where a solver of this kind
usually goes quietly wrong.

Constraints leave directions free — "these two edges are equal" holds anywhere
along a bisector — and a solver is entitled to travel a long way down one of
them, which in practice means adding a relation throws the sketch across the
screen. Two things prevent it. Damping is uniform rather than scaled by each
diagonal, because an unknown no constraint touches has a zero diagonal and would
otherwise be left undamped and singular; damped evenly it simply stays put. And
solving runs twice: first with a weak pull towards where the sketch already was,
which picks the nearest solution out of those available, then without it, from a
starting point that has nowhere far left to go.

Row-reducing that same Jacobian answers two questions worth asking. Its rank
against the number of unknowns gives the degrees of freedom still loose, so a
sketch can say it is under-constrained; its rank against the number of residuals
gives the constraints that merely repeat others. A contradiction is a different
thing again, and is refused rather than approximated: if the residuals cannot be
driven to zero the node reports how far off it got instead of handing back a
shape that satisfies nothing.

## From a sketch to a face

A solved sketch is a set of points, not an outline, so the outline has to be
recovered. Lines are walked into closed loops, and each circle is a loop of its
own. The walk is only unambiguous if every point joins exactly two lines, so a
branch or a loose end is reported rather than guessed at — the alternative is
building whichever loop the walk happened to find first and calling it the
profile.

Which loop is material and which is a hole is decided by where they sit. A
loop's depth is how many other loops contain it, tested with a point on its own
boundary — its centre would not do, because the centre of the outer of two
circles about the same point lies inside the inner one too. Even depth bounds
material, odd takes it away, so a ring drawn inside a hole is solid again.
Disjoint outlines become separate faces, and extrude to separate bodies.

Orientation then has to be imposed rather than inherited. A face's outer wire
must run anticlockwise about its normal and its holes the other way, and how a
loop was drawn says nothing about which it is meant to be — you can trace a
rectangle either way round. Getting this wrong does not fail: OpenCASCADE builds
a face that is quietly wrong, and the error shows up as a body of the wrong
volume, several percent out, long after the fact. So each wire's signed area is
measured and the points are reversed to suit the part it plays.

## Ports a node grows for itself

Most node types have a fixed set of ports. A profile cannot: a drawn shape needs
one dimension per corner, and only the node knows how many corners it has. So a
type may declare `expand`, a pure function from the node's own stored inputs to
the extra ports it needs, and `graph.schemaOf(nodeId)` — not the registry — is
what everything reads ports from. The registry still only knows the type's fixed
ports; the node knows the rest.

Two consequences worth stating. A grown port's default is the value the shape
was drawn at, so overriding one corner is a genuine override rather than a
restatement of the whole shape, and the stored point list stays the single
record of what was drawn. And because the inputs decide which ports exist,
loading a document has to expand before it validates: a saved file carries
literals for grown ports, and rejecting them would have made any edited profile
unopenable.

## Known gaps

- Dimensions and constraints are listed in the panel, not drawn in the view:
  there are no dimension lines or constraint glyphs on the sketch itself.
- Sketch entities are lines and circles. No arcs, splines, or trimming, so a
  rounded outline is a fillet on the solid rather than in the sketch.
- Lines have to meet exactly two at a point. A sketch that branches or trails a
  loose end is reported rather than partly built.
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
