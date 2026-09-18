# Editing the chain

Notes on a piece of work that spans several changes: right-click menus, moving a
body, editing a feature that already exists, and looking at the model as it was
at some earlier node. They are one undertaking because they all need the same
thing underneath, and because the obvious way to build each of them separately
is wrong in the same way.

Status is marked per piece at the bottom. Everything above it is reasoning, and
is the part worth reading before changing any of this.

## Appending and splicing are the same operation

A feature built today is *appended*: it reads what is already there and becomes
the new end of the chain. Two things people expect of a modeller need more:

- **Moving a body other features are built on.** The move has to happen before
  those features, not after them.
- **Deleting a feature from the middle** without losing what came after it.

Both are the same operation from either side — putting a node onto a wire that
already carries something, or taking one off. The general form is

> put `inserted` between `existing` and everything that was reading it

and appending is that with no consumers. `spliceAfter` in `src/core/rewire.ts`
is exactly this, and at the end of a chain it degenerates to an ordinary
connect. There is no separate append path to keep in step with it.

The reverse is `removeAndHeal`: take a node out and join what it was reading to
what was reading it. Whether that is possible is a question about ports, not
about intent — a fillet takes a solid and hands one on, so a solid *passes
through* it and the body it was rounding can stand in its place; an extrude
takes a sketch and hands on a solid, so nothing passes through, and what was
reading the extrude is left wanting an input. That is the truth about what
happened, and the menu should say so rather than refusing the delete.

Where a node has more than one input of the right type, the first one wins.
Schemas list what a feature works *on* before what it works *with* — a cut
names its target before its tool — so the thing being modified is the thing
that passes through. That is a convention the schemas have to keep.

## Moving a body: two different operations

Appending a move at the **end** of a chain moves the final body, and there is
nothing downstream to disturb. Splicing one **into the middle** is a different
model, and the difference is sharper than "everything after it moves":

- **At the end:** the whole thing shifts, bores and fillets and all, as if you
  picked it up.
- **Before the bore:** the block shifts and the bore stays where the sketch on
  the XY plane puts it — the block has moved relative to its own features.

Both are wanted. The first is far commoner and needs none of this machinery.

Translation is the one transform that leaves our topological naming alone:
edges are matched by bounding-box fraction and faces by normal and rank, and a
rigid translation preserves both. Rotation would not be so kind, and wants its
own thinking.

## There is no terminator node

"Delete this" means four different things, and each already has a shape:

1. **Delete the node** — the feature never happened. A document edit.
2. **Hide the result** — a view state. `Graph.setVisibility` and the eye.
3. **Suppress the feature** — it stays, greyed, passing its input through
   untouched. Not built yet; nearly free once the pass-through above exists.
4. **Subtract material** — a cut, a defeature. Not a deletion at all: a new node
   that happens to take material away.

What the viewport draws is already "nodes whose geometry nothing consumes".
That is the terminator, implicitly. A body disappears when nothing produces it
any more, or when it is told not to be drawn. Adding a node to mean "stop here"
would be a fifth spelling of something the graph already says.

## Rolling back is a question of what to draw, not what to recompute

In a history modeller the model *is* a list of operations and the past has to be
replayed to be seen. Here every node's output is a value that already exists
after a solve: evaluation is content-addressed, so the block before the bore did
not stop existing when the bore was cut. The whole history is present at once.

So "roll back to node N" is not recomputation. It is one addition to the rule
the worker already uses to decide what to show — *a node is drawn unless
something downstream consumes its geometry to make geometry* — namely: when
rolled back to N, everything downstream of N is treated as absent. The cone can
be skipped by the evaluator too, so rolling back is cheaper than not.

The thing that genuinely is a graph edit, rather than a view, is **inserting at
a past point**. That is the splice again.

One consequence worth keeping: because this is a graph rather than a list,
"the state at N" is exact and per-branch, and "everything after N" is a cone
rather than a suffix. The time metaphor is borrowed from a tool that works
differently, and it should not be taken too literally in the interface.

## Editing a feature that already exists

Reopening a feature's dialog needs three separable things, and only the first is
really about the dialog:

- The dialog gains an **edit mode**: open on a node, load its current values,
  change them live — the preview machinery already watches values change —
  and commit, or restore on cancel. No nodes are created, so there is no
  cleanup to get wrong.
- Editing a node **rolls the view back** to it, so what is on screen is what
  that feature made rather than what came after.
- Because the cone is a display question and not a rebuild, the nodes that
  depend on it can be drawn faintly at the same time. You see what you are
  changing *and* what it will disturb, which a timeline cannot show you.

## The pieces

| # | Piece | Needs | Status |
|---|-------|-------|--------|
| 1 | `spliceAfter`, `removeAndHeal`, `branchOf` — pure graph operations | — | **done** |
| 2 | Node editor context menu: delete (heal or branch), rename, hide, suppress, edit | 1 | |
| 3 | `solid.move` node and a three-axis drag gizmo | 1 for the mid-chain case | |
| 4 | Editing an existing feature through its dialog | — | |
| 5 | Rolling the view back to a node; new features splice at the marker | 1, 4 | |
| 6 | Viewport context menu, scoped to face and body | 2, 3 | |

Piece 6 wants `BRepAlgoAPI_Defeaturing` for *delete face*, which is listed as
supported in this build but has not been called yet. Several things that were
listed turned out to be unbound or differently shaped, so it gets probed before
anything is promised on top of it. *Delete face* means defeature — remove the
face and heal its neighbours together, leaving a solid — not punching a hole,
which would leave an open shell that cannot be booleaned or exported as a body.
