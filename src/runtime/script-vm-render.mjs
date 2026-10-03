/**
 * The host half of the render scan (native/script-vm/src/render.rs,
 * docs/play-cpu-plan.md Phase 2): one filter over Level.Actors read from the
 * object image for the viewer's per-frame consumers (game.movingLights, the
 * sprite scene, the actor mesh admission). Host bookkeeping, not an original
 * structure. This module owns:
 *
 * - the field table (R_FIELDS): each field's offset, bool mask and key id,
 *   from the cell registry, checked against the kind render.rs reads;
 * - each class row's render word (after its locomotion word): which fields
 *   `readNamed` resolves, for that class, to the key and cell the table
 *   describes, with bit 31 set once computed;
 * - the [count, handle...] list of a Level.Actors array, rebuilt when the
 *   array, its length or actorsEpoch (base-epoch.mjs) changes.
 *
 * RENDER_SCAN=js in Node or ?renderScan=js in the viewer keeps every
 * consumer's JavaScript loop; RENDER_SCAN=verify (?renderScan=verify)
 * scans in Rust and also evaluates every actor the scan covered with
 * `referenceKinds`, the consumers' own tests through readNamed, and throws
 * on a difference.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell} from './script-object-image.mjs';
import {classRecordId, fieldKeyId} from './script-vm-lower.mjs';
import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {actorsEpoch} from './base-epoch.mjs';

/** The fields render.rs reads (R_*), in index order: [spelling, key, kind]. */
export const RENDER_FIELDS = Object.freeze([
  ['bHidden', 'engine.actor.bhidden', 'bool'],
  ['bDeleteMe', 'engine.actor.bdeleteme', 'bool'],
  ['Mesh', 'engine.actor.mesh', 'pointer'],
  ['DrawType', 'engine.actor.drawtype', 'byte'],
  ['Owner', 'engine.actor.owner', 'pointer'],
  ['bOnlyOwnerSee', 'engine.actor.bonlyownersee', 'bool'],
  ['bOwnerNoSee', 'engine.actor.bownernosee', 'bool'],
  ['RenderIteratorClass', 'engine.actor.renderiteratorclass', 'pointer'],
  ['LightType', 'engine.actor.lighttype', 'byte'],
  ['bStatic', 'engine.actor.bstatic', 'bool'],
  ['bNoDelete', 'engine.actor.bnodelete', 'bool'],
  ['bDynamicLight', 'engine.actor.bdynamiclight', 'bool'],
  ['LightBrightness', 'engine.actor.lightbrightness', 'byte'],
  ['LightRadius', 'engine.actor.lightradius', 'byte'],
  // The mesh-light selection's light fields (meshlight.rs).
  ['LightEffect', 'engine.actor.lighteffect', 'byte'],
  ['bMovable', 'engine.actor.bmovable', 'bool'],
  ['bSpecialLit', 'engine.actor.bspeciallit', 'bool'],
  ['Location', 'engine.actor.location', 'vector'],
  // Galaxy Update's ambient scan.
  ['AmbientSound', 'engine.actor.ambientsound', 'pointer'],
  // The level loop (level.rs).
  ['DistanceFromPlayer', 'engine.actor.distancefromplayer', 'float'],
  // The mesh scene's reads (render.rs mesh_reads).
  ['PrePivot', 'engine.actor.prepivot', 'vector'],
  ['DrawScale', 'engine.actor.drawscale', 'float'],
  ['Style', 'engine.actor.style', 'byte'],
  ['ScaleGlow', 'engine.actor.scaleglow', 'float'],
  ['bAnimByOwner', 'engine.actor.banimbyowner', 'bool'],
  ['bParticles', 'engine.actor.bparticles', 'bool'],
  ['Rotation', 'engine.actor.rotation', 'rotator'],
  ['AnimFrame', 'engine.actor.animframe', 'float'],
  // A fixed array of four floats, read element by element.
  ['BlendAnimFrame', 'engine.actor.blendanimframe', 'float[4]'],
  // SetupForActor's reads (mesh-lighting-view.mjs setupMesh). A struct
  // member is [spelling, struct key, member kind, member key]: its entry is
  // the member's offset, and its binding test is the struct's key.
  ['Region.Zone', 'engine.actor.region', 'pointer', 'engine.actor.pointregion.zone'],
  ['Region.iLeaf', 'engine.actor.region', 'int', 'engine.actor.pointregion.ileaf'],
  ['Region.ZoneNumber', 'engine.actor.region', 'byte', 'engine.actor.pointregion.zonenumber'],
  ['AmbientGlow', 'engine.actor.ambientglow', 'byte'],
  ['bNoSmooth', 'engine.actor.bnosmooth', 'bool'],
  ['bMeshEnviroMap', 'engine.actor.bmeshenviromap', 'bool'],
  ['bMeshCurvy', 'engine.actor.bmeshcurvy', 'bool'],
  ['bUnlit', 'engine.actor.bunlit', 'bool'],
]);
/** Whether `cell` is of `kind` as render.rs reads it: a scalar or struct
 * kind, or `float[4]`, a fixed array of four contiguous floats. */
