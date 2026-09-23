# Training crate destruction contract

The authority is the installed DeusEx.u/Engine.u TextBuffer and bytecode,
and Engine.dll's recovered SpawnActor, falling, landing and rotation bodies.
Extracted source stays in `.cache/research/crate` outside Git.

`DeusExDecoration.Active.TakeDamage` subtracts qualifying damage, darkens a
survivor with ResetScaleGlow, or calls DropThings, clears Event, assigns
Instigator, emits noise and calls Frag. DropThings sets based actors Falling.
Frag spawns `fragType` with Owner, then calls CalcVelocity, sets DrawScale
from the shared FRand stream, and takes Skin from GetMeshTexture. A
nonexplosive decoration then calls Destroy. `Containers.Destroyed` chooses
Contents/Content2/Content3, spawns numThings items at randomized positions and
yaw, sets Falling, bCollideWorld and Velocity, then enters Pickup/Dropped.
Trash/rat and explosive smoke branches need their own admitted families;
they are not replaced with effects in the host.

`TraceHitHandNonPenSpawner` inherits TraceHitNonPenSpawner → TraceHitSpawner
→ Actor. These script-only classes inherit AActor's constructor. The base
PostBeginPlay sets an absent Owner to Level and runs SpawnEffects. On a crate
this hand-to-hand branch spawns no secondary effects; SetTimer(0.1,false)
then Timer → Destroy is still required. Mover decals remain their own path.

Projectile construction is recorded in `script-projectile-construction.mjs`:
AProjectile size 0x340, InternalConstructor 0x103014e7, body 0x103442e0,
vtable 0x10428850. Script-only Fragment subclasses inherit this constructor.
`ULevel::SpawnActor` 0x103950fb–0x103951b6, before the actor-array append,
checks default bCollideWorld, or bCollideWhenPlacing with NetMode != 3.
It calls FindSpot with extent (radius,radius,height), mutable Location,
checkActors=0 and checkFirst=1, and returns null on failure. The remaining
hash/startup/encroachment/tail order is the already recovered Inventory
spawn sequence; Projectile does not pass the FindBase ancestry gate.

`Fragment.Flying.BeginState` runs RandSpin(125000), clamps small Pitch/Roll
rates to 10000, selects a Fragments mesh with FRand and starts a repeating
5-second timer. `DeusExFragment.PostBeginPlay` adds FRand()*2 to LifeSpan.
CalcVelocity and HitWall are original bytecode. The falling bBounce branch
dispatches HitWall directly; it must reread Velocity, Physics, bBounce and
bDeleteMe after the callback. `DeusExFragment.Tick` changes Style to
Translucent and ScaleGlow to LifeSpan/2 when LifeSpan <= 2. Actor.Tick owns
LifeSpan expiry. Inventory landing uses actorLanded, with the original
SetPhysics/SetBase callback order. No host damage, random-fragment or fade
substitute is permitted.

`validate-crowbar-crate.mjs` exercises public fire input and the ticked
scheduler with original Training data. Its fixed placement hits the upper
stacked `CrateBreakableMedGeneral2`: 10 → 4 → −2 HP, six WoodFragments,
the crate's mesh texture copied to their Skin, bounce and settling, the
authored Lockpick contents landing on a support, 0.1-second hit-effect
expiry, fragment fade and LifeSpan expiry, then reset restoring the crate
and removing spawned actors. The float32 ResetScaleGlow expression yields
0.4599999785423279 on the first hit (not float32(0.46)).

The existing native oracles establish falling/bounce, rotation, landing and
MoveActor arithmetic. This integration check establishes their VM/scene
bindings; it is not a claim of complete original-game visual fidelity.
Fragment/weapon/pickup landing audio and AI sound propagation are recorded
deferred boundaries, like existing decoration audio. PHYS_Projectile,
explosive smoke, trash/rat generation and unrelated spawn families remain
explicit unsupported paths. Rendering evidence and scope are separate.
