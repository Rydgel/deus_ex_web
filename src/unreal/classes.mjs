import { Reader, PackageError } from './package.mjs';
import { counted, nameAt, objectAt, readProperties } from './objects.mjs';

/** One serialized UE1 expression, shared by the whole-script skipper and the
 * linker-Preload SerializeExpr boundary.  Returns the expanded byte count the
 * original engine records for the expression (object/name indices expand to
 * four bytes in the stored script size).  `onIndex(isName, value, start, end)`
 * observes each serialized compact reference span so callers can emit the
 * expanded in-memory form. */
function scriptExpression(pkg, r, onIndex = null) {
  let expanded = 0;
  const bytes = n => { r.take(n); expanded += n; };
  const index = isName => {
    const start = r.offset;
    const n = r.compact();
    expanded += 4;
    if (isName) nameAt(pkg, n); else objectAt(pkg, n);
    if (onIndex) onIndex(isName, n, start, r.offset);
  };
  function expression(depth = 0) {
    if (depth > 128) throw new PackageError('Invalid script nesting', r.offset);
    const op = r.u8(); expanded++;
    const child = () => expression(depth + 1);
    const argumentsList = () => { while (child() !== 0x16) {} };
    if (op >= 0x60) { if (op < 0x70) bytes(1); argumentsList(); }
    else if (op >= 0x39 && op <= 0x59) child();
    else switch (op) {
      case 0x00: case 0x01: case 0x02: case 0x20: case 0x29: index(false); break;
      case 0x21: index(true); break;
      case 0x04: if (pkg.version > 61) child(); break;
      case 0x05: bytes(1); child(); break;
      case 0x06: bytes(2); break;
      case 0x07: case 0x09: case 0x18: bytes(2); child(); break;
      case 0x0a: { const offset = r.u16(); expanded += 2; if (offset !== 65535) child(); break; }
      case 0x0c: while (true) {
        const start = r.offset;
        const n = r.compact();
        const end = r.offset;
        expanded += 4;
        bytes(4);
        if (onIndex) onIndex(true, n, start, end);
        if (nameAt(pkg, n) === 'None') break;
      } break;
      case 0x0d: case 0x0e: case 0x2d: child(); break;
      case 0x0f: case 0x10: case 0x14: case 0x1a: child(); child(); break;
      case 0x11: child(); child(); child(); child(); break;
      case 0x12: case 0x19: child(); bytes(3); child(); break;
      case 0x13: case 0x2e: case 0x36: index(false); child(); break;
      case 0x1b: case 0x38: index(true); argumentsList(); break;
      case 0x1c: index(false); argumentsList(); break;
      case 0x1d: case 0x1e: bytes(4); break;
      case 0x1f: while (r.u8() !== 0) expanded++; expanded++; break;
      case 0x22: case 0x23: bytes(12); break;
      case 0x24: case 0x2c: bytes(1); break;
      case 0x2b: bytes(1); child(); break;
      case 0x2f: child(); bytes(2); break;
      case 0x32: case 0x33: index(false); child(); child(); break;
      case 0x34: while (r.u16() !== 0) expanded += 2; expanded += 2; break;
      case 0x08: case 0x0b: case 0x15: case 0x16: case 0x17: case 0x25: case 0x26:
      case 0x27: case 0x28: case 0x2a: case 0x30: case 0x31: break;
      default: throw new PackageError(`Unsupported script token 0x${op.toString(16)}`, r.offset - 1);
    }
    return op;
  }
  expression();
  return expanded;
}

/**
 * Consume one serialized expression — the byte-consumption step of the
 * recovered UStruct::SerializeExpr load loop at 0x10126ff0.  `r` must be
 * positioned at the expression start; returns the expanded size the native
 * cursor advances by.
 */
export function skipScriptExpression(pkg, r) {
  const start = r.offset;
  const expanded = scriptExpression(pkg, r);
  return { expanded, serialized: r.offset - start };
}

/**
 * One serialized expression expanded the way the recovered
 * `UStruct::SerializeExpr` (0x101289c0) writes it into the Script FArray:
 * raw stream bytes pass through, while each compact object/name reference is
 * replaced by the resolved four-byte slot — `resolveObject(index)` supplies
 * the object pointer word and `resolveName(index)` the process-wide FName
 * index.  Returns the expanded bytes plus the expanded/serialized sizes.
 */
