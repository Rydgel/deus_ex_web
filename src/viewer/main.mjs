import * as THREE from 'three';
import './style.css';
import { AssetStore } from '../unreal/assets.mjs';
import { readGlobalConfigBool, parseIniValue } from '../unreal/user-config.mjs';
import { decodeMap } from '../unreal/map.mjs';
import { toView, fromView } from '../unreal/geometry.mjs';
import { createWorld } from './world.mjs';
import { createSimHost } from './sim-host.mjs';
import { createSimClient } from './sim-client.mjs';
import { createPlayCamera, pointCamera, applyPlayFrame, verticalFov, rotatorEuler, setPixelCentre } from './play-camera.mjs';
import { createSpriteScene } from './sprite-scene.mjs';
import { createDecalScene } from './decal-scene.mjs';
import { decalProbe, placeProbe, laserProbe, meshLightProbe } from './decal-probe.mjs';
import { viewProbe } from './view-probe.mjs';
import { DECAL_LAYER } from './render-layers.mjs';
import { createCoronaPass } from './corona-pass.mjs';
import { TextureStore } from '../unreal/textures.mjs';
import { createHudRenderer } from './hud.mjs';
import { createActorMeshDraw } from './actor-mesh-draw.mjs';
import { bindingView } from './npc-mesh-preview.mjs';
import { createGpuMesh } from './gpu-mesh.mjs';
import { WEAPON_GPU_MESH_CAPACITIES } from './gpu-mesh-layout.mjs';
import { createWeaponOverlayDraw } from './weapon-overlay-draw.mjs';
import { packViews } from './mesh-frame-pack.mjs';
import {pointerButtonKey,windowPointerSample} from './window-pointer.mjs';
import { typedCharacters } from './typed-characters.mjs';
import {mp3SampleRate,pcm16} from '../runtime/galaxy-lipsync-channels.mjs';
import { setDisplayRampPerFragment } from './light-atlas.mjs';
import { createDisplayRamp } from './display-ramp.mjs';
import { stateDigest } from '../runtime/state-digest.mjs';
import { createMusicOutput } from './galaxy-music-output.mjs';
import { connectMusicLibraryPort, driveMusicLibrary } from '../runtime/galaxy-music-library.mjs';
import { msvcrtWtoi } from '../runtime/script-text-parser.mjs';

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
// (moving-lights.mjs); ?movingLights=full keeps the whole-frame recompute.
const movingLightsParam=new URLSearchParams(location.search).get('movingLights');
if(movingLightsParam)globalThis.DEUS_EX_MOVING_LIGHTS=movingLightsParam;
// The render scan (script-vm-render.mjs) filters Level.Actors in Rust for
// the moving lights, sprites, mesh admission and Galaxy's ambient scan;
// ?renderScan=js keeps the JavaScript loops, ?renderScan=verify checks every
// scan against them. The same js/verify switches: ?meshLight= for
// SetupForActor's light selection (script-vm-meshlight.mjs), ?cycleScan= for
// CycleActors (script-iterators.mjs) and ?levelScan= for the level loop's
// DistanceFromPlayer and compaction passes (level.rs), ?farMove= for the
// noncolliding FarMoveActor (render.rs far_move), ?particles= for
// execUpdateParticles (particles.rs), ?gcNative= for the HUD's GC state
// and tile natives (gc.rs, script-vm-gc.mjs), ?pawnPhysics=js for a
// walking pawn's performPhysics (pawn_phys.rs, pawn-physics-kernel.mjs) and
// ?actorPhysics=js for a falling non-Pawn's (fall.rs, actor-physics-kernel.mjs).
// ?moverTracker=off keeps movers out of the BSP (brush-tracker.mjs): drawn
// whole and frustum-stamped, as before the moving brush tracker.
// ?childFrames=off keeps OccludeFrame's child frames out of Play: mirror
// and sky passes drawn whole and planned and stamped by the frustum.
// ?actorOcclusion=frustum draws and stamps the main frame's actors from the
// frustum-tested drawn set instead of OccludeBsp's Frame->Sprite
// (dynamics-candidates.mjs, docs/bsp-occlusion.md "Play").
for(const [param,global] of [['renderScan','DEUS_EX_RENDER_SCAN'],['meshLight','DEUS_EX_MESH_LIGHT'],
  ['cycleScan','DEUS_EX_CYCLE_SCAN'],['levelScan','DEUS_EX_LEVEL_SCAN'],['farMove','DEUS_EX_FAR_MOVE'],
  ['particles','DEUS_EX_PARTICLES'],['gcNative','DEUS_EX_GC_NATIVE'],['pawnPhysics','DEUS_EX_PAWN_PHYSICS'],
  ['actorPhysics','DEUS_EX_ACTOR_PHYSICS'],['actorOcclusion','DEUS_EX_ACTOR_OCCLUSION'],
  ['moverTracker','DEUS_EX_MOVER_TRACKER'],['childFrames','DEUS_EX_CHILD_FRAMES']]) {
  const value=new URLSearchParams(location.search).get(param);
  if(value)globalThis[global]=value;
}
// ?childFog=off: the child frames' passes reuse the root frame's fog maps
// (as before each frame had its own, fog-pass.mjs framePass).
const childFog = new URLSearchParams(location.search).get('childFog') !== 'off';
// The original's display gamma ramp maps the finished 8-bit framebuffer, HUD
// included (D3DDrv SetGammaRamp, display-ramp.mjs): shaders draw raw colours
// and one pass ramps the frame. ?gamma=material keeps the earlier ramp in
// every shader, before blending (docs/lighting.md "Display ramp").
const rampPerFragment = new URLSearchParams(location.search).get('gamma') === 'material';
setDisplayRampPerFragment(rampPerFragment);
const displayRamp = rampPerFragment ? null : createDisplayRamp();
const canvasClear = new THREE.Color('#06101b');
// ?gpuTimer=1: one EXT_disjoint_timer_query_webgl2 TIME_ELAPSED query around
// the frame's GL work, read back frames later (docs/play-frame-cost.md).
// Measurement only; scripts/profile-play-browser.mjs --gpu sets it.
const gpuTimerParam=new URLSearchParams(location.search).get('gpuTimer')==='1';
// ?seed=N: the shared random stream's srand seed instead of time(NULL), for
// comparing two runs of one scenario (scripts/validate-sim-split.mjs).
const seedParam=new URLSearchParams(location.search).get('seed');
const randomSeed=seedParam===null?undefined:Number(seedParam)>>>0;
// ?hold=1: the frame loop does nothing until deusExViewer.release(), whose
// first frame takes a 1/60 s step; with ?seed= and a paused fake clock two
// runs then see the same frames (scripts/validate-sim-split.mjs).
let held=new URLSearchParams(location.search).get('hold')==='1';
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
const simMode=(({inline:'inline',clone:'clone',worker:'worker'})[new URLSearchParams(location.search).get('sim')])
  ??(simVerify?'inline':'worker');
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
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// World and actor shaders apply the original display-encoded modulation
// themselves and draw raw colours; the display ramp maps the finished frame
// (display-ramp.mjs).  Keep canvas and render-target programs in Three's
// working space so mirror child draws do not select a second shader variant
// for every material; the custom output bytes are unchanged.
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; renderer.autoClear = false;
renderer.info.autoReset=false;
const scene = new THREE.Scene();
// The scene and the world root keep identity matrices: without auto-update
// on them, renderer.render no longer forces every descendant's matrixWorld
// to be recomputed (twice per frame, sky and main pass). Objects that move
// update or flag their own (validate-scene-matrices.mjs).
scene.matrixAutoUpdate = false;
const camera = createPlayCamera(), skyCamera = new THREE.PerspectiveCamera(75, 1, 1, 65536);
// A sky frame inside a mirror frame (drawFrame drawSkyFrame).
const skyFrameCamera = new THREE.PerspectiveCamera(), skyRotation = new THREE.Matrix4(), skyFrameBasis = new THREE.Matrix4();
// The main frame draws decals; child frames (mirrors, sky) do not (decal-scene.mjs).
camera.layers.enable(DECAL_LAYER);
const raycaster = new THREE.Raycaster();
let assets, world, map, currentMap, loading = false, drag = false, yaw = 0, pitch = 0;
let subtitlePreference = false;
// The loaded map's simulation side (sim-host.mjs): `game` and its frame
// session `sim`.
let game, sim = null, simHost = null, mode = 'play', paused = false, runtimeError = null;
let hudRenderer=null;
let npcPreview=null;
let spriteScene=null,coronaPass=null,decalScene=null;
// Actor mesh animation and lighting run on the GPU (docs/gpu-mesh.md), on by
// default since validate-gpu-mesh passed on Training and Island; ?gpuMesh=0
// selects the CPU kernels, which stay the reference and the fallback. A
// software WebGL implementation (headless Chromium's SwiftShader) runs the
// passes on the CPU, far slower than the kernels, so it keeps the CPU path
// unless ?gpuMesh=1 forces the GPU path.
const gpuMeshParam=new URLSearchParams(location.search).get('gpuMesh');
function softwareRenderer(){
  try{
    const gl=renderer.getContext(),info=gl.getExtension('WEBGL_debug_renderer_info');
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(String(gl.getParameter(info?info.UNMASKED_RENDERER_WEBGL:gl.RENDERER)));
  }catch{return false;}
}
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
const lipSyncPositions=new Map();
let infoLinkAudioContext=null;
// Galaxy's music (docs/galaxy-music.md "Phase 5: Output"): an AudioWorklet
// owns the library (galaxy-music-output.mjs); the simulation talks to it on
// its own MessageChannel, the worker's end or, with ?sim=inline, the page's
// `pageMusicLibrary`. ?music=0 leaves the worklet out (the simulation then
// uses the headless mirror library), for A/B measurements.
const musicEnabled=new URLSearchParams(location.search).get('music')!=='0';
const musicOutput=musicEnabled?createMusicOutput():null;
let pageMusicLibrary=null,musicError=null;
const conversationAudio=new Map();
// Galaxy's lip-sync channels for the speech being played (docs/lip-sync.md).
let lipSync=null;
const audioTransport={requests:0,starts:0,failures:0,lastRequest:null,lastStarted:null,lastError:null};
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
    const context=await activateInfoLinkAudio();
    const entry={rate:event.rate,source:null,stopped:false,gain:context.createGain(),panner:context.createStereoPanner()};
    entry.panner.connect(entry.gain);entry.gain.connect(context.destination);
    galaxyVoices.set(event.voice,entry);applyGalaxyVoice(entry,event);
    let buffer=galaxyBuffers.get(event.sound);
    if(!buffer){buffer=context.decodeAudioData(event.bytes.slice().buffer);galaxyBuffers.set(event.sound,buffer);}
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
/** `lips`: also stop Galaxy's lip-sync channels (the worker's follow the
 * speech events on their own side). */
