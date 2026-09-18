# Working on wireCAD

Things you would otherwise learn the hard way. This is a briefing, not a
journal: keep it short, edit it in place, and let `git log` be the history.
Design reasoning for work spanning several changes goes in `docs/`; the
architecture is in `README.md`.

## Prove it before you say it

- `npm test` — the unit suite. `npm run typecheck` — no emit, strict.
- The browser suites need a dev server already running and Chromium's path:

  ```
  npm run dev &
  CHROMIUM_PATH=/opt/pw-browsers/chromium npm run verify:browser
  ```

  There are twelve: `browser shell edges profile extrude links constraints
  preview ghost drag glyphs datums`. They take about four minutes together and
  they are the only thing that actually tests geometry, because the kernel is
  WebAssembly and does not run in the unit suite.
- Anything about the interface is claimed only after looking at a screenshot.
  Assertions pass on things that look wrong.
- When a test click misses, suspect the test before the code. Several "bugs"
  here were clicks landing on the toolbar or the sketch panel. Check with
  `document.elementFromPoint` and fail loudly rather than silently missing.
- The toolbar floats over the top of the viewport, and the node editor takes the
  bottom half. Useful canvas is smaller than the canvas.

## The kernel lies quietly

`opencascade.js` is compiled with C++ exception catching turned **off**.

- A failed operation does not throw. It returns something wrong. Check the
  result; never infer success from the absence of an error.
- Listed in `Supported APIs.md` does not mean bound, or bound the way you would
  guess. Probe it in the browser before building on it.
- `First()` is `First_1()`, and the reference it hands back is freed by
  `RemoveFirst()`. Take a `Reversed()` copy to keep a shape past that.
- `TopTools_ListIteratorOfListOfShape` is unbound — empty the list instead.
- `BRepPrimAPI_MakeBox_2` takes four arguments, not the obvious two.

## Invariants worth not breaking

- **Wire orientation.** An outer loop runs anticlockwise and a hole runs
  clockwise. Get it wrong and OCCT builds a face that is silently wrong — the
  bug that cost the most here was a 7% volume error with nothing reported.
- **Component dimensions are signed.** `horizontalDistance` and
  `verticalDistance` measure `b - a`, so order the ends to make the number
  positive; reversed, applying it turns the geometry back to front.
- **A drawing asserts only what it shows.** An edge drawn flat is horizontal;
  its length is never assumed. A fresh sketch is honestly under-constrained.
- **Topological naming.** Faces are found by normal and rank, edges by
  bounding-box fraction, direction and length. Translation preserves both, which
  is why Move is safe mid-chain; rotation would not be.
- **Pixels are converted at draw time.** Arrowheads, relation marks and an
  unplaced dimension's standoff are given in pixels and turned into millimetres
  using what a pixel is currently worth. Anything that changes that — a zoom —
  has to redraw them, or they silently become model-sized.
- **The camera's matrices are stale until something draws.** Call
  `updateMatrixWorld()` before projecting or raycasting, or you measure against
  the view before last.

## Style

- Comments say **why**, never what. Test names are sentences about behaviour.
- Commit messages are written to be read: what changed, why, and the bugs found
  on the way, including ones older than the change.
- Report what happened. A failing test is reported with its output; a skipped
  step is named as skipped.

## Working with the branch

- Branch from `main`, merge promptly, delete the branch after.
- Do not run two sessions against the same files at once. Two edits to
  `src/viewport.ts` on different branches is how a quiet afternoon ends.
- If the branch falls behind, merge `main` in and re-run the suites.
