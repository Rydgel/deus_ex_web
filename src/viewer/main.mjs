import { hitchEnabled, createHitchLog } from './hitch-log.mjs';
import * as THREE from 'three';
import './style.css';
import { closeToolbarMenus } from './toolbar.mjs';
import { AssetStore } from '../unreal/assets.mjs';
import { readGlobalConfigBool, parseIniValue } from '../unreal/user-config.mjs';
import { decodeIniBytes } from '../runtime/ini-bytes.mjs';
import { openConfigPersistence, persistenceMode } from '../runtime/config-persistence.mjs';
import { openSavePersistence, saveMode, devServedSaves } from './save-persistence.mjs';
import { createSavesUi } from './saves-ui.mjs';
import { hostSaveDirectory } from '../runtime/save-directory.mjs';
import { setSaveSink } from '../runtime/save-sink.mjs';
import { chosenResolution } from '../runtime/display-config.mjs';
import { decodeMap } from '../unreal/map.mjs';
import { filedLevel } from './restore-asset.mjs';
import { toView, fromView } from '../unreal/geometry.mjs';
import { createWorld } from './world.mjs';
import { createSimHost } from './sim-host.mjs';
import { createSimClient } from './sim-client.mjs';
import { frameProjection as vertexProjection } from './frame-projection.mjs';
import { createPlayCamera, pointCamera, applyPlayFrame, verticalFov, rotatorEuler, setPixelCentre, projectionState, setProjectionState, PLAY_NEAR, PLAY_FAR } from './play-camera.mjs';
import { createSpriteScene } from './sprite-scene.mjs';
import { sharedProceduralTextures } from './procedural-textures.mjs';
import { createDecalScene } from './decal-scene.mjs';
import { createDetailScene } from './detail-scene.mjs';
import { unpackDetail } from '../runtime/detail-draw.mjs';
import { detailTexturesOn, modelSurfaceDetails } from '../runtime/detail-pass.mjs';
import { decalProbe, particleProbe, placeProbe, laserProbe, meshLightProbe, renderPassProbe } from './decal-probe.mjs';
import { viewProbe } from './view-probe.mjs';
import { DECAL_LAYER } from './render-layers.mjs';
import { createCoronaPass } from './corona-pass.mjs';
import { TextureStore } from '../unreal/textures.mjs';
import { createHudRenderer } from './hud.mjs';
import { expandHudStream } from '../runtime/script-window-command-stream.mjs';
import { createFlashPass } from './flash-pass.mjs';
import { createProgressFrame } from './progress-frame.mjs';
import { createActorMeshDraw } from './actor-mesh-draw.mjs';
import { bindingView } from './npc-mesh-preview.mjs';
import { createGpuMesh } from './gpu-mesh.mjs';
import { WEAPON_GPU_MESH_CAPACITIES } from './gpu-mesh-layout.mjs';
import { createWeaponOverlayDraw } from './weapon-overlay-draw.mjs';
import { packViews } from './mesh-frame-pack.mjs';
import {pointerButtonKey,windowPointerSample} from './window-pointer.mjs';
import { typedCharacters } from './typed-characters.mjs';
import { GAME_KEY_CODES } from './input-key-names.mjs';
import { createWheelAccumulator, wheelUnits } from './wheel-input.mjs';
import {pcm16} from '../runtime/galaxy-lipsync-channels.mjs';
import { setDisplayRampPerFragment } from './light-atlas.mjs';
import { createDisplayRamp, brightnessGamma } from './display-ramp.mjs';
import { CRT_PRESETS, prepareCrtPreset } from './crt-shader.mjs';
import { stateDigest } from '../runtime/state-digest.mjs';
import { createMusicOutput } from './galaxy-music-output.mjs';
import { connectMusicLibraryPort, driveMusicLibrary } from '../runtime/galaxy-music-library.mjs';
import { msvcrtWtoi } from '../runtime/script-text-parser.mjs';
import { createFrameKeeper } from './frame-keeper.mjs';
import { snapshotGrey } from '../runtime/script-root-snapshot.mjs';
import { createShaderWarmup, shaderWarmupOn } from './shader-warmup.mjs';

// Sound effects and ambient sounds play through Galaxy's own mixer in the
// music worklet (docs/galaxy-audio.md "Effects through Galaxy's mixer");
// ?sfx=webaudio keeps the previous Web Audio host mapping (main.mjs
// galaxyVoice), for A/B. Without the worklet (?music=0) effects use it too.
const sfxParam=new URLSearchParams(location.search).get('sfx');
if(sfxParam)globalThis.DEUS_EX_SFX=sfxParam;
// Script function bodies run in the Rust interpreter by default
// (docs/rust-core.md R2b); ?scriptVm=js keeps the JavaScript VM.
const scriptVmParam=new URLSearchParams(location.search).get('scriptVm');
if(scriptVmParam)globalThis.DEUS_EX_SCRIPT_VM=scriptVmParam;
// Fire.dll's procedural texture ticks run in the Rust core
// (docs/fire-texture.md "Rust kernel"); ?fireKernel=js keeps the JavaScript.
const fireKernelParam=new URLSearchParams(location.search).get('fireKernel');
if(fireKernelParam)globalThis.DEUS_EX_FIRE_KERNEL=fireKernelParam;
// The animated light-map merge runs in the Rust core (docs/static-lighting.md
// "Rust kernel"); ?lightKernel=js keeps the JavaScript.
const lightKernelParam=new URLSearchParams(location.search).get('lightKernel');
if(lightKernelParam)globalThis.DEUS_EX_LIGHT_KERNEL=lightKernelParam;
// Moving lights recompose only the light maps a changed light reaches
// (moving-lights.mjs); ?movingLights=full keeps the whole-frame recompute. ?movingCompose=js composes them in the JavaScript bodies
// (addDirect, light-atlas.mjs update) instead of the Rust core (moving.rs); ?movingCompose=verify runs both and compares every float
// and byte (deusExViewer.movingLights().stats.verify).
const movingLightsParam=new URLSearchParams(location.search).get('movingLights');
if(movingLightsParam)globalThis.DEUS_EX_MOVING_LIGHTS=movingLightsParam;
// Measurement only: ?moverRelight=off keeps every mover's light maps as the
// world built them (no SetupForSurf cache header, world.relightMovers), the
// A arm of its cost (docs/static-lighting.md "Mover surfaces in SetupForSurf").
const moverRelight=new URLSearchParams(location.search).get('moverRelight')!=='off';
// Measurement only: ?fogOrder=last draws the fog-map pass after every other world item, its place before 2026-10-28, the A arm
// of DrawComplexSurface's order (render-layers.mjs FOG_RENDER_ORDER; deusExViewer.fogOrder switches it at run time).
const fogOrderParam=new URLSearchParams(location.search).get('fogOrder');
// The render scan (script-vm-render.mjs) filters Level.Actors in Rust for
// the moving lights, sprites, mesh admission and Galaxy's ambient scan;
// ?renderScan=js keeps the JavaScript loops, ?renderScan=verify checks every
// scan against them. The same js/verify switches: ?laser= for the laser
// iterator's CurrentItem (laser-kernel.mjs), ?meshLight= for
// SetupForActor's light selection (script-vm-meshlight.mjs), ?cycleScan= for
// CycleActors and ?actorScan= for AllActors and RadiusActors (script-iterators.mjs),
// ?destroyScan= for DestroyActor's SetOwner/EndTouch scan (script-destroy.mjs), ?fogUpload=page for
// whole fog pages and ?fogCopy=from for the fog maps' `from` copies (fog-pass.mjs), ?fogLights=each for the fog kernel's lights sorted and
// written for every surface (volumetric-fog.mjs fogMapKernel), ?fogKernel=reference for the fog loop one texel at a time per light (the
// block loop, fog.rs walk_blocks, is the default) and ?fogKernel=verify to run both and count the differing maps, ?fogPass=reference for the
// fog pass' host side as it was before 2026-11-07 (?fogPass=verify runs both and counts what differs), ?fogNotes=1 for the fog pass' validation notes
// (fog-pass.mjs; validate-volumetric-fog-play.mjs asks for it), ?levelScan= for the level loop's
// DistanceFromPlayer and compaction passes (level.rs), ?levelLoop= for its
// actor loop (level_loop.rs, actor-tick-kernel.mjs `batch`), ?farMove= for the
// noncolliding FarMoveActor (render.rs far_move), ?particles= for
// execUpdateParticles (particles.rs), ?gcNative= for the HUD's GC state
// and tile natives (gc.rs, script-vm-gc.mjs), ?pawnPhysics=js for a
// walking pawn's performPhysics (pawn_phys.rs, pawn-physics-kernel.mjs) and
// ?actorPhysics=js for a falling non-Pawn's (fall.rs, actor-physics-kernel.mjs), ?walkLoopKernel=js and ?movePawnKernel=js for the
// walking loop's and a pawn MoveActor's Rust bodies (walk-loop-kernel.mjs, move-pawn-kernel.mjs; the live-scene walk trace needs the JavaScript twins).
// ?moverTracker=off keeps movers out of the BSP (brush-tracker.mjs): drawn
// whole and frustum-stamped, as before the moving brush tracker.
// ?childFrames=off keeps OccludeFrame's child frames out of Play: mirror
// and sky passes drawn whole and planned and stamped by the frustum.
// ?iteratorFrames=off keeps the root frame's render-iterator items in every
// child frame (each frame's SetupDynamics builds its own otherwise).
// ?globalCalls=js keeps EX_GlobalFunction calls (`Global.Tick(...)`) in the JavaScript VM (script-vm-lower.mjs globalCallMode);
// ?globalCalls=verify runs them in Rust and checks each resolution against the class chain.
// ?tickReads=js asks the runtime for the actor tick's reads of other objects (the zone render time, the owner's bTicked, the event gate's
// bBegunPlay: actor-tick-kernel.mjs tickReadsMode); ?tickReads=verify answers them in Rust and compares each with the runtime's.
// ?workerBusy=1 keeps the simulation worker's event queue non-empty (sim-worker.mjs), so Firefox never
// arms the worker's idle GC timer (docs/play-frame-cost.md "October 14, later"); it costs one core.
// ?navSearch=js keeps FindPathToward's open-list search in JavaScript, ?navSearch=verify runs both bodies and compares them (nav.rs,
// script-vm-nav.mjs).
// ?actorPlumbing=js keeps the reference bodies of the actor layer's host plumbing (record skipping, the pair table, the candidate
// pack, the movers' reads: actor-plumbing.mjs); ?actorPlumbing=verify checks the new bodies against them as it goes.
// ?epochScope=global keeps the receiver epoch's reference: every attach and binding advances it, whether or not the object
// has a handle yet (receiver-epoch.mjs bumpReceiverEpochFor). ?handleMirror=js rebuilds the Rust core's copies of Level.Actors
// (level loop, render scans, perception) with handleOf on every slot; =verify checks the kept handles against it
// (actor-handle-mirror.mjs).
// ?decalFast=off runs the decal attach's surface finder and node gatherer as the reference x87 expressions, ?decalFast=verify runs both
// and throws on a difference (decal/fast.rs, docs/decals.md "Fast surface finding"); ?decalFastTable=N sizes its edge table (a power of two, 16384).
// ?playerPawn=js keeps GetPlayerPawn (native 720) in the script VM's native call through invokeNative and the native chain; the default
// answers it in js_object with the resolver that chain reaches (script-vm-rust.mjs playerPawn); =verify compares the two.
// ?riderTable=js drops the rider scan's table of Base reads at every advance of the base epoch, as before (base-epoch.mjs); the default
// keeps it across CompactActors' shifts and an attach, forgetting only the slots whose own cells changed; =verify compares every slot kept
// with a fresh fill at each scan.
// ?compactScan=js reads every actor's bDeleteMe in compactScriptActors' loop; the default asks the Rust core for the slots to read (level.rs
// level_flagged), =verify reads the others too and compares. ?soundRead=js keeps the Error that PlaySound's graph reads of the level container
// throw out of instance() (script-runtime.mjs reflectedField), =verify checks that it would throw. ?decalFollow=js writes every Mover surface's
// rotation words at each AttachDecal (script-decal.mjs followDecalTracker); the default writes a mover's when its rotation changed, =verify
// checks the words kept in memory.
// ?configFind=js asks the native config tables for a property's field list at every read (script-native-config.mjs findIn; every AttachDecal
// reads Client.Decals), the default keeps the answer per class and name; ?inputFields=js walks the player's class for its input properties
// at every ReadInput (script-console-command.mjs), the default keeps the list per class. =verify for both asks fresh as well and compares.
// ?playerPawn=rust (the default now) lowers GetPlayerPawn to a Rust node over a cell the host keeps (script-vm-player-pawn.mjs), =direct is
// the js_object answer above. ?outStruct=js keeps calls with struct out parameters (HUDHitDisplay.SetHitColor) whole in JavaScript, the
// default copies the struct in and back in Rust (interp.rs CALL_OUT); ?foreachStart=js keeps the CycleActors foreach on the frame's
// JavaScript iterator stack, the default starts and steps it in Rust (iter.rs). =verify for both compares every copy and step with the
// JavaScript codecs and a shadow iterator (script-vm-foreach.mjs).
// ?structArrays=js keeps a struct local's fixed-array members, vector members and elements, stores to array elements, vector parameters
// of a call and struct out or by-value arguments with nested or vector members (ScriptedPawn.GetProjectileList's NearbyProjectileList)
// with the JavaScript VM; the default runs them in Rust (interp.rs SET_LOCAL_ELEM, LOCAL_ELEM_VECTOR, P_VECTOR, P_STRUCT_IN, iter.rs);
// =verify reads every stored element back through the closure and compares each struct copy leaf by leaf.
// ?setRotation=js keeps the SetRotation statement (native 299) in the JavaScript VM (script-set-rotation.mjs); the default runs it in Rust over the
// object image (interp.rs SET_ROTATION), =verify decides each statement again from readNamed. ?cleanupScan=js keeps CleanupDestroyed's pass over
// every actor's object pointers in JavaScript (script-cleanup.mjs cleanupImageSites) and the registry-wide filter of the collection's release; the
// default scans the pointers in Rust (cleanup.rs, script-vm-cleanup.mjs) and finds the released objects from a log; =verify runs both and compares.
// ?projectilePhysics=js keeps a non-Pawn's PHYS_Projectile (physProjectile: the Dockyard's poison gas, Tracers, rockets) in the JavaScript
// reference (projectile.mjs); the default runs it in Rust beside the falling body (fall.rs perform_projectile, actor-physics-kernel.mjs).
// ?actorPhysics=js keeps both.
// ?switchCache=js reads every DEUS_EX_* switch with its full expression at each call (src/runtime/switch-reader.mjs: `typeof process` and a
// missing global cost 400 ns in Firefox, 0.57 ms of a Dockyard frame); the default reads each switch once, at its first use, after the
// lines below have set them; =verify checks the kept answer against the full read at each call.
// ?actorNames=js rebuilds the name maps over Level.Actors (the texture pans' zone names, game.mjs surfacePan, and the mesh lighting's names and
// membership set, mesh-lighting-view.mjs levelMembership) whenever the actors epoch advances; the default keeps them across spawns and destroys
// (actor-names.mjs); =verify compares them with a fresh build at each update.
// ?hasScan=js asks a bound receiver's binding set about every position of the field table in the Rust scans (render.rs, loco.rs Obj::has: the
// destroy, render and level scans, the locomotion polls); the default walks the set bits of the question; =verify runs both and traps on a difference.
// ?imageCheck=js walks a class's whole defaults Map against its image's snapshot at every construction (script-runtime.mjs classImage); the default
// compares the version the class's DefaultsMap counts (defaults-map.mjs) and walks only after a change; =verify also walks, and throws on a difference.
// ?areaScan=js keeps RadiusActors' and VisibleActors' loops over Level.Actors in JavaScript (script-iterators.mjs scanArea); the default runs their
// class, bHidden and radius tests in the Rust core (render.rs area_scan, the Cloud timer's foreach VisibleActors walks every actor of the level);
// ?actorScan=verify runs both and compares.
// ?x87=ref runs the x87 model's add, multiply, divide, square root and normalization on the u128 bodies of x87_ref.rs (script-vm-ref.wasm,
// scripts/build-x87-ref.mjs) instead of the limb arithmetic of x87.rs (docs/firefox-60fps-plan.md "Combat tick").
// ?fcoordsCache=off computes every FCoords(FRotator) of the AI perception, locomotion and decal code in full; the default keeps the last 32
// distinct rotations' axes (percep.rs fcoords_axes, a pure function of the rotation).
// ?actorOcclusion=frustum draws and stamps the main frame's actors from the
// frustum-tested drawn set instead of OccludeBsp's Frame->Sprite
// (dynamics-candidates.mjs, docs/bsp-occlusion.md "Play").
for(const [param,global] of [['x87','DEUS_EX_X87'],['fcoordsCache','DEUS_EX_FCOORDS_CACHE'],['renderScan','DEUS_EX_RENDER_SCAN'],['laser','DEUS_EX_LASER'],['levelLoop','DEUS_EX_LEVEL_LOOP'],['meshLight','DEUS_EX_MESH_LIGHT'],
  ['cycleScan','DEUS_EX_CYCLE_SCAN'],['actorScan','DEUS_EX_ACTOR_SCAN'],['areaScan','DEUS_EX_AREA_SCAN'],['destroyScan','DEUS_EX_DESTROY_SCAN'],['fogUpload','DEUS_EX_FOG_UPLOAD'],['fogCopy','DEUS_EX_FOG_COPY'],['fogLights','DEUS_EX_FOG_LIGHTS'],['fogKernel','DEUS_EX_FOG_KERNEL'],['fogPass','DEUS_EX_FOG_PASS'],['movingCompose','DEUS_EX_MOVING_COMPOSE'],['fogNotes','DEUS_EX_FOG_NOTES'],['levelScan','DEUS_EX_LEVEL_SCAN'],['farMove','DEUS_EX_FAR_MOVE'],
  ['particles','DEUS_EX_PARTICLES'],['particleItems','DEUS_EX_PARTICLE_ITEMS'],['gcNative','DEUS_EX_GC_NATIVE'],['pawnPhysics','DEUS_EX_PAWN_PHYSICS'],
  ['actorPhysics','DEUS_EX_ACTOR_PHYSICS'],['projectilePhysics','DEUS_EX_PROJECTILE_PHYSICS'],['actorOcclusion','DEUS_EX_ACTOR_OCCLUSION'],
  ['walkLoopKernel','DEUS_EX_WALK_LOOP_KERNEL'],['movePawnKernel','DEUS_EX_MOVE_PAWN_KERNEL'],['moverTracker','DEUS_EX_MOVER_TRACKER'],['trackedCollision','DEUS_EX_TRACKED_COLLISION'],['childFrames','DEUS_EX_CHILD_FRAMES'],['iteratorFrames','DEUS_EX_ITERATOR_FRAMES'],['workerBusy','DEUS_EX_WORKER_BUSY'],['leafLists','DEUS_EX_LEAF_LISTS'],['detailTextures','DEUS_EX_DETAIL_TEXTURES'],['navSearch','DEUS_EX_NAV_SEARCH'],['collisionHost','DEUS_EX_COLLISION_HOST'],['globalCalls','DEUS_EX_GLOBAL_CALLS'],['actorPlumbing','DEUS_EX_ACTOR_PLUMBING'],['windowDraw','DEUS_EX_WINDOW_DRAW'],['tickReads','DEUS_EX_TICK_READS'],['epochScope','DEUS_EX_EPOCH_SCOPE'],['handleMirror','DEUS_EX_HANDLE_MIRROR'],['decalFast','DEUS_EX_DECAL_FAST'],['decalFastTable','DEUS_EX_DECAL_FAST_TABLE'],['playerPawn','DEUS_EX_PLAYER_PAWN'],['outStruct','DEUS_EX_OUT_STRUCT'],['structArrays','DEUS_EX_STRUCT_ARRAYS'],['setRotation','DEUS_EX_SET_ROTATION'],['cleanupScan','DEUS_EX_CLEANUP_SCAN'],['foreachStart','DEUS_EX_FOREACH_START'],['riderTable','DEUS_EX_RIDER_TABLE'],['compactScan','DEUS_EX_COMPACT_SCAN'],['soundRead','DEUS_EX_SOUND_READ'],['decalFollow','DEUS_EX_DECAL_FOLLOW'],['configFind','DEUS_EX_CONFIG_FIND'],['inputFields','DEUS_EX_INPUT_FIELDS'],['switchCache','DEUS_EX_SWITCH_CACHE'],['actorNames','DEUS_EX_ACTOR_NAMES'],['hasScan','DEUS_EX_HAS_SCAN'],['imageCheck','DEUS_EX_IMAGE_CHECK']]) {
  const value=new URLSearchParams(location.search).get(param);
  if(value)globalThis[global]=value;
}
// ?detailTextures=0 models a device without BLENDDIFFUSEALPHA: D3DDrv's SetRes clears URenderDevice.DetailTextures there and
// DrawComplexSurface skips the detail-texture pass (docs/frame-projection.md "Detail textures"). Wine's ddraw lacks the cap, so every
// stored Wine capture of the original needs it, as it needs ?antialias=0 (docs/visual-acceptance.md).
// ?leafLists=full builds every leaf's moving-light list each frame (the Filter walk in full) instead of
// the lists the frame's drawn actors and the corona pass ask for (dynamic-lighting.mjs movingLightLeafList).
// ?hitchlog=1 (hitch-log.mjs, docs/hitch-log.md) also reaches the simulation worker, for its frame record.
if (hitchEnabled) globalThis.DEUS_EX_HITCHLOG = '1';
// ?childFog=off: the child frames' passes reuse the root frame's fog maps
// (as before each frame had its own, fog-pass.mjs framePass).
const childFog = new URLSearchParams(location.search).get('childFog') !== 'off';
// ?cameraFog=off|nomovers (an experiment, docs/visual-acceptance.md "Security cameras"): a ViewportWindow's frame draws no fog maps, or none
// on its mover draw items, to attribute a camera window's difference to the fog pass.
const cameraFog = new URLSearchParams(location.search).get('cameraFog');
// The original's display gamma ramp maps the finished 8-bit framebuffer, HUD
// included (D3DDrv SetGammaRamp, display-ramp.mjs): shaders draw raw colours
// and one pass ramps the frame. ?gamma=material keeps the earlier ramp in
// every shader, before blending (docs/lighting.md "Display ramp").
const rampPerFragment = new URLSearchParams(location.search).get('gamma') === 'material';
setDisplayRampPerFragment(rampPerFragment);
const displayRamp = rampPerFragment ? null : createDisplayRamp();
// A browser display preference, outside the recovered game settings.
let crtEnabled = false, crtMaterialRamp = null, crtShortcutHeld = false;
let crtShader = 'aperture', crtCompare = false;
let crtToggleVersion = 0;
const canvasClear = new THREE.Color('#06101b'), screenClear = new THREE.Color(0, 0, 0);
// ?gpuTimer=1: one EXT_disjoint_timer_query_webgl2 TIME_ELAPSED query around
// the frame's GL work, read back frames later (docs/play-frame-cost.md).
// Measurement only; scripts/profile-play-browser.mjs --gpu sets it.
const gpuTimerParam=new URLSearchParams(location.search).get('gpuTimer')==='1'||hitchEnabled;
// The level's shader programs are built while the map loads (shader-warmup.mjs, docs/hitch-log.md "Shader programs"),
// not at the first draw that needs each one; ?shaderWarmup=0 turns it off. Its last result is in status().
let shaderWarmupResult=null;
// ?seed=N: the shared random stream's srand seed instead of time(NULL), for
// comparing two runs of one scenario (scripts/validate-sim-split.mjs).
const seedParam=new URLSearchParams(location.search).get('seed');
const randomSeed=seedParam===null?undefined:Number(seedParam)>>>0;
// ?hold=1: the frame loop does nothing until deusExViewer.release(), whose
// first frame takes a 1/60 s step; with ?seed= and a paused fake clock two
// runs then see the same frames (scripts/validate-sim-split.mjs).
const holdParam=new URLSearchParams(location.search).get('hold')==='1';
let held=holdParam;
// ?simVerify=1: every frame, the simulation side's drawn set (sim-session.mjs
// stamps, which writes LastRenderTime) against what three.js drew: the
// onAfterRender of mover meshes, sprites and actor meshes (docs/sim-worker.md).
const simVerify=new URLSearchParams(location.search).get('simVerify')==='1';
// ?cheat=summon Lockpick*10: original console commands, ';'-separated with an
// optional *N repeat, run at each Player start through the recovered exec
// chain after the bCheatsEnabled write that stands in for the original's
// `set DeusEx.JCDentonMale bCheatsEnabled True` (view-probe.mjs). A
// recording aid; DeusExPlayer.Summon spawns in front of the player.
const startCheats=(new URLSearchParams(location.search).get('cheat')??'').split(';').flatMap(part=>{
  const [,command,count]=/^(.*?)(?:\*(\d+))?$/.exec(part.trim());
  return command.trim()?Array(Math.min(Number(count??1),100)).fill(command.trim()):[];
});
const drew={movers:new Set(),sprites:new Set(),actors:new Set(),weapon:new Set()};
// The simulation runs in a module worker by default (sim-worker.mjs,
// docs/sim-worker.md "Modes"). ?sim=inline runs it on the page and hands its
// snapshot over directly; ?sim=clone does the same through structuredClone
// after a check that the input, the snapshot and the events between frames
// hold plain data only, as they do to and from the worker. The Training
// previews, the NPC focus list and ?simVerify=1 (which implies inline) drive
// or read the runtime on the page.
// Firefox defaults to inline: Gecko runs a full compacting GC in a worker about five seconds after its event queue
// drains, so a worker that idles between frames pauses for its whole heap every ~5.5 s, while the page's collections
// are incremental (docs/hitch-log.md "Firefox"; on the user's Mac: 208-398 ms stalls in the worker, none inline, at the
// same frame rate). ?sim=worker still forces the worker there.
const geckoPage=/\bFirefox\//.test(navigator.userAgent);
const simMode=(({inline:'inline',clone:'clone',worker:'worker'})[new URLSearchParams(location.search).get('sim')])
  ??(simVerify||geckoPage?'inline':'worker');