const cellIs = (cell, kind) => kind === 'float[4]'
  ? cellKind(cell) === 'fixed' && cellKind(cell.element) === 'float' && cell.element.offset === 0 &&
    cell.stride === 4 && cell.dim === 4
  : cellKind(cell) === kind;
/** Entry kinds: `entry >>> RENDER_SHIFT` is the Level.Actors index, the low
 * bits these. */
export const RENDER_LIGHT = 1, RENDER_SPRITE = 2, RENDER_ITERATOR = 4, RENDER_MESH = 8, RENDER_AMBIENT = 16,
  RENDER_JS = 32, RENDER_SHIFT = 6;
const COMPUTED = 0x80000000;

/** 'rust' (default), 'js' or 'verify'. */
export const renderScanMode = () => (typeof process !== 'undefined' && process.env?.RENDER_SCAN)
  || globalThis.DEUS_EX_RENDER_SCAN || 'rust';
/** The level loop's passes (level.rs): 'rust' (default), 'js' or 'verify'. */
export const levelScanMode = () => (typeof process !== 'undefined' && process.env?.LEVEL_SCAN)
  || globalThis.DEUS_EX_LEVEL_SCAN || 'rust';
const f32Bits = new DataView(new ArrayBuffer(4));
const bitsOf = value => { f32Bits.setFloat32(0, value, true); return f32Bits.getUint32(0, true); };

