/** UGameEngine::LoadMap's tail resets every viewport's input (docs/script-input-reset.md): a loaded player does not keep the input bytes it was saved with.
 *
 * Engine.dll 0x1038dfe0..0x1038e004 runs `Client->Viewports(i)->Input->ResetInput()` right after the new level's moving brush tracker exists and Login has
 * given the viewport its player. ResetInput (0x10394910) zeroes the held-key table, every CPF_Input ByteProperty and FloatProperty of the viewport's Actor
 * (bDuck, bRun, aForward ... the saved values included) and Action/Delta. A pawn saved crouched (bDuck 1) therefore stands up after the load.
 *
 * A: Play-only round trip (Training): bDuck, bRun and aForward are set on the player, the level is saved and loaded; the loaded player holds none of them and
 *    stands (the crouch is undone on the first ticks); a cold start and a travel (LocalTravel) also begin with the inputs at zero.
 * B: when the third-party slot (outside Git: .work/internet-saves, retromaggedon Save0021, the pawn saved crouched in a duct, Z -491.1) and the Wine capture
 *    of the original loading it (.work/travel/fan4, props of JCDentonMale2) are present: the loaded player's Location after the first ticks equals the original's
 *    dump bit for bit (Z -464.100006), Health 82 as in the dump.
 *
 *   node scripts/validate-load-input-reset.mjs */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-load-input-reset: no installed game data'); process.exit(0); }
const here = new URL('..', import.meta.url).pathname;
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const picture = ({ pitch, height }) => Uint8Array.from({ length: pitch * height }, (_, i) => (i % pitch < 160 && (i / pitch | 0) < 120) ? ((i % pitch) * 3 + (i / pitch | 0)) & 255 : 0);
const consoleLine = (c, line) => c.game.hud.scoped(() => c.game.hud.host.consoleCommands.consoleCommand(c.player(), line));
const INPUTS = ['bDuck', 'bRun', 'bStrafe', 'bFire'];

// ---- A ----------------------------------------------------------------------------------------------------------------------------------------------
{
  const directory = createSaveDirectory({ freeSpaceBytes: 8 * 1024 ** 3 });
  const { c } = await openSession('00_Training', assets, { travel: { snapshotSource: picture }, saveDirectory: directory });
  c.frames(30);
  const p = c.player();
  for (const name of INPUTS) assert.equal(c.read(p, name), 0, `a cold start begins with ${name} clear`);
  c.runtime.writeNamed(p, 'bDuck', 1); c.runtime.writeNamed(p, 'bRun', 1); c.runtime.writeNamed(p, 'aForward', 1000);
  c.frames(20);
  assert.ok(c.read(p, 'bIsCrouching'), 'the player crouches while bDuck is set');
  // the input bytes the level tick resets (CPF_Input floats) are not what is saved: set them again right before the save
  c.runtime.writeNamed(p, 'bDuck', 1); c.runtime.writeNamed(p, 'bRun', 1); c.runtime.writeNamed(p, 'aForward', 1000);
  consoleLine(c, 'SaveGame 5'); c.frames(2);
  consoleLine(c, 'LoadGame 5'); c.frames(2);
  const request = c.takeTravel();
  assert.ok(request?.restore, 'LoadGame 5 restores the slot');
  const { c: d } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL, snapshotSource: picture }, saveDirectory: directory });
  const q = d.player();
  for (const name of INPUTS) assert.equal(d.read(q, name), 0, `the loaded player's ${name} was reset by LoadMap's ResetInput`);
  assert.equal(d.read(q, 'aForward'), 0, 'aForward (a CPF_Input float) is zero');
  const crouched = d.read(q, 'CollisionHeight');
  d.frames(20);
  assert.ok(d.read(q, 'CollisionHeight') > crouched, `the loaded player stands up (CollisionHeight ${crouched} -> ${d.read(q, 'CollisionHeight')})`);
  assert.equal(d.read(q, 'bIsCrouching'), false);
  console.log(`PASS A: bDuck/bRun/aForward saved set, loaded zero; CollisionHeight ${crouched} -> ${d.read(q, 'CollisionHeight')} on the first ticks`);
}

// ---- B ----------------------------------------------------------------------------------------------------------------------------------------------
{
  // The outside-Git inputs: the third-party slot and the Wine capture, from this checkout's .work or the main checkout's.
  const stores = [path.join(here, '.work'), '/home/rydgel/projects/deus_ex_web/.work'];
  const slotDir = stores.map(store => path.join(store, 'internet-saves/retromaggedon/files/Save0021')).find(existsSync);
  const dump = stores.map(store => path.join(store, 'travel/fan4/pl1.props.txt')).find(existsSync);
  if (!slotDir || !dump) console.log('SKIP B: the Save0021 copy or the Wine capture (outside Git) is not here');
  else {
    const text = await readFile(dump, 'latin1');
    const row = text.split('\n').find(line => line.startsWith('JCDentonMale JCDentonMale2'));
    const wanted = /Location=\(([^,]+),([^,]+),([^)]+)\)/.exec(row).slice(1, 4).map(v => Math.fround(Number(v)));
    const entries = [];
    for (const name of await readdir(slotDir)) entries.push({ name, bytes: new Uint8Array(await readFile(path.join(slotDir, name))) });
    const info = parseSaveInfo(entries.find(entry => entry.name === 'SaveInfo.dxs').bytes);
    const directory = createSaveDirectory({ saves: [{ directory: 'Save0021', files: entries, info }] });
    const { c } = await openSession('DX', assets, { travel: {}, saveDirectory: directory });
    c.frames(5);
    consoleLine(c, 'LoadGame 21'); c.frames(2);
    const request = c.takeTravel();
    assert.ok(request?.restore, 'LoadGame 21 restores the slot');
    const { c: d } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL }, saveDirectory: directory });
    assert.equal(d.read(d.player(), 'bDuck'), 0, 'Save0021 holds bDuck 1; the loaded player has it reset');
    d.frames(60);
    const at = d.read(d.player(), 'Location');
    assert.deepEqual(at, wanted, `the loaded player stands where the original's dump has it (${wanted}), not at ${at}`);
    assert.equal(d.read(d.player(), 'Health'), Number(/Health=0x([0-9a-f]+)/.exec(row)[1].replace(/^/, '0x')), 'Health equals the dump');
    console.log(`PASS B: Save0021's player after 60 ticks at ${at} = the original's dump ${wanted}`);
  }
}
process.exit(0);