// ?hold=1 with ?sim=worker: each snapshot is drawn as it arrives and
// deusExViewer.settled() waits for it, so a test steps one simulation frame
// per display frame (scripts/validate-sim-split.mjs).
const lockstep=simMode==='worker'&&new URLSearchParams(location.search).get('hold')==='1';
function assertPlain(value,path,seen){
  if(value===null||typeof value!=='object'){
    if(typeof value==='function'||typeof value==='symbol')throw new Error(`?sim=clone: ${path} is a ${typeof value}`);
    return;
  }
  if(ArrayBuffer.isView(value)||value instanceof ArrayBuffer||seen.has(value))return;
  seen.add(value);
  if(Array.isArray(value)){value.forEach((item,i)=>assertPlain(item,`${path}[${i}]`,seen));return;}
  if(value instanceof Map){for(const [key,item] of value){assertPlain(key,`${path} key`,seen);assertPlain(item,`${path}.get(${key})`,seen);}return;}
  if(value instanceof Set){for(const item of value)assertPlain(item,`${path} item`,seen);return;}
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)throw new Error(`?sim=clone: ${path} is a ${prototype?.constructor?.name??'class instance'}`);
  for(const [key,item] of Object.entries(value))assertPlain(item,`${path}.${key}`,seen);
}
const crossing=value=>{if(simMode!=='clone')return value;assertPlain(value,'value',new Set());return structuredClone(value);};
/** The simulation side's handover to the page (sim-session.mjs events), in
 * order, to the given world, actor mesh layer and view model. */
function applySimEvents(events,{world:target,actors,weapon}){
  for(const event of events){
    if(event.kind==='lighting')target.updateLighting(event.changes);
    else if(event.kind==='mesh-create')actors?.draw.create(event.creation);
    else if(event.kind==='mesh-release')actors?.draw.release(event.id);
    else if(event.kind==='weapon-create')weapon?.create(event.creation);
    else if(event.kind==='weapon-release')weapon?.release(event.id);
    else throw new Error(`Unknown simulation event ${event.kind}`);
  }
}

const $ = id => document.getElementById(id);
// The page starts as the original does (docs/boot.md): the splash while the files load, then DeusEx.ini's LocalMap DX.dx in Play with no page
// bars. ?debug=1 is the debugging page: the toolbar, Inspect, the map list and 00_Training first (every tool and validator opens it, scripts/page-url.mjs).
const originalStart = new URLSearchParams(location.search).get('debug') !== '1';
if (originalStart) $('app').classList.add('original-start');
// ?loadout=1 (the debugging page only): debug-loadout.mjs gives JC its items, augmentations, skills, ammunition and credits at each Player start and
// each map opened from the list, not at a travel's arrival or a loaded game (the inventory travels with the player). Tools ▸ Give loadout
// gives it once, now.
const loadoutParam = !originalStart && new URLSearchParams(location.search).get('loadout') === '1';
/** The original's splash: Launch's InitSplash("..\\Help\\Logo.bmp") shows the bitmap at its own size centred on the screen, in a dialog of
 * its own thread, until ExitSplash after the engine's Init has browsed to the first map (UnEngineWin.h; DeusEx.exe 0x1090909e). Here: its size
 * in device pixels, centred over black, until that map is loaded. False without the bitmap in the chosen files. */
async function showSplash(files) {
  const entry = files.find(file => /(^|\/)help\/logo\.bmp$/i.test(file.path));
  if (!entry) return false;
  const bitmap = await createImageBitmap(new Blob([await entry.read()], { type: 'image/bmp' }));
  const canvas = $('splash-image');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  canvas.style.width = `${canvas.width / devicePixelRatio}px`; canvas.style.height = `${canvas.height / devicePixelRatio}px`;
  $('splash').hidden = false;
  return true;
}
// The canvas is multisampled; ?antialias=0 turns that off: the original's Direct3D 7 device has no multisampling, so its frames have none
// (docs/visual-acceptance.md "Security cameras"). The pixel validators (validate-sim-split, validate-decals-play, validate-mesh-path-frames) add preserveDrawingBuffer by patching the first occurrence of the call's closing antialias text, so that text must not appear above it.
const rendererOptions = options => new URLSearchParams(location.search).get('antialias') === '0' ? { ...options, antialias: false } : options;
// No WebGL 2 (a browser without it, hardware acceleration turned off) or a context the browser refuses: three.js throws, and the page has
// nothing to draw with. The gate says what is missing, with the browser's own reason (`webglcontextcreationerror`), instead of a dead page.
function createRenderer() {
  const canvas = $('scene'); let reason = '';
  const listen = event => { reason = event.statusMessage?.trim() || reason; };
  canvas.addEventListener('webglcontextcreationerror', listen);
  try { return new THREE.WebGLRenderer(rendererOptions({ canvas, antialias: true })); }
  catch (error) {
    $('gate-title').textContent = 'This browser cannot draw the game';
    $('gate-message').textContent = `The game needs WebGL 2, which the browser did not give the page (${reason || error.message}). `
      + 'Turn on hardware acceleration in its settings, or use another browser.';
    $('gate-choose').hidden = true; $('gate-saves').hidden = true;
    throw error;
  } finally { canvas.removeEventListener('webglcontextcreationerror', listen); }
}
const renderer = createRenderer();
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// World and actor shaders apply the original display-encoded modulation
// themselves and draw raw colours; the display ramp maps the finished frame
// (display-ramp.mjs).  Keep canvas and render-target programs in Three's
// working space so mirror child draws do not select a second shader variant
// for every material; the custom output bytes are unchanged.
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; renderer.autoClear = false;
renderer.info.autoReset=false;
// RootWindow.GenerateSnapshot (docs/root-snapshot.md): the last drawn frame, kept while the player's UIBackground is Snapshot.
const frameKeeper = createFrameKeeper(renderer);
let keepingFrames = false, snapshotServed = 0;
const snapshotKeys = [];
const scene = new THREE.Scene();
// The scene and the world root keep identity matrices: without auto-update
// on them, renderer.render no longer forces every descendant's matrixWorld
// to be recomputed (twice per frame, sky and main pass). Objects that move
// update or flag their own (validate-scene-matrices.mjs).
scene.matrixAutoUpdate = false;
const camera = createPlayCamera(), skyCamera = new THREE.PerspectiveCamera(75, 1, PLAY_NEAR, PLAY_FAR);
// The main frame draws decals; child frames (mirrors, sky) do not (decal-scene.mjs).
camera.layers.enable(DECAL_LAYER);
const raycaster = new THREE.Raycaster();
let assets, world, map, currentMap, loading = false, drag = false, yaw = 0, pitch = 0;
let subtitlePreference = false;
// The loaded map's simulation side (sim-host.mjs): `game` and its frame
// session `sim`.
let game, sim = null, simHost = null, mode = 'play', paused = false, runtimeError = null;
// The 3D view's projection from the simulation's pass frame (Proj.Z, FX15,
// FY15: play-camera.mjs setFrameProjection) instead of the FOV and the
// constant half-pixel centre; deusExViewer.frameProjection(false) is the
// latter, for the pixel census (scripts/census-frame-projection.mjs).
let frameProjection = true;
// Validation only (deusExViewer.holdTextureClock, scripts/census-draw-order.mjs): the clock the surface textures last animated at,
// and, while held, the one they keep (animated chains and procedural textures stand still in a held level's frames).
let textureClock, heldTextureClock = null;
// The vertex stage of the same frame: world and mesh materials project their
// vertices with Render.dll's and D3DDrv's chain (frame-projection.mjs,
// docs/frame-projection.md) in every pass that has a frame. ?vertexProjection=off
// keeps the camera's matrices; deusExViewer.vertexProjection(on) switches it.
vertexProjection.enabled = new URLSearchParams(location.search).get('vertexProjection') !== 'off';
// Sprites as the original's tiles (sprite-scene.mjs, docs/frame-projection.md "Sprites"); ?spriteTiles=off keeps billboards.
vertexProjection.spriteTiles(new URLSearchParams(location.search).get('spriteTiles') !== 'off');
// The main frame's rectangle in drawing-buffer pixels (XB, YB, X, Y), set with its pass.
let mainRect = null;
/** The next draw projects with `projection`'s frame (a mirror or sky child's,
 * or the main frame's), or with the camera when there is none. A render
 * target's pass maps the frame onto the target's viewport, the main pass onto
 * the render rectangle. */
function useFrameProjection(projection, mirror = 1) {
  if (!projection || !mainRect) { vertexProjection.off(); return; }
  const target = renderer.getRenderTarget(), rect = { x: mainRect.x, y: mainRect.y, width: projection.width, height: projection.height };
  const view = target ? { x: target.viewport.x, y: target.height - target.viewport.y - target.viewport.height,
    width: target.viewport.width, height: target.viewport.height } : mainRect;
  vertexProjection.use(projection, rect, view, mirror);
}
let hudRenderer=null;
const flashPass=createFlashPass();
// SaveCurrentLevel's PaintProgress frame: the last frame's world and HUD drawn again (drawProgressFrame, docs/loading-frame.md "Saving").
const progressFrame=createProgressFrame();
const shaderWarmup=shaderWarmupOn()?createShaderWarmup(renderer):null;
/** A level's shader warm-up: at its load, and again after a context restore (docs/context-loss.md). */
const levelWarmup=(level,gpu)=>shaderWarmup?.start({world:level,gpu,displayGamma:level.displayGamma,
  mirrors:level.mirrors.stats.planes>0,detail:detailTexturesOn(),roots:[displayRamp?.scene,flashPass.scene,progressFrame.scene].filter(Boolean)})??null;
let npcPreview=null;
let spriteScene=null,coronaPass=null,decalScene=null,detailScene=null;
// Actor mesh animation and lighting run on the GPU (docs/gpu-mesh.md), on by
// default since validate-gpu-mesh passed on Training and Island; ?gpuMesh=0
// selects the CPU kernels, which stay the reference and the fallback. A
// software WebGL implementation (headless Chromium's SwiftShader) runs the
// passes on the CPU, far slower than the kernels, so it keeps the CPU path
// unless ?gpuMesh=1 forces the GPU path.
const gpuMeshParam=new URLSearchParams(location.search).get('gpuMesh');
let rendererNameRead=null;
/** The WebGL renderer's name (WEBGL_debug_renderer_info's, else RENDERER), read once. */
function rendererName(){
  if(rendererNameRead===null)try{
    const gl=renderer.getContext(),info=gl.getExtension('WEBGL_debug_renderer_info');
    rendererNameRead=String(gl.getParameter(info?info.UNMASKED_RENDERER_WEBGL:gl.RENDERER));
  }catch{return '';}
  return rendererNameRead;
}
const softwareRenderer=()=>/swiftshader|llvmpipe|softpipe|software|basic render/i.test(rendererName());
let gpuMesh=null;
// The view model's page half (weapon-overlay-draw.mjs), its own GPU mesh
// instance and the last frame's summary from the simulation side.
let weaponDraw=null,weaponGpu=null,weaponSummary=null;
// The page modes' mesh lighting view (sim-host.mjs; validation access).
let meshLighting=null;
// ?sim=worker: the worker's page end (sim-client.mjs), created with the game
// files; the last snapshot's input answers and game status; the lip-sync
// channels' mixer position readers, sampled at each frame's post.
let simClient=null,simAnswers={keys:{},pointerGrab:false},simStatus=null,simPosts=0;
// The worker's last frame post (the page clock, ms).
let simLastPost=null;
// The level's first tick was asked of the worker ahead of the first frame (loadMap, sim-session.mjs preTick): the next post, the first, carries
// `preTicked` and no dt of its own. FIRST_FRAME_DT is sim-session.mjs's: the dt that first post would have measured.
let preTickPending=false;
const FIRST_FRAME_DT=1000/60/1000;
// The pointer lock's Escape (releasePointer, handEscape): the page released the lock itself; the time of the last real Escape press
// and of the Escape handed to the game; that press's release is still to come from the browser.
let resumeClock=false,pageReleasedLock=false,escapeSeen=-Infinity,escapeHanded=-Infinity,handingEscape=false,handedEscapeRelease=false,lockLostTimer=null,lockLostAt=-Infinity,fullscreenChanged=-Infinity;
// When the page last asked the browser to keep its storage (StorageManager.persist(), after the first kept save): Firefox's prompt for it
// takes the pointer lock (measured 2026-10-28), and a lock lost then is the prompt's, not the user's Escape (handEscape).
let persistAsked=-Infinity;
// Measurement only: ?preTick=off leaves every level's first tick to its first frame, the A arm (docs/first-frames.md).
const preTickParam=new URLSearchParams(location.search).get('preTick')!=='off';
// The page clock (ms) of the last frame before a travel's load. The next level's first frame measures its dt from it, so its first
// tick receives the load, as the original's does (docs/travel.md "The first tick after the load"; game.mjs `loadingFrameSeconds`).
let travelFrameTime=null;
// A travel's loading frame is on the canvas (travelTo): nothing is drawn until the next level's first frame.
let travelHeld=false;
// The last loading frame's console tiles and flash (deusExViewer.loadingFrame).
let lastLoadingFrame=null;
// SaveCurrentLevel's PaintProgress frames drawn (drawProgressFrame), the last few, with when each was drawn and replaced (deusExViewer.savingFrames).
const savingFrames=[];
// ?sim=inline: a PaintProgress frame the save drew on this thread, and the snapshot simulated with it, each drawn in a display frame of its own (animate).
const inlineFrames=[];
// The world whose simulation frame was drawn last: a PaintProgress frame draws that frame again, only in the level it belongs to.
let drawnWorld=null;
let infoLinkAudioContext=null;
// Galaxy's music (docs/galaxy-music.md "Phase 5: Output"): an AudioWorklet
// owns the library (galaxy-music-output.mjs); the simulation talks to it on
// its own MessageChannel, the worker's end or, with ?sim=inline, the page's
// `pageMusicLibrary`. ?music=0 leaves the worklet out (the simulation then
// uses the headless mirror library), for A/B measurements.
const musicEnabled=new URLSearchParams(location.search).get('music')!=='0';
const musicOutput=musicEnabled?createMusicOutput():null;
let pageMusicLibrary=null,musicError=null;
// The host decode of speech for Galaxy's speech voices and lip sync
// (decodeSpeech; docs/galaxy-audio.md "Speech through Galaxy's voices").
const speechDecode={requests:0,decoded:0,failures:0,lastSound:null,lastError:null};
// Galaxy voices (docs/galaxy-audio.md): each runtime start/control/stop
// drives one buffer source through a stereo panner and a gain. The mapping of
// Galaxy's volume (0..32767), pan (0..32767, 16383 centre) and digital master
// volume (0..127) onto Web Audio is the host's; Galaxy's own mixer is not
// translated.
const galaxyVoices=new Map(),galaxyBuffers=new Map();
const galaxyAudio={starts:0,stops:0,controls:0,failures:0,lastError:null};
function applyGalaxyVoice(entry,event){
  entry.gain.gain.value=Math.max(0,event.volume)/32767*(event.digital??127)/127;
  entry.panner.pan.value=event.pan>=0xc000?0:Math.max(-1,Math.min(1,event.pan/16383.5-1));
  if(entry.source)entry.source.playbackRate.value=event.frequency/entry.rate;
}
async function galaxyVoice(event){
  try{
    if(event.op==='stop'){
      const entry=galaxyVoices.get(event.voice);galaxyVoices.delete(event.voice);
      if(entry){entry.stopped=true;try{entry.source?.stop();}catch{}entry.gain.disconnect();}
      galaxyAudio.stops++;return;
    }
    if(event.op==='control'){const entry=galaxyVoices.get(event.voice);if(entry)applyGalaxyVoice(entry,event);galaxyAudio.controls++;return;}
    if(event.op==='decode'){void decodeSpeech(event);return;}
    const context=await activateInfoLinkAudio();
    const entry={rate:event.rate,source:null,stopped:false,gain:context.createGain(),panner:context.createStereoPanner()};
    entry.panner.connect(entry.gain);entry.gain.connect(context.destination);
    galaxyVoices.set(event.voice,entry);applyGalaxyVoice(entry,event);
    // A speech MP3 is decoded for each voice and not kept.
    let buffer=event.speech?null:galaxyBuffers.get(event.sound);
    if(!buffer){buffer=context.decodeAudioData(event.bytes.slice().buffer);if(!event.speech)galaxyBuffers.set(event.sound,buffer);}
    const decoded=await buffer;
    if(entry.stopped)return;
    const source=context.createBufferSource();source.buffer=decoded;
    if(event.loop&&event.loop.end>event.loop.start){source.loop=true;source.loopStart=event.loop.start/event.rate;source.loopEnd=event.loop.end/event.rate;}
    source.connect(entry.panner);entry.source=source;applyGalaxyVoice(entry,event);source.start();
    galaxyAudio.starts++;
  }catch(error){galaxyAudio.failures++;galaxyAudio.lastError=String(error?.message??error);}
}
function stopGalaxyVoices(){
  for(const entry of galaxyVoices.values()){entry.stopped=true;try{entry.source?.stop();}catch{}entry.gain.disconnect();}
  galaxyVoices.clear();
}
/** A speech sound's 16-bit PCM for the simulation (script-audio-live.mjs
 * asks with an `op: 'decode'` voice event): the browser's MP3 decode at the
 * MPEG header's rate (an OfflineAudioContext at that rate, so not resampled;
 * Galaxy's own MPEG decoder is not translated), through pcm16, both channels
 * interleaved for a stereo stream. The same PCM feeds Galaxy's ring voices
 * and so its lip-sync analysis. A failed decode
 * answers an empty PCM, so the voice plays nothing and finishes. */
async function decodeSpeech(event){
  speechDecode.requests++;speechDecode.lastSound=event.sound;
  let pcm;
  try{
    const channels=event.channels===2?2:1,offline=new OfflineAudioContext(channels,1,event.rate),bytes=event.bytes;
    const decoded=await offline.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    // A stereo stream (the record 0x4044) as interleaved frames, the second channel repeated if the decode has one.
    pcm=channels===2?pcm16(decoded.getChannelData(0),decoded.getChannelData(Math.min(1,decoded.numberOfChannels-1))):pcm16(decoded.getChannelData(0));
    speechDecode.decoded++;
  }catch(error){pcm=new Uint8Array(0);speechDecode.failures++;speechDecode.lastError=String(error?.message??error);}
  if(simClient)simClient.queue({op:'speech-pcm',sound:event.sound,pcm});
  else{try{game?.attachSpeech(event.sound,pcm);}catch(error){pauseForRuntimeError(error);}}
}
let revision = 0, lastTime = performance.now(), fpsTime = lastTime, frameCount = 0;
let cameraMoved = false, lastInspect = 0;
const keys = new Set(), velocity = new THREE.Vector3();
const busy = (title, message) => {
  $('gate').hidden = false; $('gate-title').textContent = title; $('gate-message').textContent = message;
  $('gate-choose').hidden = loading; $('progress').hidden = !loading;
};
function toast(message, ms = 4000) { $('toast').textContent = message; setTimeout(() => { if ($('toast').textContent === message) $('toast').textContent = ''; }, ms); }
// The player's kept settings (docs/config-persistence.md): the store the asset stores read the config files through, and the storage
// behind it. Null while persistence is off (the ?debug=1 page). A storage failure is said once per kind; the page runs on the installed
// files, and what the game writes lasts as long as the page.
let configPersistence = null, configStore = null;
const storageToasted = new Set();
function reportStorage(state) {
  if (!state.message || storageToasted.has(state.kind)) return;
  storageToasted.add(state.kind); toast(state.message, 12000);
}
// The player's saves (docs/save-storage.md "The folder flow"): where they are kept (a folder on disk, the browser, memory), the listing the simulation's
// Save directory is given, and the Saves window (the gate, Tools and Alt+S open it) that changes them. Opened at page start so the window works at the
// gate, before the game files; the simulation gets the listing at init and again at every change. The dev server's own Save folder is read under it.
let savePersistence = null, saveRefreshed = 0;
const savesUi = createSavesUi({ $, toast, persistence: () => savePersistence });
savesUi.bind();
// The default start's page controls (the user's choice, 2026-10-22): no page shortcut during play, since every key and chord is the
// game's (Alt is Strafe); while an original window holds the mouse (a menu, the inventory), Saves and CRT appear in the bars beside the
// 4:3 picture, else at the picture's top-right corner. They take clicks when the system pointer is free (a menu opened by Escape in a
// window; Alt+Enter in fullscreen); under the pointer lock the menu's own cursor stays inside the picture.
$('page-saves').onclick = () => savesUi.open();
$('page-crt').onclick = () => { setCrt(!crtEnabled, true); $('page-crt').setAttribute('aria-pressed', String(crtEnabled)); };
/** Whether an original window holds the mouse: the worker's answer with its last snapshot, or the page's own game (?sim=inline, Firefox's default). */
function windowGrabbed() {
  if (simClient) return Boolean(simAnswers.windowGrab);
  try { return Boolean(game?.windowMouseGrabbed()); } catch { return false; }
}
function placePageButtons() {
  const box = $('page-buttons');
  const show = originalStart && mode === 'play' && Boolean(game) && !loading && !runtimeError && windowGrabbed();
  if (box.hidden !== !show) box.hidden = !show;
  if (!show) return;
  $('page-crt').setAttribute('aria-pressed', String(crtEnabled));
  const canvas = $('scene'), left = parseFloat(canvas.style.marginLeft) || 0, top = parseFloat(canvas.style.marginTop) || 0;
  const width = canvas.clientWidth, height = canvas.clientHeight, w = box.offsetWidth || 80;
  if (left >= w + 24) Object.assign(box.style, {left: `${left + width + 12}px`, top: `${top + 12}px`, right: '', bottom: ''});
  else Object.assign(box.style, {left: '', top: `${top + 12}px`, right: '12px', bottom: ''});
}
function pushSaves() {
  const listing = savePersistence?.simSaves();
  if (!listing) return;
  if (simClient) simClient.setSaves(listing); else hostSaveDirectory().replace(listing);
}
/** A save slot the simulation finished (`commit`: the slot whole, SaveInfo.dxs last) or deleted (`remove`): the page's storage keeps it. A refusal (quota, a folder
 * that went away) leaves the slot as it was, is said here and in the Saves window, and the listing the simulation reads is sent again by the persistence's change. */
async function keepSimSave(message) {
  const persistence = await savesReady;
  if (!persistence) return;
  try {
    if (message.op === 'commit') await persistence.commitSlot(message.dir, message.files);
    else await persistence.removeSlot(message.dir);
  } catch (error) { toast(`The game could not be saved: ${error?.message ?? error}`, 12000); throw error; }
}
const savesReady = openSavePersistence({ mode: saveMode(location.search, originalStart), served: import.meta.env.DEV ? devServedSaves() : null,
  requestPersist: () => { persistAsked = performance.now(); return globalThis.navigator?.storage?.persist?.() ?? null; },
  onChange: () => { pushSaves(); savesUi.update(); } })
  .then(persistence => {
    savePersistence = persistence; savesUi.update();
    const message = persistence.status().message ?? persistence.status().error?.message;
    if (message) toast(message, 12000);
    return persistence;
  }, error => { toast(`Saves: ${error?.message ?? error}`, 12000); return null; });
/** The player came back to the page (the desktop game may have written a save): read a folder or the dev server's Save folder again. */
function refreshSaves() {
  const now = performance.now();
  if (!savePersistence || document.hidden || now - saveRefreshed < 3000) return;
  const status = savePersistence.status();
  if (status.source !== 'folder' && !status.served) return;
  saveRefreshed = now;
  savePersistence.refresh().catch(() => {});
}
document.addEventListener('visibilitychange', refreshSaves);
window.addEventListener('focus', refreshSaves);
async function activateInfoLinkAudio(){
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass)throw new Error('This browser cannot decode the original DataLink audio');
  // One context for the Web Audio voices, the speech and Galaxy's music
  // worklet, at Galaxy's output rate (the installed OutputRate, 44100 Hz).
  if(!infoLinkAudioContext){
    infoLinkAudioContext=new AudioContextClass({sampleRate:44100});
    // A context the browser or the system suspends (another program takes the device, Safari's interruption) is resumed at
    // once: the page has had its gesture, so it needs no other; a key or a click resumes it too (below). Not after the game
    // exited (endGame suspends it for good). docs/stage-7-exit-criteria.md row 7.5.1.
    const context=infoLinkAudioContext;
    context.addEventListener('statechange',()=>{if(!exited&&context.state!=='running'&&context.state!=='closed')context.resume().catch(()=>{});});
    musicOutput?.start(infoLinkAudioContext).catch(error=>{musicError=String(error?.message??error);});
  }
  if(infoLinkAudioContext.state!=='running'&&infoLinkAudioContext.state!=='closed')await infoLinkAudioContext.resume();
  return infoLinkAudioContext;
}
// Music plays on every map: any gesture creates or resumes the context
// (browsers start audio only after one).
if(musicOutput)for(const type of ['pointerdown','keydown'])
  document.addEventListener(type,()=>{if(!exited&&infoLinkAudioContext?.state!=='running')activateInfoLinkAudio().catch(()=>{});},true);
/** Galaxy's EffectsChannels from DeusEx.ini, clamped to 0..32 as the
 * subsystem's Init (0x10605580) does; the worklet opens the library with it. */
async function readGalaxyOutputConfig(files){
  const file=files.find(entry=>String(entry.path).replaceAll('\\','/').split('/').pop().toLowerCase()==='deusex.ini');
  if(!file)throw new Error('DeusEx.ini is not among the game files');
  const text=decodeIniBytes(await file.read());
  const value=parseIniValue(text,'Galaxy.GalaxyAudioSubsystem','EffectsChannels');
  if(value===undefined)throw new Error('Galaxy EffectsChannels is not in DeusEx.ini');
  // Latency as script-audio-live.mjs reads it (0x10605ad0's clamp to 10..250).
  const latency=parseIniValue(text,'Galaxy.GalaxyAudioSubsystem','Latency');
  return {effectsChannels:Math.max(0,Math.min(32,msvcrtWtoi(value))),
    latency:latency===undefined?40:Math.max(10,Math.min(250,msvcrtWtoi(latency)))};
}
/** A new simulation side's music library: the worker gets its end of the
 * channel; ?sim=inline keeps one library on the page for its lifetime. */
