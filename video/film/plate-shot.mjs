// Captures the plate of a game shot (film/game-shots.mjs): one frame when nothing in it moves, else one per film frame
// (30 fps, each two stepped engine frames), with the camera the engine used for each.
//   node video/film/plate-shot.mjs <id> [--size 1920x1080] [--frames n]      -> video/out/film/plates/<id>/ plate.json, f0001.png ...
// A shot whose people walk (`live`) is captured twice, the second time with everyone hidden (clean/f0001.png ...), and plate.json
// lists who was where in each frame: game_shot.py lays whoever is nearer the camera than the crab back over it.
import {mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openEngine, lookAt} from './engine.mjs';
import {GAME} from './game-shots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), argv = process.argv.slice(2), id = argv[0], shot = GAME[id];
if (!shot) { console.error(`usage: node video/film/plate-shot.mjs <${Object.keys(GAME).join('|')}>`); process.exit(1); }
const flag = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const size = flag('size', '1920x1080').split('x').map(Number), FPS = 30;
const out = path.resolve(here, '../out/film/plates', id);
mkdirSync(out, {recursive: true});
for (const file of readdirSync(out)) if (/^f\d+\.png$|^plate\.json$/.test(file)) rmSync(path.join(out, file));     // the crab's frames (crab/) stay

const ease = x => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
// a value along [[seconds, ...values]] keys, eased between neighbours
const along = (keys, t, pick) => {
  if (t <= keys[0][0]) return pick(keys[0]);
  const curve = shot.linear ? x => x : ease;
  for (let k = 1; k < keys.length; k++) if (t <= keys[k][0]) return mix(pick(keys[k - 1]), pick(keys[k]), curve((t - keys[k - 1][0]) / (keys[k][0] - keys[k - 1][0])));
  return pick(keys.at(-1));
};
const cameraAt = t => (shot.camera.track ? {at: along(shot.camera.track, t, k => k[1]), to: along(shot.camera.track, t, k => k[2])} : shot.camera);
const actors = shot.actors ?? [];
const moving = Boolean(shot.live || shot.camera.track || actors.some(a => a.cycle || a.path));
const frames = moving ? Number(flag('frames', shot.frames)) : 1;

// People: in a shot where the level's people walk, some pass nearer the camera than the crab. The crab is laid over the frame, so they must
// be laid back over it: this needs where each person is in every frame (`people` in plate.json) and the same frames without anyone
// (clean/), from a second run of the same stepped clock with every person hidden. blender/game_shot.py makes the matte from the two.
const people = shot.people ?? Boolean(shot.live);
const PERSON = 'deusex.scriptedpawn', NEAR = 1500;                // people further than this from the camera are not recorded
const frameName = f => `f${String(f + 1).padStart(4, '0')}.png`;

async function run(clean) {
  const dir = clean ? path.join(out, 'clean') : out;
  if (clean) { rmSync(dir, {recursive: true, force: true}); mkdirSync(dir, {recursive: true}); }
  const engine = await openEngine({size, clock: true});
  try {
    const start = await engine.load(shot.map);
    if (!clean) console.log(`${shot.map}: player start ${start.location.map(v => v.toFixed(0)).join(',')}; hidden ${engine.hidden.join(',') || 'no shadow'}`);
    for (const actor of actors) actor.name = await engine.summon(actor.cls, actor.at, actor.yaw);
    if (shot.settle) await engine.step(Math.round(shot.settle * 60)); // the level runs first: its people leave the pose they are loaded in (the desk trooper at UNATCO stood arms out, 2026-11-11)
    if (!shot.live) await engine.probe({playersOnly: true});          // the level holds still; what moves is written frame by frame
    const list = async cls => ((await engine.call('liveProbe', {actors: cls, actorProps: ['CollisionRadius', 'CollisionHeight', 'bHidden', 'Owner']})).actors ?? []);
    let hide = null;
    if (clean) {
      // everyone, what they carry and the shadows under them (a shadow or a thing that shows itself again stays in both runs: no harm)
      const persons = new Set((await list(PERSON)).map(row => row.name));
      const owned = [...await list('deusex.shadow'), ...await list('engine.inventory')].filter(row => persons.has(String(row.Owner)));
      hide = Object.fromEntries([...persons, ...owned.map(row => row.name)].map(name => [name, {bHidden: true}]));
    }
    const cameras = [], seenPeople = [];
    for (let f = 0; f < frames; f++) {
      const t = f / FPS;
      for (const actor of actors) {
        let at = actor.at, yaw = actor.yaw;
        if (actor.path) {
          const xy = along(actor.path, t, k => [k[1], k[2]]), next = along(actor.path, t + 0.1, k => [k[1], k[2]]);
          at = [xy[0], xy[1], actor.at[2]];
          if (Math.hypot(next[0] - xy[0], next[1] - xy[1]) > 0.01) yaw = Math.atan2(next[1] - xy[1], next[0] - xy[0]) * 180 / Math.PI;
        }
        await engine.put(actor.name, at, yaw);
        if (actor.anim) await engine.pose(actor.name, actor.anim, actor.cycle ? (actor.frame + t / actor.cycle) % 1 : actor.frame);
      }
      const cam = cameraAt(t), look = lookAt(cam.at, cam.to);
      await engine.camera(cam.at, look);
      if (hide) await engine.call('liveProbe', {write: hide});
      await engine.step(f === 0 ? 20 : 2);
      await engine.grab(path.join(dir, frameName(f)));
      const seen = await engine.status();
      if (Math.hypot(...seen.position.map((v, i) => v - cam.at[i])) > 0.5) throw new Error(`frame ${f + 1}: the engine's camera is at ${seen.position}, not ${cam.at}`);
      cameras.push({position: cam.at, pitch: look.pitch, yaw: look.yaw});
      if (people && !clean) seenPeople.push((await list(PERSON)).filter(row => !row.bHidden && Math.hypot(...row.location.map((v, i) => v - cam.at[i])) < NEAR)
        .map(row => [row.name, ...row.location.map(v => Math.round(v * 10) / 10), row.CollisionRadius, row.CollisionHeight]));
      if (f % 30 === 29) console.log(`  ${clean ? 'clean ' : ''}${f + 1}/${frames}`);
    }
    if (engine.errors.length) console.log('page errors:', engine.errors.slice(0, 3));
    return {cameras, seenPeople};
  } finally {
    await engine.close();
  }
}

const {cameras, seenPeople} = await run(false);
// a clean run only when someone comes close enough to matter (the matte itself is decided against the crab, in game_shot.py)
const anyone = people && frames > 1 && seenPeople.some(row => row.length);
if (anyone) await run(true); else rmSync(path.join(out, 'clean'), {recursive: true, force: true});
const {camera, actors: _, ...rest} = shot;
writeFileSync(path.join(out, 'plate.json'), JSON.stringify({id, ...rest, size, fps: FPS, plateFrames: frames, horizontalFov: 75, cameras,
  actors: actors.map(a => ({name: a.name, cls: a.cls})), ...(anyone ? {people: seenPeople} : {})}));
console.log(`${id}: ${frames} plate frame${frames > 1 ? 's' : ''}${anyone ? ', and as many without people' : ''} -> ${path.relative(path.resolve(here, '../..'), out)}`);
