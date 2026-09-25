import * as THREE from 'three';
import './style.css';
import { AssetStore } from '../unreal/assets.mjs';
import { readGlobalConfigBool } from '../unreal/user-config.mjs';
import { decodeMap } from '../unreal/map.mjs';
import { toView, fromView } from '../unreal/geometry.mjs';
import { createWorld } from './world.mjs';
import { createGame } from './game.mjs';
import { createHudRenderer } from './hud.mjs';
import { createActorMeshScene } from './npc-mesh-preview.mjs';
import { createWeaponViewModel } from './weapon-view-model.mjs';
import { actorRenderFeedback } from './actor-render-feedback.mjs';
import {pointerButtonKey,windowPointerSample} from './window-pointer.mjs';

const $ = id => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.autoClear = false;
renderer.info.autoReset=false;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 1, 65536), skyCamera = camera.clone();
camera.rotation.order = 'YXZ';
const raycaster = new THREE.Raycaster();
let assets, world, map, currentMap, loading = false, drag = false, yaw = 0, pitch = 0;
let subtitlePreference = false;
let game, mode = 'play', paused = false, runtimeError = null;
let hudRenderer=null,activeInfoLinkShell=null;
let npcPreview=null;
let weaponViewModel=null;
let infoLinkAudioContext=null,infoLinkAudioSources=new Set();
const conversationAudio=new Map();
function stopConversationAudio(id){
  for(const [key,entry] of conversationAudio)if(id===undefined||id===key){
    entry.cancelled=true;entry.source?.stop();conversationAudio.delete(key);
  }
}
async function playConversationSpeech(event){
  stopConversationAudio(event.id);
  if(event.kind==='stop')return;
  const entry={cancelled:false,source:null};conversationAudio.set(event.id,entry);
  try{
    const context=await activateInfoLinkAudio(),bytes=event.audio.bytes;
    const buffer=await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    if(entry.cancelled)return;
    const source=context.createBufferSource();entry.source=source;source.buffer=buffer;
    source.playbackRate.value=event.parameters[2]/100;
    const gain=context.createGain();gain.gain.value=event.parameters[0]/100;
    source.connect(gain);gain.connect(context.destination);
    source.onended=()=>{if(conversationAudio.get(event.id)===entry)conversationAudio.delete(event.id);};
    source.start();
  }catch(error){if(entry.cancelled)return;conversationAudio.delete(event.id);pauseForRuntimeError(error);}
}
let infoLinkAnimationFrame=0,infoLinkRunToken=0;
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
function stopInfoLinkAudio(){for(const source of infoLinkAudioSources){try{source.stop();}catch{}}infoLinkAudioSources.clear();}
async function playInfoLinkAudio(audio,context=null,isCurrent=()=>true){
  if(!audio?.startCue?.bytes?.byteLength||!audio?.bytes?.byteLength)
    throw new Error('The original DataLink audio payloads are unavailable');
  context??=await activateInfoLinkAudio();
  stopInfoLinkAudio();
  const decode=bytes=>context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const [startBuffer,speechBuffer]=await Promise.all([decode(audio.startCue.bytes),decode(audio.bytes)]);
  if(!isCurrent())return null;
  const schedule=(buffer,when)=>{const source=context.createBufferSource();source.buffer=buffer;
    source.connect(context.destination);infoLinkAudioSources.add(source);
    source.onended=()=>infoLinkAudioSources.delete(source);source.start(when);};
  const now=context.currentTime;schedule(startBuffer,now);schedule(speechBuffer,now+audio.speechDelaySeconds);
  return {context,startTime:now};
}
function stopInfoLinkPresentation(){
  stopConversationAudio();
  activeInfoLinkShell=null;
  infoLinkRunToken++;
  if(infoLinkAnimationFrame)cancelAnimationFrame(infoLinkAnimationFrame);
  infoLinkAnimationFrame=0;
  $('infolink-shell').hidden=true;
  stopInfoLinkAudio();
}
function startInfoLinkPresentation(shell){
  activeInfoLinkShell=shell;
  const token=++infoLinkRunToken;
  const frame=()=>{
    if(token!==infoLinkRunToken)return;
    const state=game?.doors?.scriptRuntime?.dataLinkPresentation?.();
    if(!state){$('infolink-shell').hidden=true;infoLinkAnimationFrame=0;return;}
    // The WebGL HUD draws the original art; this region exposes its text to
    // assistive technology without a second visual dialog.
    $('infolink-shell').hidden=!state.shellVisible;
    $('infolink-title').textContent=state.title;
    $('infolink-queued').textContent=state.queuedText??'';
    $('infolink-text').textContent=state.text;
    if(state.phase==='destroyed'){
      infoLinkAnimationFrame=0;stopInfoLinkAudio();
      return;
    }
    infoLinkAnimationFrame=requestAnimationFrame(frame);
  };
  frame();
}
function resize() {
  const box = $('viewport').getBoundingClientRect();
  renderer.setSize(box.width, box.height, false); camera.aspect = box.width / Math.max(1, box.height);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(75 / 2)) / camera.aspect));
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('viewport'));
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
  if (mode === 'play' && game) camera.position.fromArray(toView(game.player.eye));
}
function setMode(next) {
  mode = next === 'play' && game ? 'play' : 'inspect'; $('mode').value = mode;
  if(mode==='play')hideNpcFocus();
  keys.clear();
  if (mode === 'play') camera.position.fromArray(toView(game.player.eye));
  $('play-hint').textContent = '';
  $('controls').textContent = mode === 'play' ? 'Drag to look · Double-click to lock mouse · WASD move · Space jump · Ctrl crouch · Shift walk · F or right-click use · Click or Enter fire / use item in hand · 1–9 belt · 0 nanokey ring · Esc release' : 'Drag to look · Double-click to lock mouse · WASD fly · Q E down / up · Shift faster · Esc release';
  $('scene').setAttribute('aria-label', mode === 'play' ? 'Game view. W A S D to move, Space to jump, Control to crouch, F to use.' : 'Map inspection camera. W A S D to fly, Q E down and up.');
}
function useDoor() {
  if (mode !== 'play' || !game || loading || runtimeError) return;
  try { const result = game.use(); toast(result.message); }
  catch(error) { pauseForRuntimeError(error); }
}
function pauseForRuntimeError(error) {
  stopConversationAudio();
  runtimeError={message:error.message,stack:error.stack};paused=true;
  keys.clear();drag=false;document.exitPointerLock?.();
  showStats();
  $('toast').textContent=`Play paused: ${error.message}. Choose Player start to reset.`;
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
  let nextWorld, nextGame, nextNpcPreview, nextWeaponViewModel;
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
        onDataLinkTransmission: event => {
          if(event.kind!=='started')return;
          queueMicrotask(()=>playInfoLinkTransmission(event));
        },
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
        nextNpcPreview=await createActorMeshScene(nextGame.doors.scriptRuntime.runtime,assets,asset,{
          player:nextGame.player.collisionActor,
          ...(new URLSearchParams(location.search).get('meshBackend')==='javascript'?{kernel:null}:{})});
        nextWorld.notes.push(`${nextNpcPreview.summary.npcs} NPC and ${nextNpcPreview.summary.props} prop meshes render live original poses in Play. Original mesh lighting, distance LOD and animated/procedural mesh skins remain unsupported.`);
        for(const error of nextNpcPreview.summary.errors)nextWorld.notes.push(`${error.actor}: ${error.message}`);
      }catch(error){nextWorld.notes.push(`Actor meshes unavailable: ${error.message}`);}
    }
    const nextHud=nextGame?.hud?await createHudRenderer(nextGame.hud,assets,await nextGame.doors.scriptRuntime.infoLinkShell()):null;
    if(nextGame)nextWeaponViewModel=await createWeaponViewModel(nextGame.doors.scriptRuntime.runtime,assets,nextGame.player.collisionActor);
    hudRenderer?.dispose();hudRenderer=nextHud;
    weaponViewModel?.dispose();weaponViewModel=nextWeaponViewModel??null;
    if(npcPreview){scene.remove(npcPreview.root);npcPreview.dispose();npcPreview=null;}
    npcPreview=nextNpcPreview??null;
    if(npcPreview){npcPreview.root.visible=true;scene.add(npcPreview.root);}
    $('npc-focus').replaceChildren(...((npcPreview?.npcActors??npcPreview?.actors??[]).map(actor=>{
      const option=document.createElement('option');option.value=option.textContent=actor.summary.actor;return option;
    })));
    $('npc-status').hidden=!npcPreview;
    $('npc-status').textContent=npcPreview?`${npcPreview.summary.npcs??npcPreview.actors.length} NPCs · ${npcPreview.summary.props??0} props · live`:'';
    if (world) { scene.remove(world.root); world.dispose(); }
    world = nextWorld; map = nextMap; currentMap = name; scene.add(world.root); revision++;
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

