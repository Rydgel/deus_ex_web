import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {nameSlots} from '../src/runtime/script-object-image.mjs';
import {nameId, nameKeyId, nameCellWord, nameSpelling} from '../src/runtime/script-name-ids.mjs';

// R3-c (docs/rust-core.md): a name cell keeps its value in the reference
// array and its nameKeyId in its four bytes (0 for None), which the Rust
// alliance body compares. Checked on DeusEx's real ScriptedPawn layout:
// Pawn.Alliance (+0x5c4) and AlliancesEx's AllianceName members (+0x7ec,
// stride 16).

const ROOT = 'Deus Ex GOTY Edition';
const ALLIANCE_NAME = 'deusex.scriptedpawn.allianceinfoex.alliancename';

async function scriptedPawn() {
  // ScriptedPawn's defaults name sounds and textures, so their packages load too.
  const files = [];
  for (const directory of ['System', 'Sounds', 'Textures'])
    for (const name of await readdir(`${ROOT}/${directory}`))
      files.push({path: `${directory}/${name}`, read: () => readFile(`${ROOT}/${directory}/${name}`)});
  const assets = new AssetStore(files);
  const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
  const deusEx = await assets.get('DeusEx');
  const cls = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('scriptedpawn'));
  const fields = new Map();
  for (let node = cls; node; node = node.base)
    for (const field of node.fields?.values() ?? []) if (!fields.has(field.key)) fields.set(field.key, field);
  await Promise.all([...fields.values()].map(field => runtime.field(field)));
  const host = {name: 'ScriptedPawn0', values: {}};
  runtime.attach(host, cls);
  return {runtime, host, instance: runtime.instance(host)};
}

test('the two name folds differ only for a falsy name that is not None', () => {
  assert.equal(nameId('UNATCO'), nameId('unatco'));
  assert.equal(nameKeyId('UNATCO'), nameKeyId('unatco'));
  assert.equal(nameKeyId('Thugs'), nameId('Thugs'));
  assert.equal(nameId(''), nameId('None'));
  assert.notEqual(nameKeyId(''), nameKeyId('None'));
  assert.equal(nameSpelling(nameKeyId('')), '');
  assert.equal(nameKeyId(null), nameKeyId(undefined));
  assert.equal(nameKeyId(null), nameKeyId('NONE'));
  assert.equal(nameCellWord('None'), 0);
  assert.equal(nameCellWord(null), 0);
  assert.equal(nameCellWord('Player'), nameKeyId('player'));
});

test('a name cell writes its id beside the reference', async () => {
  const {runtime, host, instance} = await scriptedPawn();
  const word = offset => instance.arena.view.getUint32(instance.base + offset, true);
  // A fresh image reads None: zero bytes.
  assert.equal(runtime.readNamed(host, 'Alliance'), 'None');
  assert.equal(word(0x5c4), 0);
  runtime.writeNamed(host, 'Alliance', 'UNATCO');
  assert.equal(runtime.readNamed(host, 'Alliance'), 'UNATCO');
  assert.equal(word(0x5c4), nameKeyId('unatco'));
  runtime.writeNamed(host, 'Alliance', '');
  assert.equal(word(0x5c4), nameKeyId(''));
  assert.notEqual(word(0x5c4), 0);
  runtime.writeNamed(host, 'Alliance', 'None');
  assert.equal(word(0x5c4), 0);

  // Struct members inside a fixed array: AlliancesEx[3].AllianceName.
  const entries = runtime.readNamed(host, 'AlliancesEx');
  assert.equal(entries.length, 16);
  entries[3] = {...entries[3], [ALLIANCE_NAME]: 'Thugs'};
  runtime.writeNamed(host, 'AlliancesEx', entries);
  assert.equal(word(0x7ec + 3 * 16), nameKeyId('thugs'));
  for (const index of [0, 2, 4, 15]) assert.equal(word(0x7ec + index * 16), 0);

  // Every name slot holds its reference's id.
  const slots = nameSlots(instance.cells);
  assert.ok(slots.some(slot => slot.offset === 0x5c4));
  assert.ok(slots.some(slot => slot.offset === 0x7ec + 3 * 16));
  for (const {offset, ref} of slots) assert.equal(word(offset), nameCellWord(instance.refs[ref]), `name at +0x${offset.toString(16)}`);

  // A snapshot restore moves bytes and references together.
  const snapshot = runtime.snapshotStorage(host);
  runtime.writeNamed(host, 'Alliance', 'NSF');
  runtime.restoreStorage(host, snapshot);
  assert.equal(runtime.readNamed(host, 'Alliance'), 'None');
  assert.equal(word(0x5c4), 0);
});
