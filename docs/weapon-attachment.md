# Third-person weapon attachment (Stage 4)

Started 2026-10-15. An armed pawn holds its gun in the original; Play drew nothing
([visual acceptance](visual-acceptance.md), Divergence 21). This note records, before
any translation, how the original draws it, from the hash-pinned Render.dll
`607f1077…d75d1`, Engine.dll `0c3a8b18…c20b4` and Core.dll `8bf3039e…ba7e4`, and from a
debugger on the running game (`tools/dx-live-win.c weapon`).

**Summary.** The weapon is not drawn as an actor. `URender::DrawActorSprite` draws the
**pawn** and, inside the same call, the pawn's `Weapon`: the weapon's `ThirdPersonMesh` is
swapped into its `Mesh`, and `DrawMesh` poses it with Coords built from the pawn's own
mesh. The pawn's mesh carries **special vertices** (an invisible triangle, `SpecialFaces(0)`
of the LodMesh); `DrawLodMesh` turns that triangle's camera-space positions into the hand's
coordinate frame and leaves it in a global. The weapon's own `bHidden`, `bOnlyOwnerSee`,
`Location` and `Rotation` play no part (its `Location` is added to the Coords and GetFrame
subtracts it again). The block runs for every pawn drawn in every frame that draws it
(the main frame, each mirror's child frame), whatever the weapon's visibility flags.

## Addresses (Render.dll unless named)

### 1. The pawn's draw and the hand coordinates

| Where | What |
| --- | --- |
| `DrawActorSprite` `0x10b25080`; the pawn's `DrawMesh` call `0x10b25624` | the actor is the sprite's (`[sprite+0x94]`); its `ScaleGlow`, `DrawScale`, `Location` and `Rotation` are replaced by the sprite's snapshot for the call (`0x10b255b8..0x10b255f4`) and restored (`0x10b25629..0x10b25669`); Coords = `Frame+0x34` |
| `DrawLodMesh` `0x10b0ea80`, clear `0x10b0f1b7` | `[0x10b4eb10] = 0` (the hand flag) on every LodMesh draw, after the outcode loops |
| `0x10b0ef6e..0x10b0f095` | the outcodes of the `SpecialVerts` (`mesh+0x184`) vertices, which are the **first** `SpecialVerts` records of the 0x58-byte vertex array (GetFrame's output: special vertices first, then the model's); `[ebp-0x40]` starts at `0x3c` and is ANDed with each outcode |
| `0x10b0f1c3` | `jne 0x10b0f44f` when that AND is not zero (all special vertices outside one plane): no hand |
| `0x10b0f1c9..0x10b0f20c` | `SpecialFaces.Data` is `mesh+0x174`; its first face's three `u16` are indices **into the vertex array** (A, B, C); skipped when `out(A) & out(B) & out(C)` is not zero |
| `0x10b0f212..0x10b0f44d` | the hand coordinates, below; stored by `rep movsd` into the 12 floats at `0x10b4ea08`, `[0x10b4eb10] = 1` (`0x10b0f443`) |

The hand coordinates (every operation one binary32 operation: the render pass runs at x87
precision control 24, [render-pass precision](render-pass-precision.md)):

```
X = (B - A).SafeNormal()                      Core FVector::SafeNormal 0x10144be0
Y = (X x (A - C)).SafeNormal()                products 0x10b0f2ad..0x10b0f2e9, stored as floats
Z = Y x X                                     0x10b0f31c..0x10b0f379
M = (A + C) * 0.5                             0x10b0f38e..0x10b0f3e2 (sums stored, 0.5 at 0x10b2a5c8)
hand = FCoords(Origin = -M, unit axes) *= FCoords(Origin 0, X, Y, Z)     Core FCoords::operator*= (0x1011a710)
```

`SafeNormal` returns the zero vector when `x*x + y*y + z*z` (rounded to 24 bits) is below `1e-8`
(the double at Core `0x101765d8`), else the vector times `1.0 / sqrt(sum)` (the double `1.0` at
`0x101765a8`, `appSqrt` = `fld; fsqrt`). `FCoords *= FCoords` is the transform the GetFrame port already uses
(`(d.x*A.x + d.y*A.y) + d.z*A.z` per axis, the origin less the other's origin). The result is the camera
frame **in the hand's coordinates**: the form GetFrame takes its `Coords` in (camera space in, the weapon mesh's
model space the hand frame).

### 2. The weapon's draw

All of it is inside `DrawActorSprite`, after the pawn's own draw and the restore of its snapshot:

| Where | What |
| --- | --- |
| `0x10b2565b..0x10b2566f` | `je 0x10b25cab` (nothing more) when `[0x10b4eb10]` is zero |
| `0x10b25675..0x10b25694` | the actor's class chain must reach `APawn` (`0x10b5d698`); otherwise `0x10b25cdc` |
| `0x10b2569a..0x10b256ab` | `weapon = Pawn.Weapon` (`+0x3d0`); none: `0x10b25cdc` (the selected item, below) |
| `0x10b256b1..0x10b256bd` | **`weapon.Style = pawn.Style`** (`+0x165`), the old byte kept in `[ebp-0x11]` and restored at `0x10b25c7b` |
| `0x10b256c3..0x10b256ce` | `ThirdPersonMesh` (`+0x36c`) zero: skip the weapon and its flash, go to `0x10b25a74` |
| `0x10b256d4..0x10b25706` | **swap** `Mesh` (`+0x174`) with `ThirdPersonMesh`, `DrawScale` (`+0x17c`) with `ThirdPersonScale` (`+0x370`) |
| `0x10b25702..0x10b2570c` | **`weapon.Rotation = (0, 0, 0)`**, not restored |
| `0x10b2571a`, `0x10b25734` | **`Frame.Mirror` (`+0x20`) saved and set to `1.0`** for the weapon (restored at `0x10b25a68`): faces are not reversed in a mirror's child frame |
| `0x10b25729..0x10b25775` | Coords = `[0x10b4ea08]` copied, `FCoords::operator/= (FRotator)` (Core `0x1011b690`) by the zeroed Rotation (three identity matrices), then **the weapon's `Location` added to the origin**, each sum stored as a float (GetFrame subtracts `Location + PrePivot` again) |
| `0x10b257a2`, `0x10b26230` | poly flags: `actor poly flags(Frame, weapon)` ([mesh lighting](mesh-lighting.md)): Style (the pawn's), `bNoSmooth`, `bMeshEnviroMap`, `bMeshCurvy`, `bUnlit`, `ZoneNumber`, `UClient.NoLighting` of **the weapon** |
| `0x10b257da` | `DrawMesh(Frame, weapon, **pawn**, Span, pawn.Region.Zone, Coords, LeafLights, Volumetrics, PolyFlags)`: the actor is the weapon, the **light sink is the pawn** (SetupForActor takes its location, leaf, zone and `ScaleGlow`/`AmbientGlow` from the pawn), the `Span`, `LeafLights` and `Volumetrics` are the pawn's sprite's |
| `0x10b257df..0x10b25815` | the swaps undone (Mesh, DrawScale) |

**Muzzle flash**, `0x10b25815..0x10b25a4e`, with the weapon still the one just drawn (`Inventory` fields:
`bSteadyFlash3rd` bit 0, `bFirstFrame` bit 1, `bMuzzleFlashParticles` bit 2, `bToggleSteadyFlash` bit 3,
`bSteadyToggle` bit 4 of `+0x39c`; `FlashCount` `+0x3a0`, `OldFlashCount` `+0x3a1`, `MuzzleFlashStyle` `+0x3a2`,
`MuzzleFlashMesh` `+0x3a4`, `MuzzleFlashScale` `+0x3a8`, `MuzzleFlashTexture` `+0x3ac`):

1. `bSteadyFlash3rd` set: `bSteadyToggle ^= 1` (`0x10b25819..0x10b25824`).
2. The flash is drawn when `bSteadyFlash3rd` and (`!bToggleSteadyFlash` or `bSteadyToggle`) (`0x10b25830..0x10b2583a`), or when
   `!bFirstFrame` and `FlashCount != OldFlashCount` (`0x10b2583c..0x10b25852`), and `MuzzleFlashMesh` is set.
3. Swapped into the weapon: `Mesh` with `MuzzleFlashMesh`, `DrawScale` with `MuzzleFlashScale`, `Style` with
   `MuzzleFlashStyle`, `Texture` (`+0x16c`) with `MuzzleFlashTexture`; `AnimSequence` (`+0x54`) set to the name index `0x16b`,
   **`AnimFrame` (`+0x58`) set to `appFrand()`** (`call [0x10b5d54c]` at `0x10b258e1`: one draw of the CRT stream the scripts use),
   `bUnlit` forced on and `bParticles` (`+0x194` bit 2) set from `bMuzzleFlashParticles`.
4. Coords as for the weapon (`0x10b25911..0x10b2598b`: the hand coordinates divided by the zero rotation, the Location added),
   poly flags again, `DrawMesh` (`0x10b259c3`), and everything restored (`0x10b259c8..0x10b25a48`: `bParticles` cleared,
   `bUnlit`, `AnimSequence` and `AnimFrame` as they were).
5. Whatever was drawn: `bFirstFrame` cleared and **`OldFlashCount = FlashCount`** (`0x10b25a4e..0x10b25a6e`), `Frame.Mirror`
   restored, and `Style` restored at `0x10b25c7b`.

**The weapon draw writes script-visible state** (not restored): `Rotation` (to zero, every frame the weapon draws),
`bSteadyToggle`, `bFirstFrame`, `OldFlashCount`.

### 3. Other items the pawn can hold

* **No `Weapon`, a `SelectedItem`** (`Pawn+0x3d8`, `0x10b25cdc..0x10b261ac`; implemented, see "Held items" below): the same swap of `ThirdPersonMesh` and
  `ThirdPersonScale`, the Style copy, Rotation zeroed, `Mirror` 1.0, but the Coords go through three rotation
  FCoords built inline from the item's (zeroed) Roll, Pitch and Yaw and the sine table (Roll by `FVector::TransformPointBy/TransformVectorBy`, Pitch and Yaw by
  `FCoords::operator*=`: identity matrices with the signed zeros their construction carries) before the Location is added; no muzzle flash, and the only state it writes is the
  zeroed Rotation. A `DeusExPlayer` holding a tool or an item with no weapon (`UpdateInHand` sets `SelectedItem = inHand`; a weapon sets `Weapon` as well, and then
  only the Weapon is drawn) shows it this way in a mirror.
* **`Pawn.PlayerReplicationInfo.HasFlag`** (`0x10b25a74..0x10b25c6d`, `Pawn+0x558` then `+0x354`): a Capture-the-Flag flag
  carried at the pawn's location with a rotation by `Pawn+0x3f4`: multiplayer. The earlier note of this as "the carried
  decoration" was wrong (DeusExPlayer.CarriedDecoration is not read by Render.dll). Multiplayer is out of scope here.
* After all of it (`0x10b25c70..0x10b25ca8`) `Pawn.Shadow` (`+0x55c`, an `ADecal`) gets its script event `Update`
  (`ENGINE_Update`, `0x10b25c97`); the decal path is already in Play ([decals](decals.md)).

## What the original draws, measured

`wine ad/build/dx-live-win.exe weapon <seconds>` (`tools/dx-live-win.c`) is a debugger on the running DeusEx.exe with breakpoints at
`0x10b256a3` (the `Pawn.Weapon` read), `0x10b0f212` (the special vertices), `0x10b0f44d` (the hand coordinates; the breakpoint is on a
`rep movsd`, so it fires once per word and only the first of each run of 12 holds the whole frame), `0x10b257da` (the weapon's `DrawMesh`) and
`0x10b259c3` (the flash's). One JSON line per hit; `scripts/weapon-original-cases.mjs` pairs them into cases.

**01_NYC_UNATCOIsland**, the view of the live-scene pilots (`CheatView DeusEx.Terrorist` twelve times, yaw 46936, pitch -500: the camera at
the right side of `Terrorist22`, no actor moved), the level running after the tracer detached, two captures of 8 s and 16 s:
two pawns armed in view, `Terrorist22` (`GM_Jumpsuit`, 370 model vertices) with `WeaponPistol13` (`Glock3rd`) and `ThugMale3` (`GM_DressShirt`,
304) with `WeaponMiniCrossbow1` (`MiniCrossbow3rd`); **1,179 pawn draws with a weapon** (395 and 784, each draw another animation pose), the
frame's Mirror 1, every special outcode 0, the special triangle's indices `(0, 1, 2)` and 3 special vertices in every draw. The weapon at its
`DrawMesh` call: `Mesh` the third-person mesh, `DrawScale` 1 (`ThirdPersonScale`), `Style` 1 (the pawn's), `DrawType` 2 (DT_Mesh), `Rotation`
`(0, 0, 0)`, `Location` the pawn's, `ScaleGlow` 1, `Fatness` 128, poly flags `0x4000` (PF_Flat: no unlit bit, so the weapon's `Region.ZoneNumber`
is not 0), `AnimSequence` cycling `Idle1`, `Idle2`, `Idle3` (the weapon's own animation, which the third-person mesh is posed with).

A third capture, `Terrorist1` (`GM_Jumpsuit`) with `WeaponRifle0` (`SniperRifle3rd`, a long two-handed mesh; the camera at its right side, 28 `CheatView`s,
yaw 49152): **379 more draws**, all equal (1,558 in all, 3,116 word-for-word comparisons with the translation, 0 differences).

**State the draw writes, seen in the running game** (`dump-actor-win.exe WeaponPistol13`, level running): `Rotation = (0, 0, 0)` (Play's
weapon keeps the pawn's `(0, -2216, 0)`); after typing `set DeusEx.WeaponPistol FlashCount 9` into the level, `FlashCount = 9` **and
`OldFlashCount = 9`** one draw later, with no flash drawn: the `OldFlashCount` store runs whenever the weapon is drawn.

**The muzzle flash is dead code in the shipped game.** The flash site (`0x10b259c3`) did not fire for either weapon with `FlashCount` changed,
and a scan of every class default in Engine.u, DeusEx.u and DeusExItems.u (`.work/weapon/flash-classes.mjs`, not in Git) finds **no `MuzzleFlashMesh`**
(the pistol's reads `None`) against 112 classes with a `ThirdPersonMesh`. The block's instructions are recovered above and its Coords are the weapon's
(the oracle runs them), but nothing in the game's data reaches the mesh draw, so it is not wired: **unsupported, by data**. The state writes that
precede it (`bFirstFrame`, `OldFlashCount`, `bSteadyToggle`) are written.

## Oracle and translation

`scripts/native-weapon-attach-oracle.py` runs the original instructions under Unicorn: DrawLodMesh `0x10b0f1c9..0x10b0f44f` (the special
face's vertices and outcodes in, the global and the flag out), DrawActorSprite `0x10b256e8..0x10b257a2` (the weapon's scale swap, Rotation
zeroed, Mirror forced, the hand coordinates divided by the zero rotation and the Location added), with Core's `SafeNormal`,
`FCoords::operator*=` and `operator/=(FRotator)` unchanged, at precision control 24. `src/runtime/weapon-attachment.mjs` is the translation
(`safeNormal`, `specialOutcode`, `handCoords`, `weaponCoords`); `scripts/validate-weapon-attach.mjs` compares every output word.

* 200 random special triangles (159 drawn, 41 skipped by their outcodes) and 100 random weapon Coords: **0 differences**; a mutated
  translation (the 0.5 of M changed) fails 159 of 200, so the cases discriminate.
* The original's own 1,558 draws (above): `handCoords` of the logged special vertices equals the logged hand coordinates, and
  `weaponCoords` of those and the weapon's `Location` equals the Coords logged at the weapon's `DrawMesh` call, **1,558 of 1,558, every word**
  (`validate-weapon-attach.mjs` runs them when `.work/weapon/original-cases*.json` exist, built by `weapon-original-cases.mjs`).

## Play (2026-10-15)

**Wiring.** Each armed pawn the actor mesh layer draws gets a binding for its weapon (`src/viewer/actor-weapon-sim.mjs`), created through
`createMeshBinding`'s `attach` option, on the GPU mesh path when the page has it (`?weapons=cpu` and `?gpuMesh=0` take the CPU path, the reference: "The GPU path" below),
lit right after its pawn in each frame ("Order of SetupForActor calls") and posed and drawn after the pawns with a view whose frames are the pawn's:

* the weapon's mesh is `ThirdPersonMesh` (`runtime.prepareMeshReference`, `getMeshSurfaces`, `getMeshTextureOf`), its DrawScale `ThirdPersonScale`, its Style the
  pawn's, its Rotation zero (`attach.overrides`);
* the hand frame of each frame the pawn is drawn in comes from the pawn binding's `specialCamera` (the cached poses of that frame's GetFrame call through the
  frame's matrix, the first `SpecialVerts` vertices: the buffer DrawLodMesh reads) with `weapon-attachment.mjs` (`handCoords`, `weaponCoords`, the frame's
  PrjXM..PrjYP from `frameMaster().prj` for the outcodes); the weapon's GetFrame matrix, LOD selection and camera-space points use those Coords
  (`attach.coords`), the pawn's own Coords are untouched;
* the weapon is lit as DrawMesh lights it: `setupMesh(weapon, null, ctx, {sink: pawn, style: pawn.Style})`, the sink's location, leaf, zone, glow and cache from the
  pawn, the poly flags and the unlit colour from the weapon, and the frame's Mirror 1.0 (`attach.lightFrame`);
* the state DrawActorSprite writes is written (`writeState`): Rotation zero, `OldFlashCount = FlashCount`, `bFirstFrame` cleared, `bSteadyToggle` flipped per
  drawn frame for a steady flash;
* the weapon is **not stamped** (DrawActorSprite stamps the pawn only): it is in none of the frame id sets, its `drawnIn` answers false, `LastRenderTime` stays;
  the frame passes (`framePasses`) take it in a frame when its pawn is there and had a hand (`inFrame`);
* the page draws it like any binding with the frustum test off (`creation.attached`: its bounds come from the world-space pose, which is not where the
  hand puts it); `?weapons=off` draws none.

**Measured.** `scripts/validate-weapon-play.mjs` (the Island view, worker mode, a headless Chromium): both armed pawns have a binding (on the GPU path; on the CPU path with
`?weapons=cpu`) drawn in the main frame, with its lighting record (camera points and colours on the CPU path); the weapon's Coords equal `weaponCoords(handCoords(...))` of Play's own special vertices word for word; Rotation zero,
`OldFlashCount = FlashCount`, the weapon stays hidden and unstamped, its pawn is stamped; `?weapons=off` has no weapon binding.
Pixels, the Island view against a fresh original (`live-original.sh ... --tag wpn3`, the debugger log of the same run in `.work/weapon/`; Play `live-acceptance.mjs play
--tag wpn3 --page-params antialias=0`, `visual-acceptance.mjs compare --view wpn3:0,0,0:0,0,0`): whole frame ratio 1.316, mean abs. diff. 2.92, edge recall .999 /
precision .990, sub-pixel (0, 0), 0 outlier blocks (without the weapon: 2.94, .981 / .988); the pistol's region (`--crop 50x90+682+370`) 3.77, .991 / .991, 0 outlier
blocks (without it: 7.94, .475 / .662, 34 outlier blocks). The side-by-side crop shows the same pistol at the same place and angle. The rifle view (`--tag rif1`,
`Terrorist1`'s sniper rifle) matches as a whole frame (ratio 1.34, mean abs. diff. 2.50, edge recall .992 / .990, 0 outlier blocks) but is **not a discriminating test**: the rifle is
behind the body from that side, and the numbers are the same with `?weapons=off`; its evidence is the 379 logged draws above. ThugMale3's crossbow is hidden behind its body in the
Island view too (both frames agree).

Regression on the branch (worker mode unless noted): `validate-mesh-lighting-play`, `validate-lodmesh-lod-play`, `validate-sim-split` (worker against inline: same pixels),
`validate-mirrors-play`, `validate-gpu-mesh`, `validate-actor-mesh-scene` and the mesh unit tests all pass; the weapon changes no path an actor without a weapon takes.

**Found while wiring.** The hand frame has determinant -1 (a reflection): X, Y, Z = Y x X, so the weapon mesh is authored for a reflecting transform and the original keeps its
faces by the camera-space test alone. In a mirror's child frame Play's projection flips x for the whole pass (`uFpDepth.z`), which reverses the winding the other way:
`decision.flipSide` makes the page draw the weapon's single-sided groups with the other side there (verified against the original, "Mirrors" below).

## Mirrors (2026-10-15)

**Scene** (`05_NYC_UNATCOMJ12lab`, found by `.work/weapon/*-census.mjs` over the maps' mirrored surfaces, player starts and pawns). The player starts at
`PlayerStart0` (-3087, 1400, -155), 225 units in front of a translucent mirror pane (surface 3611, plane x = -2862, y 1360..1488, z -160..-64, flags `0x8c0000c`) and, looking along
+x, sees his whole reflection in it. JC is armed through original paths only, typed after N unfrozen ticks with the level held (`live-original.sh --no-ghost --cmds`, run by Play at the
same ticks): `summon DeusEx.WeaponPistol` (20), `set ... ViewRotation (Pitch=-10130,Yaw=16432)` to look at it (50), `ParseRightClick` (90, the pickup), `ActivateBelt 1` (130), the view
turned to the pane (170), the frame at tick 300 with the level held (`--tag jcm`). The player is excluded from the main frame in first person, so the pistol is drawn in the mirror's child
frame alone. A second scene (`--tag jcb`) adds `BehindView 1` and a view off the line to the mirror: JC's back in the main frame, his reflection beside it, both drawing the pistol.

**The running original** (`wine dx-live-win.exe weapon 6` with the level up afterwards, `DX_POST`): 234 draws of `JCDentonMale2` (`GM_Trench`, 336 model vertices, `WeaponPistol3`/`Glock3rd`), every one in
the mirror's child frame (`Recursion` 1, Mirror -1: the `read`, `special` and `coords` events 234 times each) and the weapon's `DrawMesh` with the frame's Mirror at **1.0** (the forced value, 234 events).
The child frame's PrjXM..PrjYP are `3e36ee45 3e6bb90c 3ec81e6e 3e4958ba`: the planes of the pane's clipped window, not the main frame's. The special vertices' outcodes are read against them in each frame
(`DrawLodMesh` 0x10b0efd3..), so Play now passes every frame its own planes (the Rust core's per-frame fields 25..28, `frames[].prj`, `lightFrames[].prj`). Play's child frame in the replay of the same run has
exactly those four words.

**Translation.** `validate-weapon-attach.mjs` takes the 234 draws as cases (`weapon-original-cases.mjs --cases`: the logged special vertices and outcodes, the logged hand coordinates and the
Coords handed to the weapon's `DrawMesh`): hand and weapon Coords equal word for word (3,584 comparisons with the running original in all, 0 failures; the 1,558 main-frame draws above and these 468).

**Captured again on the Mac (2026-10-16, CrossOver).** The same scenes on the Mac's bottle (`scripts/live-original.sh`, tags `jcm` and `jci`, the commands above; then `weapon 6`), for
the Stage 4 gate's row 4.1.11, whose Linux captures were out of reach: 143 pawn draws of JC with the pistol (142 with the weapon drawn) and 157 with the MedKit (156 drawn), every one in the
mirror's child frame with **the same PrjXM..PrjYP words** as the Linux capture (`3e36ee45 3e6bb90c 3ec81e6e 3e4958ba`). The Island view above (`CheatView DeusEx.Terrorist` twelve times,
`weapon 8` and `weapon 16`) gave 590 draws with the weapon drawn (Terrorist22's pistol; ThugMale3's crossbow once; the rifle capture of Terrorist1 was not retaken, so the Mac corpus is narrower than the Linux one). `validate-weapon-attach.mjs` over these 888 draws: 1,776 comparisons, 0 failures; Play's replay of
the Mac `jcm` trace (`validate-weapon-mirror-play.mjs`) has the logged words. The frame rate under Rosetta is lower, so a 6 s capture holds fewer draws than the Linux one.

**Pixels** (`live-acceptance.mjs play --tag jcm --shot jcm --no-ghost --page-params "antialias=0&weaponMirrors=1"`, `visual-acceptance.mjs compare`, the level held at tick 300; the Wine brightness gap, ratio
about 1.3, is the known uniform one):

| Scene, region | Play | MAD | edge recall / precision | outlier blocks |
| --- | --- | ---: | ---: | ---: |
| jcm, whole frame | weapon in the mirror | 2.03 | .978 / .972 | 0 |
| jcm, JC's reflection (160x180 +560+340) | weapon in the mirror | 4.90 | .999 / .999 | 0 |
| jcm, the pistol's region in the reflection (40x44 +645+425) | `weaponMirrors=1` | 4.72 | **1.000 / 1.000** | 0 |
| | `weaponMirrors=0` (no pistol) | 4.85 | .795 / 1.000 | 0 |
| | `weaponMirrors=1` without `flipSide` | 4.82 | .807 / 1.000 | 1 |
| jcb, whole frame | weapon in the mirror | 2.21 | .987 / .992 | 0 |
| jcb, the main-frame pistol (50x60 +745+355) | either | 3.51 | 1.000 / 1.000 | 0 |
| jcb, the reflection (70x100 +815+250) | `weaponMirrors=1` / `=0` | 4.82 / 4.82 | 1.000 / .997 vs .986 / .986 | 0 |

The pistol drawn in the reflection is the same one at the same place and angle as the original's (`.work/weapon/jcm-hand-orig-on-off.png`: original, Play on, Play off). The face-side flip is verified
by the third row: without `decision.flipSide` the weapon's faces are culled the wrong way and the pistol is missing as when it is off (.807 against .795 recall); with it the region matches.

**On by default** since this step: `?weaponMirrors=0` turns it off (`?weapons=off` still turns every third-person weapon off). `scripts/validate-weapon-mirror-play.mjs` is the Play-side check (the
scene above in worker mode with the console commands run live: a binding drawn in child frame 1 alone with the frame's own planes, the Coords equal to the translation over that frame's special
vertices, the switches; with the capture of the original in `.work/live-acceptance/05_NYC_UNATCOMJ12lab` it replays the run and compares the child frame's planes with the logged words).
Not compared: an NPC in a mirror (the capture of the Underworld/Club views has none; the NPC path is the player's one with its pawn drawn in both frames, which `jcb` covers for JC).

**Found while capturing.** `viewProbe`'s `location` wrote Play's player Location without moving its hash entry, so the replay's first `SetRotation` after a placement that differs from the player's own settle
(the original's JC rests at z -155.8095, Play's at -155.968) paused with "Remove actor before changing its registered location". The placement now re-registers the player (`changeActor`).

## Held items (SelectedItem with no Weapon, 2026-10-15)

**Which pawns.** `Pawn.SelectedItem` is set by `DeusExPlayer.UpdateInHand` (and by nothing for a ScriptedPawn), so the pawn is the player holding a pickup: of the classes in Engine.u, DeusEx.u and DeusExItems.u
whose defaults set `ThirdPersonMesh`, the weapons and also `MedKit`, `Lockpick`, `Multitool`, `Binoculars`, `BioelectricCell`, `Flare`, `NanoKey`, `NanoKeyRing`, `Credits`, `WeaponMod`, `AdaptiveArmor`, `BallisticArmor`,
`HazMatSuit`, `TechGoggles`, the augmentation cannisters and `DataVaultImage` (40 classes in all with a mesh; `.work/weapon/third-person-classes.mjs`). When the player holds one of those with no weapon
(`Weapon` None, `SelectedItem` the item) it is drawn in his hand in every frame that draws him: in a mirror.

**The running original** (the same lab scene, `--tag jci`, `summon DeusEx.MedKit` instead of the pistol, the `weapon` debugger with the new site `0x10b26165`, the item block's `DrawMesh` call): 234 draws, every one
with `Weapon` None and `SelectedItem` `MedKit0`, mesh `MedKit3rd`, DrawScale 1, Style the pawn's, Rotation (0, 0, 0), the frame's Mirror at 1.0, in the mirror's child frame (Recursion 1).

**Oracle and translation.** `scripts/native-weapon-attach-oracle.py` runs the unchanged instructions `0x10b25d37..0x10b26118` (the swap, the zeroed Rotation, the forced Mirror, the three rotations built
from `GMath`'s sine table, Core's `TransformPointBy`/`TransformVectorBy`, the `FVector`/`FCoords` constructors and `FCoords::operator*=`, the Location sums) at precision control 24;
`selectedCoords` (`src/runtime/weapon-attachment.mjs`) is the translation: the roll rotation (origin `(-0,-0,-0)`, X `(1,-0,-0)`, Y `(-0,cos,sin)`, Z `(-0,-sin,cos)`) applied by transform, the pitch
(X `(cos,0,-sin)`, Y `(-0,1,-0)`, Z `(sin,-0,cos)`) and the yaw (X `(cos,-sin,0)`, Y `(sin,cos,0)`, Z `(0,0,1)`) by `*=`, the Location added. Roll goes first, then Pitch, then Yaw. 100 random cases
(random hand coordinates with zeros, negative zeros and tiny values, a nonzero Rotation to be zeroed, both Mirror signs, both scale swaps) and the 234 original draws (`weapon-original-cases.mjs --cases`):
0 differences (4,052 comparisons with the running original in all); dropping the three rotations from the translation fails 19 of the random cases (a zero's sign), so they discriminate. The block writes the
Rotation alone (no flash state).

**Play.** `actor-weapon-sim.mjs` draws the pawn's `SelectedItem` when it has no `Weapon` (a held `Weapon` wins, as in the original), with `selectedCoords`; the validator checks both in the lab scene (`summon
DeusEx.MedKit`: `item` true, drawn in child frame 1 alone, Coords equal the translation). **Pixels** (`--tag jci`, `?antialias=0`): whole frame ratio 1.317, MAD 2.10, edge recall .977 / precision .976, 0 outlier
blocks; over the MedKit in the reflection (40x40 +640+425) MAD 5.18, recall 1.000 / precision 1.000, 0 outlier blocks, and with `?weapons=off` 7.86, .287 / .762, 22 outlier blocks (`.work/weapon/jci-medkit-orig-on-off.png`:
original, Play, Play without: the same box, handle and cross in the same hand).


## A ViewportWindow's frame (security cameras, 2026-10-15)

`DrawWorld` is one function for every root frame ([script-window-viewport](script-window-viewport.md#camera-pass): the window's frame goes through the same OccludeFrame and DrawFrame), so DrawActorSprite's
weapon block runs for a pawn in the camera's Frame->Sprite exactly as for the main frame's, with the window frame's own Coords, Mirror 1 and PrjXM..PrjYP. Play's `updateFrame` (the second DrawWorld's actor update)
now updates the weapons of the pawns in the frame after their pawns (`weapons.update(..., hideOthers = false)`), with the camera master frame's projection planes (`prj: seen.master.prj`), and the pass's
decisions no longer hide a weapon binding whose pawn is in the frame and had a hand there (`weaponInRoot`: a weapon is in no Frame->Sprite of its own). A mirror inside the camera's view uses the same child-frame path as the main frame's.

**Checked in Play** (`validate-terminals-camera-browser.mjs --expect weapons`, worker mode, 01_NYC_UNATCOIsland ComputerSecurity1: the Temp Holding Cell window of SecurityCamera5): the armed terrorists in the camera frame
(Terrorist18 `WeaponPistol10`, Terrorist30 `WeaponPistol20`, Terrorist2 `WeaponPistol25` over the tries) each have a weapon binding drawn in the window's root frame (`frames [null]`), whereas before the step the
window drew their bodies without it. **Not compared with the original's pixels**: those three terrorists walk and animate differently in the two programs (the matched window captures mask their region,
[security cameras](visual-acceptance.md#security-cameras-2026-10-14)), and the debugger cannot be attached beside the terminal route's tracer; the evidence is the shared function and Play's own check.

## Order of SetupForActor calls, and the GPU path: analysis (2026-10-15)

**The order.** In DrawActorSprite the pawn's DrawMesh (GetFrame, DrawLodMesh, SetupForActor, Light) comes first and the weapon's second, in each frame; the frames follow DrawFrame's order (children first, the main frame last,
each frame visiting its sprites). Play updates a pawn binding over all of its frames and then updates the weapon binding over all of its frames (`weapons.update` after `binding.update`). Across *different* pawns the order does
not matter: SetupForActor's per-actor cache is `GCache` item `(Actor.Index * 256) + 0x30`, so each pawn's cache is touched only by that pawn's calls and its weapon's (the weapon is lit with the pawn as the sink), and the
per-call stamp (`ExtraTag`) only needs to differ between calls. Within one pawn it can matter: `setupForActor` (mesh-lighting.mjs) reads the cache at every call (the cached candidates and their fades, `newCache`,
the `fade & 1` visibility shortcut for the lights whose `(Index ^ FrameCount) & 15` is nonzero) and writes it back (`fade + step`, `fade - step`, at most 16 entries), so the calls
`[pawn@child, weapon@child, pawn@main, weapon@main]` of the original and `[pawn@child, pawn@main, weapon@child, weapon@main]` of Play start the second frame's calls from different caches. A light's fade only
decides *whether it is still added* (a light that stops being visible stays in the list until its fade runs out, `max(0, fade - step)`), so the colours differ only on the frames where a light's fade crosses zero or a
moving light enters one frame's `LeafLights` and not the other's; with one frame (a pawn in the main frame alone, the usual case) both orders are the same sequence.

**The order, implemented (2026-10-15).** The addresses are section 2's: `DrawActorSprite` (`0x10b25080`) makes the pawn's `DrawMesh` call at `0x10b25624` and, in the same invocation, the weapon's at `0x10b257da`, and
DrawFrame invokes it once per sprite per frame, so within a frame the pawn's SetupForActor is followed by its weapon's. The pawn binding lights its frames in `lightIn` (`createMeshBinding`: the child frames in DrawFrame's order, the main
frame last); that function now calls a hook after each frame (`view.afterLight`, made by `weapons.interleave`, `actor-weapon-sim.mjs`), which is the weapon's part of that frame in the original's place: the hand from the pawn's special vertices as
that frame's GetFrame call made them (`binding.specialCamera`, with the frame's own projection planes), the weapon's Coords, and its SetupForActor result (`lighting.setupMesh(weapon, ..., {sink: pawn})`, which reads the cache the pawn's call
just wrote). `weapons.update` then poses and draws the weapon with those results (`attach.takePrepared`); a frame the hook did not reach (the pawn's lighting did not run there) is placed and lit by `update` as before, in the old position.
`?weaponOrder=late` keeps the earlier order (all of a pawn's frames, then the weapon's) as a switch, for this comparison. The CPU path is untouched: the same functions run, in the original's order.

**Compared with the old order** (`scripts/validate-weapon-order.mjs`, worker mode): the `jcb` scene (05_NYC_UNATCOMJ12lab, JC with the pistol, `BehindView 1`, the view off the line to the mirror, so he is lit in the pane's child frame and in the main
frame), loaded under a paused Playwright clock (`?hold=1&seed=1`, 16 ms frames, the console commands at fixed frames), so a run repeats exactly. The simulation side keeps every SetupForActor call (the actor, the light sink, the frame's origin
words and the result: the ambient, `ScaleGlow`, the flags and each light's identity, location, radius, colour and fade as words) from the first BehindView frame, 120 frames. In every frame the sink's calls are `pawn@child weapon@child pawn@main
weapon@main` with the hook and `pawn@child pawn@main weapon@child weapon@main` with `?weaponOrder=late` (the validator asserts both, so the comparison does tell the orders apart). The same order twice gives identical words (604 results, and the
weapon's float32 corner colours); the two orders give **0 words different** in the 604 SetupForActor results and equal weapon colours in the main and the child frame. The reason is in this scene's lights: JC's three
(`TriggerLight0`, `2`, `6`) are constant, visible from his location in every call, and their fades are at 255, so each call applies the same step in either order. A pawn's calls in one frame all see the same location (the sink's), so
each light's visibility is the same in all of them; the orders can part only where a light is in one frame's `LeafLights` and not the other's (a moving light that enters the main frame's view planes but not the mirror's), in the frame
it first appears: the late order's `weapon@child` then finds it in the cache `pawn@main` wrote, and the original's does not. No scene of the maps checked has that yet; the order is implemented because the disassembly gives it.

**The GPU path (2026-10-15).** A weapon binding takes the GPU mesh path when the page has it (`bind(weapon, {attach, layout})` with the actors' layout); `?weapons=cpu` and `?gpuMesh=0` keep the CPU path, which stays the
reference and the fallback (more than 32 selected lights, a layout that is full). [GPU mesh](gpu-mesh.md#a-pawns-weapon-2026-10-15) has the mechanism: (1) the camera-space publication takes the Coords of the frame being lit,
`attach.coords(frameIndex)` (the hand's), as the slot's frame matrix in place of the lighting frame's, once per frame the weapon is drawn in; (2) the light constants come from the SetupForActor result the pawn's frame loop took for the
weapon right after the pawn's own (`attach.takePrepared`, `attach.setup`: the pawn as sink, "Order of SetupForActor calls"); (3) the face pass takes the slot's own Mirror (F11.w, 1.0) in place of the run's, since DrawActorSprite forces
Frame->Mirror to 1.0 for the weapon's DrawMesh whatever the frame's (`0x10b2571a`); (4) no frustum test (the world-space bounds are not where the hand puts the weapon) and no actor batching (the faces' side flips with the pass).

*Compared with the CPU path.* `validate-gpu-mesh` has two weapon scenes (`?sim=inline`, bit exact against the CPU twin and the kernel, the tolerances of the other meshes being 1 ulp, 2 ulp for a tween and 1 byte): the Island view of
Terrorist22's pistol and ThugMale3's crossbow (20 weapon-binding comparisons over 10 captures: 3,690 world-pose, final-pose and camera-space components, 2,790 lit corners) and the MJ12 lab's `jcb` scene (JC's pistol in BehindView, main frame
and reflection: 10 comparisons, 1,770 components, 1,290 corners, and 10 real child frames with their own hand and SetupForActor result lit through a Mirror -1 run: 1,530 corners, 1,770 components): **0 differences**, 0 ulp and 0 bytes,
no drawn-test disagreement. The slot's Mirror lane is checked by running every weapon's lighting under a Mirror -1 run against the kernel at Mirror 1.0; dropping the lane from `setLighting` fails both scenes. In Play's worker mode
`validate-weapon-gpu-play` loads the same two scenes under a paused clock (`?hold=1&seed=1`, 16 ms frames) with `?weapons=cpu` twice (the control), the default and `?weapons=off`, and compares the drawing buffers: **the GPU path draws the CPU
path's pixels exactly** (0 of 921,600 pixels differ in either scene, as in the control); the weapons cover 3,103 and 783 pixels in the two scenes, so the comparison sees them.

## Cost (2026-10-15)

**Method** (`scripts/weapon-cost.mjs`, Play's default worker mode, a fresh headless Chromium per run, `--use-angle=gl` on the Linux host's AMD iGPU, 1440x960, the player floating in the `ghost` cheat at the view, level running, 240 drawn frames after
4 s): pairs of runs of one view, interleaved (the side that goes first alternates), the default against `?weapons=off`, five pairs per scene; each phase is the mean per drawn frame over a run's frames (`deusExViewer.framePhases`: the worker's steps
`w.*` and the page's own), and the table has the median over the pairs. The weapon layer's own time is counted where it runs (`weapons.stats`: `weapons.update` and the hook the pawns' lighting makes, the wall time per
worker frame; also `lodProbe({list: 'weaponStats'})`). The page is vsync-limited here (60 Hz, the draw interval is 16.7 ms with and without the weapons), so the costs below are host work, not frame rate. The host was shared with other
agents' jobs (load average 7 to 9 on 16 cores), so a single phase wobbles by about 0.3 ms between runs, and the difference of two phases by as much; the layer's own time is the precise column. Linux AMD numbers: the Mac the 120 fps
target is defined on was not at hand.

The scenes put armed pawns in view (`.work/weapon/find-view.mjs`: Frame->Sprite pawns whose weapon the last update drew, over rings of eye positions around the clusters of armed pawns a census of the maps in Play found): 02_NYC_Street at
(1374, 1390, -374) looking along -x at the UNATCO troops and terrorists, 06_HongKong_WanChai_Street at (-1700, -1300, 2122) at the MJ12 troops on the roof, the Island at (3240, -100, 1178) at Terrorist22 and ThugMale3, and the Paris Club at
(-623, 177, -40) at ThugMale0 (the Club has three armed pawns in all). Armed pawns drawn is the mean number of weapon records an update made.

*Before* (the CPU path, commit `88b6f96`; per drawn frame, ms):

| Scene | armed pawns drawn | the weapon layer's own time (sim side) | worker `w.actors` on / off | page `actors` on - off | page `render` on - off |
| --- | ---: | ---: | ---: | ---: | ---: |
| NYC Street | 11 | 1.27 (0.116 each) | 4.89 / 3.69 | +0.23 | +0.33 |
| Hong Kong Wan Chai Street | 3 | 0.42 (0.139) | 4.24 / 3.85 | +0.06 | +0.16 |
| Island | 2 | 0.30 (0.151) | 3.43 / 3.05 | +0.07 | +0.12 |
| Paris Club | 1 | 0.32 | 2.83 / 2.43 | +0.03 | +0.01 |

So an armed pawn in view cost the worker 0.12 to 0.3 ms a frame (the Club's assault shotgun mesh is the largest), the page's record application a few hundredths and its draw submission about 0.03 ms (a weapon's mesh groups are three.js
meshes like any actor's); eleven pawns in view cost 1.27 ms of the worker's ~14 ms and about 0.6 ms of the page's.

*After* (the GPU path, this branch; same scenes, same method):

| Scene | armed pawns drawn | the weapon layer's own time (sim side) | worker `w.actors` on / off | page `actors` on - off | page `render` on - off |
| --- | ---: | ---: | ---: | ---: | ---: |
| NYC Street | 11 | 0.94 (0.085 each) | 4.48 / 3.28 | +0.05 | +0.35 |
| Hong Kong Wan Chai Street | 3 | 0.25 (0.084) | 3.70 / 3.55 | -0.01 | -0.02 |
| Island | 2 | 0.22 (0.110) | 3.20 / 3.05 | 0.00 | +0.03 |
| Paris Club | 1 | 0.22 | 2.57 / 2.31 | +0.01 | +0.21 |

The layer's own time falls by 26 to 40 percent and the page's record application to nothing the noise hides (the CPU path copied corner colours and camera-space points into the geometry attributes of every weapon every frame; the GPU path
sends one lighting record and a plan). The draw submission is unchanged, as it should be. What is left on the simulation side is not the GetFrame replay and lighting the GPU took over: in the NYC scene (sub-timers added for the
measurement, 11 weapons, 0.995 ms) the hand placement is 0.40 ms (`specialCamera`: the pawn's special vertices published through the frame's matrix, the outcodes, `handCoords`, `weaponCoords`: about 36 microseconds per weapon and frame), the
binding's update 0.31 ms (pose change detection, the plan, the LOD selection, the lighting record), SetupForActor 0.12 ms and the layer's bookkeeping 0.16 ms. The update no longer allocates its frame lists, Maps, Sets and view objects per armed
pawn per frame (they are reused; `last` for validation is built on demand), but `specialCamera` and the hand still allocate their small arrays.

*GPU against CPU in one session* (the default against `?weapons=cpu`, interleaved, five pairs per scene; per drawn frame, ms, GPU / CPU):

| Scene | armed pawns drawn | the layer's own time | page `actors` | page `render` | page `total` | worker `w.actors` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| NYC Street | 11 | 0.84 / 1.06 | 0.57 / 0.79 | 1.74 / 1.64 | 3.52 / 3.66 | 4.36 / 4.24 |
| Hong Kong Wan Chai Street | 3 | 0.23 / 0.37 | 0.56 / 0.69 | 0.84 / 0.97 | 2.74 / 3.18 | 3.35 / 3.87 |
| Island | 2 | 0.21 / 0.26 | 0.51 / 0.51 | 1.40 / 1.25 | 3.04 / 2.80 | 3.27 / 3.08 |
| Paris Club | 1 | 0.18 / 0.24 | 0.39 / 0.39 | 1.79 / 1.70 | 5.39 / 5.25 | 2.19 / 2.20 |

Here too the layer's own time falls (19 to 38 percent), and the page's record application with it where several weapons are in view; every other phase of the two sides is within the run-to-run wobble of this shared host
(`w.actors` and the worker total differ by up to a millisecond either way, which no weapon explains).

## Open

* **A ViewportWindow's frame against the original**: wired and checked in Play (above), not compared with the original's own camera window (the debugger and the terminal route's tracer cannot hold the game together).
* **GPU path**: done (above). The CPU path stays the reference; `?weapons=cpu`.
* **Order of SetupForActor calls**: implemented and compared (above). Not compared in a scene where a light first enters one frame's `LeafLights` and not the other's, which is the only case the orders can differ in; the lab scene has none.
* **An NPC in a mirror**: the same wiring as JC's (verified for JC in a mirror, both frames, `jcb`); no capture of the original has an armed NPC in a mirror yet (the maps' mirrors sit at
  the height of a standing pawn's belt or above its hands except the lab's panes, and the Club's guards stand away from them).
* **Muzzle flash**: dead by data, see above; the render-time `appFrand` it would draw from the CRT stream is not modelled.
* **Cost**: measured (above): 0.08 to 0.15 ms of the worker's frame per armed pawn in view on the GPU path (0.12 to 0.3 on the CPU path), the hand placement being the largest part left; not measured on the Mac.

**Screenshots** (Play, worker mode, default settings; outside the repository): `.work/weapon/club-guard-front.png` and `club-guard-side.png` (10_Paris_Club: the guard `ThugMale4` with his assault shotgun, the camera behind him on
`CheatView`), `jc-reflection-pistol.png` and `jc-reflection-pistol-zoom.png` (05_NYC_UNATCOMJ12lab: JC's reflection holding the pistol, the first-person pistol below); the comparisons with the original:
`jcm-hand-orig-on-off.png`, `jci-medkit-orig-on-off.png`.
