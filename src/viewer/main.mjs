import * as THREE from 'three';
import './style.css';
import { AssetStore } from '../unreal/assets.mjs';
import { readGlobalConfigBool } from '../unreal/user-config.mjs';
import { decodeMap } from '../unreal/map.mjs';
import { toView, fromView } from '../unreal/geometry.mjs';
import { createWorld } from './world.mjs';
import { createGame } from './game.mjs';
import { createSpriteScene } from './sprite-scene.mjs';
import { createCoronaPass } from './corona-pass.mjs';
import { TextureStore } from '../unreal/textures.mjs';
import { createHudRenderer } from './hud.mjs';
import { createActorMeshScene } from './npc-mesh-preview.mjs';
import { createGpuMesh } from './gpu-mesh.mjs';
import { createWeaponViewModel } from './weapon-view-model.mjs';
import { createMeshLightingView } from './mesh-lighting-view.mjs';
import { actorRenderFeedback } from './actor-render-feedback.mjs';
import {pointerButtonKey,windowPointerSample} from './window-pointer.mjs';
import {createLipSyncChannels,mp3SampleRate,pcm16} from '../runtime/galaxy-lipsync-channels.mjs';
import {loadScriptVmKernel} from '../runtime/script-vm-kernel.mjs';

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
// ?gpuTimer=1: one EXT_disjoint_timer_query_webgl2 TIME_ELAPSED query around
// the frame's GL work, read back frames later (docs/play-frame-cost.md).
// Measurement only; scripts/profile-play-browser.mjs --gpu sets it.
const gpuTimerParam=new URLSearchParams(location.search).get('gpuTimer')==='1';

const $ = id => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// World and actor shaders apply the original display-encoded modulation and
// gamma ramp themselves.  Keep canvas and render-target programs in Three's
// working space so mirror child draws do not select a second shader variant
// for every material; the custom output bytes are unchanged.
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; renderer.autoClear = false;
renderer.info.autoReset=false;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 1, 65536), skyCamera = camera.clone();
camera.rotation.order = 'YXZ';
const raycaster = new THREE.Raycaster();
let assets, world, map, currentMap, loading = false, drag = false, yaw = 0, pitch = 0;
let subtitlePreference = false;
let game, mode = 'play', paused = false, runtimeError = null;
let hudRenderer=null;
let npcPreview=null;
let spriteScene=null,coronaPass=null;
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
let weaponViewModel=null;
let meshLighting=null;
let infoLinkAudioContext=null;
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
function stopConversationAudio(id){
  for(const [key,entry] of conversationAudio)if(id===undefined||id===key){
    entry.cancelled=true;entry.source?.stop();conversationAudio.delete(key);
  }
  if(id===undefined)lipSync?.clear();else lipSync?.stop(id);
}
async function playConversationSpeech(event){
  stopConversationAudio(event.id);
  if(event.kind==='stop')return;
  lipSync?.start(event);
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
  infoLinkAudioContext??=new AudioContextClass();
  if(infoLinkAudioContext.state==='suspended')await infoLinkAudioContext.resume();
  return infoLinkAudioContext;
}
function stopInfoLinkPresentation(){
  stopConversationAudio();
  stopGalaxyVoices();
  $('infolink-shell').hidden=true;
}
// Accessibility mirrors native TextWindow contents. The pixels are emitted
// only by the recovered native HUD/GC tree; no independent playback timeline.
function updateInfoLinkAccessibility(){
  const bridge=game?.doors?.scriptRuntime,host=bridge?.windowHost;
  if(!host?.hud)return;
  const runtime=bridge.runtime,read=(o,k)=>runtime.readNamed(o,k);
  const info=read(host.hud,'infoLink');
  $('infolink-shell').hidden=!info;
  if(!info)return;
  const text=read(info,'winText');
  $('infolink-title').textContent=host.raw.read(read(info,'winName'),0x168,'string');
  $('infolink-queued').textContent=host.raw.read(read(info,'winQueued'),0x168,'string');
  // Native displayBuffer contains the characters that have actually appeared.
  $('infolink-text').textContent=host.computerText(text);
}
// Play's screen shape: the window's own, or a fixed one centred in it (like
// choosing a 1024x768 or 1680x1050 resolution in the original). The root
// window and the 3D view take the canvas size, so a forced-play letterbox
// follows the chosen shape.
const SCREEN_ASPECTS = { window: null, '4:3': 4 / 3, '16:10': 16 / 10 };
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
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(75 / 2)) / camera.aspect));
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('viewport'));
// The original renders the 3D view into the root window's render viewport
// (XRootWindow PreRender, script-root-render-viewport.mjs): the horizontal
// FOV spans the rect's width, so a letterbox crops vertically about the
// rect's centre.
function setViewAspect(aspect, fov) {
  if (camera.aspect === aspect && camera.userData.fov === fov) return;
  camera.aspect = aspect; camera.userData.fov = fov;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) / aspect));
  camera.updateProjectionMatrix();
}
function renderViewportFor(rect) {
  const pr = renderer.getPixelRatio(), height = renderer.domElement.height;
  return [rect.x / pr, (height - rect.y - rect.height) / pr, rect.width / pr, rect.height / pr];
}
const rotatorAngle = n => ((n % 65536 + 98304) % 65536 - 32768) * Math.PI / 32768;
// A rotator as the view's Euler (pitch, -yaw, -roll in 'YXZ', as applyPlayerView).
const rotatorEuler = ([pitchUnits, yawUnits, rollUnits]) =>
  new THREE.Euler(rotatorAngle(pitchUnits), -rotatorAngle(yawUnits), -rotatorAngle(rollUnits), 'YXZ');
