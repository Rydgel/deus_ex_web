/** Core's runaway-loop guard and the Patrolling loop that reaches it (docs/script-level-tick.md "Core's runaway-loop guard",
 * docs/script-pawn-nav.md "A patrol that cannot start").
 *
 * The slow-spot census stopped twice on 09_NYC_ShipBelow with `Runaway loop detected (over 10000000 iterations)`, in PickDestination and in
 * Patrolling. The loop is ScriptedPawn.Patrolling's own state code: with `PickDestination` choosing the next PatrolPoint of a route whose
 * pausetime is 0 and `FindPathToward` finding no path to it, no statement of the Patrol/Pausing cycle yields (WaitForLanding installs its
 * latent only while the pawn is PHYS_Falling, Engine 0x103bb6f0), so one ULevel::Tick ends only in Core's counter.
 *
 * Part A pins, in the installed Core.dll and Engine.dll, the contract our guard implements: the counter GRunaway (0x101f81bc) counts every
 * execJump (0x1012faf0) and execJumpIfNot (0x1012fbc0), taken or not; past 10,000,000 (0x989680) and without `-norunaway` on the command
 * line it Logf's NAME_Critical (0x2f9) "Runaway loop detected (over %i iterations)" through the FFrame, whose Serialize sends a critical
 * event to GError (a fatal FOutputDeviceError) with the object, the node and the bytecode offset; GInitRunaway (0x1012e7d0) clears the
 * counter, and ULevel::Tick calls it (Engine 0x103a5265). Part B runs the real Patrolling bytecode of 09_NYC_ShipBelow's HKMilitary9
 * (OrderTag BayPP00: four PatrolPoints in a cycle, pausetime 0) with the path search made to fail (the level's ReachSpec table empty for
 * that pawn: a fault injected here, not a state the original is shown to reach), the runaway count started 3,000 jumps below the limit,
 * and checks the loop is what the guard stops: WaitForLanding and FindPathToward alternate with FindPathToward always None, the pawn does
 * not move, the error is the guard's, the count is back to 0 afterwards and the next tick runs.
 *
 *   node scripts/validate-script-runaway-guard.mjs */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';
import { SCRIPT_RUNAWAY_LIMIT, scriptRunawayCount, setScriptRunaway } from '../src/runtime/script-vm.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();

// ---- Part A: the DLLs -------------------------------------------------------------------------------------------------------------
function image(bytes) {
  const pe = bytes.readUInt32LE(0x3c), sections = bytes.readUInt16LE(pe + 6), optional = bytes.readUInt16LE(pe + 20), base = bytes.readUInt32LE(pe + 24 + 28);
  const table = pe + 24 + optional, list = [];
  for (let i = 0; i < sections; i++) {
    const o = table + 40 * i;
    list.push({ rva: bytes.readUInt32LE(o + 12), size: Math.max(bytes.readUInt32LE(o + 8), bytes.readUInt32LE(o + 16)), raw: bytes.readUInt32LE(o + 20) });
  }
  const at = (va, length) => {
    const rva = va - base, s = list.find(x => rva >= x.rva && rva < x.rva + x.size);
    assert.ok(s, `address ${va.toString(16)} is in a section`);
    return bytes.subarray(s.raw + rva - s.rva, s.raw + rva - s.rva + length);
  };
  const text = (va, length = 160) => at(va, length).toString('utf16le').split('\0')[0];
  const rvaAt = rva => { const s = list.find(x => rva >= x.rva && rva < x.rva + x.size); return s.raw + rva - s.rva; };
  /** The import whose IAT slot is at `va`: "Core.dll!name". */
  const importAt = va => {
    const directory = bytes.readUInt32LE(pe + 24 + 96 + 8);
    for (let o = rvaAt(directory); bytes.readUInt32LE(o + 12); o += 20) {
      const lookup = bytes.readUInt32LE(o) || bytes.readUInt32LE(o + 16), first = bytes.readUInt32LE(o + 16);
      for (let i = 0; bytes.readUInt32LE(rvaAt(lookup) + 4 * i); i++) {
        if (base + first + 4 * i !== va) continue;
        const entry = bytes.readUInt32LE(rvaAt(lookup) + 4 * i), name = bytes.toString('latin1', rvaAt(entry) + 2, bytes.indexOf(0, rvaAt(entry) + 2));
        return `${bytes.toString('latin1', rvaAt(bytes.readUInt32LE(o + 12)), bytes.indexOf(0, rvaAt(bytes.readUInt32LE(o + 12))))}!${name}`;
      }
    }
    return null;
  };
  return { at, text, importAt };
}
/** `bytes` with `??` for a byte that is a relocated or relative operand. */
function expectBytes(label, actual, pattern) {
  const want = pattern.trim().split(/\s+/);
  assert.ok(actual.length >= want.length, label);
  want.forEach((b, i) => { if (b !== '??') assert.equal(actual[i].toString(16).padStart(2, '0'), b, `${label}: byte ${i} (${want.slice(0, i + 1).join(' ')})`); });
}
const core = image(await readFile(`${root}/System/Core.dll`)), engine = image(await readFile(`${root}/System/Engine.dll`));

