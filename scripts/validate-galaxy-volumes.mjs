/** Galaxy's instant volumes against Galaxy.dll (docs/galaxy-volumes.md).
 *
 * scripts/native-galaxy-volume-oracle.py runs UGalaxyAudioSubsystem's
 * SetInstantSoundVolume/SpeechVolume/MusicVolume bodies (with Galaxy's _ftol
 * and volume setters) on every byte pair of a grid and reports the subsystem's
 * bytes and Galaxy's volume globals; src/runtime/galaxy-volumes.mjs must give
 * the same bytes and digital volume, and leave the music globals alone without
 * a playing song. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createGalaxyVolumes } from '../src/runtime/galaxy-volumes.mjs';
import { gameDirectory } from './game-directory.mjs';

const VALUES = [0, 1, 2, 31, 32, 63, 64, 100, 127, 128, 153, 191, 192, 204, 254, 255];
const cases = [];
for (const native of [268, 269, 270])
  for (const value of VALUES) for (const other of VALUES)
    cases.push({ native, value, music: 153, sound: native === 269 ? other : 204, speech: native === 268 ? other : 255 });
const directory = path.resolve('reports/galaxy-volumes');
mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, 'cases.json'), JSON.stringify(cases));
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, [path.resolve('scripts/native-galaxy-volume-oracle.py'), gameDirectory(),
  path.join(directory, 'cases.json')], { encoding: 'utf8', maxBuffer: 16 << 20 }));
assert.equal(oracle.hash, '606e71d13bbd3c4db2460aabcf60d87b1c79bb49d77725cf9e087513c7d06353');
let digital = 0;
for (const [i, c] of cases.entries()) {
  const original = oracle.results[i];
  const galaxy = createGalaxyVolumes({ musicVolume: c.music, soundVolume: c.sound, speechVolume: c.speech });
  if (c.native === 268) galaxy.setInstantSoundVolume(c.value);
  else if (c.native === 269) galaxy.setInstantSpeechVolume(c.value);
  else galaxy.setInstantMusicVolume(c.value);
  const { state } = galaxy, label = `${c.native}(${c.value}) music ${c.music} sound ${c.sound} speech ${c.speech}`;
  assert.deepEqual([state.musicVolume, state.soundVolume, state.speechVolume], [original.music, original.sound, original.speech], `${label}: bytes`);
  if (c.native === 270) {
    assert.equal(state.digitalVolume, null, `${label}: no digital volume`);
    for (const key of ['glxDigital', 'glxMusic', 'glxMusicFade', 'glxMusicTarget']) assert.equal(original[key], 0xee, `${label}: ${key} untouched without a song`);
  } else {
    assert.deepEqual([state.digitalVolume, 0, state.digitalVolume], [original.glxDigital, original.glxDigitalFade, original.glxDigitalTarget], `${label}: digital volume`);
    digital++;
  }
}
console.log(`Galaxy instant volumes: ${cases.length} cases equal to Galaxy.dll (${digital} digital volumes, music without a song).`);