// Viewer test navigation only. Original startup, targeting and Frob still run;
// no keys, doors, flags, target or conversation state are assigned here.
previews.instructor=()=>{
  if(!game||loading||currentMap!=='00_Training')return;
  try{
    setMode('play');resetCamera();
    const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor;
    const instructor=runtime.levelFor(player).actors.find(actor=>actor?.name==='UNATCOTroop3');
    if(!instructor)throw new Error('Training instructor is unavailable');
    const location=runtime.namedReference(instructor,'Location').get();
    game.collision.queries.changeActor(player,()=>{
      game.player.position=[location[0]-80,location[1],location[2]];
      game.player.velocity=[0,0,0];
    });
    yaw=0;pitch=-.3;camera.rotation.set(pitch,yaw,0);
    camera.position.fromArray(toView(game.player.eye));
    drag=false;document.exitPointerLock?.();togglePanel(false);$('scene').focus();
    void activateInfoLinkAudio().catch(error=>pauseForRuntimeError(error));
    toast('Instructor preview · wait a few seconds, then press F to speak. Player start returns to the beginning.');
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
    const location = runtime.namedReference(crowbar, 'Location').get();
    game.collision.queries.changeActor(player, () => {
      game.player.position = [location[0] - 48, location[1], location[2]];
      game.player.velocity = [0, 0, 0];
    });
    yaw = 0; pitch = -0.15; camera.rotation.set(pitch, yaw, 0);
    camera.position.fromArray(toView(game.player.eye));
    drag = false; document.exitPointerLock?.(); togglePanel(false); $('scene').focus();
    game.interaction.frobTarget = crowbar;
    const picked = game.use();
    const belt=game.hud.read(game.hud.hud,'belt');
    const position=game.hud.read(belt,'objects').findIndex(slot=>game.hud.read(slot,'item')===crowbar);
    const equipped = await game.activateBelt(position);
    const crate=runtime.levelFor(player).actors.find(actor=>actor?.name==='CrateBreakableMedGeneral1');
    const at=runtime.namedReference(crate,'Location').get();
    // This diagnostic placement matches validate-crowbar-crate's measured
    // reachable trace, while every swing still runs through public input/ticks.
    game.collision.queries.changeActor(player,()=>{
      game.player.position=[at[0],at[1]+64,-128+43+0.2];game.player.velocity=[0,0,0];
    });
    yaw=Math.PI/2;pitch=Math.atan2(at[2]-(game.player.position[2]+40),64);
    camera.rotation.set(pitch,yaw,0);camera.position.fromArray(toView(game.player.eye));
    toast(`${picked.message || 'Crowbar'} · ${equipped.ok ? 'Click or press Enter twice to break the crate' : 'select from the object belt'}`);
  } catch (error) { pauseForRuntimeError(error); }
};