const COUNTER = 'bc 81 1f 10', LIMIT = '80 96 98 00', CRITICAL = 'f9 02 00 00';
// execJump: GRunaway++ ; > 0x989680 ? (no -norunaway: Logf(NAME_Critical, ...)) ; GRunaway = 0 ; then the jump itself
expectBytes('execJump', core.at(0x1012faf0, 0x6a),
  `a1 ${COUNTER} 56 8b 74 24 08 40 3d ${LIMIT} a3 ${COUNTER} 7e 39 68 58 ad 1a 10 e8 ?? ?? ?? ?? 50 e8 ?? ?? ?? ?? 83 c4 08 85 c0 75 18 68 ${LIMIT} 68 6c ad 1a 10 68 ${CRITICAL} 56 e8 ?? ?? ?? ?? 83 c4 10 c7 05 ${COUNTER} 00 00 00 00 8b 4e 0c`);
expectBytes('execJumpIfNot', core.at(0x1012fbc0, 0x6a),
  `a1 ${COUNTER} 56 8b 74 24 08 40 3d ${LIMIT} 57 a3 ${COUNTER} 7e 39 68 c4 ad 1a 10 e8 ?? ?? ?? ?? 50 e8 ?? ?? ?? ?? 83 c4 08 85 c0 75 18 68 ${LIMIT} 68 d8 ad 1a 10 68 ${CRITICAL} 56 e8 ?? ?? ?? ?? 83 c4 10 c7 05 ${COUNTER} 00 00 00 00 8b 46 0c`);
for (const va of [0x101aad58, 0x101aadc4]) assert.equal(core.text(va), 'norunaway', `-norunaway at ${va.toString(16)}`);
const FORMAT = 'Runaway loop detected (over %i iterations)';
for (const va of [0x101aad6c, 0x101aadd8]) assert.equal(core.text(va), FORMAT, `the message at ${va.toString(16)}`);
// GInitRunaway clears the counter and its neighbour; ULevel::Tick calls it through the import (Engine IAT 0x10599f60).
expectBytes('GInitRunaway', core.at(0x1012e7d0, 13), `33 c0 a3 ${COUNTER} a3 c0 81 1f 10 c3`);
expectBytes('ULevel::Tick GInitRunaway', engine.at(0x103a5265, 6), 'ff 15 60 9f 59 10');
assert.match(engine.importAt(0x10599f60) ?? '', /^Core\.dll!\?GInitRunaway@@YAXXZ$/i, 'Engine IAT 0x10599f60 is Core\'s GInitRunaway');
// FFrame::Serialize: NAME_Critical goes to GError->Logf("%s (%s:%04X) %s", Object full name, Node full name, offset, text); the rest to
// GLog as NAME_ScriptWarning (0x301) unless GIsStrict.
const serialize = core.at(0x1012e7e0, 0xd0);
expectBytes('FFrame::Serialize critical test', serialize.subarray(0x21), `3d ${CRITICAL}`);
expectBytes('FFrame::Serialize non-critical', serialize.subarray(0x64), 'a1 34 7c 1a 10 68 a0 aa 1a 10 68 01 03 00 00');
expectBytes('FFrame::Serialize critical', serialize.subarray(0xb6), 'a1 38 7c 1a 10 68 80 aa 1a 10');
assert.equal(core.text(0x101aaa80), '%s (%s:%04X) %s', 'critical format');
assert.equal(core.text(0x101aaaa0), '%s (%s:%04X) %s', 'script warning format');
// Our constants are the DLL's.
assert.equal(SCRIPT_RUNAWAY_LIMIT, 0x989680, 'SCRIPT_RUNAWAY_LIMIT is the DLL\'s 0x989680');
console.log('Core.dll / Engine.dll: runaway guard contract pinned (counter, limit, -norunaway, NAME_Critical, GError, GInitRunaway, ULevel::Tick)');

