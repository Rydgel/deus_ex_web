import test from 'node:test';
import assert from 'node:assert/strict';
import { LowerNameTable } from '../src/runtime/lower-name-table.mjs';

// The Map it replaced: key text.toLowerCase(), the next number for a key not seen.
function model(first) {
  const keys = new Map();
  let next = first;
  return {
    find: text => keys.get(text.toLowerCase()) ?? -1,
    add: text => { keys.set(text.toLowerCase(), next); return next++; },
    size: () => keys.size,
  };
}

test('names equal up to case share a number, numbered from the first in the order added', () => {
  const table = new LowerNameTable(0x400);
  assert.equal(table.find('Actor'), -1);
  assert.equal(table.add('Actor'), 0x400);
  assert.equal(table.add('Pawn'), 0x401);
  assert.equal(table.find('ACTOR'), 0x400);
  assert.equal(table.find('pawn'), 0x401);
  assert.equal(table.find('Pawns'), -1);
  assert.equal(table.add(''), 0x402);
  assert.equal(table.find(''), 0x402);
  assert.equal(table.size, 3);
});

test('a text that is not ASCII takes its lowercase string first, as toLowerCase does', () => {
  const table = new LowerNameTable(10);
  const texts = ['K', 'k', 'ΑΣ', 'ας', 'İ', 'i̇', 'Ünï', 'ÜNÏ', 'x', 'X', '\u{1F600}', 'é', 'É', 'ß'];
  const reference = model(10);
  for (const text of texts) {
    const have = reference.find(text);
    assert.equal(table.find(text), have, `find ${JSON.stringify(text)}`);
    if (have < 0) assert.equal(table.add(text), reference.add(text), `add ${JSON.stringify(text)}`);
  }
  for (const text of texts) assert.equal(table.find(text), reference.find(text), `again ${JSON.stringify(text)}`);
  assert.equal(table.size, reference.size());
  // the Kelvin sign lowercases to an ASCII k: one name with 'K' and 'k'
  assert.equal(table.find('K'), table.find('k'));
});

test('thousands of names with repeated spellings, colliding hashes and non-ASCII letters agree with the Map', () => {
  let seed = 11;
  const next = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const letters = 'aAbBcCzZ_09éÉΣσ';
  const word = () => Array.from({ length: 1 + next(7) }, () => letters[next(letters.length)]).join('');
  const table = new LowerNameTable(0x400), reference = model(0x400);
  for (let i = 0; i < 20000; i++) {
    const text = word(), have = reference.find(text);
    assert.equal(table.find(text), have, text);
    if (have < 0) assert.equal(table.add(text), reference.add(text), text);
  }
  assert.equal(table.size, reference.size());
});
