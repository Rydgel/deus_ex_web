# Actor mesh texture sharing

The change reuses GPU texture objects for static skins across actors in one
scene. It changes resource ownership, not skin selection, pixel decoding,
sampler settings, or actor behavior.

The existing original evidence establishes the inputs before this change:
[GetSkin/GetTexture](script-lodmesh-materials.md) recovers Engine.dll
`0x10367eb0` and `0x1031c0a0`, including actor overrides, mesh fallbacks,
pointer identity, and Render.dll's material flags and packed UV bytes.
[Mesh lighting](mesh-lighting.md) establishes the per-actor vertex colors;
the shared texture cannot own or cache those colors. Texture loading keeps
palette/mip identity as described in [texture loading](script-texture-loading.md).

Sharing is limited to the same canonical static texture, final palette
masking, and NoSmooth sampler choice. Animated/procedural skins retain the
existing explicit unsupported boundary. Materials stay per actor because
Style, ScaleGlow, modulated uniforms and Three's material-based draw order
must retain their current behavior. Geometry, animation/tween caches,
environment UVs and render feedback remain per actor.

Scene ownership includes async admission: disposing the scene during
decode cannot create a late GPU texture, and retiring one actor must not
dispose a texture still used by another. Last-lease release disposes a GPU
texture. Standalone actor
and Training previews own their pools and retain their existing disposal API.

Each actor retains its existing private TextureStore and every original
decode await. GPU acquisition happens synchronously at the old allocation
point. Sharing the decode promises was rejected: it changed preview arrival
and material allocation order. Keeping that order matters because Three
sorts opaque submissions by material identity; there is no new promise
shortcut or material sharing in the retained change.

The adapter also avoids rewriting material color/blending/alpha-test fields
when the actor's Style and effective ScaleGlow are unchanged. The first
update still applies all live state, and changes still update every private
material. With original lighting, ScaleGlow remains part of the lighting
pass rather than the texture color.

## Verification and resource counts

The whole Island scene (291 actors, 739 draw groups, 47,063 triangles)
requires 128 shared texture objects instead of 739, an 82.7% reduction.
The stored RGBA mip payload associated with those GPU textures decreases
from 51,673,564 to 12,354,928 bytes (76.1%). These are texture-object and
pixel-payload counts, not driver VRAM measurements or a claimed frame-rate
increase. The full scene includes actors outside the current camera view;
it is larger than the submitted group count in browser profiles.

All 739 before/after group records match exactly, in order: geometry,
UVs, vertex colors, mip dimensions and pixels, actor/material identity
labels, sampler settings, blend/alpha/depth/side state and color. The
combined SHA-256 is
`33e28e88033da1e0f0609a6c11a1948bbf583d25e12a63fce302662d38854108`.
Relative material allocation order also matches exactly, preserving the
material-id input to Three's opaque sort. Existing unsupported/skipped
procedural skins are unchanged. The local measurement and detailed records
are `.work/tools/actor-mesh-resource-count.mjs` and
`.work/actor-mesh-pool-count-{before,after}.json`.

Training's existing integration validator passes with 218 draw groups
using 68 texture objects. It checks the 18 NPC + 46 prop composition,
static/environment geometry, actor removal/readmission, independent live
ScaleGlow/Style with shared crate skins, no repeated material writes on an
unchanged frame, disposal, script-driven tool Mesh changes, and owner
visibility. Four focused unit tests cover static identity reuse, masked
and NoSmooth variants, last-owner disposal, disposal during a pending
decode, and the animated/procedural boundary.

Run `node --test test/actor-mesh-textures.test.mjs` and
`node scripts/validate-actor-mesh-scene.mjs`. Original frame, texture
selection and lighting evidence is reused; this resource comparison does
not establish whole-renderer fidelity or solve the remaining visibility,
LOD and procedural-texture work.