async function connectMusic(files){
  if(!musicOutput)return;
  try{
    musicOutput.configure(await readGalaxyOutputConfig(files));
    if(simClient)simClient.connectMusic(musicOutput.simulationPort());
    else if(!pageMusicLibrary)pageMusicLibrary=connectMusicLibraryPort(musicOutput.simulationPort(),{effects:true});
  }catch(error){musicError=String(error?.message??error);}
}
function musicStatus(output=musicOutput?.status()??null){
  return {enabled:musicEnabled,error:musicError,context:infoLinkAudioContext?.state??'uninitialized',output,
    library:simClient?simStatus?.music??null:pageMusicLibrary?.status()??null};
}
function stopInfoLinkPresentation(){
  stopGalaxyVoices();
  $('infolink-shell').hidden=true;
}
// Accessibility mirrors native TextWindow contents (the simulation frame's
// infoLink, sim-session.mjs). The pixels are emitted only by the recovered
// native HUD/GC tree; no independent playback timeline.
function updateInfoLinkAccessibility(info){
  if(!info)return;
  $('infolink-shell').hidden=!info.visible;
  if(!info.visible)return;
  $('infolink-title').textContent=info.title;
  $('infolink-queued').textContent=info.queued;
  $('infolink-text').textContent=info.text;
}
// Play's screen shape: the window's own, or a fixed one centred in it (like
// choosing a 1024x768 or 1680x1050 resolution in the original). The root
// window and the 3D view take the canvas size, so a forced-play letterbox
// follows the chosen shape.
const SCREEN_ASPECTS = { window: null, '4:3': 4 / 3, '16:10': 16 / 10 };
// The canvas aspect resize() gave the camera, and how many resizes ran: the
// simulation side's camera follows them (play-camera.mjs).
let canvasAspect = 1, resizeCount = 0;
let screenAspect = 'window';
// A SetRes request from the original menus (UWindowsViewport::Exec SetRes -> RenDev->SetRes): the
// drawing buffer is exactly width x height, scaled to fit the page (docs/script-native-config.md).
let fixedResolution = null;
function layoutCrtComparison() {
  const canvas = $('scene'), overlay = $('crt-comparison');
  overlay.style.width = canvas.style.width || '100%'; overlay.style.height = canvas.style.height || '100%';
  overlay.style.left = canvas.style.marginLeft || '0'; overlay.style.top = canvas.style.marginTop || '0';
}
function resize() {
  const box = $('viewport').getBoundingClientRect(), canvas = $('scene');
  let width = box.width, height = box.height;
  if (mode === 'play' && fixedResolution) {
    const { width: bufferWidth, height: bufferHeight } = fixedResolution;
    const fit = Math.min(box.width / bufferWidth, box.height / bufferHeight);
    width = Math.floor(bufferWidth * fit); height = Math.floor(bufferHeight * fit);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    canvas.style.marginLeft = `${Math.floor((box.width - width) / 2)}px`; canvas.style.marginTop = `${Math.floor((box.height - height) / 2)}px`;
    renderer.setPixelRatio(1);
    renderer.setSize(bufferWidth, bufferHeight, false); camera.aspect = bufferWidth / Math.max(1, bufferHeight);
    canvasAspect = camera.aspect; resizeCount++;
    camera.fov = verticalFov(75, camera.aspect);
    camera.updateProjectionMatrix();
    setPixelCentre(camera, renderer.domElement.width, renderer.domElement.height);
    layoutCrtComparison();
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const aspect = mode === 'play' ? SCREEN_ASPECTS[screenAspect] : null;
  if (aspect) { if (width / Math.max(1, height) > aspect) width = height * aspect; else height = width / aspect; }
  if (mode === 'play') {
    // A resolution the root window divides: ResizeRoot (0x1003adf0) takes
    // m = min(floor(w/640), floor(h/480)) and the GC draws whole root units
    // times m, so a remainder column or row would show the 3D view under
    // the letterbox. The canvas buffer is snapped down to multiples of m.
    const pr = renderer.getPixelRatio();
    let w = Math.floor(width * pr), h = Math.floor(height * pr);
    const m = Math.max(1, Math.min(Math.floor(w / 640), Math.floor(h / 480)));
    // (+0.25 so three.js's floor(css * pr) gives back w and h exactly.)
    w -= w % m; h -= h % m; width = (w + 0.25) / pr; height = (h + 0.25) / pr;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    canvas.style.marginLeft = `${Math.floor((box.width - width) / 2)}px`; canvas.style.marginTop = `${Math.floor((box.height - height) / 2)}px`;
  } else for (const name of ['width', 'height', 'marginLeft', 'marginTop']) canvas.style[name] = '';
  renderer.setSize(width, height, false); camera.aspect = width / Math.max(1, height);
  canvasAspect = camera.aspect; resizeCount++;
  camera.fov = verticalFov(75, camera.aspect);
  camera.updateProjectionMatrix();
  camera.userData.projection = null;   // the next Play frame brings its pass frame's
  setPixelCentre(camera, renderer.domElement.width, renderer.domElement.height);
  layoutCrtComparison();
}
new ResizeObserver(resize).observe($('viewport'));
// A new device pixel ratio with the same CSS box (a zoom, the window moved to another screen) is no resize to the observer: a resolution
// query for the current ratio says when it changes, and is renewed for the next one.
(function watchPixelRatio() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { resize(); watchPixelRatio(); }, { once: true });
})();
function renderViewportFor(rect) {
  const pr = renderer.getPixelRatio(), height = renderer.domElement.height;
  return [rect.x / pr, (height - rect.y - rect.height) / pr, rect.width / pr, rect.height / pr];
}
// The sky frame: Play's comes with the simulation frame (sim-session.mjs,
// Render.dll 0x10b18410: the SkyZone's Location and Rotation, the sky view
// being the SkyZone rotation applied after the view's); Inspect uses the
// map's statically chosen sky.
// A ViewportWindow's world frame (XViewportWindow::Draw: ClearZ, then
// RenderFrame -> URender::DrawWorld on its master frame; docs/
// script-window-viewport.md "Camera pass"), drawn between the HUD's GC
// draws before and after it. The simulation side planned the frame
// (sim-session.mjs planViewportPass): OccludeBsp's polygons and movers,
// the sky frame and the actor layer's decisions. Its decals, sprites'
// Frame->Sprite, mirrors, coronas, fog maps and mesh lighting are the main
// frame's or are not drawn (explicitly unsupported).
const viewportCamera = createPlayCamera();
/** Points viewportCamera along a 'viewport' command's frame. */
function aimViewportCamera(command) {
  const view = { location: command.location, rotation: command.rotation, fov: command.fov };
  applyPlayFrame(viewportCamera, view, { render: true, width: command.width, height: command.height },
    frameProjection ? command.pass?.projection ?? null : null);
  setPixelCentre(viewportCamera, command.width, command.height);
  viewportCamera.updateMatrixWorld();
  return viewportCamera;
}
/** A 'viewport' command's camera frustum (light map culling). */
function viewportFrustum(command) {
  const view = aimViewportCamera(command);
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
}
// The camera passes the last frame drew (terminalProbe): rectangle and draw calls.
let viewportPassesDrawn = [];
// The snapshot's packed mesh records (mesh-frame-pack.mjs), which the HUD frame's late actor records also use.
let frameWords = null;
// Validation: whether the camera frames draw the decal block (deusExViewer.viewportDecals).
let viewportDecalsOn = true;
/** The pieces of one root frame's child-frame passes, for the main frame and
 * for a ViewportWindow's frame alike (the original runs the same OccludeFrame
 * and DrawFrame for both): `framePass(record)` puts one child frame's world,
 * sprites and fog in place (null: the root frame's again; `spritesOf(record)`
 * picks the sprite records that frame draws), `drawSkyFrame` draws a sky frame
 * OccludeBsp made inside a mirror frame (mirror-passes.mjs skyFrameCamera,
 * 0x10b184b1: the camera of its own Coords, its own world and sprites, and
 * its own Frame->Sprite actors, the simulation side's `passSky`, applied now
 * and the mirror frame's put back after) and `updateActors` applies the actor
 * layer's decisions for each mirror pass. `stampFrame` is the simulation's
 * decisions for the frame (sim-session.mjs stamps, planViewportPass). */
function framePassHelpers(frames, stampFrame, spritesOf) {
  let passIndex = 0;
  const framePass = frames ? record => {
    useFrameProjection(record?.projection, record?.mirror);
    world.fog?.framePass(record, renderer);
    detailScene?.framePass(record);
    if (!record) { world.visibility.all(); spriteScene?.framePass(null); return; }
    world.visibility.select(record.nodes, record.movers ?? null);
    spritesOf(record);
  } : null;
  const drawSkyFrame = (record, frameCamera, node) => {
    const markersVisible = world.markers.visible; world.markers.visible = false;
    const npcVisible = npcPreview?.root.visible, target = renderer.getRenderTarget();
    const actors = npcPreview ? stampFrame?.passSky?.[node.passAt]?.find(entry => entry.frame === record.index) ?? null : null;
    // The actors' lighting run resets the GL state, the render target with it.
    if (actors) { npcPreview.draw.pass(actors.decisions, fromView(frameCamera.position.toArray()), actors.light); renderer.setRenderTarget(target); }
    else if (npcPreview) npcPreview.root.visible = false;
    framePass(record);
    try { renderer.render(scene, frameCamera); }
    finally {
      framePass(null); world.markers.visible = markersVisible;
      if (npcPreview) npcPreview.root.visible = npcVisible;
      if (actors) { node.reapply(); renderer.setRenderTarget(target); }
    }
  };
  // Without the simulation side's actor decisions (it stopped on an error)
  // the actors' last state draws.
  const updateActors = npcPreview && !runtimeError && stampFrame?.plan?.actors ? (position, passCamera, node) => {
    const at = passIndex, decisions = node ? stampFrame.passDecisions[passIndex++] : stampFrame.mainDecisions;
    // Both sides plan the passes from the same frame (mirrors.mjs render `plan`); the pass ids prove it.
    if (node && (!decisions || stampFrame.passIds[at] !== node.id))
      throw new Error(`The page drew mirror pass ${node.id} (${at}) where the simulation side planned ${stampFrame.passIds[at] ?? 'none'}`);
    // A child frame's pass lights the actors it draws with that frame's Coords and Mirror.
    const light = node ? stampFrame?.passFrames?.[at] ?? null : null;
    npcPreview.draw.pass(decisions ?? new Map(), position, light);
    // A sky frame inside this mirror frame finds its decisions at `passAt`
    // and puts these back with `reapply`.
    if (node) { node.passAt = at; node.reapply = () => npcPreview.draw.pass(decisions, position, light); }
  } : null;
  return { framePass, drawSkyFrame, updateActors };
}
/** A root frame's sky frame: the camera at the SkyZone (`sky`), drawn under
 * the frame (`parent` is the frame's camera) with its own world, sprites and
 * actors when OccludeBsp made it a child frame (`rootSky`, stamped on the
 * simulation side); without child frames, no actors. */
function drawRootSky(parent, sky, rootSky, stampFrame, framePass) {
  skyCamera.copy(parent); skyCamera.layers.disable(DECAL_LAYER); skyCamera.position.fromArray(toView(sky.location));
  skyCamera.quaternion.premultiply(new THREE.Quaternion().setFromEuler(rotatorEuler(sky.rotation)));
  const markersVisible = world.markers.visible; world.markers.visible = false;
  const skyActors = rootSky && npcPreview && stampFrame?.skyDecisions;
  const npcVisible = npcPreview?.root.visible; if (npcPreview && !skyActors) npcPreview.root.visible = false;
  if (skyActors) npcPreview.draw.pass(stampFrame.skyDecisions, fromView(skyCamera.position.toArray()), stampFrame.skyFrame ?? null);
  if (rootSky) framePass(rootSky); else vertexProjection.off();
  try { renderer.render(scene, skyCamera); } finally { if (rootSky) framePass(null); }
  world.markers.visible = markersVisible;
  if (npcPreview) npcPreview.root.visible = npcVisible;
  renderer.clearDepth();
  if (skyActors) npcPreview.draw.pass(stampFrame.mainDecisions ?? new Map(), fromView(parent.position.toArray()));
}
function viewportWorldPass(command) {
  const plan = command.pass;
  if (!plan || !world || !(command.width > 0 && command.height > 0)) return;
  // A camera window's frames keep the camera's projection (docs/frame-projection.md).
  vertexProjection.off();
  const callsBefore = renderer.info.render.calls;
  aimViewportCamera(command);
  // The frame's decal block (the camera frame's own OccludeBsp polygons).
  viewportCamera.layers[plan.decals && viewportDecalsOn ? 'enable' : 'disable'](DECAL_LAYER);
  // The frame's actors, updated on the simulation side after the main frame's
  // (sim-session.mjs planViewportPass): their poses, LOD and lighting for each
  // of this camera's frames, in this frame, before the pass draws them; the
  // others are hidden in the camera's own frame.
  if (npcPreview && plan.late) npcPreview.draw.apply(plan.late, fromView(viewportCamera.position.toArray()), frameWords);
  if (npcPreview && plan.decisions) npcPreview.draw.pass(plan.decisions, fromView(viewportCamera.position.toArray()));
  const frames = plan.frames ?? null, stampFrame = plan.stamps ?? null, rect = { x: command.x, y: command.y, width: command.width, height: command.height };
  // The volumetric fog maps of this frame's surfaces: its own Coords for the
  // camera frame and for each child frame (fog-pass.mjs update).
  let fogMaps = null;
  if ((world.fog?.stats.surfaces || world.fog?.stats.moverPolygons) && !runtimeError && plan.visibility) {
    try {
      world.fog.update({ location: command.location, rotation: command.rotation }, viewportFrustum(command),
        new Set(cameraFog === 'off' ? [] : Array.from(plan.visibility.nodes, node => world.nodeSurface[node])),
        { moverItems: cameraFog ? null : plan.visibility.moverItems ?? null, fogZone: world.fogZone, frames: childFog && cameraFog !== 'off' ? frames : null, nodeSurface: world.nodeSurface, renderer });
      const { drawn, texels, movers, frameMaps, moverItems } = world.fog.stats; fogMaps = { drawn, texels, movers, frameMaps, moverItems };
    } catch (error) { pauseForRuntimeError(error); }
  }
  // Each sprite record the frame draws: the camera frame's, and each child frame's.
  const { framePass, drawSkyFrame, updateActors } = framePassHelpers(frames, stampFrame,
    record => spriteScene?.numberedPass(plan.sprites?.frames?.[record.index] ?? []));
  // The mirror frames: each child frame into its target, over the camera's own
  // rectangle, which the camera frame's shader then samples. Without child
  // frames the mirror surfaces draw unreflected.
  world.mirrors.render(renderer, scene, viewportCamera, { markers: world.markers, sky: plan.sky, frames: frames ?? [], rect,
    framePass, skyIn: frames ? drawSkyFrame : null, updateActors, viewport: rect, plan: stampFrame?.plan ?? null });
  const box = renderViewportFor(command), markersVisible = world.markers.visible;
  renderer.setViewport(...box); renderer.setScissor(...box); renderer.setScissorTest(true);
  world.markers.visible = false;
  try {
    if (command.clearZ) renderer.clearDepth();
    if (plan.sky) drawRootSky(viewportCamera, plan.sky, frames?.find(f => f.parent === 0 && f.kind === 'sky') ?? null, stampFrame, framePass);
    if (plan.visibility) world.visibility.select(plan.visibility.nodes, plan.visibility.movers ?? null);
    decalScene?.update(plan.decals ?? null);
    spriteScene?.numberedPass(plan.sprites ? plan.sprites.root : null);
    renderer.render(scene, viewportCamera);
    // DrawFrame's corona pass closes the frame, in this frame's pixels.
    if (plan.coronas && coronaPass) {
      try { coronaPass.update(plan.coronas.frame, plan.coronas.width, plan.coronas.height); coronaPass.render(renderer); }
      catch (error) { pauseForRuntimeError(error); }
    }
    viewportPassesDrawn.push({ rect: [command.x, command.y, command.width, command.height], calls: renderer.info.render.calls - callsBefore,
      frames: frames?.length ?? 0, decals: plan.decals?.length ?? 0, icons: plan.coronas?.frame.icons.length ?? 0, fog: fogMaps });
  } finally {
    world.visibility.all(); world.markers.visible = markersVisible; spriteScene?.numberedPass(null);
    const pr = renderer.getPixelRatio(), full = [0, 0, renderer.domElement.width / pr, renderer.domElement.height / pr];
    renderer.setViewport(...full); renderer.setScissor(...full); renderer.setScissorTest(false);
  }
}
function skyFrame(frame) {
  if (mode === 'play' && game) return frame?.sky ?? null;
  return world.sky ? { location: world.sky, rotation: world.skyRotation ?? [0, 0, 0] } : null;
}
/** Points the camera along a PlayerCalcView result (sim-session.mjs,
 * play-camera.mjs). */
function applyPlayerView(view) {
  ({ pitch, yaw } = pointCamera(camera, view));
  return view;
}
/** Player start; with ?sim=worker, returns the promise of the worker's
 * reply, which points the camera. */
function resetCamera({ keepLevel = false, travelled = false } = {}) {
  if (!map) return;
  let reply = null;
  hideNpcFocus();
  if (mode === 'play' && game) {
    // `keepLevel`: the load just made this level (docs/class-graph-design.md, migration step 5: one LoadMap per arrival, as the original's
    // process runs one, a level restored by travel included, docs/travel.md "Play, step 3"): no Player start, which would load the map
    // again and run its begin-play pass a second time; only the view and the movers are read from it. The Reset button is Player start.
    // `travelled`: that load is a travel's arrival or a loaded game, whose player keeps its inventory (no ?loadout=1).
    if (keepLevel) {
      if (simClient) reply = simClient.call('restoreView').then(result => { if (result && world) { world.syncMovers(result.movers); applyPlayerView(result.view); } })
        .then(() => applyStartCheats({ loadout: !travelled }));
      else { world.syncMovers(sim.movers()); applyStartCheats({ loadout: !travelled }); }
    }
    // Player start; the worker resets after the frames posted before it.
    else if (simClient) reply = simClient.call('reset').then(result => { if (result && world) { world.syncMovers(result.movers); applyPlayerView(result.view); } })
      .then(() => applyStartCheats({ loadout: true }));
    else { sim.reset(); world.syncMovers(sim.movers()); applyStartCheats({ loadout: true }); }
    runtimeError=null;paused=false;keys.clear();$('toast').textContent='';stopInfoLinkPresentation();showStats();lockGameKeys(true);
  }
  const start = map.summary.playerStarts.find(p => p.location);
  const position = start?.location ?? map.model.points.at(0) ?? [0, 0, 0];
  camera.position.fromArray(toView([position[0], position[1], position[2] + 40]));
  pitch = (start?.rotation?.[0] ?? 0) * Math.PI / 32768;
  yaw = -(start?.rotation?.[1] ?? 0) * Math.PI / 32768;
  camera.rotation.set(pitch, yaw, 0); cameraMoved = false;
  if (mode === 'play' && game && !simClient) applyPlayerView(sim.view());
  return reply;
}
/** ?easter=1 (docs/easter-egg.md): an opt-in mod. Without the flag this is a no-op and its module is never loaded. */
const easterParam = new URLSearchParams(location.search).get('easter') === '1';
function applyEaster() {
  if (!easterParam || !game) return null;
  return import('./easter-page.mjs').then(({ startEaster }) => startEaster({ game, simClient, assets, mapName: currentMap }))
    .catch(error => toast(`?easter: ${error.message}`));
}
/** The start's credit card (credit-card.mjs, docs/boot.md "The credit card"): not original, on the original start's DX.dx flight only,
 * ?credit=0 hides it. Its module loads with the first DX.dx frame. */
const creditParam = originalStart && new URLSearchParams(location.search).get('credit') !== '0';
let creditCard = null, creditLoading = null;
function creditFrame(x) {
  if (creditCard) { creditCard.update(x); return; }
  if (x === null || creditLoading) return;
  creditLoading = import('./credit-card.mjs').then(({ createCreditCard }) => createCreditCard({ assets, scene: $('scene') }))
    .then(card => { creditCard = card; }, error => toast(`credit card: ${error.message}`));
}
/** debug-loadout.mjs on the simulation side; the toast says what was given, or only what was refused when `quiet`. */
async function giveLoadoutNow({ quiet = false } = {}) {
  if (!game) throw new Error('No game loaded');
  const result = simClient ? await simClient.call('loadout') : (await import('./debug-loadout.mjs')).giveLoadout(game);
  const refused = result.refused.map(({ cls, why }) => `${cls} (${why})`).join(', ');
  const summary = `Loadout: ${result.given.length} items, ${result.augmentations} augmentations, ${result.credits} credits`;
  if (refused) toast(`${summary} · not given: ${refused}`, 8000);
  else if (!quiet) toast(summary);
  return result;
}
/** ?loadout=1 (`loadout`: not at a travel's arrival), then ?cheat= after a Player start; failures are shown, not thrown. */
function applyStartCheats({ loadout = false } = {}) {
  const easter = applyEaster();
  const given = loadout && loadoutParam && game ? giveLoadoutNow({ quiet: true }).catch(error => toast(`?loadout: ${error.message}`)) : null;
  if (!startCheats.length || !game) return given ?? easter;
  const args = { exec: startCheats };
  return Promise.resolve(given).then(() => simClient ? simClient.call('viewProbe', args) : viewProbe(game, args))
    .catch(error => toast(`?cheat: ${error.message}`));
}
/** With ?sim=worker, returns the promise of PlayerCalcView's reply. */
function setMode(next) {
  let reply = null;
  if (mode === 'play' && next !== 'play') simInput.reset({releasePhysical:true});
  mode = next === 'play' && game ? 'play' : 'inspect'; $('mode').value = mode;
  resize(); // Inspect uses the whole canvas again; Play takes the screen shape.
  if(mode==='play')hideNpcFocus();
  keys.clear();
  if (mode === 'play') {
    if (simClient) reply = simClient.call('view').then(view => { if (view) applyPlayerView(view); });
    else applyPlayerView(sim.view());
  }
  $('play-hint').textContent = '';
  $('controls').textContent = mode === 'play' ? 'Drag to look · Double-click to lock mouse · WASD move · Space jump · X crouch · Shift walk · Right-click use · F center view · Click or Enter fire / use item in hand · 1–9 belt · 0 nanokey ring · Esc menu' : 'Drag to look · Double-click to lock mouse · WASD fly · Q E down / up · Shift faster · Esc menu';
  $('scene').setAttribute('aria-label', mode === 'play' ? 'Game view. W A S D to move, Space to jump, X to crouch, right mouse to use, F to center view.' : 'Map inspection camera. W A S D to fly, Q E down and up.');
  return reply;
}
function travelTo(request) {
  // (the level left has stopped ticking: sim-session.mjs `travelled`). The loading frame starts here: the inline frame that ticked
  // the travel, or the worker's latest post (a display frame or two after the travel's, and those posts reach a level that no longer ticks)
  travelFrameTime = simClient ? simLastPost : lastTime;
  // The snapshot that brought the request is LoadMap's PaintProgress frame (docs/loading-frame.md): no later frame of the level left is
  // drawn over it, from here (a loaded game's files are read first) to the next level's first frame.
  travelHeld = true;
  loadSavedFiles(request).then(currentFiles => loadMap(request.map, { travel: request, currentFiles }))
    .catch(error => { toast(error.message); pauseForRuntimeError(error); })
    .finally(() => { travelHeld = false; });
}
/** A loaded game (`?loadgame=N`, docs/travel.md order step 4): the simulation's Save directory lists the slot without its bytes, which the page keeps in its storage
 * (the browser's, or the picked folder): the files Browse copied into `Current` are read here, awaited, and travel with the level's load. */
