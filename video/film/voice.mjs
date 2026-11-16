// JC Denton's line for the dock scene, from the game's own recordings: "Maybe you should try getting a job." It is what
// he says to Cassandra in Paris (conversation MeetCassandra, speech object ConSpeech4702 of DeusExConText.u, soundID 219;
// the conversation's audioPackageName is Mission10, so the recording is the Sound ConAudioMission10_219 of
// DeusExConAudioMission10.u, by the name rule of ConSys' GetSpeechAudio: ConAudio<package>_<soundID>). Found 2026-11-11.
// The recording is read from the local installation and written to video/out/film/voice/ (ignored by Git); nothing is played.
//   node video/film/voice.mjs
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parsePackage} from '../../src/unreal/package.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..'), out = path.resolve(here, '../out/film/voice');
const LINES = {'get-a-job': {pkg: 'DeusExConAudioMission10', sound: 'ConAudioMission10_219', text: 'Maybe you should try getting a job.'}};

mkdirSync(out, {recursive: true});
for (const [name, line] of Object.entries(LINES)) {
  const bytes = readFileSync(path.join(repo, 'Deus Ex GOTY Edition', 'System', `${line.pkg}.u`)), pkg = parsePackage(bytes);
  let entry = null;
  for (const e of pkg.exports) if (e && e.name === line.sound && e.className === 'Sound') entry = e;
  if (!entry) throw new Error(`${line.sound} is not in ${line.pkg}.u`);
  const object = bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize);
  const start = object.indexOf(Buffer.from([0xff, 0xfb]));                 // the MPEG audio inside the Sound object
  if (start < 0 || start > 32) throw new Error(`${line.sound}: no MPEG audio where it was expected`);
  const mp3 = path.join(out, `${name}.mp3`), wav = path.join(out, `${name}.wav`);
  writeFileSync(mp3, object.subarray(start));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp3, '-ar', '48000', '-ac', '2', wav], {stdio: 'inherit'});
  if (r.status !== 0) throw new Error('ffmpeg failed');
  console.log(`${name}: "${line.text}" -> ${path.relative(repo, wav)}`);
}
