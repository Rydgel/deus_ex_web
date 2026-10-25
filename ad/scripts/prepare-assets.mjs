// Prepares the renderer's inputs in ad/build:
// - assets/pairs: the original/Play frame pairs of the Stage 4 acceptance work (.work/acceptance/<map>/<name>-{original,play}.png,
//   same camera, same held level time), both graded with the original D3D gamma ramp (Brightness 0.6 -> exponent 1/(2.5*0.6),
//   docs/lighting.md): the captures hold the raw framebuffer on both sides;
// - clips.json: the frame count of each Play clip in ad/captures/play (capture-play.mjs).
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ad = path.resolve(here, '..');
const acceptance = path.resolve(ad, '../.work/acceptance');
const out = path.join(ad, 'build/assets/pairs');
mkdirSync(out, {recursive: true});

// [map, capture, crop (the security terminal's window)]; the renderer's PAIRS list names the same ids
const PAIRS = [['00_Intro', 'in2-in1'], ['00_Intro', 'in2-in3'], ['01_NYC_UNATCOIsland', 'cvA4'], ['01_NYC_UNATCOHQ', 'mm2'],
  ['02_NYC_BatteryPark', 'y1'], ['02_NYC_Hotel', 'hotel1'], ['04_NYC_Street', 'vents3'], ['06_HongKong_WanChai_Garage', 'garage2'],
  ['06_HongKong_WanChai_Underworld', 'uw_s0'], ['09_NYC_Ship', 'y1'], ['10_Paris_Club', 'club1'], ['15_Area51_Final', 'a51f', '680x520+300+110']];
let graded = 0;
for (const [map, name, crop] of PAIRS) for (const side of ['original', 'play']) {
  const src = path.join(acceptance, map, `${name}-${side}.png`);
  if (!existsSync(src)) { console.warn('missing', src); continue; }
  const args = [src, '-gamma', '1.5', ...(crop ? ['-crop', crop, '+repage', '-resize', '1280x'] : []), '-unsharp', '0x0.8+0.5+0', '-quality', '92',
    path.join(out, `${map}__${name}-${side[0]}.jpg`)];
  execFileSync('magick', args);
  graded++;
}
const clips = path.join(ad, 'captures/play');
const counts = existsSync(clips) ? Object.fromEntries(readdirSync(clips, {withFileTypes: true}).filter(e => e.isDirectory())
  .map(e => [e.name, readdirSync(path.join(clips, e.name)).filter(f => f.endsWith('.jpg')).length])) : {};
writeFileSync(path.join(ad, 'build/clips.json'), JSON.stringify(counts, null, 1));
console.log(`${graded} pair frames graded`, JSON.stringify(counts));
