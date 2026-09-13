# Script controlled light cache boundary

This note records the Stage 3 contract recovered for a script write to an
actor's lighting properties.  The installed Deus Ex `Engine.dll` and
`Render.dll`, the `00_Training` serialized model, and the installed script
bytecode are the sources of truth.  The browser-side invalidation coordinator
added with this note is an explicit host boundary; it is not presented as a
reimplementation of an unlocated native setter.

## Recovered inputs

`Engine/Classes/Actor.uc` declares the transient flags in this order:

* `bStatic` (`0x1`),
* `bNoDelete` (`0x4`),
* `bLightChanged` (`0x400`), “Recalculate this light's lighting now”, and
* `bDynamicLight` (`0x800`), “Temporarily treat this as a dynamic light”.

The compiled actor layout places the lighting fields at `actor+0x1e0`
(`LightType`), `+0x1e2` (`LightBrightness`), `+0x1e3` (`LightHue`),
`+0x1e4` (`LightSaturation`) and `+0x1e5` (`LightRadius`).  These offsets are
also used by the native renderer and are independent of the browser object's
property names.

The selected `00_Training` route has TriggerLight references 111, 113, 114
and 110 in the model's terminated `LightMapIndex.LightActors` lists.  The
four lights are `LT_Steady`, have authored brightness 50, 50, 25 and 25, and
have `bNoDelete` set without `bDynamicLight`.  `src/unreal/model.mjs` decodes
each light map's `lightActors` start and walks `model.lights` until a zero
terminator.  This gives an exact map dependency from a light reference to the
lightmap entries which include it.

The installed `TriggerLight.Tick` bytecode writes the typed
`LightBrightness` field while its alpha transition runs.  The bytecode does
not contain a write to `bLightChanged`; the VM property write alone is the
recovered script behavior.  `APlayerPawn::RecomputeLighting` is exported at
`Engine.dll 0x10301ff5`, jumps to `0x10368de0`, and that body is only
`xor al, al; ret`, so it supplies no additional invalidation behavior.

## Native cache behavior

The original Render.dll guard string at `0x10b2a2dc`, pushed by the exception
tail at `0x10b06c43`, names the body beginning at `0x10b05fa0` as
`FLightInfo::ComputeFromActor` (thunk `0x10b0100f`). The earlier inference that
this whole body was named DynamicLight from a crash call path was incorrect.
`SetupForSurf` starts separately at `0x10b06c90` and calls this thunk at
`0x10b07375`. Both cache branches test the actor flag after comparing their
cached color headers, rather than geometry alone:

* at `0x10b06459`--`0x10b06461`, load `actor+0x28`, then test
  `0x400` (`testb $0x4, %ch`);
* at `0x10b0698f`--`0x10b06997`, repeat the load and test on the second cache
  path.

When the bit is clear, the branches jump to the cached sample path
(`0x10b065e2` and `0x10b06b65`).  When it is set, they jump to the
recalculation paths (`0x10b064ff` and `0x10b06a35`).  Thus the recovered
native rule is:

> A matching cached surface record may be reused only when the actor's
> `bLightChanged` bit is clear.  A set bit rejects that cache record and sends
> the branch through surface-light recomputation.

The same `ComputeFromActor` body reads the current byte at `actor+0x1e2`
(`LightBrightness`) at `0x10b060b3` before either cache branch and stores its
value times the original float `1/255` in the light-info object at `this+0x20`.
After the color-generation virtual, `0x10b0612f–0x10b06148` multiplies each RGB
component at `this+0x6c/+0x70/+0x74` by that brightness and the actor's
LevelInfo.Brightness (`actor+0xa8`, then `+0x500`). The first cache branch
compares exactly these three resulting floats against its saved header at
`0x10b06427–0x10b06453`. Any unequal component jumps to `0x10b064ff` regardless
of bLightChanged. That path stores the new three-float header, then regenerates
256 RGB entries (`0x10b06570–0x10b065e0`); each component is capped at 127 and
alpha is 255. Thus the steady brightness route does not need a script write
to bLightChanged to refresh its color table.

