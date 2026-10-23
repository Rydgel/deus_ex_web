/** A decoration's speech in a restored or loaded level (found by the Stage 6 chain of mission 1, docs/stage-6-chains.md): the police boat's first-person conversation
 * GotoM02 after the Island was restored from Save\Current (HQ round trip) or loaded from a real slot stopped at `Unsupported original door native 264 PlaySound from
 * conplay.playspeech`: the boat, a map actor of a restored level, has no measured GObjObjects slot, and the speech's channel id needs an emitter index.
 *
 * The one model of a restored level (docs/travel.md "Unresolved" 10, labelled and unverified: each restored object's registry index is 0x100000 + its export index) now
 * serves the sound routes too (ScriptRuntime.soundObjectIndex, source 'restored'), reported with the modeled spawns' (audio.modeledIds). Checked:
 *   - a fresh Island's boat still has its measured index (source 'measured', 36115 in the open capture);
 *   - the Island restored from the filed level after a visit to HQ: the boat's index is 0x100000 + its export index, and GotoM02 plays its speech (no stop);
 *   - the Island loaded from a real slot (nicouzouf Save0002 of .work/internet-saves; SKIP without it): the same path.
 *
 *   node scripts/validate-restored-speech.mjs */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import './census-stage5-drivers.mjs';
import { loadAssets, typeLine, conversationOf } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';
import { placeLines } from './chain-lib.mjs';
import { gameDirectory } from './game-directory.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-restored-speech: no installed game data'); process.exit(0); }
const assets = await loadAssets();

/** The boat's GotoM02 as the chain plays it: the flag it needs, the dock's edge, the right button; true when its first speech plays. */
function gotoM02(c) {
  const boat = c.actor('NYPoliceBoat0');
  c.watched.add(boat);
  c.read(c.player(), 'FlagBase').setBool('M02Briefing_Played', true, true, 0);   // the briefing's flag (the chain gets it from M02Briefing)
  for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at: [-4780, 10139, -250], view: [0, 32768] })]) { typeLine(c, line); c.frames(20); }
  c.frames(60);
  typeLine(c, 'ParseRightClick'); c.frames(30);
  const state = conversationOf(c);
  return state?.name === 'GotoM02' && state.event === 'speech';
}

// 1. a fresh Island
{
  const { c } = await openSession('01_NYC_UNATCOIsland', assets, { travel: {} });
  c.frames(60);
  const index = c.runtime.soundObjectIndex(c.actor('NYPoliceBoat0'));
  assert.deepEqual(index, { index: 36115, source: 'measured' }, 'a fresh level keeps its measured indices');
  assert.ok(gotoM02(c), 'GotoM02 plays on a fresh Island');
  console.log('fresh Island: the boat is', JSON.stringify(index), 'and GotoM02 plays');
}

// 2. the Island restored from the filed level (HQ and back)
{
  const directory = createSaveDirectory();
  const { c } = await openSession('01_NYC_UNATCOIsland', assets, { travel: {}, saveDirectory: directory });
  c.frames(60);
  c.exec('LocalTravel 01_NYC_UNATCOHQ#Inside_UN_HQ'); c.frames(2);
  const toHq = c.takeTravel();
  assert.ok(toHq, 'the Island leaves for HQ');
  const { c: hq } = await openSession(toHq.map, assets, { travel: { arrival: toHq, lastURL: toHq.lastURL }, saveDirectory: directory });
  hq.frames(60);
  hq.exec('LocalTravel 01_NYC_UNATCOIsland#tunnel_drop_nyc'); hq.frames(2);
  const back = hq.takeTravel();
  assert.ok(back?.restore, 'the way back restores the filed Island');
  const { c: island } = await openSession(back.map, assets, { travel: { arrival: back, lastURL: back.lastURL }, saveDirectory: directory });
  island.frames(60);
  const boat = island.actor('NYPoliceBoat0'), index = island.runtime.soundObjectIndex(boat);
  assert.equal(index?.source, 'restored', 'a restored level\'s actor takes the restored-level model');
  assert.equal(index.index, island.runtime.instance(boat).nativeObject.hashIndex, 'the index is the object\'s modeled hash slot');
  assert.ok(index.index > 0x100000 && index.index < 0x100000 + 0x10000, 'the model is 0x100000 + the export index');
  assert.ok(gotoM02(island), 'GotoM02 plays on the restored Island');
  assert.ok(island.runtime.audio.modeledIds.get('NYPoliceBoat (restored-level model)') >= 1, 'the restored-level model is reported with the modeled spawns');
  console.log('restored Island: the boat is', JSON.stringify(index), 'and GotoM02 plays; reported:', JSON.stringify([...island.runtime.audio.modeledIds]));
}

// 3. the Island loaded from a real slot
const slot = '/home/rydgel/projects/deus_ex_web/.work/internet-saves/nicouzouf/files/Deus Ex/Save0002';
if (existsSync(`${slot}/SaveInfo.dxs`)) {
  const entries = [];
  for (const file of await readdir(slot)) entries.push({ name: file, bytes: new Uint8Array(await readFile(`${slot}/${file}`)) });
  const info = parseSaveInfo(entries.find(e => e.name === 'SaveInfo.dxs').bytes);
  const directory = createSaveDirectory({ saves: [{ directory: 'Save0201', files: entries, info }] });
  const { c } = await openSession('00_TrainingCombat', assets, { travel: {}, saveDirectory: directory });
  c.frames(60);
  c.exec('LoadGame 201'); c.frames(2);
  const request = c.takeTravel();
  assert.ok(request, 'LoadGame 201 makes a request');
  const { c: loaded } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL }, saveDirectory: directory });
  loaded.frames(120);
  const index = loaded.runtime.soundObjectIndex(loaded.actor('NYPoliceBoat0'));
  assert.equal(index?.source, 'restored', 'a loaded level\'s actor takes the same model');
  assert.ok(gotoM02(loaded), 'GotoM02 plays on the loaded Island');
  console.log('loaded slot (Save0002):', JSON.stringify(index), 'and GotoM02 plays');
} else console.log('slot check: SKIP (.work/internet-saves is not here)');
console.log('PASS validate-restored-speech');
process.exit(0);
