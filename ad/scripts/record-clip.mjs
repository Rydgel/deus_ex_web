// Real-time clips of Play with its sound (the promo/tweet clips): headless Chromium, Play's default worker mode, the 3D canvas
// and every Web Audio graph that reaches a destination recorded together by one in-page MediaRecorder, so picture and sound stay in sync.
//
//   node ad/scripts/record-clip.mjs probe                    # positions of the scenes' actors on Liberty Island
//   node ad/scripts/record-clip.mjs gunther --out ad/build/clips/gunther.webm
//   node ad/scripts/record-clip.mjs fight --out ad/build/clips/fight.webm
//
// The scenes are driven through the player's own inputs (keyboard, mouse buttons) after a placement (placeProbe), as the Stage 5 census does;
// `summon` (the original console cheat) gives the weapon. The game's HUD is shown; only the viewer's web UI is hidden.
// Clips contain original game content: they stay out of Git (ad/.gitignore).
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {mkdirSync, openSync, writeSync, closeSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2), scene = argv[0];
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const [width, height] = option('size', '1280x720').split('x').map(Number);
const MAP = '01_NYC_UNATCOIsland';

// Runs before any page module: every AudioNode connected to a context's destination is also connected to that context's tap.
const audioTap = () => {
  const connect = AudioNode.prototype.connect, taps = new Map();
  window.__audioTaps = taps;
  AudioNode.prototype.connect = function (target, ...rest) {
    const result = connect.call(this, target, ...rest);
    if (target instanceof AudioDestinationNode) {
      let tap = taps.get(this.context);
      if (!tap) { tap = this.context.createMediaStreamDestination(); taps.set(this.context, tap); }
      connect.call(this, tap);
    }
    return result;
  };
};

// In the page: the canvas at 60 fps and every tap mixed into one audio track, recorded in 1 s slices handed to the host.
const startRecorder = async ({bits}) => {
  const canvas = document.getElementById('scene');
  const mix = new AudioContext(), out = mix.createMediaStreamDestination();
  await mix.resume();
  for (const tap of window.__audioTaps.values()) mix.createMediaStreamSource(tap.stream).connect(out);
  const stream = new MediaStream([...canvas.captureStream(60).getVideoTracks(), ...out.stream.getAudioTracks()]);
  const recorder = new MediaRecorder(stream, {mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond: bits, audioBitsPerSecond: 192000});
  window.__recorder = recorder;
  recorder.ondataavailable = async event => {
    const bytes = new Uint8Array(await event.data.arrayBuffer());
    let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await window.__clipChunk(btoa(text));
  };
  window.__recorderDone = new Promise(resolve => { recorder.onstop = resolve; });
  recorder.start(1000);
  return {taps: window.__audioTaps.size, canvas: [canvas.width, canvas.height]};
};