// Render.dll's sky frame (0x10b18410): only when LevelInfo.SkyZone (+0x384)
// is set; the frame zone's ZoneInfo (LevelInfo when the zone has none)
// supplies its SkyZone, whose Location is the sky frame's origin and whose
// Rotation detransforms the view coords (FCoords /= FRotator: roll, pitch,
// yaw), i.e. the sky view is the SkyZone rotation applied after the view's.
// In Play the zones' SkyZone is what the original LinkToSkybox set at
// startup; Inspect uses the map's statically chosen sky.
function skyFrame() {
  const runtime = mode === 'play' ? game?.doors?.scriptRuntime?.runtime : null;
  if (!runtime) return world.sky ? { location: world.sky, rotation: world.skyRotation ?? [0, 0, 0] } : null;
  const level = runtime.levelFor(game.player.collisionActor), info = level.actors[0];
  if (!runtime.readNamed(info, 'SkyZone')) return null;
  const zone = level.pointRegion(fromView(camera.position.toArray()))?.zone ?? info;
  const sky = runtime.readNamed(zone, 'SkyZone') ?? runtime.readNamed(info, 'SkyZone');
  return { location: runtime.readNamed(sky, 'Location'), rotation: runtime.readNamed(sky, 'Rotation') };
}
function applyPlayerView() {
  const view = game.view();
  const angle = n => ((n % 65536 + 98304) % 65536 - 32768) * Math.PI / 32768;
  camera.position.fromArray(toView(view.location));
  pitch = angle(view.rotation[0]); yaw = -angle(view.rotation[1]);
  camera.rotation.set(pitch, yaw, -angle(view.rotation[2]));
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(view.fov / 2)) / camera.aspect));
  camera.updateProjectionMatrix();
  return view;
}
function resetCamera() {
  if (!map) return;
  hideNpcFocus();
  if (mode === 'play' && game) {
    game.reset(); world.syncMovers(game.collision.movers);
    runtimeError=null;paused=false;keys.clear();$('toast').textContent='';stopInfoLinkPresentation();showStats();
  }
  const start = map.summary.playerStarts.find(p => p.location);
  const position = start?.location ?? map.model.points[0] ?? [0, 0, 0];
  camera.position.fromArray(toView([position[0], position[1], position[2] + 40]));
  pitch = (start?.rotation?.[0] ?? 0) * Math.PI / 32768;
  yaw = -(start?.rotation?.[1] ?? 0) * Math.PI / 32768;
  camera.rotation.set(pitch, yaw, 0); cameraMoved = false;
  if (mode === 'play' && game) applyPlayerView();
}
function setMode(next) {
  if (mode === 'play' && next !== 'play') game?.resetInput({releasePhysical:true});
  mode = next === 'play' && game ? 'play' : 'inspect'; $('mode').value = mode;
  resize(); // Inspect uses the whole canvas again; Play takes the screen shape.
  if(mode==='play')hideNpcFocus();
  keys.clear();
  if (mode === 'play') applyPlayerView();
  $('play-hint').textContent = '';
  $('controls').textContent = mode === 'play' ? 'Drag to look · Double-click to lock mouse · WASD move · Space jump · X crouch · Shift walk · Right-click use · F center view · Click or Enter fire / use item in hand · 1–9 belt · 0 nanokey ring · Esc menu' : 'Drag to look · Double-click to lock mouse · WASD fly · Q E down / up · Shift faster · Esc menu';
  $('scene').setAttribute('aria-label', mode === 'play' ? 'Game view. W A S D to move, Space to jump, X to crouch, right mouse to use, F to center view.' : 'Map inspection camera. W A S D to fly, Q E down and up.');
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

async function loadMap(name) {
  if (!assets || !assets.files.has(name.toLowerCase())) throw new Error(`Map is not available: ${name}`);
  if (loading) throw new Error('A map is already loading');
  loading = true; $('map').disabled = true; $('reset').disabled = true; $('choose').disabled = true;
  hideNpcFocus();
  $('toast').textContent = '';stopInfoLinkPresentation();
  document.exitPointerLock?.(); keys.clear();
  busy('Loading original map', `Reading ${name}…`);
  let nextWorld, nextGame, nextNpcPreview, nextWeaponViewModel, nextMeshLighting, nextGpuMesh = null;
  try {
    const asset = await assets.get(name);
    await new Promise(resolve => setTimeout(resolve, 0));
    const nextMap = decodeMap(asset.bytes);
    nextWorld = await createWorld(nextMap, asset, assets, (message, done, total) => {
      $('gate-message').textContent = message; $('progress').max = total; $('progress').value = done;
    });
    if (!nextWorld.counts.triangles) throw new Error(`No renderable surfaces found. ${nextWorld.errors[0]?.message ?? 'Check the selected map.'}`);
    try {
      nextGame = await createGame(nextMap, asset, assets, {
        presentation:true,
        subtitles: subtitlePreference,
        onLightingChanged: changes => nextWorld.updateLighting(changes),
        onConversationSpeech:event=>{void playConversationSpeech(event);},
        onAudioVoice:event=>{void galaxyVoice(event);},
      });
    }
    catch (error) { nextWorld.notes.push(`Play mode unavailable: ${error.message}`); }
    if(nextGame){
      const runtime=nextGame.doors.scriptRuntime.runtime;
      const byName=new Map(runtime.levelFor(nextGame.player.collisionActor).actors.filter(Boolean).map(actor=>[actor.name,actor]));
      nextWorld.root.traverse(mesh=>{
        const actor=mesh.isMesh&&byName.get(mesh.userData.actor);
        if(actor)mesh.onAfterRender=actorRenderFeedback(runtime,actor);
      });
    }
    if(nextGame){
      $('gate-message').textContent='Preparing original actor meshes…';
      try{
        const meshRuntime=nextGame.doors.scriptRuntime.runtime;
        const exportIndexByName=new Map(asset.pkg.exports.map((entry,i)=>[entry.name,i+1]));
        nextMeshLighting=createMeshLightingView(meshRuntime,()=>meshRuntime.levelFor(nextGame.player.collisionActor),
          {exportName:ref=>asset.pkg.exports[ref-1]?.name,exportIndex:name=>exportIndexByName.get(name)});
        if(gpuMeshParam==='1'||gpuMeshParam!=='0'&&!softwareRenderer()){
          try{nextGpuMesh=createGpuMesh(renderer);}
          catch(error){nextWorld.notes.push(`GPU mesh path unavailable: ${error.message}`);}
        }
        nextNpcPreview=await createActorMeshScene(nextGame.doors.scriptRuntime.runtime,assets,asset,{gpu:nextGpuMesh,
          // Player start logs in a new player; follow the current one.
          player:()=>nextGame.player.collisionActor,lighting:nextMeshLighting,displayGamma:nextWorld.displayGamma,
          childFrames:nextWorld.mirrors.stats.planes>0,
          ...(new URLSearchParams(location.search).get('meshBackend')==='javascript'?{kernel:null}:{})});
        nextMeshLighting.kernel=nextNpcPreview.kernel;
        nextWorld.notes.push(`${nextNpcPreview.summary.npcs} NPC and ${nextNpcPreview.summary.props} prop meshes render live original poses and original mesh lighting in Play. Distance LOD, Fatness, fog/volumetric lights and animated/procedural mesh skins remain unsupported.`);
        for(const error of nextNpcPreview.summary.errors)nextWorld.notes.push(`${error.actor}: ${error.message}`);
      }catch(error){nextWorld.notes.push(`Actor meshes unavailable: ${error.message}`);}
    }
    const nextHud=nextGame?.hud?await createHudRenderer(nextGame.hud,assets,await nextGame.doors.scriptRuntime.infoLinkShell()):null;
    if(nextGame)nextWeaponViewModel=await createWeaponViewModel(nextGame.doors.scriptRuntime.runtime,assets,()=>nextGame.player.collisionActor,
      {kernel:nextNpcPreview?.kernel??null,lighting:nextMeshLighting??null,displayGamma:nextWorld.displayGamma});
    // Sprites and particles (docs/particles.md), drawn from the live level.
    let nextSpriteScene=null;
    if(nextGame){
      const spriteRuntime=nextGame.doors.scriptRuntime.runtime;
      nextSpriteScene=createSpriteScene(spriteRuntime,new TextureStore(assets),{
        player:()=>nextGame.player.collisionActor,displayGamma:nextWorld.displayGamma,
        frand:()=>spriteRuntime.rng.frand(),
        constructIterator:(cls,outer)=>{
          const linked=[...spriteRuntime.linkedClasses].find(candidate=>candidate.record.key===(cls.key??cls.record?.key));
          if(!linked)throw new Error(`RenderIteratorClass ${cls.key} is not linked`);
          const base=spriteRuntime.actorLifecycle.construction,native=spriteRuntime.instance(outer).nativeObject;
          if(!native)throw new Error(`${outer.name} has no native object to own its RenderInterface`);
          // A pre-placed actor hashes its owned objects by its measured
          // GObjObjects index (docs/object-index-captures.md).
          if(!Number.isInteger(native.index)&&!Number.isInteger(native.hashIndex)){
            const measured=spriteRuntime.measuredObjectIndex(outer);
            if(!Number.isInteger(measured))throw new Error(`${outer.name} has no measured object index for its RenderInterface`);
            native.hashIndex=measured;
          }
          return spriteRuntime.constructObject(linked,{outer:native,name:'None',flags:0,template:null},{
            ...base,validate:()=>true,initNativeProperties:()=>{},nativeConstructor:()=>{}});
        }});
    }
    // Light coronas (docs/coronas.md), DrawFrame's corona pass.
    const nextCoronaPass=nextGame?createCoronaPass(nextGame.doors.scriptRuntime.runtime,new TextureStore(assets),{
      model:nextMap.model,exportName:ref=>asset.pkg.exports[ref-1]?.name,player:()=>nextGame.player.collisionActor,
      displayGamma:nextWorld.displayGamma}):null;
    coronaPass?.dispose();coronaPass=nextCoronaPass;
    if(spriteScene){scene.remove(spriteScene.root);spriteScene.dispose();}
    spriteScene=nextSpriteScene;
    if(spriteScene)scene.add(spriteScene.root);
    meshLighting=nextMeshLighting??null;
    hudRenderer?.dispose();hudRenderer=nextHud;
    weaponViewModel?.dispose();weaponViewModel=nextWeaponViewModel??null;
    if(npcPreview){scene.remove(npcPreview.root);npcPreview.dispose();npcPreview=null;}
    gpuMesh?.dispose();gpuMesh=nextGpuMesh;
    npcPreview=nextNpcPreview??null;
    if(npcPreview){npcPreview.root.visible=true;scene.add(npcPreview.root);}
    $('npc-focus').replaceChildren(...((npcPreview?.npcActors??npcPreview?.actors??[]).map(actor=>{
      const option=document.createElement('option');option.value=option.textContent=actor.summary.actor;return option;
    })));
    $('npc-status').hidden=!npcPreview;
    $('npc-status').textContent=npcPreview?`${npcPreview.summary.npcs??npcPreview.actors.length} NPCs · ${npcPreview.summary.props??0} props · live`:'';
    const lipSyncKernel = nextGame ? (await loadScriptVmKernel()).lipsync : null;
    if (world) { scene.remove(world.root); world.dispose(); }
    world = nextWorld; map = nextMap; currentMap = name; scene.add(world.root); revision++;
    lipSync = nextGame ? createLipSyncChannels({kernel: lipSyncKernel, ...nextGame.lipSyncServices()}) : null;
    game = nextGame;runtimeError=null; $('mode').options[0].disabled = !game; setMode(game ? mode : 'inspect'); paused = false;
    const training = Boolean(game) && name === '00_Training';
    setPreviewsAvailable({light: training, 'dark-door': training, npc: Boolean(npcPreview?.npcActors?.length),
      instructor: training, weapon: training, datacube: training, keypad: training});
    $('infolink-shell').hidden = true;
    world.displayGamma.value = 1 / (2.5 * Number($('brightness').value));
    resetCamera(); showStats();
    $('wireframe').checked = false; $('actor-markers').checked = false;
    $('lighting').checked = true;
    $('map').value = name; $('gate').hidden = true; $('reset').disabled = false;
    $('state').textContent = `${name} · ${world.textures} textures · ${world.counts.triangles.toLocaleString()} triangles`;
    if (world.errors.length) toast(`${world.errors.length} render issues — open Diagnostics for details.`);
  } catch (error) {
    if(nextWeaponViewModel&&nextWeaponViewModel!==weaponViewModel)nextWeaponViewModel.dispose();
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
    const files = Array.from(event.target.files, file => ({ path: file.webkitRelativePath || file.name, read: () => file.arrayBuffer() }));
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
$('subtitles').onchange = event => { subtitlePreference = event.target.checked; if (game) game.subtitles = subtitlePreference; };
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
    if (runtime.readNamed(pawn, 'FrobTarget') === target) { applyPlayerView(); return; }
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
    world.syncMovers(game.collision.movers);
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
    world.syncMovers(game.collision.movers);
    const open=pair.every(mover=>mover.interpolation.key===1);
    toast(`Dark-room doors ${open?'opened':'closed'} · original padoor fanout found 0 actors`);
    return result;
  } catch(error) { pauseForRuntimeError(error); }
};

function look(dx, dy) {
  if (mode === 'play' && game) {
    try { game.mouseMotion(dx, dy); cameraMoved = true; }
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
  try{return game.windowPointer(sample);}catch(error){pauseForRuntimeError(error);return true;}
}
$('scene').onpointerdown = event => {
  if (!world || loading) return;
  paused = mode === 'play' && Boolean(runtimeError); $('scene').focus();
  const windowHasMouse = windowPointer(event);
  if (mode === 'play' && game && !runtimeError) {
    const key = ['LeftMouse', 'MiddleMouse', 'RightMouse'][event.button];
    try { if (key) game.inputButton(key, true); }
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
  try { if (key) game.inputButton(key, false); }
  catch (error) { pauseForRuntimeError(error); }
};
$('scene').onpointercancel = () => { drag = false; game?.resetInput({releasePhysical:true}); };
$('scene').ondblclick = () => $('scene').requestPointerLock?.()?.catch?.(() => toast('Drag the view to look around.'));
document.addEventListener('pointermove', event => { if(windowPointer(event))return; if (document.pointerLockElement === $('scene') || drag) look(event.movementX, event.movementY); });
// UEngine::InputEvent (docs/script-console-command.md): Console.KeyEvent, then
// XInputExt::Process. A key the player's root window consumes (a grabbing
// modal such as the keypad or a menu) releases every held binding and reaches
// nothing else; any other key runs its binding (Escape=ShowMainMenu).
function inputKey(event, pressed) {
  if (mode !== 'play' || !game || runtimeError || !world || loading) return null;
  if (/INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) return null;
  try { return game.inputKey(event.code, pressed); }
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
document.addEventListener('keydown', event => {
  const input = inputKey(event, true);
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
document.addEventListener('pointerlockchange', () => { drag = false; keys.clear(); game?.resetInput(); });
document.addEventListener('keyup', event => {
  const input = inputKey(event, false);
  if (input?.consumed || (input?.handled && !input.host)) event.preventDefault();
  keys.delete(event.code);
});
window.addEventListener('blur', () => { keys.clear(); drag = false; paused = true; game?.resetInput({releasePhysical:true}); });
document.addEventListener('visibilitychange', () => { keys.clear(); if (document.hidden) { paused = true; game?.resetInput({releasePhysical:true}); } });
function status() {
  return { ready: Boolean(world) && !loading, map: currentMap ?? null, revision,
    textures: world?.textures ?? 0, renderErrors: world?.errors ?? [], triangles: world?.counts.triangles ?? 0,
    movers: world?.counts.movers ?? 0, position: fromView(camera.position.toArray()),
    mode, paused, runtimeError, gameplay: game?.status() ?? null,
    galaxy:{...galaxyAudio,voices:galaxyVoices.size},
    audio:{...audioTransport,contextState:infoLinkAudioContext?.state??'uninitialized',
      active:[...conversationAudio].map(([id,entry])=>({id,sound:entry.sound,started:Boolean(entry.source)}))},
    npcPreview:npcPreview?{...npcPreview.summary,visible:npcPreview.root.visible}:null,
    weaponViewModel:weaponViewModel?.summary??null,
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
} };

// Host frame-phase timing (docs/play-frame-cost.md): wall-clock ms per animate()
// phase, read and reset by deusExViewer.framePhases(). Measurement only.
const framePhases = { frames: 0, tick: 0, lighting: 0, actors: 0, mirrors: 0, render: 0, hud: 0, total: 0,
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
function animate(time) {
  requestAnimationFrame(animate);
  const dt = Math.max(0, (time - lastTime) / 1000); lastTime = time;
  const frameStart = phaseMark = performance.now();
  if (world && !loading) {
    let playerView = null, renderRect = null;
    const axis = (positive, negative) => positive.some(k => keys.has(k)) - negative.some(k => keys.has(k));
    const x = axis(['KeyD','ArrowRight'], ['KeyA','ArrowLeft']), z = axis(['KeyW','ArrowUp'], ['KeyS','ArrowDown']), y = axis(['KeyE'], ['KeyQ']);
    if (mode === 'play' && game) {
      if (!paused && !runtimeError && !document.hidden) {
        try { game.tick(dt); lipSync?.update(dt); }
        catch(error) { pauseForRuntimeError(error); }
      }
      world.syncMovers(game.collision.movers);
      if (!runtimeError) {
        try { world.syncMovingLights(game.movingLights(), game.collision.movers); } catch (error) { pauseForRuntimeError(error); }
      }
      try { playerView = applyPlayerView(); } catch (error) { pauseForRuntimeError(error); }
      if (playerView && !runtimeError) {
        const width = renderer.domElement.width, height = renderer.domElement.height;
        try { renderRect = game.renderViewport(width, height); } catch (error) { pauseForRuntimeError(error); }
        if (renderRect?.render && renderRect.width > 0 && renderRect.height > 0) setViewAspect(renderRect.width / renderRect.height, playerView.fov);
      }
      phase('tick');
      if (x || z || keys.has('Space') || keys.has('ControlLeft') || keys.has('ControlRight')) cameraMoved = true;
      const target = game.target();
      $('play-hint').textContent = runtimeError?.travel ? `Map ended · travel to ${runtimeError.travel.url} is Stage 6 · Player start replays`
      : runtimeError ? 'Play paused · Player start resets the scene' : paused ? 'Click the view to resume' : target ? `Right-click · ${target.label}` : '';
    } else if (x || y || z) {
      const forward = new THREE.Vector3(); camera.getWorldDirection(forward);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      velocity.copy(forward).multiplyScalar(z).addScaledVector(right, x); velocity.y += y;
      velocity.normalize().multiplyScalar(Math.min(dt, .05) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 900 : 240));
      camera.position.add(velocity); cameraMoved = true;
    }
    // Draw the current shared-runtime pose; rendering neither chooses an
    // animation nor advances NPC time — the script runtime owns both.
    // One lighting frame per main-viewport draw (docs/mesh-lighting.md).
    // Inspect's free camera lights meshes from its own view.
    if(meshLighting&&!runtimeError){
      const toUnits=radians=>Math.round(radians*32768/Math.PI);
      const view=playerView??{location:fromView(camera.position.toArray()),rotation:[toUnits(pitch),toUnits(-yaw),0]};
      try{meshLighting.beginFrame({location:view.location,rotation:view.rotation,seconds:time/1000});}
      catch(error){pauseForRuntimeError(error);}
    }
    phase('lighting');
    // The GPU timer starts before the actor layer, whose mesh passes
    // (docs/gpu-mesh.md) are GPU work submitted during this phase.
    gpuBegin();
    // SetupDynamics' actor scan (sprites and render iterators) runs first:
    // a LaserProxy, spawned after its emitter, is drawn as an actor where
    // this frame's LaserIterator left it (docs/lasers.md).
    let meshItems=[];
    if(spriteScene&&mode==='play'&&game&&!runtimeError){
      try{meshItems=spriteScene.update();}catch(error){pauseForRuntimeError(error);}
      spriteScene.root.visible=true;
    }else if(spriteScene)spriteScene.root.visible=false;
    if(npcPreview&&!runtimeError){
      camera.updateMatrixWorld();
      const frustum=new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
      const children=world.mirrors.mayRender(camera);
      try{npcPreview.update(fromView(camera.position.toArray()),{lit:Boolean(meshLighting?.frame),frustum,camera,
        cull:!children,children,items:meshItems});}catch(error){pauseForRuntimeError(error);}
    }
    phase('actors');
    renderer.info.reset();
    let panInputs = null;
    if (mode === 'play' && game && !runtimeError) {
      try { panInputs = game.surfacePan(); } catch (error) { pauseForRuntimeError(error); }
    }
    // Light-map animation skips light maps outside the view unless a mirror
    // may draw them.
    camera.updateMatrixWorld();
    const viewFrustum = world.mirrors.mayRender(camera) ? null : new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    world.updateTextureAnimation(undefined, { ...panInputs, viewpoint: fromView(camera.position.toArray()), frustum: viewFrustum });
    world.flushLighting(renderer);
    // Volumetric fog maps from this frame's eye and view rotation
    // (docs/volumetric-fog.md). Mirror views reuse the main frame's maps.
    if (world.fog?.stats.surfaces && !runtimeError) {
      const toUnits = radians => Math.round(radians * 32768 / Math.PI);
      const fogView = playerView ?? { location: fromView(camera.position.toArray()), rotation: [toUnits(pitch), toUnits(-yaw), 0] };
      try {
        world.fog.update(fogView, new THREE.Frustum().setFromProjectionMatrix(
          new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)));
      } catch (error) { pauseForRuntimeError(error); }
    }
    world.mirrors.render(renderer, scene, camera, { markers: world.markers, sky: world.sky,
      updateActors: npcPreview && !runtimeError ? (position, passCamera) => npcPreview.updateView(position, passCamera) : null });
    phase('mirrors');
    let calls = drawCalls(); framePhases.mirrorCalls += calls;
    renderer.setClearColor('#06101b', 1); renderer.clear();
    const drawWorld = !renderRect || (renderRect.render && renderRect.width > 0 && renderRect.height > 0);
    const clipped = drawWorld && renderRect && (renderRect.x || renderRect.y
      || renderRect.width !== renderer.domElement.width || renderRect.height !== renderer.domElement.height);
    if (clipped) {
      const box = renderViewportFor(renderRect);
      renderer.setViewport(...box); renderer.setScissor(...box); renderer.setScissorTest(true);
    }
    const sky = drawWorld ? skyFrame() : null;
    if (sky) {
      skyCamera.copy(camera); skyCamera.position.fromArray(toView(sky.location));
      skyCamera.quaternion.premultiply(new THREE.Quaternion().setFromEuler(rotatorEuler(sky.rotation)));
      const markersVisible = world.markers.visible; world.markers.visible = false;
      const npcVisible=npcPreview?.root.visible;if(npcPreview)npcPreview.root.visible=false;
      renderer.render(scene, skyCamera); world.markers.visible = markersVisible;
      if(npcPreview)npcPreview.root.visible=npcVisible;renderer.clearDepth();
      framePhases.skyCalls += drawCalls() - calls; calls = drawCalls();
    }
    if (drawWorld) renderer.render(scene, camera);
    // Coronas close DrawFrame, before PostRender's weapon and HUD.
    if (drawWorld && mode === 'play' && coronaPass && playerView && !runtimeError) {
      const pr = renderer.getPixelRatio(), box = clipped ? renderViewportFor(renderRect)
        : [0, 0, renderer.domElement.width / pr, renderer.domElement.height / pr];
      try { coronaPass.update(playerView, box[2], box[3]); coronaPass.render(renderer); }
      catch (error) { pauseForRuntimeError(error); }
    }
    framePhases.mainCalls += drawCalls() - calls; calls = drawCalls();
    if(drawWorld&&mode==='play'&&weaponViewModel&&!runtimeError){
      try{weaponViewModel.render(renderer,camera);}catch(error){pauseForRuntimeError(error);}
    }
    if (clipped) {
      const pr = renderer.getPixelRatio(), full = [0, 0, renderer.domElement.width / pr, renderer.domElement.height / pr];
      renderer.setViewport(...full); renderer.setScissor(...full); renderer.setScissorTest(false);
    }
    phase('render');
    if(mode==='play'&&hudRenderer&&playerView){
      hudRenderer.render(renderer,renderer.domElement.width,renderer.domElement.height,null,playerView);
      updateInfoLinkAccessibility();
    }
    gpuEnd();
    framePhases.hudCalls += drawCalls() - calls;
    phase('hud');
    $('crosshair').hidden=mode==='play'&&Boolean(hudRenderer);
    if ($('inspect').checked && time - lastInspect > 150) {
      lastInspect = time; raycaster.setFromCamera(new THREE.Vector2(), camera);
      const hit = raycaster.intersectObjects(world.root.children, true).find(h => h.object.isMesh);
      const surface = hit && (hit.object.userData.faceMaterials?.[hit.faceIndex] ?? hit.object.material.userData);
      $('surface-info').textContent = hit ? `${surface.key}\n${surface.width} × ${surface.height} · ${surface.mipCount} mips\nSurface ${hit.object.userData.faces[hit.faceIndex]} · ${hit.object.userData.actor ?? 'world'}\nFlags 0x${surface.flags.toString(16)}` : 'No surface under the crosshair.';
    }
  }
  framePhases.frames++; framePhases.total += performance.now() - frameStart;
  frameCount++;
  if (time - fpsTime > 1000) { $('performance').textContent = world ? `${Math.round(frameCount * 1000 / (time - fpsTime))} fps` : ''; frameCount = 0; fpsTime = time; }
}
requestAnimationFrame(animate);

if (import.meta.env.DEV) {
  try {
    const manifest = await fetch('/__game__/manifest').then(r => r.json());
    if (manifest.files.length) await setFiles([...manifest.files.map(path => ({ path, read: async () => {
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
