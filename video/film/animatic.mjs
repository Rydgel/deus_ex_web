// The animatic: the whole film at its real length on the locked score, each shot either its rendered footage (when
// video/out/film/<clip>/f####.png exists) or a card saying what will be there. Cards are drawn in JavaScript (headless
// Chromium); ffmpeg joins the pieces and lays the music under them.
//   node video/film/animatic.mjs            -> video/out/film/animatic.mp4 (1280x720, 30 fps)
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {SHOTS, VOICE, CAPTIONS} from './storyboard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..'), out = path.resolve(here, '../out/film');
const score = JSON.parse(readFileSync(path.resolve(here, '../out/music/score.json'), 'utf8'));
// --size WxH (1280x720) and --out name.mp4 (animatic.mp4): the same cut at the final size is the film itself
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const FPS = 30, [W, H] = flag('--size', '1280x720').split('x').map(Number), outName = flag('--out', 'animatic.mp4'), work = path.join(out, outName.replace(/\.mp4$/, ''));
const frameAt = t => Math.round(t * FPS);
const COLORS = {boot: '#5b6b8c', study: '#3f8f8a', light: '#d9a441', 'work-a': '#d9703e', 'work-b': '#c2553a', 'work-c': '#e0803c', denton: '#7d6fc4', finale: '#e2a13a', outro: '#5b6b8c'};
const HOW = {blender: 'Blender', data: 'Blender + screens of project data', game: 'our engine\'s frame + the crab from Blender', graphics: 'JavaScript graphics'};
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const clock = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const ff = args => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {stdio: 'inherit'}); if (r.status !== 0) throw new Error('ffmpeg failed'); };

rmSync(work, {recursive: true, force: true});
mkdirSync(work, {recursive: true});
const total = score.duration;
// every shot as [first frame, frame count]; the last one also carries the tail after the final bar
const shots = SHOTS.map((shot, i) => {
  const t0 = shot.bar * score.bar, t1 = i + 1 < SHOTS.length ? SHOTS[i + 1].bar * score.bar : total;
  return {...shot, n: i + 1, t0, t1, f0: frameAt(t0), frames: frameAt(t1) - frameAt(t0)};
});

