import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Reader, parsePackage, summarizePackage } from '../src/unreal/package.mjs';

// Hand-authored wire-format vectors; no commercial game data in tests.
test('compact indices decode signs, continuation boundaries, and 32-bit extremes', () => {
  const vectors = [
    [[0], 0], [[0x80], 0], [[0x3f], 63], [[0xbf], -63],
    [[0x40, 1], 64], [[0xc0, 1], -64], [[0x7f, 0x7f], 8191],
    [[0x40, 0x80, 1], 8192],
    [[0x7f, 0xff, 0xff, 0xff, 0x0f], 2147483647],
    [[0xc0, 0x80, 0x80, 0x80, 0x10], -2147483648],
  ];
  for (const [bytes, expected] of vectors) {
    const r = new Reader(Uint8Array.from(bytes));
    assert.equal(r.compact(), expected);
    assert.equal(r.offset, bytes.length);
  }
});

test('compact indices reject truncation and overflow', () => {
  for (const bytes of [[], [0x40], [0x40, 0x80], [0x40, 0x80, 0x80, 0x80, 0x20], [0x40, 0x80, 0x80, 0x80, 0x10]]) {
    assert.throws(() => new Reader(Uint8Array.from(bytes)).compact(), /Truncated|overflow|range/);
  }
});

test('package strings decode ANSI and UTF-16 with required terminators', () => {
  assert.equal(new Reader(Uint8Array.from([4, 68, 88, 33, 0])).string(), 'DX!');
  assert.equal(new Reader(Uint8Array.from([0x83, 0x41, 0, 0xa9, 0x03, 0, 0])).string(), 'AΩ');
  // Core FString serializes raw TCHAR units, including BOM and lone surrogates.
  const wide = new Reader(Uint8Array.from([0x84, 0xff, 0xfe, 0, 0xd8, 0x41, 0, 0, 0]));
  assert.equal(wide.string(), '\ufeff\ud800A');
  assert.equal(wide.offset, 9);
  assert.throws(() => new Reader(Uint8Array.from([2, 65, 66])).string(), /Unterminated/);
  assert.throws(() => new Reader(Uint8Array.from([5, 65])).string(), /Truncated/);
});

function fixture() {
  // Header: 56 bytes; six names: 75 bytes + 1 padding byte; two imports: 14 bytes;
  // one 14-byte export at 146; four-byte payload at 160.
  const bytes = new Uint8Array(164);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x9e2a83c1, true);
  view.setUint16(4, 69, true);
  view.setInt32(12, 6, true); view.setInt32(16, 56, true);
  view.setInt32(20, 1, true); view.setInt32(24, 146, true);
  view.setInt32(28, 2, true); view.setInt32(32, 132, true);
  let offset = 56;
  for (const name of ['None', 'Core', 'Package', 'Class', 'TestActor', 'TestActor0']) {
    const encoded = new TextEncoder().encode(name);
    bytes[offset++] = encoded.length + 1;
    bytes.set(encoded, offset);
    offset += encoded.length + 5;
  }
  assert.equal(offset, 131);
  // Core.Package Core (root package), Core.Class TestActor (inside Core).
  bytes.set([1, 2, 0, 0, 0, 0, 1, 1, 3, 255, 255, 255, 255, 4], 132);
  // class=-2, super=0, outer=0, name=5, flags=0, size=4, offset=160.
  bytes.set([0x82, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 4, 0x60, 2], 146);
  bytes.set([0xde, 0xad, 0xbe, 0xef], 160);
  return bytes;
}

test('reads tables, dependencies, object paths, and export payload spans', () => {
  const p = parsePackage(fixture());
  assert.equal(p.version, 69);
  assert.deepEqual(p.dependencies, ['Core']);
  assert.equal(p.imports[1].path, 'Core.TestActor');
  assert.equal(p.exports[0].className, 'TestActor');
  assert.equal(p.exports[0].serialOffset, 160);
  assert.equal(p.exports[0].serialSize, 4);
  assert.equal(p.exports[0].path, 'TestActor0');
  assert.deepEqual(summarizePackage(p).exportClasses, { TestActor: 1 });
});