// Places Play in front of DataCube0 (the paddoor code) and aims at it. Reading
// is the normal F key: ParseRightClick -> DoFrob -> InformationDevices.Frob.
previews.datacube = () => {
  if (!game || loading || currentMap !== '00_Training') return;
  try {
    setMode('play'); resetCamera();
    const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
    const cube = runtime.levelFor(player).actors.find(actor => actor?.name === 'DataCube0');
    if (!cube) throw new Error('Training DataCube0 is unavailable');
    const at = runtime.namedReference(cube, 'Location').get();
    game.collision.queries.changeActor(player, () => {
      game.player.position = [at[0] - 56, at[1], at[2] + 48];
      game.player.velocity = [0, 0, 0];
    });
    for (let frame = 0; frame < 30; frame++)
      game.tick(1 / 60, {forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false});
    yaw = 0; pitch = Math.atan2(at[2] - game.player.eye[2], 56);
    camera.rotation.set(pitch, yaw, 0); camera.position.fromArray(toView(game.player.eye));
    drag = false; document.exitPointerLock?.(); togglePanel(false); $('scene').focus();
    // The highlight a tick computes from this aim; set here like the crowbar preview.
    game.interaction.frobTarget = cube;
    toast('DataCube preview · press F to read it; walk away or press F again to close.');
  } catch (error) { pauseForRuntimeError(error); }
};

