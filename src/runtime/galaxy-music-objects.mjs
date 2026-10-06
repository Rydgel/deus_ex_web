/** The UMusic objects Play's scripts hand Galaxy (PlayerPawn.Song), as the
 * adapters galaxy-music.mjs reads: Handle +0x48 and the TLazyArray<BYTE> Data
 * at +0x28 (SavedPos +0x30, Data/Num/Max +0x34..+0x3c), its Load (the Engine
 * body 0x1030cbb0, script-lazy-byte-array.mjs) and FArray::Realloc
 * (docs/script-music-load.md, docs/galaxy-music/update-transition.md §1).
 *
 * Two kinds of reference reach PlayerPawn.Song in Play:
 *
 * - A map's LevelInfo.Song import (PostLogin's ClientSetMusic, the dynamic
 *   music sections) resolves to the resource registry's export reference
 *   ({asset, index, kind: 'Music'}). Its UMusic state lives here, one record
 *   per reference. UMusic::Serialize loads Data at once (no GLazyLoad, so
 *   OriginalSize = Data.Num), so the record starts as the original's after
 *   Serialize: SavedPos negative (the position of Data's compact count in the
 *   package, negated), Num = Max = the module size, the bytes; Handle 0.
 *   Load re-reads the package bytes (src/unreal/music-module.mjs, the same
 *   lazy array) when Unload has emptied the array.
 * - A DynamicLoadObject Music (CreditsScrollWindow, PlayMusicWindow) is a
 *   load-graph object whose +0x28 record the graph's loader filled
 *   (script-music-load.mjs); Load runs the graph's lazy loader on its linker
 *   archive, Realloc follows the graph's array storage. Not exercised by a
 *   Play map yet.
 *
 * Storage is host memory: Data is a Uint8Array (export references) or the
 * graph's array; a reallocated tail the original leaves uninitialised
 * (appRealloc) reads as 0. */
import {readMusicExport} from '../unreal/music-module.mjs';
import {loadLazyByteArray} from './script-lazy-byte-array.mjs';

/** Bytes of an FCompactIndex holding `value` (6 bits, then 7 per byte). */
const compactLength = value => {
  let length = 1, rest = Math.abs(value);
  if (rest >= 0x40) { rest >>>= 6; do { length++; rest >>>= 7; } while (rest); }
  return length;
};

/** FArray::Realloc(1) over a Uint8Array: Max bytes, contents kept. */
function reallocBytes(lazy) {
  const data = lazy.max ? new Uint8Array(lazy.max) : null;
  if (data && lazy.data) data.set(lazy.data.subarray(0, Math.min(lazy.data.length, lazy.max)));
  lazy.data = data;
}

function exportMusic(song) {
  const {asset, index} = song;
  const first = readMusicExport(asset, index);
  // Data's compact count sits right before the bytes (package version > 61:
  // the stored end offset, then the count, then the bytes).
  const position = first.bytes.byteOffset - asset.bytes.byteOffset - compactLength(first.bytes.length);
  const lazy = {savedPosition: -position, num: first.bytes.length, max: first.bytes.length, data: first.bytes};
  const archive = {position: 0};
  const services = {
    read: (data, key) => key === 'lazyField08' ? data.savedPosition : key === 'archive' ? archive : key === 'array' ? data : data[key],
    write: (data, key, value) => { if (key === 'lazyField08') data.savedPosition = value; else data[key] = value; },
    tell: ar => ar.position,
    seek: (ar, at) => { ar.position = at; },
    // Ar << Data (Engine 0x1030cca0): Num from the compact count, Max = Num,
    // Realloc, then the bytes.
    serializeArray: (ar, array) => {
      if (ar.position !== position) throw new Error(`Galaxy music: ${song.key} Data is not at its saved position`);
      const {bytes} = readMusicExport(asset, index);
      array.num = array.max = bytes.length;
      array.data = bytes;
      ar.position += compactLength(bytes.length) + bytes.length;
    },
  };
  return {
    fullName: `Music ${asset.name}.${song.entry?.path ?? song.name}`,
    handle: 0,
    lazy,
    load: () => loadLazyByteArray(lazy, services),
    realloc: reallocBytes,
    bytes: data => data.data.subarray(0, data.num),
  };
}

function graphMusic(object, graph) {
  const record = object.instanceValues.get(0x28);
  if (!record?.bytes) throw new Error(`Galaxy music: ${object.name ?? object} has no loaded Data`);
  const lazy = {
    get savedPosition() { return record.savedPosition; }, set savedPosition(value) { record.savedPosition = value; },
    get num() { return record.bytes.num; }, set num(value) { record.bytes.num = value; },
    get max() { return record.bytes.max; }, set max(value) { record.bytes.max = value; },
    get data() { return record.bytes.data; }, set data(value) { record.bytes.data = value; },
  };
  return {
    fullName: `Music ${graph.fullName(object)}`,
    get handle() { return object.instanceValues.get(0x48) ?? 0; },
    set handle(value) { object.instanceValues.set(0x48, value); },
    lazy,
    load: () => graph.loadResourceBytes(record),
    // The load graph's FArray::Realloc for byte arrays (script-load-graph.mjs).
    realloc: () => {
      const a = record.bytes;
      if (!a.max) { a.data = null; return; }
      a.data ??= [];
      a.data.length = a.max;
    },
    bytes: () => Uint8Array.from({length: record.bytes.num}, (_, i) => record.bytes.data[i] ?? 0),
  };
}

/** `music(song)`: the adapter for an object reference, created once per
 * reference. */
export function createMusicObjects({graph = null} = {}) {
  const objects = new WeakMap();
  return {
    music(song) {
      let entry = objects.get(song);
      if (entry) return entry;
      if (song?.resourceConstructed === 'Engine.Music' && song.instanceValues instanceof Map) {
        if (!graph) throw new Error('Galaxy music: a load-graph Music needs the class loader graph');
        entry = graphMusic(song, graph);
      } else if (song?.kind === 'Music' && song.asset?.pkg && Number.isInteger(song.index)) entry = exportMusic(song);
      else throw new Error(`Galaxy music: ${song?.key ?? song} is not a loaded Music object`);
      objects.set(song, entry);
      return entry;
    },
  };
}
