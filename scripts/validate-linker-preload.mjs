/**
 * Drive the recovered `ULinkerLoad::Preload` (Core.dll 0x10162000) over real
 * DeusEx.u class exports — `DataVaultImage` plus a curated set covering every
 * shipped default-tag shape (docs/script-linker-preload.md) — including the
 * complete closure each preload pulls through this package's and the other
 * packages' linkers.
 *
 * What this exercises end to end:
 *
 *   - real package linkers built from the installed bytes — names interned
 *     into one process-wide FName table, imports verified by the recovered
 *     Verify/VerifyImport bodies and materialized lazily by CreateImport
 *     through the target package's own `ULinkerLoad`, exports created
 *     through `ULinkerLoad::CreateExport` (0x1012e230) exactly as
 *     IndexToObject drives it;
 *   - the registered Core/Engine/DeusEx native class objects
 *     (docs/script-native-registration-order.md +
 *     src/runtime/script-native-class-registry.mjs) aliased onto their
 *     package class exports by the StaticConstructObject find path
 *     (0x101579c0): the found object is re-initialized in place, its flags
 *     become `SetFlags | (old & 0x0c000000)` — which is how the registered
 *     records acquire RF_NeedLoad and serialize their package data;
 *   - `ULinkerLoad::Preload` itself: the IsA(UStruct) super preload, the
 *     cross-linker delegation through the object's +0x10 linker, the
 *     Seek/Precache/Serialize/Tell ordering and the export-size warning;
 *   - the recovered serialize chain: UObject/UField/UStruct/UState/UClass/
 *     UFunction/UProperty/UEnum/UConst/UTextBuffer bodies, the SerializeExpr
 *     boundary expanding compact refs to four-byte script slots, and the
 *     tagged-defaults loop writing through mutable cells;
 *   - the recovered link chain (UStruct/UState/UClass::Link + the per-kind
 *     UProperty::Link bodies) with the replication-condition walk over
 *     expanded script memory.
 *
 * The oracle is the decoded package (`readClass`/`readFieldLinks`/
 * `readPropertyMetadata` in src/unreal): field order, kinds, arrayDim,
 * linked offsets, PropertiesSize and every tagged default are compared.
 *
 * Explicit boundaries (recorded, not silently faked):
 *   - `initClassDefaultObject` seeds the defaults map from the superclass's
 *     already-loaded defaults (the native InitProperties memcpy boundary);
 *     native C++ constructor defaults for properties without a package tag
 *     are not modelled — comparison covers serialized tags only;
 *   - the registration-time defaults of the metaclasses themselves are not
 *     modelled: a constructed object seeds its instance region from the
 *     class's defaults block only once that class has serialized one (the
 *     re-init event records whether defaults existed);
 *   - `loadConfig`/`loadLocalized` are observed but do not mutate (no ini);
 *   - UObject::Serialize's FStateFrame block (RF 0x02000000) stays
 *     unsupported — no export in this closure carries it.
 */

import {exportObject, exportRecord} from '../src/runtime/linker-exports.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {Reader} from '../src/unreal/package.mjs';
import {
  readClass,
} from '../src/unreal/classes.mjs';
import {
  readFieldLinks,
  readPropertyMetadata,
  readStructMetadata,
} from '../src/unreal/script-metadata.mjs';
import { nameAt, exportAt, importAt } from '../src/unreal/objects.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';

import {createScriptLoadGraph} from '../src/runtime/script-load-graph.mjs';
import {linkerPreload} from '../src/runtime/script-linker-preload.mjs';
import {ENGINE_CLASSES} from '../src/runtime/script-native-class-registry.mjs';
import {INVENTORY_CONSTRUCTION} from '../src/runtime/script-inventory-construction.mjs';
import {gameDirectory} from './game-directory.mjs';

const {dataVaultImage, layout} = INVENTORY_CONSTRUCTION;

const root = gameDirectory();
const systemFiles = [];
for (const directory of ['System', 'Maps', 'Sounds', 'Textures', 'Music']) {
  for (const name of await readdir(path.join(root, directory))) {
    systemFiles.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
  }
}
const systemAssets = new AssetStore(systemFiles);

