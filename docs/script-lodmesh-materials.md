# Original LodMesh surfaces and skin selection

## Contract recovered before implementation

Authority is the hash-pinned GOTY Engine/Core binaries recorded in
[mesh frames](script-lodmesh-frame.md), plus Render.dll SHA-256
`607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1`.

Render.DrawLodMesh (`10b0ea80`) calls ULodMesh.GetFrame with stride 88 at
`10b0ee0f`. Its ordinary-vertex base is the returned buffer plus 88 times
mesh.SpecialVerts (+184), established at `10b0ed8a..10b0edbc`. Full-resolution
triangle selection (`10b10123..10b101e8`) reads mesh +144, eight bytes per face:
three unsigned word wedge indices followed by an unsigned word material index.
The wedge table at +15c contains four-byte records: unsigned word ordinary
vertex index and two unsigned bytes U/V. The renderer copies those packed
records to its scratch wedge table and indexes the ordinary-vertex base.
Thus indices into GetFrame's complete output add SpecialVerts exactly once.
Material records at +168 contain u32 polygon flags then i32 texture slot;
`10b10b0a..10b10b24` reads both fields. Flags are ORed with the supplied renderer
flags. The UV path at `10b10b43..10b10c83` scales each byte by texture size times
texture scale times 1/256 (`10b2ac28` = 0.00390625). The topology accessor will
retain raw UV bytes; texture-coordinate conversion belongs to the draw adapter.

This is the full-resolution topology boundary only. Reduced LOD additionally
reads face levels (+138), wedge-collapse links (+150), point-collapse links
(+12c), distance/LOD settings, and position/UV morphing. Those branches are
explicitly unimplemented; full-resolution decoding must not be presented as
equivalent to full DrawLodMesh. Face culling, normal accumulation, lighting,
clipping, texture animation/locking and draw-device calls remain separate.

AActor.GetSkin thunk `103016f9` enters `10367eb0..10367ec8`: unsigned index <8
returns Actor.MultiSkins[index] (+1a4); all other indices return null. Original
AActor and APawn vtable slot +80 is that thunk. ScriptedPawn and DeusExPlayer
in DeusEx.dll (SHA-256 `b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04`)
use `1001af26`, an IAT jump through `1002721c` to the same Engine GetSkin.

UMesh.GetTexture thunk `103032b5` enters `1031c0a0..1031c0ff`, inherited by
ULodMesh vtable +74. With an actor, call virtual GetSkin(index); if nonnull,
call it **again** and return that second result. Otherwise a nonzero index
whose mesh texture (+d8 array) is nonnull returns it. Next prefer nonnull
Actor.Skin (+170), then return the requested mesh texture. Without an actor,
return the mesh texture. This worker assumes a valid texture index when it
reaches the array; the browser boundary must reject unsafe array access.

Actor.GetMeshTexture native 1013 (`103e17c0..103e18be`) has a separate wrapper:
evaluate optional int (default zero, including EX_Nothing), advance past the
end-parameters byte, clear result, then read Mesh (+174). With no mesh, warn
using the original text `GetMeshTexture: No mesh` and return null. Otherwise
use the same repeated GetSkin call first. The early mesh-array path requires
index >0 and index < texture count (+dc), then nonnull texture. Next prefer
Actor.Skin. The final mesh-array path requires index >=0 and <count; otherwise
return null. Preserve these bounds and live field reads; do not replace this
wrapper with the less defensive UMesh worker.

Original ScriptedPawn.SetSkinStyle loops slots 0..7 through native 1013 and
GetStyleTexture, then writes Skin/ScaleGlow/Style. ResetSkinStyle restores the
authored defaults. These are the intended linked-runtime integration boundary.

## References and runtime boundary

`native-lodmesh-materials-oracle.py` established captures before translation.
It executes 28 complete GetSkin/GetTexture/native-1013 calls, including original
literal evaluators, unsigned/signed bounds, null slots/actor/mesh, Skin fallback,
EX_Nothing and the repeated virtual-call order. Actor storage remains unchanged;
the no-mesh warning is a recorded leaf. It also verifies the original vtable
and DeusEx import bindings described above.

The oracle executes the identified unchanged Render instruction ranges over
the already verified LightSwitch/GM_Trench serialized arrays. All 26/603 faces
match `readLodMeshSurfaces` in material/flags, packed wedges (including raw UV
bytes), texture slot and resulting complete-buffer vertex references. These
ranges establish data interpretation, not complete renderer equivalence.

`validate-lodmesh-materials.mjs` compares these references. Optional
`--reference-only` captures the original outputs; `--captured` reuses them only
when the input specs still match. Native execution is the default.

`ScriptRuntime` exposes full-resolution surfaces and renderer-side GetTexture
over its existing canonical resources and dispatches native 1013 separately.
The GM_Trench runtime check verifies Jaime's 603 faces, special-vertex prefix,
linked Skin/MultiSkins offsets and authored texture identities, then executes
his original SetSkinStyle/GetStyleTexture and ResetSkinStyle scripts. The
LightSwitch check reaches the canonical mesh-texture fallback, including the
omitted optional argument. No new animation, appearance or NPC startup is
invented by this resource bridge.