function stopConversationAudio(id,lips=true){
  for(const [key,entry] of conversationAudio)if(id===undefined||id===key){
    entry.cancelled=true;entry.source?.stop();conversationAudio.delete(key);
  }
  if(!lips)return;
  if(id===undefined)lipSync?.clear();else lipSync?.stop(id);
}
async function playConversationSpeech(event){
  stopConversationAudio(event.id,!simClient);
  if(event.kind==='stop')return;
  if(!simClient)lipSync?.start(event);
  const sound=event.audio.sound?.key??event.audio.soundObject;
  audioTransport.requests++;audioTransport.lastRequest={id:event.id,sound};
  const entry={cancelled:false,source:null,sound};conversationAudio.set(event.id,entry);
  try{
    const context=await activateInfoLinkAudio(),bytes=event.audio.bytes;
    const buffer=await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    if(entry.cancelled)return;
    const source=context.createBufferSource();entry.source=source;source.buffer=buffer;
    source.playbackRate.value=event.parameters[2]/100;
    const gain=context.createGain();gain.gain.value=event.parameters[0]/100;
    source.connect(gain);gain.connect(context.destination);
    source.onended=()=>{if(conversationAudio.get(event.id)===entry){conversationAudio.delete(event.id);lipSync?.stop(event.id);}};
    source.start();const startedAt=context.currentTime;
    audioTransport.starts++;audioTransport.lastStarted={id:event.id,sound};
    // Lip sync analyses the speech at its own rate (the MP3 header's, Galaxy's
    // record +0x3c); the realtime decode above may be resampled.
    // A failed second decode leaves this speech without lip sync (the
    // speech itself is playing); the reason is in status().audio.
    const rate=mp3SampleRate(bytes);
    if(rate&&lipSync){
      try{
        const offline=new OfflineAudioContext(1,Math.max(1,Math.ceil(buffer.duration*rate)),rate);
        const pcm=pcm16((await offline.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))).getChannelData(0));
        if(!entry.cancelled)lipSync.attach(event.id,{pcm,rate,position:()=>(context.currentTime-startedAt)*rate*source.playbackRate.value});
      }catch(error){audioTransport.lipSyncFailures=(audioTransport.lipSyncFailures??0)+1;audioTransport.lipSyncError=String(error?.message??error);}
    }
  }catch(error){if(entry.cancelled)return;conversationAudio.delete(event.id);
    audioTransport.failures++;audioTransport.lastError=String(error.message);pauseForRuntimeError(error);}
}
let revision = 0, lastTime = performance.now(), fpsTime = lastTime, frameCount = 0;
let cameraMoved = false, lastInspect = 0;
const keys = new Set(), velocity = new THREE.Vector3();
const busy = (title, message) => {
  $('gate').hidden = false; $('gate-title').textContent = title; $('gate-message').textContent = message;
  $('gate-choose').hidden = loading; $('progress').hidden = !loading;
};
function toast(message) { $('toast').textContent = message; setTimeout(() => { if ($('toast').textContent === message) $('toast').textContent = ''; }, 4000); }
async function activateInfoLinkAudio(){
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass)throw new Error('This browser cannot decode the original DataLink audio');
  // One context for the Web Audio voices, the speech and Galaxy's music
  // worklet, at Galaxy's output rate (the installed OutputRate, 44100 Hz).
  if(!infoLinkAudioContext){
    infoLinkAudioContext=new AudioContextClass({sampleRate:44100});
    musicOutput?.start(infoLinkAudioContext).catch(error=>{musicError=String(error?.message??error);});
  }
  if(infoLinkAudioContext.state==='suspended')await infoLinkAudioContext.resume();
  return infoLinkAudioContext;
}
// Music plays on every map: any gesture creates or resumes the context
// (browsers start audio only after one).
if(musicOutput)for(const type of ['pointerdown','keydown'])
  document.addEventListener(type,()=>{if(infoLinkAudioContext?.state!=='running')activateInfoLinkAudio().catch(()=>{});},true);
