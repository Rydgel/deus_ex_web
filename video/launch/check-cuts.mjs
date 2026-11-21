// The frames on both sides of every cut of a launch video, taken from the encoded file, as sheets to look at one by one:
//   node video/launch/check-cuts.mjs [--video trailer-1080p.mp4] [--shots trailer-shots-made.json] [--around 2]
//        -> .work/marketing/out/<video>-cuts/cut-<nn>.jpg (the last `around` frames before the cut, the first `around` after), and
//           first.jpg, last.jpg, and every-<seconds>.jpg sheets of one frame a second
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), out = path.join(repo, '.work/marketing/out');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const video = path.join(out, option('video', 'trailer-1080p.mp4')), around = Number(option('around', 2));
const made = JSON.parse(readFileSync(path.join(out, option('shots', 'trailer-shots-made.json')), 'utf8'));
const dir = path.join(out, path.basename(video, '.mp4') + '-cuts');
rmSync(dir, {recursive: true, force: true}); mkdirSync(path.join(dir, 'f'), {recursive: true});
const starts = made.shots.map(s => Math.round(s.at * made.fps)), total = made.frames;
const wanted = new Set([0, total - 1]);
for (const s of starts.slice(1)) for (let k = -around; k < around; k++) wanted.add(s + k);
for (let f = 0; f < total; f += made.fps) wanted.add(f);
const list = [...wanted].filter(f => f >= 0 && f < total).sort((a, b) => a - b);
// every frame of the file, decoded once at half size (a select expression of a hundred frames is more than ffmpeg parses)
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', 'scale=960:540', '-fps_mode', 'passthrough', '-q:v', '2', path.join(dir, 'f', 'n%05d.jpg')]);
const file = f => path.join(dir, 'f', `n${String(f + 1).padStart(5, '0')}.jpg`);
const sheet = (frames, name, tile) => execFileSync('magick', ['montage', ...frames.flatMap(f => ['-label', `${f} (${(f / made.fps).toFixed(2)} s)`, file(f)]), '-tile', tile, '-geometry', '960x540+4+4', '-background', '#222', '-fill', 'white', '-pointsize', '18', path.join(dir, name)]);
for (const [i, s] of starts.slice(1).entries()) {
  const frames = []; for (let k = -around; k < around; k++) frames.push(s + k);
  sheet(frames, `cut-${String(i + 1).padStart(2, '0')}.jpg`, `${around * 2}x1`);
  console.log(`cut ${i + 1} at frame ${s} (${(s / made.fps).toFixed(2)} s): ${made.shots[i].name} | ${made.shots[i + 1].name}`);
}
const seconds = []; for (let f = 0; f < total; f += made.fps) seconds.push(f);
for (let i = 0; i < seconds.length; i += 12) sheet(seconds.slice(i, i + 12), `every-${String(i).padStart(2, '0')}.jpg`, '4x3');
sheet([0, total - 1], 'ends.jpg', '2x1');
console.log(`-> ${path.relative(repo, dir)}`);
