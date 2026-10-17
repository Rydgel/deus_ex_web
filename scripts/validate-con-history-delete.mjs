/** CriticalDelete of a ConHistory (native 751 on DeusExPlayer.conHistory, the way MissionScript.FirstFrame, ResetPlayerToDefaults and RestartLevel reach it
 * through DeusExPlayer.ResetConversationHistory): the scalar deleting destructor in DeusEx vtable 0x10027fe8 slot +0x0c (docs/script-loadmap-gc.md,
 * "ConHistory CriticalDelete").
 *
 * 1. Original evidence: the hash-pinned DLLs, the pinned bodies (DeusEx 0x100146a0 and 0x10014730, ConSys ~DConHistory 0x10003400 and
 *    ~DConHistoryEvent 0x100038a0), the instructions the model rests on, the imports they call and the vtable slots that select them.
 * 2. Play: a history made by a real conversation on 01_NYC_UNATCOIsland (Terrorist4's greeting) and a three-event history made the way
 *    ConPlayBase.SetupHistory/AddHistoryEvent make one are deleted through the script function: every event is released first, in firstEvent order,
 *    the history after them, each slot returns to GObjAvailable in that order, and the script clears conHistory. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {gameDirectory} from './game-directory.mjs';
import {openSession} from './census-stage5-session.mjs';

const root = gameDirectory();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// ---- 1. Original evidence ----------------------------------------------------
const DLL_SHA256 = {
  DeusEx: 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04',
  ConSys: 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
};
const BODIES = {
  conHistoryDeletingDestructor: ['DeusEx', 0x100146a0, 0x100146c2, '287e75677cbd330d0f9598c117ad31d52b19c5a8898ad2bfcef29a8b709df404'],
  conHistoryEventDeletingDestructor: ['DeusEx', 0x10014730, 0x10014752, 'f3a558b2205dc37a69af85cd3a1ba0f0b2cb31dd12f8728eb67305718751cb0b'],
  conHistoryDestructor: ['ConSys', 0x10003400, 0x10003518, '5209382bfbc6aae2e6b79f1a2f4c2272fc0f8aba7403e5478508a9ea0658b971'],
  conHistoryEventDestructor: ['ConSys', 0x100038a0, 0x100039aa, '7e3334f7aa18425699dcaf4b0d30f157863e399f26adac285d1ca41e95a8124d'],
  conHistoryDestroy: ['ConSys', 0x1000ca20, 0x1000ca78, 'ad2fb0f6338bdf5a9e55e3f4e20878e3cb583925725192fa3e5ef43e885605b2'],
};
// The instructions the model rests on, inside the pinned ranges.
const ANCHORS = [
  ['DeusEx', 0x100146a3, 'ff1500700210', 'deleting destructor: call ~DConHistory (IAT 0x10027000)'],
  ['DeusEx', 0x100146a9, 'f644240801', 'deleting destructor: test flags, 1'],
  ['DeusEx', 0x100146b0, '6a5c56ff159c700210', 'flag 1: ??3UObject(this, 0x5c)'],
  ['DeusEx', 0x10014733, 'ff1520700210', 'event deleting destructor: call ~DConHistoryEvent (IAT 0x10027020)'],
  ['DeusEx', 0x10014740, '6a4856ff159c700210', 'event flag 1: ??3UObject(this, 0x48)'],
  ['ConSys', 0x10003422, 'c70668350110', '~DConHistory: store the DConHistory vtable 0x10013568'],
  ['ConSys', 0x10003430, 'ff157c300110', '~DConHistory: ConditionalDestroy(this) (vtable +0x24 = DConHistory::Destroy)'],
  ['ConSys', 0x10003436, '8d7e40', '~DConHistory: FString member at +0x40 (strDescription)'],
  ['ConSys', 0x10003474, '8d7e34', '~DConHistory: FString member at +0x34 (strLocation)'],
  ['ConSys', 0x100034aa, '8d7e28', '~DConHistory: FString member at +0x28 (conOwnerName)'],
  ['ConSys', 0x100034df, 'c706c4310110', '~DConHistory: store the DConObject vtable 0x100131c4'],
  ['ConSys', 0x100034ef, 'ff157c300110', '~DConHistory: ConditionalDestroy(this) again (guarded, UObject::Destroy)'],
  ['ConSys', 0x100034ff, 'ff1578300110', '~DConHistory: ~UObject'],
  ['ConSys', 0x100038c2, 'c707bc350110', '~DConHistoryEvent: store the DConHistoryEvent vtable 0x100135bc'],
  ['ConSys', 0x100038d0, 'ff157c300110', '~DConHistoryEvent: ConditionalDestroy(this)'],
  ['ConSys', 0x10003971, 'c707c4310110', '~DConHistoryEvent: store the DConObject vtable 0x100131c4'],
  ['ConSys', 0x10003991, 'ff1578300110', '~DConHistoryEvent: ~UObject'],
  ['ConSys', 0x1000ca51, '8b018b71446a01ff500c', 'DConHistory::Destroy: next = event->next (+0x44), event->vtable +0x0c (1)'],
];
const IMPORTS = [
  ['DeusEx', 0x10027000, 'CONSYS.dll!??1DConHistory@@UAE@XZ'],
  ['DeusEx', 0x10027020, 'CONSYS.dll!??1DConHistoryEvent@@UAE@XZ'],
  ['DeusEx', 0x1002709c, 'Core.dll!??3UObject@@SAXPAXI@Z'],
  ['ConSys', 0x1001307c, 'Core.dll!?ConditionalDestroy@UObject@@QAEHXZ'],
  ['ConSys', 0x10013078, 'Core.dll!??1UObject@@UAE@XZ'],
];
// Retail vtable slots: [dll, vtable, slot, target].
const SLOTS = [
  ['DeusEx', 0x10027fe8, 0x0c, 0x100146a0],   // ConHistory scalar deleting destructor
  ['DeusEx', 0x10027fe8, 0x24, 0x1001ae60],   // ConHistory Destroy: jmp DConHistory::Destroy
  ['DeusEx', 0x1002803c, 0x0c, 0x10014730],   // ConHistoryEvent scalar deleting destructor
  ['DeusEx', 0x1002803c, 0x24, 0x1001aec0],   // ConHistoryEvent Destroy: jmp UObject::Destroy
  ['ConSys', 0x10013568, 0x24, 0x1000ca20],   // DConHistory::Destroy
];

function peImage(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(60, true), optional = pe + 24, base = view.getUint32(optional + 28, true);
  const sections = [], table = optional + view.getUint16(pe + 20, true);
  for (let i = 0; i < view.getUint16(pe + 6, true); i++) {
    const at = table + i * 40;
    sections.push({rva: view.getUint32(at + 12, true), size: Math.max(view.getUint32(at + 8, true), view.getUint32(at + 16, true)), raw: view.getUint32(at + 20, true)});
  }
  const offset = va => {
    const rva = va - base, section = sections.find(s => rva >= s.rva && rva < s.rva + s.size);
    if (!section) throw new Error(`VA 0x${va.toString(16)} is outside the image`);
    return section.raw + rva - section.rva;
  };
  const u32 = va => view.getUint32(offset(va), true);
  const cstring = at => { let end = at; while (bytes[end]) end++; return Buffer.from(bytes.subarray(at, end)).toString('latin1'); };
  const imports = new Map();
  for (let at = offset(base + view.getUint32(optional + 104, true)); view.getUint32(at + 16, true); at += 20) {
    const dll = cstring(offset(base + view.getUint32(at + 12, true)));
    const thunks = view.getUint32(at, true) || view.getUint32(at + 16, true), slots = view.getUint32(at + 16, true);
    for (let i = 0; ; i++) {
      const entry = u32(base + thunks + 4 * i);
      if (!entry) break;
      imports.set(base + slots + 4 * i, `${dll}!${entry & 0x80000000 ? `#${entry & 0xffff}` : cstring(offset(base + entry) + 2)}`);
    }
  }
  return {bytes: (start, end) => bytes.subarray(offset(start), offset(start) + (end - start)), u32, imports};
}

const images = {};
for (const [name, digest] of Object.entries(DLL_SHA256)) {
  const bytes = await readFile(path.join(root, 'System', `${name}.dll`));
  assert.equal(sha256(bytes), digest, `${name}.dll is not the hash-pinned GOTY image`);
  images[name] = peImage(bytes);
}
if (process.argv.includes('--print-digests'))
  for (const [name, [dll, start, end]] of Object.entries(BODIES)) console.log(name, sha256(images[dll].bytes(start, end)));
else {
  for (const [name, [dll, start, end, digest]] of Object.entries(BODIES)) assert.equal(sha256(images[dll].bytes(start, end)), digest, `${name} body changed`);
  for (const [dll, at, hex, meaning] of ANCHORS) assert.equal(Buffer.from(images[dll].bytes(at, at + hex.length / 2)).toString('hex'), hex, meaning);
  for (const [dll, slot, name] of IMPORTS) assert.equal(images[dll].imports.get(slot), name, `${dll} IAT 0x${slot.toString(16)}`);
  for (const [dll, vtable, slot, target] of SLOTS) assert.equal(images[dll].u32(vtable + slot), target, `${dll} vtable 0x${vtable.toString(16)} slot +0x${slot.toString(16)}`);

  // ---- 2. Play ------------------------------------------------------------------
  const files = [];
  for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const name of await readdir(path.join(root, directory))) files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
  const session = await openSession('01_NYC_UNATCOIsland', new AssetStore(files));
  const {c, c: {runtime}} = session;
  const player = c.player(), index = object => runtime.instance(object).nativeObject.index;
  const registry = runtime.actorLifecycle.construction.registry;
  const events = history => { const list = []; for (let event = c.read(history, 'firstEvent'); event; event = c.read(event, 'next')) list.push(event); return list; };
  // MissionScript.FirstFrame (the Timer's first call) resets the history behind the M1MissionStart flag; let it run before a conversation starts.
  c.frames(30);
  for (let i = 0; i < 240 && !c.flag('m1missionstart'); i++) c.frames(5);
  assert.ok(c.flag('m1missionstart'), 'MissionScript.FirstFrame ran');
  assert.equal(c.read(player, 'conHistory'), null, 'no history yet');

  function deleteAndCheck(history, label) {
    const list = events(history), slots = [...list.map(index), index(history)], before = registry.freeIndices.length;
    for (const object of [history, ...list]) assert.equal(runtime.isReleased(object), false, `${label}: live before the delete`);
    runtime.processEvent(player, 'ResetConversationHistory', []);
    assert.equal(c.read(player, 'conHistory'), null, `${label}: ResetConversationHistory clears conHistory after CriticalDelete`);
    for (const object of [history, ...list]) assert.equal(runtime.isReleased(object), true, `${label}: ${object.name} was released`);
    for (const slot of slots) assert.equal(registry.objects[slot], null, `${label}: GObjObjects[${slot}] was cleared`);
    // DConHistory::Destroy deletes the events in firstEvent order inside ConditionalDestroy; ~UObject of the history follows: slots are appended in that order.
    assert.deepEqual(registry.freeIndices.slice(before), slots, `${label}: GObjAvailable received the event slots in order, then the history's`);
    return slots;
  }

  // (a) a real history: Terrorist4 greets the player; the conversation has ended with one logged event.
  const terrorist = c.actor('Terrorist4'), at = c.pos(terrorist);
  c.stand([at[0] - 200, at[1], at[2]], at);
  for (let i = 0; i < 180 && !(c.read(player, 'conHistory') && !c.read(player, 'conPlay')); i++) c.frames(1);
  const real = c.read(player, 'conHistory');
  assert.ok(real && !c.read(player, 'conPlay') && events(real).length >= 1, 'a conversation made a history with events');
  const realSlots = deleteAndCheck(real, 'real history');

  // (b) a three-event history as ConPlayBase.SetupHistory (native 3002) and AddHistoryEvent (native 3003) link one.
  const native = (index_, receiver = player) => runtime.invokeNative({index: index_, receiver, argumentCount: 0, evaluateArgument: () => undefined, script: null, frame: null});
  const history = native(3002);
  for (const field of ['firstEvent', 'lastEvent', 'next']) assert.equal(c.read(history, field), null, `${field} starts None`);
  const made = [native(3003), native(3003), native(3003)];
  runtime.writeNamed(history, 'firstEvent', made[0]);
  made.forEach((event, i) => runtime.writeNamed(event, 'next', made[i + 1] ?? null));
  runtime.writeNamed(history, 'lastEvent', made[2]);
  runtime.writeNamed(player, 'conHistory', history);
  assert.deepEqual(events(history), made);
  const chainSlots = deleteAndCheck(history, 'three-event history');
  // AddObject takes the last available slot first (LIFO): the history's own.
  const next = native(3002);
  assert.equal(index(next), chainSlots.at(-1), 'AddObject reuses the history slot, the last freed');
  console.log(`CriticalDelete of a ConHistory validated: ${Object.keys(BODIES).length} pinned bodies, ${ANCHORS.length} anchors, ${IMPORTS.length} imports, ${SLOTS.length} slots; ` +
    `a real history (${realSlots.length - 1} event) and a three-event history were deleted event by event, then the history, with GObjAvailable in that order.`);
  process.exit(0);
}
