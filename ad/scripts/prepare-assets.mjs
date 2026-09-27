// Grades the captured stills into ad/build/assets for the renderer.
// Original Shot bitmaps hold the raw framebuffer; the original D3D renderer
// showed them through its gamma ramp (Brightness 0.6 -> exponent 1/(2.5*0.6),
// docs/lighting.md), so originals get the same curve. Browser captures were
// taken at the viewer's default brightness 0.6, which already applies it.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ad = path.resolve(here, '..');
const out = path.join(ad, 'build/assets');
mkdirSync(out, {recursive: true});

const originals = [
  'logo/intro-1', 'logo/intro-4', 'logo/intro-9', 'logo/intro-12', 'logo/intro-18', 'logo/intro-27', 'logo/intro-31',
  'logo/intro-40', 'logo/intro-45', 'logo/intro-52', 'logo/intro-60', 'logo/intro-70',
  'intro-cp0000-CameraPoint0', 'intro-cp0001-CameraPoint3', 'intro-cp0002-CameraPoint4', 'intro-cp0003-CameraPoint6',
  'intro-cp0006-CameraPoint10', 'intro-cp0021-CameraPoint16', 'intro-cp0045-CameraPoint56', 'intro-cp0047-CameraPoint45',
  'intro-cp0052-CameraPoint17', 'intro-cp0070-CameraPoint68', 'intro-cp0071-CameraPoint67', 'intro-cp0074-CameraPoint71',
  'intro-cp0076-CameraPoint69', 'intro-cp0005-CameraPoint24',
  'l-start', 'l-statue-high', 'l-statue-mid', 'l-statue-dock', 'l-paul', 'l-paul-wide', 'l-harley', 'l-boat', 'l-nsf', 'l-gunther',
  'h-anna', 'h-gunther', 'h-sam',
  't-start', 't-infolink', 't-side', 't-corridor', 't-observers', 't-observers-wide', 't-crates', 't-weapons', 't-medbot',
  't-repairbot', 'p-walton', 'p-jaime-observer', 'p-doctor', 'p-doctor-2', 'p-scientist-female', 'p-scientist-observer',
  'p-trooper-body', 'p-manderley-wide', 'p-instructor-wide',
];
const browser = ['t-start', 't-infolink', 't-side', 't-observers', 'p-walton', 'p-doctor', 'p-jaime-observer', 't-crates',
  't-weapons', 't-medbot', 'p-trooper-body', 'l-statue-high', 'l-statue-mid'];

let done = 0;
for (const name of originals) {
  const src = path.join(ad, 'captures/original', `${name}.png`);
  if (!existsSync(src)) { console.warn('missing original', name); continue; }
  const dst = path.join(out, `o-${path.basename(name)}.jpg`);
  execFileSync('magick', [src, '-gamma', '1.5', '-unsharp', '0x0.8+0.5+0', '-quality', '93', dst]);
  done++;
}
for (const name of browser) {
  const src = path.join(ad, 'captures/browser', `${name}.png`);
  if (!existsSync(src)) { console.warn('missing browser', name); continue; }
  execFileSync('magick', [src, '-unsharp', '0x0.8+0.5+0', '-quality', '93', path.join(out, `b-${name}.jpg`)]);
  done++;
}
const clips = path.join(ad, 'captures/browser/clips');
const counts = Object.fromEntries(readdirSync(clips).map(name => [name, readdirSync(path.join(clips, name)).length]));
console.log(`${done} stills graded`, JSON.stringify(counts));
