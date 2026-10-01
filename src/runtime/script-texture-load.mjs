/** Engine Texture/Palette loading. Original instruction contract and limits:
 * docs/script-texture-loading.md. Storage, clock and object identity are host
 * services; only the recovered loading branch is admitted here. */
import {loadLazyByteArray} from './script-lazy-byte-array.mjs';

export class TextureLoadBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextureLoadBoundaryError';
    this.code = 'UNSUPPORTED_TEXTURE_LOAD';
  }
}
const fail = message => { throw new TextureLoadBoundaryError(message); };
function call(services, name, ...args) {
  if (typeof services[name] !== 'function') fail(`Texture loading requires ${name}`);
  const result = services[name](...args);
  if (result && typeof result.then === 'function') fail(`Texture ${name} suspended`);
  return result;
}
function read(object, offset, services, type = 'u32') {
  const value = call(services, 'read', object, offset, type);
  if (value === undefined) fail(`Unresolved texture field +0x${offset.toString(16)}`);
  return value;
}
const write = (object, offset, value, services, type = 'u32') =>
  call(services, 'write', object, offset, value, type);
const array = () => ({data: null, num: 0, max: 0});
function loading(archive) {
  if (!archive.ar0c) fail('Texture save/nonloading archive is not translated');
}
function count(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
    fail(`Invalid native resource array count ${value}`);
  return value;
}
function append(a, elementSize, services) {
  const index = a.num;
  a.num = count(index + 1);
  if (a.num > a.max) {
    a.max = a.num + Math.trunc(3 * a.num / 8) + 32;
    call(services, 'arrayRealloc', a, elementSize);
  }
  return index;
}

/** Core FArray::Remove 0x101454f0, using host element storage. */
export function removeResourceArray(a, index, amount, elementSize, services) {
  if (!amount) return;
  if (index < 0 || amount < 0 || index + amount > a.num)
    fail('FArray::Remove outside resource array');
  a.data.copyWithin(index, index + amount, a.num);
  a.num -= amount;
  if ((a.num * 3 < a.max * 2 || (a.max - a.num) * elementSize >= 0x4000) &&
      (a.max - a.num > 64 || a.num === 0)) {
    a.max = a.num;
    call(services, 'arrayRealloc', a, elementSize);
  }
}

export function constructPalette(object, services) {
  call(services, 'objectConstructor', object);
  write(object, 0x28, array(), services, 'array');
  write(object, 0, 0x10426654, services);
}

export function constructTexture(object, services) {
  call(services, 'objectConstructor', object);
  write(object, 0, 0x104266b8, services);
  write(object, 0x44, 0x00408040, services);
  write(object, 0x48, 0xffffffff, services);
  write(object, 0x28, 0, services, 'u8');
  write(object, 0x2c, null, services, 'pointer');
  write(object, 0x30, 0, services, 'u8');
  write(object, 0x31, 0, services, 'u8');
  write(object, 0x34, 0, services);
  write(object, 0x38, 0, services);
  write(object, 0x4c, call(services, 'seconds'), services, 'f64');
  write(object, 0xa4, array(), services, 'array');
  write(object, 0xb0, array(), services, 'array');
  write(object, 0x68, 0, services);
  for (const offset of [0x60, 0x64, 0x6c, 0x70, 0x74]) write(object, offset, 1, services, 'f32');
  write(object, 0, 0x1042672c, services);
}

function serializeBytes(a, archive, services) {
  archive.countBytes(a.num, a.max);
  a.num = count(archive.readCompact());
  a.max = a.num;
  call(services, 'arrayRealloc', a, 1);
  const num = a.num, target = a.data;
  const bytes = archive.readRaw(num);
  for (let i = 0; i < num; i += 1) target[i] = bytes[i];
}

/** TLazyArray<byte>::Load 0x1030cbb0. Negative SavedPos means already loaded. */
export function loadTextureLazyBytes(lazy, services) {
  return loadLazyByteArray(lazy, {
    read: (data, key) => key === 'lazyField08' ? data.savedPosition : key === 'array' ? data.bytes : data[key],
    write: (data, key, value) => { data[key === 'lazyField08' ? 'savedPosition' : key] = value; },
    tell: archive => { loading(archive); return archive.tell(); },
    seek: (archive, position) => archive.seek(position),
    serializeArray: (archive, bytes) => serializeBytes(bytes, archive, services),
  });
}

/** FArchive operator<<(TLazyArray<BYTE>&) 0x103039ef, loading (shared by
 * texture mips and UMusic.Data). */
export function serializeLazyBytes(lazy, archive, services) {
  let end;
  if (archive.ar04 > 61) {
    end = archive.readU32();
    call(services, 'attach', archive, lazy);
  } else {
    call(services, 'attach', archive, lazy);
    const size = archive.readCompact();
    end = archive.tell() + size;
  }
  if (!call(services, 'getLazyLoad')) loadTextureLazyBytes(lazy, services);
  archive.seek(end);
}

