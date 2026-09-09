# Original crouch ceiling query

Source recorded before translation: DeusExPlayer.PlayerWalking.ProcessMove
3425–3465. If bIsCrouching OR the incoming bForceDuck, call SetBasedPawnSize with
default radius and height16. Then form checkpoint.Z with two script float stores:
Location.Z-CollisionHeight, then +2*GetDefaultCollisionHeight. Trace from Location
to checkpoint using [CollisionRadius,CollisionRadius,1] and bTraceActors=true.
The returned Actor determines bCantStandUp and the new bForceDuck. Otherwise
ResetBasedPawnSize executes (when not leaning) and bCantStandUp remains false.
The existing bForceDuck is therefore consumed before being replaced. A clear
query on key release can keep the crouched size for one call before reset.

Original Actor.execTrace103e3330 parses output vectors, End, optional Start
(default caller.Location), optional bTraceActors (default bCollideActors), and
Extent (default zero). It calls SingleLineCheck with source=self, extra0 and
flags6 when bTraceActors=false or flags55 (0x37) when true, at103e347e–103e3501.
Thus its generic-actor blocking filter differs from TraceActors' raw iterator.
It returns the selected Actor and copies the output vectors even on a clear
controlled result. The wrapper needs original entry-to-return capture before
the ProcessMove ceiling query is connected.

Twenty-four original entry-to-return captures now match `scriptTrace` exactly,
covering explicit/default start and extent, both bCollideActors defaults,
explicit false/true bTraceActors and clear/blocked controlled results. Original
native argument evaluation and SingleLineCheck are controlled callback boundaries;
the flag selection, source passing and result copying execute original code.
The comparison is reproducible with `node scripts/validate-native-script-trace.mjs`.

Play now uses `updateCrouch` for this source-derived ProcessMove branch and
`scriptTrace` for its original native query contract. Full generic ProcessMove,
leaning, inventory and multiplayer behavior remain outside this adapter. The
previous target-volume overlap shortcut and cylinder-height-derived force flag
are no longer used for compiled maps.
