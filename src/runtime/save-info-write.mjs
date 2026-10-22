/** `SaveInfo.dxs`, written the way DDeusExGameEngine::SaveGame's SavePackage(SaveInfo package, MyDeusExSaveInfo, 0, "<slot>\SaveInfo.dxs")
 * writes it (docs/travel.md "SaveGame: the SaveInfo", docs/save-storage.md "The snapshot"): a version-68 package of three exports with no Outer,
 * the 160 x 120 snapshot's `Texture` and `Palette` and the `DeusExSaveInfo` object.
 *
 * Measured on 44 files of the original: the Wine session's Save0077, the desktop saves Save0001 and QuickSave of 2026-09, and 41 slots of other players'
 * games from the internet (`.work/internet-saves`, scripts/validate-save-info-corpus.mjs reproduces every one byte for byte), all with the same layout:
 *   - 33 names: `None`, then the property names and class names of the three objects in the order of the original process's FName table, then
 *     the three object names (`Texture0`, `Palette0`, `MyDeusExSaveInfo`: the engine's unique-name counters gave the numbers) in an order that is the
 *     process's history, not the export order: Texture, Palette, SaveInfo in the first save of a process (Save0077); across the 41 internet saves
 *     Palette before Texture 23 times, Texture before Palette 18, MyDeusExSaveInfo between them 3 times and never first. Names are flagged 0x70010; the ones the
 *     engine registers natively carry 0x4000000 (`None`, `Class`, `Package` also 0x400). `saveInfo` is in the table without being used: the package's own
 *     name, tagged as the Outer. A name no tag uses is absent: a Hour or Second of 0 (the class default, not stored) leaves a 32-name table (4 of the 41).
 *     `bCheatsEnabled` is the one name whose place was not measured (no file had it set).
 *   - 5 imports (Engine, Engine.Texture, DeusEx, DeusEx.DeusExSaveInfo, Engine.Palette), 3 exports with Outer 0: the Texture (flags 0x70000), the
 *     Palette (0x70000) and MyDeusExSaveInfo (0x70004). The order of the exports is that of the objects in GObjObjects: Texture before Palette in the
 *     Wine session's file, Palette before Texture in the older two.
 *   - The Texture: tagged properties Palette (the export), UBits, VBits, USize, VSize, UClamp, VClamp, InternalTime[0], InternalTime[1] (the
 *     engine's `appSeconds()` as two ints, a host clock: it differs in every file), then the one mip: compact(1), the lazy array's SkipPos (the
 *     absolute file position after its bytes), compact(count), the P8 indices, USize, VSize, UBits, VBits.
 *   - The Palette: no tags, compact(256) and 256 colours (R, G, B, A) = (i, i, i, 255).
 *   - MyDeusExSaveInfo: Year, Month, Day, Hour, Minute, Second, DirectoryIndex, Description, MissionLocation, MapName, Snapshot, saveCount, saveTime,
 *     bCheatsEnabled in declaration order, a value equal to the class default (0, "", false) not stored.
 * The GUID is new for each save. What differs between two saves of the same state is therefore the GUID, the time stamp, the snapshot's pixels,
 * InternalTime and (through their positions) the SkipPos and the export offsets when the order or the strings change.
 *
 * `options.snapshot` is `{pitch, height, data}` (the P8 indices, pitch x height bytes, the picture in the top-left) or null: the original with the
 * OpenGL render device saves no Snapshot (SaveGame leaves the property None); that file has no Texture and Palette export (**unverified**: no such
 * file was measured, the layout is the same code without the two objects). */
import { ByteWriter } from './byte-writer.mjs';
import { PackageTables, buildPackage } from './package-write.mjs';
import { writeTaggedElement } from './tagged-write.mjs';

/** The names of the three objects in the order of the original process's name table (measured), with the flags the file carries. */
const NAME_ORDER = [['None', 0x4070410], ['InternalTime'], ['VBits'], ['VClamp'], ['UBits'], ['UClamp'], ['Palette'], ['Description'], ['USize'], ['VSize'],
  ['MapName'], ['saveTime'], ['Second'], ['Minute'], ['Hour'], ['Day'], ['Month'], ['Year'], ['MissionLocation'], ['Snapshot'], ['DirectoryIndex'],
  ['saveCount'], ['saveInfo'], ['DeusExSaveInfo'], ['DeusEx'], ['Texture', 0x4070010], ['Class', 0x4070410], ['Package', 0x4070410], ['Engine', 0x4070010],
  ['Core', 0x4070010]];
