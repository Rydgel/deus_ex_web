import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTravelText, formatTravelText, normalizeTravelText, firstTravelTextDifference, parsePropertyLine, parseObjectValue,
  travelTextOfDump, TravelTextError } from '../src/runtime/travel-text.mjs';

// The head of the measured menu-Training text (docs/travel.md; .work/travel/s2/s5-training-menu.travel.txt), shortened.
const MEASURED = `Class=DeusEx.JCDentonMale Name=JCDentonMale7 Ptr=02e50e00
{
SkillSystem=15ee2800 SkillManager21
KeyRing=0fc9af00 NanoKeyRing31
FlagBase=03e04c40 FlagBase22
Inventory=0fc9af00 NanoKeyRing31
}
Class=DeusEx.NanoKeyRing Name=NanoKeyRing31 Ptr=0fc9af00
{
bInObjectBelt=True
beltPos=0
}
Class=Extension.FlagBase Name=FlagBase22 Ptr=03e04c40
{
hashTable[11]=0f8d9d30 FlagBool36
}
Class=Extension.FlagBool Name=FlagBool36 Ptr=0f8d9d30
{
bValue=True
FlagName=PlayerTraveling
flagHash=908074891
FlagBase=03e04c40 FlagBase22
}
`;
// The same state in another session: other addresses, other instance numbers, CRLF line ends.
const OTHER = `Class=DeusEx.JCDentonMale Name=JCDentonMale0 Ptr=00001000
{
SkillSystem=00002000 SkillManager3
KeyRing=00003000 NanoKeyRing4
FlagBase=00004000 FlagBase0
Inventory=00003000 NanoKeyRing4
}
Class=DeusEx.NanoKeyRing Name=NanoKeyRing4 Ptr=00003000
{
bInObjectBelt=True
beltPos=0
}
Class=Extension.FlagBase Name=FlagBase0 Ptr=00004000
{
hashTable[11]=00005000 FlagBool1
}
Class=Extension.FlagBool Name=FlagBool1 Ptr=00005000
{
bValue=True
FlagName=PlayerTraveling
flagHash=908074891
FlagBase=00004000 FlagBase0
}
`.replace(/\n/g, '\r\n');

test('a text parses into records and formats back with CRLF line ends', () => {
  const records = parseTravelText(MEASURED);
  assert.deepEqual(records.map(r => r.name), ['JCDentonMale7', 'NanoKeyRing31', 'FlagBase22', 'FlagBool36']);
  assert.equal(records[0].ptr, '02e50e00');
  assert.deepEqual(records[1].lines, ['bInObjectBelt=True', 'beltPos=0']);
  assert.equal(formatTravelText(records), MEASURED.replace(/\n/g, '\r\n'));
});

test('the normalizer maps pointers by first appearance and strips instance numbers', () => {
  const text = normalizeTravelText(MEASURED);
  assert.match(text, /^Class=DeusEx\.JCDentonMale Name=JCDentonMale# Ptr=@0$/m);
  assert.match(text, /^SkillSystem=@1 SkillManager#$/m);
  assert.match(text, /^hashTable\[11\]=@4 FlagBool#$/m);
  // the values that are not pointers are left alone
  assert.match(text, /^flagHash=908074891$/m);
  assert.match(text, /^FlagName=PlayerTraveling$/m);
});

test('two sessions of the same state normalize equal; a changed value or order is found', () => {
  assert.equal(firstTravelTextDifference(MEASURED, OTHER), null);
  const changed = OTHER.replace('beltPos=0', 'beltPos=1');
  assert.deepEqual(firstTravelTextDifference(MEASURED, changed), { line: 11, expected: 'beltPos=0', actual: 'beltPos=1' });
  const moved = parseTravelText(OTHER);
  [moved[1], moved[2]] = [moved[2], moved[1]];
  assert.ok(firstTravelTextDifference(MEASURED, moved));
});

test('property lines and object values follow the importer grammar', () => {
  assert.deepEqual(parsePropertyLine('hashTable[11]=0f8d9d30 FlagBool36'), { name: 'hashTable', index: 11, indexed: true, value: '0f8d9d30 FlagBool36' });
  assert.deepEqual(parsePropertyLine('  Health=75'), { name: 'Health', index: 0, indexed: false, value: '75' });
  assert.deepEqual(parseObjectValue('0f8d9d30 FlagBool36'), { ptr: '0f8d9d30', name: 'FlagBool36' });
  assert.deepEqual(parseObjectValue('None'), { ptr: null, name: null });
  assert.equal(parseObjectValue('True'), null);
});

test('malformed texts are refused by name', () => {
  assert.throws(() => parseTravelText('garbage'), TravelTextError);
  assert.throws(() => parseTravelText('Class=A.B Name=B0 Ptr=00000001\n{\nx=1\n'), /not closed/);
});

test('the frame-time values compare by presence when asked', () => {
  // The original's New Game text at the Island carries `saveTime=0.006523` (its own tick delta); Play's fixed step writes another number.
  const a = 'Class=DeusEx.JCDentonMale Name=JCDentonMale1 Ptr=00000001\n{\nsaveTime=0.006523\nLastConEndTime=413.335846\nHealth=75\n}\n';
  const b = a.replace('0.006523', '0.016667').replace('413.335846', '133.283340');
  assert.deepEqual(firstTravelTextDifference(a, b), { line: 3, expected: 'saveTime=0.006523', actual: 'saveTime=0.016667' });
  assert.equal(firstTravelTextDifference(a, b, { times: true }), null);
  assert.match(normalizeTravelText(a, { times: true }), /saveTime=<time>\nLastConEndTime=<time>\nHealth=75/);
  // absence is a difference (a default of 0 is not written): the value is masked, the property is not
  const absent = a.replace('saveTime=0.006523\n', '');
  assert.equal(firstTravelTextDifference(a, absent, { times: true }).line, 3);
  // other floats are never masked
  assert.ok(firstTravelTextDifference(a, a.replace('Health=75', 'Health=76'), { times: true }));
});

test('the value of a measured dump is extracted', () => {
  const dump = ['Level MyLevel slot 1 at 0x1', '  URL.Map: entry.dx', '  TravelInfo: 0 pairs', 'Level MyLevel slot 2 at 0x2', '  URL.Map: 00_Training',
    '  TravelInfo: 1 pairs, hash 0x1 count 8', '  [0] key: Player', '  [0] value:', ...MEASURED.trimEnd().split('\n'), '  [0] end', ''].join('\n');
  const { map, key, text } = travelTextOfDump(dump);
  assert.equal(map, '00_Training');
  assert.equal(key, 'Player');
  assert.equal(firstTravelTextDifference(MEASURED, text), null);
});