function destroyLazy(lazy, services) {
  lazy.vtable = 0x104267fc;
  if (lazy.archive) call(services, 'detach', lazy.archive, lazy);
  const a = lazy.bytes;
  call(services, 'arrayRemove', a, 0, a.num, 1);
  if (a.data !== null) call(services, 'freeArray', a);
  a.data = null;
  a.num = 0;
  a.max = 0;
}

function serializeMips(object, a, archive, services) {
  archive.countBytes(a.num * 40, a.max * 40);
  const size = count(archive.readCompact());
  for (let i = 0; i < a.num; i += 1) destroyLazy(a.data[i].lazy, services);
  a.num = 0;
  a.max = size;
  call(services, 'arrayRealloc', a, 40);
  const bias = Math.min(call(services, 'mipBias', object, read(object, 0x88, services, 'u8')), size - 1);
  for (let i = 0; i < size; i += 1) {
    const saved = call(services, 'getLazyLoad');
    if (i < bias) call(services, 'setLazyLoad', 1);
    const index = append(a, 40, services);
    // The count-taking FArray constructor (0x10107280) calls Realloc(1)
    // even for its initial zero count, before FLazyLoader construction.
    const bytes = array();
    call(services, 'arrayRealloc', bytes, 1);
    const mip = {lazy: {vtable: 0x104267fc, archive: null, savedPosition: 0, bytes}};
    a.data[index] = mip;
    serializeLazyBytes(mip.lazy, archive, services);
    mip.width = archive.readU32();
    mip.height = archive.readU32();
    mip.uBits = archive.readRaw(1)[0];
    mip.vBits = archive.readRaw(1)[0];
    // Original restores on the successful path, not with a synthetic finally.
    call(services, 'setLazyLoad', saved);
  }
}

export function serializeTexture(object, archive, services) {
  loading(archive);
  call(services, 'objectSerialize', object, archive);
  const primary = read(object, 0xa4, services, 'array');
  if (read(object, 0x84, services, 'u8') & 8) {
    for (let i = 0; i < primary.num; i += 1) {
      const a = primary.data[i].lazy.bytes;
      a.num = a.max = 0;
      call(services, 'arrayRealloc', a, 1);
    }
  }
  serializeMips(object, primary, archive, services);
  if (read(object, 0x84, services, 'u8') & 0x20)
    serializeMips(object, read(object, 0xb0, services, 'array'), archive, services);
  if (read(object, 0x84, services, 'u8') & 8) {
    for (let i = 0; i < primary.num; i += 1) {
      const mip = primary.data[i], a = mip.lazy.bytes;
      const size = count(Math.imul(mip.width, mip.height));
      a.num = 0;
      a.max = size;
      call(services, 'arrayRealloc', a, 1);
      a.num = size;
      a.data?.fill(0, 0, size);
    }
  }
  return archive;
}

export function serializePalette(object, archive, services) {
  loading(archive);
  call(services, 'objectSerialize', object, archive);
  const a = read(object, 0x28, services, 'array');
  archive.countBytes(a.num * 4, a.max * 4);
  const size = count(archive.readCompact());
  a.num = 0;
  a.max = size;
  call(services, 'arrayRealloc', a, 4);
  for (let i = 0; i < size; i += 1) {
    const index = append(a, 4, services), color = new Uint8Array(4);
    a.data[index] = color;
    for (let channel = 0; channel < 4; channel += 1) color[channel] = archive.readRaw(1)[0];
  }
  if (archive.ar04 < 66) for (let i = 0; i < a.num; i += 1) a.data[i][3] = 255;
  return archive;
}

export function postLoadTexture(object, services) {
  call(services, 'objectPostLoad', object);
  if (!read(object, 0x2c, services, 'pointer')) {
    const palette = call(services, 'allocatePalette', {
      size: 0x34, outer: read(object, 0x18, services, 'pointer'), name: 0, flags: 0,
    });
    if (!palette) fail('Palette allocation returned null');
    constructPalette(palette, services);
    write(object, 0x2c, palette, services, 'pointer');
    const colors = read(palette, 0x28, services, 'array');
    for (let i = 0; i < 256; i += 1) {
      const index = append(colors, 4, services);
      colors.data[index] = Uint8Array.of(i, i, i, 0);
    }
  }
  for (const [clampOffset, sizeOffset] of [[0x3c, 0x34], [0x40, 0x38]]) {
    const value = read(object, clampOffset, services) | 0;
    const size = read(object, sizeOffset, services) | 0;
    write(object, clampOffset, value < 0 ? 0 : value >= size ? size : value, services);
  }
  write(object, 0xa0, 0, services);
  write(object, 0x4c, call(services, 'seconds'), services, 'f64');
}
