import { Reader, PackageError } from './package.mjs';
import { counted, nameAt, objectAt, readProperties } from './objects.mjs';

/** Walk serialized UE1 bytecode without executing it. Object/name indices expand
 * to four bytes in the script size stored by the original engine. */
export function skipBytecode(pkg, r, size) {
  if (!Number.isInteger(size) || size < 0 || size > 16_000_000) throw new PackageError('Invalid script size', r.offset);
  let expanded = 0;
  const bytes = n => { r.take(n); expanded += n; };
  const index = isName => { const n = r.compact(); expanded += 4; if (isName) nameAt(pkg, n); else objectAt(pkg, n); };
  function expression(depth = 0) {
    if (depth > 128 || expanded >= size) throw new PackageError('Invalid script nesting or size', r.offset);
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
      case 0x0c: while (true) { const n = r.compact(); expanded += 4; bytes(4); if (nameAt(pkg, n) === 'None') break; } break;
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
    if (expanded > size) throw new PackageError('Script size mismatch', r.offset);
    return op;
  }
  while (expanded < size) expression();
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
  r.take(16); // Probe/ignore masks
  const labelTableOffset = r.u16(), stateFlags = r.u32(), classFlags = r.u32();
  r.take(16); // GUID
  const dependencies = counted(r, 9, () => ({ class: ref(), deep: r.u32(), scriptCRC: r.u32() }));
  const packageImports = counted(r, 1, () => nameAt(pkg, r.compact()));
  const within = ref(), configName = nameAt(pkg, r.compact());
  const defaultsOffset = r.offset, defaults = readProperties(pkg, r);
  if (r.offset !== r.bytes.length) throw new PackageError('Trailing Class data', r.offset);
  if (base !== entry.superIndex) throw new Error('Class superclass disagrees with export table');
  return { entry, base, next, scriptText, children, friendlyName, line, textPosition,
    scriptSize, scriptBytes, labelTableOffset, stateFlags, classFlags, dependencies,
    packageImports, within, configName, defaultsOffset, ...defaults };
}

/** Select scalar/struct defaults only: resource references need package provenance
 * and will be handled by the future runtime rather than merged as map indices. */
export class ClassDefaults {
  constructor(assets) { this.assets = assets; this.cache = new Map(); }
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
  async forActor(asset, actor) {
    return { ...await this.get(asset, asset.pkg.exports[actor.index - 1].classIndex), ...actor.values };
  }
}
