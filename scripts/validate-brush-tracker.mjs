/** Engine's moving brush tracker in the Rust core (native/script-vm/src/
 * tracker.rs, src/runtime/brush-tracker.mjs) against the unchanged
 * original under Unicorn (scripts/native-brush-tracker-oracle.py):
 * docs/brush-tracker.md.
 *
 * Every case of scripts/brush-tracker-cases.json (20 cases on Training,
 * the Paris club, Island, the Intro and the Ship) runs step by step through
 * both: construct (Update(NULL) at the step's control word), update, frame
 * (Update for every non-hidden mover in Level.Actors order), flush,
 * surfIsDynamic and destroy. After each step this builds the oracle's
 * report from the Rust model and tracker state: every added, changed and
 * removed node, surface, point, vector and vert (all fields as bit
 * patterns), NodeFlags-only changes, the arrays' Num and Max, the tracker's
 * cursors, originals, free head, Normal and NodeMaps / VertOwners /
 * PointHelper, and each changed mover's SavedPos, SavedRot, flags and node
 * chain. Full steps must be equal field for field; brief steps must give
 * the oracle's SHA-256 of the same report (Python's sorted-key JSON, with
 * the oracle's newBlocks, which only the emulator can record).
 *
 * A mutation check then shows the comparison detects a 1-ulp change: the
 * Rust side gets one rotating mover's Location with its lowest bit flipped
 * in one step, and the report must differ.
 *
 *   node scripts/validate-brush-tracker.mjs [case-id ...] */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion } from '../src/runtime/bsp-occlusion.mjs';
import { TRACKER, MOVER, DSURF } from '../src/runtime/brush-tracker.mjs';
import { buildMap, caseRequest, runOracle } from './brush-tracker-request.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) {
  console.log('SKIP validate-brush-tracker: no native probe environment');
  process.exit(0);
}
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const kernel = (await loadScriptVmKernel()).occlusion;
const spec = JSON.parse(await readFile(new URL('./brush-tracker-cases.json', import.meta.url), 'utf8'));
const only = new Set(process.argv.slice(2));