const IMPORT_ORDER = [
  { classPackage: 'Core', className: 'Package', outer: 0, name: 'Engine' },
  { classPackage: 'Core', className: 'Class', outer: -1, name: 'Texture' },
  { classPackage: 'Core', className: 'Package', outer: 0, name: 'DeusEx' },
  { classPackage: 'Core', className: 'Class', outer: -3, name: 'DeusExSaveInfo' },
  { classPackage: 'Core', className: 'Class', outer: -1, name: 'Palette' },
];

/** The properties of DeusExSaveInfo in declaration order with their tag types. `bCheatsEnabled` is the one name whose place in the original's
 * table was not measured (every measured file had it False): it is placed after the measured names, in first-use order. */
const INFO_FIELDS = [['Year', 'int'], ['Month', 'int'], ['Day', 'int'], ['Hour', 'int'], ['Minute', 'int'], ['Second', 'int'], ['DirectoryIndex', 'int'],
  ['Description', 'string'], ['MissionLocation', 'string'], ['MapName', 'string'], ['Snapshot', 'object'], ['saveCount', 'int'], ['saveTime', 'int'],
  ['bCheatsEnabled', 'bool']];
const field = (name, type) => ({ name, key: name.toLowerCase(), metadata: { type } });
const log2 = value => { const bits = Math.log2(value); if (!Number.isInteger(bits)) throw new Error(`${value} is not a power of two`); return bits; };

/** The stand-in for the source package PackageTables takes the order of its names and imports from. */
const orderSource = () => ({
  names: NAME_ORDER.map(([name, flags]) => ({ name, flags: flags ?? 0x10 })),
  imports: IMPORT_ORDER,
});

/**
 * @param properties  {Year, Month, Day, Hour, Minute, Second, DirectoryIndex, Description, MissionLocation, MapName, saveCount, saveTime, bCheatsEnabled}
 * @param snapshot    {pitch, height, data} or null
 * @param guid        16 bytes
 * @param textureName, paletteName   the unique names the engine's counters gave the two objects
 * @param textureFirst  whether the Texture precedes the Palette in the export table (GObjObjects order)
 * @param internalTime  [low, high] the two ints of appSeconds()'s double
 * @param nameTail      the order of the three object names at the end of the name table (default: the Texture's, the Palette's, MyDeusExSaveInfo): the original's is the
 *                      order of their FName indices, which depends on the process's history (41 saved games show the Texture and Palette names in both orders and
 *                      MyDeusExSaveInfo between or after them, never first); Play cannot reproduce it and takes the order of a first save in a process (Save0077)
 */
export function writeSaveInfo(options) { return writeSaveInfoDetailed(options).bytes; }

/** writeSaveInfo, and where the snapshot's indices lie in the file (`pixelOffset`, `pixelLength`; null without a snapshot): the picture can be
 * replaced in place later, since nothing else in the package depends on its values. */
