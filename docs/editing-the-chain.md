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
own thinking. `solid.move` is translation only for that reason, and the node
copies the shape it is given rather than transforming it in place: handing the
input's own handle back would give one shape two owners, and the second cache
entry to be evicted would free it twice.

## There is no terminator node

"Delete this" means four different things, and each already has a shape:

1. **Delete the node** — the feature never happened. A document edit.
2. **Hide the result** — a view state. `Graph.setVisibility` and the eye.
3. **Suppress the feature** — it stays, greyed, passing its input through
   untouched. Built on the pass-through above: the flag lives on the node, and
   the evaluator hands the input on instead of computing, so a held-back feature
   costs less than one that acts. It hands on a value its upstream already owns
   and caches nothing of its own, since a second owner of one shape is how a
   shape gets disposed of twice.
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
  cleanup to get wrong. *Built.* The other two below wait on piece 5, which is
  where a marker in the history comes from.
- Editing a node **rolls the view back** to it, so what is on screen is what
  that feature made rather than what came after.
- Because the cone is a display question and not a rebuild, the nodes that
  depend on it can be drawn faintly at the same time. You see what you are
  changing *and* what it will disturb, which a timeline cannot show you.

## The pieces

| # | Piece | Needs | Status |
|---|-------|-------|--------|
| 1 | `spliceAfter`, `removeAndHeal`, `branchOf` — pure graph operations | — | **done** |
| 2 | Node editor context menu: delete (heal or branch), rename, hide, suppress, edit | 1 | **done** |
| 3 | `solid.move` node and a three-axis drag gizmo | 1 for the mid-chain case | **done** |
| 4 | Editing an existing feature through its dialog | — | **done** |
| 5 | Rolling the view back to a node; new features splice at the marker | 1, 4 | |
| 6 | Viewport context menu, scoped to face and body | 2, 3 | |

Piece 2's *Edit* was an entry and a pair of callbacks rather than a feature of
its own, and piece 4 filled it in from behind exactly as expected: `canEdit`
learned a second answer and the menu did not change at all.

Piece 4 itself needed no new machinery in the dialog, only a second way in.
`openOn` loads the node's own values — its literal where it has one, the port's
default where it does not — which is also why Cancel needs no way to unset a
port: writing a default back as a literal says the same thing and hashes the
same. Changes go straight to the node, so there is no preview to build and
nothing to clean up, and the capture taken before the first change is forgotten
on Cancel, so an abandoned edit leaves no undo step.

What editing deliberately does not do is rewire. The operand rows show what the
feature is built on and offer nothing else: pointing a fillet at another body
means a new edge selection and moved wires, and the graph is where wires are
moved. Keeping "nothing is created" true is what makes cancelling exact.

What the menu says before it acts is the part worth keeping. `deleteOutcome` in
`src/ui/node-menu.ts` predicts what `removeAndHeal` will do — how many wires
find what the node was reading in its place, and how many are left wanting an
input — and the prediction is exact rather than a guess: a wire off the
pass-through output always reconnects, because the input it lands on is freed
by the removal itself. A test holds the two together, so a change to the healing
rule that the menu did not hear about fails rather than lies.

Piece 3 turned out to need no decision about which of the two moves was meant.
A feature spec can now say that it goes *into* the chain at its first operand
rather than onto the end of it — `splice` in `src/ui/features.ts`, which only
Move sets — and `buildFeature` calls `spliceAfter` instead of `connect` for that
one operand. Selecting the last body and selecting a body three features back
are then the same gesture, and the difference between picking the whole thing up
and shifting a block out from under its own bore is which body was pointed at.

The preview made the cancel path worth noticing. A preview is the real thing
standing in the graph already, so a move being set up has already taken the
bore off the block; removing that node on Cancel would leave the bore wanting a
target. Withdrawing a preview now heals rather than removes, which puts the
consumers back where they were, and for every other feature — appended, so with
no consumers of its own — healing is a plain removal.

The gizmo is three of the arrow the viewport already drew, not a thing of its
own: `setDragHandles` takes a list, and hit-testing picks the nearest head. Two
details are new. A number that starts at zero and may go either way has no
length to draw and nothing to grab, and three of them at once would put all
three heads on one point, so a handle can ask for a stalk — a fixed length out
from the origin, with its own distance added to that. And the arrows stay
anchored where the body was when the dialog opened, worked out once from the
first mesh that arrives, because a gizmo that follows the body moves the thing
you are holding while you hold it.

Piece 6 wants `BRepAlgoAPI_Defeaturing` for *delete face*, which is listed as
supported in this build but has not been called yet. Several things that were
listed turned out to be unbound or differently shaped, so it gets probed before
anything is promised on top of it. *Delete face* means defeature — remove the
face and heal its neighbours together, leaving a solid — not punching a hole,
which would leave an open shell that cannot be booleaned or exported as a body.