previews.keypad = () => {
  if (!game || loading || currentMap !== '00_Training') return;
  try {
    setMode('play'); resetCamera();
    const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
    const keypad = runtime.levelFor(player).actors.find(actor => actor?.name === 'Keypad0');
    if (!keypad) throw new Error('Training Keypad0 is unavailable');
    const at = runtime.namedReference(keypad, 'Location').get();
    game.collision.queries.changeActor(player, () => {
      game.player.position = [at[0] - 48, at[1], at[2]];
      game.player.velocity = [0, 0, 0];
    });
    for (let frame = 0; frame < 30; frame++)
      game.tick(1 / 60, {forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false});
    yaw = 0; pitch = Math.atan2(at[2] - game.player.eye[2], 48);
    camera.rotation.set(pitch, yaw, 0); camera.position.fromArray(toView(game.player.eye));
    drag = false; document.exitPointerLock?.(); togglePanel(false); $('scene').focus();
    game.interaction.frobTarget = keypad;
    toast('Keypad preview · press F to open it, then type the DataCube code 0012.');
  } catch (error) { pauseForRuntimeError(error); }
};

previews.light = () => {
  if (!game || loading || currentMap !== '00_Training') return;
  try {
    const runtime=game.doors.scriptRuntime.runtime;
    const player=game.player.collisionActor;
    const lightSwitch=runtime.levelFor(player).actors.find(actor=>actor?.name==='LightSwitch0');
    if (!lightSwitch) throw new Error('Training light switch is unavailable');
    const location=runtime.namedReference(lightSwitch,'Location').get();
    setCamera({position:[location[0]-178,location[1],location[2]+35],rotation:[-2000,0,0]});
    game.doors.scriptRuntime.dispatchEvent(lightSwitch,'Frob',[player,null]);
    game.tick(.4,{forward:0,right:0,yaw:game.player.yaw,pitch:0,jump:false,crouch:false,walk:false});
    world.syncMovers(game.collision.movers);
    const lit=runtime.levelFor(player).actors.some(actor=>actor&&/^TriggerLight[0-3]$/.test(actor.name)&&
      runtime.namedReference(actor,'LightBrightness').get()>0);
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
    setCamera({position:[4160,848,-105],rotation:[0,0,0]});
    game.interaction.frobTarget=pair[0];
    const result=game.use();
    for(let frame=0;frame<260;frame++)game.tick(1/120,{});
    world.syncMovers(game.collision.movers);
    const open=pair.every(mover=>mover.interpolation.key===1);
    toast(`Dark-room doors ${open?'opened':'closed'} · original padoor fanout found 0 actors`);
    return result;
  } catch(error) { pauseForRuntimeError(error); }
};

