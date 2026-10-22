import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, dosDateTime, createStoredZip } from '../src/runtime/zip-store.mjs';

/** A reader for what the writer makes: the central directory, then each entry's local header and data, every field checked against the other. */
function readStoredZip(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  assert.equal(start + size, end, 'the central directory ends where the end record starts');
  const entries = [];
  let at = start;
  for (let n = 0; n < count; n++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true), crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true), plain = view.getUint32(at + 24, true), nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50);
    assert.equal(view.getUint16(local + 8, true), method); assert.equal(view.getUint32(local + 14, true), crc);
    const localName = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
    const data = zip.subarray(local + 30 + localName + localExtra, local + 30 + localName + localExtra + plain);
    assert.equal(method, 0, 'stored'); assert.equal(compressed, plain); assert.equal(flags & 0x0800, 0x0800, 'UTF-8 names');
    assert.equal(crc32(data), crc, `${name}: the CRC-32 of its bytes`);
    entries.push({ name, data, date: view.getUint16(at + 14, true), time: view.getUint16(at + 12, true) });
    at += 46 + nameLength;
  }
  return entries;
}

test('CRC-32 is the zip\'s (the check value of the standard)', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('DOS date and time: years from 1980, seconds in twos, local time', () => {
  const when = new Date(2026, 8, 12, 14, 47, 33).getTime();
  const { date, time } = dosDateTime(when);
  assert.deepEqual([(date >> 9) + 1980, (date >> 5) & 15, date & 31], [2026, 9, 12]);
  assert.deepEqual([time >> 11, (time >> 5) & 63, (time & 31) * 2], [14, 47, 32]);
  assert.equal((dosDateTime(0).date >> 9) + 1980, 1980, 'a time before 1980 is clamped');
});

test('a stored archive of save files reads back entry for entry', () => {
  const big = Uint8Array.from({ length: 70000 }, (_, i) => (i * 31 + 7) & 255);
  const files = [{ path: 'Save/Save0001/SaveInfo.dxs', bytes: Uint8Array.from([1, 2, 3]), modified: new Date(2026, 8, 12, 14, 47, 34).getTime() },
    { path: 'Save/Save0001/00_Training.dxs', bytes: big }, { path: 'Save\\QuickSave\\SaveInfo.dxs', bytes: new Uint8Array(0) }, { path: 'Save/Ünï/𝔲.dxs', bytes: Uint8Array.from([9]) }];
  const zip = createStoredZip(files);
  const read = readStoredZip(zip);
  assert.deepEqual(read.map(entry => entry.name), ['Save/Save0001/SaveInfo.dxs', 'Save/Save0001/00_Training.dxs', 'Save/QuickSave/SaveInfo.dxs', 'Save/Ünï/𝔲.dxs'], 'backslashes become slashes, names are UTF-8');
  assert.deepEqual([...read[0].data], [1, 2, 3]); assert.deepEqual([...read[1].data], [...big]); assert.equal(read[2].data.length, 0);
  assert.equal((read[0].date >> 9) + 1980, 2026);
  assert.equal(zip.length, files.reduce((n, f) => n + f.bytes.length + 2 * new TextEncoder().encode(f.path).length + 30 + 46, 22), 'headers, data and the end record, nothing else');
});

test('an empty archive is just the end record', () => {
  const zip = createStoredZip([]);
  assert.equal(zip.length, 22);
  assert.deepEqual(readStoredZip(zip), []);
});

test('too many entries are refused', () => {
  assert.throws(() => createStoredZip(new Array(65536).fill({ path: 'a', bytes: new Uint8Array(0) })), RangeError);
});
