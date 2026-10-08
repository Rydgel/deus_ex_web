/** The native config class tables (src/runtime/script-native-config.mjs) against the
 * StaticConstructors they were read from: tools/native-class-properties.py scans each constructor in
 * the hash-pinned DLLs (Engine, WinDrv, Galaxy) for the
 * `new(GetClass(), TEXT("Name"), RF_Public) UXProperty(CPP_PROPERTY(Member), TEXT("Category"), Flags)`
 * sequence, and every property's name, type, member offset, flags (CPF_Config 0x4000), category and
 * registration order must equal the table. The Galaxy `OutputRates` and Client `Details` enum names
 * are compared with the FNames the constructors create. Needs NATIVE_PROBE_PYTHON (capstone). */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {NATIVE_CONFIG_CLASSES, OUTPUT_RATES} from '../src/runtime/script-native-config.mjs';
import {CLIENT_DETAILS} from '../src/runtime/script-client-resource-settings.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? process.env.DEUS_EX_NATIVE_PYTHON;
if (!python) { console.log('SKIP validate-native-config-classes: set NATIVE_PROBE_PYTHON'); process.exit(0); }
const KINDS = {UBoolProperty: 'bool', UIntProperty: 'int', UFloatProperty: 'float', UByteProperty: 'byte', UStrProperty: 'string'};
const scan = (cls, ...flags) => execFileSync(python, ['tools/native-class-properties.py', cls.ctor.dll,
  `0x${cls.ctor.start.toString(16)}-0x${(cls.ctor.start + 0x2000).toString(16)}`, ...flags], {encoding: 'utf8', maxBuffer: 1 << 24});

let properties = 0;
for (const cls of NATIVE_CONFIG_CLASSES) {
  if (!cls.ctor) { assert.equal(cls.properties.length, 0, `${cls.path} declares no table without a constructor`); continue; }
  const found = JSON.parse(scan(cls, '--json'));
  assert.deepEqual(found.map(record => ({name: record.name, kind: KINDS[record.class], offset: record.offset, flags: record.flags, category: record.category})),
    cls.properties.map(property => ({name: property.name, kind: property.kind, offset: property.offset, flags: 0x4000, category: property.category})),
    `${cls.path} properties`);
  properties += found.length;
  // Bool properties carry their bit mask in +0x5c (all 1: one BITFIELD bit each).
  for (const record of found) if (record.class === 'UBoolProperty') assert.equal(record.word5c, 1, `${cls.path}.${record.name} bit mask`);
}
// Enum names: the FNames created before the first property (the enum's own name, then its entries).
const names = ctor => scan({ctor}, '--names').trim().split('\n').map(line => line.slice(11));
const galaxy = NATIVE_CONFIG_CLASSES.find(cls => cls.path === 'Galaxy.GalaxyAudioSubsystem');
const galaxyNames = names(galaxy.ctor);
assert.deepEqual(galaxyNames.slice(0, 1 + OUTPUT_RATES.length), ['OutputRates', ...OUTPUT_RATES], 'Galaxy OutputRates enum');
assert.equal(galaxyNames[1 + OUTPUT_RATES.length], 'UseDirectSound', 'the first property follows the enum');
const client = NATIVE_CONFIG_CLASSES.find(cls => cls.path === 'Engine.Client');
assert.deepEqual(names(client.ctor).slice(0, 1 + CLIENT_DETAILS.length), ['Details', ...CLIENT_DETAILS], 'Client Details enum');
console.log(`native-config-classes: ${properties} properties of ${NATIVE_CONFIG_CLASSES.filter(cls => cls.ctor).length} classes match their StaticConstructors; both enums match`);