async function playInfoLinkTransmission({tag='DataLink'}={}){
  if(!game||loading||currentMap!=='00_Training')return;
  const request=++infoLinkRunToken,sourceGame=game;
  const isCurrent=()=>request===infoLinkRunToken&&game===sourceGame;
  try{
    const audioContext=await activateInfoLinkAudio();
    const shell=await sourceGame.doors.scriptRuntime.infoLinkShell();
    if(!isCurrent())return;
    const presentation=sourceGame.doors.scriptRuntime.dataLinkPresentation?.();
    const audio=await playInfoLinkAudio(presentation?.audio??shell.audio,audioContext,isCurrent);
    if(!audio||!isCurrent())return;
    startInfoLinkPresentation(shell);
  }catch(error){if(isCurrent())pauseForRuntimeError(error);}
}

function look(dx, dy) {
  yaw -= dx * .0025; pitch = THREE.MathUtils.clamp(pitch - dy * .0025, -Math.PI / 2 + .01, Math.PI / 2 - .01);
  camera.rotation.set(pitch, yaw, 0); cameraMoved = true;
}
// LeftMouse is bound to `ParseLeftClick|Fire` (installed User.ini). With the
// pointer locked, press/release are the button edges; unlocked, left-drag
// stays mouse look and a click without movement fires on release.
let clickStart = null;
function pressFire() {
  if (mode !== 'play' || !game || loading || runtimeError) return;
  try { const result = game.pressFire(); if (result?.message) toast(result.message); }
  catch (error) { pauseForRuntimeError(error); }
}
function releaseFire() {
  if (mode !== 'play' || !game || loading) return;
  try { game.releaseFire(); } catch (error) { pauseForRuntimeError(error); }
}
function windowPointer(event,action=null){
  if(mode!=='play'||!game||runtimeError||!world||loading)return false;
  const canvas=$('scene'),sample=windowPointerSample(event,canvas.getBoundingClientRect(),
    renderer.domElement.width,renderer.domElement.height,document.pointerLockElement===canvas);
  if(action!==null){const key=pointerButtonKey(event.button);if(key<0)return false;sample.key=key;sample.action=action;}
  try{return game.windowPointer(sample);}catch(error){pauseForRuntimeError(error);return true;}
}
$('scene').onpointerdown = event => { if (world && !loading) { paused = mode==='play'&&Boolean(runtimeError); $('scene').focus();
  if(windowPointer(event,1)){keys.clear();drag=false;clickStart=null;$('scene').setPointerCapture(event.pointerId);event.preventDefault();return;}
  if (event.button === 2) useDoor(); else if (event.button === 0 && document.pointerLockElement === $('scene')) pressFire(); else { drag = true; clickStart = { x: event.clientX, y: event.clientY }; $('scene').setPointerCapture(event.pointerId); } } };
$('scene').oncontextmenu = event => event.preventDefault();
$('scene').onpointerup = event => {
  drag = false;
  if(windowPointer(event,3)){clickStart=null;event.preventDefault();return;}
  if (event.button !== 0) return;
  if (document.pointerLockElement === $('scene')) { releaseFire(); return; }
  const moved = clickStart && Math.hypot(event.clientX - clickStart.x, event.clientY - clickStart.y);
  clickStart = null;
  if (moved !== null && moved < 4) { pressFire(); releaseFire(); }
};
$('scene').onpointercancel = () => { drag = false; };
$('scene').ondblclick = () => $('scene').requestPointerLock?.()?.catch?.(() => toast('Drag the view to look around.'));
document.addEventListener('pointermove', event => { if(windowPointer(event))return; if (document.pointerLockElement === $('scene') || drag) look(event.movementX, event.movementY); });
// Keys whose User.ini binding Play replaces with its own stand-in: movement
// (UInput's axis/button system is not implemented), F use, Enter fire and the
// 0-9 belt keys.
const HOST_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'Space', 'ControlLeft', 'ControlRight', 'KeyF', 'Enter',
  ...Array.from({length: 10}, (_, digit) => `Digit${digit}`)];
