# TriggerLight brightness invalidation

This note records the renderer boundary reached by the `00_Training`
`LightSwitch0 -> TriggerLight0..3` route.  The source of truth is the installed
Engine.dll/Render.dll and the serialized map.  A browser cache invalidation
strategy is identified separately from behavior recovered from the original
binary.

## The training lights are authored surface-list lights

The four map actors are references 111, 113, 114 and 110.  Reading the class
defaults and map overrides gives:

| actor | `bStatic` | `bNoDelete` | `LightType` | `LightBrightness` | `LightRadius` |
| --- | ---: | ---: | ---: | ---: | ---: |
| TriggerLight0 (111) | false | true | 1 (`LT_Steady`) | 50 | 40 |
| TriggerLight1 (113) | false | true | 1 (`LT_Steady`) | 50 | 40 |
| TriggerLight2 (114) | false | true | 1 (`LT_Steady`) | 25 | 40 |
| TriggerLight3 (110) | false | true | 1 (`LT_Steady`) | 25 | 40 |

The defaults reader has no nonzero `bDynamicLight` value for these actors.
`Actor.uc` declares the flags in order at lines 61--73 and the lighting bytes
at lines 387--405.  The byte fields therefore use the native actor offsets
`+0x1e0` (`LightType`), `+0x1e2` (`LightBrightness`), `+0x1e3`
(`LightHue`), `+0x1e4` (`LightSaturation`) and `+0x1e5` (`LightRadius`).

The serialized model places these references in the per-surface
`LightMapIndex.LightActors` lists.  `src/unreal/model.mjs` reads each list's
`lightActors` start into `model.lights`; a zero terminates a list, while the
same light map carries `dataOffset` into `model.lightBits`.  A direct decode of
`00_Training.dx` reports 53,722 entries in `model.lights`; refs 110, 111, 113
and 114 occur 191, 185, 176 and 181 times respectively, and 98 light maps
contain one of them in their terminated `LightActors` segment.  This is the
actual classification available in the map: `LightType=LT_Steady` selects the
light's effect, while membership in `LightActors` selects a precomputed
surface contribution.  `LightType` itself is not a static/dynamic flag.

## The recovered dynamic path excludes them by default

Render.dll's exported `SetupDynamics` thunk is `0x10b0118b`; its body is
`0x10b22d90`.  The candidate scan walks the level actor array in order
(`level+0x2c` pointer and `level+0x30` count).  At `0x10b230e8`--
`0x10b23114` it performs this gate:

1. `LightType` at `actor+0x1e0` must be nonzero.
2. It tests `$0x5` against the low byte of the actor flags at `actor+0x28`.
   The set bits are the `bStatic` and `bNoDelete` declarations (`0x1` and
   `0x4`).
3. If either bit is set, the high-byte test at `0x10b230fd`--`0x10b23100`
   requires `$0x8`, or the full flag `0x800`, which is `bDynamicLight`.
4. Live `LightBrightness` at `+0x1e2` and `LightRadius` at `+0x1e5` must be
   nonzero.  The routine then reads `VolumeRadius` at `+0x1ea`, calls the
   actor's `WorldLightRadius` virtual at `+0x60`, performs scene bounds tests,
   and allocates a dynamic light item containing the actor.

The training lights fail step 2 and have no authored opt-in for step 3.  They
are therefore not evidence that `SetupDynamics` drives the switchable crate
lights.  The draw-time caller at `0x10b1a18e` invokes `SetupDynamics` before
`OccludeBsp` (`0x10b1a199`), establishing a per-draw dynamic-list rebuild for
actors that pass this gate.

The separate Render.dll `GlobalLighting` thunk `0x10b010b4` (body
`0x10b05e90`) reads the actor's light type/hue/saturation and calls Engine.dll
`FGetHSV` (`0x10303dd7 -> 0x103ec8d0`) with brightness 255 for actor colour
construction.  The recovered light contribution scales that colour by the
live `LightBrightness/255` and level brightness.  This formula, the existing
`shadowMask` and `lightAttenuation` helpers in `src/unreal/lighting.mjs`, and
the serialized `lightBits` are sufficient to recompute a contribution when
the light's brightness changes.  They do not establish the original cache
invalidation mechanism.

Engine.dll `AIGetLightLevel` (`0x10303ee0 -> 0x1036b980`) independently walks
the current level actor array, tests live `LightType` and `LightBrightness`,
calls `WorldLightRadius` at the actor virtual `+0x60`, and applies static-light
occlusion when the actor's static bit is set.  This confirms that at least one
lighting consumer sees a changed brightness without a cached actor snapshot;
it is not a static lightmap rebuild.

## What is and is not recovered for `bLightChanged`

`Actor.uc:71` defines transient `bLightChanged` as “Recalculate this light's
lighting now” and `Actor.uc:72` defines `bDynamicLight`.  The field order makes
the former flag `0x400` and the latter `0x800` in the `+0x28` DWORD; the direct
`0x800` test above confirms the latter mapping.  A focused search of the
Engine.dll and Render.dll instruction listings found the cache consumers in
`FLightInfo::ComputeFromActor` (`0x10b05fa0`, named by its original guard string), at `0x10b06459`--`0x10b06461` and
`0x10b0698f`--`0x10b06997`, testing `0x400` at `actor+0x28` (the high-byte
`testb $0x4, %ch`).  The setter/clear path for `bLightChanged`, the static
lightmap dirty bit, and the surface cache upload were not identified in this
pass.  No script-side write to the flag can therefore be claimed as original
behavior.

`src/unreal/lighting.mjs` caches each `${surfaceIndex}:${zone}` result in a
model-local `WeakMap` and now keeps a dependency set for each result.  Its
explicit `invalidate()` route accepts a changed light reference and optional
`LightBrightness` byte, refills affected results in place, and preserves their
atlas identity.  `src/viewer/main.mjs` connects the selected steady
TriggerLight tick changes to `world.updateLighting()` after script execution.

## Supported implementation boundary

For the selected TriggerLight case, a host may preserve each affected
lightmap's shadow mask, sample points, radius/incidence falloff and colour
parameters, then recompute only the brightness-scaled contribution from the
current typed byte before reuploading the affected atlas tiles.  The map gives
an exact dependency index: scan each terminated `LightActors` segment and
associate the light actor reference with that surface/zone cache key.  This is
an efficient and numerically source-backed *candidate* for the contribution,
but the original binary did not establish that it invalidates this way.

The host schedule for that candidate is: finish script Tick/event processing,
collect changed steady-light references, invalidate their dependent static
surface entries, rebuild or upload those entries, then draw.  The ordering
follows the need to sample the script's new `LightBrightness`; it is a host
requirement, not a recovered native call order.  The dynamic `SetupDynamics`
list should be rebuilt before drawing only for actors that pass its flag gate.

The following remain explicitly unsupported by this evidence:

* claiming that `bLightChanged` is set by the TriggerLight bytecode or that the
  recovered ComputeFromActor cache tests establish who clears that flag;
* treating the four training lights as `SetupDynamics` lights unless a runtime
  native path demonstrably sets `bDynamicLight`;
* claiming that the original renderer rebuilds a static atlas or reuses its
  shadow masks after a script brightness write;
* animated `LightType`/`LightEffect`, position/radius changes, corona texture
  changes, and other renderer branches outside the selected steady
  brightness-only case.
