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

The mesh uses **texture-only inspection shading**, explicitly labeled in the
view. `bUnlit` remains false on the actor. No guessed mesh lighting is installed
as original behavior. Full resolution is deliberate inspection behavior, not
a claim that DrawLodMesh's distance-dependent topology is complete.

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
