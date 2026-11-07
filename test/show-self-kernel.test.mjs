/** The ABI the ShowSelf pawn-list walk shares with showself.rs: the exports the host calls, and the width of the field table it fills. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ShowSelfHost, showSelfMode} from '../src/runtime/show-self-kernel.mjs';

const source = readFileSync(new URL('../native/script-vm/src/showself.rs', import.meta.url), 'utf8');

test('the exports the show self host calls exist in showself.rs', () => {
  const exports = [...source.matchAll(/pub extern "C" fn (\w+)\(/g)].map(m => m[1]).sort();
  assert.deepEqual(exports, ['showself_fields_ptr', 'showself_scan']);
  assert.equal(Number(source.match(/static mut SS_FIELDS: \[u32; (\d+)\]/)[1]), 4, 'two offsets and two key ids');
});

test('the scanner is null where the whole walk stays in JavaScript', () => {
  const host = new ShowSelfHost({arena: null});
  assert.equal(host.scanner(() => 0, () => null), null, 'no module attached');
  assert.equal(showSelfMode(), process.env.SHOW_SELF || 'rust');
});

test('the verify mode catches a pawn Rust skipped', () => {
  const host = new ShowSelfHost({arena: null});
  const pawns = [{name: 'a', next: null}, {name: 'b', next: null}, {name: 'c', next: null}];
  pawns[0].next = pawns[1]; pawns[1].next = pawns[2];
  const counters = new Map([[pawns[0], 1], [pawns[1], -1], [pawns[2], 1]]);
  const read = pawn => counters.get(pawn), next = pawn => pawn.next, player = {name: 'player'};
  host.verify(pawns[0], player, pawns[1], read, next);
  host.verify(pawns[0], player, null, () => 1, next);
  assert.throws(() => host.verify(pawns[0], player, pawns[2], read, next), /Rust skipped b/);
  assert.throws(() => host.verify(pawns[0], player, {name: 'x'}, () => 1, next), /not on the list/);
  assert.throws(() => host.verify(pawns[0], player, null, read, next), /Rust skipped b/);
});