// ---- Part B: Patrolling ------------------------------------------------------------------------------------------------------------
const TARGET = 'HKMilitary9', BIAS = 3000;
const armed = { on: false };
const calls = { find: [], landing: 0 };
const invokeNative = ScriptRuntime.prototype.invokeNative;
ScriptRuntime.prototype.invokeNative = function (call) {
  const result = invokeNative.call(this, call);
  if (armed.on && call.receiver?.name === TARGET) {
    if (call.index === 517) calls.find.push(result);
    else if (call.index === 527) calls.landing++;
  }
  return result;
};
const pawnNavServices = ScriptRuntime.prototype.pawnNavServices;
ScriptRuntime.prototype.pawnNavServices = function (receiver) {
  const services = pawnNavServices.call(this, receiver);
  return armed.on && receiver?.name === TARGET ? { ...services, reachSpecTable: () => [] } : services;
};
// The Rust interpreter keeps its own copy of the count in the object arena and takes it back at every crossing: bias both.
const runawayWord = runtime => (runtime.scriptVm?.runawayAt ? { view: runtime.scriptVm.arena.view, at: runtime.scriptVm.runawayAt } : null);
const setRunaway = (runtime, value) => {
  setScriptRunaway(value);
  const word = runawayWord(runtime);
  if (word) word.view.setUint32(word.at, value, true);
};
const runaway = runtime => { const word = runawayWord(runtime); return word ? word.view.getUint32(word.at, true) : scriptRunawayCount(); };
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('09_NYC_ShipBelow');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime, level = runtime.levelFor(game.player.collisionActor);
const find = name => level.actors.find(a => a?.name === name);
const read = (actor, name) => runtime.readNamed(actor, name);
for (let i = 0; i < 30; i++) game.tick(1 / 60);

const pawn = find(TARGET);
assert.ok(pawn, `${TARGET} is in the map`);
assert.equal(read(pawn, 'Orders'), 'Patrolling');
assert.equal(read(pawn, 'OrderTag'), 'BayPP00');
// The route: BayPP00 -> BayPP01 -> BayPP02 -> BayPP03 -> BayPP00, every pausetime 0 (the map's PatrolPoints).
const route = ['PatrolPoint21', 'PatrolPoint20', 'PatrolPoint19', 'PatrolPoint18'].map(find);
route.forEach((point, i) => {
  assert.ok(point, `PatrolPoint ${i}`);
  assert.equal(read(point, 'pausetime'), 0, `${point.name} pausetime`);
  assert.equal(read(point, 'NextPatrolPoint'), route[(i + 1) % 4], `${point.name} -> ${route[(i + 1) % 4].name}`);
});
const stateName = () => runtime.instance(pawn).state?.stateNode?.record.name;
const before = read(pawn, 'Location').map(Math.fround);

// Arm: the path search fails for this pawn, the count starts BIAS jumps below the limit, and the state code resumes at its `Patrol` label.
armed.on = true;
const state = runtime.instance(pawn).state, process = state.process.bind(state);
state.process = delta => { if (!armed.biased) { armed.biased = true; setRunaway(runtime, SCRIPT_RUNAWAY_LIMIT - BIAS); } return process(delta); };
state.gotoLabel('Patrol');
let error = null;
for (let i = 0; i < 5 && !error; i++) {
  try { game.tick(1 / 60); } catch (e) { error = e; }
}
armed.on = false;
assert.ok(error, 'the Patrolling loop ends in the guard');
assert.match(error.message, /^Runaway loop detected \(over 10000000 iterations\) in (Patrolling|PickDestination|PickStartPoint)$/, error.message);
assert.equal(runaway(runtime), 0, 'the count is back to 0 after the guard fires (Core 0x1012fb36)');
assert.equal(stateName(), 'Patrolling', 'still in Patrolling');
assert.ok(read(pawn, 'destPoint'), 'a destination was picked');
assert.equal(read(pawn, 'MoveTarget'), null, 'no path, no MoveTarget');
assert.deepEqual(read(pawn, 'Location').map(Math.fround), before, 'the pawn did not move');
assert.ok(calls.find.length > 100 && calls.find.length < 1000, `FindPathToward ran ${calls.find.length} times in one tick`);
assert.ok(calls.find.every(r => r === null), 'FindPathToward found no node');
assert.ok(Math.abs(calls.landing - calls.find.length) <= 1, `WaitForLanding ${calls.landing} and FindPathToward ${calls.find.length} alternate`);
console.log(`Patrolling: ${calls.find.length} FindPathToward (all None) and ${calls.landing} WaitForLanding in one tick, then "${error.message}"`);
console.log('script runaway guard: PASS');
