import test from 'node:test';
import assert from 'node:assert/strict';
import {internEntries} from '../src/runtime/host-accessors.mjs';

test('internEntries gives one frozen array to equal lists, holes included', () => {
  const a = {}, b = {}, c = {};
  const first = internEntries([a, , c]);
  assert.equal(internEntries([a, undefined, c]), first, 'a hole and undefined are the same');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.length, 3);
  assert.equal(first[1], undefined);
  assert.notEqual(internEntries([a, b, c]), first);
  assert.notEqual(internEntries([a, c]), first);
  assert.notEqual(internEntries([a, , c, undefined]), first, 'a different length is a different list');
  assert.equal(internEntries([a, , c, undefined]).length, 4);
  assert.equal(internEntries([]), internEntries([]));
  // the list given is not kept: a caller that goes on filling its own array does not change the shared one
  const mine = [a];
  const shared = internEntries(mine);
  mine[1] = b;
  assert.equal(shared.length, 1);
});

test('interned arrays and their entries are collected when nothing else holds them (no global keeps a level\'s entries alive)', async () => {
  const {execFileSync} = await import('node:child_process');
  const script = `
    const {internEntries} = await import(${JSON.stringify(new URL('../src/runtime/host-accessors.mjs', import.meta.url).href)});
    const refs = [];
    (function level() {
      for (let host = 0; host < 3; host++) {
        const entries = Array.from({length: 4}, () => ({big: new Array(1000).fill(host)}));
        const list = internEntries([entries[0], undefined, entries[2], entries[3]]);
        refs.push(new WeakRef(list), ...entries.map(entry => new WeakRef(entry)));
      }
    })();
    await new Promise(resolve => setTimeout(resolve, 10));
    for (let i = 0; i < 4; i++) { globalThis.gc(); await new Promise(resolve => setTimeout(resolve, 10)); }
    console.log(JSON.stringify(refs.filter(ref => ref.deref() !== undefined).length));
  `;
  const output = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {encoding: 'utf8'});
  assert.equal(JSON.parse(output.trim().split('\n').at(-1)), 0);
});
