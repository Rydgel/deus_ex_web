# Scrollbar manager child removal

Contract recorded before translation from installed Extension.dll (SHA-256
93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c),
XScaleManagerWindow::ChildRemoved at 0x10042480–0x10042542.

The body captures the removed child in EDI, then calls ProcessScript with
ChildRemoved, a one-pointer parameter block and third argument zero. After the
script returns it compares that captured pointer with the live fields in order:
first button +14c, second button +150, scale +158, value window +154. It clears
only the first matching field and returns. Aliased fields are not all cleared.
Script changes to the manager fields affect the comparisons; rewriting the
parameter block does not change EDI. Null is compared normally. No parent
reconfiguration or other callback follows. Native exception unwinding is outside
this normal-return translation.

Before host wiring, compare full receiver and child images plus ordered script
calls against the original DLL for each slot, unrelated/null children, aliasing,
and callback mutations of both the receiver and the argument block. This is one
cleanup callback; ScrollArea descendant removal and full family destruction
remain separate unsupported boundaries.

## Verified delivery

Ten complete original-DLL normal-return comparisons pass. They compare every
byte of the manager and both child images and the ProcessScript event, receiver,
child parameter and third argument. The original executes unchanged machine
code; only ProcessScript is supplied as a mutation-capable service.

The host now routes ScaleManager's ChildRemoved virtual to this translation.
The Training medical-screen integration dispatches that virtual on its actual
constructed vertical manager, verifies removal of its first-button and scale
references, and preserves the unrelated second button. This is an isolated
notification check, not a successful full-screen destruction: ScrollArea's
DescendantRemoved still rejects dispatch, and the bot Frob still stops at its
existing Actor.PlaySound boundary.

Reproduce: `node scripts/validate-window-scroll-removal.mjs`,
`node scripts/validate-window-baseline-play.mjs`, and `npm run build`.
Both bot integration routes and the production build pass (the existing bundle
size warning remains). No full validator sweep was needed for this slice.
No visual equivalence, full cleanup or Stage 3 completion is claimed.

## Next slice: ScrollArea descendant removal

Contract recorded before translation from the same hash-pinned Extension.dll:
XScrollAreaWindow::DescendantRemoved at 0x10043980–0x10043a42. It compares the
argument with +14c, +150, +154, +158, +15c, +160, +164, +168 and +16c, in that
order. The first match is cleared and the function returns immediately; aliases
in later slots remain. Unrelated pointers cause no writes, and null is compared
normally. There is no ProcessScript call, inherited callback, reconfiguration,
or child dereference anywhere in this body.

Original reference cases will cover all nine slots, aliases, unrelated children,
and null with and without a matching slot, comparing full images and absence of
script calls before admission to the host. Full recursive family destruction
remains outside this notification-only slice.

The ScrollArea follow-up now passes 13 original-DLL comparisons (23 total with
ScaleManager), including all nine reference slots and the null/alias cases.
The host routes this native override directly, before its generic script bridge.
The Training medical-screen fixture verifies that removing its up button and
vertical scale clears the corresponding area references, preserves the down
button, manager and clip, and executes no script event. These direct virtual
notifications do not claim full tree unlink/destruction. Bot audio and remaining
scrolling/input/destructor boundaries are unchanged.

Follow-up verification: both bot integration routes, the production build and
`git diff --check` pass; the build retains its existing bundle-size warning.
No full sweep was run for this bounded callback addition.