test('version 61 uses a heritage header and null-terminated names', () => {
  const bytes = new Uint8Array(146), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x9e2a83c1, true); view.setUint16(4, 61, true);
  for (const [at, n] of [[12, 6], [16, 44], [20, 1], [24, 128], [28, 2], [32, 114]]) {
    view.setInt32(at, n, true);
  }
  let offset = 44;
  for (const name of ['None', 'Core', 'Package', 'Class', 'TestActor', 'TestActor0']) {
    const encoded = new TextEncoder().encode(name);
    bytes.set(encoded, offset); offset += encoded.length + 5;
  }
  assert.equal(offset, 113);
  bytes.set([1, 2, 0, 0, 0, 0, 1, 1, 3, 255, 255, 255, 255, 4], 114);
  bytes.set([0x82, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 4, 0x4e, 2], 128);
  bytes.set([0xde, 0xad, 0xbe, 0xef], 142);
  const p = parsePackage(bytes);
  assert.equal(p.version, 61);
  assert.equal(p.guid, null);
  assert.deepEqual(p.heritage, { count: 0, offset: 0 });
  assert.deepEqual(p.dependencies, ['Core']);
  assert.equal(p.exports[0].serialOffset, 142);
  assert.equal(p.exports[0].name, 'TestActor0');
  view.setInt32(40, 147, true);
  assert.throws(() => parsePackage(bytes), /Invalid heritage/);
  assert.throws(() => new Reader(Uint8Array.of(65, 66)).string(61), /Truncated/);
});

test('respects Uint8Array subviews, including Node Buffer byte offsets', () => {
  const wrapped = new Uint8Array(200);
  wrapped.set(fixture(), 11);
  assert.equal(parsePackage(wrapped.subarray(11, 175)).exports.length, 1);
  assert.equal(parsePackage(fixture().buffer).imports.length, 2);
});

test('rejects truncated files, wrong signatures, unsupported versions, and invalid offsets', () => {
  for (const size of [0, 4, 20, 55, 90, 163]) {
    assert.throws(() => parsePackage(fixture().subarray(0, size)));
  }
  for (const [at, value, expected] of [
    [0, 0, /Not an Unreal/], [4, 100, /Unsupported/],
    [12, 0xffffffff, /Invalid names/], [16, 165, /Invalid names/],
    [16, 0, /Invalid names/], [52, 0xffffffff, /generation count/],
  ]) {
    const bytes = fixture();
    new DataView(bytes.buffer).setUint32(at, value, true);
    assert.throws(() => parsePackage(bytes), expected);
  }
});

test('rejects invalid name references, invalid classes, and cyclic object outers', () => {
  let bytes = fixture(); bytes[152] = 7;
  assert.throws(() => parsePackage(bytes), /Invalid name reference/);
  bytes = fixture(); bytes[146] = 0x83;
  assert.throws(() => parsePackage(bytes), /Invalid object reference/);
  bytes = fixture(); new DataView(bytes.buffer).setInt32(141, -2, true);
  assert.throws(() => parsePackage(bytes), /Cyclic/);
});

test('CLI tools inspect files and inventory directories with explicit failure statuses', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'deus-ex-format-test-'));
  const run = (name, ...args) => spawnSync(process.execPath, [
    fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url)), ...args,
  ], { encoding: 'utf8' });
  try {
    assert.equal(run('inventory', directory).status, 1);
    const filename = path.join(directory, 'Training.DX');
    writeFileSync(filename, fixture());
    writeFileSync(path.join(directory, 'Core.u'), fixture());
    const inspected = run('inspect-package', filename);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).exports, 1);
    const detailed = run('inspect-package', filename, '--tables');
    assert.equal(JSON.parse(detailed.stdout).exports[0].name, 'TestActor0');
    const inventory = run('inventory', directory);
    assert.equal(inventory.status, 0, inventory.stderr);
    const result = JSON.parse(inventory.stdout);
    assert.equal(result.files, 2);
    assert.equal(result.packages.length, 2);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.packages[1].unresolvedDependencies, []);
    assert.match(result.packages[0].sha256, /^[a-f0-9]{64}$/);
    writeFileSync(path.join(directory, 'broken.u'), new Uint8Array([1]));
    const broken = run('inventory', directory);
    assert.equal(broken.status, 1);
    assert.equal(JSON.parse(broken.stdout).errors[0].path, 'broken.u');
    assert.equal(run('inspect-package').status, 2);
    assert.equal(run('inspect-package', path.join(directory, 'missing.u')).status, 1);
    assert.equal(run('inventory', path.join(directory, 'missing')).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
