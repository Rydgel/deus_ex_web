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

* **No `Weapon`, a `SelectedItem`** (`Pawn+0x3d8`, `0x10b25cdc..0x10b261ac`): the same swap of `ThirdPersonMesh` and
  `ThirdPersonScale`, the Style copy, Rotation zeroed, `Mirror` 1.0, but the Coords go through three rotation
  FCoords built from the item's (zeroed) Roll, Pitch and Yaw (`FVector::TransformPointBy/TransformVectorBy`, `FCoords::operator*=`:
  identity matrices) before the Location is added; no muzzle flash. A `DeusExPlayer` holding a tool or an item with no weapon
  (`UpdateInHand` sets `SelectedItem = inHand`; a weapon sets `Weapon` as well) shows it this way in a mirror.
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
* The original's own 1,179 draws (above): `handCoords` of the logged special vertices equals the logged hand coordinates, and
  `weaponCoords` of those and the weapon's `Location` equals the Coords logged at the weapon's `DrawMesh` call, **1,179 of 1,179, every word**.
