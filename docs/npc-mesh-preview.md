# Training NPC mesh inspection

These meshes are **live bindings to the script-attached map actors, visible in
Play and Inspect**. The runtime resolves each actor to the same object the VM
mutates, so `update()` resamples the original `GetFrame` path whenever
AnimSequence, AnimFrame, transform or blend fields change under the shared
clock. Original startup now runs at load for the supported pawn set; it does
not claim original mesh lighting, distance LOD, AI or conversations.

The display adapter samples runtime pose changes into the existing vertex
buffers and recomputes bounds. Its persistent per-actor cache preserves original
tween history. Unchanged poses require no geometry upload; hidden/deleted actors
stop drawing. It supplies no separate animation clock — the script runtime's
tick advances poses in Play and leaves them frozen in Inspect; see the
[startup contract and live results](script-npc-startup-animation.md).

Static GPU skin textures are now [shared within each actor scene](actor-mesh-texture-sharing.md).
Private decoding/await order, materials, animation caches and render feedback
remain per actor; unchanged Style/ScaleGlow no longer rewrites material state.

## Evidence established before the draw adapter

The prepared `JaimeReyes0` actor references `DeusExCharacters.GM_Trench_F`,
`AnimSequence=Fighter`, `AnimFrame=0`, `DrawScale=0.8999999761581421`,
location `[361.278564453125,1206.008056640625,-53.10018539428711]` and rotation
`[0,-16544,0]`. These are class/map values, not a captured post-startup pose.

The adapter consumes the already native-compared [GetFrame translation](script-lodmesh-frame.md)
with identity FCoords, producing world-space positions, and the native-compared
[full-resolution face and skin accessors](script-lodmesh-materials.md).
GetFrame's isolated preview cache uses Jaime's measured GObjObjects index 34333
(`JaimeReyes.JaimeReyes0`, local `tools/dump-gobjects-win.c` Training capture).
It does not register that captured index as the browser world's live identity.
The preview owns and discards its cache; package export indices are not used.

