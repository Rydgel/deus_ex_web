import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {installActorFlagWords, actorWordOf} from '../src/runtime/actor-flag-words.mjs';

// execVisibleActors (Engine.dll 0x103e5260) skips a candidate whose AActor
// +0x28 dword has bit 1, bHidden (`test byte ptr [edi+0x28], 2` at
// 0x103e5394; SDK AActor +0x028:1-1). Regression: the port tested the host
// `actorFlags` word, which in Play carries only bStatic, bDeleteMe,
// bCollideWhenPlacing and bMovable, so hidden actors were yielded.

const ROOT = 'Deus Ex GOTY Edition';

test('VisibleActors skips a candidate whose image bHidden is set, whatever its host actorFlags', async () => {
  const files = [];
  for (const name of await readdir(`${ROOT}/System`))
    if (/\.u$/i.test(name)) files.push({path: `System/${name}`, read: () => readFile(`${ROOT}/System/${name}`)});
  const assets = new AssetStore(files);
  const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
  const engine = await assets.get('Engine');
  const cls = await runtime.loadClass(engine, engine.exportsByPath.get('actor'));
  const actor = (name, position) => {
    const host = {name, position};
    runtime.attach(host, cls);
    return host;
  };
  const source = actor('Source', [0, 0, 0]);
  const shown = actor('Shown', [10, 0, 0]), hidden = actor('Hidden', [20, 0, 0]), spawned = actor('Spawned', [30, 0, 0]);
  // A map host's `actorFlags` is the masked image accessor (level load
  // composes the same four bits); bHidden is written as a script would.
  for (const host of [shown, hidden]) {
    const instance = runtime.instance(host);
    host.actorFlags = instance.arena.view.getUint32(instance.base + 0x28, true) & 0xa0081;
    installActorFlagWords(host, instance, {actor: true});
  }
  runtime.writeNamed(hidden, 'bHidden', true);
  runtime.writeNamed(spawned, 'bHidden', true);
  assert.equal(hidden.actorFlags & 2, 0, 'the host word never carries bHidden');
  assert.equal(actorWordOf(runtime.instance(hidden)) & 2, 2);
  assert.equal(actorWordOf(runtime.instance(shown)) & 2, 0);

  const checks = [];
  const level = {actors: [null, shown, hidden, spawned, source], model: {},
    fastLineCheck: (model, from, to) => { checks.push(from[0]); return 1; }};
  runtime.actorClass = cls; runtime.levelFor = () => level;
  let out = null;
  const sink = {reference: true, get: () => out, set: value => { out = value; }};
  const iterator = runtime.createIterator({index: 311, receiver: source, argumentCount: 2,
    evaluateArgument: i => [null, sink][i]});
  const yields = [];
  while (iterator.next()) yields.push(out.name);
  assert.deepEqual(yields, ['Shown', 'Source']);
  // A hidden candidate never reaches FastLineCheck (the skip precedes it).
  assert.deepEqual(checks, [10, 0]);
});
