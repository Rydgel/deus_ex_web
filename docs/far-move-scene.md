# Composed original FarMoveActor evidence

This validation composes original Engine FarMoveActor10398ba0 with
FindSpot10398480, CheckEncroachment1039a350, the shared original collision hash,
world/owned-model/primitive point and line queries, and original Touch internals.
It uses the previously established contracts in relocation.md,
check-encroachment.md, level-points.md, and encroachment-query.md.

The controlled source is a healthy PlayerPawn cylinder registered after the
saved level actors. Its actor flags include bMovable, collision flags are15,
and its original GetPlayerPawn control pointer is nonnull. Tests reset its pose,
height and touch slots between cases through original RemoveActor/AddActor.
No child is based on it. Script dispatch is an explicit boundary: EncroachingOn
returns the case's named rejection result; the other event bodies have no
side effects. SetActorZone is an explicit callback boundary. This is native
collision and relocation evidence, not script/zone behavior acceptance.

Before comparing translation, capture originals with
`node scripts/validate-native-far-move-scene.mjs --capture-only`.
Reports remain ignored under `reports/movement/native-far-move-scene/`.

The corpus contains 40 cases (20 per map), captured before adding the JavaScript
comparison. All 40 match exactly. There are 26 accepted and 14 rejected results.
Standing and crouched destinations include real mover-area placement probes,
failed world fits, two actual Pawn locations per map with both acceptance and
rejection replies, and explicit test/noCheck branches. Liberty's accepted
ThugMale5 relocation also touches DataLinkTrigger15; both reciprocal lists and
the Touch-before-EncroachedBy order match.

The JavaScript side composes `farMoveActor`, `findSpot`, `createLevelQueries`
(including original point recovery), `checkPlayerEncroachment`, and the shared
Touch helpers. One live hash is reused through source removal, queries,
commit/rejection, and source registration. The native side imports the existing
NativeEncroachment/NativeLevel harnesses without changing them, supplies the
original FarMove/FindSpot/CheckEncroachment entry points in the level vtable, and
runs their original native callees. Both sides reset the same controlled pawn
between cases. Original actor class ancestry and brush transforms come from the
existing scene fixtures; the source is explicitly controlled PlayerPawn.

Compared outputs are the success boolean, exact float32 current/old locations,
motion flags, ordered removal/fitting/encroachment/script/addition/zone calls,
and all nonempty reciprocal Touching arrays. Both scene and case SHA256 are
checked before capture reuse. Binary hashes include Engine/Core/CRT.

Reproduce the comparison:

```sh
node scripts/validate-native-far-move-scene.mjs --capture-only
node scripts/validate-native-far-move-scene.mjs --reuse
```

This establishes the bounded composed geometry/registration/callback-order
cases. It does not establish actual DataLink, damage, zone transition, actor
creation/destruction, based-child script effects, or unrestricted FarMove
acceptance across both maps. The controlled EncroachingOn acceptance is an
explicit test reply, not a claim about the target actor's original script body.
