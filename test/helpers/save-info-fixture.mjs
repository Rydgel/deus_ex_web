/** A hand-built `SaveInfo.dxs` for tests (no game data): a version-68 package laid out like the two real saves of docs/save-directory.md, with the
 * `Palette` and `Texture` exports of the snapshot and the `DeusExSaveInfo` object `MyDeusExSaveInfo`, their properties tagged as UnrealScript
 * serializes them. `buildSaveInfo({properties, snapshot})`: `snapshot` is null (no Snapshot property) or `{width, height, data, colors, format}`. */

const compact = value => {
  const out = [];
  const negative = value < 0; let rest = Math.abs(value);
  let first = (negative ? 0x80 : 0) | (rest & 0x3f); rest = Math.floor(rest / 64);
  if (rest) first |= 0x40;
  out.push(first);
  while (rest) { let byte = rest & 0x7f; rest = Math.floor(rest / 128); if (rest) byte |= 0x80; out.push(byte); }
  return out;
};
const u32 = value => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
const u16 = value => [value & 255, (value >>> 8) & 255];
const ansi = text => [...new TextEncoder().encode(text), 0];
const concat = parts => Uint8Array.from(parts.flatMap(part => [...part]));

export function buildSaveInfo({ properties = {}, snapshot = null, textureName = 'Texture1', paletteName = 'Palette1' } = {}) {
  const names = ['None'];
  const nameIndex = name => { let i = names.indexOf(name); if (i < 0) { i = names.length; names.push(name); } return i; };
  const ref = {                                                   // the imports and exports the real file has
    imports: [['Core', 'Package', 0, 'Engine'], ['Core', 'Class', -1, 'Texture'], ['Core', 'Package', 0, 'DeusEx'], ['Core', 'Class', -3, 'DeusExSaveInfo'], ['Core', 'Class', -1, 'Palette']],
  };
  const tag = (name, type, value, { size = null } = {}) => {
    const body = value;
    const sizeCode = size === null ? ({ 1: 0, 2: 1, 4: 2, 12: 3, 16: 4 }[body.length] ?? 5) : size;
    return [...compact(nameIndex(name)), type | (sizeCode << 4), ...(sizeCode === 5 ? [body.length] : []), ...body];
  };
  const int = (name, value) => tag(name, 2, u32(value));
  const byte = (name, value) => tag(name, 1, [value]);
  const object = (name, index) => tag(name, 5, compact(index));
  const string = (name, text) => { const body = [...compact(text.length + 1), ...ansi(text)]; return tag(name, 13, body); };
  const bool = (name, value) => [...compact(nameIndex(name)), 3 | (0 << 4) | (value ? 0x80 : 0)];
  const none = [0];

  const exportBodies = [];                                         // [{name, classIndex, flags, bytes(offset => Uint8Array)}]
  if (snapshot) {
    const colors = snapshot.colors, count = colors.length / 4;
    exportBodies.push({ name: paletteName, classIndex: -5, flags: 0x70000, make: () => concat([none, compact(count), [...colors]]) });
    const width = snapshot.width, height = snapshot.height;
    const tagged = [object('Palette', 1), byte('UBits', Math.log2(width)), byte('VBits', Math.log2(height)), int('USize', width), int('VSize', height),
      int('UClamp', width), int('VClamp', height), ...(snapshot.format ? [byte('Format', snapshot.format)] : []), none];
    exportBodies.push({ name: textureName, classIndex: -2, flags: 0x70000, make: offset => {
      const head = tagged.flat(), mip = [...compact(snapshot.data.length), ...snapshot.data, ...u32(width), ...u32(height), Math.log2(width), Math.log2(height)];
      // mip count (1), the skip offset (the absolute offset after the mip's data: the reader checks it), the mip
      const dataEnd = offset + head.length + 1 + 4 + compact(snapshot.data.length).length + snapshot.data.length;
      return concat([head, [1], u32(dataEnd), mip]);
    } });
  }
  const infoProperties = [];
  for (const [name, value] of Object.entries(properties)) {
    if (typeof value === 'string') infoProperties.push(string(name, value));
    else if (typeof value === 'boolean') infoProperties.push(bool(name, value));
    else infoProperties.push(int(name, value));
  }
  if (snapshot) infoProperties.push(object('Snapshot', 2));
  exportBodies.push({ name: 'MyDeusExSaveInfo', classIndex: -4, flags: 0x70004, make: () => concat([...infoProperties, none]) });

  // layout: header (64 bytes), export data, then the name, import and export tables
  const headerSize = 64;
  let offset = headerSize;
  const laidOut = exportBodies.map(entry => { const bytes = entry.make(offset); const placed = { ...entry, bytes, offset }; offset += bytes.length; return placed; });
  // (names used by the tables are interned before the tables are written)
  for (const [packageName, className, , name] of ref.imports) { nameIndex(packageName); nameIndex(className); nameIndex(name); }
  for (const entry of laidOut) nameIndex(entry.name);
  const nameTable = concat(names.map(name => [...compact(name.length + 1), ...ansi(name), ...u32(0x70010)]));
  const importTable = concat(ref.imports.map(([packageName, className, outer, name]) => [...compact(nameIndex(packageName)), ...compact(nameIndex(className)), ...u32(outer >>> 0), ...compact(nameIndex(name))]));
  const exportTable = concat(laidOut.map(entry => [...compact(entry.classIndex), ...compact(0), ...u32(0), ...compact(nameIndex(entry.name)), ...u32(entry.flags),
    ...compact(entry.bytes.length), ...compact(entry.offset)]));
  const namesAt = offset, importsAt = namesAt + nameTable.length, exportsAt = importsAt + importTable.length;
  const header = concat([u32(0x9e2a83c1), u16(68), u16(0), u32(0),
    u32(names.length), u32(namesAt), u32(laidOut.length), u32(exportsAt), u32(ref.imports.length), u32(importsAt),
    new Array(16).fill(7), u32(1), u32(laidOut.length), u32(names.length)]);
  return concat([header, ...laidOut.map(entry => entry.bytes), nameTable, importTable, exportTable]);
}
