# Runtime roadmap

Target: original Deus Ex game data running locally in a desktop browser. Preserve
the original levels and behavior as the project progresses. Begin with keyboard
and mouse; mobile support is undecided.

## 0. Obtain and validate data

Read an installed game directory. Validate all package tables, hash the inputs,
and resolve cross-package object references. Detect missing packages, unsupported
versions, and case differences in Windows filenames explicitly.

Done when `00_Training.dx`, its dependencies, and `DeusEx.u` parse from real data
and the inventory has no unexplained failures. **Complete:** the extracted
installation supplies 219 readable packages (215 at version 68, four at version
61), with no unresolved package dependencies. Data stays in the ignored
`Deus Ex GOTY Edition/` directory.

## 1. Render an original map

Decode tagged object properties, BSP nodes/surfaces/vertices, actor transforms,
texture palettes/mip levels, and basic surface flags. Define and test coordinate,
winding, unit, and UV conversions. Choose a browser renderer after measuring the
decoded geometry. Keep decoding separate from rendering.

Done when the browser renders recognizably correct training-map geometry and
textures from original packages, with an inspection camera and useful diagnostics.
This is a map viewer, before gameplay.

**Complete:** the browser renders original training geometry with 70 textures,
24,427 triangles, and 25 static doors/movers, with no render errors. Drag or
pointer-lock camera controls, map selection, wireframe, actor markers, surface
inspection, and diagnostics work. Local folder selection also works in the
production build without uploading game data. All 23 unit/format tests and five
browser tests pass. The [rendering contract](rendering.md) records conventions,
evidence, and limits: flat lighting, static procedural water, no actor meshes or
gameplay. Unknown level tails and property types remain explicitly opaque;
class defaults have not been applied. All 88 compiled world models decode, but
visual acceptance currently covers training.

## 2. Make a small playable slice

**Next milestone.** The inspection camera and pointer-lock input are available;
player simulation, collision, and interaction have not started.

Add pointer-lock input, a fixed simulation step, first-person movement, player
spawn handling, gravity, and BSP collision. Implement one door or pickup using
the actual map's properties. Use training to constrain the first behavior subset;
use Liberty Island as the next integration map.

Done when a player spawns in the original training map, walks without passing
through ordinary floors/walls, and performs the selected interaction. Browser
reload should reproduce the same initial state.

## 3. Execute game behavior

Choose between extending the browser runtime with an UnrealScript VM and porting
an existing native reimplementation to WebAssembly. Before choosing, prototype
one representative script/class call path and measure memory and loading cost.

Required systems include class inheritance, default properties, states, events,
timers, latent functions, garbage collection, and native function dispatch.
Deus Ex-specific conversation and UI classes need explicit coverage. Package
script bytecode alone does not replace behavior implemented by the native DLLs.

Done when a documented subset of original game classes executes and its behavior
is compared with the original game. A handwritten door demo alone is not evidence
of general script compatibility.

## 4. Expand toward the full game

Implement AI/navigation/perception, combat, items, inventory, skills,
augmentations, conversations, mission flags, audio/music, menus, and HUD. Add
persistent saves and map transitions, then complete whole-mission playthroughs.

Track support per subsystem and mission. Keep unsupported behavior visible in
diagnostics instead of silently ignoring it. Establish performance budgets from
measurements on target browsers before optimizing.

## Architecture constraints

- Keep game assets outside source control and let users supply their local data.
- Keep binary decoding independent of rendering and DOM code; the initial reader
  already shares one implementation between Node and browser APIs.
- Prefer a narrow, testable slice of original behavior before broad approximations.
- Keep asset loading asynchronous and design for browser memory limits.
- Record package versions, hashes, and external source revisions so failures can
  be reproduced against the same input.
- Treat an eventual WebAssembly port as an engineering decision that needs a
  prototype, not an assumption that the Windows binaries can compile to the web.
