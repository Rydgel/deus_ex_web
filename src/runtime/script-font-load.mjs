/** Engine Font loading. Original instruction contract and limits:
 * docs/script-font-load.md. Storage and object identity are host services;
 * only the recovered loading branch is admitted here. */

/** Hash-checked GOTY Engine.dll addresses this translation follows. */
export const FONT_NATIVE = Object.freeze({
  staticClass: 0x10587348, initializer: 0x103855b0, internalConstructor: 0x10303468,
  constructorBody: 0x103853d0, vtable: 0x10426878, serialize: 0x10385400,
  pageArray: 0x10385680, page: 0x10385940, characterArray: 0x10385a00,
  character: 0x10385bb0, characterArrayDestructor: 0x10385860,
  postLoadThunk: 0x1040c72e, instanceSize: 0x38, registeredClassFlags: 0x12,
  staticConstructor: 0x10101041, lazyArrayVtable: 0x104267fc,
});

/** The `check(!(CharactersPerPage&(CharactersPerPage-1)))` at 0x10385466. */
export const FONT_PER_PAGE_ASSERT = Object.freeze({
  line: 0x1a, file: 'D:\\prj\\Clean\\Engine\\Src\\UnFont.cpp',
  expr: '!(CharactersPerPage&(CharactersPerPage-1))',
});

export class FontLoadBoundaryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FontLoadBoundaryError';
    this.code = 'UNSUPPORTED_FONT_LOAD';
    Object.assign(this, details);
  }
}
const fail = (message, details) => { throw new FontLoadBoundaryError(message, details); };
function call(services, name, ...args) {
  if (typeof services[name] !== 'function') fail(`Font loading requires ${name}`);
  const result = services[name](...args);
  if (result && typeof result.then === 'function') fail(`Font ${name} suspended`);
  return result;
}
function read(object, offset, services, type = 'u32') {
  const value = call(services, 'read', object, offset, type);
  if (value === undefined) fail(`Unresolved font field +0x${offset.toString(16)}`);
  return value;
}
const write = (object, offset, value, services, type = 'u32') =>
  call(services, 'write', object, offset, value, type);
const array = () => ({data: null, num: 0, max: 0});
function loading(archive) {
  // Both array serializers test archive +0x0c (ArIsLoading); the saving and
  // nonloading branches are separate code and are not translated.
  if (!archive.ar0c) fail('Font save/nonloading archive is not translated');
}
function count(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
    fail(`Invalid native font array count ${value}`);
  return value;
}
/** Inline FArray::Add(1, 16) at 0x1038572a/0x10385a8f. */
function append(a, services) {
  const index = a.num;
  a.num = count(index + 1);
  if (a.num > a.max) {
    a.max = a.num + Math.trunc(3 * a.num / 8) + 32;
    call(services, 'arrayRealloc', a, 16);
  }
  return index;
}
const i32 = bytes => new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);

/** UFont::UFont 0x103853d0: UObject ctor, zero Pages, install the vtable.
 * CharactersPerPage (+0x28) keeps the template/default value. */
export function constructFont(object, services) {
  call(services, 'objectConstructor', object);
  write(object, 0x2c, array(), services, 'array');
  write(object, 0, FONT_NATIVE.vtable, services);
}

/** TArray<FFontCharacter>::~TArray 0x10385860. */
function destroyCharacters(a, services) {
  // check(Index>=0) (line 0x1f6) and check(Index+Count<=ArrayNum) (0x1f7)
  // pass for Remove(0, ArrayNum): the count is always nonnegative here.
  call(services, 'arrayRemove', a, 0, a.num, 16);
  if (a.data !== null) call(services, 'freeArray', a);
  a.data = null;
  a.max = 0;
  a.num = 0;
}

/** operator<<(FArchive&, TArray<FFontCharacter>&) 0x10385a00, loading branch. */
function serializeCharacters(a, archive, services) {
  archive.countBytes(a.num * 16, a.max * 16);
  const size = count(archive.readCompact());
  // FFontCharacter has no destructor; the original keeps an empty loop.
  a.max = size;
  a.num = 0;
  call(services, 'arrayRealloc', a, 16);
  for (let i = 0; i < size; i += 1) {
    const index = append(a, services);
    // 0x10385bb0: StartU, StartV, USize, VSize as four Serialize(&x, 4).
    const record = {startU: 0, startV: 0, uSize: 0, vSize: 0};
    a.data[index] = record;
    record.startU = i32(archive.readRaw(4));
    record.startV = i32(archive.readRaw(4));
    record.uSize = i32(archive.readRaw(4));
    record.vSize = i32(archive.readRaw(4));
  }
}

/** operator<<(FArchive&, TArray<FFontPage>&) 0x10385680, loading branch. */
function serializePages(a, archive, services) {
  archive.countBytes(a.num * 16, a.max * 16);
  const size = count(archive.readCompact());
  // Existing elements are destroyed before the array is emptied; Num is
  // reread on every iteration.
  for (let i = 0; i < a.num; i += 1) destroyCharacters(a.data[i].characters, services);
  a.num = 0;
  a.max = size;
  call(services, 'arrayRealloc', a, 16);
  for (let i = 0; i < size; i += 1) {
    const index = append(a, services);
    // Placement new zeroes only Characters; Texture is assigned by the
    // FFontPage serializer (0x10385940) before anything reads it.
    const page = {texture: undefined, characters: array()};
    a.data[index] = page;
    page.texture = call(services, 'serializeObject', archive);
    serializeCharacters(page.characters, archive, services);
  }
}

/** UFont::Serialize 0x10385400, loading branch. */
export function serializeFont(object, archive, services) {
  loading(archive);
  call(services, 'objectSerialize', object, archive);
  const saved = call(services, 'getLazyLoad');
  call(services, 'setLazyLoad', 1);
  serializePages(read(object, 0x2c, services, 'array'), archive, services);
  write(object, 0x28, i32(archive.readRaw(4)), services);
  const perPage = read(object, 0x28, services) | 0;
  if (perPage & (perPage - 1)) {
    call(services, 'failAssert', FONT_PER_PAGE_ASSERT);
    fail('Original UFont CharactersPerPage power-of-two assertion', {assertion: FONT_PER_PAGE_ASSERT});
  }
  if (!call(services, 'getLazyLoad')) {
    // Reached only when a nested callback cleared the forced GLazyLoad.
    // The page counter and running character index advance independently;
    // CharactersPerPage, Pages and each texture's Mips are reread.
    for (let i = 0, page = 0; i < 0x100; page += 1) {
      const pages = read(object, 0x2c, services, 'array');
      if (page < pages.num && pages.data[page].texture) {
        for (let mip = 0; ; mip += 1) {
          const texture = read(object, 0x2c, services, 'array').data[page].texture;
          const mips = read(texture, 0xa4, services, 'array');
          if (mip >= mips.num) break;
          call(services, 'loadLazyArray', mips.data[mip].lazy);
        }
      }
      const step = read(object, 0x28, services) | 0;
      if (step <= 0) fail('Original UFont lazy-load loop does not terminate for CharactersPerPage <= 0');
      i = (i + step) | 0;
    }
  }
  call(services, 'setLazyLoad', saved);
  return archive;
}
