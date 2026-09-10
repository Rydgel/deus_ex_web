# Stage 3 handoff — 2026-09-10

Work stopped at the user's request to conserve tokens. Resume implementation
only when requested. Stage 3 is **unfinished**, saved in a progress checkpoint
commit at the user's request. Stage 2 is
committed as `3a74d2b` (`Implement source-backed Stage 2 playable slice`).
All agents stopped; their final research notes are preserved below.

After this handoff, the user reported disabled Play. A bounded loader fix was
made: Vite's local manifest omitted Sounds/Music and `.uax`/`.umx`, so the
expanded map host failed with `Missing package: Training_Music`. The two-line
fix in `vite.config.mjs` now serves those original package types locally.
Verification through the actual HTTP manifest/file endpoints initialized
training Play and advanced JC to grounded successfully. Reload the page to
discard the old manifest. This fix is included in the checkpoint; Stage 3 work stayed stopped.

## Working rules

- Follow [AGENTS.md](../AGENTS.md): independently translate original data,
  bytecode and native instructions. Do not substitute guessed behavior.
- Keep delivery local; do not commit, push or deploy without a request.
- Keep JavaScript; no performance/WASM detour.
- Use focused checks at new translation/integration boundaries. Do not rerun
  passing checks without a change or unresolved concern. Nonvisual Stage 3
  work has no visual-comparison gate.
- Use bounded subagent tasks when useful, with explicit file ownership; prefer
  the configured `luna_worker`. Preserve existing uncommitted work.

## Implemented, with scope limits