export function expandScriptExpression(pkg, r, { resolveObject, resolveName } = {}) {
  if (typeof resolveObject !== 'function' || typeof resolveName !== 'function') {
    throw new TypeError('expandScriptExpression requires resolveObject and resolveName');
  }
  const start = r.offset;
  const refs = [];
  const expanded = scriptExpression(pkg, r, (isName, value, at, end) => {
    const word = isName ? resolveName(value) : resolveObject(value);
    if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) {
      throw new PackageError(`Expanded script ${isName ? 'name' : 'object'} reference is not a dword`, at);
    }
    refs.push({ at, end, word });
  });
  const serialized = r.offset - start;
  const raw = r.bytes.subarray(start, r.offset);
  const out = new Uint8Array(expanded);
  let source = 0, target = 0;
  for (const ref of refs) {
    const before = ref.at - start - source;
    out.set(raw.subarray(source, source + before), target);
    source += before;
    target += before;
    out[target] = ref.word & 0xff;
    out[target + 1] = (ref.word >>> 8) & 0xff;
    out[target + 2] = (ref.word >>> 16) & 0xff;
    out[target + 3] = (ref.word >>> 24) & 0xff;
    target += 4;
    source += ref.end - ref.at;
  }
  out.set(raw.subarray(source), target);
  return { bytes: out, expanded, serialized };
}

/**
 * Walk one expression inside the expanded in-memory script — the buffer the
 * load path fills through `expandScriptExpression`.  Object and name slots
 * are fixed four-byte words there, so the same token table runs with `index`
 * reads widened to a dword.  `data` is the script byte span; `offset` the
 * starting cursor.  Returns the end cursor (the recovered SerializeExpr
 * `iMem` advance).  `onIndex(isName, offset)`, when given, receives each
 * object or name word's offset, as the compact walker's `onIndex` does: the
 * collector's SerializeExpr visits the same words (an object word through the
 * archive's object operator, a name word through its name operator).
 */
export function skipExpandedScriptExpression(data, offset, { version = 68, onIndex = null } = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let cursor = offset;
  let expanded = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const take = n => { const s = cursor; cursor += n; expanded += n; return bytes.subarray(s, s + n); };
  const readU8 = () => { const v = bytes[cursor]; cursor += 1; expanded += 1; return v; };
  const readU16 = () => { const v = view.getUint16(cursor, true); cursor += 2; expanded += 2; return v; };
  const index = (isName = false) => { if (onIndex) onIndex(isName, cursor); cursor += 4; expanded += 4; };
  function expression(depth = 0) {
    if (depth > 128) throw new PackageError('Invalid expanded script nesting', cursor);
    const op = readU8();
    const child = () => expression(depth + 1);
    const argumentsList = () => { while (child() !== 0x16) {} };
    if (op >= 0x60) { if (op < 0x70) take(1); argumentsList(); }
    else if (op >= 0x39 && op <= 0x59) child();
    else switch (op) {
      case 0x00: case 0x01: case 0x02: case 0x20: case 0x29: index(); break;
      case 0x21: index(true); break;
      case 0x04: if (version > 61) child(); break;
      case 0x05: take(1); child(); break;
      case 0x06: take(2); break;
      case 0x07: case 0x09: case 0x18: take(2); child(); break;
      case 0x0a: { const jump = readU16(); if (jump !== 65535) child(); break; }
      case 0x0c: while (true) { index(true); take(4); if (view.getUint32(cursor - 8, true) === 0) break; } break;
      case 0x0d: case 0x0e: case 0x2d: child(); break;
      case 0x0f: case 0x10: case 0x14: case 0x1a: child(); child(); break;
      case 0x11: child(); child(); child(); child(); break;
      case 0x12: case 0x19: child(); take(3); child(); break;
      case 0x13: case 0x2e: case 0x36: index(); child(); break;
      case 0x1b: case 0x38: index(true); argumentsList(); break;
      case 0x1c: index(); argumentsList(); break;
      case 0x1d: case 0x1e: take(4); break;
      case 0x1f: while (readU8() !== 0) {} break;
      case 0x22: case 0x23: take(12); break;
      case 0x24: case 0x2c: take(1); break;
      case 0x2b: take(1); child(); break;
      case 0x2f: child(); take(2); break;
      case 0x32: case 0x33: index(); child(); child(); break;
      case 0x34: while (readU16() !== 0) {} break;
      case 0x08: case 0x0b: case 0x15: case 0x16: case 0x17: case 0x25: case 0x26:
      case 0x27: case 0x28: case 0x2a: case 0x30: case 0x31: break;
      default: throw new PackageError(`Unsupported expanded script token 0x${op.toString(16)}`, cursor - 1);
    }
    return op;
  }
  expression();
  return cursor;
}

/** Walk serialized UE1 bytecode without executing it. Object/name indices expand
 * to four bytes in the script size stored by the original engine. */
export function skipBytecode(pkg, r, size) {
  if (!Number.isInteger(size) || size < 0 || size > 16_000_000) throw new PackageError('Invalid script size', r.offset);
  let expanded = 0;
  while (expanded < size) {
    const { expanded: delta } = skipScriptExpression(pkg, r);
    expanded += delta;
  }
  if (expanded !== size) throw new PackageError('Script size mismatch', r.offset);
}

