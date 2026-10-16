# Player alterations and the viewport flash

Stage 4 item (2026-10-15): drunk, drugs, poison and the other alterations the player's scripts apply, and the
full-screen flash the original draws for them (damage, zone tints, underwater). Authority: the retail GOTY
DeusEx.u/Engine.u bytecode (`scripts/dump-script-function.mjs`), `.cache/reference/*.uc` where it has the class,
and the unchanged Engine.dll / D3DDrv.dll / Extension.dll bodies cited below.

## Census (step 1)

`scripts/census-player-alterations.mjs` (`scripts/validate-player-alterations-census.mjs` runs it) gives the player each
effect the way the game does and plays it for a few seconds of Level time through Play's own frame (tick, sprite scan,
HUD draw), headless, one session per map. Items (`item`) are the map's own pickups frobbed, put in hand with the digit
key User.ini binds to `ActivateBelt` and used with the left mouse button; a thrown weapon (`throw`) is picked up the same
way and fired for ten frames; `hit` is the `TakeDamage(Damage, Instigator, HitLocation, Momentum, DamageType)` call every
damage source makes into the player (`Cloud.Timer`, `DamageTrigger`, `HurtRadius`, a projectile), made on the player's
own bytecode: the sources themselves (a Greasel's spit, a dart, a flame) are not simulated. A paused scenario's session
is built again (a pause leaves the runtime unusable; Player start is the way out in Play). `EXPECTED` in the script is
the outcome of the last run and the script fails when a scenario differs, so a regrown boundary cannot go unnoticed and
a fixed one must be recorded. Run it as `node scripts/census-player-alterations.mjs [--only id,id] [--json out]` (8 GB
heap, about 8 minutes).

| Effect (scenario) | Map | Stopped at before 2026-10-15 | Now |
| --- | --- | --- | --- |
| drink wine, 40oz liquor, liquor bottle, take Zyme (`drink-wine`, `drink-liquor40oz`, `drink-liquor-bottle`, `take-zyme`) | Island, Bar, Hotel | `Window.SetBackgroundSmoothing` (native 1423, exec `0x10051dc0`) in `DeusExPlayer.DrugEffects` | plays: `drugEffectTimer` +5 / +10 / +5 / +60, FOV and ViewRotation sway, DrunkFX background (below) |
| poison (`hit-poison`: `StartPoison` adds 4 s to `drugEffectTimer`, four `PoisonEffect` ticks) | Island | the same native, from `DrugEffects` | plays |
| tear gas grenade, EMP grenade (`tear-gas-grenade`, `emp-grenade`; both summoned: Island holds no such pickup) | Island | `Actor.HurtRadius` in the thrown projectile's `Explode`: `foreach VisibleCollidingActors` = iterator native 312, exec `0x103e55b0` (`Original iterator native is not implemented: 312`) | plays: `HurtRadius` runs through the translated iterator 312 (below); the explosion's flash (peak 2.06 scale, fog 0.69) and EMP `EnergyDrain` are computed |
| cigarettes (5 `PoisonGas` damage, smoke puff, cough), ambrosia (message only) | Island, Ship | plays | plays |
| `TakeDamage` of PoisonGas, TearGas, Radiation, HalonGas, Flamed (CatchFire, burning), Burned, Drowned, EMP (EnergyDrain), Shocked, Shot (bleeding, BloodDrop spawns) | Island | plays | plays |

"Plays" means no pause. Every scenario computes the flash in script (`ClientFlash` adds to `DesiredFlashScale` and
`DesiredFlashFog`, `ViewFlash` integrates `FlashScale` and `FlashFog` each tick; the census records the peaks) and until
this work **none of it was drawn**: nothing in Play read `FlashScale`/`FlashFog` or drew D3DDrv's `EndFlash`.

Outside the census: the player in water. "The player (JC) has no swimming path: runPlayerPhysics refuses water regions"
([swimming](swimming.md#unsupported-and-unresolved)), so drowning and the underwater tint from walking in cannot be
reached; the zone tint is reachable with `ghost` (the capture scripts' camera). Pain zones (Radiation, Burned, HalonGas,
Shocked, bPainZone) and `DamageTrigger` are not scenarios yet. `summon` of a class no actor of the map loaded (`VialCrack`
on Island) pauses in `Object.castObject` (`Class-object ancestry is not prepared`: DynamicLoadObject returns a class
object without a linked class); no player reaches an item the map does not hold, so the census takes each class from a
map that holds it.

## Script side

Scripts (DeusEx.u / PlayerPawn.uc):

* `DeusExPlayer.DrugEffects(deltaTime)` (bytecode dump; `.uc` 1272): with `drugEffectTimer > 0` the HUD root window's
  `HUD.SetBackground(Texture'Effects.UserInterface.DrunkFX')` (natives 1421), `SetBackgroundSmoothing(true)` (1423),
  `SetBackgroundStretching(true)` (1424), `SetBackgroundStyle(4)` (1422, DSTY_Modulated) once; `mult = FClamp(timer / 10, 0, 3)`;
  `ViewRotation += (1024 cos(t mult) dt mult, 1024 sin(t mult) dt mult, 0)` clamped to +-4096; standalone,
  `DesiredFOV = FClamp(Default.DesiredFOV - timer + Rand(2), 30, Default.DesiredFOV)`; the timer counts down by dt. At zero
  the background is cleared and `DesiredFOV` restored. `PlayerPawn.uc` 2831 moves `FOVAngle` toward `DesiredFOV`; Play's
  camera reads `FOVAngle` (`game.mjs` PlayerCalcView), so the FOV change already reaches the frame.
* Sources of `drugEffectTimer`: `WineBottle` +5 and `HealPlayer(2)`, `Liquor40oz` +10 and `HealPlayer(2)`, `LiquorBottle` +5,
  `VialCrack` (Zyme) +60 and `HealPlayer(-10)`, `StartPoison` +4 (damage type `Poison`, four `PoisonEffect` ticks every two
  seconds), `DXReduceDamage` -4 at full gas protection. `Cigarettes` deals 5 `PoisonGas` damage (no poison).
* The flash: `ClientFlash(scale, fog)` (`DesiredFlashScale += scale; DesiredFlashFog += 0.001 fog`), `ViewFlash` (DeusEx
  override `.uc` 10165: `goalScale = 1 + DesiredFlash + ConstantGlowScale + HeadRegion.Zone.ViewFlash.X`, `goalFog =
  DesiredFlashFog + ConstantGlowFog + HeadRegion.Zone.ViewFog`, `FlashScale.X += (goalScale - FlashScale.X + InstantFlash) *
  10 dt` with dt <= 0.1, the desired values decaying by 2 dt (0 during `FlashTimer`), `FlashScale = FlashScale.X * (1,1,1)`,
  `FlashScale.X` above 0.981 becomes 1, `FlashFog` components under 0.019 become 0), `PlayDXTakeDamageHit` (a flash of
  `FClamp(Damage, 20, 100) * 0.002` with the fog of the damage type: Burned/Flamed (200,100,100), Radiation (100,100,0),
  PoisonGas (50,150,0), TearGas (150,150,0), Drowned (0,100,200), EMP (0,200,200), others (50,0,0)), `DXReduceDamage`
  `ClientFlash(0.01, (0,0,50))` on reduced damage. The DeusEx script is bit-for-bit what Play already ran.

## Engine side: how FlashScale and FlashFog reach the device

`UGameEngine::Draw` (Engine `0x1038f110`, [render-pass precision](render-pass-precision.md#where-the-pass-begins-and-ends)):

* `0x1038f36e..0x1038f54e`: `useActor = Level.NetMode != 0 || Client.ScreenFlashes` (ALevelInfo `+0x518`, UClient `+0x44`;
  DeusEx.ini `[WinDrv.WindowsClient] ScreenFlashes=True`). With it, the viewport actor's `FlashScale` (`APlayerPawn+0x610`)
  times `0.5f` (`fmuls 0x10426d74`) and `FlashFog` (`+0x61c`); without it the neutral `(0.5,0.5,0.5)` and `(0,0,0)`. Each of the six
  components is clamped (`fcomps 0.0` C0 -> 0, `fcomps 1.0` not below -> 1.0; NaN -> 0), the planes' W is zero. They go
  through `UViewport::Lock(FlashScale, FlashFog, ...)` (`0x1038f59a`) into the render device (D3DDrv keeps them at
  `this+0xa48` and `+0xa58`).
* `0x1038f70c` the `PostRenderFlash` event (PlayerPawnExt: PostRenderWindows paints the HUD windows), **`0x1038f714`
  `RenDev->EndFlash()` (vtable `+0xa4`, D3DDrv `0x10001064` thunk to `0x10007c90`)**, `0x1038f73e` the `PostRender`
  event, the console's PostRender. The first-person weapon is drawn earlier, in DrawWorld's `RenderOverlays`. So the flash
  covers the world, the weapon and the HUD, and is the last pixel work before the buffer is shown; the display gamma ramp
  maps the finished frame including it.

`UD3DRenderDevice::EndFlash` (`0x10007c90..0x100080ab`):

* Gate: skip when `FlashScale.xyz` are the bit pattern `0x3f000000` (0.5f), `FlashScale.w == 0` and all four `FlashFog`
  components compare equal to `0.0` (`fcomps 0x100188e4`).
* Colour: alpha = `min(2 * FlashScale.x, 1.0)` (`fadd st,st`, `fcoms 1.0`); each of A, R (FlashFog.x), G, B is `v * 256.0f`
  stored as a float, `- 0.5f`, `fistp` (round to nearest even) and clamped to [0, 255] (`appFloor` as `ftol(x - 0.5)`: an
  exact byte-valued product `n` lands on `n - 0.5` and rounds to the even neighbour, so 25/256 gives 24 and 26/256 gives 26).
  D3DCOLOR = A<<24 | R<<16 | G<<8 | B.
* Quad: four vertices of 36 bytes `(0,0) (0,SizeY) (SizeX,SizeY) (SizeX,0)`, z = `z43 * 0.5 + z33`, rhw 0.5, the colour,
  from the vertex buffer's cursor (`this+0xd0`, then +4; a cursor past `0x1f40` discards the buffer, Lock flags `0x2800`
  instead of `0x1800`). Device state: `SetBlending(0x47)` then ALPHABLENDENABLE on, SRCBLEND ONE (2), DESTBLEND SRCALPHA (5),
  texture stage 0 COLOROP DISABLE and ALPHAOP SELECTARG2, ZFUNC ALWAYS, `DrawPrimitiveVB(TRIANGLEFAN, vb, cursor, 4)`, then
  COLOROP/ALPHAOP restored from `this+0xa00/0xa04`, ZFUNC LESSEQUAL, `SetBlending(0)`.
  The frame becomes `fog + frame * alpha` per channel on the unmapped back buffer.

## Verification

| Piece | Evidence |
| --- | --- |
| `Window.SetBackgroundSmoothing` (1423): `src/runtime/script-window-background-style.mjs` | `scripts/validate-window-background-smoothing.mjs`: 350 cases (window flags, XGC flags, int arguments, null and non-null XGC) equal to Extension.dll `0x1004d700` + `0x100270e0` run in Unicorn (raw access order, final fields, `GeneratePolyFlags` leaf calls) |
| `EndFlash`: `src/runtime/screen-flash.mjs` `endFlash` | `scripts/validate-d3d-endflash.mjs`: 67 cases equal to D3DDrv.dll `0x10007c90` under a stubbed COM device: the gate, every device call and its arguments in order, the four 36-byte vertices, the cursor and discard; includes the byte-valued ties; a mutant using `floor` fails |
| `ActorRadiusCheck`: `src/runtime/collision-hash-radius.mjs` | `scripts/validate-native-hash-radius.mjs`: 218 queries equal to Engine.dll `0x103589e0` (cells, hit order) |
| `viewportFlash` (Draw's derivation) | disassembly only (`0x1038f36e..0x1038f54e`), not executed natively: the formula is pinned by `validate-d3d-endflash.mjs` unit checks; the NetMode/ScreenFlashes gate assumes standalone with `ScreenFlashes=True` |
| The pass in Play: `src/viewer/flash-pass.mjs`, snapshot field `hud.flash` (`sim-session.mjs`) | `scripts/validate-flash-play.mjs` (worker mode): neutral flash leaves the frame unchanged, a fog/scale state tints it |
| The pass against the original's frames | Stage 4 gate row 4.2.26 (`frames 00_Training [flashA]`, `[flashB]`): two held states, the flash's per-channel map of levels equal to the running original's at all 369 (channel, level) pairs; [below](#against-the-original-2026-10-16-gate-row-4226) |

## Against the original (2026-10-16, gate row 4.2.26)

Held frames of the running original under CrossOver on the Mac (`scripts/original-views.sh`, which now runs there, and `visual-acceptance.mjs original`) against
Play's (`play`, worker mode, `?antialias=0&detailTextures=0`) at the same camera, Training's corridor `-100,840,30` looking down +x, and the same level time.

* **Holding a flash.** A written `FlashScale`/`FlashFog` moves back toward its goal every tick, so the state is held through the goal: both programs run
  `set DeusEx.JCDentonMale ConstantGlowScale s` and `ConstantGlowFog (X=..,Y=..,Z=..)` at the camera (`--pre-shot-cmd`) and wait 5 s (`--pre-shot-wait 5000`;
  300 page frames in Play). `original --player-state` reads the player's `FlashScale` (`+0x610`) and `FlashFog` (`+0x61c`) after the shot into
  `<view>-state.json`: the scale read 0.500000596 for a goal of 0.5, so the approach had converged.
* **The fog cutoff at a held tick (measured).** `ViewFlash` sets each `FlashFog` component under 0.019 to 0 after the step (`.uc` 10206), and at the held
  level's TimeDilation 0.001 the step is fog x 10 x 0.005 s: a fog goal under 0.38 never leaves 0. The first state's fog (0.3,0.1,0) read back (0,0,0)
  from the original, and Play's frame shows none either (the flash maps below are equal). By the same rule (derived, not measured) a scale goal above
  0.62 snaps back to 1 at a held tick: the first step `1 + (g - 1) / 20` stays above 0.981.
* **Brightness 2/3.** The Shot bakes the Brightness ramp into its bitmap; at 2/3 it is the identity and the bitmap is the framebuffer
  ([visual acceptance](visual-acceptance.md#main-views-at-brightness-23)), and Play's ramp at 0.4 is the identity. The flash is `fog + frame * alpha` in
  framebuffer levels, which any other ramp would bend.
* **The comparison.** The Shot includes the flash (the frame halves at scale 0.5). `compare --flash-base flash0` reads each program's flash as a per-channel
  map of levels, the output level in the frame with the flash for every input level of the same program's frame without it (`flash0`, a capture of its
  own), and compares the original's map with Play's where both frames hold the level. What the two programs draw differently in the scene drops out.

| State | Read back from the original | Fog bytes, alpha | The original's map (levels 0 to 154 held) | Equal (channel, level) | Stray samples, original / Play | Frame: edges, outlier blocks |
| --- | --- | --- | --- | ---: | ---: | --- |
| `flash0`: none (50.800 s) | scale 1, fog 0 | none | - | - | - | 1 / .999, 0 (32 before [the screen clear](#the-screen-clear-fixed-2026-10-16)) |
| `flashA`: `ConstantGlowScale -0.5`, `ConstantGlowFog (0.3,0.1,0)` (51.001 s) | scale 0.500000596, fog 0 | (0,0,0), 128 | v to round(v x 128/255): 1, 2 to 1, 3 to 2, ..., 152 to 76, 153 to 77 | 369 / 369 | 0 / 0 | .999 / .999, 0 (32 before the screen clear) |
| `flashB`: `ConstantGlowScale 0`, `ConstantGlowFog (0.6,0.45,0.4)` (50.427 s) | scale 1, fog (0.599999428, 0.44999969, 0.399999738) | (153,115,102), 255 | v to min(255, fog + v); 54, 4 and 2 saturated pixels | 369 / 369 | 0 / 0 | 1 / .999, 0 |

A Play frame without the flash against `flashA` differs at 363 of the 369 levels. The gate (`frames 00_Training [flashA]`, `[flashB]`, `flashBase`) plays
`flash0` once and each state in its own run, judges `flash0` and the state as frames, and fails on any differing level or stray sample.

What this does not cover: levels above the frame's (154 here), the DrunkFX HUD background (`ShowHud False` hides the HUD; it is another draw), a zone's
`ViewFog`/`ViewFlash` as the source (the goal is the same sum, but the ghost camera's `set Location` does not move `HeadRegion`), a flash in motion (a
damage flash decays over ticks) and a Windows D3D driver: both blends ran on the M2, the original's under CrossOver.

### The screen clear (fixed 2026-10-16)

Found by `flash0`: in the band above the corridor (rows 0 to about 195) Play drew nothing and showed the page's canvas colour, `canvasClear` `#06101b`
(`main.mjs`), which three.js takes to linear light and `rawClear` writes raw: (0,1,3) on 242,417 pixels, 242,415 of them black in the original. That was
32 outlier blocks in every frame of that view at Brightness 2/3. What the original does there, from the retail binaries (capstone over the GOTY
`Engine.dll` and `D3DDrv.dll`):

* `UGameEngine::Draw` locks the viewport once per frame, `UViewport::Lock(FlashScale, FlashFog, ScreenClear, LockFlags, HitData, HitSize)` through vslot
  `0x60` at `0x1038f59a`. `ScreenClear` is built in place by Core's `FPlane::FPlane(float,float,float,float)` (`??0FPlane@@QAE@MMMM@Z`, import
  `0x10599b7c`) from four pushed zeros (`0x1038f564..0x1038f56c`). `LockFlags` is `[ebp-0x44] | 1` (`or al, 1` at `0x1038f557`), where `[ebp-0x44]` is 0
  or 1 from the result of the call at `0x1038f266` (vslot `0x54`, not identified; it cannot clear the bit). So bit 0, `LOCKR_ClearScreen` (= 1 in the SDK's `UnRenDev.h`), is set on every frame.
* `UD3DRenderDevice::Lock` (thunk `0x100010e1` to `0x10002fb0`) stores `LockFlags` at `this+0xa68`, `FlashScale` at `+0xa48` and `FlashFog` at `+0xa58`.
  It then calls `IDirect3DDevice7::Clear(0, NULL, flags, colour, 1.0f, 0)` (vslot `0x28`, `0x100031c5`) with flags 3 (target and Z) when `+0xa68` bit 0
  is set, 2 (Z only) otherwise (`0x100030b5..0x100030ca`). The colour is `ScreenClear`, each component `v * 256.0f - 0.5f` and `fistp`, clamped to
  [0, 255] (constants `0x10018554` = 256.0 and `0x1002a898` = 0.5), packed `R<<16 | G<<8 | B`: 0x000000.

So every pixel the frame leaves undrawn is black, before the ramp, which keeps 0 at 0. Play's frames now clear as the device does: a Play frame clears
to black, and an Inspect frame keeps the page's colour (`drawFrame` in `main.mjs`, by the frame's `playing`). `flash0` then reads mean absolute
difference 0.00, the three channel means equal, 0 outlier blocks. 10,898 pixels (1.2%) still differ, mostly by one level and at most by 22: the scene,
not the clear. The gate judges `flash0` as a frame, so the clear is held by row 4.2.26. Not checked here: child frames (mirrors, camera windows), which
clear in their own passes.

## Iterator 312 (`VisibleCollidingActors`): done 2026-10-15

`Actor.HurtRadius` (`bIgnoreLOS` false) runs `foreach VisibleCollidingActors(Actor, Victims, DamageRadius, HitLocation)` for every
grenade, rocket and explosion. Exec `0x103e55b0` (thunk `0x103016d1`): arguments `BaseClass` (null becomes Actor), out `Actor`,
`Radius` (omitted or 0.0 becomes 1000.0f), `Loc` (default the caller's Location, `+0x114`), `bIgnoreHidden`; the list is
`Level.Hash->ActorRadiusCheck(GMem, Loc, Radius, 0)` (`XLevel+0xf8`, vtable slot `+0x18`, body `0x103589e0`); per candidate:
`IsA(BaseClass)`, not hidden when `bIgnoreHidden` (`Actor+0x28` bit 2), and `Level.Model->FastLineCheck(actor.Location, Loc)`
(UModel `0x10301a37`); the first passing candidate is the out value and the next resume goes on down the list.
`ActorRadiusCheck` (`src/runtime/collision-hash-radius.mjs`): the cell box `(v -/+ r + 32768) * 1/256` per axis (X on the x87 stack
until the float32 store, Y and Z stored first), FISTP, clamped to [0, 0x3fff]; the hash walk X outer, Z inner; a hit when
`dx*dx + dy*dy + dz*dz < r*r` strictly, the sum extended and `r*r` a float32; results prepended (reverse visiting order).
Compared with the unchanged body by `scripts/validate-native-hash-radius.mjs` (218 queries on the original's permutation tables
and the seed-independent domain: cell boxes and hit list order, including the strict tie at exactly 100 units). The iterator
(`createVisibleCollidingActorsIterator`, `script-iterators.mjs`, routed in `script-runtime.mjs`) is the exec's argument and filter
order; its integration is checked by the census rows `tear-gas-grenade` and `emp-grenade` (both play), not by an oracle of the
exec body itself (open: an exec-body differential with a native hash fixture).

## Not done, in order

1. **Comparison with the original** (step 5): **the pass, done 2026-10-16** ([above](#against-the-original-2026-10-16-gate-row-4226): two held
   states, the multiply and the additive branch, the GL blend's 8-bit result equal to the original's at every level the frame holds, on the M2).
   Still open: a zone's tint as the source (a `ghost` camera in a `WaterZone` with `ViewFog`, e.g. 02_NYC_Underground, needs `HeadRegion` moved
   by a real move), a drunk or poisoned frame (the DrunkFX background with the HUD shown, the view sway) and a decaying damage flash.
2. The DrunkFX background (modulated tile over the whole HUD) draws through the existing HUD renderer's DSTY_Modulated
   path; its look has not been compared with the original. **Fixed 2026-10-16:** DrunkFX is a Fire.dll WetTexture and the HUD
   renderer drew its stored mip, which Serialize leaves zeroed, so the modulated tile (2·src·dst) turned the whole frame black for
   as long as `drugEffectTimer` ran (wine, liquor, Zyme, a poison's four seconds). The HUD now draws a Fire or Wet texture from the
   page's live procedural set (procedural-textures.mjs), as BSP surfaces, mesh skins and sprites do.
3. Pain zones and `DamageTrigger` scenarios, the underwater tint scenario, player swimming and drowning
   ([swimming](swimming.md#unsupported-and-unresolved)); the sources of poison and fire themselves (Greasel spit, darts,
   flamethrower flames); `summon` of a class the map did not load.
