import { PackageError, Reader } from './package.mjs';

export function nameAt(pkg, index) {
  if (!pkg.names[index]) throw new PackageError(`Invalid name reference ${index}`, 0);
  return pkg.names[index].name;
}

export function objectAt(pkg, index) {
  if (index === 0) return null;
  const entry = index > 0 ? pkg.exports[index - 1] : pkg.imports[-index - 1];
  if (!entry) throw new PackageError(`Invalid object reference ${index}`, 0);
  return entry;
}

export function vector(r) { return [r.f32(), r.f32(), r.f32()]; }

export function counted(r, minimumBytes, read, count = r.compact()) {
  if (count < 0 || count > 1_000_000 || count > Math.floor((r.bytes.length - r.offset) / minimumBytes)) {
    throw new PackageError(`Invalid array count ${count}`, r.offset);
  }
  return Array.from({ length: count }, read);
}

/** Stored property overrides only. Class defaults and script execution are separate. */
export function readObject(pkg, bytes, exportIndex) {
  const entry = objectAt(pkg, exportIndex);
  if (exportIndex <= 0 || !entry.serialSize) throw new PackageError('Expected serialized export', 0);
  const reader = new Reader(bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize));
  let stack = null;
  if (entry.flags & 0x02000000) {
    const node = reader.compact(), state = reader.compact();
    objectAt(pkg, node); objectAt(pkg, state);
    const probeMask = [reader.u32(), reader.u32()];
    const latentAction = reader.i32();
    stack = { node, state, probeMask, latentAction, offset: node ? reader.compact() : null };
  }
  return { entry, reader, stack, ...readProperties(pkg, reader) };
}

/** Tagged values also appear at the end of UClass exports as default overrides. */
export function readProperties(pkg, reader) {
  const properties = [];
  const values = Object.create(null);
  while (true) {
    const name = nameAt(pkg, reader.compact());
    if (name === 'None') break;
    const info = reader.u8(), type = info & 15, sizeCode = (info >> 4) & 7;
    const struct = type === 10 ? nameAt(pkg, reader.compact()) : null;
    const size = sizeCode < 5 ? [1, 2, 4, 12, 16][sizeCode]
      : sizeCode === 5 ? reader.u8() : sizeCode === 6 ? reader.u16() : reader.u32();
    let arrayIndex = 0;
    if ((info & 128) && type !== 3) {
      const first = reader.u8();
      arrayIndex = (first & 192) === 192
        ? (first & 63) * 2 ** 24 + reader.u8() * 65536 + reader.u8() * 256 + reader.u8()
        : (first & 128) ? (first & 127) * 256 + reader.u8() : first;
    }
    const data = reader.take(type === 3 ? 0 : size);
    const r = new Reader(data);
    let value, decoded = true;
    switch (type) {
      case 1: value = r.u8(); break;
      case 2: value = r.i32(); break;
      case 3: value = Boolean(info & 128); break;
      case 4: value = r.f32(); break;
      case 5: case 8: value = r.compact(); objectAt(pkg, value); break;
      case 6: value = nameAt(pkg, r.compact()); if (pkg.nameSpelling) value = pkg.nameSpelling.spell(value); break;   // the first package to enter a name fixes its spelling (name-spelling.mjs)
      case 10:
        if (struct === 'Vector') value = vector(r);
        else if (struct === 'Rotator') value = [r.i32(), r.i32(), r.i32()];
        else if (struct === 'Scale') value = { scale: vector(r), shearRate: r.f32(), shearAxis: r.u8() };
        else if (struct === 'Color') value = [r.u8(), r.u8(), r.u8(), r.u8()];
        else { value = null; decoded = false; }
        break;
      case 11: value = vector(r); break;
      case 12: value = [r.i32(), r.i32(), r.i32()]; break;
      case 13: value = r.string(pkg.version); break;
      default: value = null; decoded = false;
    }
    if (decoded && r.offset !== data.length) throw new PackageError(`Unexpected size for property ${name}`, reader.offset);
    properties.push({ name, type, struct, arrayIndex, value, decoded, data });
    // Preserve indexed overrides individually; do not pretend to apply defaults.
    values[arrayIndex ? `${name}[${arrayIndex}]` : name] = value;
  }
  return { properties, values };
}
