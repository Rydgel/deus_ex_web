/** Callback-free spawned rider MoveActor over authoritative image fields.
 * Original contract and focused native evidence: docs/rider-move-kernel.md.
 * Every refusal leaves the actor untouched for playerMove. Map/player views
 * and bound Touching are deliberately ineligible. No native event is skipped:
 * a prospective zone change is handed back before the first actor store.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell} from './script-object-image.mjs';
import {playerMove} from './player-move.mjs';
import {setActorZone} from './zone.mjs';

const env = typeof process !== 'undefined' ? process.env ?? {} : {};
const DISABLED = env.MOVE_RIDER_KERNEL === 'js' || globalThis.DEUS_EX_MOVE_RIDER_KERNEL === 'js';
const DIFFERENTIAL = env.MOVE_RIDER_DIFFERENTIAL === '1';
const counts = {calls: 0, tiny: 0};
if (DIFFERENTIAL) process.on('exit', () => process.stderr.write(`rider differential: ${JSON.stringify(counts)}\n`));

// The field order is the ABI shared with native/script-vm/src/move_actor.rs.
export const MOVE_FIELDS = [
  ['bStatic', 'bool'], ['bMovable', 'bool'], ['bCollideActors', 'bool'], ['bCollideWorld', 'bool'],
  ['bBlockActors', 'bool'], ['bBlockPlayers', 'bool'], ['bDeleteMe', 'bool'], ['StandingCount', 'byte'],
  ['Touching', 'fixed'], ['Location', 'vector'], ['Rotation', 'rotator'],
  ['CollisionRadius', 'float'], ['CollisionHeight', 'float'], ['Region', 'struct'], ['Brush', 'pointer'],
].map(([name, kind]) => [name, `engine.actor.${name.toLowerCase()}`, kind]);
const int32 = v => Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff;

export class MoveActorHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.version = -1;
    this.classes = new Map();
    this.instances = new WeakMap();
  }
  attach(x) { this.x = x; this.fieldsAt = x.move_rider_fields_ptr(); }
  table() {
    const version = fieldImageCellVersion();
    if (version === this.version) return;
    this.version = version;
    this.classes.clear();
    this.instances = new WeakMap();
    this.pawnClasses?.clear();
    this.pawnInstances = new WeakMap();
    this.vm.zone.table();
    this.members = this.vm.zone.members;
    this.cells = MOVE_FIELDS.map(([, key, kind]) => {
      const cell = fieldImageCell(key);
      return cellKind(cell) === kind ? cell : null;
    });
    const touch = this.cells[8];
    this.valid = !this.cells.includes(null) && this.members !== null &&
      this.cells[7].mask === 0 && this.members[2].mask === 0 &&
      touch.dim === 4 && touch.stride === 4 && cellKind(touch.element) === 'pointer' && touch.element.offset === 0;
    if (!this.valid) return;
    const view = this.vm.arena.view;
    this.cells.forEach((cell, i) => {
      view.setUint32(this.fieldsAt + i * 8, cell.offset, true);
      view.setUint32(this.fieldsAt + i * 8 + 4, cell.mask >>> 0, true);
    });
    this.members.forEach((member, i) => view.setUint32(this.fieldsAt + 120 + i * 4, member.offset, true));
  }
  eligible(instance) {
    const {cls, cells, fieldTable: names} = instance;
    let info = this.classes.get(cls);
    if (!info || info.names !== names.size) {
      let ok = this.valid;
      for (let c = cls; c; c = c.base)
        if (c.record?.key === 'engine.pawn' || c.record?.key === 'engine.brush') ok = false;
      for (let i = 0; ok && i < MOVE_FIELDS.length; i++) {
        const [name, key] = MOVE_FIELDS[i];
        let field;
        try { field = this.runtime.lookupMember(cls, 'fields', name); } catch { ok = false; break; }
        const cached = names.get(name);
        const cell = cached === undefined ? cells.get(key) : cached?.field === field ? cached.cell : null;
        if (field?.key !== key || !sameCell(cell, this.cells[i])) ok = false;
      }
      this.classes.set(cls, info = {names: names.size, ok});
    }
    if (!info.ok) return false;
    let entry = this.instances.get(instance);
    // Runtime bindings only add or replace keys (bindProperty/window host).
    // Replacement cannot change eligibility; adding a key changes size.
    if (!entry || entry.info !== info || entry.bindings !== instance.bindings.size) {
      const ok = MOVE_FIELDS.every(([, key]) => !instance.bindings.has(key));
      this.instances.set(instance, entry = {info, bindings: instance.bindings.size, ok});
    }
    return entry.ok;
  }
  /** The same field-table admission for the pawn MoveActor
   * (move-pawn-kernel.mjs, B4): the source must be a Pawn and not a Brush,
   * and every MOVE_FIELDS spelling must resolve to the table's cell with no
   * binding on the receiver. */
  eligiblePawn(instance) {
    const {cls, cells, fieldTable: names} = instance;
    this.pawnClasses ??= new Map();
    this.pawnInstances ??= new WeakMap();
    let info = this.pawnClasses.get(cls);
    if (!info || info.names !== names.size) {
      let ok = this.valid, pawn = false;
      for (let c = cls; c; c = c.base) {
        if (c.record?.key === 'engine.pawn') pawn = true;
        if (c.record?.key === 'engine.brush') ok = false;
      }
      if (!pawn) ok = false;
      for (let i = 0; ok && i < MOVE_FIELDS.length; i++) {
        const [name, key] = MOVE_FIELDS[i];
        let field;
        try { field = this.runtime.lookupMember(cls, 'fields', name); } catch { ok = false; break; }
        const cached = names.get(name);
        const cell = cached === undefined ? cells.get(key) : cached?.field === field ? cached.cell : null;
        if (field?.key !== key || !sameCell(cell, this.cells[i])) ok = false;
      }
      this.pawnClasses.set(cls, info = {names: names.size, ok});
    }
    if (!info.ok) return false;
    let entry = this.pawnInstances.get(instance);
    if (!entry || entry.info !== info || entry.bindings !== instance.bindings.size) {
      const ok = MOVE_FIELDS.every(([, key]) => !instance.bindings.has(key));
      this.pawnInstances.set(instance, entry = {info, bindings: instance.bindings.size, ok});
    }
    return entry.ok;
  }
  rider(receiver, level, delta, rotation) {
    if (DISABLED || !this.vm.zone.enabled || !level.zoneModel) return undefined;
    const runtime = this.runtime, instance = receiver?.[runtime.instanceKey] ?? runtime.instances.get(receiver);
    if (!instance?.cells || !instance.base || instance.arena !== this.vm.arena ||
      instance.poison?.size || instance.imageToken?.released || instance.nativeObject?.released) return undefined;
    // Only the spawned collision-view entry calls this host. Immutable class
    // traits are checked again here; no getter-backed flags are read in JS.
    if (!receiver.scriptView || receiver.pawn || receiver.movingBrush || receiver.model) return undefined;
    // (indexed tests: an every() with its callback, and a spread call below, each made an object per call)
    if (!Array.isArray(delta) || delta.length !== 3 || typeof delta[0] !== 'number' || typeof delta[1] !== 'number' || typeof delta[2] !== 'number' ||
      !Array.isArray(rotation) || rotation.length !== 3 || !int32(rotation[0]) || !int32(rotation[1]) || !int32(rotation[2])) return undefined;
    this.table();
    if (!this.eligible(instance)) return undefined;
    const model = this.vm.zone.model(level);
    if (!model) return undefined;
    const before = DIFFERENTIAL ? this.snapshot(receiver) : null;
    const code = this.x.move_rider(instance.base, model, delta[0], delta[1], delta[2], rotation[0], rotation[1], rotation[2]);
    if (!code) return undefined;
    const view = this.vm.arena.view, at = instance.base + this.cells[9].offset;
    const result = {success: true, delta: code === 1 ? [0, 0, 0] : [Math.fround(delta[0]), Math.fround(delta[1]), Math.fround(delta[2])],
      position: [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)],
      time: 1, hit: null};
    if (DIFFERENTIAL) this.verify(receiver, level, delta, rotation, before, result, code);
    return result;
  }
  snapshot(receiver) {
    const read = name => this.runtime.readNamed(receiver, name);
    return {position: read('Location'), rotation: read('Rotation'), oldLocation: read('OldLocation'),
      region: this.runtime.regionValue(receiver, 'Region'), deleted: read('bDeleteMe'),
      radius: read('CollisionRadius'), height: read('CollisionHeight')};
  }
  verify(receiver, level, delta, rotation, before, result, code) {
    const source = {...before, scriptView: true, pawn: false, isPawn: false, static: false, movable: true,
      flags: 0, standingCount: 0, touching: [null, null, null, null]};
    const unexpected = () => { throw Error('Rider differential: unexpected query or event'); };
    let zones = 0, encroachments = 0;
    const expected = playerMove(source, delta, {
      worldActor: level.worldActor, multiLineCheck: unexpected, removeActor: unexpected, addActor: unexpected,
      dispatch: unexpected, isBlockedBy: unexpected, isOverlapping: unexpected, beginTouch: unexpected,
      endTouch: unexpected, moveRiders: unexpected, ignoreBases: true,
      checkEncroachment: () => { encroachments++; return false; },
      setActorZone: (actor, test, force) => { zones++; setActorZone(actor, {
        pointRegion: p => level.pointRegion(p), actorLeaving: unexpected, zoneChange: unexpected, actorEntered: unexpected,
      }, test, force); },
    }, rotation);
    const after = this.snapshot(receiver);
    const equalArray = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const same = equalArray(after.position, source.position) && equalArray(after.rotation, source.rotation) &&
      equalArray(after.oldLocation, source.oldLocation) && after.region.zone === source.region.zone &&
      after.region.leaf === source.region.leaf && after.region.zoneNumber === source.region.zoneNumber &&
      equalArray(result.position, expected.position) && equalArray(result.delta, expected.delta) &&
      result.success === expected.success && result.time === expected.time && result.hit === expected.hit &&
      zones === (code === 1 ? 0 : 1) && encroachments === zones;
    if (!same) throw Error(`Rider differential mismatch for ${receiver.name}`);
    counts.calls++; if (code === 1) counts.tiny++;
  }
}
