import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigCache } from '../src/runtime/config-cache.mjs';
import { readToken, importText, exportText } from '../src/runtime/config-text.mjs';
import { loadConfig, saveConfig, configRoot, defaultsObject } from '../src/runtime/script-config.mjs';

const cacheWith = text => new ConfigCache({ files: new Map([['user.ini', text], ['deusex.ini', '']]) });

test('FConfigFile::Read strips one quote pair and FConfigCacheIni finds the newest key', () => {
  const cache = cacheWith('[A.B]\r\nKey=one\r\nkey="two"\r\n\r\nnoequals\r\n[Empty]\r\n');
  assert.equal(cache.getString('a.b', 'KEY', 'User'), 'two', 'case-insensitive, newest pair first');
  assert.deepEqual(cache.find('User', false).find('A.B').multiFind('key'), ['two', 'one']);
  assert.equal(cache.getString('A.B', 'Missing', 'User'), null);
  assert.equal(cache.getString('A.B', 'Key', 'Absent'), null, 'a missing file is not created by GetString');
  assert.equal(cache.getString('A.B', 'Key', 'User', 3), 'tw', 'GetString keeps Size-1 characters');
});

test('SetString keeps the launcher dirty rule and Flush writes Pairs order', () => {
  const cache = cacheWith('[A.B]\r\nX=True\r\n');
  const file = cache.find('User', false);
  cache.setString('A.B', 'X', 'true', 'User');
  assert.equal(file.dirty, false, 'a case-insensitively equal value is left alone');
  assert.equal(cache.getString('A.B', 'X', 'User'), 'True');
  cache.setString('A.B', 'X', 'False', 'User');
  assert.equal(file.dirty, true);
  cache.setString('A.B', 'Y', '1', 'User');
  cache.flush(true);
  assert.equal(cache.written.get('user.ini'), '[A.B]\r\nX=False\r\nY=1\r\n\r\n');
  assert.equal(cache.getString('A.B', 'Y', 'User'), '1', 'Flush(1) drops the file; Find re-reads the written text');
  assert.equal(cache.resolveName('System'), 'DeusEx.ini');
  assert.equal(cache.resolveName('Foo.int'), 'Foo.int', 'an existing extension is kept');
});

test('ReadToken and the ImportText bodies', () => {
  assert.deepEqual(readToken('Abc_d-e.f rest'), { token: 'Abc_d-e', rest: '.f rest' });
  assert.deepEqual(readToken('a.b', 0x400, true), { token: 'a.b', rest: '' });
  assert.deepEqual(readToken('"q\\41\\\\" x'), { token: 'qA\\', rest: ' x' });
  assert.deepEqual(readToken('*x'), { token: '*', rest: '*x' }, 'another first character is not consumed');
  assert.equal(readToken('"open'), null);
  assert.deepEqual(importText('bool', 'TRUE'), { rest: '', value: true });
  assert.deepEqual(importText('bool', '0'), { rest: '', value: false });
  assert.equal(importText('bool', 'yes'), null);
  assert.deepEqual(importText('int', '-12x'), { rest: 'x', value: -12 });
  assert.deepEqual(importText('int', 'x'), { rest: 'x', value: undefined }, 'int ImportText never fails');
  assert.deepEqual(importText('float', '3.25,next'), { rest: ',next', value: 3.25 });
  assert.equal(importText('float', '0.1').value, Math.fround(0.1));
  assert.deepEqual(importText('byte', '7a'), { rest: 'a', value: 7 });
  assert.equal(importText('byte', '-1'), null, 'a byte needs a leading digit');
  assert.deepEqual(importText('byte', 'b', { enumNames: ['a', 'B'] }), { rest: '', value: 1 });
  assert.deepEqual(importText('name', ''), { rest: '', value: 'None' });
  assert.deepEqual(importText('string', 'Default x'), { rest: 'Default x', value: 'Default x' });
});

