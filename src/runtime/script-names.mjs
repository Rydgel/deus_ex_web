/*
 * Core FName table storage and deletion.
 *
 * This module owns the mutable GNames-shaped arrays used by the script GC
 * bridge.  The native entry fields are represented explicitly as
 * {index, flags, hashNext, text}; see docs/script-names.md.
 */

const HASH_BUCKET_COUNT = 0x1000;
const CRC_POLYNOMIAL = 0x04c11db7;

export const NAME_FLAGS = Object.freeze({
  unreachable: 0x00000002,
  native: 0x04000000,
});

const U32 = value => Number(value) >>> 0;

// Core 0x10149840 initializes the same normal CRC table used by the FName
// hash.  The native loop uses a right-shifting update with this table (rather
// than appStrCrc's left-shifting update), so preserve that unusual pairing.
const CRC_TABLE = Object.freeze(Array.from({length: 0x100}, (_, index) => {
  let value = U32(index << 24);
  for (let bit = 0; bit < 8; bit++) {
    value = U32((value & 0x80000000) !== 0
      ? (value << 1) ^ CRC_POLYNOMIAL
      : value << 1);
  }
  return value;
}));

function foldedUnit(value) {
  return value >= 0x61 && value <= 0x7a ? value - 0x20 : value;
}

function nativeText(text) {
  const terminator = text.indexOf('\u0000');
  return terminator < 0 ? text : text.slice(0, terminator);
}

function crcByte(hash, value) {
  return U32((hash >>> 8) ^ CRC_TABLE[(hash ^ value) & 0xff]);
}

/** Core FName hash state before the final 0xfff bucket mask. */
export function hashScriptName(text) {
  if (typeof text !== 'string') throw new TypeError('FName text must be a string');
  text = nativeText(text);
  let hash = 0;
  // Indexing a JavaScript string visits UTF-16 code units, matching the
  // native TCHAR loop rather than iterating Unicode code points.
  for (let offset = 0; offset < text.length; offset++) {
    const unit = foldedUnit(text.charCodeAt(offset));
    hash = crcByte(hash, unit & 0xff);
    hash = crcByte(hash, (unit >>> 8) & 0xff);
  }
  return hash;
}

/** Core FName bucket selection: hash state masked with 0xfff. */
export function hashScriptNameBucket(text) {
  return hashScriptName(text) & (HASH_BUCKET_COUNT - 1);
}

function equalScriptNames(left, right) {
  // Core appStricmp1010239c is a wrapper over MSVCRT _wcsicmp at IAT
  // 0x102ab4c8.  The original startup uses the C locale, whose folding for
  // this path is the ASCII mapping below. Locale-dependent non-ASCII folding
  // is intentionally outside this host adapter until separately traced.
  left = nativeText(left);
  right = nativeText(right);
  if (left.length !== right.length) return false;
  for (let offset = 0; offset < left.length; offset++) {
    if (foldedUnit(left.charCodeAt(offset)) !== foldedUnit(right.charCodeAt(offset))) {
      return false;
    }
  }
  return true;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`FName requires ${name} array`);
  return value;
}

function entryText(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string') {
    throw new TypeError('FName entry requires native text at +0x0c as entry.text');
  }
  return nativeText(entry.text);
}

function entryIndex(entry, names) {
  if (Number.isInteger(entry?.index)) return entry.index;
  const index = names.indexOf(entry);
  if (index >= 0) return index;
  throw new TypeError('FName entry requires native index at +0x00 as entry.index');
}

function entryFlags(entry) {
  if (entry && Object.hasOwn(entry, 'flags')) return U32(entry.flags);
  if (entry && Object.hasOwn(entry, 'objectFlags')) return U32(entry.objectFlags);
  throw new TypeError('FName entry requires native flags at +0x04 as entry.flags');
}

function nextEntry(entry) {
  if (entry === null || entry === undefined) return null;
  return entry.hashNext ?? null;
}

function setNextEntry(entry, next) {
  entry.hashNext = next;
}

function requireInteger(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw new TypeError(`FName ${name} must be an integer >= ${minimum}`);
  return value;
}