assert.equal(createHash('sha256')
  .update(await readFile(path.join(root, 'System', 'DeusEx.u'))).digest('hex'),
  INVENTORY_CONSTRUCTION.binaries.deusEx.sha256, 'local DeusEx.u is the recorded GOTY package');
assert.equal(createHash('sha256')
  .update(await readFile(path.join(root, 'System', 'Core.dll'))).digest('hex'),
  '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  'local Core.dll is the recorded GOTY build');

const packageAssets = new Map();
for (const file of systemFiles) {
  if (!/\.(u|uax|utx|umx)$/i.test(file.path)) continue;
  const name = path.basename(file.path).replace(/\.[^.]+$/, '');
  packageAssets.set(name.toLowerCase(), await systemAssets.get(name));
}
const graph = createScriptLoadGraph({packageAssets, captureEvents: true});
const {linkers, events, warnings, assertions, linkOrder, loadedObjects,
  buildLinker, indexToObject, preloadServices, slotOf, addr, sameRecord,
  classRecordOf, isA, fullName, nameText, propertyKindOf, structFieldChain,
  classStatic, propertyStatic} = graph;
const skippedStructValues = [];
const f32 = new Float32Array(1);
const f32u32 = new Uint32Array(f32.buffer);

// ---------------------------------------------------------------------------
// Per-class comparator: run one Class export through the recovered
// ULinkerLoad::Preload and compare every serialized field against the
// decoded-package oracle.
// ---------------------------------------------------------------------------

/** Full-name oracle for a package-local object reference (tag values). */
function oraclePathForRef(ref, linker) {
  if (typeof ref === 'string') return ref;
  if (ref === 0 || ref === null || ref === undefined) return null;
  if (ref > 0) return `${linker.packageName}.${exportAt(linker.pkg, ref).path}`;
  return importAt(linker.pkg, ref).path;
}

// Member kinds this comparator does not decode inside an undecoded struct
// tag payload — recorded boundaries, not silently faked.
const SKIPPED_STRUCT_MEMBER_KINDS = new Set([
  'BoolProperty', 'StructProperty', 'ArrayProperty', 'FixedArrayProperty', 'MapProperty',
]);
const DECODED_STRUCT_MEMBER_KINDS = new Set([
  'ByteProperty', 'IntProperty', 'FloatProperty', 'NameProperty',
  'ObjectProperty', 'ClassProperty', 'StrProperty',
]);

function verifyClassExport(className, {linker = deusExLinker} = {}) {
  const asset = {pkg: linker.pkg, bytes: linker.bytes, name: linker.packageName};
  const index = linker.pkg.exports.findIndex(e => e.name === className && e.className === 'Class');
  assert.ok(index >= 0, `${linker.packageName} exports a Class named ${className}`);
  const exportEntry = exportRecord(linker.exports, index);

  // Preload may be a no-op here: a class already serialized as another set
  // member's superclass returns {preloaded: false, reason: 'loaded'}.  The
  // serialize proof is the recorded PreloadTellExit event for this record.
  const object = indexToObject(linker, index + 1);
  assert.ok(object, `CreateExport produced ${className}`);
  linkerPreload(object, {archive: linker.archive, linker, events}, preloadServices);
  const tellExit = events.find(event =>
    event.op === 'PreloadTellExit' && sameRecord(event.object, object));
  assert.ok(tellExit, `${className} serialized through ULinkerLoad::Preload`);
  assert.equal(tellExit.consumed, exportEntry.serialSize,
    `${className} Preload consumed exactly the export serial range`);
  assert.ok(!events.some(event =>
    event.op === 'PreloadSizeMismatch' && sameRecord(event.object, object)),
    `${className} raised no export-size warning`);

  const oracle = readClass(asset, index + 1);

  // Children chain: names, classes, arrayDim/flags and linked offsets vs the
  // decoded-package oracle.
  const oracleFields = [];
  {
    let ref = oracle.children;
    const seen = new Set();
    while (ref) {
      assert.ok(!seen.has(ref), `${className} oracle children chain is acyclic`);
      seen.add(ref);
      const entry = exportAt(linker.pkg, ref);
      const links = readFieldLinks(asset, ref);
      oracleFields.push({ref, entry, links});
      ref = links.nextRef;
    }
  }
  const loadedFields = [];
  {
    let field = slotOf(object, 0x38) ?? null;
    const seen = new Set();
    while (field) {
      assert.ok(!seen.has(addr(field)), `${className} loaded children chain is acyclic`);
      seen.add(addr(field));
      loadedFields.push(field);
      field = slotOf(field, 0x2c) ?? null;
    }
  }
  assert.equal(loadedFields.length, oracleFields.length,
    `${className} children chain length matches the package`);
  for (const [i, expected] of oracleFields.entries()) {
    const field = loadedFields[i];
    assert.equal(nameText(slotOf(field, 0x20)), expected.entry.name, `${className} child ${i} name`);
    assert.equal(propertyKindOf(field), expected.entry.className, `${className} child ${i} class`);
  }
  const linkedProperties = loadedFields.filter(field => isA(field, propertyStatic));
  for (const [i, expected] of oracleFields.entries()) {
    if (!expected.entry.className.endsWith('Property')) continue;
    const field = loadedFields[i];
    const oracleProp = readPropertyMetadata(asset, expected.ref);
    assert.equal(slotOf(field, 0x34), oracleProp.arrayDim,
      `${className}.${expected.entry.name} serialized ArrayDim`);
    assert.equal(slotOf(field, 0x3c), oracleProp.propertyFlags,
      `${className}.${expected.entry.name} serialized PropertyFlags`);
    assert.ok(Number.isInteger(slotOf(field, 0x48)),
      `${className}.${expected.entry.name} received a linked Offset`);
  }
  // UBoolProperty::Link packs consecutive bools into one DWORD
  // (Offset = Prev->Offset while the bitmask shifts), so equal consecutive
  // offsets are legal exactly when both properties are BoolProperty.
  const ownOffsets = linkedProperties.map(field => slotOf(field, 0x48));
  for (let i = 1; i < ownOffsets.length; i += 1) {
    const packedBool = ownOffsets[i] === ownOffsets[i - 1] &&
      propertyKindOf(linkedProperties[i]) === 'BoolProperty' &&
      propertyKindOf(linkedProperties[i - 1]) === 'BoolProperty';
    assert.ok(ownOffsets[i] > ownOffsets[i - 1] || packedBool,
      `${className} own-property offsets increase in link order ` +
      `(${nameText(slotOf(linkedProperties[i - 1], 0x20))} -> ${nameText(slotOf(linkedProperties[i], 0x20))})`);
  }

  // Serialized class-body fields vs the oracle.
  assert.equal(slotOf(object, 0x484), oracle.classFlags, `${className} ClassFlags`);
  assert.equal(nameText(slotOf(object, 0x4a0)), oracle.configName, `${className} ClassConfigName`);
  assert.equal(nameText(slotOf(object, 0x40)), oracle.friendlyName, `${className} FriendlyName`);
  assert.equal(slotOf(object, 0x54), oracle.line, `${className} Line`);
  assert.equal(slotOf(object, 0x50), oracle.textPosition, `${className} TextPos`);
  const loadedDeps = slotOf(object, 0x4bc);
  assert.equal(loadedDeps?.num ?? loadedDeps?.data?.length, oracle.dependencies.length,
    `${className} dependency count`);

  // Tagged defaults vs the oracle.  Tag events were scoped to their
  // destination by the serializeTaggedProperties wrapper; the defaults pass
  // is the one whose data is the class's allocated Map.
  const defaultsMap = object.defaults?.data;
  assert.ok(defaultsMap instanceof Map, `${className} defaults storage exists`);
  const appliedTags = events.filter(event =>
    (event.op === 'TagSerializeItem' || event.op === 'TagBoolItem') && event.data === defaultsMap);
  const oracleTags = oracle.properties;
  assert.equal(appliedTags.length, oracleTags.length,
    `${className} applied ${oracleTags.length} tags`);

  const loadedTagValue = event => {
    const property = event.property;
    const kind = propertyKindOf(property);
    const raw = defaultsMap.get(event.destOffset);
    if (event.op === 'TagBoolItem') return (event.tag.raw & 0x80) !== 0;
    if (kind === 'NameProperty') return raw === null || raw === undefined ? raw : nameText(raw);
    return raw;
  };

  for (const [i, oracleTag] of oracleTags.entries()) {
    const applied = appliedTags[i];
    assert.equal(nameText(slotOf(applied.property, 0x20)), oracleTag.name,
      `${className} tag ${i} resolves to ${oracleTag.name}`);
    assert.equal(applied.tag.type, oracleTag.type, `${className} tag ${i} type`);
    assert.equal(applied.tag.arrayIndex, oracleTag.arrayIndex, `${className} tag ${i} arrayIndex`);
    assert.equal(applied.destOffset,
      slotOf(applied.property, 0x48) + slotOf(applied.property, 0x38) * oracleTag.arrayIndex,
      `${className} tag ${oracleTag.name} placement`);
    const loaded = loadedTagValue(applied);
    if (oracleTag.type === 5 || oracleTag.type === 8) {
      // Object and class references both ship as type 5.
      assert.equal(loaded ? fullName(loaded) : null, oraclePathForRef(oracleTag.value, linker),
        `${className} tag ${oracleTag.name} object reference`);
    } else if (oracleTag.type === 4) {
      assert.ok(Math.abs(loaded - oracleTag.value) < 1e-6 ||
        Object.is(loaded, oracleTag.value), `${className} tag ${oracleTag.name} float`);
    } else if (oracleTag.type === 10) {
      // Struct tags serialize memberwise; the loaded cell is member-keyed.
      // Member values keep the archive's raw dword — decode Float/Int bits by
      // the member's own property kind.
      const structure = slotOf(applied.property, 0x5c);
      const memberFields = [...structFieldChain(structure)];
      const memberNames = memberFields.map(field => nameText(slotOf(field, 0x20)));
      const memberValueEqual = (field, got, expected, label) => {
        const kind = propertyKindOf(field);
        if (kind === 'FloatProperty') {
          f32u32[0] = got >>> 0;
          assert.ok(Math.abs(f32[0] - expected) < 1e-6 || Object.is(f32[0], expected),
            `${label} (bits 0x${(got >>> 0).toString(16)})`);
        } else if (kind === 'IntProperty') {
          assert.equal(got >>> 0, expected >>> 0, label);
        } else {
          assert.equal(got, expected, label);
        }
      };
      if (oracleTag.decoded) {
        if (Array.isArray(oracleTag.value)) {
          for (const [m, expected] of oracleTag.value.entries()) {
            memberValueEqual(memberFields[m], loaded[memberNames[m]], expected,
              `${className} tag ${oracleTag.name} member ${memberNames[m]}`);
          }
        } else if (oracleTag.value && typeof oracleTag.value === 'object') {
          for (const [key, expected] of Object.entries(oracleTag.value)) {
            const memberField = memberFields.find(f => nameText(slotOf(f, 0x20)) === key);
            if (expected && typeof expected === 'object' && Array.isArray(expected)) {
              const member = loaded[key];
              const innerFields = [...structFieldChain(slotOf(memberField, 0x5c))];
              const innerNames = innerFields.map(f => nameText(slotOf(f, 0x20)));
              for (const [m, v] of expected.entries()) {
                memberValueEqual(innerFields[m], member[innerNames[m]], v,
                  `${className} tag ${oracleTag.name}.${key}.${innerNames[m]}`);
              }
            } else {
              memberValueEqual(memberField, loaded[key], expected,
                `${className} tag ${oracleTag.name}.${key}`);
            }
          }
        }
        continue;
      }
      // Undecoded oracle shape: decode the raw tag payload memberwise against
      // the struct's exported member table (same member order SerializeBin
      // walks), then compare each member against the loaded cell.
      const structSegments = fullName(structure).split('.');
      const structLinker = linkers.get(structSegments[0].toLowerCase());
      assert.ok(structLinker,
        `${className} tag ${oracleTag.name}: struct package ${structSegments[0]} is loaded`);
      const structAsset = {pkg: structLinker.pkg, bytes: structLinker.bytes, name: structLinker.packageName};
      const structPath = structSegments.slice(1).join('.');
      const structIndex = structLinker.pkg.exports.findIndex(e => e.path === structPath);
      assert.ok(structIndex >= 0,
        `${className} tag ${oracleTag.name}: ${fullName(structure)} resolves to an export`);
      const members = readStructMetadata(structAsset, structIndex + 1).children;
      const boundary = members.filter(member =>
        member.arrayDim > 1 || SKIPPED_STRUCT_MEMBER_KINDS.has(member.className) ||
        !DECODED_STRUCT_MEMBER_KINDS.has(member.className));
      if (boundary.length > 0) {
        for (const member of boundary) {
          skippedStructValues.push({
            className, tag: oracleTag.name, struct: fullName(structure), member: member.name,
          });
        }
        continue;
      }
      const r = new Reader(oracleTag.data);
      for (const member of members) {
        const memberLoaded = loaded[member.name];
        const label = `${className} tag ${oracleTag.name}[${oracleTag.arrayIndex}] member ${member.name}`;
        switch (member.className) {
          case 'ByteProperty':
            assert.equal(memberLoaded, r.u8(), label);
            break;
          case 'IntProperty':
            // Member cells keep the archive's raw dword; compare as bits.
            assert.equal(memberLoaded >>> 0, r.i32() >>> 0, label);
            break;
          case 'FloatProperty': {
            // Member cells keep the raw IEEE-754 dword (the per-property
            // float coercion only applies to top-level tag destinations).
            f32u32[0] = memberLoaded >>> 0;
            const expected = r.f32();
            assert.ok(Math.abs(f32[0] - expected) < 1e-6 || Object.is(f32[0], expected),
              `${label} (bits 0x${(memberLoaded >>> 0).toString(16)})`);
            break;
          }
          case 'NameProperty':
            assert.equal(nameText(memberLoaded), nameAt(linker.pkg, r.compact()), label);
            break;
          case 'ObjectProperty': case 'ClassProperty': {
            const ref = r.compact();
            assert.equal(memberLoaded ? fullName(memberLoaded) : null,
              oraclePathForRef(ref, linker), label);
            break;
          }
          case 'StrProperty':
            assert.equal(memberLoaded, r.string(linker.pkg.version), label);
            break;
          default:
            throw new Error(`unreachable: filtered member kind ${member.className}`);
        }
      }
      assert.equal(r.offset, oracleTag.data.length,
        `${className} tag ${oracleTag.name} oracle consumed exactly the tag payload`);
    } else {
      assert.deepEqual(loaded, oracleTag.value, `${className} tag ${oracleTag.name}`);
    }
  }

  // The +0x60 chain contains every property the tags wrote to — inherited
  // members reachable through the linked merge.
  const chainNames = new Set();
  {
    let property = slotOf(object, 0x60) ?? null;
    const seen = new Set();
    while (property) {
      assert.ok(!seen.has(addr(property)), `${className} cyclic +0x60 chain`);
      seen.add(addr(property));
      chainNames.add(nameText(slotOf(property, 0x20)));
      property = slotOf(property, 0x4c) ?? null;
    }
  }
  for (const tag of oracleTags) {
    assert.ok(chainNames.has(tag.name),
      `${className} +0x60 chain contains inherited property ${tag.name}`);
  }

  // Link ordering: the class's struct link ran its per-property links in
  // Children order, then built the reference and property chains.
  const structLink = linkOrder.find(entry =>
    sameRecord(entry.object, object) && entry.operations.some(op => op.operation === 'build-property-chains'));
  assert.ok(structLink, `${className} ran the recovered UStruct::Link`);
  const opOrder = structLink.operations.map(op => op.operation);
  const firstLinkProperty = opOrder.indexOf('link-property');
  const refChain = opOrder.indexOf('build-reference-chain');
  const chainIndex = opOrder.indexOf('build-property-chains');
  assert.ok(firstLinkProperty >= 0 && refChain > firstLinkProperty && chainIndex > refChain,
    `${className} link order: per-property link, then reference chains, then the property chains`);
  const linkPropertyOrder = structLink.operations
    .filter(op => op.operation === 'link-property')
    .map(op => nameText(slotOf(op.property, 0x20)));
  const ownPropertyNames = oracleFields
    .filter(field => field.entry.className.endsWith('Property'))
    .map(field => field.entry.name);
  assert.deepEqual(linkPropertyOrder, ownPropertyNames,
    `${className} property link order follows the serialized Children chain`);

  const indexed = oracleTags.filter(tag => tag.arrayIndex > 0).length;
  console.log(`verified ${className}: ${loadedFields.length} children, ` +
    `${oracleTags.length} tags (${indexed} at arrayIndex>0), ${exportEntry.serialSize} serial bytes`);
  return {object, oracle, appliedTags, loadedFields, linkedProperties, oracleFields};
}

// ---------------------------------------------------------------------------
// Run: build the linkers, then Preload the DataVaultImage export
// ---------------------------------------------------------------------------

const coreLinker = buildLinker('Core');
const engineLinker = buildLinker('Engine');
const deusExLinker = buildLinker('DeusEx');

// Verify fills source records, not export objects. No fixture-wide eager
// construction is allowed to mask missing CreateImport/Preload dependencies.
for (const linker of linkers.values()) {
  assert.equal(linker.verified, 1, `${linker.packageName} imports verified`);
  assert.ok(linker.exports.every(record => record.object === null),
    `${linker.packageName} has no constructed export before first use`);
}
assert.equal(loadedObjects.length, 0, 'Verify never adds constructed exports to GObjLoaded');

const dviIndex = deusExLinker.pkg.exports.findIndex(e => e.name === 'DataVaultImage');
assert.ok(dviIndex >= 0, 'DeusEx.u exports DataVaultImage');
const dviExport = exportRecord(deusExLinker.exports, dviIndex);

// DataVaultImage's SuperField reference is an import that must resolve
// through Engine's own ULinkerLoad.
const superImportRef = deusExLinker.pkg.exports.at(dviIndex).superIndex;
assert.ok(superImportRef < 0, 'DataVaultImage Super is an import reference');
const superImport = importAt(deusExLinker.pkg, superImportRef);
assert.equal(superImport.path, 'Engine.Inventory');
const verifiedInventoryImport = deusExLinker.imports[-superImportRef - 1];
assert.equal(verifiedInventoryImport.sourceLinker, engineLinker, 'VerifyImport selects Engine linker');
assert.equal(engineLinker.pkg.exports.at(verifiedInventoryImport.sourceIndex).path, 'Inventory',
  'VerifyImport selects Inventory by class/name/outer hash lookup');
assert.equal(verifiedInventoryImport.object, null, 'Inventory import stays unconstructed until first use');

const deusExAsset = {pkg: deusExLinker.pkg, bytes: deusExLinker.bytes, name: 'DeusEx'};

// ---------------------------------------------------------------------------
// Assertions — DataVaultImage through the shared comparator plus its recorded
// INVENTORY_CONSTRUCTION layout checks, then the curated set.
// ---------------------------------------------------------------------------

const {
  object: dviObject,
  linkedProperties: dviLinkedProperties,
  oracleFields: dviOracleFields,
} = verifyClassExport('DataVaultImage');
assert.equal(dviExport.object, dviObject);
assert.equal(slotOf(dviObject, 0x10), deusExLinker, 'DataVaultImage carries the DeusEx linker');
assert.equal(slotOf(dviObject, 0x14), dviIndex, 'DataVaultImage LinkerIndex is its export index');

// The import path materialized Engine.Inventory through Engine's own linker
// and aliased the registered AInventory class object (0x10576f70).
const inventoryRecord = indexToObject(deusExLinker, superImportRef);
const engineInventoryExportIndex = engineLinker.pkg.exports.findIndex(e => e.path === 'Inventory');
assert.ok(engineInventoryExportIndex >= 0);
assert.equal(inventoryRecord, exportObject(engineLinker.exports, engineInventoryExportIndex),
  'the import resolves through Engine\'s own ULinkerLoad');
assert.equal(addr(inventoryRecord), ENGINE_CLASSES.Inventory.staticClass,
  'the Engine.Inventory export aliases the registered class object');
assert.notEqual(addr(dviObject), ENGINE_CLASSES.Inventory.staticClass,
  'DataVaultImage is not the Inventory static — the import was a real lookup');

// UClass::Bind: DataVaultImage (scripted-only, no DeusEx.dll registration)
// inherits the Engine AInventory InternalConstructor through its super.
assert.equal(dviObject.nativeConstructor, ENGINE_CLASSES.Inventory.internalCtor,
  'DataVaultImage inherits AInventory InternalConstructor through UClass::Bind');
assert.equal(slotOf(dviObject, 0x28), inventoryRecord, 'DataVaultImage SuperField is the resolved import');

// The recorded field table (name/kind/arrayDim/elementSize) must match after link.
assert.deepEqual(dviLinkedProperties.map(field => nameText(slotOf(field, 0x20))),
  dataVaultImage.fields.map(field => field.name), 'DataVaultImage property order');
assert.deepEqual(dviLinkedProperties.map(field => propertyKindOf(field)),
  dataVaultImage.fields.map(field => field.kind), 'DataVaultImage property classes');
for (const [i, field] of dviLinkedProperties.entries()) {
  const expected = dataVaultImage.fields[i];
  const oracleRef = dviOracleFields.find(f => f.entry.name === expected.name)?.ref;
  assert.ok(oracleRef, `oracle has property ${expected.name}`);
  const oracleProp = readPropertyMetadata(deusExAsset, oracleRef);
  assert.equal(slotOf(field, 0x34), oracleProp.arrayDim, `${expected.name} serialized ArrayDim`);
  assert.equal(slotOf(field, 0x34), expected.arrayDim, `${expected.name} recorded ArrayDim`);
  assert.equal(slotOf(field, 0x38), expected.elementSize, `${expected.name} linked ElementSize`);
  assert.equal(slotOf(field, 0x3c), oracleProp.propertyFlags, `${expected.name} serialized PropertyFlags`);
  assert.ok(Number.isInteger(slotOf(field, 0x48)), `${expected.name} received a linked Offset`);
}
assert.equal(slotOf(dviObject, 0x3c), layout.dataVaultImagePropertiesSize,
  'linked PropertiesSize matches the recorded class layout');

// PlayerPawn correction: the Engine registration exists (0x1058c160 /
// 0x10301ff0) — if the closure constructed it, Bind must have landed the
// real constructor rather than the missing-record fallback.
const playerPawnExportIndex = engineLinker.pkg.exports.findIndex(e => e.path === 'PlayerPawn');
if (playerPawnExportIndex >= 0 && exportObject(engineLinker.exports, playerPawnExportIndex)) {
  const pp = exportObject(engineLinker.exports, playerPawnExportIndex);
  assert.equal(pp.nativeConstructor, ENGINE_CLASSES.PlayerPawn.internalCtor,
    'PlayerPawn binds its registered Engine constructor');
}

// The curated set — DeusExWeapon ahead of its subclass WeaponAssaultGun, so
// the superclass preload lands inside the parent's own run.
for (const className of [
  'DeusExWeapon', 'WeaponAssaultGun', 'DeusExPlayer', 'Gray', 'Rocket',
  'MenuScreenCustomizeKeys',
]) {
  verifyClassExport(className);
}

// No tag anywhere in the closure took a native warn-and-skip path.
const tagSkips = events.filter(event => [
  'TagUnmatched', 'TagTypeMismatch', 'TagArrayIndex', 'TagStructMismatch', 'TagNotSerializable',
].includes(event.op));
assert.equal(tagSkips.length, 0, `no tag warn-and-skip events: ${JSON.stringify(
  tagSkips.slice(0, 5).map(event => ({op: event.op, tag: event.tag?.text})))}`);

// Closure accounting — report the measured closure; every serialize ran a
// recovered body, every construct went through CreateExport.
const serializedCount = events.filter(event => event.op === 'PreloadSerializeEnter').length;
const constructedCount = events.filter(event => event.op === 'ConstructObject').length;
const reinitCount = events.filter(event => event.op === 'ConstructReinit').length;
const classExportCount = events.filter(event =>
  event.op === 'ConstructObject' && sameRecord(classRecordOf(event.object), classStatic)).length +
  reinitCount;
console.log(`preload closure: ${serializedCount} serialized, ${constructedCount} constructed ` +
  `(${reinitCount} static re-inits), ${classExportCount} class exports`);
assert.ok(serializedCount > 0 && constructedCount > 0, 'closure produced objects');
assert.equal(assertions.length, 0, `no native assert fired: ${JSON.stringify(assertions.slice(0, 3))}`);
const realWarnings = warnings.filter(w => !['name-reference', 'exists'].includes(w.kind));
assert.equal(realWarnings.length, 0, `no warnings: ${JSON.stringify(realWarnings.slice(0, 5))}`);

// Shipped-shape census over every serialized DeusEx.u class export: which
// tag types and array-index encodings the GOTY package actually contains.
{
  let classCount = 0;
  let tagCount = 0;
  let indexedClasses = 0;
  let maxArrayIndex = 0;
  let maxArrayIndexClass = null;
  const typeCounts = new Map();
  for (const [i, entry] of deusExLinker.pkg.exports.entries()) {
    if (entry.className !== 'Class' || !entry.serialSize) continue;
    const cls = readClass(deusExAsset, i + 1);
    classCount += 1;
    let indexed = false;
    for (const tag of cls.properties) {
      tagCount += 1;
      typeCounts.set(tag.type, (typeCounts.get(tag.type) ?? 0) + 1);
      assert.notEqual(tag.type, 9, `${entry.path} ships an ArrayProperty tag`);
      assert.notEqual(tag.type, 8, `${entry.path} ships a type-8 tag`);
      assert.ok(tag.arrayIndex < 128,
        `${entry.path}.${tag.name} ships a multi-byte array index`);
      if (tag.arrayIndex > 0) indexed = true;
      if (tag.arrayIndex > maxArrayIndex) {
        maxArrayIndex = tag.arrayIndex;
        maxArrayIndexClass = entry.name;
      }
    }
    if (indexed) indexedClasses += 1;
  }
  const typeSummary = Object.fromEntries([...typeCounts.entries()].sort((a, b) => a[0] - b[0]));
  console.log(`shipped defaults: ${classCount} classes, ${tagCount} tags, ` +
    `types ${JSON.stringify(typeSummary)}, max arrayIndex ${maxArrayIndex} ` +
    `(${maxArrayIndexClass}), ${indexedClasses} classes with arrayIndex>0`);
  assert.equal(classCount, 1158, 'DeusEx.u serialized class count');
  assert.equal(tagCount, 13865, 'DeusEx.u shipped default-tag count');
  assert.deepEqual(typeSummary,
    {1: 523, 2: 1375, 3: 1075, 4: 2895, 5: 4192, 6: 91, 10: 1483, 13: 2231},
    'DeusEx.u shipped tag-type totals');
  assert.equal(indexedClasses, 464, 'classes with an arrayIndex>0 tag');
  assert.equal(maxArrayIndex, 70, 'largest shipped array index');
  assert.equal(maxArrayIndexClass, 'MenuScreenCustomizeKeys', 'largest shipped array index class');
}

// Every struct default in the set was value-compared; a nonempty list means a
// set member carries a member shape this comparator does not decode.
assert.equal(skippedStructValues.length, 0,
  `struct payloads skipped by the comparator: ${JSON.stringify(skippedStructValues)}`);

console.log('validate-linker-preload: 7 classes preload/link/defaults verified against the decoded package');