export class RenderScanHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.expected = null;
    this.tableVersion = -1;
    this.complete = false;
    this.bits = new WeakMap();
    this.listKey = null;
    this.list = 0;
    this.listCapacity = 0;
    this.out = 0;
    this.outCapacity = 0;
  }
  attach(exports) {
    this.x = exports;
    this.fieldsAt = exports.render_fields_ptr();
  }
  /** The row's first render word address: after its names, the two
   * perception words and the locomotion word; the second follows it. */
  wordAt(address) {
    return address + 8 + 8 * this.vm.arena.view.getUint32(address + 4, true) + 12;
  }
  /** Fill the table's missing entries from the registry when it changed. An
   * added entry recomputes every class row's render word. */
  table() {
    if (this.complete) return;
    const version = fieldImageCellVersion();
    if (this.tableVersion === version) return;
    this.tableVersion = version;
    const view = this.vm.arena.view, expected = this.expected ??= RENDER_FIELDS.map(() => null);
    let added = false;
    RENDER_FIELDS.forEach(([, key, kind, member], index) => {
      if (expected[index]) return;
      const cell = fieldImageCell(key);
      const target = member ? cellKind(cell) === 'struct' && cell.members.find(item => item.key === member) : cell;
      if (!target || !cellIs(target, kind)) return;
      expected[index] = cell;
      added = true;
      const at = this.fieldsAt + 12 * index;
      view.setUint32(at, member ? cell.offset + target.offset : cell.offset, true);
      view.setUint32(at + 4, target.mask >>> 0, true);
      view.setUint32(at + 8, fieldKeyId(key), true);
    });
    if (!added) return;
    this.bits = new WeakMap();
    for (const {address} of this.vm.rows.values()) {
      view.setUint32(this.wordAt(address), 0, true);
      view.setUint32(this.wordAt(address) + 4, 0, true);
    }
    this.complete = !expected.includes(null);
  }
  /** A class's two render words: field i is set when `lookupMember` on
   * `cls` resolves the spelling to the key and the instance reads a cell the
   * table describes (fields 0..30 in the first word with COMPUTED, 31..62
   * in the second). */
  classBits(cls, cells) {
    let bits = this.bits.get(cls);
    if (bits !== undefined) return bits;
    let low = COMPUTED, high = 0;
    const expected = this.expected ?? [];
    RENDER_FIELDS.forEach(([name, key], index) => {
      if (!expected[index] || !cells) return;
      let field;
      try { field = this.runtime.lookupMember(cls, 'fields', name.split('.')[0]); } catch { return; }
      if (field?.key !== key || !sameCell(cells.get(key), expected[index])) return;
      if (index < 31) low |= 1 << index; else high |= 1 << (index - 31);
    });
    bits = [low >>> 0, high >>> 0];
    this.bits.set(cls, bits);
    return bits;
  }
  /** js_render_class (no script runs). */
  classWord(handle) {
    const vm = this.vm, address = vm.classRow(handle);
    if (!address) return;
    const identity = identityOfHandle(handle), runtime = this.runtime;
    const instance = identity[runtime.instanceKey] ?? runtime.instances.get(identity);
    const [low, high] = this.classBits(instance.cls, instance.cells), at = this.wordAt(address);
    vm.arena.view.setUint32(at, low, true);
    vm.arena.view.setUint32(at + 4, high, true);
  }
  imports() {
    return {js_render_class: handle => this.classWord(handle)};
  }
  /** The [count, handle...] list of `actors`, kept per array, length and
   * actorsEpoch: every structural change of a Level.Actors array advances
   * that epoch. */
  listFor(actors) {
    const count = actors.length, epoch = actorsEpoch(), key = this.listKey;
    if (key && key.actors === actors && key.count === count && key.epoch === epoch) return this.list;
    const bytes = 4 + 4 * count;
    if (bytes > this.listCapacity) {
      if (this.list) this.vm.arena.release(this.list, this.listCapacity);
      this.listCapacity = Math.max(4096, bytes * 2);
      this.list = this.vm.arena.alloc(this.listCapacity);
    }
    const view = this.vm.arena.view;
    view.setUint32(this.list, count, true);
    for (let i = 0; i < count; i++) view.setUint32(this.list + 4 + 4 * i, actors[i] ? handleOf(actors[i]) : 0, true);
    this.listKey = {actors, count, epoch};
    return this.list;
  }
  /** The entries of `actors` from `start` for `kinds` (RENDER_*), or null
   * when the scan cannot run here (the mode is js, or the table is not
   * complete). `viewer` and `viewTarget` are objects (or null). */
  scan(actors, {start = 0, kinds, viewer = null, viewTarget = null, firstPerson = true}) {
    const mode = renderScanMode();
    if (mode === 'js') return null;
    this.table();
    if (!this.complete) return null;
    const list = this.listFor(actors), count = actors.length;
    if (count + 1 > this.outCapacity) {
      if (this.out) this.vm.arena.release(this.out, 4 * this.outCapacity);
      this.outCapacity = Math.max(1024, 2 * (count + 1));
      this.out = this.vm.arena.alloc(4 * this.outCapacity);
    }
    const written = this.x.render_scan(list, start, kinds, viewer ? handleOf(viewer) : 0,
      viewTarget ? handleOf(viewTarget) : 0, firstPerson ? 1 : 0, this.out);
    const entries = new Uint32Array(this.vm.arena.memory.buffer, this.out, written).slice();
    if (mode === 'verify') this.verify(actors, entries, {start, kinds, viewer, viewTarget, firstPerson});
    return entries;
  }
  /** CycleActors' scan step in Rust (render.rs cycle_scan) over `actors`
   * for class record `base`: {kind (0 exhausted, 1 found, 2 untested),
   * cursor, steps}; the actor found or untested is actors[cursor - 1]. */
  cycleScan(actors, cursor, steps, bound, base) {
    const list = this.listFor(actors);
    this.cycleOut ??= this.vm.arena.alloc(16);
    this.x.cycle_scan(list, cursor, steps, bound, classRecordId(base), this.cycleOut);
    const view = this.vm.arena.view, at = this.cycleOut;
    return {kind: view.getUint32(at, true), cursor: view.getUint32(at + 4, true), steps: view.getUint32(at + 8, true)};
  }
  /** tickStandaloneLevel's DistanceFromPlayer pass (level.rs
   * level_distance) over `actors` from `start` for the player's Location
   * `origin`: the indices the image could not answer, which the caller
   * computes in order, or null when the pass cannot run here (the mode is
   * js, the table is not complete, a non-finite origin). `reference(actor)`
   * is the caller's own distance, compared under LEVEL_SCAN=verify. */
  playerDistances(actors, start, origin, reference) {
    const mode = levelScanMode();
    if (mode === 'js' || !origin.every(Number.isFinite)) return null;
    this.table();
    if (!this.complete) return null;
    const list = this.listFor(actors), count = actors.length;
    if (count + 1 > this.outCapacity) {
      if (this.out) this.vm.arena.release(this.out, 4 * this.outCapacity);
      this.outCapacity = Math.max(1024, 2 * (count + 1));
      this.out = this.vm.arena.alloc(4 * this.outCapacity);
    }
    const handed = this.x.level_distance(list, start, bitsOf(origin[0]), bitsOf(origin[1]), bitsOf(origin[2]), this.out);
    const indices = new Uint32Array(this.vm.arena.memory.buffer, this.out, handed).slice();
    if (mode === 'verify') {
      const back = new Set(indices);
      for (let i = start; i < count; i++) {
        if (!actors[i] || back.has(i)) continue;
        const got = this.runtime.readNamed(actors[i], 'DistanceFromPlayer'), want = reference(actors[i]);
        if (bitsOf(got) !== bitsOf(want))
          throw new Error(`LEVEL_SCAN=verify: ${actors[i].name} DistanceFromPlayer is ${got} in Rust, ${want} by playerDistance`);
      }
    }
    return indices;
  }
  /** Whether compactScriptActors would change nothing (level.rs
   * level_settled): true only when no slot of `actors` from `start` is null
   * and no actor is bDeleteMe, read in the image. */
  compactSettled(actors, start) {
    const mode = levelScanMode();
    if (mode === 'js') return false;
    this.table();
    if (!this.complete) return false;
    const settled = this.x.level_settled(this.listFor(actors), start) === 1;
    if (settled && mode === 'verify')
      for (let i = start; i < actors.length; i++)
        if (!actors[i] || this.runtime.readNamed(actors[i], 'bDeleteMe'))
          throw new Error(`LEVEL_SCAN=verify: Level.Actors[${i}] ${actors[i]?.name} is settled in Rust`);
    return settled;
  }
  /** The mesh scene's per-actor reads (render.rs mesh_reads) into each
   * block of the `count` (handle, block) pairs at `pairs`; false when they
   * cannot run here (the mode is js, the table is not complete). */
  meshReads(pairs, count, {player = null, behind = false, viewTarget = null}) {
    if (renderScanMode() === 'js') return false;
    this.table();
    if (!this.complete) return false;
    this.x.mesh_reads(pairs, count, player ? handleOf(player) : 0, behind ? 1 : 0, viewTarget ? handleOf(viewTarget) : 0);
    return true;
  }
  /** RENDER_SCAN=verify: every actor the scan covered against
   * referenceKinds. */
  verify(actors, entries, view) {
    const last = entries.length && entries[entries.length - 1] & RENDER_ITERATOR ? entries[entries.length - 1] >>> RENDER_SHIFT : actors.length - 1;
    const byIndex = new Map([...entries].map(entry => [entry >>> RENDER_SHIFT, entry & (1 << RENDER_SHIFT) - 1]));
    for (let i = view.start; i <= last; i++) {
      const got = byIndex.get(i) ?? 0;
      if (got & RENDER_JS) continue;
      const want = referenceKinds(this.runtime, actors[i], view);
      if (want !== got)
        throw new Error(`RENDER_SCAN=verify: Level.Actors[${i}] ${actors[i]?.name} is ${got} in Rust, ${want} by readNamed`);
    }
  }
}

