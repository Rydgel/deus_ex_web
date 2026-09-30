# Spawned actors' live Touching slots

The original `Actor.Touching[4]` is the native array at actor offsets
`+0xe8..+0xf4`. Script reads and native collision/destruction read the same
four actor pointers. There is no separate script snapshot for actors created
by `Spawn`.

The behavior contract comes from the installed Engine package and DLL,
before changing the host adapter:

* `Engine.Actor` declares the four-element actor array. Its linked object
  property is checked against `+0xe8` in the focused validator.
* `AddTouch` reads each slot at `0x103696c1`, stores the other actor at
  `0x10369827`, dispatches `Touch` at `0x1036984d`, then compares the same
  slot at `0x10369853`. Thus a script-visible write during `Touch` must
  influence whether `BeginTouch` dispatches the reciprocal event.
* `EndTouch` (`0x10369970`) clears the matching slot before dispatching
  `UnTouch`. The reciprocal clear/event still happens when its own event is
  suppressed. The existing recovered contract and original oracle are in
  [CheckEncroachment and Touch](check-encroachment.md).
* `ULevel::DestroyActor` reads these four slots for each current actor at
  `0x10395f59..0x10395f79`, then calls `target.EndTouch(other, 1)`. See
  [DestroyActor's live relationship scan](script-destroy.md).

Before the correction, `installActorCollisionView` created a separate
JavaScript `touching` array. Native movement changed that array while
scripts and DestroyActor read the unchanged object-image `Touching` field.
The Island fish and Training carcass comparison in
[the Rust migration notes](rust-core.md#touching-comparison-september-30)
demonstrated the divergence.

The correction makes the spawned collision view's four array entries read
and write the existing script storage. It retains actor identities, fixed
slot order, synchronous callback visibility, and the original touch helpers.
It does not change map-actor bindings or touch admission/eviction policy.
Reading through the storage accessor each time also avoids retaining a
detached buffer when the object arena grows.

## Focused verification

`node scripts/validate-script-spawn-touching.mjs` captures six focused cases
with the existing original-DLL oracle, then runs them through collision
views using installed `Fish` and `UNATCOTroopCarcass` classes. Event order,
callback-visible script slots, and final slots match the original: new and
duplicate touches, cancellation during `Touch`, both end slots, and
suppressed self notification. The validator also checks both accessor modes,
object-image pointer cells, a retained array across arena growth, and the
DestroyActor survivor's `UnTouch`/clear. The old adapter fails on the first
native `Touch`: host slot 3 contains the other actor while the script slot
is null. Twelve existing collision/touch/destruction regression tests pass.

The 360-tick simulation comparison reads every live host array after every
level tick. Script/host mismatches decrease from 222 to zero in Training and
from 22 to zero on Island. Remaining image-only differences belong to bound
map/controlled-player fields, outside this correction. `scriptView` also
marks the controlled player, so the older comparison labels those image-only
player differences as “spawned.” There are no simulation errors.

Training's 30 checkpoints are unchanged (`c8eebff5786adf55` at the end),
including agreement between the JavaScript VM and checked Rust VM. Island's
final digest remains `b767a7e417fe5968`; its checkpoint at 230 timed ticks
(290 including warmup) changes from `f3e00aa11be77a7e` to
`60b2ab212dffc3d9`. Independent hashes of all 680,723 property
reads at that checkpoint differ only for `Fish12.Touching` and
`Fish16.Touching`: the fourth slots now contain each other. The other 29
checkpoints remain unchanged. JavaScript and checked Rust agree on all 30
corrected checkpoints in both maps. This is the expected fidelity correction,
not a representation-only digest change.

Training's unchanged digest has a different cause. Original
`ScriptedPawn.Dying` calls `SpawnCarcass()` immediately followed by
`Destroy()` (installed source lines 13877–13878). A focused runtime trace
confirms that `UNATCOTroopCarcass0` contains `UNATCOTroop2` in host/script
slot 3 on entry to that troop's DestroyActor; both are empty on return,
and the troop is marked deleted. The old host-only list retained the dead
troop for the remaining 222 ticks, while its script field already read
empty. Correct destruction now clears the live reference, so the script
digest remains empty for the right reason. These simulation comparisons
identify translation regressions; they do not independently establish
original-game fidelity.

Local captures and reports remain under `reports/movement/script-spawn-touching`
and `.work/touching-*`, outside Git. This correction adds no new contact
policy or whole-level native fidelity claim; arbitrary script event bodies
and existing map/player image mirrors retain their previous evidence scope.