function growthCapacity(count) {
  // This is the exact positive-count path at Core 0x1014e1f1-0x1014e203
  // and 0x1014bb10-0x1014bb27: count + floor(3*count/8) + 0x20.
  return count + Math.floor((count * 3) / 8) + 0x20;
}

function removeFreeIndex(freeIndices, expectedIndex, capacity) {
  const oldCount = freeIndices.length;
  if (oldCount === 0 || freeIndices[oldCount - 1] !== expectedIndex) {
    throw new Error('FName free-index reuse must remove the last FArray element');
  }
  freeIndices.pop();
  const newCount = freeIndices.length;
  const excess = capacity - newCount;
  // FArray::Remove101454f0 considers shrinking when 3*newCount is below
  // 2*capacity, then requires at least 0x4000 bytes of excess (element size
  // four here) and either more than 0x40 spare elements or an empty array.
  if (newCount * 3 < capacity * 2 && excess * 4 >= 0x4000 &&
      (excess > 0x40 || newCount === 0)) {
    return newCount;
  }
  return capacity;
}

function findInBucket(names, buckets, text, bucket) {
  const seen = new Set();
  for (let entry = buckets[bucket] ?? null; entry !== null; entry = nextEntry(entry)) {
    if (!entry || seen.has(entry)) throw new Error('FName hash chain is cyclic or malformed');
    seen.add(entry);
    if (equalScriptNames(entryText(entry), text)) {
      const index = entryIndex(entry, names);
      if (names[index] !== entry) throw new Error('FName entry index does not point into GNames');
      return entry;
    }
  }
  return null;
}

/**
 * Create a mutable GNames/GNameAvail/hash-table adapter.
 *
 * `allocator.free(entry)` is the explicit Core GMalloc +0x08 boundary used by
 * DeleteEntry.  `allocator.allocate(text,index,flags,hashNext)` is optional;
 * the default produces a host record with the verified native fields.
 */