/** Galaxy's EffectsChannels from DeusEx.ini, clamped to 0..32 as the
 * subsystem's Init (0x10605580) does; the worklet opens the library with it. */
async function readEffectsChannels(files){
  const file=files.find(entry=>String(entry.path).replaceAll('\\','/').split('/').pop().toLowerCase()==='deusex.ini');
  if(!file)throw new Error('DeusEx.ini is not among the game files');
  const data=await file.read(),text=new TextDecoder('latin1').decode(data instanceof Uint8Array?data:new Uint8Array(data));
  const value=parseIniValue(text,'Galaxy.GalaxyAudioSubsystem','EffectsChannels');
  if(value===undefined)throw new Error('Galaxy EffectsChannels is not in DeusEx.ini');
  return Math.max(0,Math.min(32,msvcrtWtoi(value)));
}
/** A new simulation side's music library: the worker gets its end of the
 * channel; ?sim=inline keeps one library on the page for its lifetime. */
async function connectMusic(files){
  if(!musicOutput)return;
  try{
    musicOutput.configure({effectsChannels:await readEffectsChannels(files)});
    if(simClient)simClient.connectMusic(musicOutput.simulationPort());
    else if(!pageMusicLibrary)pageMusicLibrary=connectMusicLibraryPort(musicOutput.simulationPort(),{effects:true});
  }catch(error){musicError=String(error?.message??error);}
}
function musicStatus(output=musicOutput?.status()??null){
  return {enabled:musicEnabled,error:musicError,context:infoLinkAudioContext?.state??'uninitialized',output,
    library:simClient?simStatus?.music??null:pageMusicLibrary?.status()??null};
}
function stopInfoLinkPresentation(){
  stopConversationAudio();
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
function resize() {
  const box = $('viewport').getBoundingClientRect(), canvas = $('scene');
  let width = box.width, height = box.height;
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
  setPixelCentre(camera, renderer.domElement.width, renderer.domElement.height);
}
new ResizeObserver(resize).observe($('viewport'));
function renderViewportFor(rect) {
  const pr = renderer.getPixelRatio(), height = renderer.domElement.height;
  return [rect.x / pr, (height - rect.y - rect.height) / pr, rect.width / pr, rect.height / pr];
}
// The sky frame: Play's comes with the simulation frame (sim-session.mjs,
// Render.dll 0x10b18410: the SkyZone's Location and Rotation, the sky view
// being the SkyZone rotation applied after the view's); Inspect uses the
// map's statically chosen sky.
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
function resetCamera() {
  if (!map) return;
  let reply = null;
  hideNpcFocus();
  if (mode === 'play' && game) {
    // Player start; the worker resets after the frames posted before it.
    if (simClient) reply = simClient.call('reset').then(result => { if (result && world) { world.syncMovers(result.movers); applyPlayerView(result.view); } })
      .then(applyStartCheats);
    else { sim.reset(); world.syncMovers(sim.movers()); applyStartCheats(); }
    runtimeError=null;paused=false;keys.clear();$('toast').textContent='';stopInfoLinkPresentation();showStats();
  }
  const start = map.summary.playerStarts.find(p => p.location);
  const position = start?.location ?? map.model.points[0] ?? [0, 0, 0];
  camera.position.fromArray(toView([position[0], position[1], position[2] + 40]));
  pitch = (start?.rotation?.[0] ?? 0) * Math.PI / 32768;
  yaw = -(start?.rotation?.[1] ?? 0) * Math.PI / 32768;
  camera.rotation.set(pitch, yaw, 0); cameraMoved = false;
  if (mode === 'play' && game && !simClient) applyPlayerView(sim.view());
  return reply;
}
/** ?cheat= after a Player start; failures are shown, not thrown. */
function applyStartCheats() {
  if (!startCheats.length || !game) return null;
  const args = { exec: startCheats };
  return Promise.resolve().then(() => simClient ? simClient.call('viewProbe', args) : viewProbe(game, args))
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
function pauseForRuntimeError(error) {
  stopConversationAudio();
  runtimeError={message:error.message,stack:error.stack,travel:error.travel??null};paused=true;
  keys.clear();drag=false;document.exitPointerLock?.();
  showStats();
  // The map ended by travelling (Stage 6): a stop, not a failure.
  $('toast').textContent=error.travel
    ?`The map ended: it travels to “${error.travel.url}”. Map travel is not implemented yet (Stage 6). Choose Player start to replay.`
    :`Play paused: ${error.message}. Choose Player start to reset.`;
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
    lipSync: loaded.game ? workerLipSync : null, notes: loaded.notes, events: loaded.events, hudTextures: loaded.hudTextures, dispose() {} };
}
async function loadMap(name) {
  if (!assets || !assets.files.has(name.toLowerCase())) throw new Error(`Map is not available: ${name}`);
  if (loading) throw new Error('A map is already loading');
  loading = true; $('map').disabled = true; $('reset').disabled = true; $('choose').disabled = true;
  hideNpcFocus();
  $('toast').textContent = '';stopInfoLinkPresentation();
  document.exitPointerLock?.(); keys.clear();
  busy('Loading original map', `Reading ${name}…`);
  let nextWorld, nextHost = null, nextGame = null, nextNpcPreview = null, nextGpuMesh = null, nextSim = null, nextWeaponDraw = null, nextWeaponGpu = null;
  try {
    const asset = await assets.get(name);
    await new Promise(resolve => setTimeout(resolve, 0));
    const nextMap = decodeMap(asset.bytes);
    nextWorld = await createWorld(nextMap, asset, assets, (message, done, total) => {
      $('gate-message').textContent = message; $('progress').max = total; $('progress').value = done;
    });
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
    // mesh layers' simulation halves and lip sync.
    const hostOptions = { randomSeed, subtitles: subtitlePreference,
      stampScene: nextWorld.stampScene(), panZones: nextWorld.panZoneNames(), childFrames: nextWorld.mirrors.stats.planes > 0,
      gpu: nextGpuMesh?.capacities ?? null, weaponGpu: nextWeaponGpu?.capacities ?? null,
      meshBackend: new URLSearchParams(location.search).get('meshBackend') };
    // On the page the old map's audio unregisters its music before the next
    // map's runtime is built (the worker does the same at its load).
    if (!simClient) simHost?.disposeAudio?.();
    nextHost = simClient ? remoteHost(await simClient.load(name, hostOptions)) : await createSimHost(nextMap, asset, assets, { ...hostOptions,
      musicLibrary: pageMusicLibrary,
      onConversationSpeech: event => { void playConversationSpeech(event); }, onAudioVoice: event => { void galaxyVoice(event); },
      onProgress: message => { $('gate-message').textContent = message; } });
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
        /** Iterator item bindings in use (validation access, page only). */
        itemStats:()=>actorSim.itemSlots?.().map(({actor,ids})=>({actor,slots:ids.length,
          drawn:ids.filter(id=>id!==null&&drawOf(id)?.root.visible).length}))??null,
        batchStats:()=>draw.batchStats(),proceduralTextures:()=>draw.proceduralTextures(),
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
    // The simulation's first events (the startup lighting, the admitted
    // actors' creation records) reach the page before the first frame, whose
    // actor meshes are built while the map loads.
    applySimEvents(crossing(nextHost.events.splice(0)),{world:nextWorld,actors:nextNpcPreview,weapon:nextWeaponDraw});
    await nextNpcPreview?.draw.ready();
    coronaPass?.dispose();coronaPass=nextCoronaPass;
    if(spriteScene){scene.remove(spriteScene.root);spriteScene.dispose();}
    spriteScene=nextSpriteScene;
    if(spriteScene)scene.add(spriteScene.root);
    if(decalScene){scene.remove(decalScene.root);decalScene.dispose();}
    decalScene=nextDecalScene;
    if(decalScene)scene.add(decalScene.root);
    hudRenderer?.dispose();hudRenderer=nextHud;
    simHost?.dispose();simHost=nextHost;meshLighting=nextHost.meshLighting??null;weaponDraw?.dispose();weaponGpu?.dispose();simStatus=null;simAnswers={keys:{},pointerGrab:false};simLastPost=null;
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
    lipSync = nextGame ? nextHost.lipSync : null;
    game = nextGame;sim = nextSim;runtimeError=null; $('mode').options[0].disabled = !game; const viewReply = setMode(game ? mode : 'inspect'); paused = false;
    // The previews drive the runtime directly: on the page only.
    const training = Boolean(game) && name === '00_Training' && !simClient;
    setPreviewsAvailable({light: training, 'dark-door': training, npc: Boolean(npcPreview?.npcActors?.length),
      instructor: training, weapon: training, datacube: training, keypad: training});
    $('infolink-shell').hidden = true;
    world.displayGamma.value = 1 / (2.5 * Number($('brightness').value));
    // The worker's PlayerCalcView replies point the camera before the map
    // counts as ready (on the page they are synchronous).
    // resetCamera runs ?cheat= when it resets the player (Play mode).
    const playerReset = mode === 'play' && !!game;
    const resetReply = resetCamera(); showStats();
    await viewReply; await resetReply;
    if (!playerReset) await applyStartCheats();
    $('wireframe').checked = false; $('actor-markers').checked = false;
    $('lighting').checked = true;
    $('map').value = name; $('gate').hidden = true; $('reset').disabled = false;
    $('state').textContent = `${name} · ${world.textures} textures · ${world.counts.triangles.toLocaleString()} triangles`;
    if (world.errors.length) toast(`${world.errors.length} render issues — open Diagnostics for details.`);
  } catch (error) {
    if(nextHost&&nextHost!==simHost)nextHost.dispose?.();
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
    $('reset').disabled = !world;
  }
  return status();
}
async function setFiles(files) {
  const next = new AssetStore(files);
  if (simMode === 'worker') {
    // The worker reads the same files (File objects or the dev server's
    // URLs), with the page's DEUS_EX_* switches set before its runtime loads.
    simClient?.terminate();
    simClient = createSimClient({ onProgress: message => { $('gate-message').textContent = message; },
      onFrame: lockstep ? snapshot => drawLockstep(snapshot) : null,
      onFailure: error => pauseForRuntimeError(error) });
    const flags = Object.fromEntries(Object.keys(globalThis).filter(key => key.startsWith('DEUS_EX_')).map(key => [key, globalThis[key]]));
    await simClient.init(flags, files.map(file => ({ path: file.path, ...(file.file ? { file: file.file } : {}), ...(file.url ? { url: file.url } : {}) })));
  }
  await connectMusic(files);
  const names = [...next.files.values()].filter(f => /\.(dx|unr)$/i.test(f.path)).map(f => f.name).sort();
  if (!names.length) throw new Error('No maps found. Choose the game folder containing Maps, Textures, and System.');
  assets = next;
  // Honor the installed DeusExPlayer.bSubtitles globalconfig (shipped True) as
  // the initial conversation-subtitle preference; the diagnostics toggle flips it.
  subtitlePreference = await readGlobalConfigBool(files, 'DeusEx.DeusExPlayer', 'bSubtitles', false);
  const subtitleToggle = $('subtitles'); if (subtitleToggle) subtitleToggle.checked = subtitlePreference;
  $('map').replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; }));
  await loadMap(names.find(n => n.toLowerCase() === '00_training') ?? names[0]);
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
$('mode').onchange = event => setMode(event.target.value);
function togglePanel(open) { $('panel').hidden = !open; $('diagnostics').setAttribute('aria-expanded', String(open)); }
$('diagnostics').onclick = () => togglePanel($('panel').hidden);
// Page bars off: the view fills the window, so the HUD root (and with it a
// forced-play conversation's letterbox, which holds the intro's subtitles)
// gets the window's own aspect. A per-browser convenience only.
function setUiHidden(hidden) {
  $('app').classList.toggle('ui-hidden', hidden); $('show-ui').hidden = !hidden;
  try { localStorage.setItem('deusex.uiHidden', hidden ? '1' : '0'); } catch { /* storage unavailable */ }
}
$('hide-ui').onclick = () => setUiHidden(true);
function setScreenAspect(value) {
  screenAspect = Object.hasOwn(SCREEN_ASPECTS, value) ? value : 'window'; $('screen-aspect').value = screenAspect; resize();
  try { localStorage.setItem('deusex.screenAspect', screenAspect); } catch { /* storage unavailable */ }
}
$('screen-aspect').onchange = event => setScreenAspect(event.target.value);
try { setScreenAspect(localStorage.getItem('deusex.screenAspect') ?? 'window'); } catch { /* storage unavailable */ }
$('show-ui').onclick = () => setUiHidden(false);
try { if (localStorage.getItem('deusex.uiHidden') === '1') setUiHidden(true); } catch { /* storage unavailable */ }
$('close-panel').onclick = () => togglePanel(false);
$('wireframe').onchange = event => { if (world) for (const material of world.materials.values()) material.wireframe = event.target.checked; };
$('actor-markers').onchange = event => { if (world) world.markers.visible = event.target.checked; };
$('lighting').onchange = event => { if (world) world.lightingEnabled.value = event.target.checked ? 1 : 0; };
$('subtitles').onchange = event => { subtitlePreference = event.target.checked; simInput.subtitles(subtitlePreference); };
$('brightness').oninput = event => {
  const value = Number(event.target.value);
  if (world) world.displayGamma.value = 1 / (2.5 * value);
  $('brightness-value').value = value.toFixed(2);
};
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
    drag=false;document.exitPointerLock?.();togglePanel(false);$('scene').focus();
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
    drag = false; document.exitPointerLock?.(); togglePanel(false); $('scene').focus();
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
    drag = false; document.exitPointerLock?.(); togglePanel(false); $('scene').focus();
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
    drag = false; document.exitPointerLock?.(); togglePanel(false); $('scene').focus();
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
  pointer(sample) {
    if (!simClient) return game.windowPointer(sample);
    simClient.queue({ op: 'pointer', sample });
    return simAnswers.pointerGrab;
  },
  reset(options) { if (!game) return; if (simClient) simClient.queue({ op: 'resetInput', options }); else game.resetInput(options); },
  subtitles(value) { if (!game) return; if (simClient) simClient.queue({ op: 'subtitles', value }); else game.subtitles = value; },
};
/** Galaxy's lip-sync channels in the worker, seen from the page's speech
 * playback: attach (the decoded PCM and the mixer position, sampled at each
 * frame's post), stop and clear go with the next frame; the channels start
 * on the worker's side. */
