# Map rendering contract

The viewer uses the original compiled `Level.Model` and static mover brush models,
decoded in JavaScript and rendered with Three.js/WebGL2. It reads local browser
File objects; Vite offers a loopback-only development adapter. Production contains
only the viewer code and requires the user to choose an installed game directory.

## Coordinates and surfaces

- Keep one scene unit per Unreal unit. Convert source `(X, Y, Z)` to viewer
  `(Y, Z, -X)`: forward becomes negative Z, right becomes positive X, and up
  becomes positive Y. This conversion reflects handedness.
- Align polygon winding with the serialized surface normal, reverse winding for
  that reflection, and discard zero-area triangles. Keep surface IDs for picking.
- For each original point, subtract the surface base point. Dot with the stored
  texture U and V vectors, add the signed surface pan, and divide by that mip's
  width and height. Leave UVs unbounded for texture wrapping. Upload rows without
  a Y flip so the original V direction remains consistent.
- Brush transforms subtract PrePivot, apply MainScale, rotate, apply PostScale,
  and translate by Location. Rotators use 65,536 units per turn. Sheared brushes
  are explicitly unsupported. Lighting now resolves inherited scalar and struct
  class defaults. This does not instantiate the general gameplay object runtime.

Invisible faces are omitted. Masked P8 surfaces make palette index zero transparent
black; palette alpha is otherwise ignored. D3DDrv.dll (`9e0f8a42…d8ac9f`) builds a
per-upload palette in both P8 fillers and, under `PF_Masked`, stores `0` into its
entry zero: `FTexFiller8888_P8::BeginUpload` at `0x10002363` and
`FTexFiller1555_P8::BeginUpload` at `0x100028f4` (`test PolyFlags,2; mov
[AlphaPalette],0`). The colour is therefore black as well as the alpha, so
bilinear filtering darkens masked edges instead of blending in the palette's
own index-zero colour (magenta in most DeusExDeco and fence textures). The
alpha test is `ALPHAREF 127`, `ALPHAFUNC D3DCMP_GREATER` (`0x1000c83a`). The
point-sampled HUD keeps index zero's palette colour with zero alpha instead
(`TextureStore` mode `'point'`): masked HUD styles discard those texels, and
the unmasked styles that share the texture draw the unmasked colour. Two-sided, no-smoothing, translucent screen
blend, and modulated blend flags affect materials. Fake-backdrop openings reveal
an initial pass from the original SkyZoneInfo location. Static lightmaps and shadow
masks are reconstructed as described in [lighting.md](lighting.md). Moving
lights add their texels to BSP and mover light maps in Play, as described in
[dynamic-lighting.md](dynamic-lighting.md). Animated surface textures
(AnimNext chains) advance through the original UTexture Get/Update/Tick
([texture animation](texture-animation.md)); auto-panning (recovered there),
wavy surfaces, fog and dynamic lighting of meshes remain outside the current
renderer. Display brightness follows the original D3D
gamma curve, separately from light intensities. Static translucent horizontal
mirror floors now render reflected views and blend before gamma; see
[original mirror evidence and remaining limits](mirror-surfaces.md). General
gamma handling of other blended surfaces remains presentation work.

P8 palettes and stored mip chains are used directly. RGB565, RGB8, and BGRA8 also
have decoders, covered with synthetic fixtures. Training's WetTexture has empty
stored pixel arrays; its original SourceTexture is displayed statically, and the
missing ripple simulation is reported. Unsupported texture encodings produce
diagnostics rather than substituted artwork.

## Training acceptance evidence

The original `00_Training.dx` is the visual acceptance map. All 71 referenced
world textures decode, including the static source of the procedural water.
After invisible/backdrop faces and degenerate triangles are removed, and static
movers added, the render contains **24,427 triangles, 70 used textures, and 25
moving brushes in their initial positions**, with zero render errors. The model's
25,674 diagnostic triangles are a different count: world only, including
degenerate fans and backdrop polygons.

The viewer starts 40 Unreal units above PlayerStart1, using zero rotation when no
stored rotation exists. The field of view is 75 degrees horizontally. This is an inspection-camera convention, not emulation
of the player's collision cylinder or class defaults. WASD/arrow keys fly, Q/E
move down/up, Shift increases speed, dragging looks around, and double-click
requests mouse lock. Escape releases it. Player start resets the camera.

Diagnostics expose counts, original texture paths, mip dimensions, source surface
IDs, flags, actor positions, wireframe, lighting/brightness controls, a reference
camera form, and unsupported data. The training level
still has 23 opaque trailing bytes and 1,364 opaque actor properties. Actor meshes,
characters, dynamic lighting, reflections, collision, physics, scripts, animation, and gameplay
are outside this milestone. Other maps are selectable, but visual acceptance
currently covers training; decoding all 88 maps does not establish rendering
compatibility for the full game.

## Validation

```sh
npm ci
npm test
node scripts/validate-game.mjs > reports/map-validation.json
node scripts/validate-viewer.mjs > reports/stage1-validation.json
npm run build
npx playwright install chromium firefox
npm run test:browser
```

Create `reports/` first. The 34 unit/format tests cover binary boundaries,
properties, class defaults, bytecode traversal, lighting and shadow math, mover
polygons, atlas padding, coordinates, UVs, winding, transforms, palettes, and mips.
Real-data validation checks all 88 world models plus training's texture and mover
geometry. Browser tests exercise a rendered training map, camera movement/reset,
diagnostics, map switching, local folder selection, error recovery, static lighting,
unlit preservation, reference cameras, brightness controls, and the absence
of game-data network requests in production. Mouse-lock testing uses a focused,
headed browser because macOS headless Chromium rejects pointer lock; it requires
a desktop session. Native browser WebMCP support is optional. Its four registered
handlers are contract-tested using a mock capability, not claimed as native support.

Screenshots and JSON evidence are local under `reports/`, excluded from Git and
deployment. Browser observations are not a performance guarantee; performance
budgets and broader browser coverage remain to be established.

## References

Binary layouts were checked against SurrealEngine, reference revision
`7bc5a89cbc22254f89d18b040b94ef0c37d44cf2`, especially
[UTexture](https://github.com/dpjudas/SurrealEngine/blob/7bc5a89cbc22254f89d18b040b94ef0c37d44cf2/SurrealEngine/Packages/Engine/Resources/Textures/UTexture.cpp),
[UPalette](https://github.com/dpjudas/SurrealEngine/blob/7bc5a89cbc22254f89d18b040b94ef0c37d44cf2/SurrealEngine/Packages/Engine/Resources/UPalette.cpp),
and the Model and UObject links in [extracted-data.md](extracted-data.md).
Rendering uses [Three.js DataTexture](https://threejs.org/docs/#DataTexture)
and BufferGeometry. SurrealEngine is a format reference, not a linked runtime.
