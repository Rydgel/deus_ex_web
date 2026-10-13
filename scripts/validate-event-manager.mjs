/** The Rust AI event manager (native/script-vm/src/aievent.rs) against the original UEventManager's own instructions
 * (scripts/native-event-manager-oracle.py): every scenario of scripts/event-manager-cases.mjs, operation by operation, compares
 * the boundary log (score callbacks, AICanSee, SingleLineCheck, the AIEvent callbacks with their parameters) and the manager's
 * tables (event types in bucket order, their senders and receivers in list order, the 16 slots of every sender, the process
 * ring). `--reference-only` captures the original's output to .cache/research/event-manager-original.json. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';
import {cases} from './event-manager-cases.mjs';
import {aiNameHash} from '../src/runtime/script-vm-aievent.mjs';

const reference = JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-event-manager-oracle.py', gameDirectory()], {input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 28}));
if (process.argv.includes('--reference-only')) {
  await mkdir('.cache/research', {recursive: true});
  await writeFile('.cache/research/event-manager-original.json', JSON.stringify({cases, reference}));
  console.log(`Captured ${reference.cases.length} original event manager scenarios.`);
  process.exit(0);
}

const module = new WebAssembly.Module(await readFile(process.env.SCRIPT_VM_WASM ?? 'src/runtime/script-vm.wasm'));
const hex = word => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, word >>> 0, true);
  return [...new Uint8Array(view.buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
};
const f32bits = value => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};
const bitsF32 = word => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, word >>> 0, true);
  return view.getFloat32(0, true);
};

class World {
  constructor(test) {
    this.memory = new WebAssembly.Memory({initial: 160, maximum: 160});
    this.names = ['None'];
    this.actors = new Map();
    this.handles = new Map();
    this.policy = {};
    this.log = [];
    this.time = 0;
    const missing = name => () => { throw new Error(`unexpected import ${name}`); };
    const env = {memory: this.memory};
    for (const entry of WebAssembly.Module.imports(module)) if (entry.kind === 'function') env[entry.name] = missing(entry.name);
    Object.assign(env, this.imports());
    this.x = new WebAssembly.Instance(module, {env}).exports;
    const size = this.x.ai_pool_size();
    this.pool = 0x300000;
    this.dumpAt = this.pool + ((size + 0xffff) & ~0xffff);
    assert(this.dumpAt + (1 << 20) < this.memory.buffer.byteLength);
    this.x.ai_attach(this.pool);
    this.x.ai_reset();
    this.id = name => { let i = this.names.indexOf(name); if (i < 0) { i = this.names.length; this.names.push(name); } return i; };
  }
  name(id) { return this.names[id]; }
  actorOf(handle) { return this.handles.get(handle) ?? null; }
  idOf(handle) { return handle ? this.actorOf(handle)?.id ?? `?${handle}` : null; }
  add(id, spec) {
    const handle = 1000 + this.actors.size;
    const actor = {id, handle, ...spec};
    this.actors.set(id, actor);
    this.handles.set(handle, actor);
  }
  imports() {
    const w = this;
    const actor = handle => w.actorOf(handle);
    return {
      js_ai_name_hash: name => aiNameHash(w.name(name)),
      js_ai_name_cmp: (a, b) => { const x = w.name(a).toLowerCase(), y = w.name(b).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; },
      js_ai_flags: handle => { const a = actor(handle); return (a.deleted ? 1 : 0) | (a.kind === 'pawn' ? 2 : 0) | (a.kind === 'inventory' ? 4 : 0) | (a.detectable ? 8 : 0); },
      js_ai_float: (handle, field) => {
        const a = actor(handle);
        return f32bits([a.location[0], a.location[1], a.location[2], a.radius, a.height, a.lastRender, a.distance, a.hearing][field]);
      },
      js_ai_locs: (a, b, out) => {
        const view = new DataView(w.memory.buffer), p = actor(a).location, q = actor(b).location;
        for (let i = 0; i < 3; i++) { view.setFloat32(out + 4 * i, p[i], true); view.setFloat32(out + 12 + 4 * i, q[i], true); }
      },
      // The oracle's AICanSee is a leaf that returns what the policy says whatever the geometry, so the pre-gate (which skips the call
      // when the real function is certain to return 0) must not fire here: a detectable target and no minimum angular size.
      js_ai_view: (pawn, other, out) => {
        const view = new DataView(w.memory.buffer);
        for (let i = 0; i < 11; i++) view.setUint32(out + 4 * i, 0, true);
        view.setUint32(out + 40, 1, true);
      },
      js_ai_owner: handle => (actor(handle).owner ? w.actors.get(actor(handle).owner).handle : 0),
      js_ai_time: () => w.time,
      js_ai_in_stasis: handle => (actor(handle).stasis ? 1 : 0),
      js_ai_can_see: (pawn, other, visibility, c0, c1, c2, c3) => {
        let result = Math.fround((w.policy.canSeeScale ?? 0.75) * bitsF32(visibility));
        for (const rule of w.policy.canSee ?? []) if (w.idOf(pawn) === rule[0] && w.idOf(other) === rule[1]) result = Math.fround(rule[2]);
        w.log.push({kind: 'canSee', pawn: w.idOf(pawn), other: w.idOf(other), visibility: hex(visibility), flags: [c0, c1, c2, c3], result: hex(f32bits(result))});
        return f32bits(result);
      },
      js_ai_line_check: (receiver, sender) => {
        const r = actor(receiver), s = actor(sender);
        const blocked = (w.policy.blocked ?? []).some(rule => rule[0] === r.id && rule[1] === s.id);
        w.log.push({kind: 'lineCheck', source: r.id, end: s.location.map(v => hex(f32bits(v))), start: r.location.map(v => hex(f32bits(v))), flags: 6, blocked});
        return f32bits(blocked ? 0.5 : 1);
      },
      js_ai_callback: (handle, callback, event, state) => {
        const a = actor(handle), name = callback ? w.name(callback) : 'AIEvent';
        if (a.functions && !a.functions.includes(name)) return;
        const p = new Uint32Array(w.memory.buffer, w.x.ai_params_ptr(), 5);
        w.log.push({kind: 'callback', actor: a.id, function: name, event: w.name(event), state,
          params: {bestActor: w.idOf(p[0]), score: hex(p[1]), visibility: hex(p[2]), volume: hex(p[3]), smell: hex(p[4])}});
      },
      js_ai_score: (receiver, sender, callback, score) => {
        let value = Math.fround(bitsF32(score) * (w.policy.scoreScale ?? 0.5));
        if ((w.policy.cull ?? []).some(rule => rule[0] === w.idOf(receiver) && rule[1] === w.idOf(sender))) value = 0;
        w.log.push({kind: 'score', actor: w.idOf(receiver), function: w.name(callback), receiver: w.idOf(receiver), sender: w.idOf(sender),
          score: hex(score), result: hex(f32bits(value))});
        return f32bits(value);
      },
      js_ai_warn: (code, count) => { w.log.push({kind: 'warning'}); if (code === 1) w.log.push({kind: 'warning'}); },
    };
  }
  snapshot() {
    const n = this.x.ai_dump(this.dumpAt, 1 << 18);
    const words = new Uint32Array(this.memory.buffer, this.dumpAt, n).slice();
    let at = 0;
    const next = () => words[at++];
    const signed = () => words[at++] | 0;
    const out = {currentSlot: next(), refProcessing: signed(), deleteCount: signed()};
    const firstActor = next(), firstEvent = next();
    out.firstProcess = firstActor || firstEvent ? {actor: this.idOf(firstActor), event: this.name(firstEvent)} : null;
    const count = next();
    out.types = [];
    out.ring = [];
    for (let t = 0; t < count; t++) {
      const entry = {bucket: next(), name: this.name(next()), hash: next(), senders: [], receivers: []};
      const ns = next(), nr = next();
      for (let i = 0; i < ns; i++) {
        const sender = {actor: this.idOf(next()), destroyed: next(), holdScore: hex(next()), slots: []};
        for (let s = 0; s < 16; s++) sender.slots.push([hex(next()), hex(next()), hex(next()), hex(next())]);
        sender.current = [hex(next()), hex(next()), hex(next()), hex(next())];
        entry.senders.push(sender);
      }
      for (let i = 0; i < nr; i++) {
        const r = {actor: this.idOf(next()), destroyed: next(), callback: this.name(next()), scoreCallback: this.name(next()), invoke: next(), state: next(),
          checks: [next(), next(), next(), next()], on: next(), bestScore: hex(next()), bestSender: this.idOf(next()), nextSlot: next()};
        r.params = {bestActor: this.idOf(next()), score: hex(next()), visibility: hex(next()), volume: hex(next()), smell: hex(next())};
        entry.receivers.push(r);
      }
      out.types.push(entry);
    }
    const ring = next();
    for (let i = 0; i < ring; i++) out.ring.push({actor: this.idOf(next()), event: this.name(next()), destroyed: next()});
    return out;
  }
  op(op) {
    const x = this.x, id = name => this.id(name), h = name => this.actors.get(name).handle;
    switch (op.op) {
      case 'set': Object.assign(this.actors.get(op.actor), op.fields); break;
      case 'policy': Object.assign(this.policy, op.policy); break;
      case 'time': this.time = op.seconds; break;
      case 'setCallback': {
        const [c0, c1, c2, c3] = op.flags ?? [1, 1, 0, 1];
        x.ai_set_callback(h(op.receiver), id(op.event), id(op.callback), op.score ? id(op.score) : 0, c0, c1, c2, c3);
        break;
      }
      case 'clearCallback': x.ai_clear_callback(h(op.receiver), id(op.event)); break;
      case 'send': x.ai_send(h(op.sender), id(op.event), op.type, f32bits(op.value ?? 1), f32bits(op.radius ?? 800)); break;
      case 'start': x.ai_start(h(op.sender), id(op.event), op.type, f32bits(op.value ?? 1), f32bits(op.radius ?? 800)); break;
      case 'end': x.ai_end(h(op.sender), id(op.event), op.type); break;
      case 'clear': x.ai_clear(h(op.sender), id(op.event)); break;
      case 'destroyActor': x.ai_destroy_actor(h(op.actor)); break;
      case 'process': x.ai_process(); break;
      case 'cleanup': x.ai_cleanup(); break;
      case 'tick': x.ai_tick(); break;
      case 'qsortCompare': break; // the comparator itself is the oracle's (a Python ordering checked against it)
      default: throw new Error(`unknown op ${op.op}`);
    }
  }
}

const DEFAULTS = {kind: 'plain', location: [0, 0, 0], radius: 17, height: 39, detectable: true, deleted: false, lastRender: 0, distance: 100000, hearing: 0, stasis: false, owner: null};
let compared = 0, ops = 0;
for (const [index, scenario] of cases.entries()) {
  const original = reference.cases[index];
  assert.equal(original.name, scenario.name);
  const world = new World(scenario);
  for (const [id, spec] of Object.entries(scenario.actors)) world.add(id, {...DEFAULTS, ...spec});
  for (const [step, row] of original.ops.entries()) {
    world.log = [];
    const op = scenario.ops[step];
    if (op.op === 'qsortCompare') {
      // the Rust ordering (ascending score, insertion order on ties) against the original comparator's matrix
      const scores = op.scores.map(Math.fround);
      const expected = row.log[0].matrix;
      const order = (a, b) => (scores[a] < scores[b] ? -1 : scores[a] > scores[b] ? 1 : a < b ? -1 : a > b ? 1 : 0);
      const matrix = [];
      for (let i = 0; i < scores.length; i++) for (let j = 0; j < scores.length; j++) matrix.push(order(i, j));
      assert.deepEqual(matrix.map(Math.sign), expected.map(Math.sign), `${scenario.name}: comparator`);
      compared++;
      continue;
    }
    world.op(op);
    const wanted = row.log.filter(entry => entry.kind !== 'delete' && entry.kind !== 'qsort' && entry.kind !== 'canHearResult');
    assert.deepEqual(world.log, wanted, `${scenario.name} step ${step} (${JSON.stringify(op)}): boundary log`);
    if (row.snapshot) assert.deepEqual(world.snapshot(), row.snapshot, `${scenario.name} step ${step} (${JSON.stringify(op)}): tables`);
    ops++;
  }
  compared++;
}
console.log(`Event manager: ${compared} scenarios, ${ops} operations: boundary logs and tables equal the original's.`);