async function loadSavedFiles(request) {
  const wanted = request.loadgame?.fetch ?? [];
  if (!wanted.length) return null;
  const directory = savePersistence?.directory;
  if (!directory) throw new Error(`Saved game ${request.loadgame.dir} cannot be read: the page has no save storage`);
  const files = [];
  for (const name of wanted) {
    let bytes = null;
    try { bytes = await directory.read(request.loadgame.dir, name); } catch (error) { throw new Error(`Saved game ${request.loadgame.dir}\\${name} cannot be read: ${error?.message ?? error}`); }
    if (!bytes) throw new Error(`Saved game ${request.loadgame.dir}\\${name} is not in the save storage`);
    files.push({ name, bytes, modified: directory.modifiedOf?.(request.loadgame.dir, name) ?? null });
  }
  return files;
}
function pauseForRuntimeError(error) {
  runtimeError={message:error.message,stack:error.stack,travel:error.travel??null};paused=true;
  keys.clear();drag=false;releasePointer();lockGameKeys(false);
  showStats();
  // The way back: Player start is a ?debug=1 tool; the original start's page has a reload, to the main menu and its Load Game.
  const back=originalStart?'Reload the page to continue from a saved game':'Choose Player start to reset';
  // The map ended by travelling (Stage 6): a stop, not a failure.
  $('toast').textContent=error.travel
    ?(error.name==='TravelStop'
      ?`The map ended: it travels to “${error.travel.url}”, which stops at ${error.message}. Choose Player start to replay.`
      :`The map ended: it travels to “${error.travel.url}”. Map travel is not implemented in this session (Stage 6). Choose Player start to replay.`)
    :`Play paused: ${error.message}. ${back}.`;
}
// A simulation worker that closed, was terminated or never returns from a frame sends nothing (docs/sim-worker.md "A failed worker"): when
// the frames posted to it have heard nothing for SIM_SILENCE_MS, the page says so. A load is not a frame (no posts while `loading`), and a
// frame answers within a GC pause; the toast goes if the worker answers after all.
const SIM_SILENCE_MS = 15000;
const SIM_SILENT = 'The game stopped answering. Reload the page to continue from a saved game (your saves are kept).';
let simSilent = false;
function watchSimulation() {
  const silent = simClient.silence() > SIM_SILENCE_MS;
  if (silent === simSilent) return;
  simSilent = silent;
  if (silent) { keys.clear(); drag = false; releasePointer(); lockGameKeys(false); $('toast').textContent = SIM_SILENT; }
  else if ($('toast').textContent === SIM_SILENT) $('toast').textContent = '';
}
function showStats() {
  const pairs = [['Map', currentMap], ['World triangles', map.summary.triangles.toLocaleString()],
    ['Rendered triangles', world.counts.triangles.toLocaleString()], ['Textures', world.textures],
    ['Static doors / movers', world.counts.movers], ['Actors', map.actors.length],
    ['Lighting actors', world.lighting.lightActors], ['Lightmaps', world.lighting.lightmaps], ['Render errors', world.errors.length]];
  $('stats').replaceChildren(...pairs.flatMap(([label, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; return [dt, dd];
  }));
  $('notes').replaceChildren(...[...world.notes, ...(game?.notes ?? []), ...(runtimeError?[`Play paused: ${runtimeError.message}`]:[]), ...world.errors.slice(0, 10).map(e => `${e.actor ?? `Surface ${e.surface}`}: ${e.message}`)].map(message => {
    const li = document.createElement('li'); li.textContent = message; return li;
  }));
}

/** The worker's map load (sim-worker.mjs `loaded`) as the page's view of a
 * simulation host: stand-ins for `game` and `sim` with what the page reads. */
function remoteHost(loaded) {
  const summary = loaded.summary;
  return { game: loaded.game ? { remote: true, notes: loaded.gameNotes, hud: loaded.hud } : null, session: loaded.game ? { remote: true } : null,
    actorSim: summary ? { summary, actors: [], npcActors: [] } : null, lit: loaded.lit, meshLighting: null,
    notes: loaded.notes, events: loaded.events, hudTextures: loaded.hudTextures, loadMarks: loaded.loadMarks ?? null, released: loaded.released ?? [], dispose() {} };
}
/** The last map load's steps (Stage 7 loading time, docs/load-time.md): `marks`, the page's in ms from loadMap's start; `simMarks`, the
 * simulation side's (in ms from the worker's receipt of the load, or from loadMap's start inline); `firstDraw`, the first frame drawn after it. */
let loadTimeline = null;
const loadMark = step => { if (loadTimeline) loadTimeline.marks.push([step, Math.round(performance.now() - loadTimeline.start)]); };
/** `travel`: the request of the travel step that leads here (travel.mjs; docs/travel.md), null for a map opened directly. The simulation
 * side's Login imports the travel text it carries. */
async function loadMap(name, { travel = null, currentFiles = null } = {}) {
  if (!assets || !assets.files.has(name.toLowerCase())) throw new Error(`Map is not available: ${name}`);
  if (loading) throw new Error('A map is already loading');
  loading = true; $('map').disabled = true; $('reset').disabled = true; $('loadout').disabled = true; $('choose').disabled = true;
  hideNpcFocus();
  $('toast').textContent = '';stopInfoLinkPresentation();
  // The original start keeps the mouse through a travel, as the original's viewport does across a level load.
  if (!originalStart || !travel) releasePointer();
  keys.clear(); inlineFrames.length = 0;
  // A travel (New Game, a level's exit, a loaded game) leaves LoadMap's PaintProgress frame of the level it leaves on the canvas
  // (travelTo, docs/loading-frame.md) for the whole load, the page's own build included. The page's gate is for a load with no level
  // frame behind it (the first map, a map from the list) and for a load error; with the tools (?debug=1) the steps show in the status line.
  const heldFrame = Boolean(travel && world);
  const progress = message => { $(heldFrame ? 'state' : 'gate-message').textContent = message; };
  if (heldFrame) progress(`Loading ${name}…`); else busy('Loading original map', `Reading ${name}…`);
  loadTimeline = { map: name, sim: simMode, start: performance.now(), marks: [], simMarks: null, firstDraw: null };
  let nextWorld, nextHost = null, nextGame = null, nextNpcPreview = null, nextGpuMesh = null, nextSim = null, nextWeaponDraw = null, nextWeaponGpu = null, overlapped = null, warming = null;
  // A travel arrival attaches to the script process of the level left (script-process.mjs): inline here, in the worker there (sim-worker.mjs).
  // ?process=new starts a new one for every level, as a load from the map list does: a new run of the original, whose classes start from
  // their packages' defaults (a default the level left wrote does not come along).
  const shareProcess = new URLSearchParams(location.search).get('process') !== 'new';
  const keepProcess = !simClient && travel && shareProcess ? simHost?.scriptProcess ?? null : null;
  try {
    // A level filed in Save\Current (travel.mjs `restore`: a loaded game's, or one travel left) is drawn from that file, the package the simulation
    // loads (sim-worker.mjs), not from the map's .dx: the two number their objects differently, and the simulation's lighting changes name lights
    // by their object reference in the level it runs (a loaded 03_NYC_747 had 29 of its 36 lights at other references: the plane drew dark).
    // Inline (Firefox's default, ?sim=inline) the simulation's Save directory is this realm's: a loaded game's slot files the page read from its
    // storage go into Save\Current first, as the worker does with them (sim-worker.mjs `load`), and the level is read from there, so the simulation
    // restores it rather than cold-loading the map's .dx.
    const restore = travel?.restore ?? null;
    if (!simClient && currentFiles) {
      const saves = hostSaveDirectory();
      for (const file of currentFiles) saves.writeFile('Current', file.name, file.bytes, file.modified === null ? undefined : { modified: file.modified });
    }
    const filedBytes = !restore ? null : simClient ? currentFiles?.find(file => file.name.toLowerCase() === restore.file.toLowerCase())?.bytes?.slice()
      ?? await simClient.call('filedLevel', { file: restore.file }) : hostSaveDirectory().readFile('Current', restore.file);
    if (restore && !filedBytes) throw new Error(`Save\\Current\\${restore.file} is not in the save directory`);
    const filed = filedBytes ? filedLevel(filedBytes, restore) : null;
    const asset = filed?.asset ?? await assets.get(name);
    await new Promise(resolve => setTimeout(resolve, 0));
    // With the worker the page keeps no property tags of the map's actors: only the simulation's attach reads them (decodeMap)
    const nextMap = filed?.map ?? decodeMap(asset.bytes, { properties: !simClient });
    loadMark('decoded');
    // The simulation side's options that do not come from the page's world. With the worker the load starts now and runs while the page builds
    // its world (sim-client.mjs loadOverlapped): the level's startup in the worker reads none of the world's part, sent below once it is built.
    const params = new URLSearchParams(location.search);
    // With the kept config the player's bSubtitles is the class default every Login reads, the Game Options menu's own: no page override.
    const baseOptions = { randomSeed, subtitles: configStore ? null : subtitlePreference, fullscreen: Boolean(document.fullscreenElement), travel: { arrival: travel, lastURL: travel?.lastURL ?? null },
      meshBackend: params.get('meshBackend'), meshLod: params.get('meshLod'),
      // ?weapons=off: no pawn's third-person weapon is drawn (docs/weapon-attachment.md), for A/B captures; ?weapons=cpu: they take the
      // CPU path (the reference) instead of the GPU mesh path
      weapons: params.get('weapons'),
      // ?weaponMirrors=0: no weapon in mirror child frames (on by default: compared with the original, docs/weapon-attachment.md "Mirrors")
      weaponMirrors: params.get('weaponMirrors'),
      // ?weaponOrder=late: each weapon is lit after all of its pawn's frames (the order before the interleaving; docs/weapon-attachment.md)
      weaponOrder: params.get('weaponOrder'), shareProcess };
    if (simClient) { overlapped = simClient.loadOverlapped(name, baseOptions, currentFiles); overlapped.reply.catch(() => {}); }
    nextWorld = await createWorld(nextMap, asset, assets, (message, done, total) => {
      progress(message); $('progress').max = total; $('progress').value = done;
    });
    loadMark('world');
    if (!nextWorld.counts.triangles) throw new Error(`No renderable surfaces found. ${nextWorld.errors[0]?.message ?? 'Check the selected map.'}`);
    // The page's GPU mesh instances (docs/gpu-mesh.md): the level's and the
    // view model's own; the simulation side keeps layouts with their
    // capacities.
    if(gpuMeshParam==='1'||gpuMeshParam!=='0'&&!softwareRenderer()){
      try{nextGpuMesh=createGpuMesh(renderer);}
      catch(error){nextWorld.notes.push(`GPU mesh path unavailable: ${error.message}`);}
      if(nextGpuMesh){
        try{nextWeaponGpu=createGpuMesh(renderer,WEAPON_GPU_MESH_CAPACITIES);}
        catch(error){nextWorld.notes.push(`GPU mesh path unavailable for the view model: ${error.message}`);}
      }
    }
    // The simulation side (sim-host.mjs): the game, the frame session, the
    // mesh layers' simulation halves and lip sync. The world's part of its options:
    const scenePart = { stampScene: nextWorld.stampScene(), panZones: nextWorld.panZoneNames(),
      // Actors only a child frame draws are admitted where one may exist: a map with mirrors, or with security
      // cameras (a ViewportWindow's frame draws the player, whom Draw's bBehindView stops excluding).
      childFrames: nextWorld.mirrors.stats.planes > 0 || nextMap.actors.some(actor => actor.className === 'SecurityCamera' || actor.className === 'ComputerSecurity'),
      gpu: nextGpuMesh?.capacities ?? null, weaponGpu: nextWeaponGpu?.capacities ?? null };
    const hostOptions = { ...baseOptions, ...scenePart };
    // On the page the old map's audio unregisters its music before the next
    // map's runtime is built (the worker does the same at its load).
    if (!simClient) simHost?.disposeAudio?.();
    if (overlapped) { overlapped.scene(scenePart); overlapped.scene = null; }
    // The level's shader programs build while the simulation side loads (shader-warmup.mjs).
    try { warming = levelWarmup(nextWorld, nextGpuMesh); } catch (error) { console.warn('shader warm-up failed', error); }
    nextHost = simClient ? remoteHost(await overlapped.reply) : await createSimHost(nextMap, asset, assets, { ...hostOptions,
      musicLibrary: pageMusicLibrary, process: keepProcess, restore: Boolean(filed),
      onAudioVoice: event => { void galaxyVoice(event); },
      onProgress: progress,
      // SaveCurrentLevel's PaintProgress frame, drawn by the save on this thread (a key's between frames, a tick's in a frame): animate draws it next
      onPaintProgress: frame => { inlineFrames.push({ progress: frame }); } });
    // The packages the worker's script process released since its last load (sim-worker.mjs releasedPackages) leave the page's store
    // too, now that the next world is built: inline, the one store has released them at the same point (createSimHost's LoadMap).
    for (const name of nextHost.released ?? []) assets.release(name);
    loadMark('host');
    // The level's first tick (about 200 ms on the Island: every pawn's first state code) would be the first frame's, and the page would wait for
    // it after the load. The worker is done with the level and idle while the page builds its meshes and swaps its world in: it makes the tick
    // now, with the dt the first post would carry (sim-session.mjs preTick). A travel's arrival (a loaded game's too) makes it with the loading
    // frame, measured from the last frame before the load to now: the page's build after it is not the level's time, as a shorter load would
    // not be (docs/first-frames.md "Travel and loaded games"). Not when a start cheat or the easter egg act on the level first, nor the loadout of
    // a map opened directly (an arrival keeps its inventory), nor under ?hold=1, whose level ticks only in the frames a test releases (the
    // strobe checks hold TriggerLight1 before its first Tick).
    preTickPending = false;
    if (simClient && preTickParam && !holdParam && nextHost.game && mode === 'play' && !easterParam && !(loadoutParam && !travel) && !startCheats.length) {
      preTickPending = true;
      const dt = travel && travelFrameTime !== null ? Math.max(0, (performance.now() - travelFrameTime) / 1000) : FIRST_FRAME_DT;
      simClient.call('preTick', { dt, width: renderer.domElement.width, height: renderer.domElement.height, aspect: canvasAspect, resizes: resizeCount })
        .catch(() => {});
    }
    loadTimeline.simMarks = simClient ? nextHost.loadMarks : nextHost.loadMarks?.map(([step, at]) => [step, Math.round(at - loadTimeline.start)]) ?? null;
    // the new session's snapshot requests number from 1 again (script-window-host.mjs display.snapshotSerial)
    snapshotServed = 0; saveDeliveries.length = 0;
    nextWorld.notes.push(...nextHost.notes);
    nextGame = nextHost.game; nextSim = nextHost.game ? nextHost.session : null;
    if(nextGame&&simVerify&&!simClient){
      // The simulation side stamps the movers it decides are drawn
      // (sim-session.mjs stamps); ?simVerify records what three.js drew.
      const runtime=nextGame.doors.scriptRuntime.runtime;
      const byName=new Map(runtime.levelFor(nextGame.player.collisionActor).actors.filter(Boolean).map(actor=>[actor.name,actor]));
      nextWorld.root.traverse(mesh=>{
        const actor=mesh.isMesh&&byName.get(mesh.userData.actor);
        if(actor)mesh.onAfterRender=()=>drew.movers.add(actor.name);
      });
    }
    // The page halves: the actor mesh layer's draw (actor-mesh-draw.mjs),
    // with the simulation side's bindings as Training's NPC focus list.
    if(nextHost.actorSim){
      const actorSim=nextHost.actorSim;
      const draw=createActorMeshDraw(assets,{gpu:nextGpuMesh,lit:Boolean(nextHost.meshLighting??nextHost.lit),displayGamma:nextWorld.displayGamma,
        feedback:handle=>simVerify?()=>drew.actors.add(handle):()=>{}});
      // On the page the bindings' views (npc-mesh-preview.mjs bindingView)
      // join both halves; the worker's bindings are out of reach.
      const drawOf=id=>draw.bindings.get(id),views=new WeakMap();
      const view=binding=>{let value=views.get(binding);if(!value)views.set(binding,value=bindingView(binding,drawOf));return value;};
      nextNpcPreview={root:draw.root,draw,summary:actorSim.summary,kernel:actorSim.kernel??null,
        get actors(){return actorSim.actors.map(view);},get npcActors(){return actorSim.npcActors.map(view);},
        /** The pawns' third-person weapon bindings (validation access, page only). */
        get weaponBindings(){return actorSim.all().filter(binding=>binding.attachedTo).map(view);},
        /** Iterator item bindings in use (validation access, page only). */
        itemStats:()=>actorSim.itemSlots?.().map(({actor,ids})=>({actor,slots:ids.length,
          drawn:ids.filter(id=>id!==null&&drawOf(id)?.root.visible).length}))??null,
        batchStats:()=>draw.batchStats(),proceduralTextures:()=>draw.proceduralTextures(),
        /** Validation only (?sim=inline): URender's LOD settings (actor-mesh-sim.mjs). */
        setLodSettings:settings=>actorSim.setLodSettings?.(settings)??null,resetLodSettings:()=>actorSim.resetLodSettings?.(),
        dispose(){draw.dispose();}};
    }
    const nextHud=nextGame?.hud?await createHudRenderer({assets,preload:nextHost.hudTextures}):null;
    nextWeaponDraw=nextGame?createWeaponOverlayDraw(assets,{gpu:nextWeaponGpu,displayGamma:nextWorld.displayGamma,
      feedback:handle=>simVerify?()=>drew.weapon.add(handle):()=>{}}):null;
    // Sprites and particles (docs/particles.md): the simulation's sprite scan
    // (sim-session.mjs sprites) drawn by the page.
    const nextSpriteScene=nextSim?createSpriteScene(assets,new TextureStore(assets),{
      displayGamma:nextWorld.displayGamma,stamp:simVerify?handle=>drew.sprites.add(handle):()=>{}}):null;
    // Light coronas (docs/coronas.md), DrawFrame's corona pass: the
    // simulation's scan (corona-scan.mjs) drawn by the page.
    const nextCoronaPass=nextGame?createCoronaPass(assets,new TextureStore(assets),{displayGamma:nextWorld.displayGamma}):null;
    // Decals (docs/decals.md): DrawFrame's decal block on the simulation
    // side (decal-draw.mjs), its fragments drawn by the page.
    const nextDecalScene=nextSim?createDecalScene(assets,new TextureStore(assets),{displayGamma:nextWorld.displayGamma}):null;
    // Detail textures (docs/frame-projection.md "Detail textures"): D3DDrv's pass on the simulation side (detail-draw.mjs),
    // its fans drawn by the page. ?detailTextures=0 models a device without BLENDDIFFUSEALPHA: no pass.
    let nextDetailScene=null;
    if(nextSim&&detailTexturesOn()){
      try{nextDetailScene=createDetailScene(assets,new TextureStore(assets),{displayGamma:nextWorld.displayGamma,
        surfaceDetails:await modelSurfaceDetails(assets,asset,nextMap.model)});}
      catch(error){nextWorld.notes.push(`Detail textures unavailable: ${error.message}`);}
    }
    // ?detailBias=factor,units[,depth]: the detail passes' depth offset (detail-scene.mjs ZBIAS), for A/B captures against the original.
    const detailBias=new URLSearchParams(location.search).get('detailBias');
    if(nextDetailScene&&detailBias){const [factor,units,depth]=detailBias.split(',').map(Number);nextDetailScene.setBias(factor||0,units||0,depth||0);}
    // The simulation's first events (the startup lighting, the admitted
    // actors' creation records) reach the page before the first frame, whose
    // actor meshes are built while the map loads.
    applySimEvents(crossing(nextHost.events.splice(0)),{world:nextWorld,actors:nextNpcPreview,weapon:nextWeaponDraw});
    await nextNpcPreview?.draw.ready();
    loadMark('meshes');
    coronaPass?.dispose();coronaPass=nextCoronaPass;
    if(spriteScene){scene.remove(spriteScene.root);spriteScene.dispose();}
    spriteScene=nextSpriteScene;
    if(spriteScene)scene.add(spriteScene.root);
    if(decalScene){scene.remove(decalScene.root);decalScene.dispose();}
    decalScene=nextDecalScene;
    if(decalScene)scene.add(decalScene.root);
    if(detailScene){scene.remove(detailScene.root);detailScene.dispose();}
    detailScene=nextDetailScene;
    if(detailScene)scene.add(detailScene.root);
    hudRenderer?.dispose();hudRenderer=nextHud;
    simHost?.dispose(keepProcess);simHost=nextHost;meshLighting=nextHost.meshLighting??null;weaponDraw?.dispose();weaponGpu?.dispose();simStatus=null;simAnswers={keys:{},pointerGrab:false};simLastPost=null;
    weaponDraw=nextWeaponDraw;weaponGpu=nextWeaponGpu;weaponSummary=null;
    if(npcPreview){scene.remove(npcPreview.root);npcPreview.dispose();npcPreview=null;}
    gpuMesh?.dispose();gpuMesh=nextGpuMesh;
    npcPreview=nextNpcPreview??null;
    if(npcPreview){npcPreview.root.visible=true;scene.add(npcPreview.root);}
    $('npc-focus').replaceChildren(...((npcPreview?.npcActors??npcPreview?.actors??[]).map(actor=>{
      const option=document.createElement('option');option.value=option.textContent=actor.summary.actor;return option;
    })));
    $('npc-status').hidden=!npcPreview;
    $('npc-status').textContent=npcPreview?`${npcPreview.summary.npcs??npcPreview.actors.length} NPCs · ${npcPreview.summary.props??0} props · live`:'';
    if (world) { scene.remove(world.root); world.dispose(); }
    world = nextWorld; map = nextMap; currentMap = name; scene.add(world.root); revision++;
    if (fogOrderParam === 'last') world.fog?.setLast(true);
    if (world.mirrors.stats.planes > 0) world.mirrors.clipShape(renderer);
    game = nextGame;sim = nextSim;runtimeError=null;lockGameKeys(true); $('mode').options[0].disabled = !game; const viewReply = setMode(game ? mode : 'inspect'); paused = false;
    // Play is not offered (its kernels did not load, sim-host.mjs): the default start, which has no notes panel, says why.
    if (!game && originalStart) {
      const note = world.notes.find(text => text.startsWith('Play mode unavailable: '));
      $('toast').textContent = `The game cannot start in this browser: ${note ? note.slice('Play mode unavailable: '.length) : 'Play mode unavailable'}. Reload the page; if it stays, try another browser.`;
    }
    // The previews drive the runtime directly: on the page only.
    const training = Boolean(game) && name === '00_Training' && !simClient;
    setPreviewsAvailable({light: training, 'dark-door': training, npc: Boolean(npcPreview?.npcActors?.length),
      instructor: training, weapon: training, datacube: training, keypad: training});
    $('infolink-shell').hidden = true;
    world.displayGamma.value = brightnessGamma(Number($('brightness').value));
    displayFlushes = null; displayResolutionVersion = 0; displayExitRequests = 0;
    // The worker's PlayerCalcView replies point the camera before the map
    // counts as ready (on the page they are synchronous).
    // resetCamera runs ?cheat= when it resets the player (Play mode).
    const playerReset = mode === 'play' && !!game;
    loadMark('swapped');
    const resetReply = resetCamera({ keepLevel: true, travelled: Boolean(travel) }); showStats();
    await viewReply; await resetReply;
    loadMark('playerStart');
    if (!playerReset) await applyStartCheats({ loadout: !travel });
    $('wireframe').checked = false; $('actor-markers').checked = false;
    $('lighting').checked = true;
    $('map').value = name; $('gate').hidden = true; $('reset').disabled = false; $('loadout').disabled = !game;
    $('state').textContent = `${name} · ${world.textures} textures · ${world.counts.triangles.toLocaleString()} triangles`;
    if (world.errors.length) toast(`${world.errors.length} render issues — open Diagnostics for details.`);
    if (warming) {
      const mark = performance.now();
      const summary = $('state').textContent;
      progress('Compiling shaders');
      const result = await warming.finish().catch(error => { console.warn('shader warm-up failed', error); return null; });
      if (heldFrame) $('state').textContent = summary;
      shaderWarmupResult = result && { ...result, waitMs: Math.round(performance.now() - mark) };
    }
    // A travel's level: its first frame's dt runs from the last frame before the load (DeusEx.exe's main loop does not reset OldTime
    // across Browse, 0x109147da..0x109148a6), so the loading frame reaches the new level's first tick, where ULevel::Tick clamps the
    // actors' delta to 0.4 s. A map opened directly keeps the ordinary first frame: the engine's first map is loaded before the main
    // loop takes OldTime (0x10914720..0x109147a9).
    if (travel && travelFrameTime !== null) { if (simClient) simLastPost = travelFrameTime; else lastTime = travelFrameTime; }
    travelFrameTime = null;
    loadMark('ready');
  } catch (error) {
    // (the level left goes on: its next post is an ordinary one)
    preTickPending = false;
    // a load the worker started waits for the world's part: none comes
    overlapped?.scene?.(null);
    warming?.dispose();
    if(nextHost&&nextHost!==simHost)nextHost.dispose?.(keepProcess);
    // The level left goes on: the process it shared is its own again (the failed level's runtime may have attached to it).
    const left=simHost?.game?.doors.scriptRuntime.runtime;
    if(keepProcess&&left&&keepProcess.runtime!==left)keepProcess.attach(left);
    if(nextWeaponDraw&&nextWeaponDraw!==weaponDraw)nextWeaponDraw.dispose();
    if(nextWeaponGpu&&nextWeaponGpu!==weaponGpu)nextWeaponGpu.dispose();
    if(nextNpcPreview&&nextNpcPreview!==npcPreview)nextNpcPreview.dispose();
    if(nextGpuMesh&&nextGpuMesh!==gpuMesh)nextGpuMesh.dispose();
    if (nextWorld && nextWorld !== world) nextWorld.dispose();
    busy('Could not load this map', error.message);
    throw error;
  } finally {
    loading = false; $('map').disabled = false; $('choose').disabled = false;
    $('progress').hidden = true; $('gate-choose').hidden = false;
    $('reset').disabled = !world; $('loadout').disabled = !game;
  }
  return status();
}
async function setFiles(files) {
  if (originalStart) await showSplash(files).catch(error => toast(`Splash: ${error.message}`));
  configPersistence?.close?.();
  configPersistence = await openConfigPersistence({ mode: persistenceMode(location.search, originalStart), onStatus: reportStorage });
  configStore = configPersistence.store;
  const next = new AssetStore(files, { configStore });
  if (simMode === 'worker') {
    // The worker reads the same files (File objects or the dev server's
    // URLs), with the page's DEUS_EX_* switches set before its runtime loads.
    simClient?.terminate();
    simClient = createSimClient({ onProgress: message => { $('gate-message').textContent = message; },
      onFrame: lockstep ? snapshot => drawLockstep(snapshot) : null,
      onFailure: error => pauseForRuntimeError(error),
      // a config file the game wrote: the page keeps it (config-store.mjs accept -> the storage)
      onConfig: record => configStore?.accept(record.leaf, record),
      // a save the game finished or deleted: the storage keeps it (docs/save-storage.md "Writing a save")
      onSave: message => { keepSimSave(message).catch(() => {}); } });   // (a refusal is said by keepSimSave itself)
    const flags = Object.fromEntries(Object.keys(globalThis).filter(key => key.startsWith('DEUS_EX_')).map(key => [key, globalThis[key]]));
    await simClient.init(flags, files.map(file => ({ path: file.path, ...(file.file ? { file: file.file } : {}), ...(file.url ? { url: file.url } : {}) })),
      configStore ? configStore.snapshot() : null, (await savesReady) ? savePersistence.simSaves() : null);
  } else if (await savesReady) {
    pushSaves();
    // the simulation runs on the page: its saves reach the storage directly
    if (savePersistence) setSaveSink({ commitSlot: ({ dir, files }) => keepSimSave({ op: 'commit', dir, files }), removeSlot: ({ dir }) => keepSimSave({ op: 'remove', dir }) });
  }
  await connectMusic(next.configFiles);
  const names = [...next.files.values()].filter(f => /\.(dx|unr)$/i.test(f.path)).map(f => f.name).sort();
  if (!names.length) throw new Error('No maps found. Choose the game folder containing Maps, Textures, and System.');
  assets = next;
  // Honor the installed DeusExPlayer.bSubtitles globalconfig (shipped True) as
  // the initial conversation-subtitle preference; the diagnostics toggle flips it.
  subtitlePreference = await readGlobalConfigBool(next.configFiles, 'DeusEx.DeusExPlayer', 'bSubtitles', false);
  // A resolution the player chose with SetRes and the game kept (display-config.mjs): the drawing buffer is fixed to it as that SetRes did.
  if (configStore) {
    const text = async (list, leaf) => { const file = list.find(entry => String(entry.path).replaceAll('\\', '/').split('/').pop().toLowerCase() === leaf); return file ? decodeIniBytes(await file.read()) : null; };
    // the page starts windowed (fullscreen only by Alt+Enter): the start size is the Windowed* keys', as the original's windowed start reads
    fixedResolution = chosenResolution(await text(files, 'deusex.ini') ?? await text(files, 'default.ini'), await text(next.configFiles, 'deusex.ini'), false);
  }
  const subtitleToggle = $('subtitles'); if (subtitleToggle) subtitleToggle.checked = subtitlePreference;
  $('map').replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; }));
  // (the original's start browses to DeusEx.ini's [URL] LocalMap=DX.dx: docs/boot.md)
  try { await loadMap(names.find(n => n.toLowerCase() === (originalStart ? 'dx' : '00_training')) ?? names[0]); }
  finally { $('splash').hidden = true; }
  // the storage message again, now that the game is on screen (the first one came while the files loaded)
  const kept = configPersistence?.status();
  if (kept?.message) toast(kept.message, 12000);
}
const fail = error => { toast(error.message); if (!world) busy('Could not open game files', error.message); };
$('choose').onclick = $('gate-choose').onclick = () => $('folder').click();
$('folder').onchange = async event => {
  try {
    const files = Array.from(event.target.files, file => ({ path: file.webkitRelativePath || file.name, read: () => file.arrayBuffer(), file }));
    await setFiles(files);
  } catch (error) { fail(error); }
};
$('map').onchange = event => loadMap(event.target.value).catch(fail);
$('reset').onclick = resetCamera;
$('loadout').onclick = () => giveLoadoutNow().catch(error => toast(`Loadout: ${error.message}`, 8000));
$('mode').onchange = event => setMode(event.target.value);
function togglePanel(open) { $('panel').hidden = !open; $('diagnostics').setAttribute('aria-expanded', String(open)); }
$('diagnostics').onclick = () => togglePanel($('panel').hidden);
// Page bars off: the view fills the window, so the HUD root (and with it a
// forced-play conversation's letterbox, which holds the intro's subtitles)
// gets the window's own aspect. A per-browser convenience only.
function setUiHidden(hidden) {
  if (hidden) closeToolbarMenus();
  $('app').classList.toggle('ui-hidden', hidden); $('show-ui').hidden = !hidden;
  try { localStorage.setItem('deusex.uiHidden', hidden ? '1' : '0'); } catch { /* storage unavailable */ }
}
$('hide-ui').onclick = () => setUiHidden(true);
function setCrt(enabled, announce = false) {
  crtToggleVersion++;
  crtEnabled = Boolean(enabled);
  if (!crtEnabled) { crtCompare = false; displayRamp?.reset(); crtMaterialRamp?.reset(); }
  $('crt').setAttribute('aria-pressed', String(crtEnabled));
  $('crt').textContent = crtEnabled ? 'On' : 'Off';
  $('display-options').classList.toggle('has-effect', crtEnabled);
  $('display-options').title = crtEnabled ? `Display settings · ${CRT_PRESETS[crtShader].name} enabled` : 'Display settings';
  $('crt-compare').setAttribute('aria-pressed', String(crtCompare));
  $('crt-comparison').hidden = !crtCompare;
  $('crt-comparison-name').textContent = CRT_PRESETS[crtShader].name;
  try { localStorage.setItem('deusex.crt', crtEnabled ? '1' : '0'); } catch { /* storage unavailable */ }
  if (announce) toast(crtEnabled ? `CRT enabled · ${CRT_PRESETS[crtShader].name} · Alt+C / Option+C` : 'CRT disabled · Alt+C / Option+C');
}
$('crt').onclick = () => {
  setCrt(!crtEnabled, true);
  if (world && !loading && !$('display-menu').matches(':popover-open')) $('scene').focus({ preventScroll: true });
};
let crtSelection = 0;
async function setCrtShader(value, activate = true) {
  const id = Object.hasOwn(CRT_PRESETS, value) ? value : 'aperture';
  const request = ++crtSelection;
  const toggleVersion = crtToggleVersion;
  $('crt-shader').value = id;
  try {
    if (id === 'royale') {
      if (activate) toast('Loading CRT-Royale…');
    }
    await prepareCrtPreset(id);
  } catch (error) {
    if (request !== crtSelection) return;
    $('crt-shader').value = crtShader;
    toast(`Could not load ${CRT_PRESETS[id].name}: ${error.message}`);
    return;
  }
  if (request !== crtSelection) return;
  crtShader = id;
  $('crt-shader').value = crtShader;
  try { localStorage.setItem('deusex.crtShader', crtShader); } catch { /* storage unavailable */ }
  setCrt((activate && toggleVersion === crtToggleVersion) || crtEnabled, activate);
}
for (const [id, preset] of Object.entries(CRT_PRESETS)) $('crt-shader').add(new Option(preset.label, id));
try {
  const enabled = localStorage.getItem('deusex.crt') === '1';
  const preset = localStorage.getItem('deusex.crtShader') ?? 'aperture';
  setCrt(enabled);
  setCrtShader(preset, false);
} catch { /* storage unavailable */ }
$('crt-shader').onchange = event => {
  setCrtShader(event.target.value);
  if (world && !loading && !$('display-menu').matches(':popover-open')) $('scene').focus({ preventScroll: true });
};
$('crt-compare').onclick = () => {
  closeToolbarMenus();
  crtCompare = !crtCompare; setCrt(true);
  if (world && !loading) $('scene').focus({ preventScroll: true });
};
function setScreenAspect(value) {
  screenAspect = Object.hasOwn(SCREEN_ASPECTS, value) ? value : 'window'; $('screen-aspect').value = screenAspect; resize();
  if (originalStart) return;
  try { localStorage.setItem('deusex.screenAspect', screenAspect); } catch { /* storage unavailable */ }
}
$('screen-aspect').onchange = event => setScreenAspect(event.target.value);
// The original's start is 4:3: DeusEx.ini [WinDrv.WindowsClient] StartupFullscreen=True at FullscreenViewportX=640,
// FullscreenViewportY=480, and every mode the menu offers is 4:3 or 5:4 (SetRes fixes the buffer to it). The original keeps
// its horizontal field of view, so a wider screen shows less above and below; 4:3 shows all of the default's view.
// The ?debug=1 page keeps its stored choice (the window's own shape by default).
if (originalStart) setScreenAspect('4:3');
else try { setScreenAspect(localStorage.getItem('deusex.screenAspect') ?? 'window'); } catch { /* storage unavailable */ }
$('show-ui').onclick = () => setUiHidden(false);
try { if (localStorage.getItem('deusex.uiHidden') === '1') setUiHidden(true); } catch { /* storage unavailable */ }
$('close-panel').onclick = () => togglePanel(false);
$('wireframe').onchange = event => { if (world) for (const material of world.materials.values()) material.wireframe = event.target.checked; };
$('actor-markers').onchange = event => { if (world) world.markers.visible = event.target.checked; };
$('lighting').onchange = event => { if (world) world.lightingEnabled.value = event.target.checked ? 1 : 0; };
$('subtitles').onchange = event => { subtitlePreference = event.target.checked; simInput.subtitles(subtitlePreference); };
function setBrightness(value) {
  $('brightness').value = String(value);
  if (world) world.displayGamma.value = brightnessGamma(value);
  $('brightness-value').value = value.toFixed(2);
}
$('brightness').oninput = event => setBrightness(Number(event.target.value));
// The render device's view of the client config (sim-session.mjs snapshot.display): a Flush re-reads
// Brightness (D3DDrv UD3DRenderDevice::Flush) and a SetRes request fixes the drawing buffer.
let displayFlushes = null, displayResolutionVersion = 0, displayFullscreenToggles = 0, displayRelaunches = 0, displayExitRequests = 0, exited = false;
/** USystem::Exec EXIT/QUIT (MenuMain's Exit and the box's Yes; docs/host-services.md "Exit"): the original's main loop ends after the tick and
 * the process shuts down. A page cannot close itself: the simulation ends, the sound stops, the view goes blank and the page says so. */