async function openPlay() {
  const {default: config} = await import('../../vite.config.mjs');
  const server = await createServer({...config, configFile: false, root, logLevel: 'error', server: {...config.server, port: 0, strictPort: false, watch: null}});
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch({args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio']});
  const page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); } catch { /* storage unavailable */ } });
  await page.addInitScript(audioTap);
  await page.goto(`${url}/?seed=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.evaluate(map => { const menu = document.getElementById('map'); menu.value = map; menu.dispatchEvent(new Event('change')); }, MAP);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.mode === 'play'; }, MAP, {timeout: 300000});
  return {server, browser, page, errors};
}

const read = (page, names, props) => page.evaluate(([names, props]) => window.deusExViewer.liveProbe({read: {names, props}}), [names, props]).then(r => r.read ?? r);
const exec = (page, ...lines) => page.evaluate(lines => window.deusExViewer.viewProbe({exec: lines}), lines);
const place = (page, args) => page.evaluate(args => window.deusExViewer.placeProbe(args), args);
const wait = (page, ms) => page.waitForTimeout(ms);

if (scene === 'probe') {
  const {server, browser, page, errors} = await openPlay();
  try {
    await wait(page, 3000);
    console.log(JSON.stringify(await read(page, ['DeusExMover8', 'DeusExMover10', 'GuntherHermann0', 'Terrorist0', 'ThugMale7', '@player'], ['Location', 'Rotation', 'CollisionRadius']), null, 1));
    console.log(JSON.stringify(await page.evaluate(() => ({canvas: [document.getElementById('scene').width, document.getElementById('scene').height]}))));
    console.log('errors', errors);
  } finally { await browser.close(); await server.close(); }
  process.exit(0);
}
const units = rad => Math.round(rad * 32768 / Math.PI);
const wrap = v => ((v % 65536) + 65536) % 65536;
const shortest = (from, to) => { let d = wrap(to - from); if (d > 32768) d -= 65536; return d; };
const center = [width / 2, height / 2];

/** Turn the view to `rotation` ([pitch, yaw, roll] in Unreal units) over `ms`, a write per frame (the player's own ViewRotation, as a mouse would). */
async function turnTo(page, rotation, ms = 600) {
  const start = (await read(page, ['@player'], ['ViewRotation']))['@player'].ViewRotation;
  const steps = Math.max(1, Math.round(ms / 16));
  for (let k = 1; k <= steps; k++) {
    const t = k / steps, e = t * t * (3 - 2 * t);
    await place(page, {rotation: [wrap(start[0] + shortest(start[0], rotation[0]) * e), wrap(start[1] + shortest(start[1], rotation[1]) * e), 0]});
    await wait(page, 16);
  }
}
/** The view rotation from the player's eye to an actor's Location (placeProbe's lookAt, computed without writing). */
async function aimAt(page, name, ms = 250, lift = 0) {
  const r = await read(page, ['@player', name], ['Location', 'EyeHeight', 'BaseEyeHeight']);
  if (!r[name]?.Location) return false;
  const eye = r['@player'].Location.map((v, i) => v + (i === 2 ? r['@player'].EyeHeight : 0)), at = r[name].Location;
  const d = at.map((v, i) => v - eye[i] + (i === 2 ? lift : 0));
  await turnTo(page, [wrap(units(Math.atan2(d[2], Math.hypot(d[0], d[1])))), wrap(units(Math.atan2(d[1], d[0]))), 0], ms);
  return true;
}
const health = async (page, name) => (await read(page, [name], ['Health']))[name]?.Health ?? null;
const conversation = page => page.evaluate(() => window.deusExViewer.conversationProbe({}));

/** Summon an item in front of the player, look down at it and take it with the right button (the census's `give`). */
async function take(page, cls) {
  await place(page, {set: {actor: '$player', fields: {bCheatsEnabled: true}}});
  const before = (await read(page, ['@player'], ['ViewRotation']))['@player'].ViewRotation;
  await exec(page, `summon ${cls}`); await wait(page, 300);
  await turnTo(page, [wrap(-10130), before[1], 0], 200); await wait(page, 300);
  await page.mouse.click(...center, {button: 'right'}); await wait(page, 600);
  await turnTo(page, [0, before[1], 0], 200);
}

let markStart = 0;
const marks = [];
const mark = what => { const t = (Date.now() - markStart) / 1000; marks.push([what, t]); console.log(`mark ${what} ${t.toFixed(2)} s`); };
/** Put a carried item in hand with its belt key (the original ActivateBelt binding): the belt slot read from the player's Inventory chain. */
async function draw(page, cls) {
  let item = (await read(page, ['@player'], ['Inventory']))['@player'].Inventory, key = null;
  for (let k = 0; k < 16 && item && !key; k++) {
    const name = typeof item === 'string' ? item : item?.name;
    const r = (await read(page, [name], ['beltPos', 'Inventory']))[name];
    if (name?.startsWith(cls)) key = String(r.beltPos);
    item = r?.Inventory;
  }
  if (key === null) throw new Error(`no ${cls} carried`);
  await page.keyboard.press(key); await wait(page, 1500);
  return key;
}
async function record(page, out, body) {
  mkdirSync(path.dirname(out), {recursive: true});
  const fd = openSync(out, 'w');
  let bytes = 0;
  await page.exposeFunction('__clipChunk', b64 => { const b = Buffer.from(b64, 'base64'); writeSync(fd, b); bytes += b.length; });
  const info = await page.evaluate(startRecorder, {bits: Number(option('bits', 16e6))});
  console.log(`recording ${out}: canvas ${info.canvas.join('x')}, ${info.taps} audio graph(s)`);
  const started = Date.now(); markStart = started;
  try { await body(); } finally {
    await page.evaluate(async () => { window.__recorder.stop(); await window.__recorderDone; await new Promise(r => setTimeout(r, 1500)); });
    closeSync(fd);
    console.log(`${out}: ${((Date.now() - started) / 1000).toFixed(1)} s, ${(bytes / 1e6).toFixed(1)} MB`);
  }
}
async function settle(page) {
  // MissionScript.FirstFrame (M1MissionStart) runs a few seconds in: the level as a player finds it
  await wait(page, 6000);
  await page.focus('#scene');
  // the viewer's web UI is hidden (deusex.uiHidden); the game's HUD stays unless --no-hud (the original console command `ShowHud False`)
  await exec(page, 'KillAll FlyGenerator', ...(argv.includes('--no-hud') ? ['ShowHud False'] : []));
  // the viewer's brightness (the original's Brightness setting); --brightness, default the viewer's own
  if (option('brightness', null)) await page.evaluate(value => { const el = document.getElementById('brightness'); el.value = value; el.dispatchEvent(new Event('input')); }, option('brightness'));
}

async function gunther(page, out) {
  await settle(page);
  const weapon = option('weapon', 'WeaponPistol');
  if (!argv.includes('--unarmed')) { await take(page, weapon); await draw(page, weapon); }
  // the wall button beside the cell (DeusExMover8), where row 5.4.5's capture stands: looking down at it, the cell's wall is the door
  // --start x,y: where JC stands to press the button (default just inside the cell: the capture's own spot, 1952,-1796, reached with `ghost`, puts the eye in the
  // pillar west of the walk, and the pillar appears as he steps out of it)
  const [sx, sy] = option('start', '1950,-1815').split(',').map(Number);
  await place(page, {location: [sx, sy, -84.2], rotation: [wrap(-4500), 49152, 0]});
  await wait(page, 1500);
  await record(page, out, async () => {
    await wait(page, 1200);
    await aimAt(page, 'DeusExMover8', 900, 6); await wait(page, 500);
    await page.mouse.click(...center, {button: 'right'}); mark('button');
    await wait(page, 1600);
    // the door has swung: Gunther in the cell, then a real walk in (the conversation starts at some 57 units). --hop places the player in front of him
    // as row 5.4.5's capture does instead (a cut in the edit, and the walk's momentum shows in the conversation's first shot). Freed, he leaves after some 8 s unless it has started.
    await aimAt(page, 'GuntherHermann0', 900, 20); await wait(page, 400);
    let con = null;
    if (!argv.includes('--hop')) {
      // a real walk to him: one aim, then forward held without corrections (a re-aim mid-walk snaps the view), until the conversation starts
      await page.keyboard.down('w');
      for (let i = 0; i < 60 && con?.conPlay?.con !== 'GuntherRescued'; i++) {
        await wait(page, 100); con = await conversation(page);
        const r = await read(page, ['@player', 'GuntherHermann0'], ['Location', 'Velocity']);
        const d = Math.hypot(r['@player'].Location[0] - r.GuntherHermann0.Location[0], r['@player'].Location[1] - r.GuntherHermann0.Location[1]);
        console.log(`walk ${i}: distance ${d.toFixed(0)} speed ${Math.hypot(...r['@player'].Velocity.slice(0, 2)).toFixed(0)} con ${con?.conPlay?.con ?? '-'}`);
        if (d < Number(option('stop', 90))) { await page.keyboard.up('w'); }
      }
      await page.keyboard.up('w');
      for (let i = 0; i < 50 && con?.conPlay?.con !== 'GuntherRescued'; i++) { await wait(page, 100); con = await conversation(page); }
    } else {
      await page.keyboard.down('w'); await wait(page, 600); await page.keyboard.up('w');
      await wait(page, 350);
      mark('cut');
      await place(page, {location: [1885, -2180, -128], rotation: [0, 49152, 0], set: {actor: '$player', fields: {Velocity: [0, 0, 0], Acceleration: [0, 0, 0]}}});
      for (let i = 0; i < 60 && con?.conPlay?.con !== 'GuntherRescued'; i++) { await wait(page, 100); con = await conversation(page); }
    }
    mark('conversation');
    console.log('conversation:', con?.conPlay?.con ?? null);
    // the speeches play out at their own pace; a choice stays on screen a moment, then the first one is taken
    let last = '', chosen = 0;
    for (let i = 0; i < 900; i++) {
      await wait(page, 200); con = await conversation(page);
      if (!con.conPlay) break;
      const event = JSON.stringify(con.conPlay.event ?? {});
      if (event !== last) { last = event; console.log('event', event.slice(0, 160)); }
      if (event !== last || i === 0) {}
      if (con.conPlay.event?.cls === 'ConEventChoice' && chosen < 8) {
        mark('choice');
        await wait(page, 2500); await page.keyboard.press('Enter'); chosen++; await wait(page, 1000);
      }
    }
    mark('end');
    await wait(page, 3000);
  });
}

async function fight(page, out) {
  await settle(page);
  const weapon = option('weapon', 'WeaponAssaultGun');
  await take(page, weapon);
  for (let i = 0; i < Number(option('ammo', 2)); i++) await take(page, option('ammo-class', 'Ammo762mm'));
  if (option('god', null)) await exec(page, 'god');
  // the pickups' log lines fade before the scene starts
  await draw(page, weapon); await wait(page, Number(option('pre-wait', 7000)));
  // Terrorist0 stands on open ground facing yaw 8623; the player is placed in its view, `distance` units away
  const t = (await read(page, ['Terrorist0'], ['Location', 'Rotation'])).Terrorist0;
  const distance = Number(option('distance', 450)), bearing = t.Rotation[1] / 32768 * Math.PI + Number(option('bearing', 0)) * Math.PI / 180;
  await place(page, {location: [t.Location[0] + Math.cos(bearing) * distance, t.Location[1] + Math.sin(bearing) * distance, t.Location[2] + 4]});
  await wait(page, 300);
  await aimAt(page, 'Terrorist0', 50); await wait(page, 300);
  // the targets: every living pawn of the census within `range` of the player, nearest first, re-chosen before each burst
  const census = (await page.evaluate(() => window.deusExViewer.liveProbe({census: true}))).census;
  const names = census.pawns.map(p => p.name).filter(n => !/^JCDenton/i.test(n));
  const range = Number(option('range', 1100));
  const nearest = async () => {
    const r = await read(page, ['@player', ...names], ['Location', 'Health']);
    const me = r['@player'].Location;
    return names.map(n => [n, r[n]]).filter(([, a]) => a?.Location && a.Health > 0)
      .map(([n, a]) => [n, Math.hypot(a.Location[0] - me[0], a.Location[1] - me[1], a.Location[2] - me[2])])
      .filter(([, d]) => d < range).sort((x, y) => x[1] - y[1]);
  };
  const killed = [];
  await record(page, out, async () => {
    await wait(page, Number(option('lead', 1500)));
    const end = Date.now() + Number(option('seconds', 18)) * 1000;
    let current = null, quietSince = null;
    while (Date.now() < end) {
      const list = await nearest();
      if (current && !list.some(([n]) => n === current)) { killed.push(current); mark(`down ${current}`); }
      current = list[0]?.[0] ?? null;
      if (!current) { quietSince ??= Date.now(); if (Date.now() - quietSince > 2500) break; await wait(page, 200); continue; }
      quietSince = null;
      await aimAt(page, current, 140, Number(option('lift', 8)));
      await page.mouse.move(...center); await page.mouse.down();
      await wait(page, Number(option('burst', 450)));
      await page.mouse.up(); await wait(page, 220);
    }
    mark('end');
    await wait(page, 1500);
  });
  console.log('down:', killed.join(' '));
  console.log('player health:', await health(page, '@player'));
}

/** Stills to frame a scene: --shots "x,y,z,pitch,yaw;..." (a placement each), --frob K right-clicks after shot K, --wait ms between. */
async function look(page, out) {
  await settle(page);
  if (option('hud', null)) await exec(page, 'ShowHud True');
  const shots = option('shots', '').split(';').filter(Boolean).map(s => s.split(',').map(Number));
  mkdirSync(out, {recursive: true});
  for (const [k, [x, y, z, pitch, yaw]] of shots.entries()) {
    await place(page, {location: [x, y, z], rotation: [wrap(pitch), wrap(yaw), 0]});
    await wait(page, Number(option('wait', 1200)));
    const p = (await read(page, ['@player'], ['Location']))['@player'].Location.map(Math.round);
    await page.screenshot({path: path.join(out, `look-${k}.png`)});
    console.log(`look-${k}: asked ${[x, y, z]} stands ${p}`);
    if (option('movers', null)) {
      const names = option('movers').split(',');
      const st = await page.evaluate(() => window.deusExViewer.moverProbe({points: true}));
      for (const m of (st.movers ?? st.tracked ?? [])) if (names.includes(m.name) || names.includes('*')) {
        const nums = []; const walk = v => { if (typeof v === 'number') nums.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
        walk(m.points);
        const flat = []; for (let i = 0; i + 2 < nums.length; i += 3) flat.push(nums.slice(i, i + 3));
        const box = flat.length ? [0, 1, 2].map(i => [Math.min(...flat.map(p => p[i])), Math.max(...flat.map(p => p[i]))].map(Math.round)) : null;
        if (box && (!names.includes('*') || (box[0][1] > 1600 && box[0][0] < 2200 && box[1][1] > -2400 && box[1][0] < -1500))) console.log(`  ${m.name}: box ${JSON.stringify(box)}`);
      }
      if (!names.includes('*')) console.log('  ', JSON.stringify(await read(page, names, ['Location', 'Rotation', 'PrePivot', 'KeyNum', 'MoverEncroachType', 'bBlockPlayers', 'bBlockActors', 'bCollideActors', 'InitialState'])));
    }
    if (Number(option('frob', -1)) === k) { await page.mouse.click(...center, {button: 'right'}); await wait(page, 2500); await page.screenshot({path: path.join(out, `look-${k}-frob.png`)}); }
  }
}

const scenes = {gunther, fight, look};
if (!scenes[scene]) throw new Error(`unknown scene ${scene}`);
const {server, browser, page, errors} = await openPlay();
try {
  await scenes[scene](page, path.resolve(option('out', `ad/build/clips/${scene}.webm`)));
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  console.log('status:', JSON.stringify(await page.evaluate(() => { const s = window.deusExViewer.status(); return {paused: s.paused, runtimeError: s.runtimeError?.message ?? null}; })));
} finally { await browser.close(); await server.close(); }
