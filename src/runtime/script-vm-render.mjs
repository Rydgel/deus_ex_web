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
 * - the frame's shared pass (`share`): the light, sprite and mesh
 *   consumers' kinds in one walk, which each consumer's own scan then takes
 *   while nothing that scan reads can have changed (below).
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
import {receiverEpoch} from './receiver-epoch.mjs';
import {HandleMirror} from './actor-handle-mirror.mjs';
import {switchReader} from './switch-reader.mjs';

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
  // The noncolliding FarMoveActor (render.rs far_move).
  ['bCollideActors', 'engine.actor.bcollideactors', 'bool'],
  ['bBlockActors', 'engine.actor.bblockactors', 'bool'],
  ['bBlockPlayers', 'engine.actor.bblockplayers', 'bool'],
  ['bCollideWorld', 'engine.actor.bcollideworld', 'bool'],
  ['bCollideWhenPlacing', 'engine.actor.bcollidewhenplacing', 'bool'],
  ['StandingCount', 'engine.actor.standingcount', 'byte'],
  ['Brush', 'engine.actor.brush', 'pointer'],
  ['OldLocation', 'engine.actor.oldlocation', 'vector'],
  ['bJustTeleported', 'engine.actor.bjustteleported', 'bool'],
  // FDynamicSprite::Setup's GetAnimSeq name (actor-mesh-sim.mjs packSetup): the
  // name's word, its folded id (script-name-ids.mjs nameCellWord).
  ['AnimSequence', 'engine.actor.animsequence', 'name'],
  // ULevel::DestroyActor's SetOwner/EndTouch scan (render.rs destroy_scan): a fixed array of four pointers.
  ['Touching', 'engine.actor.touching', 'pointer[4]'],
  // The collision hash's candidate and filter reads (hash.rs image_cylinder, image_accept).
  ['CollisionRadius', 'engine.actor.collisionradius', 'float'],
  ['CollisionHeight', 'engine.actor.collisionheight', 'float'],
  ['bProjTarget', 'engine.actor.bprojtarget', 'bool'],
]);
/** Whether `cell` is of `kind` as render.rs reads it: a scalar or struct
 * kind, or `float[4]` / `pointer[4]`, a fixed array of four contiguous
 * floats or pointers. */
const cellIs = (cell, kind) => kind === 'float[4]' || kind === 'pointer[4]'
  ? cellKind(cell) === 'fixed' && cellKind(cell.element) === kind.slice(0, -3) && cell.element.offset === 0 &&
    cell.stride === 4 && cell.dim === 4
  : cellKind(cell) === kind;
/** Entry kinds: `entry >>> RENDER_SHIFT` is the Level.Actors index, the low
 * bits these. */
/** roster_reads' reasons (render.rs AT_*): the actor is not in Level.Actors, its Mesh is not the binding's, the image does not answer for
 * its reads, its row's handle has been released. */
export const RS_ABSENT = 1, RS_MESH = 2, RS_NOT_OK = 4, RS_STALE = 8;
export const RENDER_LIGHT = 1, RENDER_SPRITE = 2, RENDER_ITERATOR = 4, RENDER_MESH = 8, RENDER_AMBIENT = 16,
  RENDER_JS = 32, RENDER_SHIFT = 6;
/** Input only (render.rs K_THROUGH): an ITERATOR entry does not end the scan. */
const RENDER_THROUGH = 64;
/** The kinds the frame's shared pass serves. */
const SHARED_KINDS = RENDER_LIGHT | RENDER_SPRITE | RENDER_ITERATOR | RENDER_MESH;
const COMPUTED = 0x80000000;

/** 'rust' (default), 'js' or 'verify'. */
export const renderScanMode = switchReader('RENDER_SCAN', 'DEUS_EX_RENDER_SCAN', 'rust');
/** The noncolliding FarMoveActor (render.rs far_move): 'rust' (default),
 * 'js', 'verify', or 'nofit' (the core as it was before it answered FindSpot's point check: a move that needs FindSpot runs in
 * JavaScript; the A/B baseline). */