function endGame() {
  exited = true; paused = true;
  keys.clear(); drag = false; releasePointer(); lockGameKeys(false);
  stopInfoLinkPresentation(); infoLinkAudioContext?.suspend?.().catch(() => {});
  // (with the worker gone, the page's input paths would fall to the inline game's methods: no game is left to take input)
  simClient?.terminate(); simClient = null; game = null;
  $('scene').style.visibility = 'hidden';
  $('toast').textContent = 'Deus Ex has exited. Reload the page to start again.';
}
function applyDisplaySettings(display) {
  // The Exec chain's host requests (docs/host-services.md): UWindowsViewport::Exec ToggleFullscreen does what Alt+Enter does (the menu
  // click that sent it is the user activation the browser asks for); USystem::Exec RELAUNCH restarts the game, a page reload; EXIT/QUIT ends
  // it. A listener may cancel the 'deusex-relaunch' and 'deusex-exit' events (the menu sweep and validators do).
  if (display.fullscreenToggles !== displayFullscreenToggles) {
    const requests = display.fullscreenToggles - displayFullscreenToggles; displayFullscreenToggles = display.fullscreenToggles;
    if (requests > 0 && requests % 2 === 1) toggleFullscreen();
  }
  applySnapshotRequests(display);
  if (display.relaunches !== displayRelaunches) {
    displayRelaunches = display.relaunches;
    const event = new CustomEvent('deusex-relaunch', { cancelable: true, detail: { arguments: display.relaunchArguments } });
    if (window.dispatchEvent(event)) location.reload();
  }
  if ((display.exitRequests ?? 0) !== displayExitRequests) {
    displayExitRequests = display.exitRequests;
    if (window.dispatchEvent(new CustomEvent('deusex-exit', { cancelable: true }))) endGame();
  }
  // The first frame of a load takes the client's Brightness as the render device's Init does (the kept config's, when the player set one)
  if ((displayFlushes === null ? Boolean(configStore) : display.flushes !== displayFlushes) && Number.isFinite(display.brightness)) setBrightness(display.brightness);
  displayFlushes = display.flushes;
  if (display.resolutionVersion !== displayResolutionVersion) {
    displayResolutionVersion = display.resolutionVersion;
    fixedResolution = display.resolution ? { width: display.resolution.width, height: display.resolution.height } : null;
    resize();
  }
}
// RootWindow.GenerateSnapshot (docs/root-snapshot.md): each requested texture is made here, from the frame the page drew last, before
// the HUD that names it draws. The pixels are the original's resampling (script-root-snapshot.mjs) of the kept frame; a request before
// any frame was kept reads an empty (black) frame, as ReadPixels of a cleared surface would.
/** The snapshot requests of saves waiting for a kept frame, and the answer: RootWindow.GenerateSnapshot's pixel work on the kept frame, as the P8 indices of the
 * texture (the 160 x 120 picture in the next power of two), sent to the simulation by the save's job number. A frame kept while the save waited is the one the
 * player last saw; with none yet, the next one drawn answers (serveSaveSnapshots runs after each kept frame). */
const saveDeliveries = [];
function serveSaveSnapshots() {
  if (!saveDeliveries.length || !frameKeeper.hasFrame) return;
  const frame = frameKeeper.read();
  if (!frame) return;
  for (const request of saveDeliveries.splice(0)) {
    const grey = snapshotGrey(frame.pixels, frame.width, frame.height, request.snapW, request.snapH);
    const data = Uint8Array.from(grey.data);
    if (simClient) simClient.snapshotPixels(request.jobId, grey.pitch, grey.height, data);
    else void import('../runtime/game-save.mjs').then(save => save.deliverSaveSnapshot(request.jobId, { data }));
  }
}
function applySnapshotRequests(display) {
  // textures the simulation made from bytes it holds (a save's snapshot picture): the HUD draws them by key once they are here
  for (const image of display.images ?? []) hudRenderer?.setDynamicImage(image.key, { width: image.width, height: image.height, data: image.data });
  keepingFrames = Boolean(display.keepFrame);
  if (!keepingFrames) frameKeeper.reset();
  for (const request of display.snapshotRequests ?? []) {
    if (request.serial <= snapshotServed || !hudRenderer) continue;
    snapshotServed = request.serial;
    // a save's snapshot (game-save.mjs): not a texture the HUD draws; the picture goes back to the simulation, made from a kept frame
    if (request.deliver) { saveDeliveries.push(request); continue; }
    const frame = frameKeeper.read() ?? { width: request.sizeX, height: request.sizeY, pixels: new Uint32Array(request.sizeX * request.sizeY) };
    const grey = snapshotGrey(frame.pixels, frame.width, frame.height, request.snapW, request.snapH);
    const data = new Uint8Array(grey.data.length * 4);
    for (let i = 0; i < grey.data.length; i++) { const g = grey.data[i], at = i * 4; data[at] = data[at + 1] = data[at + 2] = g; data[at + 3] = 255; }
    hudRenderer.setDynamicImage(request.key, { width: grey.pitch, height: grey.height, data });
    snapshotKeys.push(request.key);
    // The script drops its last snapshot when it makes the next; a texture older than two requests cannot be on screen.
    while (snapshotKeys.length > 3) hudRenderer.releaseDynamicImage(snapshotKeys.shift());
  }
  serveSaveSnapshots();
  for (const key of display.snapshotReleased ?? []) {
    const at = snapshotKeys.indexOf(key);
    if (at >= 0) { hudRenderer?.releaseDynamicImage(key); snapshotKeys.splice(at, 1); }
  }
}
function setCamera(input) {
  if (!world) throw new Error('No map loaded');
  if (!input || Object.keys(input).some(k => !['position', 'rotation'].includes(k)) ||
    ![input.position, input.rotation].every(a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite)) ||
    input.position.some(n => Math.abs(n) > 1e7) || input.rotation.some(n => Math.abs(n) > 65536)) throw new Error('Expected three finite position coordinates and three Unreal rotator values');
  const signed = n => ((n % 65536 + 98304) % 65536 - 32768) * Math.PI / 32768;
  setMode('inspect');
  camera.position.fromArray(toView(input.position));
  pitch = signed(input.rotation[0]); yaw = -signed(input.rotation[1]);
  camera.rotation.set(pitch, yaw, -signed(input.rotation[2])); cameraMoved = true;
  $('camera-position').value = input.position.join(', '); $('camera-rotation').value = input.rotation.join(', ');
  return status();
}
$('camera-form').onsubmit = event => {
  event.preventDefault();
  try { setCamera({ position: $('camera-position').value.split(',').map(Number), rotation: $('camera-rotation').value.split(',').map(Number) }); }
  catch (error) { toast(error.message); }
};

// Viewer-only preview navigation, grouped in one toolbar menu. Each entry runs
// its handler below; the menu returns to its placeholder after every choice.
const previews = {};
function setPreviewsAvailable(available) {
  const menu = $('preview');
  for (const option of menu.options) if (option.value) option.hidden = option.disabled = !available[option.value];
  menu.value = ''; menu.hidden = ![...menu.options].some(option => option.value && !option.disabled);
}
$('preview').onchange = event => {
  const run = previews[event.target.value];
  event.target.value = ''; $('scene').focus();
  void run?.();
};

// The actual light change still executes the original switch Frob and
// TriggerLight state scripts in the shared game host.
function hideNpcFocus(){
  // Camera controls are optional; authored NPC meshes remain in the scene.
  $('npc-preview-label').hidden=true;
}
function focusNpcPreview(name){
  const actor=npcPreview.actors.find(actor=>actor.summary.actor===name);
  if(!actor)return;
  const location=actor.location,angle=actor.rotation[1]*Math.PI/32768;
  setCamera({position:[location[0]+Math.cos(angle)*155,location[1]+Math.sin(angle)*155,location[2]+15],
    rotation:[-600,(actor.rotation[1]+32768)%65536,0]});
  stopInfoLinkPresentation();npcPreview.root.visible=true;
  $('npc-preview-title').textContent=`${npcPreview.actors.length} NPC meshes · original Training assets`;
  $('npc-preview-label').hidden=false;togglePanel(false);
}
$('npc-focus').onchange=event=>focusNpcPreview(event.target.value);
previews.npc=()=>{
  if(!npcPreview||loading)return;
  // Inspection camera only: do not teleport JC or start an invented idle.
  focusNpcPreview($('npc-focus').value);
};

// Explicit preview placement/aim only. Selection is still the original
// HighlightCenterObject query, at its own FrobTime cadence.
function aimPreview(target, point = null) {
  const runtime = game.doors.scriptRuntime.runtime, pawn = game.player.collisionActor;
  for (let frame = 0; frame < 60; frame++) {
    const at = point ?? runtime.readNamed(target, 'Location');
    const eye = runtime.readNamed(pawn, 'Location').slice();
    eye[2] += runtime.readNamed(pawn, 'BaseEyeHeight');
    const d = at.map((value, i) => value - eye[i]);
    const rotation = [Math.trunc(Math.atan2(d[2], Math.hypot(d[0], d[1])) * 32768 / Math.PI),
      Math.trunc(Math.atan2(d[1], d[0]) * 32768 / Math.PI), 0];
    runtime.writeNamed(pawn, 'ViewRotation', rotation);
    runtime.writeNamed(pawn, 'Rotation', [0, rotation[1], 0]);
    game.tick(1 / 60);
    if (runtime.readNamed(pawn, 'FrobTarget') === target) { applyPlayerView(sim.view()); return; }
  }
  throw new Error(`Original preview trace did not select ${target.name}: ` +
    `selected=${runtime.readNamed(pawn, 'FrobTarget')?.name ?? 'None'}, ` +
    `player=${JSON.stringify(runtime.readNamed(pawn, 'Location'))}, ` +
    `target=${JSON.stringify(runtime.readNamed(target, 'Location'))}`);
}

// Viewer test navigation only. Original startup, targeting and Frob still run;
// no keys, doors, flags, target or conversation state are assigned here.
previews.instructor=()=>{
  if(!game||loading||currentMap!=='00_Training')return;
  try{
    setMode('play');resetCamera();
    const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor;
    const instructor=runtime.levelFor(player).actors.find(actor=>actor?.name==='UNATCOTroop3');
    if(!instructor)throw new Error('Training instructor is unavailable');
    const location=runtime.readNamed(instructor,'Location');
    game.collision.queries.changeActor(player,()=>{
      game.player.position=[location[0]-80,location[1],location[2]];
      game.player.velocity=[0,0,0];
    });
    aimPreview(instructor);
    drag=false;releasePointer();togglePanel(false);$('scene').focus();
    void activateInfoLinkAudio().catch(error=>pauseForRuntimeError(error));
    toast('Instructor preview · wait a few seconds, then right-click to speak. Player start returns to the beginning.');
  }catch(error){pauseForRuntimeError(error);}
};

// Places Play beside the Training weapon crate, picks up the crowbar through the
// public frob path, equips its original belt slot, then faces the adjacent crates.
// The crowbar and crates sit past the locked keypad doors that the training
// scripts open; this is the same curated placement the other previews use
// (changeActor next to the target). Real gameplay reaches them by walking once
// those doors open.
previews.weapon = async () => {
  if (!game || loading || currentMap !== '00_Training') return;
  try {
    setMode('play'); resetCamera();
    const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
    const crowbar = runtime.levelFor(player).actors.find(actor => actor?.name === 'WeaponCrowbar1');
    if (!crowbar) throw new Error('Training crowbar is unavailable');
    const location = runtime.readNamed(crowbar, 'Location');
    game.collision.queries.changeActor(player, () => {
      game.player.position = [location[0] - 48, location[1], location[2]];
      game.player.velocity = [0, 0, 0];
    });
    yaw = 0; pitch = -0.15; camera.rotation.set(pitch, yaw, 0);
    camera.position.fromArray(toView(game.player.eye));
    drag = false; releasePointer(); togglePanel(false); $('scene').focus();
    aimPreview(crowbar);
    const picked = game.use();
    const belt=game.hud.read(game.hud.hud,'belt');
    const position=game.hud.read(belt,'objects').findIndex(slot=>game.hud.read(slot,'item')===crowbar);
    const equipped = await game.activateBelt(position);
    const crate=runtime.levelFor(player).actors.find(actor=>actor?.name==='CrateBreakableMedGeneral1');
    const at=runtime.readNamed(crate,'Location');
    // This diagnostic placement matches validate-crowbar-crate's measured
    // reachable trace, while every swing still runs through public input/ticks.
    game.collision.queries.changeActor(player,()=>{
      game.player.position=[at[0],at[1]+64,-128+43+0.2];game.player.velocity=[0,0,0];
    });
    aimPreview(crate);
    toast(`${picked.message || 'Crowbar'} · ${equipped.ok ? 'Click or press Enter twice to break the crate' : 'select from the object belt'}`);
  } catch (error) { pauseForRuntimeError(error); }
};

// Places Play in front of DataCube0 (the paddoor code) and aims at it. Reading
// uses the original RightMouse binding: ParseRightClick -> DoFrob -> InformationDevices.Frob.
previews.datacube = () => {
  if (!game || loading || currentMap !== '00_Training') return;
  try {
    setMode('play'); resetCamera();
    const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
    const cube = runtime.levelFor(player).actors.find(actor => actor?.name === 'DataCube0');
    if (!cube) throw new Error('Training DataCube0 is unavailable');
    const at = runtime.readNamed(cube, 'Location'), side = 48 * Math.SQRT1_2;
    game.collision.queries.changeActor(player, () => {
      game.player.position = [at[0] - side, at[1] - side, at[2]];
      game.player.velocity = [0, 0, 0];
    });
    for (let frame = 0; frame < 30; frame++)
      game.tick(1 / 60);
    camera.position.fromArray(toView(game.player.eye));
    drag = false; releasePointer(); togglePanel(false); $('scene').focus();
    // The original highlight tick selects the cube from the preview aim.
    aimPreview(cube);
    toast('DataCube preview · right-click to read it; walk away or right-click again to close.');
  } catch (error) { pauseForRuntimeError(error); }
};

previews.keypad = () => {
  if (!game || loading || currentMap !== '00_Training') return;
  try {
    setMode('play'); resetCamera();
    const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
    const keypad = runtime.levelFor(player).actors.find(actor => actor?.name === 'Keypad0');
    if (!keypad) throw new Error('Training Keypad0 is unavailable');
    const at = runtime.readNamed(keypad, 'Location');
    game.collision.queries.changeActor(player, () => {
      game.player.position = [at[0] - 48, at[1], at[2]];
      game.player.velocity = [0, 0, 0];
    });
    for (let frame = 0; frame < 30; frame++)
      game.tick(1 / 60);
    yaw = 0; pitch = Math.atan2(at[2] - game.player.eye[2], 48);
    camera.rotation.set(pitch, yaw, 0); camera.position.fromArray(toView(game.player.eye));
    drag = false; releasePointer(); togglePanel(false); $('scene').focus();
    aimPreview(keypad);
    toast('Keypad preview · right-click to open it, then type the DataCube code 0012.');
  } catch (error) { pauseForRuntimeError(error); }
};

previews.light = () => {
  if (!game || loading || currentMap !== '00_Training') return;
  try {
    const runtime=game.doors.scriptRuntime.runtime;
    const player=game.player.collisionActor;
    const lightSwitch=runtime.levelFor(player).actors.find(actor=>actor?.name==='LightSwitch0');
    if (!lightSwitch) throw new Error('Training light switch is unavailable');
    const location=runtime.readNamed(lightSwitch,'Location');
    setMode('play');
    game.collision.queries.changeActor(player, () => {
      game.player.position = [location[0]-80,location[1],location[2]]; game.player.velocity = [0,0,0];
    });
    aimPreview(lightSwitch); game.use();
    game.tick(.4);
    world.syncMovers(sim.movers());
    const lit=runtime.levelFor(player).actors.some(actor=>actor&&/^TriggerLight[0-3]$/.test(actor.name)&&
      runtime.readNamed(actor,'LightBrightness')>0);
    toast(`Room lights ${lit?'on':'off'} · switch mesh is not rendered yet`);
  } catch(error) { pauseForRuntimeError(error); }
};

// Viewer navigation for the newly admitted original TriggerToggle pair. The
// preview uses the normal game.use path; opening/closing and empty padoor fanout
// remain owned by the installed Mover bytecode.
previews['dark-door'] = () => {
  if (!game || loading || currentMap !== '00_Training') return;
  try {
    const pair=game.collision.movers.filter(mover=>
      ['DeusExMover19','DeusExMover20'].includes(mover.name));
    if(pair.length!==2||pair.some(mover=>!mover.supported))
      throw new Error('Training dark-room doors are unavailable');
    setMode('play');
    const at = game.doors.scriptRuntime.runtime.readNamed(pair[0], 'Location');
    game.collision.queries.changeActor(game.player.collisionActor, () => {
      game.player.position = [at[0]-80,at[1],at[2]]; game.player.velocity = [0,0,0];
    });
    aimPreview(pair[0]);
    const result=game.use();
    for(let frame=0;frame<260;frame++)game.tick(1/120);
    world.syncMovers(sim.movers());
    const open=pair.every(mover=>mover.interpolation.key===1);
    toast(`Dark-room doors ${open?'opened':'closed'} · original padoor fanout found 0 actors`);
    return result;
  } catch(error) { pauseForRuntimeError(error); }
};

