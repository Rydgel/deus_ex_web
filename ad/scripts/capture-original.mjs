// Takes the original-game half of the shot plan with DeusEx.exe already running
// (node ad/scripts/original-game.mjs launch). Each map is opened from the
// console; start views are taken before cheats, the rest in ghost mode with the
// HUD hidden; sequences shoot a playing cinematic at a fixed interval.
// Output: ad/captures/original/<name>.png (1280x720 Shot bitmaps).
//
//   node ad/scripts/capture-original.mjs [mapFilter] [shotFilter]
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {collect, run, shots} from './original-game.mjs';
import {EYE_HEIGHT, maps} from './shot-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, '../build/original-steps');
mkdirSync(scratch, {recursive: true});
const [mapFilter = '', shotFilter = ''] = process.argv.slice(2);
const LOAD_WAIT = {'00_Training': 16000, '01_NYC_UNATCOIsland': 26000, '01_NYC_UNATCOHQ': 24000, '00_Intro': 7000};

let step = 0;
function post(lines, timeout) {
  const file = path.join(scratch, `step-${String(step++).padStart(3, '0')}.txt`);
  writeFileSync(file, lines.join('\n') + '\n');
  run(file, timeout);
}
function snap(name, lines) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = shots();
    post([...lines, 'shot', 'sleep 900']);
    const result = collect(name, before);
    if (result.length) return console.log(name, `${result[0].width}x${result[0].height}`);
  }
  console.log(name, 'NO SHOT');
}
const f = n => n.toFixed(2);
const vec = ([x, y, z]) => `(X=${f(x)},Y=${f(y)},Z=${f(z)})`;

for (const plan of maps.filter(m => m.map.includes(mapFilter))) {
  console.log(`open ${plan.map}`);
  post([`cmd open ${plan.map}`, `sleep ${LOAD_WAIT[plan.map] ?? 20000}`]);
  if (plan.sequence) {
    const {prefix, interval, count} = plan.sequence;
    const before = shots();
    const lines = [];
    for (let i = 0; i < count; i++) lines.push('shot', `sleep ${interval}`);
    post(lines, count * (interval + 700) + 60000);
    const taken = collect(prefix, before);
    console.log(prefix, `${taken.length} frames`);
    continue;
  }
  for (const shot of plan.start ?? []) {
    if (shotFilter && !shot.name.includes(shotFilter)) continue;
    const lines = shot.velocity ? [`cmd set DeusEx.JCDentonMale Velocity ${vec(shot.velocity)}`] : [];
    snap(shot.name, [...lines, `sleep ${shot.wait ?? 1000}`]);
  }
  post(['cmd set DeusEx.JCDentonMale bCheatsEnabled True', 'sleep 200', 'cmd ghost', 'sleep 200',
    'cmd ShowHud False', 'sleep 300']);
  for (const shot of plan.shots ?? []) {
    if (shotFilter && !shot.name.includes(shotFilter)) continue;
    const [x, y, z] = shot.eye, [pitch, yaw, roll] = shot.rotation;
    snap(shot.name, [
      `cmd set DeusEx.JCDentonMale Location ${vec([x, y, z - EYE_HEIGHT])}`,
      'cmd set DeusEx.JCDentonMale Velocity (X=0,Y=0,Z=0)',
      `cmd set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=${roll})`,
      'sleep 900',
    ]);
  }
}