export const farMoveMode = switchReader('FAR_MOVE', 'DEUS_EX_FAR_MOVE', 'rust');
/** The level loop's passes (level.rs): 'rust' (default), 'js' or 'verify'. */
export const levelScanMode = switchReader('LEVEL_SCAN', 'DEUS_EX_LEVEL_SCAN', 'rust');
/** compactScriptActors' scan for the slots to read (level.rs level_flagged): 'rust' (default), 'js' (every actor's bDeleteMe is read,
 * as before) or 'verify'. */
export const compactScanMode = switchReader('COMPACT_SCAN', 'DEUS_EX_COMPACT_SCAN', 'rust');
/** How the scans ask a bound receiver's binding set about the fields of a question (render.rs and loco.rs `Obj::has`, `vm_has_mode`): 'rust'
 * (default) walks the set bits, 'js' every position of the field table (the reference), 'verify' both, trapping on a difference. */
export const hasScanMode = switchReader('HAS_SCAN', 'DEUS_EX_HAS_SCAN', 'rust');
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
    this.mirror = new HandleMirror();
    this.list = 0;
    this.listCapacity = 0;
    this.out = 0;
    this.outCapacity = 0;
    this.shared = null;
  }
  attach(exports) {
    this.x = exports;
    this.fieldsAt = exports.render_fields_ptr();
    exports.vm_has_mode({js: 1, verify: 2}[hasScanMode()] ?? 0);
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
    // The table first: a class row's word is computed against it (the collision hash asks before any render scan has).
    this.table();
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
    this.mirror.sync(actors);
    this.vm.arena.view.setUint32(this.list, count, true);
    new Uint32Array(this.vm.arena.memory.buffer, this.list + 4, count).set(this.mirror.handles.subarray(0, count));
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
    const entries = this.served(actors, start, kinds, viewer, viewTarget, firstPerson)
      ?? this.walk(actors, start, kinds, viewer, viewTarget, firstPerson);
    if (mode === 'verify') this.verify(actors, entries, {start, kinds, viewer, viewTarget, firstPerson});
    return entries;
  }
  walk(actors, start, kinds, viewer, viewTarget, firstPerson) {
    const list = this.listFor(actors), count = actors.length;
    if (count + 1 > this.outCapacity) {
      if (this.out) this.vm.arena.release(this.out, 4 * this.outCapacity);
      this.outCapacity = Math.max(1024, 2 * (count + 1));
      this.out = this.vm.arena.alloc(4 * this.outCapacity);
    }
    const written = this.x.render_scan(list, start, kinds, viewer ? handleOf(viewer) : 0,
      viewTarget ? handleOf(viewTarget) : 0, firstPerson ? 1 : 0, this.out);
    return new Uint32Array(this.vm.arena.memory.buffer, this.out, written).slice();
  }
  /** The frame's shared pass (sim-session.mjs, before game.movingLights):
   * the moving-light, sprite (with `viewer`, `viewTarget` and
   * `firstPerson`, as the sprite scan passes them) and mesh kinds of every
   * actor of `actors` in one walk, through the iterators. The three
   * consumers run in that order in the frame, each a walk of every actor,
   * cold: one walk reads each actor once. A consumer's scan takes its kinds
   * from it (`served`) once, from index 0, while nothing the walk read can
   * have changed: the same array, length and actorsEpoch, the same
   * receiver epoch and no script body begun since (scriptRuns). The sprite
   * kinds' entries end at the first ITERATOR entry, as a walk of their own
   * does: the sprite scan runs that iterator and walks on from the next
   * actor itself. The other kinds stay: an iterator sprite-scan.mjs runs
   * (ParticleIterator, LaserIterator) writes without script only the
   * iterator, its items' snapshot fields (Location, Rotation, DrawScale,
   * ScaleGlow, through FarMoveActor for particles) and a particle proxy's
   * bHidden, none of which the light or mesh kinds read; any script it runs
   * moves scriptRuns and an actor it spawns moves actorsEpoch. An iterator
   * added there must keep to that. What the image cannot answer stays
   * RENDER_JS, as in a scan of its own (every consumer tests such an actor
   * itself). */
  share(actors, {viewer = null, viewTarget = null, firstPerson = true}) {
    this.shared = null;
    if (renderScanMode() === 'js') return;
    this.table();
    if (!this.complete) return;
    const entries = this.walk(actors, 0, SHARED_KINDS | RENDER_THROUGH, viewer, viewTarget, firstPerson);
    this.shared = {actors, count: actors.length, actorsEpoch: actorsEpoch(), receiverEpoch: receiverEpoch(),
      runs: this.vm.scriptRuns(), viewer, viewTarget, firstPerson, entries, served: 0};
  }
  /** A scan's entries from the shared pass, or null when it cannot serve
   * them (see `share`): what a walk of its own would return. */
  served(actors, start, kinds, viewer, viewTarget, firstPerson) {
    const shared = this.shared;
    if (!shared || start !== 0 || (kinds & ~SHARED_KINDS) || (shared.served & kinds)) return null;
    if (shared.actors !== actors || shared.count !== actors.length || shared.actorsEpoch !== actorsEpoch()
      || shared.receiverEpoch !== receiverEpoch() || shared.runs !== this.vm.scriptRuns()) {
      this.shared = null;
      return null;
    }
    const sprites = kinds & (RENDER_SPRITE | RENDER_ITERATOR);
    if (sprites && (shared.viewer !== viewer || shared.viewTarget !== viewTarget || shared.firstPerson !== firstPerson)) return null;
    shared.served |= kinds;
    const keep = kinds | RENDER_JS, low = (1 << RENDER_SHIFT) - 1, all = shared.entries, out = [];
    for (let i = 0; i < all.length; i++) {
      const bits = all[i] & keep;
      if (!bits) continue;
      out.push((all[i] & ~low) | bits);
      if (bits & RENDER_ITERATOR) break;
    }
    return Uint32Array.from(out);
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
  /** RadiusActors' (mode 1) and VisibleActors' (mode 2) scan in Rust (render.rs area_scan) over `actors` from `start` for class record
   * `base`, Radius `radius` and the point `loc` (both float32 values): {kind (0 exhausted, 1 passed the image's tests, 2 untested),
   * cursor}; the actor passed or untested is actors[cursor - 1]. No script runs. */
  areaScan(actors, start, base, mode, radius, loc) {
    this.table();
    const list = this.listFor(actors);
    this.areaAt ??= this.vm.arena.alloc(32);
    const at = this.areaAt, set = this.vm.arena.view;
    set.setFloat32(at, radius, true);
    set.setFloat32(at + 4, loc[0], true);
    set.setFloat32(at + 8, loc[1], true);
    set.setFloat32(at + 12, loc[2], true);
    this.x.area_scan(list, start, classRecordId(base), mode, at, at + 16);
    const view = this.vm.arena.view;
    return {kind: view.getUint32(at + 16, true), cursor: view.getUint32(at + 20, true)};
  }
  /** DestroyActor's SetOwner/EndTouch scan in Rust (render.rs destroy_scan): from `from`, the first index of `actors` whose
   * actor holds `receiver` as its Owner or in a Touching slot, or that the image cannot answer; `actors.length` when none.
   * No script runs. */
  destroyScan(actors, from, receiver) {
    this.table();
    return this.x.destroy_scan(this.listFor(actors), from, handleOf(receiver));
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
  /** The slots compactScriptActors has to read bDeleteMe of (level.rs level_flagged), as the sorted indices of `actors` from `start`:
   * a null slot, a bDeleteMe actor, an actor the image cannot answer. Every other slot holds an actor whose bDeleteMe is false, so
   * the compaction need not read it. Null when the scan cannot run here (COMPACT_SCAN / ?compactScan= is js, the table is not
   * complete); under =verify each unflagged slot is read as the reference does. */
  compactFlagged(actors, start) {
    const mode = compactScanMode();
    if (mode === 'js' || levelScanMode() === 'js') return null;
    this.table();
    if (!this.complete) return null;
    const list = this.listFor(actors), count = actors.length;
    if (count + 1 > this.outCapacity) {
      if (this.out) this.vm.arena.release(this.out, 4 * this.outCapacity);
      this.outCapacity = Math.max(1024, 2 * (count + 1));
      this.out = this.vm.arena.alloc(4 * this.outCapacity);
    }
    const flagged = this.x.level_flagged(list, start, this.out);
    const indices = new Uint32Array(this.vm.arena.memory.buffer, this.out, flagged).slice();
    if (mode === 'verify') {
      const marked = new Set(indices);
      for (let i = start; i < count; i++)
        if (!marked.has(i) && (!actors[i] || this.runtime.readNamed(actors[i], 'bDeleteMe')))
          throw new Error(`COMPACT_SCAN=verify: Level.Actors[${i}] ${actors[i]?.name} is not flagged in Rust`);
    }
    return indices;
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
  /** A scratch of the arena of at least `bytes` (kept between calls and grown), as {at, bytes}. */
  scratchOf(name, bytes) {
    const held = this[name] ??= {at: 0, bytes: 0};
    if (bytes > held.bytes) {
      if (held.at) this.vm.arena.release(held.at, held.bytes);
      held.bytes = Math.max(4096, 2 * bytes);
      held.at = this.vm.arena.alloc(held.bytes);
    }
    return held;
  }
  /** A power of two of slots for a table of `entries` entries, at most half full. */
  tableSlots(entries) {
    let slots = 256;
    while (slots < 2 * entries) slots *= 2;
    return slots;
  }
  /** The roster pass (render.rs roster_reads) over the `count` rows at `rows`: each row's block as meshReads makes it, and the
   * rows the host must look at, as an array of `row << 4 | reasons` (RS_*), in row order. With `actors` (the Level.Actors array) the
   * rows' positions in it are written too. Null when the pass cannot run here (the mode is js, the table is not complete, the core
   * predates it). */
  rosterReads(rows, count, {player = null, behind = false, viewTarget = null}, actors = null) {
    if (renderScanMode() === 'js' || typeof this.x.roster_reads !== 'function') return null;
    this.table();
    if (!this.complete) return null;
    const list = actors ? this.listFor(actors) : 0, slots = actors ? this.tableSlots(Math.max(actors.length, count)) : 1;
    const scratch = actors ? this.scratchOf('rosterScratch', 8 * slots).at : 0, attn = this.scratchOf('rosterAttn', 4 * (count + 1)).at;
    const n = this.x.roster_reads(rows, count, player ? handleOf(player) : 0, behind ? 1 : 0, viewTarget ? handleOf(viewTarget) : 0,
      list, scratch, slots, attn);
    return new Uint32Array(this.vm.arena.memory.buffer, attn, n).slice();
  }
  /** The main frame's candidate order from the roster (render.rs pack_order): `skip` the rows the iterators stand in for, `extra` the
   * host's items and sprites as [order, class, index] triples (`extraN` of them). Returns {n, refs, words, host} (arena addresses of
   * the entries' references, the room for their candidate words and the host list), or null when the pass cannot run here or a binding's
   * block is not answered by the image. */
  packOrder(rows, count, childFrames, skip, extra, extraN) {
    if (renderScanMode() === 'js' || typeof this.x.pack_order !== 'function') return null;
    this.table();
    if (!this.complete) return null;
    const total = count + extraN;
    const skipAt = this.scratchOf('sPackSkip', 4 * (skip.length + 1)).at, extraAt = this.scratchOf('sPackExtra', 12 * (extraN + 1)).at;
    const sorted = this.scratchOf('sPackSort', 9 * total + 16).at, refs = this.scratchOf('sPackRefs', 4 * (total + 1)).at;
    const words = this.scratchOf('sPackWords', 88 * (total + 1)).at, host = this.scratchOf('sPackHost', 4 * (total + 2)).at;
    if (sorted & 7) throw new Error('pack_order: the sort scratch is not 8-byte aligned');
    const u32 = new Uint32Array(this.vm.arena.memory.buffer);
    u32[skipAt >> 2] = skip.length;
    for (let i = 0; i < skip.length; i++) u32[(skipAt >> 2) + 1 + i] = skip[i];
    u32.set(extra.subarray(0, 3 * extraN), extraAt >> 2);
    const n = this.x.pack_order(rows, count, childFrames ? 1 : 0, skipAt, extraAt, extraN, sorted, refs);
    if ((n | 0) === -1) return null;   // (PACK_HOST: a wasm u32 result is a signed number here)
    return {n, refs, words, host};
  }
  /** The candidate words of the binding entries of a packOrder (render.rs pack_words); the host list at `order.host` names the entries
   * whose words the host makes. */
  packWords(rows, order) {
    this.x.pack_words(rows, order.refs, order.n, order.words, order.host);
  }
  /** The rows' positions in `actors` alone (render.rs roster_positions); false when the pass cannot run here. */
  rosterPositions(rows, count, actors) {
    if (renderScanMode() === 'js' || typeof this.x.roster_positions !== 'function') return false;
    this.table();
    if (!this.complete) return false;
    const list = this.listFor(actors), slots = this.tableSlots(Math.max(actors.length, count));
    this.x.roster_positions(rows, count, list, this.scratchOf('rosterScratch', 8 * slots).at, slots);
    return true;
  }
  /** The mesh entries of the admission scan (the frame's shared walk when it serves it, else a walk of its own) without those render.rs
   * admit_filter knows the layer's admit would turn away without effect (a row's actor, one drawnInWorld rejects), as an array of
   * `index << RENDER_SHIFT | kinds`; null when the pass cannot run here. */
  admitScan(actors, rows, count, {player = null, behind = false, viewTarget = null, childFrames = false}) {
    if (renderScanMode() === 'js' || typeof this.x.admit_filter !== 'function') return null;
    this.table();
    if (!this.complete) return null;
    // what `served` checks for a consumer of the mesh kind alone
    const shared = this.shared;
    let all = null;
    if (shared) {
      if (shared.actors === actors && shared.count === actors.length && shared.actorsEpoch === actorsEpoch()
        && shared.receiverEpoch === receiverEpoch() && shared.runs === this.vm.scriptRuns()) {
        if (!(shared.served & RENDER_MESH)) { shared.served |= RENDER_MESH; all = shared.entries; }
      } else this.shared = null;
    }
    if (!all) all = this.walk(actors, 0, RENDER_MESH, null, null, true);
    const list = this.listFor(actors), slots = this.tableSlots(count);
    const scratch = this.scratchOf('admitScratch', 8 * slots).at, input = this.scratchOf('admitIn', 4 * (all.length + 1)).at;
    const output = this.scratchOf('admitOut', 4 * (all.length + 1)).at;
    new Uint32Array(this.vm.arena.memory.buffer, input, all.length).set(all);
    const n = this.x.admit_filter(list, input, all.length, RENDER_MESH | RENDER_JS, rows, count, player ? handleOf(player) : 0, behind ? 1 : 0,
      viewTarget ? handleOf(viewTarget) : 0, childFrames ? 1 : 0, scratch, slots, output);
    return new Uint32Array(this.vm.arena.memory.buffer, output, n).slice();
  }
  /** SetupDynamics' moving brushes' reads (render.rs mover_reads) into each block of the `count` (handle, block) pairs at `pairs`
   * (status, Location, Rotation words); false when they cannot run here (the mode is js, the table is not complete, the core
   * predates them). */
  moverReads(pairs, count, {viewer = null, viewTarget = null, behind = false}) {
    if (renderScanMode() === 'js' || typeof this.x.mover_reads !== 'function') return false;
    this.table();
    if (!this.complete) return false;
    this.x.mover_reads(pairs, count, viewer ? handleOf(viewer) : 0, viewTarget ? handleOf(viewTarget) : 0, behind ? 1 : 0);
    return true;
  }
  /** Whether the field table is complete, so `farMove` and the particle loop may address an actor's image. */
  ready() {
    this.table();
    return this.complete;
  }
  /** FarMoveActor(actor, destination, Test 0, `noCheck`) in Rust
   * (render.rs far_move) over the zone `model` and the world BSP `world`
   * (trace-kernel.mjs base, 0 for none): 1 when it moved the actor, 2 when
   * FindSpot refused it (the original's false; nothing was stored), 0 when
   * the JavaScript body must run (nothing was stored). */
  farMove(actor, destination, noCheck, model, world = 0) {
    if (!this.ready()) return 0;
    return this.x.far_move(handleOf(actor), model, bitsOf(destination[0]), bitsOf(destination[1]), bitsOf(destination[2]),
      noCheck ? 1 : 0, world);
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
