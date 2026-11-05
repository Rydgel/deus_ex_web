# Native mesh resources in the shared loader

This extends the original payload work in `script-mesh-payload.md` to native
class defaults, constructor state, the retained linker archive and EndLoad.
It does not implement mesh rendering, save archives or complete Play load
finalization. The destructors, run for meshes the LoadMap collection purges,
are [mesh destruction](mesh-destruction.md).

## Original contract established before integration

The original GOTY Engine initializers at `0x103d8200` (Primitive), `0x103a6770`
(Mesh) and `0x10354f40` (LodMesh) register sizes `0x54`, `0x12c` and `0x1b0`.
Their Super chain is Core.Object → Primitive → Mesh → LodMesh; all have
Core.Object as Within, initial class flags zero, System config name,
`0x04084004` object flags and Core's static constructor `0x10101041`.
Internal constructors are respectively `0x103023ce`, `0x103020bd`,
`0x10303855`. None has a Class export in the installed Engine.u.

`native-mesh-graph-oracle.py` runs these initializers and original
`UClass::Register` (`0x10127800`) in inheritance order, with the existing
explicit Core.Object bootstrap and registration/config/allocator services.
The resulting class flags are `0x12`; complete native default tails from
`+28` to each class's size are zero. These zeros come from registration, not
from missing serialized tags. Instance construction must still run afterward:
the original Mesh constructor writes scale `(1,1,1)`, `+f8=-1`, zero origin
and rotation, native lazy-array vtables and FArrays. LodMesh initializes its
additional arrays and installs vtable `0x1042942c`.

Constructor bodies and array initialization are already recovered at
`0x103a6130` / `0x1034a760`. Core InitProperties (`0x101520d0`) copies the
registered defaults before those constructors. A poisoned instance tail in
the new probe verifies that no field silently relies on fresh zero allocation.

The shared serializer must run the original UObject prefix on the *same*
archive, then the native field order from `script-mesh-payload.md`. In particular,
FNames pass through the linker's global-name mapping and Texture references
call the canonical IndexToObject path while the parent archive cursor is live.
The four FLazyLoader objects attach to that archive, with original saved offsets,
Num/Max behavior and deferred loads restoring its cursor. A separately parsed
export followed by a synthetic seek is not the native load path.

All three original instance vtables have PostLoad slot `+20 = 0x1040c72e`,
the Engine import trampoline through `0x10599ae4` to Core UObject::PostLoad.
Thus conditional PostLoad clears the existing load flag and reaches the base
`0x20000000` postload flag without forcing the vertex arrays to load. This
dispatch is established from the actual vtable, not assumed from ancestry.

Required comparisons cover class defaults, complete constructor bytes, the
existing real mesh array/scalar references, canonical Texture pointers, lazy
archive retention and complete queue finalization. Original binary data and
captures remain outside Git.

## Implementation and results

`script-mesh-load.mjs` now owns the original constructor and version 68 loading
body. The detached `decodeLodMeshPayload` inspection adapter and shared graph
both invoke it; there are no separate copies of the mesh format reader. The
graph stores the constructed arrays/fields on its existing native resource
record. `meshPayloadView` exposes those same arrays to frame consumers without
copying the resource or changing its canonical Texture references.

The Primitive registry row was missing its original Core.Object Super pointer;
the recovered initializer fixes that hierarchy. Resource loading initializes
all three native-only default images and admits LodMesh's actual constructor,
Serialize and inherited PostLoad. Unsupported mesh archive versions are refused
before Preload clears RF_NeedLoad. General Mesh/Primitive instance serializers
and saving remain unsupported.

`validate-mesh-load-graph.mjs` compares all three class default tails, class
sizes/flags/Super/Within, complete constructed instance bytes, all four original
constructor reallocations, every serialized array, global sequence/notify
FNames, scalar bits, Texture tokens, lazy state and original frame vectors.
GM_Trench finishes its one-object scope. LightSwitch finishes its entire
733-object scope, including Texture/Palette dependencies and metadata/function
binding, using the original Core initializer table and named DLL exports. Every
queued object clears NeedLoad/NeedPostLoad and reaches base PostLoad; no queue
entries are filtered out. Deferred mesh reads remain attached to the original
linker archive after EndLoad and restore that shared cursor.

The existing eight payload comparisons still pass through this shared body,
including eager/deferred loads and both remap fixtures. The Sound graph and
seven-class Play metadata boundary are regression checks for bootstrap changes.
This does not finish the larger live Play queue: remaining native resource
types, bootstrap defaults, ownership/destruction and general finalization are
still explicit Stage 3 work. The subsequent Play identity bridge below uses
these shared records for prepared mesh resources.

## Play identity bridge contract

This integration reuses the constructor, class-default, serializer and lazy
archive evidence above; it adds no inferred mesh behavior. When native class
loading is enabled, prepared LodMesh resources must use that loader's existing
export record and `meshPayload` view. Class/default references, imported handles,
the prepared resource and deferred frame reads must therefore converge on the
same object and archive. Texture edges must come from the serializer's resolved
UObject references, rather than resolving the package indices a second time.

LodMesh construction/loading needs only the GLazyLoad read service. Its admission
must be separable from Texture's clock and mip-bias services; enabling mesh loads
does not establish those other services. Play retains its existing explicit
deferred-load policy (`GLazyLoad=1`), a branch compared against original DLL
execution. This is a host-selected input, not a claim about the original engine's
global initialization. Other resources retain their existing explicit boundary.

Preparation runs native Preload, preserving its incoming archive position, and
does not call a filtered EndLoad. The larger Play queue remains intact and its
NeedPostLoad flags remain pending until all required virtuals are available.
Standalone inspection can still explicitly use the detached adapter; failure
of the native Play route must not silently fall back to it.

Focused integration checks cover existing default-created and first-load meshes,
concurrent/repeated preparation, canonical Texture edges, retained lazy arrays
and cursor restoration, and continued refusal of unsupported Texture loads.
The existing native mesh comparisons remain the source-of-truth checks.

`ScriptClassLoader` now admits mesh loads with this narrow service contract.
`ScriptResourceRegistry` uses it whenever the runtime enables native class
loading: the prepared resource's `loadRecord` and `payload` are the existing
native record and its view, and each Texture edge maps from the native reference
to the VM's canonical export handle. There is no second mesh decode in Play.
Registry-only inspection retains the detached adapter explicitly.

The Play boundary check now prepares Training's live JaimeReyes0 mesh
(`GM_Trench_F`) from its existing class-default reference, concurrently and
repeatedly, and verifies that the record and payload view remain identical.
GM_Trench's frame access preserves the live archive cursor. A separate first-load
LightSwitch case checks canonical Texture edges and verifies that unsupported
Texture Preload leaves its flags intact. The original 1/733-object native mesh
comparisons, seven-class default comparisons, 12 resource/animation unit tests
and the browser health/compass/InfoLink/reset check pass with this bridge.
