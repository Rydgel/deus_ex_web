/** The native registry (src/runtime/native-registry.mjs, docs/native-census.md) must say what Play's dispatchers do: each
 * registered site's code is read statically and compared with its declaration in both directions, every source file that
 * compares a call's native index is either a registered site or listed as not one, and the VM and Rust layers agree with the
 * dispatchers. A failure names the site and the indices on each side. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {NATIVE_SITES, NOT_DISPATCHERS, NATIVE_CONSTANTS, RUST_NATIVES, LATENT_POLLS, NATIVE_DECISIONS, handledNatives, idx} from '../src/runtime/native-registry.mjs';
import {primitiveNativeIndices} from '../src/runtime/script-vm.mjs';
import {moverPrimitiveIndices} from '../src/runtime/script-mover-primitives.mjs';
import {decorationPrimitiveIndices} from '../src/runtime/script-decoration-primitives.mjs';
import {readSites, compareSite, sourceViews, siteBody, routedByCode, expandRanges} from '../scripts/native-dispatch-parse.mjs';

const base = fileURLToPath(new URL('..', import.meta.url));
const routedBySite = await readSites(NATIVE_SITES, {base, constants: NATIVE_CONSTANTS});
const siteById = new Map(NATIVE_SITES.map(site => [site.id, site]));

test('the registry has unique sites, sorted unique indices and sites that exist', () => {
  assert.equal(siteById.size, NATIVE_SITES.length, 'site ids are unique');
  for (const site of NATIVE_SITES) {
    const indices = site.indices ?? [];
    assert.equal(new Set(indices).size, indices.length, `${site.id}: duplicate indices`);
    for (const index of indices) assert.ok(Number.isInteger(index) && index > 0 && index < 0x10000, `${site.id}: ${index}`);
    assert.ok(site.anchor || site.parsed === false, `${site.id}: has no anchor to read`);
  }
});

for (const site of NATIVE_SITES) {
  if (!routedBySite.has(site.id)) continue;
  test(`the code of ${site.id} routes what the registry declares`, () => {
    const difference = compareSite(site, routedBySite.get(site.id));
    for (const [what, items] of Object.entries(difference)) {
      assert.deepEqual(items, [], `${site.id} (${site.file}): ${what} ${JSON.stringify(items)}; update src/runtime/native-registry.mjs or the dispatcher`);
    }
  });
}

test('a gate forwards to a registered child, and a child handles only what some gate sends it', () => {
  const sent = new Map();
  for (const site of NATIVE_SITES) {
    for (const [from, to, child] of site.gates ?? []) {
      assert.ok(siteById.has(child), `${site.id}: gate ${from}-${to} names the unknown site ${child}`);
      if (!sent.has(child)) sent.set(child, new Set());
      for (let index = from; index <= to; index++) sent.get(child).add(index);
    }
  }
  for (const [child, gate] of sent) {
    const stray = (siteById.get(child).indices ?? []).filter(index => !gate.has(index));
    assert.deepEqual(stray, [], `${child} handles indices no gate forwards to it`);
  }
});

test('the VM primitives are the cases of native(), the mover and decoration primitives and the short circuits', () => {
  const site = siteById.get('vm-primitives');
  const views = sourceViews(readFileSync(path.join(base, site.file), 'utf8'));
  const cases = routedByCode(siteBody(views, site), {constants: NATIVE_CONSTANTS});
  const dynamic = [...cases.dynamic].sort();
  assert.deepEqual(dynamic, [...site.dynamic].sort(), 'native() run-time lookups');
  const expected = new Set([...cases.indices, ...moverPrimitiveIndices, ...decorationPrimitiveIndices, 130, 132]);
  assert.deepEqual([...new Set(primitiveNativeIndices)].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
  assert.deepEqual([...site.indices].sort((a, b) => a - b), [...primitiveNativeIndices].sort((a, b) => a - b));
});

test('every Rust-lowered native also has a JavaScript dispatcher', () => {
  const handled = handledNatives({layers: ['vm', 'runtime', 'window-host', 'play-host']}).byIndex;
  const missing = [...RUST_NATIVES.lowered, ...RUST_NATIVES.aiEvents].filter(index => !handled.has(index));
  assert.deepEqual(missing, [], 'Rust kinds for natives no JavaScript dispatcher routes');
});

test('the Rust AI event manager natives are the cases of aiEventNative', () => {
  const file = readFileSync(path.join(base, 'src/runtime/script-runtime.mjs'), 'utf8');
  const body = siteBody(sourceViews(file), {id: 'aiEventNative', anchor: /\n {2}aiEventNative\(aiEvents,call\) \{/});
  const cases = routedByCode(body).indices;
  // 710, 711 (callbacks), 713, 714, 715 (events); 716 is the switch's default
  assert.deepEqual([...cases].sort((a, b) => a - b), [710, 711, 713, 714, 715]);
  assert.deepEqual([...RUST_NATIVES.aiEvents].sort((a, b) => a - b), [650, 710, 711, 713, 714, 715, 716]);
});

test('every latent native has a poll the runtime routes', () => {
  const polls = new Set(Object.values(LATENT_POLLS));
  const runtime = readFileSync(path.join(base, 'src/runtime/script-runtime.mjs'), 'utf8');
  const doors = readFileSync(path.join(base, 'src/runtime/script-doors.mjs'), 'utf8');
  const runtimePoll = routedByCode(siteBody(sourceViews(runtime), {id: 'pollLatent', anchor: /pollLatent:call=>\{/}));
  const doorsPoll = routedByCode(siteBody(sourceViews(doors), {id: 'doors pollLatent', anchor: /runtime\.pollLatent = \(\{ index, receiver, state \}\) => \{/}));
  assert.deepEqual([...runtimePoll.indices].sort((a, b) => a - b), [384, 385, 501, 503, 505, 507, 509, 511, 528]);
  assert.deepEqual([...doorsPoll.indices], [302]);
  assert.deepEqual([...polls].sort((a, b) => a - b), [302, 384, 385, 501, 503, 505, 507, 509, 511, 528]);
});

test('every source file that compares a call\'s native index is a registered site or listed as not one', () => {
  const registered = new Set(NATIVE_SITES.map(site => site.file));
  const found = [];
  for (const directory of ['src/runtime', 'src/viewer', 'src/unreal']) {
    for (const name of readdirSync(path.join(base, directory)).filter(file => file.endsWith('.mjs'))) {
      const file = `${directory}/${name}`;
      const code = sourceViews(readFileSync(path.join(base, file), 'utf8'));
      // A native handler reads `call.index`, or tests the function key of a native bound by name.
      if (/\bcall\??\.index\b/.test(code.code) || /\bcall\??\.record\??\.key\s*[!=]==\s*'[^'.]+\.[^'.]+\.[^']+'/.test(code.text)) found.push(file);
    }
  }
  const unlisted = found.filter(file => !registered.has(file) && !(file in NOT_DISPATCHERS));
  assert.deepEqual(unlisted, [], 'new native dispatch code: register it in src/runtime/native-registry.mjs (NATIVE_SITES) or explain it in NOT_DISPATCHERS');
  const stale = Object.keys(NOT_DISPATCHERS).filter(file => !found.includes(file) && !registered.has(file));
  assert.deepEqual(stale, [], 'NOT_DISPATCHERS lists files that no longer compare a native index');
});

test('the comparison fails in both directions', () => {
  const code = `function handle(call) { if (call.index === 5) return 1; switch (call.index) { case 7: case 8: return 2; } if (call.index >= 20 && call.index <= 22) return 3; return table.get(call.index); }`;
  const routed = routedByCode({code: code, text: code});
  assert.deepEqual([...routed.indices].sort((a, b) => a - b), [5, 7, 8]);
  assert.deepEqual(routed.ranges, [[20, 22]]);
  assert.deepEqual([...routed.dynamic], ['table.get(index)']);
  const agree = compareSite({indices: [5, 7, 8, 20, 21, 22], dynamic: ['table.get(index)']}, routed);
  assert.deepEqual(Object.values(agree).flat(), []);
  const forgotten = compareSite({indices: [5, 7, 20, 21, 22], dynamic: ['table.get(index)']}, routed);
  assert.deepEqual(forgotten.undeclared, [8], 'code routes a native the registry does not declare');
  const stale = compareSite({indices: [5, 7, 8, 9, 20, 21, 22], dynamic: ['table.get(index)']}, routed);
  assert.deepEqual(stale.unrouted, [9], 'registry declares a native the code does not route');
  const gated = compareSite({indices: [5, 7, 8], gates: [[20, 22, 'child']], dynamic: ['table.get(index)']}, routed);
  assert.deepEqual(Object.values(gated).flat(), [], 'a gate accounts for the range it forwards');
  assert.deepEqual(compareSite({indices: [5, 7, 8, 20, 21, 22]}, routed).undeclaredLookups, ['table.get(index)']);
});

test('handledNatives drops what a gate forwards and the name-bound marker', () => {
  const {byIndex, byName} = handledNatives();
  assert.ok(byIndex.has(1472), 'FindWindow is handled');
  assert.ok(byIndex.get(1472).includes('window-host'));
  assert.ok(byIndex.has(1535) && !byIndex.get(1535).includes('runtime-invoke'), 'TileWindow setters belong to their child site');
  assert.ok(!byIndex.has(0));
  assert.ok(byName.has('core.object.getenum'));
  assert.deepEqual(idx('1 3-5'), [1, 3, 4, 5]);
  assert.equal(expandRanges([[2, 4]]).size, 3);
});

test('a decided native is not also handled, and each decision names its reason, evidence and date', () => {
  const {byIndex, byName} = handledNatives();
  const seen = new Set();
  for (const decision of NATIVE_DECISIONS) {
    assert.ok(!seen.has(decision.native), `${decision.native} is decided twice`);
    seen.add(decision.native);
    const handled = typeof decision.native === 'number' ? byIndex.has(decision.native) : byName.has(decision.native);
    assert.ok(!handled, `${decision.native} is decided "${decision.decision}" but a dispatcher routes it: drop or rewrite the decision`);
    assert.ok(['not-reached', 'host-path', 'unsupported'].includes(decision.decision), `${decision.native}: decision kind`);
    assert.ok(typeof decision.name === 'string' && decision.name, `${decision.native}: name`);
    for (const field of ['reason', 'evidence'])
      assert.ok(typeof decision[field] === 'string' && decision[field].length > 40, `${decision.native}: ${field}`);
    assert.match(decision.date, /^\d{4}-\d{2}-\d{2}$/, `${decision.native}: date`);
  }
});