// UEngine::InputEvent (docs/script-console-command.md): Console.KeyEvent, then
// XInputExt::Process. A key the player's root window consumes (a grabbing
// modal such as the keypad or a menu) releases every held binding and reaches
// nothing else; any other key runs its binding (Escape=ShowMainMenu).
function inputKey(event, pressed) {
  if (mode !== 'play' || !game || runtimeError || !world || loading) return null;
  if (/INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) return null;
  try { return game.inputKey(event.code, pressed, {hostCodes: HOST_KEYS}); }
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
    if (!HOST_KEYS.includes(event.code)) { if (input.handled) event.preventDefault(); return; }
  } else if (event.code === 'Escape') { document.exitPointerLock?.(); keys.clear(); drag = false; return; }
  if (!world || loading || /INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) return;
  if (event.code === 'KeyF' && !event.repeat) { useDoor(); event.preventDefault(); }
  // Enter shares LeftMouse's `ParseLeftClick|Fire` binding.
  if (event.code === 'Enter' && !event.repeat && mode === 'play' && game && !runtimeError) {
    pressFire();
    event.preventDefault();
  }
  if (/^Digit[0-9]$/.test(event.code) && !event.repeat && mode === 'play' && game && !runtimeError) {
    const position=Number(event.code.slice(5));
    (async()=>{try{await game.activateBelt(position);}catch(error){pauseForRuntimeError(error);}})();
    event.preventDefault();
  }
  if (['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight','Space','ControlLeft','ControlRight'].includes(event.code)) {
    if(mode==='play'&&runtimeError){event.preventDefault();return;}
    if(mode==='play'&&currentMap==='00_Training')activateInfoLinkAudio().catch(()=>{});
    paused = false;
    keys.add(event.code); event.preventDefault();
  }
});
document.addEventListener('pointerlockchange', () => { drag = false; keys.clear(); });
document.addEventListener('keyup', event => {
  const input = inputKey(event, false);
  if (input?.consumed || (input?.handled && !input.host)) event.preventDefault();
  keys.delete(event.code); if (event.code === 'Enter') releaseFire();
});
window.addEventListener('blur', () => { keys.clear(); drag = false; paused = true; game?.resetInput(); });
document.addEventListener('visibilitychange', () => { keys.clear(); if (document.hidden) { paused = true; game?.resetInput(); } });
function status() {
  return { ready: Boolean(world) && !loading, map: currentMap ?? null, revision,
    textures: world?.textures ?? 0, renderErrors: world?.errors ?? [], triangles: world?.counts.triangles ?? 0,
    movers: world?.counts.movers ?? 0, position: fromView(camera.position.toArray()),
    mode, paused, runtimeError, gameplay: game?.status() ?? null,
    npcPreview:npcPreview?{...npcPreview.summary,visible:npcPreview.root.visible}:null,
    weaponViewModel:weaponViewModel?.summary??null,
    lighting: world?.lighting ?? null, lightingEnabled: Boolean(world?.lightingEnabled.value), horizontalFOV: 75,
    brightness: Number($('brightness').value), displayGamma: world?.displayGamma.value ?? null,
    rotation: [pitch, yaw], wireframe: $('wireframe').checked, actorMarkers: $('actor-markers').checked, cameraMoved,
    calls: renderer.info.render.calls, frame: renderer.info.render.frame,
  };
}
// A small read-only diagnostic hook also makes browser regressions reproducible.
window.deusExViewer = { status };

