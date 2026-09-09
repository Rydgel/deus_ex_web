# Original ActorEncroachmentCheck: source contract before translation

Engine10358d50 (export thunk10301497, hash virtual+1c) swaps the queried actor's
Location/Rotation with the proposed values, computes GetActorExtent at that pose,
and scans the existing hash without removing/re-registering the actor. It
restores both pose fields before returning. Traversal is X/Y/Z, bucket links
latest-registration first, with tag and actor dedup checks.

After marking each candidate visited, skip a candidate whose Brush is nonnull,
whose class IsA(Brush), and whose bStatic (Actor+28 mask0x1) is false. Skip the
queried actor itself. For every other candidate, call the **queried actor's**
Brush/Mesh/fallback primitive PointCheck using queried actor as owner, candidate
Location as position, and candidate cylinder [Radius,Radius,Height] as extent.
Always pass extra0. This is not a point test against the candidate's primitive.

When overlap is reported, replace Actor with candidate, clear Primitive to null,
and **append** the44-byte result to the result list. This preserves visitation
order, unlike ActorPointCheck which prepends. No blocking, owner or based-on
filter occurs here. Those belong to CheckEncroachment/FarMove callers.

Relevant instructions: pose swap10358d9a–10358dff; GetActorExtent10358e0f;
candidate skip10358ee6–10358f20; narrowphase10358f26–10358fa0;
Actor/Primitive overwrite and append10358fa7–10358fd8; restoration/list terminator
10359007–10359042. Original captures are required before implementation.

## Delivered query and evidence

`actorEncroachmentCheck(hash,actor,position,rotation,extra=0)` from
`encroachment-query.mjs` returns ordered full hits with candidate Actor and null
Primitive. It uses `actor.collisionValues ?? actor.values`, original model or
cylinder primitive, and candidate `lineage` for Brush membership. `actorFlags`
provides the Actor+28 boolean word; absent that, candidate values.bStatic supplies
the explicitly decoded static flag. Extra is ignored as in the native call.

The proposed owner values are local to the query; actual actor fields and live
hash registrations remain unchanged after return. There are no externally
supplied callbacks that can observe this local implementation detail. Callers
must separately perform original remove/change/add when committing a movement.
The low-level hash method `actorEncroachmentCheck({bounds},primitiveCheck)` uses
GetActorExtent cell conversion and returns appended hits in visitation order.

`node scripts/validate-native-encroachment.mjs --capture-only` records original
results before comparison. `--reuse` verifies SHA256 inputs and compares full
ordered hits and restored position/rotation. **308 cases match exactly**:
175 Training and133 Liberty. These query all44 real movers at closed,halfway,
open poses against a controlled pawn near either X face, and ordinary pawn
relocations at mover centers. A controlled static brush copy verifies the
static-candidate exception alongside native dynamic-brush skips. Scene actor
ancestry fixes Mover→Brush→Actor, required by the original skip instruction.
The posed moving actor is never rehashed; controlled pawn updates use original
RemoveActor/AddActor, mirrored by the runtime shared hash.

The additional rotated/static-brush case exposed x87 PlaneDot cancellation in
model point recovery. Original Core10118520 preserves a quarter-turn sine term:
plane[1,0,-1.2246468525851679e-16,-6448] at[-6448,1376,-128] has stored positive
distance1.554312234475219e-14, whereas binary64 lost it to zero. That positive
nearest face wins recovery. Full modelPointCheck now rounds the original Z/Y/X
sum and offset subtraction with a64-bit significand before its float32 store.
The2,178 direct-model and3,756 level-point corpus still matches after this change.
The original trace is retained in ignored encroach-point-debug.py/output sources.

`node --test test/encroachment-query.test.mjs` retains an independent controlled
original cylinder case: source at100 temporarilyposed102, candidatesb/c at104,
registrationa,b,c => returnedc,b, both recoveryX92. Source remains100 and removes
using its old registration. This distinguishes append order, posed-source
narrowphase, self-skip and no re-registration.

This helper does not implement ULevel.CheckEncroachment policy, EncroachingOn /
EncroachedBy events, mover pushing, FarMoveActor, collision flags beyond the
query's own static-brush skip, or actor lifecycle. Those are caller dependencies.
Owned zero-extent candidate checks remain explicitly unsupported by model points.
