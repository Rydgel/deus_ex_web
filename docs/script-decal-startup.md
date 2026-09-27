# Shadow / native Decal startup

This continues the [NPC startup dependency](script-npc-startup-animation.md).
Authority: the installed Engine.dll and Core.dll (hashes in
[construction evidence](script-construction.md)), and the embedded Engine.Decal
and DeusEx.Shadow source and bytecode. This is not yet successful decal surface
attachment or rendering.

## Constructor and storage

The loaded Shadow class (DeusEx.u export 7308, flags 0x32) has the chain
`Shadow -> Engine.Decal -> Engine.Actor -> Core.Object`. Core UClass::Bind
copies down Decal's constructor, as established by the existing native class
binding translation. Engine.Decal's registration supplies size 0x32c and
InternalConstructor 0x10303a26 -> 0x10331070 -> ctor 0x10331090.

The ctor runs the inherited member constructors, clears the SurfList TArray
header at +0x320/+0x324/+0x328, and writes vtable 0x10426f74. Direct execution
of the original ctor on a sentinel-filled allocation confirms those are the
only changed bytes. The Decal vtable's ProcessEvent (+0x10), native Destroy
(+0x24), InitExecution (+0x38), and Spawned (+0x74) slots match AActor's slots. MultiDecalLevel (+0x318)
and LastRenderedTime (+0x31c) remain template values.

SurfList is a native `array<int>`. Its logical VM storage needs an empty value,
independent signed-int element copies and explicit destruction. Reuse the
existing original [UArrayProperty copy](script-property-copy.md#dynamic-tarray-copy)
and [destruction](script-property-destroy.md) contracts: a non-owning IntProperty
inner copies count*4 bytes; destruction clears the outer allocation/header.
Supporting whole integer-array values does not implement dynamic-array VM
index/resize opcodes, owning/nested arrays, or raw allocator capacity.

## Startup and native gates

The original Shadow default Texture is **DeusExItems.Skins.FlatFXTex40**. The
scalar-only ClassDefaults convenience reader omits this object reference; its
absence there is not a null Texture. The script runtime's canonical default is
the authority. MultiDecalLevel is 4; all collision/placement flags are false;
bGameRelevant is true. The original noncolliding SpawnActor path applies, using
the Decal constructor and actual inherited startup events.

`Decal.BeginPlay` calls AttachDecal(100); false invokes Destroy. Shadow does not
override BeginPlay. `Decal.Destroyed` calls DetachDecal then Super.Destroyed.

`execAttachDecal` (0x103e7250):

1. Evaluate required TraceDistance and optional DecalDir (default zero vector),
   advance past EndFunctionParms, initialize the return bool to false.
2. Follow XLevel (+0xac) -> Engine (+0x40) -> Client (+0x44). Null Client returns.
3. Test **Client.Decals at +0x4c**, not a render-device pointer. Zero returns.
   UClient.StaticConstructor at 0x1037560b..0x1037564a registers the literal
   `Decals` name with offset 0x4c and BoolProperty mask 1. AttachDecal itself
   tests the complete word.
4. If Texture (+0x16c) is null, log the original diagnostic and return false.
5. Otherwise clamp signed MultiDecalLevel above 4 to 4 (store at 0x103e7351),
   then enter the BSP attachment path. Its successful surface/geometry work remains
   an explicit boundary until recovered. Do not disable Client.Decals or clear
   Shadow.Texture to evade this path.

`execDetachDecal` (0x103e9a30) advances the parameter cursor and returns directly
when SurfList.Num <= 0 (0x103e9a67..0x103e9a6f -> 0x103e9c1d). Nonempty lists
require removing the decal entries from their BSP surfaces before changing the
list; that branch is not an empty-list no-op.

The native Destroy slot is AActor's 0x10301f8c, so ConditionalDestroy uses the
existing Actor -> UObject property cleanup. This is distinct from ADecal's
C++ destructor (0x103025c2 -> 0x1030fd60), which clears/frees SurfList before
the base destructor; final collection/release remains unsupported.

## Focused validation and remaining boundary

`node scripts/validate-decal-startup.mjs` compares the translated constructor
and six native cases with original DLL execution: null client, disabled decals,
missing texture, explicit direction with a clamped depth, omitted direction
with a negative depth and nonzero bool word, and empty DetachDecal. The two
positive cases deliberately stop at 0x103e7357 after the clamp store; they are
not full successful attachments. The argument Steps and original warning are
recorded. Original DLLs and extracted sources remain outside Git.

`node scripts/validate-npc-startup-boundary.mjs` executes Jaime's original
PreBeginPlay/CreateShadow through the shared SpawnActor path. Shadow has its
original Texture, owner/instigator, feet location, rotator (16384,0,0), empty
SurfList and native vtable, then enters inherited Decal.BeginPlay. With the
controlled client setting matching the installed `Decals=True`, execution
stops at `DECAL_BOUNDARY / AttachDecal.surfaces`. bInitialized remains false.
The same fixture checks linked integer-array copies/destruction and the real
disabled-decals BeginPlay -> Destroyed -> empty DetachDecal -> native Destroy
route, including actor-array removal and the pending-deletion chain.

The live browser prepares this shared path but does not run NPC startup. Its
Client.Decals binding, positive BSP attachment, nonempty detachment, Shadow.Tick,
final release and the subsequent pawn initialization dependencies remain open.
No production setting disables decals to bypass these requirements.

## Attachment record ownership

A successful attachment records its texture-keyed owner in the live level's
`decalRecords` (DetachDecal releases it). The original keeps FDecal entries
on the loaded level's own UModel surfaces (`FBspSurf.Decals`, SDK
`UnObj.h:213,458-467`), and LoadMap loads that model fresh. The decoded map
model is shared by every Play instance and by Player-start reloads, so the
records live on the level object, and a reload clears them with the other
per-load level fields. Before 2026-09-27 they were stored on the shared model.
That carried Shadow owners across reloads and kept every discarded game
reachable, about 300 MB each: a `createGame` loop grew 300 MB per boot, and
`validate-player-tick-order` peaked at 5.4 GB. Now dropped games are
collected, and that validator peaks at 2.8 GB.
