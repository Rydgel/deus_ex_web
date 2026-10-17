#!/usr/bin/env node
/**
 * Regenerates the ?easter=1 mod's spoken clips (docs/easter-egg.md "Voices") from the lines in src/viewer/easter-config.mjs:
 * Piper (https://github.com/rhasspy/piper, the `piper-tts` package) speaks each line with the speaker's voice model, ffmpeg trims the
 * silence, resamples to 44.1 kHz, brings the level to the game's own speech level and encodes MPEG-1 Layer III mono at 48 kbps, the
 * format of the game's speech (frames FF FB 30 C4), which the page's speech transport decodes like the game's own.
 *
 *   node scripts/easter-voices.mjs [--download] [--piper PATH] [--voices DIR] [--out DIR] [--only ID[,ID]] [--check]
 *
 *   --download   fetch the two voice models (rhasspy/piper-voices on Hugging Face at EASTER_VOICES.revision, sha256-checked) into --voices
 *   --piper      the piper executable (default $EASTER_PIPER, else <repo>/.cache/piper-env/bin/piper)
 *   --voices     the models' directory (default <repo>/.cache/piper-voices); the models are not committed
 *   --out        where the MP3s and manifest.json go (default src/viewer/easter-audio)
 *   --only       regenerate just these clip ids
 *   --check      write nothing: measure the committed clips against the manifest and the level target, and exit 1 on a mismatch
 *
 * Level target: the game's speech was measured on 65 clips from DeusExConAudioMission01..04 and AIBarks (decoded by ffmpeg): RMS over
 * the voiced part median -13.4 dBFS (p10 -16.6, p90 -11.2), sample peak about 0 dBFS (the encoder's output clips by up to 1.2 dB). The
 * clips are set to RMS TARGET_RMS_DB (decoded MP3) with the peak at or below PEAK_CEILING_DB: a limiter at PEAK_LIMIT_DB before the encoder, tightened if the encoder overshoots.
 *
 * Piper's decoder draws random noise, so a regeneration is the same words in the same voice but not the same bytes; the committed
 * clips and manifest.json are the artifact.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {easterClips, EASTER_VOICES} from '../src/viewer/easter-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(`--${name}`);
const piper = option('piper', process.env.EASTER_PIPER ?? join(root, '.cache/piper-env/bin/piper'));
const voices = resolve(option('voices', join(root, '.cache/piper-voices')));
const out = resolve(option('out', join(root, 'src/viewer/easter-audio')));
const only = option('only', null)?.split(',');

const TARGET_RMS_DB = -13.5, PEAK_LIMIT_DB = -2, PEAK_CEILING_DB = -0.3, LEAD_SILENCE = 0.02, TAIL_SILENCE = 0.06, TRIM_DB = -45;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1 << 26, ...options});
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 4).join(' ')} failed (${result.status}): ${(result.stderr ?? '').slice(-600)}`);
  return result;
};

/** Overall RMS and sample peak (dBFS) of an audio file as ffmpeg decodes it. */
function levels(file) {
  const text = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'astats=measure_perchannel=none:measure_overall=RMS_level+Peak_level+Number_of_samples',
    '-f', 'null', '-']).stderr;
  const pick = label => Number([...text.matchAll(new RegExp(`${label}:\\s*(-?[\\d.]+)`, 'g'))].pop()?.[1] ?? NaN);
  const rate = Number(/(\d+) Hz/.exec(text)?.[1]);
  return {rmsDb: pick('RMS level dB'), peakDb: pick('Peak level dB'), seconds: pick('Number of samples') / rate, rate};
}

