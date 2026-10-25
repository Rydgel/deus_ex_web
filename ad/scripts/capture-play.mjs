// Footage of Play for the promo, 1920x1080 at 30 fps under the virtual clock (play-lib.mjs): every output frame is two exact
// 1/60 s simulation steps, written as ad/captures/play/<clip>/f0000.jpg. The game's HUD stays; the viewer's web UI is hidden.
//
//   node ad/scripts/capture-play.mjs intro       00_Intro from its first frame: the windows below, by level time, then the
//                                                logo map it travels to
// Captures contain original game content: they stay out of Git (ad/.gitignore).
import {mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPlay, read, exec, place, conversation, step, enableClock, disableClock, units, wrap, shortest} from './play-lib.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const OUT = path.join(repo, 'ad/captures/play');
const argv = process.argv.slice(2), scene = argv[0];

function clipWriter(page, name) {
  const dir = path.join(OUT, name);
  rmSync(dir, {recursive: true, force: true});
  mkdirSync(dir, {recursive: true});
  let k = 0;
  return {
    get count() { return k; },
    shot: () => page.screenshot({path: path.join(dir, `f${String(k++).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92}),
  };
}
const levelTime = async page => (await read(page, ['LevelInfo0'], ['TimeSeconds'])).LevelInfo0?.TimeSeconds ?? null;
const status = page => page.evaluate(() => { const s = window.deusExViewer.status(); return {map: s.map, mode: s.mode, ready: s.ready, paused: s.paused, err: s.runtimeError?.message ?? null}; });

// 00_Intro's shots by level time (a real-time scout of Play, 2026-10-25): the globe, Page and Simons' room from above, the two
// of them, the clone's face, the NSF briefing, the morgue, the Statue, the greasel, the gray in its tank.
const INTRO = [['i-globe', 0.5, 7.5], ['i-room', 8, 13.5], ['i-page', 14, 21], ['i-clone', 34.5, 38.5], ['i-nsf', 41.5, 46.5],
  ['i-morgue', 50.5, 55.5], ['i-statue', 76.5, 82.5], ['i-greasel', 83.5, 88.5], ['i-gray', 128.5, 137.5]];

async function intro() {
  const {page, errors, close} = await openPlay({map: '00_Intro'});
  try {
    await enableClock(page);
    let current = null, writer = null, frames = 0;
    for (;;) {
      await step(page, 1);
      frames++;
      const t = await levelTime(page);
      const win = t === null ? null : INTRO.find(([, a, b]) => t >= a && t < b);
      if (win?.[0] !== current) {
        if (writer) console.log(`${current}: ${writer.count} frames`);
        current = win?.[0] ?? null;
        writer = current ? clipWriter(page, current) : null;
      }
      if (writer) await writer.shot();
      if (frames % 30 === 0) {
        const s = await status(page);
        console.log(`frame ${frames} level ${t?.toFixed(2)} ${s.map} ${s.err ?? ''}`);
        if (s.err) throw new Error(s.err);
        if (s.map !== '00_Intro' || t === null) break;
      }
    }
    // the travel: loading runs in real time, then the logo map's first seconds
    await disableClock(page);
    await page.waitForFunction(() => { const s = window.deusExViewer.status(); return s.ready && s.map !== '00_Intro' && s.mode === 'play'; }, {}, {timeout: 300000});
    console.log('travelled to', (await status(page)).map);
    await page.waitForTimeout(1500);
    await enableClock(page);
    const logo = clipWriter(page, 'i-logo');
    for (let i = 0; i < 30 * 14; i++) { await step(page, 1); await logo.shot(); }
    console.log(`i-logo: ${logo.count} frames`);
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
  } finally { await close(); }
}

// ---------------------------------------------------------------- scenes driven by the player's inputs
// A session records named clips while it steps: frames(n) advances n output frames (shot when a clip is open), until() steps until
// a probe says so. Placements and the view writes are harness steps (placeProbe), as in the Stage 5 census and record-clip.mjs.
function session(page) {
  let writer = null, name = null;
  const s = {
    start(clip) { s.stop(); name = clip; writer = clipWriter(page, clip); },
    stop() { if (writer) console.log(`${name}: ${writer.count} frames`); writer = null; name = null; },
    async frames(n, each) {
      for (let i = 0; i < n; i++) { await step(page, 1); if (writer) await writer.shot(); if (each) await each(i); }
    },
    async until(predicate, max, every = 6) {
      for (let i = 0; i < max; i++) {
        await step(page, 1);
        if (writer) await writer.shot();
        if (i % every === 0 && await predicate()) return i;
      }
      return -1;
    },
    // the view to `rotation` over `n` frames, eased, written once per frame (the player's own ViewRotation, as a mouse would)
    async turnTo(rotation, n = 18) {
      const start = (await read(page, ['@player'], ['ViewRotation']))['@player'].ViewRotation;
      for (let k = 1; k <= n; k++) {
        const t = k / n, e = t * t * (3 - 2 * t);
        await place(page, {rotation: [wrap(start[0] + shortest(start[0], rotation[0]) * e), wrap(start[1] + shortest(start[1], rotation[1]) * e), 0]});
        await s.frames(1);
      }
    },
    async aimAt(actor, n = 10, lift = 0) {
      const r = await read(page, ['@player', actor], ['Location', 'EyeHeight']);
      if (!r[actor]?.Location) return false;
      const eye = r['@player'].Location.map((v, i) => v + (i === 2 ? r['@player'].EyeHeight : 0));
      const d = r[actor].Location.map((v, i) => v - eye[i] + (i === 2 ? lift : 0));
      await s.turnTo([wrap(units(Math.atan2(d[2], Math.hypot(d[0], d[1])))), wrap(units(Math.atan2(d[1], d[0]))), 0], n);
      return true;
    },
  };
  return s;
}
const center = page => { const v = page.viewportSize(); return [v.width / 2, v.height / 2]; };
/** Summon an item in front of the player, look down at it and take it with the right button (the census's `give`). */
async function take(page, s, cls) {
  await place(page, {set: {actor: '$player', fields: {bCheatsEnabled: true}}});
  const before = (await read(page, ['@player'], ['ViewRotation']))['@player'].ViewRotation;
  await exec(page, `summon ${cls}`); await s.frames(8);
  await s.turnTo([wrap(-10130), before[1], 0], 6); await s.frames(8);
  await page.mouse.click(...center(page), {button: 'right'}); await s.frames(18);
  await s.turnTo([0, before[1], 0], 6);
}
/** Put a carried item in hand with its belt key (the original ActivateBelt binding), the slot read from the Inventory chain. */
async function draw(page, s, cls) {
  let item = (await read(page, ['@player'], ['Inventory']))['@player'].Inventory, key = null;
  for (let k = 0; k < 16 && item && !key; k++) {
    const name = typeof item === 'string' ? item : item?.name;
    const r = (await read(page, [name], ['beltPos', 'Inventory']))[name];
    if (name?.startsWith(cls)) key = String(r.beltPos);
    item = r?.Inventory;
  }
  if (key === null) throw new Error(`no ${cls} carried`);
  await page.keyboard.press(key); await s.frames(45);
}
async function openIsland() {
  const play = await openPlay({map: '01_NYC_UNATCOIsland'});
  await enableClock(play.page);
  await play.page.focus('#scene');
  return play;
}
// The level as a player finds it: MissionScript.FirstFrame (M1MissionStart) runs a few seconds in.
async function settle(page, s, seconds = 6) {
  await s.frames(Math.round(seconds * 30));
  await exec(page, 'KillAll FlyGenerator');
}

// Arrival on the dock (the level's title text), DL_StartGame, Paul running to the player and MeetPaul's third-person camera.
async function island() {
  const {page, errors, close} = await openIsland();
  try {
    const s = session(page);
    s.start('p-arrival');
    await s.frames(30);
    await page.keyboard.down('w'); await s.frames(75); await page.keyboard.up('w');
    await s.turnTo([wrap(800), 16384 + 3000, 0], 40);
    await s.frames(40);
    s.stop();
    const started = await s.until(async () => (await conversation(page))?.conPlay?.con === 'MeetPaul', 30 * 60, 15);
    console.log('MeetPaul after', started, 'frames');
    s.start('p-paul');
    await s.frames(30 * 16);
    s.stop();
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
  } finally { await close(); }
}

// Combat: the assault rifle against the NSF on open ground (record-clip.mjs `fight`).
async function fight() {
  const {page, errors, close} = await openIsland();
  try {
    const s = session(page);
    await settle(page, s);
    await take(page, s, 'WeaponAssaultGun');
    for (let i = 0; i < 2; i++) await take(page, s, 'Ammo762mm');
    await draw(page, s, 'WeaponAssaultGun');
    await s.frames(30 * 7);   // the pickups' log lines fade
    const t = (await read(page, ['Terrorist0'], ['Location', 'Rotation'])).Terrorist0;
    const bearing = t.Rotation[1] / 32768 * Math.PI, distance = Number(option('distance', 450));
    await place(page, {location: [t.Location[0] + Math.cos(bearing) * distance, t.Location[1] + Math.sin(bearing) * distance, t.Location[2] + 4]});
    await s.frames(8);
    await s.aimAt('Terrorist0', 2); await s.frames(8);
    const census = (await page.evaluate(() => window.deusExViewer.liveProbe({census: true}))).census;
    const names = census.pawns.map(p => p.name).filter(n => !/^JCDenton/i.test(n));
    const nearest = async () => {
      const r = await read(page, ['@player', ...names], ['Location', 'Health']);
      const me = r['@player'].Location;
      return names.map(n => [n, r[n]]).filter(([, a]) => a?.Location && a.Health > 0)
        .map(([n, a]) => [n, Math.hypot(a.Location[0] - me[0], a.Location[1] - me[1], a.Location[2] - me[2])])
        .filter(([, d]) => d < 1100).sort((x, y) => x[1] - y[1]);
    };
    s.start('p-fight');
    await s.frames(40);
    const killed = [];
    let current = null, quiet = 0;
    for (let frame = 0; frame < 30 * 18; ) {
      const list = await nearest();
      if (current && !list.some(([n]) => n === current)) killed.push(current);
      current = list[0]?.[0] ?? null;
      if (!current) { if (++quiet > 12) break; await s.frames(6); frame += 6; continue; }
      quiet = 0;
      await s.aimAt(current, 4, 8);
      await page.mouse.move(...center(page)); await page.mouse.down();
      await s.frames(14); await page.mouse.up(); await s.frames(7);
      frame += 25;
    }
    await s.frames(45);
    s.stop();
    console.log('down:', killed.join(' '), 'health', (await read(page, ['@player'], ['Health']))['@player'].Health);
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
  } finally { await close(); }
}

// Gunther's cell: the wall button (DeusExMover8), the door, a walk in, GuntherRescued (record-clip.mjs `gunther`).
async function gunther() {
  const {page, errors, close} = await openIsland();
  try {
    const s = session(page);
    await settle(page, s);
    await take(page, s, 'WeaponPistol'); await draw(page, s, 'WeaponPistol');
    await s.frames(30 * 6);
    await place(page, {location: [1950, -1815, -84.2], rotation: [wrap(-4500), 49152, 0]});
    await s.frames(45);
    s.start('p-gunther');
    await s.frames(30);
    await s.aimAt('DeusExMover8', 24, 6); await s.frames(15);
    await page.mouse.click(...center(page), {button: 'right'});
    await s.frames(48);
    await s.aimAt('GuntherHermann0', 24, 20); await s.frames(12);
    await page.keyboard.down('w');
    const started = await s.until(async () => {
      const r = await read(page, ['@player', 'GuntherHermann0'], ['Location']);
      const d = Math.hypot(r['@player'].Location[0] - r.GuntherHermann0.Location[0], r['@player'].Location[1] - r.GuntherHermann0.Location[1]);
      if (d < 90) await page.keyboard.up('w');
      return (await conversation(page))?.conPlay?.con === 'GuntherRescued';
    }, 30 * 10, 3);
    await page.keyboard.up('w');
    console.log('GuntherRescued after', started, 'frames');
    await s.frames(30 * 12);
    s.stop();
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
  } finally { await close(); }
}

// The bay off the dock (Stage 5 row 5.3.8, swm3): placed 50 units above the water looking down, he falls in and swims forward
// and down, then looks up and surfaces.
async function swim() {
  const {page, errors, close} = await openIsland();
  try {
    const s = session(page);
    await settle(page, s);
    await place(page, {location: [-2800, 6900, -320], rotation: [wrap(-4551), Number(option('yaw', 16384)), 0]});
    s.start('p-swim');
    await s.frames(20);
    await page.keyboard.down('w');
    await s.frames(30 * 7);
    await s.turnTo([wrap(10000), Number(option('yaw', 16384)), 0], 40);
    await s.frames(30 * 4);
    await page.keyboard.up('w');
    await s.frames(30);
    s.stop();
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
  } finally { await close(); }
}

// Training's previews (the viewer's test setups beside the original actors, each a Player start): the crowbar drawn with its belt
// key and swung with the fire button until the crate breaks; the keypad and the DataCube used with the frob button (the original
// binding, the right mouse button). Each preview restarts the level, so its title text is let fade first.
async function training() {
  const {page, errors, close} = await openPlay({map: '00_Training'});
  try {
    await enableClock(page);
    const s = session(page);
    const preview = async value => {
      await page.evaluate(value => { const el = document.getElementById('preview'); el.value = value; el.dispatchEvent(new Event('change', {bubbles: true})); }, value);
      await page.focus('#scene');
      await s.frames(30 * 7);
    };
    const click = async (button = 'left', hold = 3) => {
      await page.mouse.move(...center(page)); await page.mouse.down({button}); await s.frames(hold); await page.mouse.up({button});
    };
    await preview('weapon');
    await page.keyboard.press('1'); await s.frames(40);
    s.start('t-crowbar');
    await s.frames(25);
    for (let swing = 0; swing < 3; swing++) { await click(); await s.frames(swing < 2 ? 32 : 4); }
    await s.frames(80);
    s.stop();
    await preview('keypad');
    s.start('t-keypad');
    await s.frames(20);
    await click('right'); await s.frames(30);
    for (const key of ['0', '0', '1', '2']) { await page.keyboard.press(key); await s.frames(12); }
    await s.frames(60);
    s.stop();
    await preview('datacube');
    s.start('t-datacube');
    await s.frames(15);
    await click('right'); await s.frames(90);
    s.stop();
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
  } finally { await close(); }
}

const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const scenes = {intro, island, fight, gunther, swim, training};
if (!scenes[scene]) throw new Error(`unknown scene ${scene}; one of ${Object.keys(scenes).join(', ')}`);
await scenes[scene]();