test('ExportTextItem bodies, including MSVC %f rounding', () => {
  assert.equal(exportText('bool', true), 'True');
  assert.equal(exportText('int', -3), '-3');
  assert.equal(exportText('float', 3), '3.000000');
  assert.equal(exportText('float', Math.fround(0.1)), '0.100000');
  assert.equal(exportText('float', Math.fround(0.9999996)), '1.000000');
  assert.equal(exportText('float', Math.fround(6e-7)), '0.000001');
  assert.equal(exportText('float', Math.fround(4e-7)), '0.000000');
  assert.equal(exportText('float', -1.5), '-1.500000');
  assert.equal(exportText('byte', 1, { enumNames: ['A', 'B'] }), 'B');
  assert.equal(exportText('name', 'AugSpeed'), 'AugSpeed');
});

// A minimal native graph: records carry their slots by offset.
function fakeGraph() {
  const record = (kind, path, slots) => ({ kind, path, slots });
  const graph = {
    slotOf: (r, offset) => r.slots[offset],
    superOf: r => r.slots[0x28] ?? null,
    isA: (r, target) => r.kind === target,
    fullName: r => r.path,
    nameText: n => n,
    intern: t => t,
    propertyKindOf: r => r.kind,
    classStatic: 'Class',
  };
  const base = record('Class', 'Pkg.Base', { 0x484: 4, 0x4a0: 'User' });
  const child = record('Class', 'Pkg.Child', { 0x484: 4, 0x4a0: 'User', 0x28: base });
  const property = (kind, name, outer, flags, offset, extra = {}) =>
    record(kind, `${outer.path}.${name}`, { 0x20: name, 0x18: outer, 0x3c: flags, 0x34: 1, 0x38: 4, 0x48: offset, ...extra });
  const global = property('BoolProperty', 'bGlobal', base, 0x44000, 0x30, { 0x5c: 2 });
  const plain = property('IntProperty', 'Count', base, 0x4000, 0x34);
  const list = property('NameProperty', 'Prefs', child, 0x4000, 0x38, { 0x34: 2 });
  base.slots[0x38] = global; global.slots[0x2c] = plain;
  child.slots[0x38] = list;
  return { graph, base, child, global, plain, list };
}

test('LoadConfig takes globalconfig from the owner class, others from the class argument', () => {
  const { graph, base, child } = fakeGraph();
  const cache = cacheWith('[Pkg.Base]\r\nbGlobal=True\r\nCount=5\r\n[Pkg.Child]\r\nbGlobal=False\r\nCount=9\r\nPrefs[1]=AugSpeed\r\n');
  const data = new Map([[0x30, 1]]);
  loadConfig(graph, cache, defaultsObject(graph, child, data));
  assert.equal(data.get(0x30), 3, 'the bool bit comes from [Pkg.Base] and other bits in the word survive');
  assert.equal(data.get(0x34), 9, 'a non-global inherited property reads the class argument section');
  assert.equal(data.get(0x3c), 'AugSpeed', 'fixed arrays use Name[i] keys');
  assert.equal(data.has(0x38), false, 'an absent key leaves the default untouched');
  const propagated = new Map();
  const cacheBaseOnly = cacheWith('[Pkg.Base]\r\nCount=5\r\n');
  loadConfig(graph, cacheBaseOnly, defaultsObject(graph, child, propagated), { propagate: 1 });
  assert.equal(propagated.get(0x34), 5, 'Propagate first loads the super class sections');
  assert.equal(configRoot(graph, child), base);
});

test('SaveConfig exports every config property through SetString and flushes', () => {
  const { graph, child } = fakeGraph();
  const cache = cacheWith('[Pkg.Child]\r\nCount=9\r\n');
  const values = { bGlobal: true, Count: 9, Prefs: ['None', 'AugSpeed'] };
  saveConfig(graph, cache, { cls: child, index: 0,
    read: (property, index) => { const v = values[property.slots[0x20]]; return Array.isArray(v) ? v[index] : v; } });
  assert.equal(cache.written.get('user.ini'),
    '[Pkg.Child]\r\nCount=9\r\nPrefs[0]=None\r\nPrefs[1]=AugSpeed\r\n\r\n[Pkg.Base]\r\nbGlobal=True\r\n\r\n');
});
