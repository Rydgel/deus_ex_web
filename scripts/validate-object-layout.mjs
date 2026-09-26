#!/usr/bin/env node
/**
 * Stage 1c of docs/object-memory.md: the linked property table of every class
 * in the installed packages, checked four ways.
 *
 * 1. Placement replay. The documented property Link bodies and UStruct::Link
 *    (docs/script-struct-link.md, script-scalar/bool/complex-property-link.md)
 *    are replayed independently over each class's and struct's direct
 *    children and must give the linker's Offset, ElementSize, BitMask and
 *    PropertiesSize exactly.
 * 2. Struct members. The load graph's struct offsets must equal the recovered
 *    struct Link that script-struct-layout.mjs runs over package metadata.
 * 3. Retail offsets. Members whose native offset is recovered from retail
 *    instructions (cited per row) must sit at that linked offset, so script
 *    access and native access touch the same bytes.
 * 4. Native Extension windows. Their C++ layout (script-window-native-layout.mjs)
 *    must reproduce every retail-recovered window offset; where it differs
 *    from the linked layout, script and native access touch different bytes
 *    in the original too. The differing members are asserted as a set.
 *
 * With .cache/sdk-layouts.json present (scripts/sdk-layouts.mjs), the SDK
 * 1112f C++ headers are compared as a research reference and summarized.
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {linkedClassLayout, linkedStructLayout} from '../src/runtime/script-object-layout.mjs';
import {nativeWindowLayout, NATIVE_WINDOW_CLASS_SIZES, RECOVERED_WINDOW_OFFSETS} from '../src/runtime/script-window-native-layout.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['System', 'Maps', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files);
const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
const loader = runtime.classLoader, graph = loader.graph, {slotOf, propertyKindOf} = graph;
const identity = record => loader.identity(record);

// Every class of the installed script packages. Engine.Engine stops at an
// existing config boundary (ImportText for its ClassProperty render devices).
const PACKAGES = ['Core', 'Engine', 'Extension', 'ConSys', 'DeusEx', 'DeusExText',
  'IpDrv', 'IpServer', 'UBrowser', 'Fire', 'UWindow'];
const KNOWN_LINK_FAILURES = new Map([
  ['engine.engine', 'Config ImportText is not linked for ClassProperty properties'],
]);
const classes = [], linkFailures = [];
for (const name of PACKAGES) {
  const pkg = await assets.get(name);
  for (const [index, entry] of pkg.pkg.exports.entries()) {
    if (entry.className !== 'Class') continue;
    try { classes.push(await runtime.loadClass(pkg, index + 1)); }
    catch (error) { linkFailures.push([`${name}.${entry.path}`.toLowerCase(), String(error.message)]); }
  }
}
assert.deepEqual(linkFailures.map(([key]) => key).sort(), [...KNOWN_LINK_FAILURES.keys()].sort(), 'linked class set');
for (const [key, message] of linkFailures) assert.ok(message.includes(KNOWN_LINK_FAILURES.get(key)), `${key}: ${message}`);
const layouts = new Map(classes.map(cls => [cls, linkedClassLayout(cls, {graph, identity})]));
const byKey = new Map(classes.map(cls => [cls.record.key, cls]));
const entryOf = (classKey, name) => {
  const cls = byKey.get(classKey);
  assert.ok(cls, `class ${classKey} is linked`);
  const entry = layouts.get(cls).properties.find(item => item.name.toLowerCase() === name.toLowerCase());
  assert.ok(entry, `${classKey}.${name} is a linked property`);
  return entry;
};

// UObject's native header: the SDK record and the offsets InitProperties
// preserves (docs/object-memory.md); InitProperties starts at +0x28.
const object = layouts.get(byKey.get('core.object'));
assert.equal(object.size, 0x28, 'Core.Object PropertiesSize');
assert.deepEqual(object.properties.map(entry => [entry.name, entry.offset, entry.elementSize, entry.arrayDim]),
  [['ObjectInternal', 0x0, 4, 6], ['Outer', 0x18, 4, 1], ['ObjectFlags', 0x1c, 4, 1], ['Name', 0x20, 4, 1],
    ['Class', 0x24, 4, 1]].sort((a, b) => object.properties.findIndex(entry => entry.name === a[0]) -
      object.properties.findIndex(entry => entry.name === b[0])), 'UObject header properties');

// 1. Placement replay of the documented Link bodies.
const align = (value, to) => (value + to - 1) & ~(to - 1);
function replayChildren(owner, start, label) {
  let size = start, previous = null, checked = 0;
  for (let child = slotOf(owner, 0x38); child; child = slotOf(child, 0x2c)) {
    if (slotOf(child, 0x18) !== owner) break;
    const kind = propertyKindOf(child);
    if (!kind?.endsWith('Property')) continue;
    const dim = slotOf(child, 0x34);
    let offset, elementSize, mask = null;
    switch (kind) {
      case 'ByteProperty': elementSize = 1; offset = size; break;
      case 'IntProperty': case 'FloatProperty': case 'NameProperty':
      case 'ObjectProperty': case 'ClassProperty': elementSize = 4; offset = align(size, 4); break;
      case 'BoolProperty': {
        // UBoolProperty::Link: MergeBools is 1 for UField/UStruct/UState/UClass.
        const shared = previous && propertyKindOf(previous) === 'BoolProperty' &&
          ((slotOf(previous, 0x5c) & 0x7fffffff) !== 0);
        mask = shared ? (slotOf(previous, 0x5c) << 1) >>> 0 : 1;
        offset = shared ? slotOf(previous, 0x48) : align(size, 4);
        elementSize = 4;
        break;
      }
      case 'StrProperty': case 'ArrayProperty': elementSize = 12; offset = align(size, 4); break;
      case 'MapProperty': elementSize = 0x14; offset = align(size, 4); break;
      case 'StructProperty': {
        elementSize = slotOf(slotOf(child, 0x5c), 0x3c);
        offset = align(size, elementSize === 2 ? 2 : elementSize < 4 ? 1 : 4);
        break;
      }
      default: throw new Error(`${label}: no documented Link body for ${kind}`);
    }
    const name = `${label}.${graph.nameText(slotOf(child, 0x20))}`;
    assert.equal(slotOf(child, 0x48), offset, `${name} Offset`);
    assert.equal(slotOf(child, 0x38), elementSize, `${name} ElementSize`);
    if (mask !== null) assert.equal(slotOf(child, 0x5c) >>> 0, mask, `${name} BitMask`);
    size = offset + elementSize * dim;
    previous = child; checked++;
  }
  assert.equal(slotOf(owner, 0x3c), align(size, 4), `${label} PropertiesSize`);
  return checked;
}
let replayed = 0;
const structs = new Set();
for (const cls of classes) {
  const superRecord = graph.superOf(cls.loadRecord);
  replayed += replayChildren(cls.loadRecord, superRecord ? align(slotOf(superRecord, 0x3c), 4) : 0, cls.record.key);
  for (const entry of layouts.get(cls).properties) {
    // Inherited entries are the superclass's own records.
    assert.ok(entry.offset + entry.elementSize * entry.arrayDim <= layouts.get(cls).size, `${entry.key} within ${cls.record.key}`);
    if (entry.type === 'struct') for (let s = slotOf(entry.field.loadRecord, 0x5c); s; s = graph.superOf(s)) structs.add(s);
  }
}
for (const structure of structs) {
  const superStruct = graph.superOf(structure);
  replayed += replayChildren(structure, superStruct ? align(slotOf(superStruct, 0x3c), 4) : 0, graph.fullName(structure));
}

// 2. Load-graph struct members against the recovered struct Link layout.
let structMembers = 0;
for (const cls of classes) for (const entry of layouts.get(cls).properties) {
  if (entry.type !== 'struct') continue;
  const recovered = entry.field.metadata.structLayout;
  assert.equal(recovered.propertiesSize, entry.struct.size, `${entry.key} struct size`);
  assert.equal(entry.elementSize, entry.struct.size, `${entry.key} ElementSize is the struct size`);
  for (const member of entry.struct.members) {
    let node = null;
    for (let layout = recovered; layout && !node; layout = layout.nativeSlots.get(0x28)?.value) node = layout.fields.get(member.key);
    assert.ok(node, `${member.key} in recovered layout`);
    assert.equal(node.offset, member.offset, `${member.key} offset`);
    assert.equal(node.elementSize, member.elementSize, `${member.key} ElementSize`);
    if (member.mask !== null) assert.equal(node.bitMask >>> 0, member.mask, `${member.key} BitMask`);
    structMembers++;
  }
  assert.deepEqual(entry.struct.members.map(member => member.key).sort(),
    entry.field.metadata.structFields.map(member => member.key).sort(), `${entry.key} struct members`);
}

// 3. Members whose native offset is recovered from retail instructions.
//    [class, property, offset, bit mask or null, where the instruction is recorded]
const RETAIL = [
  ['core.object', 'Outer', 0x18, null, 'UProperty ctor 0x10164fe9 (script-native-property-offsets.md)'],
  ['core.object', 'ObjectFlags', 0x1c, null, 'CreateExport (script-create-export.md)'],
  ['core.object', 'Name', 0x20, null, 'script-state-link.md'],
  ['core.object', 'Class', 0x24, null, 'script-linker-preload.mjs'],
  ['engine.actor', 'bDeleteMe', 0x28, 0x80, 'actor-physics.md'],
  ['engine.actor', 'bMovable', 0x28, 0x80000, 'actor-physics.md'],
  ['engine.actor', 'bIsPawn', 0x28, 0x800000, 'actor-physics.md'],
  ['engine.actor', 'Physics', 0x30, null, 'actor-physics.md'],
  ['engine.actor', 'Role', 0x31, null, 'script-spawn.md'],
  ['engine.actor', 'LastRenderTime', 0x34, null, 'script-runtime.mjs PlayerCanSeeMe'],
  ['engine.actor', 'AnimSequence', 0x54, null, 'script-play-anim.md'],
  ['engine.actor', 'AnimFrame', 0x58, null, 'script-play-anim.md'],
  ['engine.actor', 'AnimRate', 0x5c, null, 'script-play-anim.md'],
  ['engine.actor', 'TweenRate', 0x60, null, 'script-play-anim.md'],
  ['engine.actor', 'Level', 0xa8, null, 'script-runtime.mjs'],
  ['engine.actor', 'XLevel', 0xac, null, 'script-trigger-actions.md'],
  ['engine.actor', 'Instigator', 0xbc, null, 'MakeNoise (script-noise.mjs)'],
  ['engine.actor', 'Base', 0xc4, null, 'script-iterators.mjs BasedActors'],
  ['engine.actor', 'Region', 0xc8, null, 'SetActorZone 0x1039b940 (zone.md)'],
  ['engine.actor', 'StandingCount', 0xd8, null, 'actor-physics.md'],
  ['engine.actor', 'Location', 0x114, null, 'actor-physics.md'],
  ['engine.actor', 'Rotation', 0x120, null, 'actor-physics.md'],
  ['engine.actor', 'OldLocation', 0x12c, null, 'FarMoveActor (map-actor-native.mjs)'],
  ['engine.actor', 'Velocity', 0x144, null, 'animation tick 0x103a1c98 (script-anim.mjs)'],
  ['engine.actor', 'Acceleration', 0x150, null, 'actor-physics.md'],
  ['engine.actor', 'Texture', 0x16c, null, 'script-decal-startup.md'],
  ['engine.actor', 'Mesh', 0x174, null, 'execPlayAnim (script-get-anim-group.md)'],
  ['engine.actor', 'Brush', 0x178, null, 'actor-physics.md'],
  ['engine.actor', 'CollisionRadius', 0x1d4, null, 'script-actor-queries.md'],
  ['engine.actor', 'bCollideActors', 0x1dc, 0x1, 'collision hash (map-actor-native.mjs)'],
  ['engine.actor', 'bCollideWorld', 0x1dc, 0x2, 'collision hash (map-actor-native.mjs)'],
  ['engine.actor', 'bBlockActors', 0x1dc, 0x4, 'collision hash (map-actor-native.mjs)'],
  ['engine.actor', 'bBlockPlayers', 0x1dc, 0x8, 'collision hash (map-actor-native.mjs)'],
  ['engine.actor', 'bProjTarget', 0x1dc, 0x10, 'collision hash (map-actor-native.mjs)'],
  ['engine.actor', 'LightType', 0x1e0, null, 'script-light-invalidation.md'],
  ['engine.actor', 'LightBrightness', 0x1e2, null, 'script-light-cache.md'],
  ['engine.actor', 'LightHue', 0x1e3, null, 'script-light-cache.md'],
  ['engine.actor', 'LightSaturation', 0x1e4, null, 'script-light-cache.md'],
  ['engine.actor', 'LightRadius', 0x1e5, null, 'script-light-invalidation.md'],
  ['engine.actor', 'VolumeRadius', 0x1ea, null, 'script-light-invalidation.md'],
  ['engine.actor', 'bBounce', 0x1ec, 0x10, 'actor-physics.md'],
  ['engine.actor', 'bFixedRotationDir', 0x1ec, 0x20, 'actor-physics.md'],
  ['engine.actor', 'bRotateToDesired', 0x1ec, 0x40, 'actor-physics.md'],
  ['engine.actor', 'bJustTeleported', 0x1ec, 0x100, 'FarMoveActor (actor-physics.md)'],
  ['engine.actor', 'Mass', 0x1f4, null, 'actor-physics.md'],
  ['engine.actor', 'Buoyancy', 0x1f8, null, 'actor-physics.md'],
  ['engine.actor', 'RotationRate', 0x1fc, null, 'actor-physics.md'],
  ['engine.actor', 'DesiredRotation', 0x208, null, 'actor-physics.md'],
  ['engine.actor', 'PendingTouch', 0x21c, null, 'actor-physics.md'],
  ['engine.actor', 'AnimLast', 0x220, null, 'script-play-anim.md'],
  ['engine.actor', 'AnimMinRate', 0x224, null, 'animation tick 0x103a1cd2 (script-anim.mjs)'],
  ['engine.actor', 'OldAnimRate', 0x228, null, 'script-anim.mjs'],
  ['engine.actor', 'SimAnim', 0x22c, null, 'script-anim.mjs'],
  ['engine.actor', 'BindName', 0x2ac, null, 'script-conversation-action-bind.md'],
  ['engine.actor', 'BarkBindName', 0x2b8, null, 'script-conversation-action-bind.md'],
  ['engine.actor', 'ConListItems', 0x2dc, null, 'stage-3-handoff.md'],
  ['engine.pawn', 'bBehindView', 0x318, 0x1, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'bIsPlayer', 0x318, 0x2, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'bLOSflag', 0x318, 0x80000, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'bHunting', 0x318, 0x200000, 'script-pawn-nav.md'],
  ['engine.pawn', 'AvgPhysicsTime', 0x32c, null, 'performPhysics (script-pawn-physics.mjs)'],
  ['engine.pawn', 'FootRegion', 0x330, null, 'SetActorZone 0x1039b940 (zone.md)'],
  ['engine.pawn', 'HeadRegion', 0x33c, null, 'SetActorZone 0x1039b940 (zone.md)'],
  ['engine.pawn', 'MoveTimer', 0x348, null, 'performPhysics (script-pawn-physics.mjs)'],
  ['engine.pawn', 'MoveTarget', 0x34c, null, 'script-pawn-nav.mjs'],
  ['engine.pawn', 'Visibility', 0x398, null, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'Stimulus', 0x3a0, null, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'SightRadius', 0x3a4, null, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'PeripheralVision', 0x3a8, null, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'LastSeenPos', 0x3b0, null, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'LastSeeingPos', 0x3bc, null, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'Enemy', 0x3cc, null, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'ViewRotation', 0x3dc, null, 'script-window-sound.md'],
  ['engine.pawn', 'BaseEyeHeight', 0x3f4, null, 'perception (script-pawn-perception.mjs)'],
  ['engine.pawn', 'EyeHeight', 0x3f8, null, 'SetActorZone (linked-property check, zone.md)'],
  ['engine.pawn', 'SpecialGoal', 0x45c, null, 'script-pawn-nav.mjs'],
  ['engine.pawn', 'nextPawn', 0x498, null, 'script-pawn-perception.md'],
  ['engine.playerpawn', 'Player', 0x5d4, null, 'execResetKeyboard 0x103b96d0'],
  ['engine.playerpawn', 'ShowFlags', 0x5fc, null, 'script-player-login.md'],
  ['engine.playerpawn', 'RendMap', 0x600, null, 'script-player-login.md'],
  ['engine.playerpawn', 'ViewTarget', 0x60c, null, 'script-weapon-rendering.md'],
  ['engine.levelinfo', 'TimeSeconds', 0x478, null, 'script-loadmap-startup.md'],
  ['engine.levelinfo', 'NetMode', 0x518, null, 'script-spawn.md'],
  ['engine.levelinfo', 'NavigationPointList', 0x548, null, 'script-pawn-nav.mjs'],
  ['engine.levelinfo', 'PawnList', 0x54c, null, 'script-move-noise.md'],
  ['engine.zoneinfo', 'ZoneGravity', 0x31c, null, 'rolling.md'],
  ['engine.zoneinfo', 'ZoneVelocity', 0x328, null, 'rolling.md'],
  ['engine.zoneinfo', 'ZoneGroundFriction', 0x334, null, 'rolling.md'],
  ['engine.zoneinfo', 'ZoneTerminalVelocity', 0x33c, null, 'rolling.md'],
  ['engine.zoneinfo', 'bWaterZone', 0x388, 0x1, 'actor-physics.md'],
  ['engine.zoneinfo', 'bBounceVelocity', 0x388, 0x200, 'actor-physics.md'],
  ['engine.navigationpoint', 'upstreamPaths', 0x320, null, 'script-pawn-nav.mjs'],
  ['engine.navigationpoint', 'Paths', 0x360, null, 'script-pawn-nav.mjs'],
  ['engine.navigationpoint', 'PrunedPaths', 0x3a0, null, 'script-pawn-nav.mjs'],
  ['engine.navigationpoint', 'visitedWeight', 0x420, null, 'script-pawn-nav.mjs'],
  ['engine.navigationpoint', 'bestPathWeight', 0x428, null, 'script-pawn-nav.mjs'],
  ['engine.navigationpoint', 'nextNavigationPoint', 0x42c, null, 'script-pawn-nav.mjs'],
  ['engine.navigationpoint', 'nextOrdered', 0x430, null, 'script-pawn-nav.md'],
  ['engine.navigationpoint', 'prevOrdered', 0x434, null, 'script-pawn-nav.md'],
  ['engine.navigationpoint', 'startPath', 0x438, null, 'script-pawn-nav.mjs'],
  ['engine.navigationpoint', 'previousPath', 0x43c, null, 'script-pawn-nav.mjs'],
  ['engine.navigationpoint', 'cost', 0x440, null, 'script-pawn-nav.mjs'],
  ['engine.navigationpoint', 'ExtraCost', 0x444, null, 'script-pawn-nav.mjs'],
  ['engine.brush', 'MainScale', 0x32c, null, 'fitting.md'],
  ['engine.brush', 'PostScale', 0x340, null, 'fitting.md'],
  ['engine.decal', 'MultiDecalLevel', 0x318, null, 'script-decal-startup.md'],
  ['engine.decal', 'LastRenderedTime', 0x31c, null, 'script-decal-startup.md'],
  ['engine.playerreplicationinfo', 'Team', 0x340, null, 'script-pawn-perception.md'],
  ['engine.player', 'Actor', 0x30, null, 'script-player-login.md'],
  ['engine.player', 'Console', 0x34, null, 'script-console-command.mjs'],
  ['engine.console', 'Viewport', 0x2c, null, 'script-viewport-console.md'],
  ['engine.canvas', 'Font', 0x28, null, 'script-font-model.mjs'],
  ['engine.canvas', 'Viewport', 0x78, null, 'script-gc-state.md'],
  ['engine.texture', 'LODSet', 0x88, null, 'texture LOD bias (script-texture-loading.md)'],
  ['extension.playerpawnext', 'FlagBase', 0x890, null, 'APlayerPawnExt::Destroy 0x10037d40'],
  ['extension.playerpawnext', 'rootWindow', 0x894, null, 'APlayerPawnExt::Destroy 0x10037d40'],
  ['extension.gc', 'canvas', 0x28, null, 'script-gc-state.md'],
  ['extension.gc', 'polyflags', 0x4c, null, 'script-gc-state-model.mjs'],
  ['extension.gc', 'tilePlane', 0x58, null, 'script-gc-draw-model.mjs'],
  ['extension.gc', 'normalFont', 0x7c, null, 'script-font-model.md'],
  ['extension.gc', 'boldFont', 0x80, null, 'script-font-model.md'],
  ['extension.gc', 'textVSpacing', 0x90, null, 'script-font-model.md'],
  ['deusex.deusexplayer', 'conHistory', 0x9fc, null, 'ADeusExPlayer::Destroy 0x10014216'],
  ['deusex.deusexplayer', 'FirstLog', 0xa50, null, 'ADeusExPlayer::Destroy 0x10014216..0x10014222'],
  ['deusex.deusexplayer', 'LastLog', 0xa54, null, 'ADeusExPlayer::Destroy 0x10014216..0x10014222'],
  ['deusex.deusexlog', 'text', 0x28, null, 'script-native-flagbase-research.md'],
  ['deusex.deusexlog', 'next', 0x34, null, 'script-loadmap-gc.md'],
  ['deusex.dumplocation', 'currentDumpFileLocation', 0x28, null, 'script-player-dump.mjs'],
  ['deusex.dumplocation', 'dumpFileDirectory', 0x7c, null, 'script-player-dump.mjs'],
  ['deusex.dumplocation', 'currentDumpLocationIndex', 0x8c, null, 'script-player-dump.mjs'],
  ['deusex.dumplocation', 'dumpFile', 0x9c, null, 'script-player-dump.md'],
  ['deusex.dumplocation', 'dumpLocationCount', 0xa0, null, 'script-player-dump.md'],
  ['deusex.dumplocation', 'player', 0xa4, null, 'script-player-dump.md'],
  ['deusextext.deusextextparser', 'text', 0x28, null, 'script-text-parser.md'],
  ['deusextext.deusextextparser', 'textPos', 0x2c, null, 'script-text-parser.md'],
  ['deusextext.deusextextparser', 'tagEndPos', 0x30, null, 'script-text-parser.md'],
  ['deusextext.deusextextparser', 'lastText', 0x34, null, 'script-text-parser.md'],
  ['deusextext.deusextextparser', 'lastTag', 0x40, null, 'script-text-parser.md'],
  ['deusextext.deusextextparser', 'lastName', 0x44, null, 'script-text-parser.md'],
  ['deusextext.deusextextparser', 'defaultColor', 0x4c, null, 'script-text-parser.md'],
  ['deusextext.deusextextparser', 'bParagraphStarted', 0x50, null, 'script-text-parser.md'],
  ['consys.conlistitem', 'con', 0x28, null, 'script-conversation-construction.md'],
  ['consys.conlistitem', 'next', 0x2c, null, 'script-tagged-properties.md'],
  ['consys.conhistoryevent', 'next', 0x44, null, 'script-instructor-conversation.md'],
  ['consys.coneventrandomlabel', 'cycleIndex', 0x50, null, 'script-runtime.mjs GetRandomLabel'],
  ['consys.coneventrandomlabel', 'bLabelsCycled', 0x54, null, 'script-runtime.mjs GetRandomLabel'],
  ['consys.coneventanimation', 'eventOwner', 0x40, null, 'script-conversation-action-bind.md'],
  ['consys.coneventcheckobject', 'objectName', 0x40, null, 'script-conversation-check-object-bind.md'],
  ['consys.coneventcheckobject', 'checkObject', 0x4c, null, 'script-conversation-check-object-bind.md'],
  ['consys.coneventtransferobject', 'objectName', 0x40, null, 'script-conversation-transfer-object-bind.md'],
  ['consys.coneventtransferobject', 'giveObject', 0x4c, null, 'script-conversation-transfer-object-bind.md'],
  ['consys.coneventtransferobject', 'fromActor', 0x54, null, 'script-conversation-transfer-object-bind.md'],
  ['consys.coneventtransferobject', 'toActor', 0x64, null, 'script-conversation-transfer-object-bind.md'],
];
for (const [classKey, name, offset, mask, where] of RETAIL) {
  const entry = entryOf(classKey, name);
  assert.equal(entry.offset, offset, `${classKey}.${name} linked +0x${entry.offset.toString(16)}, retail +0x${offset.toString(16)} (${where})`);
  if (mask !== null) assert.equal(entry.mask, mask, `${classKey}.${name} BitMask (${where})`);
}

// 4. Native Extension windows: C++ layout against retail and the linker.
for (const [classKey, name, offset, where, mask] of RECOVERED_WINDOW_OFFSETS) {
  const native = nativeWindowLayout(byKey.get(classKey));
  const entry = [...native.fields.values()].find(item => item.name.toLowerCase() === name.toLowerCase());
  assert.ok(entry, `${classKey}.${name} has a native window entry`);
  assert.equal(entry.offset, offset, `${classKey}.${name} C++ offset (${where})`);
  if (mask !== undefined) assert.equal(entry.mask, mask, `${classKey}.${name} C++ bit (${where})`);
}
// The hand-written (noexport) C++ headers pack FColor at byte alignment; the
// struct Link aligns it to four. Retail instructions confirm the C++ side for
// each differing member, so script and native access reach different bytes.
const WINDOW_RETAIL_COLORS = new Map([
  ['extension.window.textcolor', [0x3d, 'SetTextColor 0x1004d9e0']],
  ['extension.checkboxwindow.checkboxcolor', [0x20d, 'checkbox draw (script-window-family-draw.mjs)']],
  ['extension.scalewindow.scalecolor', [0x17f, 'native 1632 (script-window-host-natives.mjs)']],
  ['extension.scalewindow.thumbcolor', [0x183, 'native 1633 (script-window-host-natives.mjs)']],
  ['extension.scalewindow.tickcolor', [0x187, 'native 1634 (script-window-host-natives.mjs)']],
]);
// Classes the C++ derivation does not cover: XTextParams has no recorded size.
const UNDERIVED_WINDOWS = ['extension.editwindow', 'extension.largetextwindow'];
const windowDivergence = new Map(), underived = [];
let windowMembers = 0;
for (const classKey of Object.keys(NATIVE_WINDOW_CLASS_SIZES)) {
  let native;
  try { native = nativeWindowLayout(byKey.get(classKey)); }
  catch (error) { underived.push(classKey); continue; }
  for (const entry of native.fields.values()) {
    if (!entry.field.key.startsWith(`${classKey}.`)) continue;
    windowMembers++;
    const linked = layouts.get(byKey.get(classKey)).byKey.get(entry.field.key);
    if (linked.offset !== entry.offset || (entry.kind === 'bool' && linked.mask !== entry.mask))
      windowDivergence.set(entry.field.key, [linked.offset, entry.offset]);
  }
}
assert.deepEqual(underived, UNDERIVED_WINDOWS, 'native window classes without a C++ derivation');
assert.deepEqual([...windowDivergence.keys()], [...WINDOW_RETAIL_COLORS.keys()], 'native window members off the linked layout');
for (const [key, [, native]] of windowDivergence) {
  const [retail, where] = WINDOW_RETAIL_COLORS.get(key);
  assert.equal(native, retail, `${key} C++ offset (${where})`);
}
// TextLogWindow.bPaused: the linker gives bit 1 of +0x184, while retail
// PauseLog 0x100478f0 writes bit 2 (the SDK header agrees with retail). The
// C++ derivation above reproduces the linker here; the window host corrects
// it with FIELD_OVERRIDES.
const paused = entryOf('extension.textlogwindow', 'bPaused');
assert.deepEqual([paused.offset, paused.mask], [0x184, 2], 'TextLogWindow.bPaused linked bit');
console.log(`native windows: ${windowMembers - windowDivergence.size - 1}/${windowMembers} members at the linked offset; ` +
  `${windowDivergence.size} FColor members and TextLogWindow.bPaused at a different retail offset or bit`);

// Research reference: SDK 1112f C++ headers, when generated locally.
const sdkPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../.cache/sdk-layouts.json');
if (existsSync(sdkPath)) {
  const sdk = JSON.parse(readFileSync(sdkPath, 'utf8')).records;
  let compared = 0, matched = 0;
  const differing = new Map();
  for (const cls of classes) {
    const name = cls.record.name ?? cls.record.key.split('.').at(-1);
    const sdkName = ['A', 'U', 'X'].map(prefix => prefix + name).find(candidate => sdk[candidate]);
    if (!sdkName) continue;
    const members = new Map();
    for (const member of sdk[sdkName].members) if (member.owner === sdkName && member.depth === 1) members.set(member.path.toLowerCase(), member);
    for (const entry of layouts.get(cls).properties) {
      if (!entry.key.startsWith(`${cls.record.key}.`)) continue;
      const member = members.get(entry.name.toLowerCase());
      if (!member) continue;
      compared++;
      const same = entry.type === 'bool'
        ? member.bits && member.bits[0] === member.bits[1] && entry.offset * 8 + 31 - Math.clz32(entry.mask) === member.offset * 8 + member.bits[0]
        : entry.offset === member.offset;
      if (same) { matched++; continue; }
      const group = differing.get(cls.record.key) ?? {count: 0, first: null, retail: []};
      group.count++;
      group.first ??= `${entry.name} linked +0x${entry.offset.toString(16)} SDK +0x${member.offset.toString(16)}`;
      // A retail-recovered offset decides between the linker and the header.
      const retail = RETAIL.find(([classKey, name]) => classKey === cls.record.key && name.toLowerCase() === entry.name.toLowerCase());
      if (retail) group.retail.push(`${entry.name} +0x${retail[2].toString(16)} (${retail[4]})`);
      differing.set(cls.record.key, group);
    }
  }
  console.log(`SDK 1112f headers (research): ${matched}/${compared} members agree`);
  for (const [key, group] of differing) console.log(`  ${key}: ${group.count} differ, first ${group.first}` +
    (group.retail.length ? `; retail agrees with the linker: ${group.retail.join(', ')}` : ''));
} else console.log('SDK 1112f headers (research): .cache/sdk-layouts.json absent, skipped');

console.log(`validate-object-layout: ${classes.length} classes, ${replayed} direct properties replayed, ` +
  `${structMembers} struct members, ${RETAIL.length} retail offsets, ${RECOVERED_WINDOW_OFFSETS.length} window offsets: ok`);