// The simulation side's input between frames: direct on the page
// (?sim=inline, clone), else queued for the worker's next frame, whose
// snapshot answers the page's synchronous questions one frame late (whether
// a key was handled or consumed, whether a modal holds the mouse).
const simInput = {
  key(code, pressed) {
    if (!simClient) return game.inputKey(code, pressed);
    simClient.queue({ op: 'key', code, pressed });
    return simAnswers.keys[code] ?? { handled: true };
  },
  // One WM_CHAR unit; nothing on the page waits for its answer.
  char(char) { if (simClient) simClient.queue({ op: 'char', char }); else game.inputChar(char); },
  button(name, pressed) { if (simClient) simClient.queue({ op: 'button', name, pressed }); else game.inputButton(name, pressed); },
  motion(dx, dy) { if (simClient) simClient.queue({ op: 'motion', dx, dy }); else game.mouseMotion(dx, dy); },
  // One WM_MOUSEWHEEL (docs/input-bindings.md); in the queue with the keys and buttons, so their order is kept.
  wheel(delta) { if (simClient) simClient.queue({ op: 'wheel', delta }); else game.inputWheel(delta); },
  pointer(sample) {
    if (!simClient) return game.windowPointer(sample);
    simClient.queue({ op: 'pointer', sample });
    return simAnswers.pointerGrab;
  },
  reset(options) { if (!game) return; if (simClient) simClient.queue({ op: 'resetInput', options }); else game.resetInput(options); },
  subtitles(value) { if (!game) return; if (simClient) simClient.queue({ op: 'subtitles', value }); else game.subtitles = value; },
  // Whether the page is fullscreen: SetRes saves the Fullscreen* or the Windowed* viewport keys by it.
  fullscreen(value) { if (!game) return; if (simClient) simClient.queue({ op: 'fullscreen', value }); else game.viewportFullscreen = value; },
};
function look(dx, dy) {
  if (mode === 'play' && game) {
    try { simInput.motion(dx, dy); cameraMoved = true; }
    catch (error) { pauseForRuntimeError(error); }
    return;
  }
  yaw -= dx * .0025; pitch = THREE.MathUtils.clamp(pitch - dy * .0025, -Math.PI / 2 + .01, Math.PI / 2 - .01);
  camera.rotation.set(pitch, yaw, 0); cameraMoved = true;
}
function windowPointer(event,action=null){
  if(mode!=='play'||!game||runtimeError||!world||loading)return false;
  const canvas=$('scene'),rect=canvas.getBoundingClientRect(),locked=document.pointerLockElement===canvas;
  // A free pointer over the page outside the picture (the 4:3 picture's bars) leaves the game's cursor where it is: the root would clamp
  // it to the edge the pointer left by, where its image (drawn right of and below its hot spot) is out of sight on the right and bottom
  // edges. The system cursor shows there; the game's comes back under the pointer as it enters the picture.
  if(!locked&&action===null&&!(event.clientX>=rect.left&&event.clientX<rect.right&&event.clientY>=rect.top&&event.clientY<rect.bottom))
    return simClient?simAnswers.pointerGrab:game.windowMouseGrabbed();
  const sample=windowPointerSample(event,rect,renderer.domElement.width,renderer.domElement.height,locked);
  if(action!==null){const key=pointerButtonKey(event.button);if(key<0)return false;sample.key=key;sample.action=action;}
  try{return simInput.pointer(sample);}catch(error){pauseForRuntimeError(error);return true;}
}
// The original's start (not ?debug=1): the game owns the mouse while it plays, and its menus draw their own cursor.
// [WinDrv.WindowsClient] StartupFullscreen=True and CaptureMouse=True: the original starts fullscreen with the mouse captured,
// and its viewport's WM_KEYDOWN/WM_SYSKEYDOWN case (WinDrv 0x1110a280) turns Enter with Alt held (GetKeyState(VK_MENU) & 0x8000)
// into UWindowsViewport::ToggleFullscreen (0x1110a29b) instead of an input event. A browser grants fullscreen and the pointer
// lock only on a user's input, and its user's Escape releases the lock, except in a page's fullscreen whose Keyboard Lock holds
// Escape (Chromium; a held Escape still leaves). The page starts windowed (the user's choice, 2026-10-22: no fullscreen on the first
// click, so not StartupFullscreen's mode): a click takes the pointer; Alt+Enter (or Display's Toggle Full-Screen Mode, the same
// ToggleFullscreen) takes fullscreen, Escape and the pointer, and leaves them again. A click that a window (a menu) takes is that
// window's too; a click in the world only takes the pointer and reaches no binding (this page's rule, not the original's: no Fire
// on the click that grabs).
let grabButton = -1, grabOnRelease = false;
// Keyboard Lock (Chromium; a page's fullscreen only) hands the page the keys the browser would take for itself (F1 help, F3
// find, F5 reload, F6, F7 caret browsing, F11, F12, Tab, Ctrl+W and the like): every key the original can bind, with Escape
// held to leave. A runtime error keeps only Escape, so F5 reloads. Nothing locks outside fullscreen or in other browsers.
function lockGameKeys(all) {
  if (!originalStart || !document.fullscreenElement) return;
  navigator.keyboard?.lock?.(all ? GAME_KEY_CODES : ['Escape'])?.catch?.(() => {});
}
function takeFullscreen() {
  const app = $('app');
  if (document.fullscreenElement) return;
  app.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {});
}
function leaveFullscreen() {
  navigator.keyboard?.unlock?.();
  releasePointer();
  if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {});
}
document.addEventListener('fullscreenchange', () => {
  simInput.fullscreen(Boolean(document.fullscreenElement));
  if (lockWithFullscreen && document.fullscreenElement && document.pointerLockElement !== $('scene')) $('scene').requestPointerLock?.()?.catch?.(() => {});
  lockWithFullscreen = false;
  if (!originalStart) return;
  if (!document.fullscreenElement) { navigator.keyboard?.unlock?.(); return; }
  lockGameKeys(!runtimeError);
});
function grabPointer(event, windowHasMouse) {
  const canvas = $('scene');
  if (!originalStart || mode !== 'play' || !game || runtimeError || document.pointerLockElement === canvas) return false;
  // The lock after the release: a lock taken at the press resets the input (pointerlockchange) before the window sees its release.
  grabOnRelease = true;
  if (windowHasMouse) return false;
  grabButton = event.button; event.preventDefault();
  return true;
}
// UWindowsViewport::ToggleFullscreen (0x1110d500): fullscreen and the pointer lock leave together, and come back together.
// Firefox refuses a lock requested in the same event as the fullscreen (NotAllowedError) and grants it once the page is fullscreen
// (measured 2026-10-28, Playwright's Firefox 155; Chromium grants both), so the fullscreenchange handler asks again (lockWithFullscreen).
let lockWithFullscreen = false;
function toggleFullscreen() {
  if (document.fullscreenElement) leaveFullscreen();
  else {
    takeFullscreen();
    if (mode === 'play' && game && !runtimeError) { lockWithFullscreen = true; $('scene').requestPointerLock?.()?.catch?.(() => {}); }
  }
}
// Alt+Enter, the original's ToggleFullscreen; the Enter press reaches no binding (Enter=ParseLeftClick|Fire).
function toggleFullscreenKey(event) {
  if (!originalStart || event.code !== 'Enter' && event.code !== 'NumpadEnter' || !event.altKey || event.ctrlKey || event.metaKey) return false;
  event.preventDefault();
  if (event.repeat) return true;
  toggleFullscreen();
  return true;
}
$('scene').onpointerdown = event => {
  if (!world || loading) return;
  paused = mode === 'play' && Boolean(runtimeError); $('scene').focus();
  const windowHasMouse = windowPointer(event);
  if (grabPointer(event, windowHasMouse)) return;
  if (mode === 'play' && game && !runtimeError) {
    const key = ['LeftMouse', 'MiddleMouse', 'RightMouse'][event.button];
    try { if (key) simInput.button(key, true); }
    catch (error) { pauseForRuntimeError(error); }
  }
  if (windowHasMouse) { keys.clear(); drag = false; event.preventDefault(); return; }
  if (event.button === 0 && document.pointerLockElement !== $('scene')) {
    drag = true; $('scene').setPointerCapture(event.pointerId);
  }
};
$('scene').oncontextmenu = event => event.preventDefault();
// WinDrv delivers the left, right and middle buttons only (WM_LBUTTON*, WM_RBUTTON*, WM_MBUTTON*; the XBUTTON messages 0x20b-0x20d
// take its default case): a middle press must not start the browser's autoscroll, nor the back and forward buttons navigate.
$('scene').onmousedown = event => { if (event.button === 1) event.preventDefault(); };
for (const type of ['mouseup', 'auxclick']) $('scene').addEventListener(type, event => { if (event.button >= 1) event.preventDefault(); });
$('scene').onpointerup = event => {
  drag = false;
  // The lock once the release is queued.
  const takeScreen = () => {
    if (grabOnRelease) { grabOnRelease = false; $('scene').requestPointerLock?.()?.catch?.(() => {}); }
  };
  if (event.button === grabButton) { grabButton = -1; event.preventDefault(); takeScreen(); return; }
  if (windowPointer(event)) event.preventDefault();
  if (mode !== 'play' || !game) return takeScreen();
  const key = ['LeftMouse', 'MiddleMouse', 'RightMouse'][event.button];
  try { if (key) simInput.button(key, false); }
  catch (error) { pauseForRuntimeError(error); }
  takeScreen();
};
$('scene').onpointercancel = () => { drag = false; simInput.reset({releasePhysical:true}); };
$('scene').ondblclick = () => $('scene').requestPointerLock?.()?.catch?.(() => toast('Drag the view to look around.'));
// Chromium's first pointermove under a new lock can carry the pointer's whole offset as movement (-516, -155 in a headless
// run): it would throw the menu's cursor or the view; that one event is dropped.
let lockMoveDropped = true;
document.addEventListener('pointerlockchange', () => { lockMoveDropped = !document.pointerLockElement; });
document.addEventListener('pointermove', event => {
  if (document.pointerLockElement === $('scene') && !lockMoveDropped) { lockMoveDropped = true; return; }
  const windowHasMouse = windowPointer(event);
  // The original start shows only the game's cursor over a window that holds the mouse; the system one marks a world to click into.
  if (originalStart) $('scene').style.cursor = windowHasMouse ? 'none' : '';
  if (windowHasMouse || loading) return;
  if (document.pointerLockElement === $('scene') || drag) look(event.movementX, event.movementY);
});
// UEngine::InputEvent (docs/script-console-command.md): Console.KeyEvent, then
// XInputExt::Process. A key the player's root window consumes (a grabbing
// modal such as the keypad or a menu) releases every held binding and reaches
// nothing else; any other key runs its binding (Escape=ShowMainMenu).
function inputKey(event, pressed) {
  if (mode !== 'play' || !game || runtimeError || !world || loading) return null;
  if (/INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) return null;
  try { return simInput.key(event.code, pressed); }
  catch (error) {
    // A console-command keyword claim throws before its handler does any
    // work, so Play continues; a binding that already ran a line pauses.
    if (error?.name === 'UnsupportedConsoleCommandError' && !error.partial) {
      if (pressed) toast(`${event.code}: ${error.message}`);
      return {handled: true};
    }
    pauseForRuntimeError(error);
    return {handled: true, consumed: true};
  }
}
// WinDrv's window procedure answers every key message itself (no DefWindowProc): the browser's own action for a key the original
// can bind (Tab's focus move, F1's help, F3's find, F5's reload, F6, F7's caret browsing, F12's devtools, the quick find of / and ',
// Space and the arrows scrolling, an Alt release focusing the menu bar) must not run, whether or not the key has a binding. Not
// for Ctrl or Meta chords outside fullscreen (reload, devtools, find, save stay the browser's); in fullscreen the Keyboard Lock
// delivers them (lockGameKeys). Keys no page can take are in docs/input-bindings.md.
const GAME_KEYS = new Set(GAME_KEY_CODES);
function gameTakesKey(event) {
  return GAME_KEYS.has(event.code) && !((event.ctrlKey || event.metaKey) && !document.fullscreenElement);
}
// TranslateMessage posts a key's WM_CHAR/WM_SYSCHAR units after its
// WM_KEYDOWN; WinDrv hands them to Client->Engine->Key
// (docs/script-window-typed-keys.md).
function typeCharacters(event) {
  for (const char of typedCharacters(event)) {
    try { simInput.char(char); }
    catch (error) {
      if (error?.name === 'UnsupportedConsoleCommandError' && !error.partial) { toast(`${event.key}: ${error.message}`); continue; }
      pauseForRuntimeError(error);
      return;
    }
  }
}
document.addEventListener('keydown', event => {
  if (escapeAlreadyHanded(event)) return;
  // Intercept before the original key/character paths (C is TurnRight).
  // A held shortcut consumes repeats and its release even if Alt lifts first.
  const editing = event.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  // The Saves window's keys (Tab, Enter, Escape) are the page's, never the game's. Alt+S and Alt+C are page shortcuts of the debugging
  // page only: on the default start Alt is the original's Strafe, so Alt+S and Alt+C are game input (the page buttons replace them).
  if (event.target.closest?.('#saves-dialog')) return;
  if (!originalStart && event.code === 'KeyS' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat && !event.isComposing && !editing) {
    event.preventDefault(); savesUi.open(); return;
  }
  if (event.code === 'KeyC' && (crtShortcutHeld || (!originalStart && !event.repeat && event.altKey && !event.ctrlKey && !event.metaKey
      && !event.isComposing && !editing))) {
    event.preventDefault();
    if (!event.repeat && !crtShortcutHeld) {
      if (event.shiftKey) {
        const shaders = Object.keys(CRT_PRESETS);
        setCrtShader(shaders[(shaders.indexOf($('crt-shader').value) + 1) % shaders.length]);
      } else setCrt(!crtEnabled, true);
    }
    crtShortcutHeld = true;
    return;
  }
  if (toggleFullscreenKey(event)) return;
  const input = inputKey(event, true);
  if (input && !runtimeError) typeCharacters(event);
  if (input) {
    if (gameTakesKey(event)) event.preventDefault();
    if (input.consumed) { keys.clear(); event.preventDefault(); return; }
    if (input.handled) {
      event.preventDefault(); paused = false;
      if(currentMap === '00_Training') activateInfoLinkAudio().catch(error => pauseForRuntimeError(error));
    }
    return;
  } else if (event.code === 'Escape') { releasePointer(); keys.clear(); drag = false; return; }
  if (!world || loading || /INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) return;
  if (['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight','Space','ControlLeft','ControlRight'].includes(event.code)) {
    if(mode==='play'&&runtimeError){event.preventDefault();return;}
    if(mode==='play'&&currentMap==='00_Training')activateInfoLinkAudio().catch(()=>{});
    paused = false;
    keys.add(event.code); event.preventDefault();
  }
});
document.addEventListener('pointerlockchange', () => { drag = false; keys.clear(); simInput.reset(); });
// The user's Escape under the pointer lock (the original start; the debugging page's double-click lock is its own). Out of a fullscreen
// whose Keyboard Lock holds it, the browser takes that press to release the lock and the page never sees the key (Chromium on Linux and
// macOS), so the game's Escape (Escape=ShowMainMenu in the world, a
// menu's own Escape) took a second press. The original's viewport gets every Escape (WinDrv's window procedure answers WM_KEYDOWN
// itself), so a lock the page did not release (releasePointer), lost while the page keeps the focus, its visibility and its fullscreen
// state, hands the game the Escape the browser took (handEscape): the page's own keydown and keyup paths run with it, the binding and
// its WM_CHAR 0x1b included, ESCAPE_WAIT_MS after the loss. A real Escape press around the loss (a browser that delivers the key, a
// held Escape leaving a Keyboard Lock's fullscreen) stands for it; the browser's own press or release of the handed Escape, when it
// comes after it, is dropped.
const ESCAPE_WAIT_MS = 50, ESCAPE_NEAR_MS = 250, PROMPT_NEAR_MS = 1000;
function releasePointer() { if (document.pointerLockElement) pageReleasedLock = true; document.exitPointerLock?.(); }
function handEscape() {
  handingEscape = true;
  try {
    for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }));
  } finally { handingEscape = false; }
  escapeHanded = performance.now(); handedEscapeRelease = true;
  // The menu's cursor at the picture's centre (the user's choice, 2026-10-30): the original leaves the root's cursor where it last was,
  // anywhere (an edge the cursor's image is drawn past included), and the free pointer moves it only once it is over the picture.
  // A window that holds the mouse after the Escape takes it (the root's pointer sample answers nothing otherwise).
  if (mode === 'play' && game && !runtimeError) {
    try { simInput.pointer({ relative: false, x: renderer.domElement.width / 2, y: renderer.domElement.height / 2 }); }
    catch (error) { pauseForRuntimeError(error); }
  }
}
document.addEventListener('fullscreenchange', () => { fullscreenChanged = performance.now(); });
document.addEventListener('pointerlockchange', () => {
  clearTimeout(lockLostTimer); lockLostTimer = null;
  const byPage = pageReleasedLock; pageReleasedLock = false;
  if (document.pointerLockElement || byPage || !originalStart) return;
  const lost = lockLostAt = performance.now();
  lockLostTimer = setTimeout(() => {
    lockLostTimer = null;
    if (escapeSeen > lost - ESCAPE_NEAR_MS || fullscreenChanged > lost - ESCAPE_NEAR_MS || document.pointerLockElement) return;
    if (lost - persistAsked < PROMPT_NEAR_MS) return;
    if (mode !== 'play' || !game || runtimeError || loading || document.hidden || !document.hasFocus() || document.querySelector('dialog[open]')) return;
    handEscape();
  }, ESCAPE_WAIT_MS);
});
/** A real Escape key event's part in the pointer lock's Escape: a press is noted (it stands for a lost lock's Escape); the browser's
 * press or release of an Escape handed (or about to be handed) to the game is dropped (true). */
