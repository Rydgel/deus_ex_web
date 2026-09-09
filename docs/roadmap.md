# Runtime roadmap

Target: original Deus Ex game data running locally in a desktop browser. Preserve
the original levels and behavior as the project progresses. Begin with keyboard
and mouse; mobile support is undecided.

Delivery stays local unless the user requests hosting.

Build an independent browser reimplementation by reverse-engineering the original
game's data formats, script bytecode, and native behavior. The original game is
the compatibility authority. SurrealEngine and other public sources can inform
research, but this project does not depend on their runtime or feature coverage.
Implement missing systems here rather than waiting for another engine to support them.

The first completion target is the original single-player campaign. Multiplayer,
mod compatibility, mobile/controller support, and hosting are separate later scope
decisions; they are not implied by campaign completion.

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
evidence, and limits. Stage 1 used flat inspection lighting; Stage 1.5 adds static
lighting and the required class defaults. Procedural water is static, with no actor
meshes or gameplay. Unknown level tails and property types remain explicitly opaque.
All 88 compiled world models decode, but
visual acceptance currently covers training.

## 1.5. Restore original lighting

**Complete for training's static lighting.** The independent implementation reads
inherited light defaults, original shadow masks and mover polygon lightmaps, and
applies the colour, falloff and brightness behavior checked in the original DLLs.
Training has 5,212 prepared lightmaps, 16,088 shadow masks, zero missing lightmaps
and zero render errors. Two cameras use coordinates read from original save states;
the main shadow patterns and coloured areas match native captures. Six sampled
wall/ceiling/door regions differ by less than three mean RGB levels per channel.
Display brightness is separate from light intensity; an unlit inspection toggle
and explicit unsupported-effect notes remain available. See [lighting evidence](lighting.md).

Reconstruct static surface lighting using the original lightmap metadata, shadow
data, light properties, and any required class defaults. Apply light colour,
brightness, radius, zone ambient light, and relevant surface flags. Retain an
unlit inspection toggle to compare geometry and textures independently of lighting.

Done when fixed-camera views of training reproduce the original game's main
light/shadow patterns, coloured illumination, and dark areas, checked against
reference views from the original game. Unlit surfaces should retain their intended
appearance, and missing lighting support must remain visible in diagnostics.

Script-controlled lights belong with behavior in Stage 3; moving-actor lighting
and remaining dynamic lighting effects belong with the broader renderer in Stage 4.

## 2. Make a small playable slice

**Next milestone.** The inspection camera and pointer-lock input are available;
player simulation, collision, and interaction have not started.

Add pointer-lock input, a fixed simulation step, first-person movement, player
spawn handling, gravity, jumping, crouching, stair stepping, and BSP collision.
Add actor collision and traces needed by the selected interaction. Implement one door or pickup using
the actual map's properties. Use training to constrain the first behavior subset;
use Liberty Island as the next integration map.

Done when a player spawns in the original training map, walks without passing
through ordinary floors/walls, and performs the selected interaction. Browser
reload should reproduce the same initial state.

Before broad gameplay implementation, prototype the script/native execution path
described in Stage 3 to validate our runtime design against original behavior.

## 3. Execute game behavior

Build our own UnrealScript VM and implementations of the native engine and Deus Ex
functions it calls. Analyze original package bytecode, class data, and native code
or observed game behavior as needed. Prototype one representative script/class/native
call path, compare it with the original, and measure memory and loading cost before
expanding coverage. This stage extends our browser runtime; it does not port or
wrap SurrealEngine.

Required systems include class inheritance, default properties, states, events,
timers, latent functions, garbage collection, and native function dispatch.
Resolve imported objects, instantiate native actor/resource types, and implement
object spawning/destruction, references, execution order, and serialization hooks.
Track native calls across the game's engine, UI/extension, and game packages;
package availability alone does not establish native compatibility.
Include script-controlled light switches and lighting changes in behavior coverage.
Deus Ex-specific conversation and UI classes need explicit coverage. Package
script bytecode alone does not replace behavior implemented by the native DLLs.