/** The consumers' own tests on one actor through readNamed: game.movingLights'
 * gate, sprite-scene.mjs update's admission, the mesh admission's live Mesh
 * and Galaxy Update's live AmbientSound. Any throw makes the consumer's own loop decide (RENDER_JS). */
export function referenceKinds(runtime, actor, {kinds, viewer = null, viewTarget = null, firstPerson = true}) {
  if (!actor) return 0;
  const read = name => runtime.readNamed(actor, name);
  try {
    let bits = 0;
    if (kinds & RENDER_LIGHT && read('LightType') && !read('bDeleteMe') &&
      !((read('bStatic') || read('bNoDelete')) && !read('bDynamicLight')) && read('LightBrightness') && read('LightRadius'))
      bits |= RENDER_LIGHT;
    if (kinds & RENDER_MESH && read('Mesh')) bits |= RENDER_MESH;
    if (kinds & RENDER_AMBIENT && read('AmbientSound')) bits |= RENDER_AMBIENT;
    if (kinds & (RENDER_SPRITE | RENDER_ITERATOR) && actor !== viewer) bits |= spriteKind() & kinds;
    return bits;
  } catch {
    return RENDER_JS;
  }
  function spriteKind() {
    if (read('bHidden')) return 0;
    if (firstPerson && viewTarget === actor) return 0;
    if (read('bOnlyOwnerSee')) {
      let owned = false;
      for (let owner = actor; owner; owner = runtime.readNamed(owner, 'Owner')) if (owner === viewer) { owned = true; break; }
      if (!owned || !firstPerson) return 0;
    }
    if (read('bOwnerNoSee') && firstPerson && read('Owner') === viewer) return 0;
    if (read('RenderIteratorClass')) return RENDER_ITERATOR;
    const drawType = read('DrawType') & 255;
    return drawType === 1 || drawType === 7 ? RENDER_SPRITE : 0;
  }
}