function animate(time) {
  requestAnimationFrame(animate);
  const dt = Math.max(0, (time - lastTime) / 1000); lastTime = time;
  if (world && !loading) {
    const axis = (positive, negative) => positive.some(k => keys.has(k)) - negative.some(k => keys.has(k));
    const x = axis(['KeyD','ArrowRight'], ['KeyA','ArrowLeft']), z = axis(['KeyW','ArrowUp'], ['KeyS','ArrowDown']), y = axis(['KeyE'], ['KeyQ']);
    if (mode === 'play' && game) {
      if (!paused && !runtimeError && !document.hidden) {
        try { game.tick(dt, { forward: z, right: x, yaw: -yaw, pitch, jump: keys.has('Space'),
          crouch: keys.has('ControlLeft') || keys.has('ControlRight'), walk: keys.has('ShiftLeft') || keys.has('ShiftRight') }); }
        catch(error) { pauseForRuntimeError(error); }
      }
      world.syncMovers(game.collision.movers);
      camera.position.fromArray(toView(game.player.eye));
      if (x || z || keys.has('Space') || keys.has('ControlLeft') || keys.has('ControlRight')) cameraMoved = true;
      const target = game.target();
      $('play-hint').textContent = runtimeError ? 'Play paused · Player start resets the scene' : paused ? 'Click the view to resume' : target ? `F · ${target.label}` : '';
    } else if (x || y || z) {
      const forward = new THREE.Vector3(); camera.getWorldDirection(forward);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      velocity.copy(forward).multiplyScalar(z).addScaledVector(right, x); velocity.y += y;
      velocity.normalize().multiplyScalar(Math.min(dt, .05) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 900 : 240));
      camera.position.add(velocity); cameraMoved = true;
    }
    // Draw the current shared-runtime pose; rendering neither chooses an
    // animation nor advances NPC time — the script runtime owns both.
    if(npcPreview&&!runtimeError){
      try{npcPreview.update(fromView(camera.position.toArray()));}catch(error){pauseForRuntimeError(error);}
    }
    renderer.info.reset();
    renderer.setClearColor('#06101b', 1); renderer.clear();
    if (world.sky) {
      skyCamera.copy(camera); skyCamera.position.fromArray(toView(world.sky));
      const markersVisible = world.markers.visible; world.markers.visible = false;
      const npcVisible=npcPreview?.root.visible;if(npcPreview)npcPreview.root.visible=false;
      renderer.render(scene, skyCamera); world.markers.visible = markersVisible;
      if(npcPreview)npcPreview.root.visible=npcVisible;renderer.clearDepth();
    }
    renderer.render(scene, camera);
    if(mode==='play'&&weaponViewModel&&!runtimeError){
      try{weaponViewModel.render(renderer,camera);}catch(error){pauseForRuntimeError(error);}
    }
    if(mode==='play'&&hudRenderer){
      const box=$('viewport').getBoundingClientRect();
      hudRenderer.render(renderer,renderer.domElement.width,renderer.domElement.height,{shell:activeInfoLinkShell,state:activeInfoLinkShell?game.doors.scriptRuntime.dataLinkPresentation():null},{location:game.player.eye,rotation:game.player.viewRotation,fov:75});
    }
    $('crosshair').hidden=mode==='play'&&Boolean(hudRenderer);
    if ($('inspect').checked && time - lastInspect > 150) {
      lastInspect = time; raycaster.setFromCamera(new THREE.Vector2(), camera);
      const hit = raycaster.intersectObjects(world.root.children, true).find(h => h.object.isMesh);
      $('surface-info').textContent = hit ? `${hit.object.material.userData.key}\n${hit.object.material.userData.width} × ${hit.object.material.userData.height} · ${hit.object.material.userData.mipCount} mips\nSurface ${hit.object.userData.faces[hit.faceIndex]} · ${hit.object.userData.actor ?? 'world'}\nFlags 0x${hit.object.material.userData.flags.toString(16)}` : 'No surface under the crosshair.';
    }
  }
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