const workerLipSync = {
  start() {},
  attach(id, { pcm, rate, position }) { lipSyncPositions.set(id, position); simClient.queue({ op: 'lipsync-attach', id, pcm, rate }); },
  stop(id) { lipSyncPositions.delete(id); simClient.queue({ op: 'lipsync-stop', id }); },
  clear() { lipSyncPositions.clear(); simClient.queue({ op: 'lipsync-clear' }); },
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
  const canvas=$('scene'),sample=windowPointerSample(event,canvas.getBoundingClientRect(),
    renderer.domElement.width,renderer.domElement.height,document.pointerLockElement===canvas);
  if(action!==null){const key=pointerButtonKey(event.button);if(key<0)return false;sample.key=key;sample.action=action;}
  try{return simInput.pointer(sample);}catch(error){pauseForRuntimeError(error);return true;}
}
$('scene').onpointerdown = event => {
  if (!world || loading) return;
  paused = mode === 'play' && Boolean(runtimeError); $('scene').focus();
  const windowHasMouse = windowPointer(event);
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
$('scene').onpointerup = event => {
  drag = false;
  if (windowPointer(event)) event.preventDefault();
  if (mode !== 'play' || !game) return;
  const key = ['LeftMouse', 'MiddleMouse', 'RightMouse'][event.button];
  try { if (key) simInput.button(key, false); }
  catch (error) { pauseForRuntimeError(error); }
};
$('scene').onpointercancel = () => { drag = false; simInput.reset({releasePhysical:true}); };
$('scene').ondblclick = () => $('scene').requestPointerLock?.()?.catch?.(() => toast('Drag the view to look around.'));
document.addEventListener('pointermove', event => { if(windowPointer(event))return; if (document.pointerLockElement === $('scene') || drag) look(event.movementX, event.movementY); });
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
  const input = inputKey(event, true);
  if (input && !runtimeError) typeCharacters(event);
  if (input) {
    if (input.consumed) { keys.clear(); event.preventDefault(); return; }
    if (input.handled) {
      event.preventDefault(); paused = false;
      if(currentMap === '00_Training') activateInfoLinkAudio().catch(error => pauseForRuntimeError(error));
    }
    return;
  } else if (event.code === 'Escape') { document.exitPointerLock?.(); keys.clear(); drag = false; return; }
  if (!world || loading || /INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) return;
  if (['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight','Space','ControlLeft','ControlRight'].includes(event.code)) {
    if(mode==='play'&&runtimeError){event.preventDefault();return;}
    if(mode==='play'&&currentMap==='00_Training')activateInfoLinkAudio().catch(()=>{});
    paused = false;
    keys.add(event.code); event.preventDefault();
  }
});
document.addEventListener('pointerlockchange', () => { drag = false; keys.clear(); simInput.reset(); });
document.addEventListener('keyup', event => {
  const input = inputKey(event, false);
  if (input?.consumed || (input?.handled && !input.host)) event.preventDefault();
  keys.delete(event.code);
});
window.addEventListener('blur', () => { keys.clear(); drag = false; paused = true; simInput.reset({releasePhysical:true}); });
document.addEventListener('visibilitychange', () => { keys.clear(); if (document.hidden) { paused = true; simInput.reset({releasePhysical:true}); } });
function status() {
  return { ready: Boolean(world) && !loading, map: currentMap ?? null, revision,
    textures: world?.textures ?? 0, renderErrors: world?.errors ?? [], triangles: world?.counts.triangles ?? 0,
    movers: world?.counts.movers ?? 0, position: fromView(camera.position.toArray()),
    mode, paused, runtimeError, gameplay: simClient ? simStatus?.gameplay ?? null : game?.status() ?? null, sim: simMode,
    galaxy:{...galaxyAudio,voices:galaxyVoices.size},music:musicStatus(),
    audio:{...audioTransport,contextState:infoLinkAudioContext?.state??'uninitialized',
      active:[...conversationAudio].map(([id,entry])=>({id,sound:entry.sound,started:Boolean(entry.source)}))},
    npcPreview:npcPreview?{...npcPreview.summary,visible:npcPreview.root.visible}:null,
    weaponViewModel:weaponSummary,
    lighting: world?.lighting ?? null, lightingEnabled: Boolean(world?.lightingEnabled.value), horizontalFOV: 75,
    mirrors: world ? { ...world.mirrors.stats } : null,
    brightness: Number($('brightness').value), displayGamma: world?.displayGamma.value ?? null,
    rotation: [pitch, yaw], wireframe: $('wireframe').checked, actorMarkers: $('actor-markers').checked, cameraMoved,
    calls: renderer.info.render.calls, frame: renderer.info.render.frame,
  };
}
// A small read-only diagnostic hook also makes browser regressions reproducible.
window.deusExViewer = { status, framePhases(reset = true) {
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
/** Validation only: view-probe.mjs (the original captures' camera commands)
 * on the simulation side. */
viewProbe(args) {
  if (simClient) return simClient.call('viewProbe', args);
  return game ? viewProbe(game, args) : null;
},
/** Validation only: window-probe.mjs (the root window, focus text,
 * Console line and notes) on the simulation side. */
async windowProbe() {
  if (simClient) return simClient.call('windowProbe');
  return game ? (await import('./window-probe.mjs')).windowProbe(game) : null;
},
/** Validation only: mover-probe.mjs (the moving brush tracker's movers) on
 * the simulation side. */
async moverProbe(args) {
  if (simClient) return simClient.call('moverProbe', args);
  return game && sim ? (await import('./mover-probe.mjs')).moverProbe(game, sim, args) : null;
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
/** The page's fog pass (fog-pass.mjs): its last frame's counters and the
 * fog meshes it drew. */
fog() {
  const fog = world?.fog;
  return fog ? { stats: { ...fog.stats }, visibleMeshes: fog.root.children.filter(object => object.visible).length } : null;
},
/** Show or hide the fog pass (validation: a frame with and without it). */
showFog(on) { if (world?.fog) world.fog.root.visible = Boolean(on); },
/** The page's corona pass (corona-pass.mjs): the last frame's counters. */
coronas() { return coronaPass ? { ...coronaPass.stats } : null; },
/** Draw or skip the corona pass (validation: a frame with and without it). */
showCoronas(on) {
  if (!coronaPass) return;
  if (!on && !coronaPass.__render) { coronaPass.__render = coronaPass.render; coronaPass.render = () => {}; }
  else if (on && coronaPass.__render) { coronaPass.render = coronaPass.__render; delete coronaPass.__render; }
},
/** The last drawn frame's decal fragments (decal-draw.mjs, decal-scene.mjs):
 * per texture the triangles the simulation clipped, and those drawn. */
decals() {
  return { groups: (lastVisibility?.decals ?? []).map(group => ({ texture: group.texture.key, triangles: group.positions.length / 9 })),
    drawnTriangles: decalScene?.count() ?? null, notes: [...(decalScene?.notes ?? [])] };
},
/** The last drawn frame's OccludeBsp result (sim-session.mjs visibility):
 * node count, mirror requests, sky, and the world triangles it kept. */
visibility() {
  return lastVisibility ? { nodes: lastVisibility.nodes.length, zone: lastVisibility.zone, mirrors: [...lastVisibility.mirrors],
    sky: lastVisibility.sky, triangles: world?.visibility?.stats.drawnTriangles ?? null,
    groups: world?.mirrors.groups().map(group => ({ key: group.key, moving: Boolean(group.moving) })) ?? [] } : null;
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
      fov: camera.fov, aspect: camera.aspect, near: camera.near, far: camera.far },
      view: { location: fromView(camera.position.toArray()), rotation: [toUnits(pitch), toUnits(-yaw), 0] },
      sky: world.sky ? { location: [...world.sky], rotation: [...(world.skyRotation ?? [0, 0, 0])] } : null } };
}
/** ?sim=worker: posts a frame; its dt is the page time since the last post
 * (the worker sums the dts of the posts it merges). */