Render.dll `10b10b43..10b10c83` multiplies each wedge UV byte by texture size,
texture scale and 1/256. Normalized texture coordinates cancel the size/scale
and are U/256, V/256. GetFrame indices already include the special-vertex
prefix. The viewer's existing reflection `[x,y,z] -> [y,z,-x]` requires reversing
the original triangle winding. Original skins, palette masking and face flags
are retained. Static texture decoding and GPU surface-flag handling reuse the
world viewer's established conventions; animated/procedural textures remain unsupported. The selected PF_Environment
path is now recovered; see [instructor material evidence](script-instructor-conversation.md#guard-environment-materials-recovered-selected-path).

The mesh uses the recovered DrawLodMesh per-vertex lighting documented in
[mesh lighting](mesh-lighting.md); it is no longer texture-only inspection
shading. Full resolution remains deliberate inspection behavior, not a claim
that DrawLodMesh's distance-dependent topology, fog or volumetric lights are
complete.

`createActorMeshPreview` is shared by every admitted actor. The Training
fixture uses the same capture's 18 identities, listed in
`TRAINING_NPC_IDENTITIES` and checked against the local capture. All eighteen meshes
render, including `WaltonSimons0` and `mib1` beside Jaime and `ScientistMale0`
behind him. The four guards use the recovered PF_Environment texture selection,
normal accumulation and reflection UV path. Their UVs update with the camera
even when the pose is unchanged. Character-specific geometry or skin logic is absent.

Training loads these meshes automatically with the map. The preview button and
Focus selector move only the inspection camera. Returning to Play or Player
start hides the focus controls but keeps the meshes visible. A footer label
identifies the live NPC binding in either mode. Preparing or displaying them must leave the
player, actor animation fields and runtime pause/error state unchanged.

`validate-npc-mesh-preview.mjs` checks this new integration boundary using the
actual Training runtime and local original identity capture: all 18 captured
identities, 18 complete mesh/texture uploads, recovered guard materials and
unchanged actor/player fields during sampling. A separate controlled section
calls each actor's original PlayWaiting method, advances the recovered animation
phase and verifies the shared buffer updates, tween continuity, bounds and
visibility. This is a script-animation fixture, not normal Play startup.
Existing native frame and material comparisons
establish the original behavior; this integration check does not establish
whole-renderer fidelity. Browser inspection confirms Jaime's room companions
and the medical bot are visible at their original locations with the scope label
present. The current UI can focus any of the 18 rendered actors.

Visibility follow-up: browser checks confirm automatic loading in Play,
Inspect-to-Play switching and Player start all retain 18 visible mesh previews
with no runtime error. The former mode/reset handlers incorrectly hid the
mesh group along with the focus controls; only the controls are now hidden.

## Whole-level prop meshes (`createActorMeshScene`)

Play no longer draws only the 18 captured NPCs. `createActorMeshScene` composes
the captured NPC layer with a general prop layer over every other visible
`LodMesh` actor in the live level — crates, the crowbar and combat-knife pickups,
ammo, plants, datacubes, keypads, security cameras, shop/cage lights, lamps,
multitools and the world NanoKey — so the collidable props JC walks into and
frobs are no longer invisible cylinders. `main.mjs` builds it for any map that
has a Play game. Training renders 18 NPC + 46 prop meshes (~11,974 triangles).

Props reuse the same `createActorMeshPreview`. A captured NPC keeps its measured
GObjObjects index; a prop uses a synthetic per-actor cache key. Each preview owns
an isolated `GetFrame` cache, and that key selects only tween/blend heap identity,
never the drawn geometry — every Training prop is `AnimSequence None`, so the
drawn pose is exact. `scripts/validate-actor-mesh-scene.mjs` checks the
composition, finite geometry, decoded skins, that static props do not re-upload
while environment props (camera lenses, datacube screens, the reflective HazMat
suit) track the camera, determinism, and that building the layer never moves,
ticks or mutates the shared runtime actors.

### World-pass visibility and Mesh changes — 2026-09-25

Which actors this layer draws follows Render.dll's level-actor pass
(`0x10b22e27`–`0x10b22ef8`) for the player's first-person frame. That pass
skips:
* the view actor and, unless `bBehindView` (`+0x318`), its `ViewTarget`
  (`+0x60c`);
* hidden actors (`bHidden`, `+0x28` bit 2);
* a `bOnlyOwnerSee` actor (`+0x1a0` bit 4) that the view actor does not
  own, or owns but sees from behind (IsOwnedBy walks `Owner`, `+0x3c`);
* an owned `bOwnerNoSee` actor (`+0x1a0` bit 2) in first person.

The same test gates admission and each frame's visibility. `bHighDetail`
and the editor's `bHiddenEd` branch are not modelled.

A script can change an actor's `Mesh`:
* `Inventory.BecomeItem` selects `PlayerViewMesh` and hides the item.
* `SkilledTool.PutDown` → `DownItem` unhides the owned tool while its
  Down animation plays, so the original draws it in the world pass too.
  `RenderOverlays` has placed it at the view offset.

The layer used to refuse this ("changed Mesh; rebuilding the inspection
resource is unsupported"), which paused Play whenever a lockpick or
multitool was put away. It now retires the old resource and admits the
actor again like a newly visible one. The new mesh decodes asynchronously
and appears once it is ready; that is a presentation latency, not game
state. `validate-actor-mesh-scene.mjs` picks up Multitool0, puts it in hand
and switches away through the original belt scripts. The tool must be
drawn with its POV mesh through `DownItem` and hidden afterwards, and the
owner rules are checked on it.

### Partial-face rendering

`createActorMeshPreview` builds each face group independently. An undecodable or
procedural/animated skin is skipped (recorded in `summary.skipped`) and the mesh
still draws its remaining solid faces. The world NanoKey carries a procedural
`FireTexture` effect face (`effects.electricity.biocell_sfx`, no stored pixel
data); its body renders while only that effect face is omitted. Skipped groups
are removed before the live pose/UV update, and an actor with no renderable face
still fails explicitly.

### Frob labels, safe prop frobs, in-hand HUD

Frob labels read the object's own original `ItemName` ("Crowbar", "General Supply
Crate", "10mm Ammo", "Houseplant"). A decoration/item whose real `Frob` reaches an
unbuilt subsystem — a DataCube's text parser, or item pickup's unlinked actor
iterator — surfaces the boundary as a message instead of halting the scene;
conversation pawns still pause honestly. The Play HUD draws the live `inHand` item
bottom-right with the item's original belt `Icon` and `ItemName`, so putting the
nanokey ring in and out of hand is visible. This is a Play readout of real state,
not the original object-belt window.

### Item pickup (implemented) and the remaining boundary

Picking up a Training weapon/tool/ammo/food/key now runs the real frob give path
F → `ParseRightClick` → `HandleItemPickup` → `DoFrob` → the item's Pickup-state
`Frob`, taking it into JC's inventory; the item's world mesh then hides through
this scene's own `bHidden` path. See [item pickup](script-item-pickup.md). The
remaining boundary is selecting a picked-up weapon into hand (its first-person
view mesh is not prepared) plus weapon fire / crate breaking, and reaching
`UNATCOTroop3` still needs the locked keypad doors `paddoor`/`hackdoor`.

### Runtime-spawned identities and damage/fade fields

The layer now reconciles live Level.Actors on every update. Mesh actors spawned
after map load (including crate fragments and dropped contents) acquire the same
GPU resources asynchronously. Deleted actors hide immediately; identities
removed on destruction/reset release their draw resources. Original ScaleGlow
and live Style update materials without altering actor animation. Their native
color multiplication and the first-person DrawActor path are recorded in
[weapon/rendering evidence](script-weapon-rendering.md). Mesh lighting remains
the recovered per-vertex path; its remaining unsupported branches are listed
in [mesh lighting](mesh-lighting.md).