function escapeAlreadyHanded(event) {
  if (event.code !== 'Escape' || handingEscape) return false;
  if (event.type === 'keydown') {
    if (!event.repeat) escapeSeen = performance.now();
    if (performance.now() - escapeHanded < ESCAPE_NEAR_MS) { event.preventDefault(); return true; }
    handedEscapeRelease = false;
    return false;
  }
  // (the release of the press the browser took, before the game is handed it)
  if (lockLostTimer !== null && escapeSeen < lockLostAt) { event.preventDefault(); return true; }
  if (!handedEscapeRelease) return false;
  handedEscapeRelease = false; event.preventDefault();
  return true;
}
// The mouse wheel is WinDrv's WM_MOUSEWHEEL (docs/input-bindings.md): one message per notch, and the world's NextBeltItem and
// PrevBeltItem or a window's scroll area answer it. The wheel of the canvas (or of the locked pointer) belongs to the game; the
// debugging page's panels keep theirs. A non-passive listener, so that Ctrl+wheel does not zoom the page.
const wheelNotches = createWheelAccumulator();
document.addEventListener('wheel', event => {
  const scene = $('scene');
  if (event.target !== scene && document.pointerLockElement !== scene) return;
  if (mode !== 'play' || !game || runtimeError || !world || loading) return;
  event.preventDefault();
  try { for (const notch of wheelNotches.push(wheelUnits(event, { gecko: geckoPage }), event.timeStamp)) simInput.wheel(notch); }
  catch (error) { pauseForRuntimeError(error); }
}, { passive: false });
document.addEventListener('keyup', event => {
  if (escapeAlreadyHanded(event)) return;
  if (event.target.closest?.('#saves-dialog') || (!originalStart && event.code === 'KeyS' && event.altKey)) return;
  if (event.code === 'KeyC' && crtShortcutHeld) { crtShortcutHeld = false; event.preventDefault(); return; }
  const input = inputKey(event, false);
  if (input?.consumed || (input?.handled && !input.host) || (input && gameTakesKey(event))) event.preventDefault();
  keys.delete(event.code);
});
// A lost focus lets go of what the player held (no key release reaches the page any more) and the game goes on: the user's choice,
// 2026-10-30 (no pause and no click to resume; what the original does on a lost focus is not measured here). A hidden page draws no
// frame and runs no tick; its first frame back takes an ordinary step (resumeClock), not the time it was hidden.
window.addEventListener('blur', () => { keys.clear(); crtShortcutHeld = false; drag = false; simInput.reset({releasePhysical:true}); });
document.addEventListener('visibilitychange', () => { keys.clear(); if (document.hidden) simInput.reset({releasePhysical:true}); else resumeClock = true; });
// Graphics context loss (docs/context-loss.md). D3DDrv's Lock tests the device every frame, sleeps while it is unavailable and rebuilds it
// with SetRes (0x1000323f..0x10003314): the game thread does nothing meanwhile, and the next tick's delta holds the whole wait. Here a lost
// context stops the simulation (animate posts and ticks nothing, and the clocks keep the last frame's time), and once three.js has made its
// new GL state, restoreGraphics rebuilds what three.js does not manage before the simulation runs again.
const graphics = { lost: false, pending: false, restoring: false, losses: 0, restores: 0, converted: 0, lastRestore: null, held: [], drawnLost: 0 };
const GRAPHICS_LOST = 'The browser lost the graphics device: the game waits for it. Reload the page if it does not come back.';
renderer.domElement.addEventListener('webglcontextlost', () => {
  graphics.lost = true; graphics.pending = false; graphics.losses++; graphics.drawnLost = 0; gpuTimer = null;
  $('toast').textContent = GRAPHICS_LOST;
});
// (three.js's own listener, added when the renderer was made, runs first; during a load, animate starts the rebuild once it is done)
renderer.domElement.addEventListener('webglcontextrestored', () => {
  graphics.lost = false; graphics.pending = true;
  if (world && !loading) void restoreGraphics();
});
async function restoreGraphics() {
  graphics.pending = false; graphics.restoring = true;
  const started = performance.now();
  try {
    gpuMesh?.restore(); weaponGpu?.restore();
    frameKeeper.reset(); gpuTimer = null;
    // A snapshot simulated before the loss that arrived after the restore is applied now, before the conversions.
    let inFlight = 0;
    if (simClient) { await simClient.settled(); for (let snap; (snap = graphics.held.shift() ?? simClient.take()); inFlight++) drawFrame(snap, performance.now()); }
    // The bindings whose cache poses the GPU held take the CPU path, in the simulation side's order, before any later frame's records.
    const reason = 'the WebGL context was lost', none = { actors: [], weapon: [] };
    const records = !gpuMesh && !weaponGpu ? none : simClient ? await simClient.call('leaveGpu', { reason }) : simHost?.leaveGpu?.(reason) ?? none;
    npcPreview?.draw.leaveGpu(records.actors); weaponDraw?.leaveGpu(records.weapon);
    const converted = records.actors.length + records.weapon.length;
    // The level's shader programs again: three.js's program cache went with the old context.
    const warming = levelWarmup(world, gpuMesh);
    if (warming) await warming.finish();
    graphics.converted += converted; graphics.restores++;
    // `drawnLost`: snapshots applied while the context was lost; `inFlight`: those applied by this restore
    graphics.lastRestore = { converted, drawnLost: graphics.drawnLost, inFlight, ms: Math.round(performance.now() - started) };
    if ($('toast').textContent === GRAPHICS_LOST) $('toast').textContent = '';
  } catch (error) { pauseForRuntimeError(new Error(`The graphics device came back, but restoring it failed: ${error.message}`)); }
  finally { graphics.restoring = false; }
}
function status() {
  return {
    storage: configPersistence ? { ...configPersistence.status() } : null, saves: savePersistence ? savePersistence.status() : null,
    ready: Boolean(world) && !loading, map: currentMap ?? null, revision,
    textures: world?.textures ?? 0, renderErrors: world?.errors ?? [], triangles: world?.counts.triangles ?? 0,
    movers: world?.counts.movers ?? 0, position: fromView(camera.position.toArray()),
    mode, paused, runtimeError, gameplay: simClient ? simStatus?.gameplay ?? null : game?.status() ?? null, sim: simMode,
    galaxy:{...galaxyAudio,voices:galaxyVoices.size},music:musicStatus(),
    audio:{...speechDecode,contextState:infoLinkAudioContext?.state??'uninitialized'},
    npcPreview:npcPreview?{...npcPreview.summary,visible:npcPreview.root.visible}:null,
    weaponViewModel:weaponSummary,
    lighting: world?.lighting ?? null, lightingEnabled: Boolean(world?.lightingEnabled.value), horizontalFOV: 75,
    mirrors: world ? { ...world.mirrors.stats } : null,
    brightness: Number($('brightness').value), displayGamma: world?.displayGamma.value ?? null,
    crt: crtEnabled, crtShader, crtCompare,
    rotation: [pitch, yaw], wireframe: $('wireframe').checked, actorMarkers: $('actor-markers').checked, cameraMoved,
    calls: renderer.info.render.calls, frame: renderer.info.render.frame, shaderWarmup: shaderWarmupResult,
    graphics: { lost: graphics.lost || graphics.pending || graphics.restoring, losses: graphics.losses, restores: graphics.restores,
      converted: graphics.converted, lastRestore: graphics.lastRestore, renderer: rendererName(), meshPath: !world ? null : gpuMesh ? 'gpu' : 'cpu' },
    // the worker's silence (watchSimulation): `silent` once the posted frames heard nothing for SIM_SILENCE_MS
    simulation: simClient ? { silent: simSilent, silence: Math.round(simClient.silence()), outstanding: simClient.outstanding } : null,
  };
}
// A small read-only diagnostic hook also makes browser regressions reproducible.
window.deusExViewer = { status,
/** The last map load's steps (loadTimeline above): null before the first load. */
loadTimings: () => loadTimeline && structuredClone(loadTimeline),
/** The last loading frame drawn (docs/loading-frame.md): the level it was drawn in, the buffer size, the console's tiles and the flash. */
loadingFrame: () => lastLoadingFrame && structuredClone(lastLoadingFrame),
/** SaveCurrentLevel's PaintProgress frames drawn (docs/loading-frame.md "Saving"), oldest first: the level, the buffer size, the console's tiles, the flash,
 * and the page clock (ms) at which each was drawn and at which the next frame replaced it (null while it is on screen). */
savingFrames: () => structuredClone(savingFrames),
/** The page's save persistence (save-persistence.mjs) for the specs: its status, the listing read again, the Saves window. */
saves: { status: () => savePersistence?.status() ?? null, refresh: () => savePersistence?.refresh() ?? Promise.resolve(false), open: () => savesUi.open(), ready: () => savesReady.then(() => true),
  /** The stored directories and their files ({dir, files: [{name, size}]}) and one file's bytes (an array): what the specs read back of a save. */
  list: () => savePersistence ? savePersistence.directory.directories().map(dir => ({ dir, files: savePersistence.directory.files(dir) })) : [],
  read: async (dir, name) => { const bytes = await savePersistence?.directory.read(dir, name); return bytes ? Array.from(bytes) : null; } },
/** The page's procedural textures held at the original's state (procedural-textures.mjs `hold`): {kind, pixels: {name: hex}} or null. */
proceduralHold(spec) { return sharedProceduralTextures().hold(spec); },
/** The page's procedural textures: key, kind, size, GlobalPhase and a pixel checksum each. */
proceduralRecords() { return sharedProceduralTextures().records(); },
framePhases(reset = true) {
  const result = { ...framePhases, runtimeError: runtimeError?.message ?? null, paused };
  if (reset) for (const key of Object.keys(framePhases)) framePhases[key] = 0;
  return result;
},
/** Play's state digest (state-digest.mjs): every script property of every
 * Level.Actors entry, for comparing two runs of one scenario. */
release() { if (held) held = 'releasing'; },
/** ?sim=worker: resolves when no frame is in flight. */
settled() { return simClient?.settled() ?? Promise.resolve(); },
/** Galaxy's music, freshly read: the worklet's counters and the
 * simulation's library service (sent to the worker and back). */
async musicStatus() {
  const output = musicOutput ? await musicOutput.refresh() : null;
  return { ...musicStatus(output), library: simClient ? await simClient.call('musicStatus') : pageMusicLibrary?.status() ?? null };
},
/** Validation only (browser-tests/audio-resume.spec.mjs): the page's AudioContext state; `{op: 'suspend'}` first suspends it, as a
 * browser or the system would. */
async audioContextProbe({ op = 'state' } = {}) {
  if (op === 'suspend' && infoLinkAudioContext) await infoLinkAudioContext.suspend();
  return infoLinkAudioContext?.state ?? 'uninitialized';
},
/** Measurement (docs/audio-latency.md, scripts/audio-latency.mjs): the
 * effect starts' post times on the simulation side and the worklet's
 * arrival, render and play timing for the same batches, with the context's
 * latencies. */
async audioLatency() {
  const worklet = musicOutput ? await musicOutput.latency(infoLinkAudioContext) : null;
  const posts = simClient ? await simClient.call('musicLatency') : pageMusicLibrary?.latencyPosts() ?? null;
  return { mode: simClient ? 'worker' : 'inline', posts, worklet };
},
/** Validation only (galaxy-music-library.mjs driveMusicLibrary): Update's
 * library calls for a song and section, or `{unregister: true}`, issued by
 * the simulation side's library service. */
musicDrive(args) {
  if (simClient) return simClient.call('musicDrive', args);
  return driveMusicLibrary(pageMusicLibrary, assets, args);
},
/** Validation only: decal-probe.mjs on the simulation side. */
decalProbe(args) {
  if (simClient) return simClient.call('decalProbe', args);
  return game ? decalProbe(game, args) : null;
},
/** Validation only: decal-probe.mjs particleProbe (a ParticleGenerator's iterator state) on the simulation side. */
particleProbe(args) {
  if (simClient) return simClient.call('particleProbe', args);
  return game ? particleProbe(game, args) : null;
},
/** Validation only: view-probe.mjs (the original captures' camera commands)
 * on the simulation side. */
viewProbe(args) {
  if (simClient) return simClient.call('viewProbe', args);
  return game ? viewProbe(game, args) : null;
},
/** debug-loadout.mjs now (Tools ▸ Give loadout): {given, refused, augmentations}. */
loadout() { return game ? giveLoadoutNow() : null; },
/** Validation only: easter-sim.mjs (docs/easter-egg.md) on the simulation side: `{op: 'status'}` reads the ?easter=1 mod's actors;
 * `{op: 'frob', who}` does what a frob of one does. Nothing runs unless this is called. */
async easterProbe(args) {
  if (simClient) return simClient.call('easter', args);
  return game ? (await import('./easter-sim.mjs')).easterCall(game, args) : null;
},
/** Validation only: live-probe.mjs, the replay of an original trace on the live level
 * (scripts/live-acceptance.mjs, docs/visual-acceptance.md "Live scenes"). */
async liveProbe(args) {
  if (simClient) return simClient.call('liveProbe', args);
  return game ? (await import('./live-probe.mjs')).liveProbe(game, args) : null;
},
/** Validation only: settings-probe.mjs, one step of the original options menus on the
 * simulation side and the settings state it left (docs/script-native-config.md). */
async settingsProbe(step) {
  if (simClient) return simClient.call('settingsProbe', [step]);
  return game ? (await import('./settings-probe.mjs')).settingsProbe(game, step) : null;
},
/** Validation only: window-probe.mjs (the root window, focus text,
 * Console line and notes) on the simulation side. */
/** Validation: the pointer given back as the page gives it (releasePointer): the game is handed no Escape, so a test's absolute
 * moves and clicks reach a menu that stays open. A user's release is the browser's Escape rule (handEscape). */
releasePointer() { releasePointer(); },
/** Validation: a frozen frame. The simulation halts (the frame input's `run`) and the page keeps drawing the last snapshot, as a lost
 * focus did before 4bf5b4bd; `freeze(false)` goes on without catching up. The page's own controls never freeze. */
freeze(on = true) { paused = Boolean(on); if (!on) resumeClock = true; },
/** Validation only (scripts/session-hour.mjs): the page's asset store, the packages it holds loaded and their bytes, and its
 * released-package cache (with ?sim=worker the simulation's store is the worker's). */
assetsProbe() {
  if (!assets) return null;
  let bytes = 0;
  for (const value of assets.ready.values()) bytes += value.bytes.byteLength;
  return { ready: assets.ready.size, readyBytes: bytes, released: assets.released.size, releasedBytes: assets.releasedBytes };
},
/** Measurement only (scripts/map-memory-census.mjs): the simulation side's script process and asset store (process-probe.mjs). */
async processProbe() {
  if (simClient) return simClient.call('processProbe');
  return (await import('./process-probe.mjs')).processProbe(simHost?.scriptProcess, assets, simHost?.handleTables?.() ?? null);
},
async windowProbe() {
  if (simClient) return simClient.call('windowProbe');
  return game ? (await import('./window-probe.mjs')).windowProbe(game) : null;
},
/** Validation only: input-probe.mjs (the player's input flags, view, hand, weapon, belt, augmentations, windows and the binding lines run) on
 * the simulation side. */
async inputProbe(args) {
  if (simClient) return simClient.call('inputProbe', args);
  return game ? (await import('./input-probe.mjs')).inputProbe(game, args) : null;
},
/** Validation only: conversation-probe.mjs (ConPlay's state and event, the conversation camera and letterbox) on the
 * simulation side. */
async conversationProbe(args) {
  if (simClient) return simClient.call('conversationProbe', args);
  return game ? (await import('./conversation-probe.mjs')).conversationProbe(game, args) : null;
},
/** Validation only: mover-probe.mjs (the moving brush tracker's movers) on
 * the simulation side. */
/** Validation only: terminal-probe.mjs (place the player at a terminal, the
 * last HUD frame's ViewportWindow frames) on the simulation side, and the
 * page's camera passes of its last frame. */
async terminalProbe(args) {
  const value = simClient ? await simClient.call('terminalProbe', args)
    : game && sim ? (await import('./terminal-probe.mjs')).terminalProbe(game, sim, args) : null;
  return value && { ...value, page: viewportPassesDrawn.map(pass => ({ ...pass })) };
},
/** Validation only: the light-map Strobe lists and each frame's reach (sim-session.mjs strobeReach). */
strobeProbe(args) {
  if (simClient) return simClient.call('strobeProbe', args);
  return sim ? sim.strobeReach(args) : null;
},
/** Validation only: the render iterators' per-frame runs (sim-session.mjs iteratorState). */
iteratorProbe(args) {
  if (simClient) return simClient.call('iteratorProbe', args);
  return sim ? sim.iteratorState(args) : null;
},
/** Validation only (validate-mover-vertices-play.mjs): the mover meshes' `deusTracked` vertices against the tracker's
 * points (`moverProbe({ points: true })` movers: name, revision, points) and, as a bound on the vertex order, against the
 * group matrix's product with the rest positions. */
moverVertexProbe(movers) { return world.moverVertices(movers); },
/** Validation: false poses the movers' vertices from their group matrices (the behaviour before the tracker's points). */
moverVertices(on) { world.useTrackerVertices(on); },
async moverProbe(args) {
  if (simClient) return simClient.call('moverProbe', args);
  return game && sim ? (await import('./mover-probe.mjs')).moverProbe(game, sim, args) : null;
},
/** Validation only: decal-probe.mjs renderPassProbe (the weapon placed by
 * RenderOverlays and the HUD scene frame) on the simulation side. */
renderPassProbe(args) {
  if (simClient) return simClient.call('renderPassProbe', args);
  return game ? renderPassProbe(game, args) : null;
},
async moverDecalProbe(args) {
  if (simClient) return simClient.call('moverDecalProbe', args);
  return game && sim ? (await import('./mover-probe.mjs')).moverDecalProbe(game, sim, args) : null;
},
/** Validation only: decal-probe.mjs meshLightProbe (one actor's mesh light
 * setups) on the simulation side. */
meshLightProbe(args) {
  if (simClient) return simClient.call('meshLightProbe', args);
  return game ? meshLightProbe(meshLighting, game, args) : null;
},
/** Validation only: decal-probe.mjs placeProbe (player location and view
 * rotation) on the simulation side. */
placeProbe(args) {
  if (simClient) return simClient.call('placeProbe', args);
  return game ? placeProbe(game, args) : null;
},
/** Validation only: decal-probe.mjs laserProbe on the simulation side. */
laserProbe() {
  if (simClient) return simClient.call('laserProbe');
  return game ? laserProbe(game, simHost?.actorSim) : null;
},
/** Validation only: lod-probe.mjs (the actor mesh layer's DrawLodMesh LOD
 * state) on the simulation side. */
async lodProbe(args) {
  if (simClient) return simClient.call('lodProbe', args);
  return (await import('./lod-probe.mjs')).lodProbe(simHost?.actorSim, args, simHost?.weaponSim);
},
/** Validation only: what the page's actor mesh layer draws under the LOD,
 * per binding id (actor-mesh-draw.mjs lodStats). */
meshLod() {
  const draw = npcPreview?.draw;
  return draw ? [...draw.bindings.values()].map(binding => binding.lodStats()) : null;
},
/** Validation only: a digest of what the page's actor mesh layer holds for every binding (actor-mesh-draw.mjs drawState). */
async meshDrawDigest() {
  const state = npcPreview?.draw.drawState();
  if (state === undefined) return null;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
},
/** Validation only: the actor mesh layer's passes record what each binding
 * has drawn in them (actor-mesh-draw.mjs setPassProbe); with no argument the
 * records so far are returned and cleared. */
meshPassProbe(on) {
  const draw = npcPreview?.draw;
  if (!draw) return null;
  if (on !== undefined) { draw.setPassProbe(on); return null; }
  return draw.takePassProbe();
},
/** The page's fog pass (fog-pass.mjs): its last frame's counters and the
 * fog meshes it drew. */
fog() {
  const fog = world?.fog;
  return fog ? { stats: { ...fog.stats }, visibleMeshes: fog.root.children.filter(object => object.visible).length } : null;
},
/** The moving lights' composition (moving-lights.mjs): the body that composes (rust, js or verify) and its counters. */
movingLights() { return world ? world.movingLightStats() : null; },
// Each fog page's GPU texture read back against its pixels (fog-pass.mjs pagesMatch): the texels that differ.
fogPages() { return world?.fog ? world.fog.pagesMatch(renderer) : null; },
/** Validation only: the 3D view's projection from the pass frame (on, the
 * default) or from the FOV and the constant pixel centre (off). */
frameProjection(on) { frameProjection = Boolean(on); },
/** Validation only: hold the clock the surface textures animate at (on: the last frame's; off: the frame's own again). */
holdTextureClock(on) { heldTextureClock = on ? textureClock ?? null : null; },
/** Validation only: the vertex stage of the frame's projection (on, the
 * default) or the camera's matrices (off). */
vertexProjection(on) { if (on === undefined) return vertexProjection.state(); vertexProjection.enabled = Boolean(on); return null; },
/** Validation only: sprites as the original's tiles (on, the default) or as camera billboards (off). */
spriteTiles(on) { vertexProjection.spriteTiles(Boolean(on)); },
/** Validation only: draw (or leave out) the decal block in a ViewportWindow's frames. */
viewportDecals(on) { viewportDecalsOn = Boolean(on); },
/** Show or hide the fog pass (validation: a frame with and without it). */
showFog(on) { if (world?.fog) world.fog.root.visible = Boolean(on); },
/** Validation only: where the fog pass draws, 'surface' (the default: after its surface's detail fans, before the decals and
 * every translucent or modulated item, as DrawComplexSurface and DrawFrame order it) or 'last' (after every other world item, the
 * order before 2026-10-28). */
fogOrder(order) { world?.fog?.setLast(order === 'last'); },
/** The page's corona pass (corona-pass.mjs): the last frame's counters,
 * and the simulation's last corona frame: its icons with the inputs of
 * their placement, the lights the helper was called for (in order), those
 * it passed (`seen`) and the master frame's words they were placed in. */
coronas() { return coronaPass ? { ...coronaPass.stats, icons: lastCoronaScan?.icons ?? null, visited: lastCoronaScan?.visited ?? null,
  seen: lastCoronaScan?.seen ?? null, frameWords: lastCoronaScan?.frameWords ?? null } : null; },
/** Draw or skip the corona pass (validation: a frame with and without it). */
showCoronas(on) {
  if (!coronaPass) return;
  if (!on && !coronaPass.__render) { coronaPass.__render = coronaPass.render; coronaPass.render = () => {}; }
  else if (on && coronaPass.__render) { coronaPass.render = coronaPass.__render; delete coronaPass.__render; }
},
/** The last drawn frame's decal fragments (decal-draw.mjs, decal-scene.mjs):
 * per texture the triangles the simulation clipped, and those drawn. */
decals(options) {
  // {hide} hides or shows the decal layer (a frame with and without it: visual-acceptance.mjs play --base decal)
  if (options && decalScene && options.hide !== undefined) decalScene.root.visible = !options.hide;
  return { groups: (lastVisibility?.decals ?? []).map(group => ({ texture: group.texture.key, triangles: group.positions.length / 9 })),
    drawnTriangles: decalScene?.count() ?? null, notes: [...(decalScene?.notes ?? [])] };
},
/** The last drawn frame's detail-texture fans (detail-draw.mjs, detail-scene.mjs): the pack's frames, the page's meshes (frame,
 * triangles) and the triangles drawn; `bias` {factor, units, depth} sets the depth offset of the fans (polygon offset and a constant),
 * {hide} hides or shows the pass (a frame with and without it). */
detail(bias) {
  if (bias && detailScene && bias.units !== undefined) detailScene.setBias(bias.factor ?? 0, bias.units, bias.depth ?? 0);
  if (bias && detailScene && bias.hide !== undefined) detailScene.root.visible = !bias.hide;
  return { on: Boolean(detailScene), frames: lastVisibility?.detail ? unpackDetail(lastVisibility.detail).map(entry => ({ index: entry.index, words: entry.words.length })) : [],
    meshes: detailScene?.meshes() ?? [], drawnTriangles: detailScene?.count() ?? null, notes: [...(detailScene?.notes ?? [])] };
},
/** The last drawn frame's OccludeBsp result (sim-session.mjs visibility):
 * node count, mirror requests, sky, the world triangles it kept and the
 * master frame's words with the view, viewport and render rectangle that
 * made them. */
visibility() {
  return lastVisibility ? { nodes: lastVisibility.nodes.length, zone: lastVisibility.zone, mirrors: [...lastVisibility.mirrors],
    sky: lastVisibility.sky, triangles: world?.visibility?.stats.drawnTriangles ?? null, master: lastVisibility.master ?? null,
    // `active`: the group draws its reflected child this frame (not its own
    // surface); `frames` OccludeFrame's mirror and sky frames with the requests
    // merged into each (validate-underworld-panes-play.mjs).
    groups: world?.mirrors.groups().map(group => ({ key: group.key, moving: Boolean(group.moving), active: Boolean(group.active.value) })) ?? [],
    frames: (lastVisibility.frames ?? []).map(f => ({ index: f.index, parent: f.parent, kind: f.kind, group: f.group, requests: f.requests, bounds: f.bounds })) } : null;
},
stateDigest() {
  if (mode !== 'play' || !game) return null;
  if (simClient) return simClient.call('stateDigest');
  const runtime = game.doors.scriptRuntime.runtime;
  return stateDigest(runtime, runtime.levelFor(game.player.collisionActor));
} };

// Host frame-phase timing (docs/play-frame-cost.md): wall-clock ms per animate()
// phase, read and reset by deusExViewer.framePhases(). Measurement only.
const framePhases = { frames: 0, tick: 0, lighting: 0, sprites: 0, actors: 0, lightAnimation: 0, textures: 0, lightUpload: 0,
  fog: 0, mirrors: 0, render: 0, coronas: 0, weapon: 0, hud: 0, ramp: 0, audio: 0, clone: 0, worker: 0, total: 0, draws: 0,
  mirrorCalls: 0, skyCalls: 0, mainCalls: 0, hudCalls: 0, gpu: 0, gpuFrames: 0, gpuDisjoint: 0, gpuSupported: 0 };
// ?hitchlog=1 (hitch-log.mjs, docs/hitch-log.md): the opt-in frame-hitch recorder.
const hitch = hitchEnabled ? createHitchLog() : null;
hitch?.attach({ renderer, framePhases, threeRevision: THREE.REVISION, client: () => simClient,
  status: () => ({ map: currentMap ?? null, paused, error: Boolean(runtimeError), position: world ? fromView(camera.position.toArray()).map(Math.round) : null }),
  music: () => { try { return musicOutput?.status()?.worklet ?? null; } catch { return null; } } });
const drawCalls = () => renderer.info.render.calls;
let phaseMark = 0;
const phase = name => { const now = performance.now(); framePhases[name] += now - phaseMark; phaseMark = now; };
// GPU time per frame (?gpuTimer=1): a TIME_ELAPSED query spans the actor
// mesh passes, mirrors, sky, main scene, weapon and HUD draws. Results arrive asynchronously, so
// finished queries are collected at the next frame's start; a GPU_DISJOINT
// report discards the pending ones. `gpu` sums milliseconds over `gpuFrames`
// frames with a result; `gpuSupported` counts frames where the extension
// exists. Measurement only, off unless the URL flag is set.
let gpuTimer = null;
function gpuBegin() {
  if (!gpuTimerParam) return;
  if (gpuTimer === null) {
    const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    gpuTimer = ext ? { gl, ext, pending: [], active: null } : false;
  }
  if (!gpuTimer) return;
  framePhases.gpuSupported++;
  const { gl, ext, pending } = gpuTimer;
  const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
  while (pending.length) {
    const query = pending[0];
    if (!disjoint && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
    pending.shift();
    if (disjoint) framePhases.gpuDisjoint++;
    else { framePhases.gpu += gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6; framePhases.gpuFrames++; }
    gl.deleteQuery(query);
  }
  gpuTimer.active = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, gpuTimer.active);
}
function gpuEnd() {
  if (!gpuTimer?.active) return;
  gpuTimer.gl.endQuery(gpuTimer.ext.TIME_ELAPSED_EXT);
  gpuTimer.pending.push(gpuTimer.active);
  gpuTimer.active = null;
}
/** A simulation frame's input from the page's state at `time` (the page
 * clock, ms), without its dt. */
function simFrameInput(time) {
  const playing = mode === 'play' && Boolean(game), toUnits = radians => Math.round(radians * 32768 / Math.PI);
  return { play: playing, run: !paused && !document.hidden, halted: Boolean(runtimeError),
    size: [renderer.domElement.width, renderer.domElement.height], aspect: canvasAspect, resizes: resizeCount,
    seconds: time / 1000, mirrors: world.mirrors.enabled, pixelRatio: renderer.getPixelRatio(), now: performance.now() / 1000,
    inspect: playing ? null : { camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
      ...projectionState(camera) },
      view: { location: fromView(camera.position.toArray()), rotation: [toUnits(pitch), toUnits(-yaw), 0] },
      sky: world.sky ? { location: [...world.sky], rotation: [...(world.skyRotation ?? [0, 0, 0])] } : null } };
}
/** ?sim=worker: posts a frame; its dt is the page time since the last post
 * (the worker sums the dts of the posts it merges). */
function postSimFrame(time) {
  if (!simClient || !sim || !world || loading || held) return false;
  const first = preTickPending; preTickPending = false;
  const dt = first ? 0 : Math.max(0, (time - (simLastPost ?? time - 1000 / 60)) / 1000);
  simClient.post({ ...simFrameInput(time), dt, ...(first ? { preTicked: true } : {}) }, { status: !simStatus || simPosts % 15 === 0 });
  simLastPost = time; simPosts++;
  return true;
}
/** One simulation frame (sim-session.mjs frame); ?sim=clone sends the input
 * and the snapshot through structuredClone (`clone` phase). */
function simFrame(input) {
  if (simMode !== 'clone') return sim.frame(input);
  let mark = performance.now();
  const sent = crossing(input);
  framePhases.clone += performance.now() - mark;
  const snapshot = sim.frame(sent);
  mark = performance.now();
  const received = crossing(snapshot);
  framePhases.clone += performance.now() - mark;
  return received;
}
function animate(time) {
  requestAnimationFrame(animate);
  if (exited) return;
  if (held === 'releasing') { held = false; lastTime = simLastPost = time - 1000 / 60; }
  if (resumeClock) { resumeClock = false; lastTime = time - 1000 / 60; if (simLastPost !== null) simLastPost = time - 1000 / 60; }
  if (held) { lastTime = time; return; }
  // A lost context (docs/context-loss.md): nothing is simulated, and lastTime and simLastPost keep the last frame's time, so the first frame
  // after the restore carries the whole wait in its dt. A snapshot simulated before the loss is applied as it arrives (its draws reach the
  // lost context, where they do nothing).
  if (graphics.lost || graphics.pending || graphics.restoring) {
    if (graphics.lost && simClient && !lockstep && world && !loading && !travelHeld) { const snap = simClient.take(); if (snap) drawFrame(snap, time); }
    if (graphics.pending && !loading) {
      if (world) void restoreGraphics();
      else { graphics.pending = false; if ($('toast').textContent === GRAPHICS_LOST) $('toast').textContent = ''; }
    }
    return;
  }
  const previousTime = lastTime, dt = Math.max(0, (time - lastTime) / 1000); lastTime = time;
  const frameStart = phaseMark = performance.now();
  if (world && !loading && !travelHeld) {
    const axis = (positive, negative) => positive.some(k => keys.has(k)) - negative.some(k => keys.has(k));
    const x = axis(['KeyD','ArrowRight'], ['KeyA','ArrowLeft']), z = axis(['KeyW','ArrowUp'], ['KeyS','ArrowDown']), y = axis(['KeyE'], ['KeyQ']);
    const playing = mode === 'play' && Boolean(game);
    if (!playing && (x || y || z)) {
      const forward = new THREE.Vector3(); camera.getWorldDirection(forward);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      velocity.copy(forward).multiplyScalar(z).addScaledVector(right, x); velocity.y += y;
      velocity.normalize().multiplyScalar(Math.min(dt, .05) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 900 : 240));
      camera.position.add(velocity); cameraMoved = true;
    }
    // The simulation frame (sim-session.mjs frame, docs/sim-worker.md): the
    // tick, PlayerCalcView, the render viewport, SetupDynamics' moving-light
    // scan, the mesh lighting frame, the sprite scan, the actor mesh layer,
    // the drawn set and its LastRenderTime stamps, the corona pass, the view
    // model and the HUD paint, in that order, in one call; drawFrame draws
    // its snapshot. Inspect sends the free camera; rendering neither chooses
    // an animation nor advances NPC time. ?sim=worker posts frame N+1 before
    // drawing snapshot N, so the worker simulates while the page draws; with
    // a frame still in flight the page posts none and its dt accumulates.
    let snap = null, draw = true;
    if (sim && simClient) {
      // Post this display frame's input first, so the worker simulates
      // while the page draws the oldest arrived snapshot.
      postSimFrame(time);
      watchSimulation();
      snap = lockstep ? null : simClient.take();
      draw = Boolean(snap);
    } else if (sim) {
      // (inline, a save's PaintProgress frame (onPaintProgress) is drawn in a display frame of its own, then the snapshot simulated with it; a
      // display frame that draws a queued one simulates nothing and its time goes to the next tick's dt)
      if (inlineFrames.length) lastTime = previousTime;
      else {
        const simulated = simFrame({ ...simFrameInput(time), dt });
        if (inlineFrames.length) inlineFrames.push(simulated); else snap = simulated;
      }
      if (inlineFrames.length) snap = inlineFrames.shift();
    }
    if (draw) drawFrame(snap, time);
    if (draw && loadTimeline && loadTimeline.firstDraw === null) loadTimeline.firstDraw = Math.round(performance.now() - loadTimeline.start);
  }
  framePhases.frames++; framePhases.total += performance.now() - frameStart;
  hitch?.frameEnd(time);
  if (time - fpsTime > 1000) { $('performance').textContent = world ? `${Math.round(frameCount * 1000 / (time - fpsTime))} fps` : ''; frameCount = 0; fpsTime = time; }
}
/** Draws one simulation snapshot (null: no simulation, Inspect over the
 * world alone). */