export function readClass(asset, index) {
  const { pkg, bytes } = asset, entry = objectAt(pkg, index);
  if (index <= 0 || entry.className !== 'Class' || !entry.serialSize) throw new Error('Expected a serialized Class');
  if (pkg.version < 68 || pkg.version > 69) throw new Error(`Unsupported class version ${pkg.version}`);
  const r = new Reader(bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize));
  if (entry.flags & 0x02000000) throw new Error('Unexpected Class state frame');
  const ref = () => { const v = r.compact(); objectAt(pkg, v); return v; };
  const base = ref(), next = ref(), scriptText = ref(), children = ref();
  const friendlyName = nameAt(pkg, r.compact());
  const line = r.u32(), textPosition = r.u32(), scriptSize = r.u32(), scriptStart = r.offset;
  skipBytecode(pkg, r, scriptSize);
  const scriptBytes = r.offset - scriptStart;
  const probeMask=[r.u32(),r.u32()],ignoreMask=[r.u32(),r.u32()];
  const labelTableOffset = r.u16(), stateFlags = r.u32(), classFlags = r.u32();
  r.take(16); // GUID
  const dependencies = counted(r, 9, () => ({ class: ref(), deep: r.u32(), scriptCRC: r.u32() }));
  const packageImports = counted(r, 1, () => nameAt(pkg, r.compact()));
  const within = ref(), configName = nameAt(pkg, r.compact());
  const defaultsOffset = r.offset, defaults = readProperties(pkg, r);
  if (r.offset !== r.bytes.length) throw new PackageError('Trailing Class data', r.offset);
  if (base !== entry.superIndex) throw new Error('Class superclass disagrees with export table');
  return { entry, base, next, scriptText, children, friendlyName, line, textPosition,
    scriptSize, scriptBytes, probeMask, ignoreMask, labelTableOffset, stateFlags, classFlags, dependencies,
    packageImports, within, configName, defaultsOffset, ...defaults };
}

/** Select scalar/struct defaults only: resource references need package provenance
 * and will be handled by the future runtime rather than merged as map indices. */
export class ClassDefaults {
  constructor(assets) { this.assets = assets; this.cache = new Map(); this.lineages = new Map(); }
  /** Original export-table superclass references, with package identity retained.
   * Native IsA follows this same ancestry; short class names alone are ambiguous.
   */
  async lineage(asset, ref, ancestors = []) {
    const object = await this.assets.resolve(asset, ref);
    if (object.entry.className !== 'Class') throw new Error(`Expected class: ${object.key}`);
    if (ancestors.includes(object.key)) throw new Error(`Cyclic class inheritance: ${object.key}`);
    if (!this.lineages.has(object.key)) {
      const pending = (async () => [object.key.toLowerCase(), ...(object.entry.superIndex
        ? await this.lineage(object.asset, object.entry.superIndex, [...ancestors, object.key]) : [])])();
      this.lineages.set(object.key, pending);
      pending.catch(() => this.lineages.delete(object.key));
    }
    return this.lineages.get(object.key);
  }
  async get(asset, ref, ancestry = []) {
    const object = await this.assets.resolve(asset, ref);
    if (ancestry.includes(object.key)) throw new Error(`Cyclic class inheritance: ${object.key}`);
    if (!this.cache.has(object.key)) {
      const pending = (async () => {
        const cls = readClass(object.asset, object.index);
        const parent = cls.base ? await this.get(object.asset, cls.base, [...ancestry, object.key]) : {};
        const values = { ...parent };
        for (const p of cls.properties) {
          if (p.decoded && ![5, 8].includes(p.type)) values[p.arrayIndex ? `${p.name}[${p.arrayIndex}]` : p.name] = p.value;
        }
        return values;
      })();
      this.cache.set(object.key, pending); pending.catch(() => this.cache.delete(object.key));
    }
    return this.cache.get(object.key);
  }
  /** An object-reference default (`name`) with its package: the class's
   * own tagged default or its nearest ancestor's, resolved in the package
   * that declares it. */
  async objectDefault(asset, ref, name) {
    const object = await this.assets.resolve(asset, ref);
    const cls = readClass(object.asset, object.index);
    const property = cls.properties.find(p => p.name === name && [5, 8].includes(p.type) && !p.arrayIndex);
    if (property) return property.value ? { asset: object.asset, ref: property.value } : null;
    return cls.base ? this.objectDefault(object.asset, cls.base, name) : null;
  }
  async forActor(asset, actor) {
    return { ...await this.get(asset, asset.pkg.exports[actor.index - 1].classIndex), ...actor.values };
  }
}