function postSimFrame(time) {
  if (!simClient || !sim || !world || loading || held) return false;
  const dt = Math.max(0, (time - (simLastPost ?? time - 1000 / 60)) / 1000);
  simClient.post({ ...simFrameInput(time), dt }, { speech: [...lipSyncPositions].map(([id, position]) => [id, position()]),
    status: !simStatus || simPosts % 15 === 0 });
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
  if (held === 'releasing') { held = false; lastTime = simLastPost = time - 1000 / 60; }
  if (held) { lastTime = time; return; }
  const dt = Math.max(0, (time - lastTime) / 1000); lastTime = time;
  const frameStart = phaseMark = performance.now();
  if (world && !loading) {
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
      snap = lockstep ? null : simClient.take();
      draw = Boolean(snap);
    } else if (sim) snap = simFrame({ ...simFrameInput(time), dt });
    if (draw) drawFrame(snap, time);
  }
  framePhases.frames++; framePhases.total += performance.now() - frameStart;
  if (time - fpsTime > 1000) { $('performance').textContent = world ? `${Math.round(frameCount * 1000 / (time - fpsTime))} fps` : ''; frameCount = 0; fpsTime = time; }
}
/** Draws one simulation snapshot (null: no simulation, Inspect over the
 * world alone). */
let lastVisibility = null;
function drawFrame(snap, time) {
  // Drawn frames: the fps counter's and framePhases' `draws` (with
  // ?sim=worker a display frame without a new snapshot draws nothing).
  framePhases.draws++; frameCount++;
  let playerView = null, renderRect = null;
  const playing = mode === 'play' && Boolean(game);
  const axis = (positive, negative) => positive.some(k => keys.has(k)) - negative.some(k => keys.has(k));
  const x = axis(['KeyD','ArrowRight'], ['KeyA','ArrowLeft']), z = axis(['KeyW','ArrowUp'], ['KeyS','ArrowDown']);
  // Inspect in the worker: the snapshot was culled for the camera posted
  // with its frame, which draws it; the free camera returns after.
  const live = snap?.inspect && simClient ? { position: camera.position.clone(), quaternion: camera.quaternion.clone() } : null;
  if (live) { camera.position.fromArray(snap.inspect.camera.position); camera.quaternion.fromArray(snap.inspect.camera.quaternion); camera.updateMatrixWorld(); }
  if (snap) {
    // The worker's audio since the last snapshot, as its callbacks ran
    // during the tick, then the frame's errors.
    for (const { kind, event } of snap.audio ?? []) { if (kind === 'voice') void galaxyVoice(event); else void playConversationSpeech(event); }
    if (snap.answers) simAnswers = snap.answers;
    for (const message of snap.toasts ?? []) toast(message);
    if (snap.status) { simStatus = snap.status; if (npcPreview && snap.status.summary) npcPreview.summary = snap.status.summary; }
    for (const error of snap.errors) pauseForRuntimeError(error);
    // The worker's step times are its own thread's (`worker`); on the page
    // they belong to the frame's phases.
    for (const [name, ms] of Object.entries(snap.timings)) {
      if (!simClient) { framePhases[name] += ms; continue; }
      framePhases.worker += ms; framePhases[`w.${name}`] = (framePhases[`w.${name}`] ?? 0) + ms;
    }
    phaseMark = performance.now();
    applySimEvents(snap.events, { world, actors: npcPreview, weapon: weaponDraw });
  }
  const frame = snap?.begin ?? null, words = packViews(snap?.pack);
  if (playing && frame) {
    world.syncMovers(frame.movers);
    // The simulation side points its own camera the same way
    // (play-camera.mjs applyPlayFrame).
    renderRect = frame.renderRect;
    if (frame.view) { playerView = frame.view; ({ pitch, yaw } = applyPlayFrame(camera, frame.view, renderRect)); }
    // The 3D view's pixel size: the render rect when it draws, else the canvas.
    const viewSize = renderRect?.render && renderRect.width > 0 && renderRect.height > 0
      ? [renderRect.width, renderRect.height] : [renderer.domElement.width, renderer.domElement.height];
    setPixelCentre(camera, ...viewSize);
    if (frame.light) world.beginLightFrame(frame.light);
    if (x || z || keys.has('Space') || keys.has('ControlLeft') || keys.has('ControlRight')) cameraMoved = true;
    const target = frame.target;
    $('play-hint').textContent = runtimeError?.travel ? `Map ended · travel to ${runtimeError.travel.url} is Stage 6 · Player start replays`
    : runtimeError ? 'Play paused · Player start resets the scene' : paused ? 'Click the view to resume' : target ? `Right-click · ${target.label}` : '';
  }
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
  const drawnLightMaps = frameSurfaces ?? (viewFrustum && visible && !visible.sky ? drawnSurfaces : null);
  const lightFrustum = frameSurfaces ? null : viewFrustum;
  // The frame's moving lights (docs/dynamic-lighting.md), on the drawn light
  // maps, before the texture animation that shares their light frame.
  if (playing && frame?.lights) {
    try { world.syncMovingLights(frame.lights, frame.movers, { frustum: lightFrustum, drawn: drawnLightMaps }); }
    catch (error) { pauseForRuntimeError(error); }
  }
  // The worker's snapshot animates textures at its frame's post time;
  // on the page the frame is now.
  world.updateTextureAnimation(simClient ? snap?.now : undefined,
    { ...panInputs, viewpoint: fromView(camera.position.toArray()), frustum: lightFrustum,
      drawn: drawnLightMaps, phase });
  world.flushLighting(renderer);
  phase('lightUpload');
  // Volumetric fog maps from this frame's eye and view rotation
  // (docs/volumetric-fog.md), and each child frame's from its own Coords.
  if (world.fog?.stats.surfaces && !runtimeError) {
    const toUnits = radians => Math.round(radians * 32768 / Math.PI);
    const fogView = playerView ?? snap?.inspect?.view ?? { location: fromView(camera.position.toArray()), rotation: [toUnits(pitch), toUnits(-yaw), 0] };
    try {
      world.fog.update(fogView, new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)),
        drawnSurfaces, { movers: visible?.movers ?? null, moverZones: visible?.moverZones ?? null,
          moverFacets: visible?.moverFacets ?? null, fogZone: world.fogZone, frames: childFog ? frames : null,
          nodeSurface: world.nodeSurface });
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
  let passIndex = 0;
  // One child frame's world (its visible nodes and mover polygons) and
  // sprite records; null: all again.
  const framePass = frames ? record => {
    world.fog?.framePass(record, renderer);
    if (!record) { world.visibility.all(); spriteScene?.framePass(null); return; }
    world.visibility.select(record.nodes, record.movers ?? null);
    spriteScene?.framePass(record.index);
  } : null;
  // A sky frame OccludeBsp made (in the root frame or inside a mirror
  // frame): the SkyZone's view turned like the frame's camera
  // (0x10b184b1), its own world and sprites, no actor meshes.
  const skyView = visible?.skyView ?? null;
  const drawSkyFrame = (record, base) => {
    if (!skyView) return;
    skyFrameCamera.copy(base, false); skyFrameCamera.matrixAutoUpdate = skyFrameCamera.matrixWorldAutoUpdate = false;
    skyFrameCamera.layers.disable(DECAL_LAYER);
    skyFrameCamera.matrixWorld.multiplyMatrices(skyRotation.makeRotationFromEuler(rotatorEuler(skyView.rotation)),
      skyFrameBasis.extractRotation(base.matrixWorld)).setPosition(...toView(skyView.location));
    skyFrameCamera.matrixWorldInverse.copy(skyFrameCamera.matrixWorld).invert();
    skyFrameCamera.position.setFromMatrixPosition(skyFrameCamera.matrixWorld);
    const markersVisible = world.markers.visible; world.markers.visible = false;
    const npcVisible = npcPreview?.root.visible; if (npcPreview) npcPreview.root.visible = false;
    framePass(record);
    try { renderer.render(scene, skyFrameCamera); }
    finally { framePass(null); world.markers.visible = markersVisible; if (npcPreview) npcPreview.root.visible = npcVisible; }
  };
  world.mirrors.render(renderer, scene, camera, { markers: world.markers, sky: world.sky, requested,
    frames, rect: frames ? (renderRect ?? null) : null, framePass, skyIn: frames ? drawSkyFrame : null,
    updateActors: npcPreview && !runtimeError ? (position, passCamera, node) => {
      const decisions = node ? stampFrame?.passDecisions[passIndex++] : stampFrame?.mainDecisions;
      if (node && !decisions) throw new Error('The page drew a mirror pass the simulation side did not plan');
      npcPreview.draw.pass(decisions ?? new Map(), position);
    } : null });
  phase('mirrors');
  let calls = drawCalls(); framePhases.mirrorCalls += calls;
  // The ramp pass maps the raw clear colour back to the UI colour.
  renderer.setClearColor(displayRamp ? displayRamp.rawClear(canvasClear, world.displayGamma.value) : canvasClear, 1); renderer.clear();
  const clipped = drawWorld && renderRect && (renderRect.x || renderRect.y
    || renderRect.width !== renderer.domElement.width || renderRect.height !== renderer.domElement.height);
  if (clipped) {
    const box = renderViewportFor(renderRect);
    renderer.setViewport(...box); renderer.setScissor(...box); renderer.setScissorTest(true);
  }
  const sky = drawWorld ? skyFrame(frame) : null;
  const rootSky = frames?.find(f => f.parent === 0 && f.kind === 'sky') ?? null;
  if (sky) {
    skyCamera.copy(camera); skyCamera.layers.disable(DECAL_LAYER); skyCamera.position.fromArray(toView(sky.location));
    skyCamera.quaternion.premultiply(new THREE.Quaternion().setFromEuler(rotatorEuler(sky.rotation)));
    const markersVisible = world.markers.visible; world.markers.visible = false;
    // The root sky frame draws its own world, sprites and actors
    // (stamped on the simulation side); without child frames, no actors.
    const skyActors = rootSky && npcPreview && stampFrame?.skyDecisions;
    const npcVisible=npcPreview?.root.visible;if(npcPreview&&!skyActors)npcPreview.root.visible=false;
    if (skyActors) npcPreview.draw.pass(stampFrame.skyDecisions, fromView(skyCamera.position.toArray()));
    if (rootSky) framePass(rootSky);
    try { renderer.render(scene, skyCamera); } finally { if (rootSky) framePass(null); }
    world.markers.visible = markersVisible;
    if(npcPreview)npcPreview.root.visible=npcVisible;renderer.clearDepth();
    if (skyActors) npcPreview.draw.pass(stampFrame.mainDecisions ?? new Map(), fromView(camera.position.toArray()));
    framePhases.skyCalls += drawCalls() - calls; calls = drawCalls();
  }
  // The decal block's fragments for this frame (sim-session.mjs visibility).
  decalScene?.update(visible?.decals ?? null);
  if (drawWorld) {
    // The main frame draws only the polygons OccludeBsp kept (world-visibility.mjs).
    if (visible) world.visibility.select(visible.nodes, visible.movers ?? null);
    spriteScene?.mainPass(true);
    try { renderer.render(scene, camera); } finally { world.visibility.all(); spriteScene?.mainPass(false); }
  }
  if (simVerify && !simClient && stampFrame) {
    const problem = sim.verifyStamps(drew, { built: id => Boolean(npcPreview?.draw.bindings.get(id)?.ready),
      skipped: spriteScene?.skipped });
    if (problem) pauseForRuntimeError(new Error(`simVerify: drawn sets differ: ${problem}`));
  }
  phase('render');
  // Coronas close DrawFrame, before PostRender's weapon and HUD.
  if (coronaFrame && coronaPass) {
    try { coronaPass.update(coronaFrame.frame, coronaFrame.width, coronaFrame.height); coronaPass.render(renderer); }
    catch (error) { pauseForRuntimeError(error); }
  }
  phase('coronas');
  framePhases.mainCalls += drawCalls() - calls; calls = drawCalls();
  if (weaponFrame && weaponDraw) {
    try { weaponDraw.render(renderer, camera, weaponFrame); } catch (error) { pauseForRuntimeError(error); }
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
    hudRenderer.render(renderer, renderer.domElement.width, renderer.domElement.height, snap.hud.commands);
    updateInfoLinkAccessibility(snap.hud.infoLink);
  }
  framePhases.hudCalls += drawCalls() - calls;
  phase('hud');
  if (displayRamp) displayRamp.apply(renderer, world.displayGamma.value);
  gpuEnd();
  phase('ramp');
  $('crosshair').hidden=mode==='play'&&Boolean(hudRenderer);
  if ($('inspect').checked && time - lastInspect > 150) {
    lastInspect = time; raycaster.setFromCamera(new THREE.Vector2(), camera);
    const hit = raycaster.intersectObjects(world.root.children, true).find(h => h.object.isMesh);
    const surface = hit && (hit.object.userData.faceMaterials?.[hit.faceIndex] ?? hit.object.material.userData);
    $('surface-info').textContent = hit ? `${surface.key}\n${surface.width} × ${surface.height} · ${surface.mipCount} mips\nSurface ${hit.object.userData.faces?.[hit.faceIndex] ?? '—'} · ${hit.object.userData.actor ?? hit.object.name ?? 'world'}\nFlags 0x${(surface.flags ?? 0).toString(16)}` : 'No surface under the crosshair.';
  }
  if (live) { camera.position.copy(live.position); camera.quaternion.copy(live.quaternion); camera.updateMatrixWorld(); }
}
/** ?sim=worker in lockstep: a snapshot drawn as it arrives. */
function drawLockstep(snapshot) {
  if (!world || loading) return;
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