export function writeSaveInfoDetailed({ properties, snapshot = null, guid, textureName = 'Texture0', paletteName = 'Palette0', textureFirst = true, internalTime = [0, 0],
  nameTail = null }) {
  if (!guid || guid.length !== 16) throw new TypeError('A package GUID is 16 bytes');
  const tables = new PackageTables({ sourcePkg: orderSource() });
  const packageKey = name => tables.importEntry({ classPackage: 'Core', className: 'Package', outerKey: '', name });
  const engine = packageKey('Engine'), deusEx = packageKey('DeusEx');
  const classKey = (packageName, name) => tables.importEntry({ classPackage: 'Core', className: 'Class', outerKey: packageName === 'Engine' ? engine : deusEx, name });
  // the exports, in table order: the objects' positions are the tags' object references
  const plan = [];
  if (snapshot) plan.push(textureFirst ? ['Texture', textureName] : ['Palette', paletteName], textureFirst ? ['Palette', paletteName] : ['Texture', textureName]);
  plan.push(['Info', 'MyDeusExSaveInfo']);
  const position = kind => plan.findIndex(entry => entry[0] === kind) + 1;
  const context = { nameIndex: text => tables.name(text), objectRef: value => (value === 'Texture' ? position('Texture') : value === 'Palette' ? position('Palette') : 0), structName: () => 'None' };

  const writers = {
    Texture: w => {
      writeTaggedElement(w, field('Palette', 'object'), 0, 'Palette', context);
      writeTaggedElement(w, field('UBits', 'byte'), 0, log2(snapshot.pitch), context);
      writeTaggedElement(w, field('VBits', 'byte'), 0, log2(snapshot.height), context);
      writeTaggedElement(w, field('USize', 'int'), 0, snapshot.pitch, context);
      writeTaggedElement(w, field('VSize', 'int'), 0, snapshot.height, context);
      writeTaggedElement(w, field('UClamp', 'int'), 0, snapshot.pitch, context);
      writeTaggedElement(w, field('VClamp', 'int'), 0, snapshot.height, context);
      writeTaggedElement(w, field('InternalTime', 'int'), 0, internalTime[0] | 0, context);
      writeTaggedElement(w, field('InternalTime', 'int'), 1, internalTime[1] | 0, context);
      w.compact(context.nameIndex('None'));
      w.compact(1);                                            // one mip
    },
    Palette: w => {
      w.compact(context.nameIndex('None'));
      w.compact(256);
      for (let i = 0; i < 256; i++) { w.u8(i); w.u8(i); w.u8(i); w.u8(255); }
    },
    Info: w => {
      const defaults = { Description: '', MissionLocation: '', MapName: '', bCheatsEnabled: false };
      for (const [name, type] of INFO_FIELDS) {
        const value = name === 'Snapshot' ? (snapshot ? 'Texture' : null) : properties[name];
        const fallback = defaults[name] ?? (type === 'object' ? null : 0);
        const same = type === 'string' ? String(value ?? '') === fallback : type === 'object' ? (value ?? null) === fallback : type === 'bool' ? Boolean(value) === fallback : (value | 0) === fallback;
        if (!same) writeTaggedElement(w, field(name, type), 0, value, context);
      }
      w.compact(context.nameIndex('None'));
    },
  };

  const exports = plan.map(([kind, name]) => ({
    classKey: kind === 'Texture' ? classKey('Engine', 'Texture') : kind === 'Palette' ? classKey('Engine', 'Palette') : classKey('DeusEx', 'DeusExSaveInfo'),
    superRef: 0, outerExport: 0, name, flags: kind === 'Info' ? 0x70004 : 0x70000, kind,
  }));
  // Pass 1 learns the names and imports the payloads use; the names of the objects follow in export order.
  for (const entry of exports) writers[entry.kind](new ByteWriter(64));
  tables.name('saveInfo');                                 // the Outer's name: tagged, in the table, used by no entry
  const tail = nameTail ?? [snapshot ? textureName : null, snapshot ? paletteName : null, 'MyDeusExSaveInfo'].filter(Boolean);
  if (tail.length !== exports.length || exports.some(entry => !tail.includes(entry.name))) throw new Error(`the name tail ${tail} is not the exports' names`);
  for (const name of tail) tables.name(name);
  tables.finalize();
  // Pass 2 writes the bytes with the final indices. The Texture's lazy array records the file position after its bytes, so each payload is
  // placed as buildPackage places it: header (64 bytes), the name table, then the payloads in export order.
  const nameTable = new ByteWriter(1024);
  for (const entry of tables.nameList) { nameTable.string(entry.text); nameTable.u32(entry.flags); }
  let at = 64 + nameTable.length, pixelOffset = null;
  for (const entry of exports) {
    const w = new ByteWriter(1024);
    writers[entry.kind](w);
    if (entry.kind === 'Texture') {
      // the mip: SkipPos (the position after the indices), the count, the indices, then USize, VSize, UBits, VBits
      const count = new ByteWriter(8); count.compact(snapshot.data.length);
      w.u32(at + w.length + 4 + count.length + snapshot.data.length);
      w.raw(count.finish());
      pixelOffset = at + w.length;
      w.raw(snapshot.data);
      w.u32(snapshot.pitch); w.u32(snapshot.height); w.u8(log2(snapshot.pitch)); w.u8(log2(snapshot.height));
    }
    const bytes = w.finish();
    entry.write = out => out.raw(bytes);
    at += bytes.length;
  }
  return { bytes: buildPackage(tables, exports, { guid }), pixelOffset, pixelLength: snapshot ? snapshot.data.length : 0 };
}