async function download() {
  mkdirSync(voices, {recursive: true});
  for (const speaker of Object.values(EASTER_VOICES.speakers)) {
    for (const [name, hash] of [[`${speaker.voice}.onnx`, speaker.onnxSha256], [`${speaker.voice}.onnx.json`, speaker.jsonSha256]]) {
      const target = join(voices, name);
      if (existsSync(target) && sha256(readFileSync(target)) === hash) { console.log(`have ${name}`); continue; }
      const url = `https://huggingface.co/rhasspy/piper-voices/resolve/${EASTER_VOICES.revision}/${speaker.path}/${name}`;
      console.log(`fetch ${url}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
      if (sha256(readFileSync(target)) !== hash) throw new Error(`${name}: sha256 differs from easter-config.mjs`);
    }
  }
}

/** One line: Piper -> trim -> 44.1 kHz -> level -> MP3. Returns the measured clip. */
function synthesise(clip, workdir) {
  const speaker = EASTER_VOICES.speakers[clip.speaker], model = join(voices, `${speaker.voice}.onnx`);
  const raw = join(workdir, `${clip.id}.raw.wav`), trimmed = join(workdir, `${clip.id}.trim.wav`), mp3 = join(out, `${clip.id}.mp3`);
  run(piper, ['-m', model, '-f', raw], {input: `${clip.text}\n`});
  // Leading and trailing silence cut down to LEAD_SILENCE and TAIL_SILENCE; the file is then at 44.1 kHz mono, 32-bit float.
  const silence = (lead) => `silenceremove=start_periods=1:start_threshold=${TRIM_DB}dB:start_silence=${lead}:detection=peak`;
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', raw, '-af',
    `${silence(LEAD_SILENCE)},areverse,${silence(TAIL_SILENCE)},areverse,aresample=44100`, '-ac', '1', '-c:a', 'pcm_f32le', trimmed]);
  // Level: a gain to TARGET_RMS_DB and a limiter, then MPEG-1 Layer III, mono, 44.1 kHz, constant 48 kbps (the game's speech frames
  // FF FB 30 C4), no tag and no Xing header so the file is MPEG frames from byte 0 as in the package. The limiter and the encoder both
  // move the level and the encoder overshoots the limit, so the gain and the limit are corrected against the decoded MP3 itself.
  let gain = TARGET_RMS_DB - levels(trimmed).rmsDb, limitDb = PEAK_LIMIT_DB, measured = null;
  const leveled = join(workdir, `${clip.id}.level.wav`);
  for (let pass = 0; pass < 6; pass++) {
    run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', trimmed, '-af',
      `volume=${gain.toFixed(3)}dB,alimiter=limit=${(10 ** (limitDb / 20)).toFixed(4)}:attack=1:release=40:level=disabled`, '-c:a', 'pcm_f32le', leveled]);
    run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', leveled, '-c:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', '-ar', '44100',
      '-write_xing', '0', '-id3v2_version', '0', '-write_id3v1', '0', mp3]);
    measured = levels(mp3);
    const rmsError = TARGET_RMS_DB - measured.rmsDb, overshoot = measured.peakDb - PEAK_CEILING_DB;
    if (Math.abs(rmsError) < 0.2 && overshoot <= 0) break;
    gain += rmsError;
    if (overshoot > 0) limitDb -= overshoot;
  }
  const bytes = readFileSync(mp3);
  if (!(bytes[0] === 0xff && bytes[1] === 0xfb && bytes[2] === 0x30 && bytes[3] === 0xc4)) throw new Error(`${clip.id}: MPEG header is not FF FB 30 C4`);
  return {id: clip.id, kind: clip.kind, speaker: clip.speaker, text: clip.text, voice: speaker.voice, bytes: bytes.length, sha256: sha256(bytes),
    seconds: Number(measured.seconds.toFixed(3)), rmsDb: Number(measured.rmsDb.toFixed(1)), peakDb: Number(measured.peakDb.toFixed(1))};
}

function check() {
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  let bad = 0;
  for (const clip of easterClips()) {
    const entry = manifest.clips.find(item => item.id === clip.id), file = join(out, `${clip.id}.mp3`);
    if (!entry || !existsSync(file) || entry.text !== clip.text || entry.speaker !== clip.speaker) { console.log(`MISSING or stale: ${clip.id}`); bad++; continue; }
    const bytes = readFileSync(file), measured = levels(file);
    const problems = [];
    if (sha256(bytes) !== entry.sha256) problems.push('sha256 differs from the manifest');
    if (Math.abs(measured.rmsDb - TARGET_RMS_DB) > 1) problems.push(`RMS ${measured.rmsDb} dB`);
    if (measured.peakDb > 0.1) problems.push(`peak ${measured.peakDb} dB`);
    console.log(`${problems.length ? 'BAD ' : 'ok  '} ${clip.id}  ${bytes.length} B  ${measured.seconds.toFixed(2)} s  rms ${measured.rmsDb} peak ${measured.peakDb}${problems.length ? '  ' + problems.join('; ') : ''}`);
    bad += problems.length ? 1 : 0;
  }
  process.exit(bad ? 1 : 0);
}

if (flag('check')) check();
if (flag('download')) await download();
for (const speaker of Object.values(EASTER_VOICES.speakers))
  for (const name of [`${speaker.voice}.onnx`, `${speaker.voice}.onnx.json`])
    if (!existsSync(join(voices, name))) throw new Error(`${join(voices, name)} is missing (run with --download)`);
if (!existsSync(piper)) throw new Error(`piper executable not found at ${piper} (pip install piper-tts into a virtualenv, or pass --piper)`);
mkdirSync(out, {recursive: true});
const manifestPath = join(out, 'manifest.json');
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {clips: []};
const workdir = mkdtempSync(join(tmpdir(), 'easter-voices-'));
const made = new Map(previous.clips.map(clip => [clip.id, clip]));
try {
  for (const clip of easterClips()) {
    if (only && !only.includes(clip.id)) continue;
    const entry = synthesise(clip, workdir);
    made.set(clip.id, entry);
    console.log(`${entry.id}  ${entry.speaker}  ${entry.bytes} B  ${entry.seconds} s  rms ${entry.rmsDb} dB  peak ${entry.peakDb} dB  "${entry.text}"`);
  }
} finally { rmSync(workdir, {recursive: true, force: true}); }
const clips = easterClips().map(clip => made.get(clip.id)).filter(Boolean);
const manifest = {
  note: 'Generated by scripts/easter-voices.mjs (docs/easter-egg.md "Voices"); our own assets, not original game audio.',
  voices: Object.fromEntries(Object.entries(EASTER_VOICES.speakers).map(([who, v]) => [who, {voice: v.voice, license: v.license, onnxSha256: v.onnxSha256,
    modelCard: `https://huggingface.co/rhasspy/piper-voices/blob/${EASTER_VOICES.revision}/${v.path}/MODEL_CARD`}])),
  piperRevision: EASTER_VOICES.revision,
  format: 'MPEG-1 Layer III, mono, 44100 Hz, CBR 48 kbps, no tags',
  target: {rmsDb: TARGET_RMS_DB, peakCeilingDb: PEAK_CEILING_DB},
  totalBytes: clips.reduce((sum, clip) => sum + clip.bytes, 0),
  clips,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${clips.length} clips, ${manifest.totalBytes} bytes in ${out}`);
