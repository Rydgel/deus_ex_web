import * as THREE from 'three';
import './style.css';
import { AssetStore } from '../unreal/assets.mjs';
import { decodeMap } from '../unreal/map.mjs';
import { toView, fromView } from '../unreal/geometry.mjs';
import { createWorld } from './world.mjs';
import { createGame } from './game.mjs';

const $ = id => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.autoClear = false;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 1, 65536), skyCamera = camera.clone();
camera.rotation.order = 'YXZ';
const raycaster = new THREE.Raycaster();
let assets, world, map, currentMap, loading = false, drag = false, yaw = 0, pitch = 0;
let game, mode = 'play', paused = false;
let revision = 0, lastTime = performance.now(), fpsTime = lastTime, frameCount = 0;
let cameraMoved = false, lastInspect = 0;
const keys = new Set(), velocity = new THREE.Vector3();
const busy = (title, message) => {
  $('gate').hidden = false; $('gate-title').textContent = title; $('gate-message').textContent = message;
  $('gate-choose').hidden = loading; $('progress').hidden = !loading;
};
function toast(message) { $('toast').textContent = message; setTimeout(() => { if ($('toast').textContent === message) $('toast').textContent = ''; }, 4000); }
function resize() {
  const box = $('viewport').getBoundingClientRect();
  renderer.setSize(box.width, box.height, false); camera.aspect = box.width / Math.max(1, box.height);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(75 / 2)) / camera.aspect));
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('viewport'));
function resetCamera() {
  if (!map) return;
  if (mode === 'play' && game) { game.reset(); world.syncMovers(game.collision.movers); }
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
  keys.clear(); game?.clock.reset();
  if (mode === 'play') camera.position.fromArray(toView(game.player.eye));
  $('play-hint').textContent = '';
  $('controls').textContent = mode === 'play' ? 'Drag to look · Double-click to lock mouse · WASD move · Space jump · Ctrl crouch · Shift walk · F or right-click use · Esc release' : 'Drag to look · Double-click to lock mouse · WASD fly · Q E down / up · Shift faster · Esc release';
  $('scene').setAttribute('aria-label', mode === 'play' ? 'Game view. W A S D to move, Space to jump, Control to crouch, F to use.' : 'Map inspection camera. W A S D to fly, Q E down and up.');
}
function useDoor() {
  if (mode !== 'play' || !game || loading) return;
  const result = game.use(); toast(result.message);
}
function showStats() {
  const pairs = [['Map', currentMap], ['World triangles', map.summary.triangles.toLocaleString()],
    ['Rendered triangles', world.counts.triangles.toLocaleString()], ['Textures', world.textures],
    ['Static doors / movers', world.counts.movers], ['Actors', map.actors.length],
    ['Lighting actors', world.lighting.lightActors], ['Lightmaps', world.lighting.lightmaps], ['Render errors', world.errors.length]];
  $('stats').replaceChildren(...pairs.flatMap(([label, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; return [dt, dd];
  }));
  $('notes').replaceChildren(...[...world.notes, ...(game?.notes ?? []), ...world.errors.slice(0, 10).map(e => `${e.actor ?? `Surface ${e.surface}`}: ${e.message}`)].map(message => {
    const li = document.createElement('li'); li.textContent = message; return li;
  }));
}

async function loadMap(name) {
  if (!assets || !assets.files.has(name.toLowerCase())) throw new Error(`Map is not available: ${name}`);
  if (loading) throw new Error('A map is already loading');
  loading = true; $('map').disabled = true; $('reset').disabled = true; $('choose').disabled = true;
  $('toast').textContent = '';
  document.exitPointerLock?.(); keys.clear();
  busy('Loading original map', `Reading ${name}…`);
  let nextWorld, nextGame;
  try {
    const asset = await assets.get(name);
    await new Promise(resolve => setTimeout(resolve, 0));
    const nextMap = decodeMap(asset.bytes);
    nextWorld = await createWorld(nextMap, asset, assets, (message, done, total) => {
      $('gate-message').textContent = message; $('progress').max = total; $('progress').value = done;
    });
    if (!nextWorld.counts.triangles) throw new Error(`No renderable surfaces found. ${nextWorld.errors[0]?.message ?? 'Check the selected map.'}`);
    try { nextGame = await createGame(nextMap, asset, assets); }
    catch (error) { nextWorld.notes.push(`Play mode unavailable: ${error.message}`); }
    if (world) { scene.remove(world.root); world.dispose(); }
    world = nextWorld; map = nextMap; currentMap = name; scene.add(world.root); revision++;
    game = nextGame; $('mode').options[0].disabled = !game; setMode(game ? mode : 'inspect'); paused = false;
    world.displayGamma.value = 1 / (2.5 * Number($('brightness').value));
    resetCamera(); showStats();
    $('wireframe').checked = false; $('actor-markers').checked = false;
    $('lighting').checked = true;
    $('map').value = name; $('gate').hidden = true; $('reset').disabled = false;
    $('state').textContent = `${name} · ${world.textures} textures · ${world.counts.triangles.toLocaleString()} triangles`;
    if (world.errors.length) toast(`${world.errors.length} render issues — open Diagnostics for details.`);
  } catch (error) {
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

function look(dx, dy) {
  yaw -= dx * .0025; pitch = THREE.MathUtils.clamp(pitch - dy * .0025, -Math.PI / 2 + .01, Math.PI / 2 - .01);
  camera.rotation.set(pitch, yaw, 0); cameraMoved = true;
}
$('scene').onpointerdown = event => { if (world && !loading) { paused = false; $('scene').focus(); if (event.button === 2) useDoor(); else { drag = true; $('scene').setPointerCapture(event.pointerId); } } };
$('scene').oncontextmenu = event => event.preventDefault();
$('scene').onpointerup = () => { drag = false; };
$('scene').onpointercancel = () => { drag = false; };
$('scene').ondblclick = () => $('scene').requestPointerLock?.()?.catch?.(() => toast('Drag the view to look around.'));
document.addEventListener('pointermove', event => { if (document.pointerLockElement === $('scene') || drag) look(event.movementX, event.movementY); });
document.addEventListener('keydown', event => {
  if (event.code === 'Escape') { document.exitPointerLock?.(); keys.clear(); drag = false; return; }
  if (!world || loading || /INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) return;
  if (event.code === 'KeyF' && !event.repeat) { useDoor(); event.preventDefault(); }
  if (['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight','Space','ControlLeft','ControlRight'].includes(event.code)) {
    paused = false;
    keys.add(event.code); event.preventDefault();
  }
});
document.addEventListener('pointerlockchange', () => { drag = false; keys.clear(); });
document.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => { keys.clear(); drag = false; paused = true; game?.clock.reset(); });
document.addEventListener('visibilitychange', () => { keys.clear(); game?.clock.reset(); if (document.hidden) paused = true; });
function status() {
  return { ready: Boolean(world) && !loading, map: currentMap ?? null, revision,
    textures: world?.textures ?? 0, renderErrors: world?.errors ?? [], triangles: world?.counts.triangles ?? 0,
    movers: world?.counts.movers ?? 0, position: fromView(camera.position.toArray()),
    mode, paused, gameplay: game?.status() ?? null,
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
      if (!paused && !document.hidden) game.tick(dt, { forward: z, right: x, yaw: -yaw, pitch, jump: keys.has('Space'),
        crouch: keys.has('ControlLeft') || keys.has('ControlRight'), walk: keys.has('ShiftLeft') || keys.has('ShiftRight') });
      world.syncMovers(game.collision.movers);
      camera.position.fromArray(toView(game.player.eye));
      if (x || z || keys.has('Space') || keys.has('ControlLeft') || keys.has('ControlRight')) cameraMoved = true;
      const target = game.target();
      $('play-hint').textContent = paused ? 'Click the view to resume' : target ? `F · ${target.label}` : '';
    } else if (x || y || z) {
      const forward = new THREE.Vector3(); camera.getWorldDirection(forward);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      velocity.copy(forward).multiplyScalar(z).addScaledVector(right, x); velocity.y += y;
      velocity.normalize().multiplyScalar(Math.min(dt, .05) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 900 : 240));
      camera.position.add(velocity); cameraMoved = true;
    }
    renderer.setClearColor('#06101b', 1); renderer.clear();
    if (world.sky) {
      skyCamera.copy(camera); skyCamera.position.fromArray(toView(world.sky));
      const markersVisible = world.markers.visible; world.markers.visible = false;
      renderer.render(scene, skyCamera); world.markers.visible = markersVisible; renderer.clearDepth();
    }
    renderer.render(scene, camera);
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
    if (manifest.files.length) await setFiles(manifest.files.map(path => ({ path, read: async () => {
      const response = await fetch(`/__game__/file/${encodeURIComponent(path)}`);
      if (!response.ok) throw new Error(`Cannot read ${path}`); return response.arrayBuffer();
    } })));
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
