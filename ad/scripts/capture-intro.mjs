// Stills of the original in-engine opening cinematic (00_Intro) taken from the
// cinematic's own camera placements (its CameraPoint actors).
//
// MissionIntro.FirstFrame starts the 'Intro' conversation, which puts JC in
// state Paralyzed and grabs the keyboard from the first frame. Setting
// LevelInfo.bPlayersOnly before `open` changes the class default as well, and
// the map's LevelInfo does not serialize that property, so 00_Intro loads
// frozen: the mission timer never fires and the console stays available. JC
// then visits each CameraPoint in ghost mode (eye = Location + EYE_HEIGHT; the
// cinematic itself uses BaseEyeHeight 0 at the point).
// Requires DeusEx.exe running (original-game.mjs launch), at a map where the
// console works. Output: ad/captures/original/intro-cpNNNN-<point>.png
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {collect, run, shots} from './original-game.mjs';
import {EYE_HEIGHT} from './shot-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const exportDir = path.join(repo, 'ad/build/intro');
if (!existsSync(path.join(exportDir, 'actors.json')))
  execFileSync('node', ['scripts/export-map.mjs', 'Deus Ex GOTY Edition/Maps/00_Intro.dx', exportDir], {cwd: repo});
const actors = JSON.parse(readFileSync(path.join(exportDir, 'actors.json'), 'utf8'));
const wrap = u => ((Math.round(u) % 65536) + 65536) % 65536;
const points = actors.filter(a => a.className === 'CameraPoint' && a.values?.Location)
  .map(a => ({name: a.name, seq: a.values.sequenceNum ?? 0, location: a.values.Location,
    rotation: (a.values.Rotation ?? [0, 0, 0]).map(wrap)}))
  .sort((a, b) => a.seq - b.seq);

const scratch = path.resolve(here, '../build/intro-steps');
mkdirSync(scratch, {recursive: true});
let step = 0;
function post(lines, timeout) {
  const file = path.join(scratch, `step-${String(step++).padStart(3, '0')}.txt`);
  writeFileSync(file, lines.join('\n') + '\n');
  run(file, timeout);
}
function snap(name, lines) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = shots();
    post([...lines, 'sleep 900', 'shot', 'sleep 900']);
    if (collect(name, before).length) return console.log(name, 'ok');
  }
  console.log(name, 'NO SHOT');
}
const f = n => Number(n).toFixed(2);

if (!process.argv.includes('--no-open')) {
  console.log('open 00_Intro frozen');
  post(['cmd set LevelInfo bPlayersOnly True', 'sleep 400', 'cmd open 00_Intro', 'sleep 14000']);
  snap('intro-frozen-start', []);
  post(['cmd set DeusEx.JCDentonMale bCheatsEnabled True', 'sleep 200', 'cmd ghost', 'sleep 200',
    'cmd ShowHud False', 'sleep 300',
    // Frozen pawns never start an animation, so they would show the mesh's
    // reference pose; hold every ScriptedPawn on an idle frame instead.
    'cmd set ScriptedPawn AnimSequence BreatheLight', 'sleep 200', 'cmd set ScriptedPawn AnimFrame 0.3', 'sleep 200',
    'cmd set ScriptedPawn AnimRate 0', 'sleep 300']);
}
for (const point of points) {
  const [x, y, z] = point.location, [pitch, yaw, roll] = point.rotation;
  snap(`intro-cp${String(point.seq).padStart(4, '0')}-${point.name}`, [
    `cmd set DeusEx.JCDentonMale Location (X=${f(x)},Y=${f(y)},Z=${f(z - EYE_HEIGHT)})`,
    // A tiny velocity makes the next physics move refresh JC's zone.
    'cmd set DeusEx.JCDentonMale Velocity (X=0,Y=0,Z=0.5)',
    `cmd set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=${roll})`,
  ]);
}