let lastVisibility = null, lastCoronaScan = null;
function drawFrame(snap, time) {
  // SaveCurrentLevel's PaintProgress frame, in order with the snapshots (sim-client.mjs 'paint', the inline queue)
  if (snap?.progress) { drawProgressFrame(snap.progress); return; }
  // Drawn frames: the fps counter's and framePhases' `draws` (with
  // ?sim=worker a display frame without a new snapshot draws nothing).
  framePhases.draws++; frameCount++;
  progressFrame.beginFrame(); drawnWorld = world;
  const shownSaving = savingFrames.at(-1);
  if (shownSaving && shownSaving.replacedAt === null) shownSaving.replacedAt = performance.now();
  // The HUD's tile commands arrive as numbers (script-window-command-stream.mjs); the list is made where it is drawn.
  if (snap?.hud?.stream) { snap.hud.commands = expandHudStream(snap.hud.stream); snap.hud.stream = null; }
  if (graphics.lost) graphics.drawnLost++;
  let playerView = null, renderRect = null;
  // A snapshot draws as the frame it was simulated for, whatever the page's
  // mode and canvas are now (with ?sim=worker it was posted a display frame
  // or more ago): a Play frame from its view, an Inspect frame from the
  // camera posted with it (its projection too), which the simulation side
  // planned its passes and culled with. The page's own camera returns after.
  const playing = (snap ? Boolean(snap.begin) : mode === 'play') && Boolean(game);
  const axis = (positive, negative) => positive.some(k => keys.has(k)) - negative.some(k => keys.has(k));
  const x = axis(['KeyD','ArrowRight'], ['KeyA','ArrowLeft']), z = axis(['KeyW','ArrowUp'], ['KeyS','ArrowDown']);
  const posted = simClient ? snap?.inspect?.camera ?? null : null;
  const live = posted || (simClient && playing && mode !== 'play') ? { position: camera.position.clone(), quaternion: camera.quaternion.clone(),
    projection: projectionState(camera), userData: { ...camera.userData }, pitch, yaw } : null;
  if (posted) {
    camera.position.fromArray(posted.position); camera.quaternion.fromArray(posted.quaternion);
    setProjectionState(camera, posted); camera.updateMatrixWorld();
  }
  if (snap) {
    hitch?.snapshot(snap);
    // The worker's audio since the last snapshot, as its callbacks ran
    // during the tick, then the frame's errors.
    for (const { kind, event } of snap.audio ?? []) if (kind === 'voice') void galaxyVoice(event);
    if (snap.display) applyDisplaySettings(snap.display);
    if (snap.answers) simAnswers = snap.answers;
    for (const message of snap.toasts ?? []) toast(message);
    if (snap.status) { simStatus = snap.status; if (npcPreview && snap.status.summary) npcPreview.summary = snap.status.summary; }
    for (const error of snap.errors) pauseForRuntimeError(error);
    // UGameEngine::Tick's travel step browsed to another level (sim-session.mjs): load it with the travel text
    if (snap.begin?.travel && !loading) travelTo(snap.begin.travel);
    // The worker's step times are its own thread's (`worker`); on the page
    // they belong to the frame's phases.
    for (const [name, ms] of Object.entries(snap.timings)) {
      if (!simClient) { framePhases[name] += ms; continue; }
      framePhases.worker += ms; framePhases[`w.${name}`] = (framePhases[`w.${name}`] ?? 0) + ms;
    }
    phaseMark = performance.now();
    applySimEvents(snap.events, { world, actors: npcPreview, weapon: weaponDraw });
  }
  // The previous frame's pack words are done with: their buffer goes back to the worker for a later frame.
  if (frameWords && simClient) simClient.recycle(frameWords.u32.buffer);
  const frame = snap?.begin ?? null, words = frameWords = packViews(snap?.pack);
  if (playing && frame) {
    world.syncMovers(frame.movers);
    // The simulation side points its own camera the same way
    // (play-camera.mjs applyPlayFrame).
    renderRect = frame.renderRect;
    mainRect = renderRect?.render && renderRect.width > 0 && renderRect.height > 0 ? { x: renderRect.x, y: renderRect.y, width: renderRect.width, height: renderRect.height }
      : { x: 0, y: 0, width: renderer.domElement.width, height: renderer.domElement.height };
    if (frame.view) {
      playerView = frame.view;
      ({ pitch, yaw } = applyPlayFrame(camera, frame.view, renderRect, frameProjection ? frame.projection ?? null : null));
    }
    // The 3D view's pixel size: the render rect when it draws, else the canvas.
    const viewSize = renderRect?.render && renderRect.width > 0 && renderRect.height > 0
      ? [renderRect.width, renderRect.height] : [renderer.domElement.width, renderer.domElement.height];
    setPixelCentre(camera, ...viewSize);
    if (frame.light) world.beginLightFrame(frame.light);
    if (x || z || keys.has('Space') || keys.has('ControlLeft') || keys.has('ControlRight')) cameraMoved = true;
    // Host status only: the frob target's name and highlight are the
    // original HUD's FrobDisplayWindow.
    if (mode === 'play') $('play-hint').textContent = runtimeError?.travel ? `Map ended · travel to ${runtimeError.travel.url} stops here (Stage 6) · Player start replays`
    : runtimeError ? 'Play paused · Player start resets the scene' : '';
  }
  // The credit card follows the flight's view, hidden under any window the root draws (MenuMain over the flight)
  if (creditParam && snap) creditFrame(playing && frame?.view && currentMap === 'DX' && !snap.hud?.commands?.some(command => command.texture)
    ? frame.view.location[0] : null);
  phase('tick');
  // The GPU timer starts before the actor layer, whose mesh passes
  // (docs/gpu-mesh.md) are GPU work submitted during this phase.
  gpuBegin();
  // SetupDynamics' actor scan (sprites and render iterators) ran first on
  // the simulation side: a LaserProxy, spawned after its emitter, is drawn
  // as an actor where this frame's LaserIterator left it (docs/lasers.md).
  if (spriteScene) {
    if (snap?.sprites) {
      for (const note of snap.sprites.notes) spriteScene.notes.add(note);
      try { spriteScene.update(snap.sprites.sprites); } catch (error) { pauseForRuntimeError(error); }
      spriteScene.root.visible = true;
    } else spriteScene.root.visible = false;
  }
  phase('sprites');
  // The actor mesh layer's page half with the frame records.
  if (npcPreview && snap?.actors)
    try { npcPreview.draw.apply(snap.actors, fromView(camera.position.toArray()), words); } catch (error) { pauseForRuntimeError(error); }
  phase('actors');
  renderer.info.reset();
  let panInputs = null;
  if (playing && !runtimeError && frame?.pan) {
    const pan = frame.pan;
    panInputs = { timeSeconds: pan.timeSeconds, zoneSpeeds: name => pan.speeds[name] };
  }
  // Light-map animation skips light maps outside the view unless a mirror
  // may draw them.
  camera.updateMatrixWorld();
  // OccludeBsp's main frame (sim-session.mjs visibility, Play): the nodes
  // it draws, its mirror child requests and whether it made a sky frame.
  const visible = playing && !runtimeError ? frame?.visibility ?? null : null;
  lastVisibility = visible;
  // The brush tracker's vertices of the movers it rebuilt (sim-session.mjs attachMoverPoints), before any pass draws them.
  if (playing && frame?.visibility?.moverPoints) world.setMoverPoints(frame.visibility.moverPoints);
  const requested = visible ? new Set(visible.mirrors) : null;
  // OccludeFrame's child frames (sim-session.mjs visibility), with
  // ?childFrames on: each mirror and sky pass draws its own results.
  const frames = visible?.frames ?? null;
  const viewFrustum = (frames ? frames.some(f => f.parent === 0 && f.kind === 'mirror') : world.mirrors.mayRender(camera, requested))
    ? null : new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  // The surfaces OccludeBsp's main frame draws (with no mirror or sky child
  // frame, whose surfaces it does not list).
  const drawnSurfaces = visible ? new Set(Array.from(visible.nodes, node => world.nodeSurface[node])) : null;
  // With child frames, every frame's surfaces: exactly what any pass draws.
  let frameSurfaces = null;
  if (frames && drawnSurfaces) {
    frameSurfaces = new Set(drawnSurfaces);
    for (const f of frames) for (const node of f.nodes) frameSurfaces.add(world.nodeSurface[node]);
  }
  // A ViewportWindow's world frame draws later in the HUD
  // (viewportWorldPass): its OccludeBsp polygons' light maps are drawn too.
  // Without its polygons (no BSP occlusion) every light map is.
  const viewportPasses = snap?.hud?.commands?.filter(command => command.kind === 'viewport' && command.pass) ?? [];
  const viewportSurfaces = viewportPasses.every(command => command.pass.visibility)
    ? viewportPasses.flatMap(command => [command.pass.visibility.nodes, ...(command.pass.frames ?? []).map(frame => frame.nodes)]
      .flatMap(nodes => Array.from(nodes, node => world.nodeSurface[node]))) : null;
  let drawnLightMaps = frameSurfaces ?? (viewFrustum && visible && !visible.sky ? drawnSurfaces : null);
  if (drawnLightMaps && viewportPasses.length) drawnLightMaps = viewportSurfaces ? new Set([...drawnLightMaps, ...viewportSurfaces]) : null;
  // Without listed polygons, the light maps in the main frustum or a camera's.
  const lightFrustum = frameSurfaces && drawnLightMaps ? null
    : viewFrustum && viewportPasses.length ? [viewFrustum, ...viewportPasses.map(viewportFrustum)] : viewFrustum;
  // The time so far stays the light animation's; `lighting` is the movers' light-map rebuild.
  phase('lightAnimation');
  // SetupForSurf's static cache header for the movers' light maps (docs/static-lighting.md "Mover surfaces in
  // SetupForSurf"): the polygons every pass draws, on the brush tracker's facets (null without the tracker: every mover at
  // its brush matrix), before their moving lights.
  if (visible && moverRelight) {
    const passItems = pass => [pass.moverItems, ...(pass.frames ?? []).map(child => child.moverItems)];
    const lists = [visible, ...viewportPasses.map(command => command.pass.visibility).filter(Boolean)].flatMap(passItems);
    try { world.relightMovers(visible.moverItems ? lists.filter(Boolean).flat() : null); }
    catch (error) { pauseForRuntimeError(error); }
  }
  phase('lighting');
  // The frame's moving lights (docs/dynamic-lighting.md), on the drawn light
  // maps, before the texture animation that shares their light frame.
  if (playing && frame?.lights) {
    try { world.syncMovingLights(frame.lights, { frustum: lightFrustum, drawn: drawnLightMaps }); }
    catch (error) { pauseForRuntimeError(error); }
  }
  // The worker's snapshot animates textures at its frame's post time;
  // on the page the frame is now.
  textureClock = heldTextureClock ?? (simClient ? snap?.now : undefined) ?? performance.now() / 1000;
  world.updateTextureAnimation(textureClock,
    { ...panInputs, viewpoint: fromView(camera.position.toArray()), frustum: lightFrustum,
      drawn: drawnLightMaps, phase });
  world.flushLighting(renderer);
  phase('lightUpload');
  // Volumetric fog maps from this frame's eye and view rotation
  // (docs/volumetric-fog.md), and each child frame's from its own Coords.
  if ((world.fog?.stats.surfaces || world.fog?.stats.moverPolygons) && !runtimeError) {
    const toUnits = radians => Math.round(radians * 32768 / Math.PI);
    const fogView = playerView ?? snap?.inspect?.view ?? { location: fromView(camera.position.toArray()), rotation: [toUnits(pitch), toUnits(-yaw), 0] };
    try {
      world.fog.update(fogView, new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)),
        drawnSurfaces, { moverItems: visible?.moverItems ?? null, fogZone: world.fogZone, frames: childFog ? frames : null,
          nodeSurface: world.nodeSurface, renderer });
    } catch (error) { pauseForRuntimeError(error); }
  }
  phase('fog');
  const drawWorld = snap ? snap.drawWorld : true;
  // Render feedback (Render.dll 0x10b25150) was stamped on the simulation
  // side (sim-session.mjs stamps, drawn-set.mjs), which hands the actor
  // layer's decision for each mirror pass to its page half; the corona
  // pass and the view model ran after it. The view model's records and GPU
  // passes are applied now, before the world's draws.
  const stampFrame = snap?.stamps ?? null, coronaFrame = snap?.coronas ?? null, weaponFrame = snap?.weapon ?? null;
  if (weaponFrame && weaponDraw) {
    weaponSummary = weaponFrame.summary;
    try { weaponDraw.prepare(weaponFrame, fromView(camera.position.toArray()), words); } catch (error) { pauseForRuntimeError(error); }
  }
  phase('weapon');
  if (simVerify) for (const set of Object.values(drew)) set.clear();
  // The detail-texture pass' fans (sim-session.mjs visibility): every frame's, shown by the pass that draws it.
  // A surface with a fog map takes no detail texture (DrawComplexSurface clears it): the fog pass' maps of this update say which.
  // `rows`: the frame's rows of pixel centres (an edge on one is drawn by D3D's tie rule, detail-scene.mjs FILL_TIE_Y).
  const detailRows = renderRect?.render && renderRect.height > 0 ? [renderRect.y, renderRect.y + renderRect.height - 1] : [0, renderer.domElement.height - 1];
  try { detailScene?.update(visible?.detail ?? null, world.fog ? (index, surface) => world.fog.fogged(index)?.has(surface) ?? false : null, detailRows); }
  catch (error) { pauseForRuntimeError(error); }
  const { framePass, drawSkyFrame, updateActors } = framePassHelpers(frames, stampFrame, record => spriteScene?.framePass(record.index));
  world.mirrors.render(renderer, scene, camera, { markers: world.markers, sky: world.sky, requested,
    frames, rect: frames ? (renderRect ?? null) : null, framePass, skyIn: frames ? drawSkyFrame : null, updateActors, plan: stampFrame?.plan ?? null });
  phase('mirrors');
  let calls = drawCalls(); framePhases.mirrorCalls += calls;
  // A Play frame clears as the original's: UGameEngine::Draw locks the viewport with LOCKR_ClearScreen on every frame (Engine `or al, 1` at
  // 0x1038f557) and ScreenClear (0,0,0,0) (0x1038f564..0x1038f56c), and D3DDrv's Lock (0x10002fb0) clears target and Z (flags 3) to that
  // colour, each component v * 256 - 0.5 rounded and clamped: black, which the ramp keeps (docs/screen-flash.md "The screen clear"). An Inspect
  // frame keeps the page's colour; the ramp pass maps the raw clear colour back to it.
  renderer.setClearColor(playing ? screenClear : displayRamp ? displayRamp.rawClear(canvasClear, world.displayGamma.value) : canvasClear, 1); renderer.clear();
  const clipped = drawWorld && renderRect && (renderRect.x || renderRect.y
    || renderRect.width !== renderer.domElement.width || renderRect.height !== renderer.domElement.height);
  if (clipped) {
    const box = renderViewportFor(renderRect);
    renderer.setViewport(...box); renderer.setScissor(...box); renderer.setScissorTest(true);
  }
  const sky = drawWorld ? skyFrame(frame) : null;
  const rootSky = frames?.find(f => f.parent === 0 && f.kind === 'sky') ?? null;
  if (sky) {
    drawRootSky(camera, sky, rootSky, stampFrame, framePass);
    framePhases.skyCalls += drawCalls() - calls; calls = drawCalls();
  }
  // The decal block's fragments for this frame (sim-session.mjs visibility).
  decalScene?.update(visible?.decals ?? null);
  if (drawWorld) {
    // The main frame draws only the polygons OccludeBsp kept (world-visibility.mjs).
    if (visible) world.visibility.select(visible.nodes, visible.movers ?? null);
    spriteScene?.mainPass(true); detailScene?.mainPass(true);
    useFrameProjection(playing && !runtimeError ? frame?.projection : null);
    try { renderer.render(scene, camera); } finally { world.visibility.all(); spriteScene?.mainPass(false); detailScene?.mainPass(false); vertexProjection.off(); }
  }
  if (simVerify && !simClient && stampFrame) {
    const problem = sim.verifyStamps(drew, { built: id => Boolean(npcPreview?.draw.bindings.get(id)?.ready),
      skipped: spriteScene?.skipped });
    if (problem) pauseForRuntimeError(new Error(`simVerify: drawn sets differ: ${problem}`));
  }
  phase('render');
  // Coronas close DrawFrame, before PostRender's weapon and HUD.
  if (coronaFrame && coronaPass) {
    lastCoronaScan = coronaFrame.frame;
    // The tile DrawFrame hands the canvas projects in the master frame (docs/coronas.md "On the tile chain").
    useFrameProjection(playing && !runtimeError ? frame?.projection : null);
    try { coronaPass.update(coronaFrame.frame, coronaFrame.width, coronaFrame.height); coronaPass.render(renderer); }
    catch (error) { pauseForRuntimeError(error); }
    finally { vertexProjection.off(); }
  }
  phase('coronas');
  framePhases.mainCalls += drawCalls() - calls; calls = drawCalls();
  if (weaponFrame && weaponDraw) {
    // The view model draws in the master frame (Canvas.DrawActor, docs/script-weapon-rendering.md).
    useFrameProjection(playing && !runtimeError ? frame?.projection : null);
    try { weaponDraw.render(renderer, camera, weaponFrame); } catch (error) { pauseForRuntimeError(error); } finally { vertexProjection.off(); }
    if (simVerify && !simClient) {
      const problem = sim.verifyWeapon(drew.weapon, handle => weaponDraw.built(handle));
      if (problem) pauseForRuntimeError(new Error(`simVerify: drawn sets differ: ${problem}`));
    }
  }
  if (clipped) {
    const pr = renderer.getPixelRatio(), full = [0, 0, renderer.domElement.width / pr, renderer.domElement.height / pr];
    renderer.setViewport(...full); renderer.setScissor(...full); renderer.setScissorTest(false);
  }
  phase('weapon');
  if (snap?.hud && hudRenderer) {
    viewportPassesDrawn = [];
    hudRenderer.render(renderer, renderer.domElement.width, renderer.domElement.height, snap.hud.commands,
      { viewport: command => { try { viewportWorldPass(command); } catch (error) { pauseForRuntimeError(error); } },
        // GC.DrawActor (docs/gc-draw-actor.md): the actor's mesh in the master frame, between the tile batches, in the world's
        // viewport rectangle; GC.ClearZ clears the depth buffer there.
        actor: command => {
          if (!weaponDraw || !command.draw) return;
          if (clipped) { const box = renderViewportFor(renderRect); renderer.setViewport(...box); renderer.setScissor(...box); renderer.setScissorTest(true); }
          useFrameProjection(playing && !runtimeError ? frame?.projection : null);
          try { weaponDraw.hudActor(renderer, camera, command.draw, fromView(camera.position.toArray()), words); }
          catch (error) { pauseForRuntimeError(error); }
          finally {
            vertexProjection.off();
            if (clipped) { const pr = renderer.getPixelRatio(), full = [0, 0, renderer.domElement.width / pr, renderer.domElement.height / pr]; renderer.setViewport(...full); renderer.setScissor(...full); renderer.setScissorTest(false); }
          }
        },
        clearZ: () => renderer.clearDepth() });
    updateInfoLinkAccessibility(snap.hud.infoLink);
  }
  // UD3DRenderDevice::EndFlash follows the PostRenderFlash event that paints the HUD windows (docs/screen-flash.md).
  if (playing && !runtimeError && snap?.hud?.flash) {
    try { flashPass.render(renderer, snap.hud.flash, () => progressFrame.keepBeforeFlash(renderer)); } catch (error) { pauseForRuntimeError(error); }
  }
  // The console's PostRender event follows EndFlash (Draw 0x1038f772): the typed line and the console's messages (docs/console.md); on
  // LoadMap's PaintProgress frame, DrawLevelAction's LOADING (sim-session.mjs hud `progress`, docs/loading-frame.md), which is kept.
  if (playing && !runtimeError && snap?.hud?.console?.length && hudRenderer) {
    try { hudRenderer.render(renderer, renderer.domElement.width, renderer.domElement.height, snap.hud.console); } catch (error) { pauseForRuntimeError(error); }
    if (snap.hud.progress) lastLoadingFrame = { map: currentMap, width: renderer.domElement.width, height: renderer.domElement.height, tiles: snap.hud.console, flash: snap.hud.flash };
  }
  framePhases.hudCalls += drawCalls() - calls;
  phase('hud');
  if (displayRamp) displayRamp.apply(renderer, world.displayGamma.value, crtEnabled, crtShader, crtCompare);
  else if (crtEnabled) (crtMaterialRamp ??= createDisplayRamp()).apply(renderer, 1, true, crtShader, crtCompare);
  gpuEnd();
  phase('ramp');
  // (a frame drawn into a lost context is not kept: a save's snapshot waits for one drawn after the restore)
  if (keepingFrames && !graphics.lost) { frameKeeper.keep(); serveSaveSnapshots(); }
  $('crosshair').hidden=mode==='play'&&Boolean(hudRenderer);
  placePageButtons();
  if ($('inspect').checked && time - lastInspect > 150) {
    lastInspect = time; raycaster.setFromCamera(new THREE.Vector2(), camera);
    const hit = raycaster.intersectObjects(world.root.children, true).find(h => h.object.isMesh);
    const surface = hit && (hit.object.userData.faceMaterials?.[hit.faceIndex] ?? hit.object.material.userData);
    $('surface-info').textContent = hit ? `${surface.key}\n${surface.width} × ${surface.height} · ${surface.mipCount} mips\nSurface ${hit.object.userData.faces?.[hit.faceIndex] ?? '—'} · ${hit.object.userData.actor ?? hit.object.name ?? 'world'}\nFlags 0x${(surface.flags ?? 0).toString(16)}` : 'No surface under the crosshair.';
  }
  if (live) {
    camera.position.copy(live.position); camera.quaternion.copy(live.quaternion); setProjectionState(camera, live.projection);
    camera.userData = live.userData; ({ pitch, yaw } = live); camera.updateMatrixWorld();
  }
}
/** SaveCurrentLevel's PaintProgress frame (DeusEx 0x1000fd83, docs/loading-frame.md "Saving"): UGameEngine::Draw of the level as the save
 * finds it, which is the frame drawn last (progress-frame.mjs), with the flash PaintProgress swaps in (EndFlash's alpha 25) and the console's
 * DrawLevelAction SAVING after it, then the ramp. With ?sim=worker it is drawn while the worker saves and stays until the next snapshot, as the
 * original's stays through the save; inline the save has held this thread, and it is shown for one display frame after it (animate). It is not
 * kept for a save's picture (GenerateSnapshot read the frame before it). Not drawn without the last frame's colours at this buffer size (a
 * resize since, ?gamma=material) or the console's tiles for it. */
function drawProgressFrame(frame) {
  if (!world || drawnWorld !== world || !hudRenderer || !displayRamp || graphics.lost || runtimeError || mode !== 'play') return false;
  const width = renderer.domElement.width, height = renderer.domElement.height;
  if (frame.width !== width || frame.height !== height || !progressFrame.restore(renderer, displayRamp.rawFrame)) return false;
  framePhases.draws++; frameCount++;
  try {
    flashPass.render(renderer, frame.flash);
    hudRenderer.render(renderer, width, height, frame.console);
  } catch (error) { pauseForRuntimeError(error); }
  displayRamp.apply(renderer, world.displayGamma.value, crtEnabled, crtShader, crtCompare, { progress: true });
  const shown = savingFrames.at(-1);
  if (shown && shown.replacedAt === null) shown.replacedAt = performance.now();
  savingFrames.push({ map: currentMap, width, height, tiles: frame.console, flash: frame.flash, drawnAt: performance.now(), replacedAt: null });
  if (savingFrames.length > 8) savingFrames.shift();
  return true;
}
/** ?sim=worker in lockstep: a snapshot drawn as it arrives. */
function drawLockstep(snapshot) {
  if (!world || loading || travelHeld) return;
  // (between a context restore and its rebuild a snapshot waits for restoreGraphics)
  if (graphics.pending || graphics.restoring) { graphics.held.push(snapshot); return; }
  const frameStart = phaseMark = performance.now();
  drawFrame(snapshot, frameStart);
  framePhases.total += performance.now() - frameStart;
}
requestAnimationFrame(animate);

if (import.meta.env.DEV) {
  try {
    const manifest = await fetch('/__game__/manifest').then(r => r.json());
    if (manifest.files.length) await setFiles([...manifest.files.map(path => ({ path, url: `/__game__/file/${encodeURIComponent(path)}`, read: async () => {
      const response = await fetch(`/__game__/file/${encodeURIComponent(path)}`);
      if (!response.ok) throw new Error(`Cannot read ${path}`); return response.arrayBuffer();
    } })), ...(manifest.libraries ?? []).map(path => ({ path, read: async () => {
      throw new Error(`Native library bytes are not served: ${path}`);
    } }))]);
  } catch (error) { fail(error); }
}

const context = document.modelContext;
if (context?.registerTool) {
  const noArguments = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Expected an empty object');
  };
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const tools = [
    { name: 'read_map_status', title: 'Read map status', description: 'Read the loaded map, render diagnostics, and inspection camera position.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: input => { noArguments(input); return status(); } },
    { name: 'open_local_map', title: 'Open map', description: 'Open a map from the game folder already selected on this device.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: async input => {
        if (!input || typeof input.name !== 'string' || Object.keys(input).some(k => k !== 'name')) throw new Error('Expected a map name');
        return loadMap(input.name);
      } },
    { name: 'reset_inspection_camera', title: 'Return to player start', description: 'Return the inspection camera to the original player start in the loaded map.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: input => { noArguments(input); if (!world) throw new Error('No map loaded'); resetCamera(); return status(); } },
    { name: 'set_inspection_camera', title: 'Set reference camera', description: 'Set an inspection camera using original Unreal coordinates and rotator units for reference comparisons.',
      inputSchema: { type: 'object', properties: {
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      }, required: ['position', 'rotation'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: setCamera },
  ];
  for (const tool of tools) {
    try { await context.registerTool(tool, { signal: lifecycle.signal }); } catch { /* Optional browser capability. */ }
  }
}