| Area | Current result | Reference |
| --- | --- | --- |
| VM and doors | Original selected door functions/state bytecode run in Play; typed fields/parameters, inheritance, events, state transitions, timers and selected latent/native paths work. | [Runtime scope](script-runtime.md), [doors](script-doors.md) |
| Object lifecycle | Source-backed construction, ownership, destruction, metadata/linking, serialization and GC components; concrete CameraPoint paths and Core.Object registration have focused coverage. Full native world/resource graph remains incomplete. | [Roadmap Stage 3](roadmap.md#3-execute-game-behavior) |
| Map actor host | Full serialized actor array, null slots, canonical identities, typed authored properties and inherited resource references. Training host has 1,337 original slots plus JC. | [Map actors](script-map-actors.md) |
| Script lights | Original TriggerLight startup, TriggerToggle and Tick execute through the shared host. Actual inherited Decoration.Frob exercises AllActors fanout in a fixture. Full LightSwitch.Frob and automatic Play integration remain open. | [Lights](script-lights.md), `src/runtime/script-lights.mjs` |
| Sound native | PlaySound264 and CheckHearSound translated: live argument defaults, optional demo recording, channel IDs, listener traversal, distance/occlusion gates. Native events and live host graph are explicit services; no audible playback yet. | [Sound](script-sound.md), `src/runtime/script-sound.mjs` |
| Sound BSP trace | Original UModel.FastLineCheck translated and used by the sound helper. This differs from movement LineCheck in flags and plane-boundary rules. | [FastLineCheck](fast-line-check.md), `src/runtime/fast-line-check.mjs` |
| Atlas | Existing lightmap tiles can be replaced without changing UVs, including padding and texture upload invalidation. Original light-cache rebuild timing is not wired. | `src/viewer/light-atlas.mjs` |
| Plant scripts | Actual inherited Plant2 Bump/Timer execute in a focused VM fixture. Sound/AI requests there remain recorded external boundaries. | [Plant contact](script-plant-contact.md) |

**User-visible plant issue remains:** normal walls are okay; Plant7 contact
reaches `Unsupported original scene event: Plant7.Bump`. Play pauses with an
explanation; rendering and Player start reset remain usable. This is not fixed
plant pushing. Do not enable the route by swallowing the callback or replacing
the original push behavior with a no-op.

## What remains

1. **Complete the training LightSwitch route.** Decode/bind mesh sequences and
   implement PlayAnim259; implement startup conversation binding; connect the
   sound native to real object indices, level/listener state and native events.
   Then connect player Frob, original light ticking and renderer updates.
2. **Finish script-controlled lighting updates.** Establish the original
   brightness/cache invalidation path, including bLightChanged lifetime and
   surface sample rebuilds. Atlas replacement alone does not solve this.
3. **Enable original plant pushing.** Wire inherited Bump/Timer dispatch,
   decoration physics/ticking, live collision-hash updates, sound lifetime and
   AI events. Preserve target-first Bump order. Burning/rolling branches must
   remain explicit until their native/state dependencies are supported.
4. **Finish the Stage 3 runtime graph.** Complex native property linking,
   class/resource loading, config/localization resources, broader spawning,
   full serialization/release/GC integration and global native object identity.
5. **Expand actual native coverage.** Engine/game behavior plus Deus Ex UI and
   conversation systems; use [the coverage inventory](script-coverage.md).
   These are still required even after a switch or plant path works.

## Research recovered at stop, not implemented

These agent findings were returned in conversation; no animation or conversation
module was saved. Preserve them as investigation anchors, not completed behavior.

- **Animation:** Engine.dll PlayAnim259 thunk `103011b8`, body `103e0160`.
  Defaults Rate=1, TweenTime=-1; Actor.Mesh `+174`; sequence lookup virtual
  `+68`. GetAnimSeq bodies `1031c000`/`1031c050` scan mesh `+84` data, `+88`
  count, stride `20` hex, matching FName at entry+0. Animation stores include
  Actor `+54/+58/+5c/+60`, `+220/+224/+228`, and SimAnim `+22c..+23c`.
  DeusExDeco.LightSwitch is LodMesh export606, 1,272 bytes. Serialized sequence
  decoding and native implementation remain unfinished.
- **Conversation binding:** DeusEx.dll ConBindEvents2101 body `1000ea50`,
  wrapper `1000e9d0`. It finds the first DeusExLevelInfo in Level.Actors,
  derives the conversation package/mission path (default training path
  `DeusExConText.ConList_Mission00`), loads DConversationList, then calls
  ConSys BindConversations `10010b70`. Purge `10010cf0` precedes binding;
  DConListItem links into actor+`2dc`, conversation ownerRefCount at+`74`.
  Training list exists with 470 entries. Agent reported empty switch binding
  names and zero matches; this is not an implemented/validated startup path.
  Do not replace StartConversation with unconditional false.
- **Surface cache:** Render.dll SetupForSurf `10b06c90` reaches
  ComputeFromActor `10b05fa0`, which reads live brightness at `10b060b3`.
  Cache gates `10b0645e` and `10b06994` test actor flags+28 mask `400`
  (bLightChanged). Training lights are excluded from SetupDynamics without
  bDynamicLight (`800`). TriggerLight.Tick writes brightness directly;
  the bLightChanged setter/clear and exact subsequent update path were not
  established. Do not infer that arbitrary dependency invalidation is faithful.

## Verification already performed

- `node --test test/script-sound.test.mjs` passed the focused sound ordering,
  live listener/default reads, ViewTarget and occlusion checks.
- `node --test test/fast-line-check.test.mjs` passed. Its plane/flag and
  two-node slab reference results were first obtained from the original DLL
  through the existing NativeCollision emulator.
- Earlier `node scripts/validate-script-lights.mjs` passed against the actual
  createGame host, including canonical actors/resources, four-light fanout,
  original brightness/corona changes, reversal and reset. Its null conversation
  list is explicitly **pre-native-startup**, not proof of post-startup behavior.
- Earlier focused object identity, VM conversion and atlas-update checks passed;
  training doors still opened/reset and Liberty Island spawned/landed. The last
  production build passed before the latest standalone sound/BSP additions.
- No additional visual gate or full-suite rerun is needed merely to resume.

Original binaries/assets remain ignored in `Deus Ex GOTY Edition`. Existing
disassemblies: `.cache/reference/Engine.asm`, `.cache/reference/Render.asm`,
`.cache/research/Core.asm`. Native probes use
`.cache/native-probe-env/bin/python` and `scripts/native-collision-oracle.py`.
Start with the documented gaps above instead of repeating completed research.