export function createScriptNames({
  names = [],
  freeIndices = [],
  buckets = Array(HASH_BUCKET_COUNT).fill(null),
  allocator = {},
  nameCount = names.length,
  nameCapacity = names.length,
  freeNameCapacity = freeIndices.length,
} = {}) {
  requireArray(names, 'names');
  requireArray(freeIndices, 'freeIndices');
  requireArray(buckets, 'hash buckets');
  if (buckets.length !== HASH_BUCKET_COUNT) throw new TypeError('FName hash buckets must have 4096 heads');
  requireInteger(nameCount, 'nameCount');
  requireInteger(nameCapacity, 'nameCapacity');
  requireInteger(freeNameCapacity, 'freeNameCapacity');
  if (nameCount > nameCapacity) throw new RangeError('FName nameCount exceeds nameCapacity');
  if (names.length < nameCount) names.length = nameCount;
  if (typeof allocator !== 'object' || allocator === null) throw new TypeError('FName allocator must be an object');

  const allocate = typeof allocator.allocate === 'function'
    ? allocator.allocate
    : (text, index, flags, hashNext) => ({index, flags, hashNext, text});
  const free = allocator.free;
  if (typeof free !== 'function') {
    throw new TypeError('FName deletion requires allocator.free for Core GMalloc +0x08');
  }

  let currentNameCount = nameCount;
  let currentNameCapacity = nameCapacity;
  let currentFreeNameCapacity = freeNameCapacity;

  function getEntry(index) {
    requireInteger(index, 'index');
    return names[index] ?? null;
  }

  function find(text) {
    if (typeof text !== 'string') throw new TypeError('FName text must be a string');
    text = nativeText(text);
    if (text.length === 0) return 0;
    const bucket = hashScriptNameBucket(text);
    const entry = findInBucket(names, buckets, text, bucket);
    return entry === null ? -1 : entryIndex(entry, names);
  }

  function resultFor(entry, index, created = false) {
    return {index, name: entry === null ? '' : entryText(entry), entry, created};
  }

  /**
   * FName constructor path 0x1014b950. `findType` follows the observed
   * numeric branches: 0 means find-only, 1 adds a normal entry, and 2 adds
   * an entry carrying the native/hardcoded flag 0x04000000.
   */
  function intern(text, findType = 1) {
    if (typeof text !== 'string') throw new TypeError('FName text must be a string');
    text = nativeText(text);
    if (!Number.isInteger(findType) || findType < 0 || findType > 2) {
      throw new TypeError('FName findType must be 0, 1, or 2');
    }
    if (text.length === 0) {
      const none = names[0] ?? null;
      return resultFor(none, 0, false);
    }

    const bucket = hashScriptNameBucket(text);
    const existing = findInBucket(names, buckets, text, bucket);
    if (existing !== null) return resultFor(existing, entryIndex(existing, names), false);
    if (findType === 0) return resultFor(names[0] ?? null, 0, false);

    let index;
    if (freeIndices.length !== 0) {
      index = freeIndices[freeIndices.length - 1];
      if (!Number.isInteger(index) || index < 0 || index >= currentNameCount || names[index] != null) {
        throw new Error('FName free-name index is outside the live GNames holes');
      }
      // Core FArray::Remove(last,1,4) removes the LIFO free index.  Its
      // generic capacity policy can shrink an oversized free-index array;
      // keep that logical capacity change even though the host array itself
      // remains JavaScript-managed.
      currentFreeNameCapacity = removeFreeIndex(freeIndices, index, currentFreeNameCapacity);
    } else {
      index = currentNameCount;
      currentNameCount++;
      if (currentNameCount > currentNameCapacity) currentNameCapacity = growthCapacity(currentNameCount);
    }

    const flags = findType === 2 ? NAME_FLAGS.native : 0;
    const head = buckets[bucket] ?? null;
    const entry = allocate(text, index, flags, head);
    if (!entry || typeof entry !== 'object') throw new TypeError('FName allocator.allocate must return an entry object');
    entry.index = index;
    entry.flags = flags;
    entry.hashNext = head;
    entry.text = text;
    buckets[bucket] = entry;
    names[index] = entry;
    return resultFor(entry, index, true);
  }

  /** Core FName::DeleteEntry body 0x1014e0b0. */
  function deleteEntry(index) {
    requireInteger(index, 'index');
    const entry = names[index] ?? null;
    if (entry === null) throw new Error(`FName DeleteEntry received an empty GNames slot ${index}`);
    if (entryIndex(entry, names) !== index) throw new Error('FName entry index does not match DeleteEntry index');
    // The original appFailAssert diagnoses this protected/native case before
    // continuing.  A host must make the unsafe continuation explicit rather
    // than silently freeing a native hardcoded entry.
    if ((entryFlags(entry) & NAME_FLAGS.native) !== 0) {
      throw new Error(`FName DeleteEntry rejected native entry ${index}`);
    }

    const text = entryText(entry);
    const bucket = hashScriptNameBucket(text);
    let previous = null;
    let current = buckets[bucket] ?? null;
    const seen = new Set();
    while (current !== null && current !== entry) {
      if (!current || seen.has(current)) throw new Error('FName hash chain is cyclic or malformed');
      seen.add(current);
      previous = current;
      current = nextEntry(current);
    }
    if (current !== entry) throw new Error(`FName entry ${index} is absent from its native hash bucket`);

    const next = nextEntry(entry);
    if (previous === null) buckets[bucket] = next;
    else setNextEntry(previous, next);

    // Native order: unlink, GMalloc::Free(entry), null GNames[index], then
    // append the reusable index to GNameAvail.
    free(entry, index, bucket);
    names[index] = null;
    freeIndices.push(index);
    if (freeIndices.length > currentFreeNameCapacity) {
      currentFreeNameCapacity = growthCapacity(freeIndices.length);
    }
    return {index, name: text, bucket, entry, next};
  }

  return {
    names,
    freeIndices,
    buckets,
    hashName: hashScriptName,
    hashBucket: hashScriptNameBucket,
    find,
    intern,
    internName: intern,
    deleteEntry,
    deleteName: deleteEntry,
    getEntry,
    get nameCount() { return currentNameCount; },
    get nameCapacity() { return currentNameCapacity; },
    get freeNameCount() { return freeIndices.length; },
    get freeNameCapacity() { return currentFreeNameCapacity; },
  };
}
