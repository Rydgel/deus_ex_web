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
`createMeshBinding`'s `attach` option on the CPU path (a few dozen vertices; the GPU path is not used for it) and updated right after its pawn
with a view whose frames are the pawn's:

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
* the page draws it like any CPU-path binding with the frustum test off (`creation.attached`: its bounds come from the world-space pose, which is not where the
  hand puts it); `?weapons=off` draws none.

**Measured.** `scripts/validate-weapon-play.mjs` (the Island view, worker mode, a headless Chromium): both armed pawns have a CPU-path binding drawn in the main frame
with camera points and colours; the weapon's Coords equal `weaponCoords(handCoords(...))` of Play's own special vertices word for word; Rotation zero,
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

## Open

* **A ViewportWindow's frame against the original**: wired and checked in Play (below), not compared with the original's own camera window (the debugger and the terminal route's tracer cannot hold the game together).
* **GPU path** for the weapon bindings (a few dozen vertices each; CPU path measured only by its pixels).
* **Order of SetupForActor calls**: the original lights the pawn then its weapon in each frame; Play runs all of a pawn's frames, then the weapon's (the sink's per-actor cache is shared).
* **An NPC in a mirror**: the same wiring as JC's (verified for JC in a mirror, both frames, `jcb`); no capture of the original has an armed NPC in a mirror yet (the maps' mirrors sit at
  the height of a standing pawn's belt or above its hands except the lab's panes, and the Club's guards stand away from them).
* **Muzzle flash**: dead by data, see above; the render-time `appFrand` it would draw from the CRT stream is not modelled.
* **Cost**: one CPU GetFrame replay per armed pawn per drawn frame (`materialize`), not measured.
