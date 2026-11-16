// Listening page for a render: video/out/music/preview.html, one self-contained file (the mp3 and a waveform strip are
// embedded) with the sections on a clickable timeline and a bar counter, so notes can say "bar 41" or "the denton scene".
import {readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const COLORS = {boot: '#5b6b8c', study: '#3f8f8a', light: '#d9a441', 'work-a': '#d9703e', 'work-b': '#c2553a', 'work-c': '#e0803c', denton: '#7d6fc4', finale: '#e2a13a', outro: '#5b6b8c'};
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const clock = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function writePreview(outDir, {label = 'draft', stats = ''} = {}) {
  const score = JSON.parse(readFileSync(path.join(outDir, 'score.json'), 'utf8'));
  const wave = path.join(outDir, 'waveform.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(outDir, 'score.wav'), '-lavfi',
    'aformat=channel_layouts=mono,showwavespic=s=1800x220:colors=0xf0b08a:scale=sqrt', '-frames:v', '1', wave], {stdio: 'inherit'});
  const b64 = file => readFileSync(path.join(outDir, file)).toString('base64');
  const total = score.duration;
  const blocks = score.sections.map(s => `<button class="sec" data-t="${s.start}" style="left:${(s.start / total * 100).toFixed(3)}%;width:${((s.end - s.start) / total * 100).toFixed(3)}%;--c:${COLORS[s.name]}"><span>${esc(s.name)}</span></button>`).join('');
  const rows = score.sections.map(s => `<tr data-t="${s.start}" data-name="${esc(s.name)}"><td><i style="background:${COLORS[s.name]}"></i>${esc(s.name)}</td><td>${clock(s.start)}</td><td>${s.bar + 1}&ndash;${s.bar + s.bars}</td><td>${esc(s.scene)}</td><td>${esc(s.music)}</td></tr>`).join('');
  const quote = score.quoted ? `<span class="mark" style="left:${(score.quoted.start / total * 100).toFixed(3)}%;width:${((score.quoted.end - score.quoted.start) / total * 100).toFixed(3)}%" title="the Deus Ex theme's phrase"></span>` : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Score preview</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#272c37; --text:#e6e3dc; --dim:#9a9aa3; --accent:#f08a5d; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 28px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 2px; letter-spacing: .01em; }
  .sub { color: var(--dim); margin: 0 0 18px; font-size: 13.5px; }
  .player { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
  #play { width: 52px; height: 52px; border-radius: 50%; border: 0; background: var(--accent); color: #1a0f08; font-size: 20px; cursor: pointer; flex: none; }
  #play:focus-visible, .sec:focus-visible, tr:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .read { font-variant-numeric: tabular-nums; }
  .read b { font-size: 26px; font-weight: 600; }
  .read span { color: var(--dim); margin-left: 10px; font-size: 13.5px; }
  .now { margin-left: auto; text-align: right; min-width: 0; }
  .now b { color: var(--accent); text-transform: uppercase; letter-spacing: .08em; font-size: 12.5px; }
  .now div { color: var(--dim); font-size: 13.5px; }
  .track { position: relative; height: 150px; background: var(--panel) center/100% 100% no-repeat; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; cursor: pointer; touch-action: none; }
  .secs { position: absolute; inset: 0; }
  .sec { position: absolute; top: 0; bottom: 0; border: 0; border-left: 1px solid #0008; background: color-mix(in srgb, var(--c) 26%, transparent); color: #fff; padding: 0; cursor: pointer; font: inherit; }
  .sec span { position: absolute; left: 6px; top: 4px; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; text-shadow: 0 1px 2px #000; }
  .sec.on { background: color-mix(in srgb, var(--c) 46%, transparent); }
  .mark { position: absolute; bottom: 0; height: 6px; background: #fff; opacity: .85; pointer-events: none; }
  #head { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; left: 0; pointer-events: none; }
  .hint { color: var(--dim); font-size: 12.5px; margin: 8px 0 22px; }
  .wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; min-width: 760px; font-size: 13.5px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; background: var(--panel); }
  tr:last-child td { border-bottom: 0; }
  tbody tr { cursor: pointer; }
  tbody tr.on { background: #ffffff0d; }
  td:first-child { white-space: nowrap; font-weight: 600; }
  td:nth-child(2), td:nth-child(3) { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--dim); }
  td i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 8px; }
  @media (max-width: 640px) { .now { margin-left: 0; text-align: left; flex-basis: 100%; } .track { height: 110px; } }
</style></head><body><main>
<h1>Score, ${esc(label)}</h1>
<p class="sub">${esc(stats)}</p>
<div class="player">
  <button id="play" aria-label="Play or pause">&#9654;</button>
  <div class="read"><b id="time">0:00</b><span id="bar">bar 1 &middot; beat 1</span></div>
  <div class="now"><b id="name"></b><div id="scene"></div></div>
</div>
<div class="track" id="track" style="background-image:url(data:image/png;base64,${b64('waveform.png')})"><div class="secs">${blocks}${quote}</div><div id="head"></div></div>
<p class="hint">Click anywhere on the strip to jump; space plays and pauses; arrow keys step one bar. The white bar at the foot of the strip marks the four quoted bars.</p>
<div class="wrap"><table><thead><tr><th>Section</th><th>At</th><th>Bars</th><th>Picture</th><th>Music</th></tr></thead><tbody>${rows}</tbody></table></div>
<audio id="a" preload="auto" src="data:audio/mpeg;base64,${b64('score.mp3')}"></audio>
</main><script>
const S = ${JSON.stringify({bar: score.bar, beat: score.beat, bars: score.bars, duration: total, sections: score.sections.map(({name, start, end, scene}) => ({name, start, end, scene}))})};
const a = document.getElementById('a'), $ = id => document.getElementById(id), track = $('track');
const secs = [...document.querySelectorAll('.sec')], rows = [...document.querySelectorAll('tbody tr')];
const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
function draw() {
  const t = a.currentTime, b = Math.min(S.bars, Math.floor(t / S.bar)), beat = Math.floor((t - b * S.bar) / S.beat) + 1;
  $('time').textContent = fmt(t);
  $('bar').textContent = t >= S.bars * S.bar ? 'tail' : 'bar ' + (b + 1) + ' \\u00b7 beat ' + beat;
  $('head').style.left = (t / S.duration * 100) + '%';
  const k = S.sections.findIndex(s => t >= s.start && t < s.end), s = S.sections[k];
  $('name').textContent = s ? s.name : ''; $('scene').textContent = s ? s.scene : '';
  secs.forEach((e, i) => e.classList.toggle('on', i === k)); rows.forEach((e, i) => e.classList.toggle('on', i === k));
  $('play').innerHTML = a.paused ? '&#9654;' : '&#10073;&#10073;';
}
const seek = t => { a.currentTime = Math.max(0, Math.min(S.duration - 0.05, t)); draw(); };
const toggle = () => { a.paused ? a.play() : a.pause(); };
$('play').onclick = toggle;
track.addEventListener('pointerdown', e => { if (e.target.closest('.sec') && e.detail > 1) return; const r = track.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * S.duration); });
rows.forEach(r => { r.tabIndex = 0; r.onclick = () => { seek(Number(r.dataset.t)); a.play(); }; r.onkeydown = e => { if (e.key === 'Enter') r.onclick(); }; });
document.addEventListener('keydown', e => {
  if (e.target.closest('tr') && e.key === 'Enter') return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowRight') seek(a.currentTime + S.bar);
  else if (e.key === 'ArrowLeft') seek(a.currentTime - S.bar);
});
for (const ev of ['play', 'pause', 'seeked', 'loadedmetadata']) a.addEventListener(ev, draw);
(function loop() { if (!a.paused) draw(); requestAnimationFrame(loop); })();
draw();
</script></body></html>
`;
  const file = path.join(outDir, 'preview.html');
  writeFileSync(file, html);
  return file;
}