The second branch is gated by `this+0x30` and copies the RGB vector into a
four-component header before reading the volume properties at actor
`+0x1e9/+0x1ea/+0x1eb`. Its post-cache brightness multiply at `0x10b06bfa`
is not needed as evidence for the first surface-color branch. The
cache-key construction at `0x10b063c9`/`0x10b068e7`
calls the 64-bit multiply helper `0x10b278b0`; the low key input is the
actor's `UObject+0x04` index multiplied by `0x100`, with the second word and
color header comparisons checked against the cache record. Brightness is absent
from the integer key but is already present in the compared color header.
The browser therefore refills dependent lightmap colors when the script changes
brightness. It preserves the existing browser pixel-buffer and atlas identity;
it does not reproduce the native color-table allocation.

The native listing does not identify who sets `bLightChanged`, when it is
cleared after a successful rebuild, which persistent surface structure stores
the rebuilt samples, or how/when a GPU texture upload would occur.  No write
to the actor flag was recovered in the relevant `Engine.dll` or `Render.dll`
paths.  In particular, the evidence does not establish that a TriggerLight
script write sets the bit, that `SetupDynamics` owns these training lights, or
that the original renderer has a lightmap-atlas operation equivalent to the
browser's `LightAtlas.update()`.

`SetupDynamics` (thunk `0x10b0118b`, body `0x10b22d90`) is a separate per-draw
candidate list.  Its gate tests `LightType`, then rejects actors with
`bStatic`/`bNoDelete` unless `bDynamicLight` is also set, and finally requires
nonzero brightness and radius.  The four training lights fail that flag gate,
so they must be handled through their surface lightmap dependencies for this
route.  This does not generalize to other maps or to actors whose native code
sets `bDynamicLight`.

## Host boundary used by Stage 3

The browser rebuild boundary is `createLighting().invalidate()` in
`src/unreal/lighting.mjs`, with `createWorld().updateLighting()` uploading the
same lightmap objects through `LightAtlas.update()`:

1. Build the exact terminated `LightActors` dependency index from a decoded
   model.
2. Register the already-created browser surface/lightmap entries, including
   their surface index and zone cache key.
3. `createLighting().invalidate()` accepts explicit changed light references
   (and an optional current `LightBrightness` byte), refills every cached
   result whose terminated list contains one of those references, and
   preserves each result object's dimensions, UV function, and atlas identity.
4. `createWorld().updateLighting()` calls `LightAtlas.update()` for each
   refilled result, so tile coordinates and padding remain valid while the
   texture version is marked dirty.

The host API does not infer a native `bLightChanged` setter or clear a native
flag.  The original setter/clear and persistent native cache write paths remain
unresolved.  `invalidate()` is an explicit host notification boundary: the
caller supplies the light reference and, when the selected steady script route
changed brightness, the current `LightBrightness` byte used by the
source-backed browser fill. Radius, effect, position, type, and corona writes
remain outside this host route.

## Integration status and unresolved branches

The world builder still keeps the atlas private, but its returned
`updateLighting(changes)` method is the integration boundary.  The script host
must call it after a TriggerLight write with entries such as
`{ ref: light.index, values: { LightBrightness: current } }`; a bare reference
is also accepted when the lighting actor object was already updated by the
caller.  `src/viewer/light-atlas.mjs` already provides the required in-place
tile `update()` operation, and no edit is needed there for this contract.

The following remain unsupported until original evidence or a reproducible
oracle measurement resolves them: the `bLightChanged` setter and clear
lifetime; static lightmap dirty-bit ownership; the exact surface-cache record
and upload path; position/radius/effect/type changes; corona/skin updates;
dynamic-list membership changes; and any renderer behavior outside the
steady brightness-only TriggerLight route.

## Focused original comparison

`native-light-color-cache-oracle.py` executes the installed Render.dll's
brightness normalization, RGB multiplication, and first-cache comparison
instructions. Render SHA-256 is
`607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1`.
The six cases show unchanged color reuses the table, brightness 50→25, 25→0
and 0→50 rebuild it, bLightChanged forces a rebuild even for unchanged RGB,
and an all-black source color remains reusable when brightness changes. Color
generation is an explicit fixture input; native allocation and surrounding
renderer execution are outside this probe.

`validate-script-light-cache.mjs` runs that comparison and the installed
Training Play route. Original LightSwitch/TriggerLight bytecode drives four
initial/off/on/reset atlas syncs, with the same cached lightmap object retained
and its pixels updated in place. This validates the new translation/integration
boundary without claiming full native cache allocation or GPU equivalence.
