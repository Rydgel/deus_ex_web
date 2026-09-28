# Ordinary moving lights: original spatial contract

Stage 4 rendering increment, 2026-09-28. This extends the existing
[moving-light path](dynamic-lighting.md). The authority is the installed GOTY
Render.dll, SHA-256
`607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1`.
Addresses below are preferred-base virtual addresses. No original binary or
disassembly is committed.

The oracle also executes Core.dll's original FVector constructor when measuring
the incidence factor. Core.dll is hash-pinned to
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.

## Contract recovered before implementation

The 12-byte effect rows at `0x10b2a0f0` select `0x10b01113`, a jump to
`0x10b03360`, for effects 0, 1, 2, 3, 11, 15 and 19. This increment admits
steady effect 0 only. Torch/fire/watery modulation, spotlights, bump maps and
the other effect-specific processing remain outside it.

1. Light-manager initialization `0x10b022fe..0x10b02352` builds 4096 floats
   at `0x10b34a6c`: with `d = sqrt((i+1)/4096)`, the entry is
   `float((2*d*d*d - 3*d*d + 1)/d)`. The square root and following arithmetic
   retain x87 extended precision until the final float store.
2. ComputeFromActor `0x10b0632d..0x10b0639e` stores the three float
   components of `Location - facet.Origin`, dots them with the facet normal
   in Z/Y/X order, multiplies by the stored reciprocal radius, takes the
   absolute value and stores the incidence factor at light-info `+0x24`.
3. The normal spatial body reads the same lightmap grid, rectangle and
   illumination bytes as NonIncidence. It computes the displacement to the
   rectangle's first texel, preserving the asymmetric float stores in
   `0x10b033b1..0x10b03463`. It stores `scale = float(rr2*4096)`.
4. Six dot products, evaluated Z/Y/X, become signed integer coefficients
   through a float store then nearest-even FISTP: displacement squared,
   displacement dot U/V step, U/V step squared, and U dot V. The inner loop
   advances squared distance by integer first and second differences. Row
   advancement also updates the U first difference by twice the U/V cross
   term. All additions wrap as 32-bit integers.
5. A texel is zero if illumination is zero or the **unsigned** squared-distance
   accumulator is at least `0x1000000`. Otherwise its top bits (`>>>12`)
   index the table. The original multiplies illumination by the table value
   and incidence factor, adds **8388608**, stores a float and takes its low
   byte (`0x10b0369f..0x10b036e2`). This is not a clamp or a floor operation.
6. The existing colour table and saturating merge consume that byte. The
   recovered candidate/filter/rectangle and static-copy composition remain
   the surrounding path.

The one-time local-static guard registers an empty destructor (`0x10b03760`)
through the CRT. An instruction oracle may supply the already-initialized
guard; it must execute the numerical body unchanged.

## Reference cases and scope

Before implementing the runtime translation or connecting Play, the extended
`native-dynamic-light-oracle.py` recorded original outputs to the ignored
`.cache/stage4-normal-original.json`. `validate-normal-moving-lighting.mjs
--reference-only` reproduces those references. The cases use all 40 surfaces
reached by Training's four authored SecurityCamera lights, plus eight grids
covering coplanar/back-side incidence, zero/full illumination, radius edges,
nonzero rectangle origins and non-orthogonal steps.

`src/runtime/dynamic-lighting.mjs` now supplies the normal table, incidence
factor and spatial body. Table initialization, incidence and the six integer
coefficients use the project's x87 model. Initial texel displacement and the
per-texel multiply use JavaScript doubles with the recovered float stores;
the comparisons establish the cases below, not an all-input precision proof.
`src/viewer/moving-lights.mjs` dispatches steady effect-0 lights to this body
and merges their colour-table bytes through the existing static-copy path.
Unrecovered effect/type variants retain explicit diagnostics.

Validation on 2026-09-28:

| Comparison | Result |
| --- | --- |
| Original normal-table initialization | 4,096 float entries, exact bits |
| Incidence, spatial bytes, merged RGB | 40 Training surfaces + 8 boundary grids, 37,763 texels, zero mismatches |
| Live Play renderer composition | 11 camera-light lightmaps match original spatial/colour bytes added to the existing static float pixels |
| AugLight lifecycle regression | F12 lights 113 maps; second F12 restores the camera-only state |
| Existing NonIncidence oracle | 438 surfaces, 72,255 texels, zero mismatches |
| Browser lighting regression | Fixed cameras, brightness and unlit controls pass; no shader errors |
| Focused unit checks / production build | 16 lighting/geometry tests pass; Vite build passes |

The live composition comparison is part of `validate-auglight-lighting.mjs`.
It invokes the original normal body on the renderer's actual inputs and compares
every resulting pixel, so keeping the old float approximation would fail it.

A local browser capture at `[6680,430,175]`, rotation `[3800,32768,0]`, shows
SecurityCamera0's green ceiling light without runtime/render errors. The image
and diagnostic JSON are ignored files at `.cache/stage4-normal-light-browser.*`.
This is a browser smoke check, not an original-game image comparison.

The live renderer's FPU control word remains unmeasured; the established
comparison convention is `0x037f`, with `0x007f` reported separately. The latter
changes 3,249 normal-table entries; no spatial byte differs on these sampled
inputs (which retain the extended-run constants). The
existing whole-BSP filter, mover-transform, grid-construction and static-map
precision limitations still apply. Numerical comparisons alone do not establish
original-game visual acceptance. Mesh lighting, spotlight/effect processing and
that original-game visual comparison remain open Stage 4 work.