/** Python json.dumps(sort_keys=True, separators=(',', ':')) of the report. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** The first path where two reports differ (a short message, never a dump). */
function difference(a, b, at = '') {
  if (canonical(a) === canonical(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = difference(a[k], b[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at}: Rust ${canonical(a)?.slice(0, 300)} | oracle ${canonical(b)?.slice(0, 300)}`;
}

/** The oracle's report shape over the Rust memory. */
function createReporter(occlusion, req) {
  const tracker = occlusion.tracker, names = req.actors.map(a => a.name);
  const words = () => new Uint32Array(kernel.memory.buffer), bytes = () => new Uint8Array(kernel.memory.buffer);
  const ints = () => new Int32Array(kernel.memory.buffer);
  const ref = v => (v >= 0x40000000 && v < 0x40000000 + names.length ? names[v - 0x40000000] : v);
  const h = i => tracker.header(i);
  const signed = v => v | 0;
  const node = raw => {
    const v = new DataView(raw.buffer, raw.byteOffset, 64), u = k => v.getUint32(k, true), i = k => v.getInt32(k, true);
    return { planeBits: [u(0), u(4), u(8), u(12)], zoneMask: [u(16), u(20)], iVertPool: i(24), iSurf: i(28), iBack: i(32),
      iFront: i(36), iPlane: i(40), iCollisionBound: i(44), iRenderBound: i(48), iZone: [raw[52], raw[53]],
      numVertices: raw[54], nodeFlags: raw[55], iLeaf: [i(56), i(60)] };
  };
  // A snapshot: per array {num, max, items} where items[i] is the
  // canonical text of element i (raw bytes for nodes).
  function snapshot() {
    const u = words(), b = bytes(), out = {};
    const nodesAt = occlusion.blocks.nodes, nn = h(TRACKER.NODES_NUM);
    out.nodes = { num: nn, max: h(TRACKER.NODES_MAX), raw: b.slice(nodesAt, nodesAt + 64 * nn) };
    const flat = (at, num, size) => u.slice(at >>> 2, (at >>> 2) + size * num);
    out.points = { num: h(TRACKER.POINTS_NUM), max: h(TRACKER.POINTS_MAX), raw: flat(occlusion.blocks.points, h(TRACKER.POINTS_NUM), 3), size: 3 };
    out.vectors = { num: h(TRACKER.VECTORS_NUM), max: h(TRACKER.VECTORS_MAX), raw: flat(tracker.blocks.vectors, h(TRACKER.VECTORS_NUM), 3), size: 3 };
    out.verts = { num: h(TRACKER.VERTS_NUM), max: h(TRACKER.VERTS_MAX), raw: flat(occlusion.blocks.verts, h(TRACKER.VERTS_NUM), 2), size: 2 };
    const top = h(TRACKER.SURFS_TOP) || req.model.surfs.length, sn = h(TRACKER.SURFS_NUM);
    out.surfs = { num: sn, max: h(TRACKER.SURFS_MAX), top, dynamic: [] };
    for (let s = top; s < sn; s++) {
      const o = (tracker.blocks.dsurfs >>> 2) + DSURF.WORDS * (s - top), w = k => u[o + k];
      const pan = w(DSURF.PAN);
      out.surfs.dynamic.push({ texture: w(DSURF.TEXKEY) ? { texture: w(DSURF.TEXKEY) - 1 } : 0, polyFlags: w(DSURF.FLAGS),
        pBase: signed(w(DSURF.PBASE)), vNormal: signed(w(DSURF.VNORMAL)), vTextureU: signed(w(DSURF.VTEXU)),
        vTextureV: signed(w(DSURF.VTEXV)), iLightMap: signed(w(DSURF.LIGHTMAP)), iBrushPoly: signed(w(DSURF.BRUSHPOLY)),
        panU: (pan << 16) >> 16, panV: pan >> 16, actor: ref(w(DSURF.ACTOR)), decals: [0, 0], nodes: [0, 0] });
    }
    if (h(TRACKER.LIVE)) {
      const maps = flat(tracker.blocks.nodeMaps, h(TRACKER.NODEMAPS_NUM), 2);
      out.nodeMaps = { num: h(TRACKER.NODEMAPS_NUM), max: h(TRACKER.NODEMAPS_MAX), raw: maps, size: 2 };
      out.vertOwners = { num: h(TRACKER.OWNERS_NUM), max: h(TRACKER.OWNERS_MAX), raw: flat(tracker.blocks.owners, h(TRACKER.OWNERS_NUM), 1), size: 1 };
      out.pointHelper = { num: h(TRACKER.HELPER_NUM), max: h(TRACKER.HELPER_MAX), raw: flat(tracker.blocks.helper, h(TRACKER.HELPER_NUM), 1), size: 1 };
      out.trackerWords = Array.from({ length: TRACKER.WORDS }, (_, i) => h(i));
    }
    out.movers = {};
    names.forEach((name, i) => {
      const m = tracker.moverWords(i), chain = [], seen = new Set();
      let link = m[MOVER.MOVERLINK] | 0;
      const nodeWords = new Int32Array(kernel.memory.buffer, nodesAt, 16 * nn);
      while (link !== -1 && !seen.has(link) && link >= 0 && link < nn) { seen.add(link); chain.push(link); link = nodeWords[16 * link + 12]; }
      out.movers[name] = { savedPosBits: [...m.slice(MOVER.SAVEDPOS, MOVER.SAVEDPOS + 3)],
        savedRot: [...m.slice(MOVER.SAVEDROT, MOVER.SAVEDROT + 3)].map(signed), flags: m[MOVER.FLAGS],
        locationBits: [...m.slice(MOVER.LOCATION, MOVER.LOCATION + 3)], rotation: [...m.slice(MOVER.ROTATION, MOVER.ROTATION + 3)].map(signed),
        moverLink: chain };
    });
    return out;
  }
  const decodeFlat = (name, raw, i, size) => {
    const e = raw.subarray(size * i, size * (i + 1));
    if (name === 'verts') return [e[0] | 0, e[1] | 0];
    if (name === 'nodeMaps') return [ref(e[0]), e[1] | 0];
    if (name === 'vertOwners' || name === 'pointHelper') return ref(e[0]);
    return [...e];
  };
  function diffFlat(name, before, after) {
    const out = { num: after.num, max: after.max }, changed = [], added = [];
    const common = Math.min(before.num, after.num), s = after.size;
    for (let i = 0; i < common; i++) {
      let same = true;
      for (let k = 0; k < s; k++) if (before.raw[s * i + k] !== after.raw[s * i + k]) { same = false; break; }
      if (!same) changed.push([i, decodeFlat(name, after.raw, i, s)]);
    }
    for (let i = common; i < after.num; i++) added.push([i, decodeFlat(name, after.raw, i, s)]);
    if (changed.length) out.changed = changed;
    if (added.length) out.added = added;
    if (after.num < before.num) out.removed = [after.num, before.num];
    return out;
  }
  function diffNodes(before, after) {
    const out = { num: after.num, max: after.max }, changed = [], flags = [], added = [];
    const common = Math.min(before.num, after.num);
    for (let i = 0; i < common; i++) {
      const o = 64 * i;
      let rest = true, flag = before.raw[o + 55] === after.raw[o + 55];
      for (let k = 0; k < 64 && rest; k++) if (k !== 55 && before.raw[o + k] !== after.raw[o + k]) rest = false;
      if (rest && flag) continue;
      if (rest) flags.push([i, before.raw[o + 55], after.raw[o + 55]]);
      else changed.push([i, node(after.raw.subarray(o, o + 64))]);
    }
    for (let i = common; i < after.num; i++) added.push([i, node(after.raw.subarray(64 * i, 64 * i + 64))]);
    if (changed.length) out.changed = changed;
    if (flags.length) out.flagsChanged = flags;
    if (added.length) out.added = added;
    if (after.num < before.num) out.removed = [after.num, before.num];
    return out;
  }
  function diffSurfs(before, after) {
    const out = { num: after.num, max: after.max }, changed = [], added = [];
    // Static surfaces never change; dynamic ones compare as records.
    const dyn = (snap, i) => (i >= snap.top ? snap.dynamic[i - snap.top] : null);
    const common = Math.min(before.num, after.num);
    for (let i = after.top; i < common; i++)
      if (canonical(dyn(before, i)) !== canonical(dyn(after, i))) changed.push([i, dyn(after, i)]);
    for (let i = common; i < after.num; i++) added.push([i, dyn(after, i)]);
    if (changed.length) out.changed = changed;
    if (added.length) out.added = added;
    if (after.num < before.num) out.removed = [after.num, before.num];
    return out;
  }
  const empty = { num: 0, max: 0, raw: new Uint32Array(0), size: 1 };
  let snap = snapshot();
  return {
    report(step, result) {
      const now = snapshot(), out = { op: step.op };
      if (result !== undefined) out.result = result;
      out.nodes = diffNodes(snap.nodes, now.nodes);
      out.surfs = diffSurfs(snap.surfs, now.surfs);
      for (const name of ['points', 'vectors', 'verts']) out[name] = diffFlat(name, snap[name], now[name]);
      if (now.trackerWords) {
        const w = now.trackerWords;
        out.tracker = { vtable: 0x1042c578, normalBits: w.slice(TRACKER.NORMAL, TRACKER.NORMAL + 3),
          iNodeCursor: w[TRACKER.NODE_CURSOR], iVertCursor: w[TRACKER.VERT_CURSOR], firstDynamicPoint: w[TRACKER.FIRST_POINT],
          originalSurfs: w[TRACKER.SURFS_TOP], originalVectors: w[TRACKER.VECTORS_TOP], originalPoints: w[TRACKER.PTOP],
          originalNodes: w[TRACKER.TOP], originalVerts: w[TRACKER.VTOP], currentActor: ref(w[TRACKER.CURRENT]),
          updateListStale: w[TRACKER.LIST_STALE] !== 0, pointFreeHead: w[TRACKER.FREE_HEAD] | 0 };
        for (const name of ['nodeMaps', 'vertOwners', 'pointHelper'])
          out.tracker[name] = diffFlat(name, snap[name] ?? { ...empty, size: now[name].size }, now[name]);
      }
      const movers = Object.fromEntries(Object.entries(now.movers).filter(([k, v]) => canonical(v) !== canonical(snap.movers[k])));
      if (Object.keys(movers).length) out.movers = movers;
      snap = now;
      return out;
    },
  };
}

/** Run a case's steps on the Rust tracker; `mutate(stepIndex, set)` may
 * alter a step's positions. Returns the reports. */
function runRust(built, req, check, mutate = null) {
  const movers = req.actors.map((a, i) => ({ tag: 0x40000000 + i, flags: a.flags, locationBits: a.locationBits,
    rotation: a.rotation, prePivotBits: a.prePivotBits, mainScale: a.mainScale, postScale: a.postScale,
    specialLit: a.specialLit, polys: a.brush.polys.map(p => ({ ...p, textureKey: p.texture === null ? 0 : p.texture + 1 })) }));
  const occlusion = createBspOcclusion(kernel, built.map.model, { surfaceTextureFlags: [], tracker: { movers } });
  try {
    const reporter = createReporter(occlusion, { ...req, model: built.model });
    const index = new Map(req.actors.map((a, i) => [a.name, i])), t = occlusion.tracker;
    req.steps.forEach((step, k) => {
      const set = mutate ? mutate(k, step.set) : step.set;
      for (const [name, fields] of Object.entries(set ?? {})) t.setMover(index.get(name), fields);
      let result, status = 0;
      if (step.op === 'construct') status = t.construct({ pc64: (step.controlWord ?? 0x037f) === 0x037f });
      else {
        const pc64 = (step.controlWord ?? 0x007f) === 0x037f;
        if (step.op === 'update') status = t.update(step.actor ? index.get(step.actor) : -1, { pc64 });
        else if (step.op === 'frame') {
          req.actors.forEach((a, i) => {
            if (step.actors && !step.actors.includes(a.name)) return;
            if (t.moverWords(i)[MOVER.FLAGS] & 2) return;
            status |= t.update(i, { pc64 });
          });
        } else if (step.op === 'flush') t.flush(index.get(step.actor));
        else if (step.op === 'surfIsDynamic') result = step.iSurfs.map(s => t.surfIsDynamic(s));
        else if (step.op === 'destroy') t.destroy();
        else throw new Error(`Unknown step ${step.op}`);
      }
      assert.equal(status, 0, `step ${k} (${step.op}): tracker status ${status}`);
      check(k, step, reporter.report(step, result), t);
    });
  } finally {
    occlusion.dispose();
  }
}

/** FPoly::Transform's output (Engine 0x10387360, the oracle hooks its return and
 * reads the polygon): for every polygon the step's rebuilds transformed, the
 * last time (a mover pulled into several Updates is rebuilt more than once),
 * the port's exported vertices equal the original's bit for bit and in its
 * order. */
function checkTransforms(where, transforms, t, req) {
  const last = new Map();
  for (const record of transforms) {
    const owner = t.surfOwner(record.iLink);
    assert.ok(owner, `${where}: Transform of iLink ${record.iLink} is a tracker surface`);
    last.set(`${owner.tag - 0x40000000}:${owner.ordinal}`, record);
  }
  const exported = new Map();
  for (const [key, record] of last) {
    const [mover, ordinal] = key.split(':').map(Number);
    if (!exported.has(mover)) exported.set(mover, t.moverPoints(mover, { raw: true }));
    const { points, counts } = exported.get(mover), words = new Uint32Array(points.buffer, points.byteOffset, points.length);
    let start = 0;
    for (let k = 0; k < ordinal; k++) start += counts[k];
    assert.equal(counts[ordinal], record.vertexBits.length, `${where}: ${req.actors[mover].name} polygon ${ordinal}: vertex count`);
    for (let j = 0; j < counts[ordinal]; j++)
      assert.deepEqual([...words.subarray(3 * (start + j), 3 * (start + j) + 3)], record.vertexBits[j].map(v => v >>> 0),
        `${where}: ${req.actors[mover].name} polygon ${ordinal} vertex ${j}`);
    stats.transforms++;
  }
}
const stats = { transforms: 0 };

const sha = text => createHash('sha256').update(text).digest('hex');
const built = new Map();
let cases = 0, steps = 0, full = 0, brief = 0;
const coverage = new Set();
let mutation = null;
for (const c of spec.cases) {
  if (only.size && !only.has(c.id)) continue;
  if (!built.has(c.map)) { built.clear(); built.set(c.map, await buildMap(assets, c.map)); }
  const b = built.get(c.map), req = caseRequest(b, c);
  const t0 = Date.now();
  const oracle = runOracle(python, root, { model: b.model, ...req });
  const oracleMs = Date.now() - t0;
  for (const block of oracle.coverage) coverage.add(block);
  const t1 = Date.now();
  runRust(b, req, (k, step, mine, t) => {
    const o = oracle.results[k];
    checkTransforms(`${c.id} step ${k} (${step.op})`, o.transforms, t, req);
    if (o.brief) {
      mine.newBlocks = o.newBlocks;
      assert.equal(sha(canonical(mine)), o.sha256,
        `${c.id} step ${k} (${step.op}, brief): ${difference(mine, mine) ?? ''}report digest differs`);
      brief++;
    } else {
      const { newBlocks: _, transforms: __, ...want } = o;
      const d = difference(mine, want);
      assert.equal(d, null, `${c.id} step ${k} (${step.op}): ${d}`);
      full++;
    }
    steps++;
  });
  cases++;
  console.log(`${c.id} (${c.map}, ${req.actors.length} movers, ${req.steps.length} steps): equal; oracle ${oracleMs} ms, Rust ${Date.now() - t1} ms`);
  // The mutation check on the first case with a rotating mover's update.
  if (!mutation && c.id === 'club-rotating') {
    const k = req.steps.findIndex((s, i) => i > 0 && s.set && Object.keys(s.set).length);
    const name = Object.keys(req.steps[k].set)[0];
    let detected = false;
    runRust(b, req, (i, step, mine, t) => {
      if (i !== k) return;
      const o = oracle.results[i];
      // One bit of the original's last Transform output flipped must be found.
      const bad = structuredClone(o.transforms);
      bad.at(-1).vertexBits[0][0] ^= 1;
      assert.throws(() => checkTransforms('mutation', bad, t, req), /vertex 0/, `${c.id} step ${k}: a flipped Transform bit went undetected`);
      if (o.brief) { mine.newBlocks = o.newBlocks; detected = sha(canonical(mine)) !== o.sha256; }
      else { const { newBlocks: _, transforms: __, ...want } = o; detected = difference(mine, want) !== null; }
    }, (i, set) => {
      if (i !== k) return set;
      const fields = { ...set[name], locationBits: [...set[name].locationBits] };
      fields.locationBits[0] ^= 1;
      return { ...set, [name]: fields };
    });
    assert.ok(detected, `${c.id} step ${k}: a 1-ulp Location change on ${name} went undetected`);
    mutation = `${c.id} step ${k}: ${name}'s Location.X off by 1 ulp is detected`;
  }
}
console.log(`${cases} cases, ${steps} steps (${full} full reports, ${brief} brief digests) equal to the original; the oracle reached ${coverage.size} tracker blocks`);
console.log(`FPoly::Transform: ${stats.transforms} polygon outputs (the last of each step) equal the original's, bit for bit`);
if (mutation) console.log(`mutation check: ${mutation}`);
console.log('validate-brush-tracker: ok');