Done when a documented subset of original game classes executes and its behavior
is compared with the original game. A handwritten door demo alone is not evidence
of general script compatibility.

## 4. Restore the remaining presentation

Decode and render original character, weapon, and prop meshes, skins, animation
sequences, sprites, attachments, and the first-person weapon view. Restore animated
and procedural textures, water/fire effects, particles, decals, sky/fog, mirrors
and other required surface effects. Extend lighting to moving actors and dynamic
effects; compare colours, brightness, and transparency with the original renderer.

Decode sound and music resources and implement positional effects, ambient sound,
speech, and music transitions. Restore fonts, menus, HUD, inventory and conversation
screens, subtitles, readable books/datacubes, and computer/security interfaces.
Respect available text/localization resources and expose audio, display, and input
settings. Implement these pieces alongside the runtime calls and gameplay that use them.

Done when representative scenes reproduce the original animated actors, effects,
sound, text, and interfaces, including synchronized speech and conversation camera
behavior where used. A feature being decoded is not evidence that it renders or plays correctly.

## 5. Implement the full gameplay systems

Expand movement and world simulation to swimming, ladders, water/damage zones,
movable objects, moving doors and elevators, and their collision/trigger behavior.
Implement AI navigation, sight/hearing, stealth, alert states, factions, and security
cameras/turrets/alarms. Connect perception to actual light and sound behavior.

Implement weapons, projectiles, damage/body health, death, inventory/equipment,
consumables, skills, augmentations/energy, lockpicking, electronics, and computer
hacking. Support dialogue choices, trading, objectives, notes, mission flags, and
scripted/cinematic events using original game data and behavior.

Done when training and Liberty Island support representative combat, stealth,
exploration, conversation, and alternate-route objectives, with the systems
interacting correctly. Extend the same compatibility checks as later missions
exercise additional behavior; a single successful route does not cover a mission.

## 6. Persist progress and complete the campaign

Implement game saves, quicksave/load, map transitions, and restoration of previously
visited maps. Persist the player, inventory, skills/augmentations, mission flags,
actors, and object references consistently. Store progress locally in the browser,
with save export/import, format versioning, and clear storage failure handling.
Compatibility with original desktop save files is a separate decision.

Done when reloads and return visits preserve expected world state, and the campaign
can be completed through representative choices and endings without progression
blockers. Validate each mission's conversations, events, and transitions against
the original game; keep a per-mission compatibility checklist.

## 7. Make the browser runtime reliable

Measure loading time, frame time, memory, and audio latency throughout development.
Add visibility/culling, batching, caching, and asset lifetime management where
measurements justify them. Validate supported desktop browsers, graphics capability
errors, resize/fullscreen, pointer-lock loss, pause/tab suspension, audio activation,
local file access, and persistent storage behavior.

Done when declared browser/performance targets pass repeatable tests, long sessions
and repeated map changes remain stable, and failures offer useful recovery paths.
Retain automated format/runtime tests and fixed-camera visual comparisons throughout
the earlier stages; this milestone closes coverage gaps rather than postponing testing.

## Architecture constraints

- Keep game assets outside source control and let users supply their local data.
- Keep an explicit support matrix for package/resource types, native functions,
  gameplay systems, maps, and browsers. Report unsupported behavior in diagnostics.
- Validate each milestone against original-game reference captures and behavior;
  preserve hashes and reproducible camera/input sequences for regression checks.
- Keep binary decoding independent of rendering and DOM code; the initial reader
  already shares one implementation between Node and browser APIs.
- Prefer a narrow, testable slice of original behavior before broad approximations.
- Keep asset loading asynchronous and design for browser memory limits.
- Record package versions, hashes, and external source revisions so failures can
  be reproduced against the same input.
- Keep external engine code as attributed research material rather than a required
  runtime. Public implementations are evidence to check against the original game,
  not a limit on our compatibility targets.
- WebAssembly may be considered for parts of our implementation if measurements
  justify it. That is an implementation choice, not a switch to another game engine
  or an assumption that the Windows binaries can compile to the web.