const card = shot => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; } body { width: 1280px; height: 720px; background: #0c1017; color: #e8e4dc; font-family: "iA Writer Mono S", "JetBrainsMono Nerd Font", monospace; position: relative; overflow: hidden; }
  .top { position: absolute; left: 72px; top: 64px; font-size: 20px; letter-spacing: .08em; color: #9aa3b2; text-transform: uppercase; }
  .top b { color: ${COLORS[shot.scene]}; }
  h1 { position: absolute; left: 72px; top: 150px; margin: 0; font: 600 60px/1.1 ui-sans-serif, system-ui, sans-serif; letter-spacing: -.01em; }
  p { position: absolute; left: 72px; top: 262px; width: 1010px; margin: 0; font: 400 30px/1.42 ui-sans-serif, system-ui, sans-serif; color: #cfd3da; }
  .how { position: absolute; left: 72px; bottom: 112px; font-size: 18px; color: #f08a5d; letter-spacing: .04em; }
  .strip { position: absolute; left: 72px; right: 72px; bottom: 56px; height: 22px; display: flex; gap: 2px; }
  .strip i { display: block; height: 100%; opacity: .28; border-radius: 2px; }
  .strip i.on { opacity: 1; outline: 2px solid #fff; }
</style>
<div class="top">shot ${shot.n} of ${shots.length} &nbsp;·&nbsp; <b>${esc(shot.scene)}</b> &nbsp;·&nbsp; bars ${shot.bar + 1}–${shot.bar + shot.bars} &nbsp;·&nbsp; ${clock(shot.t0)}</div>
<h1>${esc(shot.title)}</h1><p>${esc(shot.action)}</p><div class="how">${esc(HOW[shot.how])}</div>
<div class="strip">${shots.map(s => `<i class="${s.n === shot.n ? 'on' : ''}" style="flex:${s.frames};background:${COLORS[s.scene]}"></i>`).join('')}</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: W / 1280});      // the cards are laid out for 1280x720
const list = [];
let footage = 0;
for (const shot of shots) {
  const seg = path.join(work, `shot${String(shot.n).padStart(2, '0')}.mp4`), dir = path.join(out, shot.clip ?? shot.id);
  // a shot's own folder starts at f0001; a scene's folder (clip) is numbered from the scene's first frame
  const first = shot.clip ? shot.f0 - frameAt(score.sections.find(s => s.name === shot.scene).start) + 1 : 1;
  // a shot a frame or two short of its bars (a bar boundary rounds to 124 or 125 frames) holds its last frame
  let got = 0;
  while (got < shot.frames && existsSync(path.join(dir, `f${String(first + got).padStart(4, '0')}.png`))) got++;
  const have = got >= shot.frames - 2;
  const enc = ['-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-crf', '8', '-frames:v', String(shot.frames), seg];      // near lossless: the film is encoded once more from these
  if (have) {
    ff(['-framerate', String(FPS), '-start_number', String(first), '-i', path.join(dir, 'f%04d.png'), '-vf', `scale=${W}:${H}:flags=lanczos${got < shot.frames ? ',tpad=stop_mode=clone:stop_duration=1' : ''}`, ...enc]);
    footage++;
  } else {
    await page.setContent(card(shot));
    const png = path.join(work, `card${String(shot.n).padStart(2, '0')}.png`);
    await page.screenshot({path: png});
    ff(['-loop', '1', '-framerate', String(FPS), '-i', png, ...enc]);
  }
  list.push(`file '${seg}'`);
}
await browser.close();
writeFileSync(path.join(work, 'list.txt'), list.join('\n') + '\n');
// sound: the score, halved under each spoken line (the line itself at about -17 LUFS, the music under it near -26); picture: each line burnt in as a subtitle; and a caption track
const dest = path.join(out, outName), bold = spawnSync('fc-match', ['-f', '%{file}', 'sans:bold']).stdout.toString(), regular = spawnSync('fc-match', ['-f', '%{file}', 'sans']).stdout.toString();
const lines = VOICE.map(v => ({...v, t: v.at[0] * score.bar + v.at[1], path: path.join(out, v.file)})).filter(v => existsSync(v.path));
const length = file => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString());
for (const v of lines) v.end = v.t + length(v.path);
const duck = lines.map(v => `(1-0.5*min(1,max(0,(t-${(v.t - 0.2).toFixed(3)})/0.2))*min(1,max(0,(${(v.end + 0.35).toFixed(3)}-t)/0.35)))`).join('*') || '1';
const voices = lines.map((v, i) => `[${i + 2}:a]volume=${v.gain ?? 0}dB,aecho=1:1:45|80:0.14|0.09,adelay=${Math.round(v.t * 1000)}:all=1[v${i}]`);
const audio = [`[1:a]volume='${duck}':eval=frame[m]`, ...voices, `[m]${lines.map((_, i) => `[v${i}]`).join('')}amix=inputs=${lines.length + 1}:normalize=0[a]`];
const quote = s => s.replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '\\%');
const shown = v => Math.max(v.end + 0.3, v.t + 2.3);          // long enough to read (15 characters a second for JC's line), not long into the next shot
const burn = lines.flatMap(v => {
  const on = `enable='between(t,${(v.t - 0.05).toFixed(3)},${shown(v).toFixed(3)})'`;
  return [`drawtext=fontfile='${bold}':text='${quote(v.who.toUpperCase())}':fontsize=${Math.round(H / 34)}:fontcolor=0xf08a5d:x=(w-text_w)/2:y=h-${Math.round(H * 0.16)}:shadowcolor=black@0.9:shadowx=2:shadowy=2:${on}`,
    `drawtext=fontfile='${regular}':text='${quote(v.text)}':fontsize=${Math.round(H / 22)}:fontcolor=white:x=(w-text_w)/2:y=h-${Math.round(H * 0.115)}:box=1:boxcolor=black@0.55:boxborderw=${Math.round(H / 60)}:${on}`];
});
const stamp = t => { const ms = Math.round(t * 1000), p = (v, n = 2) => String(v).padStart(n, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
const cues = [...CAPTIONS.map(([[bar, after, shown], text]) => ({t: bar * score.bar + after, end: bar * score.bar + after + shown, text})),
  ...lines.map(v => ({t: v.t, end: shown(v), text: `${v.who}: ${v.text}`}))].sort((a, b) => a.t - b.t);
cues.forEach((cue, i) => { if (cues[i + 1] && cue.end > cues[i + 1].t) cue.end = cues[i + 1].t - 0.04; });
const srt = path.join(out, 'film.srt');
writeFileSync(srt, cues.map((cue, i) => `${i + 1}\n${stamp(cue.t)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n'));
ff(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.txt'), '-i', path.resolve(here, '../out/music/score.wav'), ...lines.flatMap(v => ['-i', v.path]), '-i', srt,
  '-filter_complex', [...audio, `[0:v]${burn.length ? burn.join(',') : 'null'}[v]`].join(';'), '-map', '[v]', '-map', '[a]', '-map', `${lines.length + 2}:0`,
  '-c:v', 'libx264', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-crf', '17', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '256k', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-t', total.toFixed(3), dest]);     // not -shortest: the caption track ends with its last cue, 5 s before the film
if (process.argv.includes('--list')) for (const shot of shots) console.log(`${String(shot.n).padStart(2)} ${shot.id.padEnd(12)} ${shot.scene.padEnd(7)} bars ${String(shot.bar + 1).padStart(2)}-${String(shot.bar + shot.bars).padEnd(2)} t ${shot.t0.toFixed(3).padStart(7)} frames ${String(shot.frames).padStart(3)} ${shot.how}`);
console.log(`${path.relative(repo, dest)}: ${shots.length} shots, ${footage} with footage, ${clock(total)}`);
