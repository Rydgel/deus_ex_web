/**
 * The host half of the Rust latent polls (docs/rust-core.md "October 1:
 * latent polls", native/script-vm/src/loco.rs): the pawn locomotion polls
 * MoveTo 501, MoveToward 503, TurnTo 509, TurnToward 511 and
 * WaitForLanding 528 run in the interpreter on the pawns' images. Host
 * bookkeeping, not an original structure. This module owns what Rust
 * cannot know by itself:
 *
 * - the field table (L_FIELDS): each field's offset, bool mask and key id,
 *   from the cell registry, checked against the kind the Rust bodies read;
 *   L_NAMES[2] is set once every field is in it;
 * - each class row's locomotion word (after its perception words): which
 *   fields the pawn view (`namedReference`) and `readNamed` resolve, for
 *   that class, to the key and cell the table describes, with bit 31 set
 *   once computed;
 * - the folded name ids of `pawn` and `inventory` for locomotionServices'
 *   name-based isA.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell} from './script-object-image.mjs';
import {fieldKeyId} from './script-vm-lower.mjs';
import {foldedNameId} from './script-name-ids.mjs';
import {identityOfHandle} from './script-object-handles.mjs';

/** The fields the Rust polls read or write (loco.rs L_*), in index order:
 * [the spelling the pawn view reads, key, cell kind]. */
export const LOCO_FIELDS = Object.freeze([
  ['Physics', 'engine.actor.physics', 'byte'],
  ['Location', 'engine.actor.location', 'vector'],
  ['Velocity', 'engine.actor.velocity', 'vector'],
  ['Acceleration', 'engine.actor.acceleration', 'vector'],
  ['Rotation', 'engine.actor.rotation', 'rotator'],
  ['DesiredRotation', 'engine.actor.desiredrotation', 'rotator'],
  ['Destination', 'engine.pawn.destination', 'vector'],
  ['Focus', 'engine.pawn.focus', 'vector'],
  ['MoveTimer', 'engine.pawn.movetimer', 'float'],
  ['DesiredSpeed', 'engine.pawn.desiredspeed', 'float'],
  ['AccelRate', 'engine.pawn.accelrate', 'float'],
  ['AvgPhysicsTime', 'engine.pawn.avgphysicstime', 'float'],
  ['CollisionRadius', 'engine.actor.collisionradius', 'float'],
  ['CollisionHeight', 'engine.actor.collisionheight', 'float'],
  ['MeleeRange', 'engine.pawn.meleerange', 'float'],
  ['MoveTarget', 'engine.pawn.movetarget', 'pointer'],
  ['FaceTarget', 'engine.pawn.facetarget', 'pointer'],
  ['bCanStrafe', 'engine.pawn.bcanstrafe', 'bool'],
  ['bReducedSpeed', 'engine.pawn.breducedspeed', 'bool'],
  ['bAdvancedTactics', 'engine.pawn.badvancedtactics', 'bool'],
  ['bCanGlide', 'engine.pawn.bcanglide', 'bool'],
  ['LatentFloat', 'engine.actor.latentfloat', 'float'],
]);
const COMPUTED = 0x80000000;

export class LocomotionHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.expected = null;
    this.tableVersion = -1;
    this.complete = false;
    this.bits = new WeakMap();
  }
  attach(exports) {
    this.fieldsAt = exports.loco_fields_ptr();
    this.namesAt = exports.loco_names_ptr();
  }
  /** Fill the table's missing entries from the registry when it changed.
   * An added entry recomputes every class row's locomotion word. */
  table() {
    if (!this.complete && this.tableVersion !== fieldImageCellVersion()) this.fillTable();
  }
  /** table()'s slow path, a function of its own: the closure below would make table() allocate a context object on every call
   * (scripts/closure-context-scan.mjs), and it runs for every actor of every tick. */
  fillTable() {
    this.tableVersion = fieldImageCellVersion();
    const view = this.vm.arena.view, expected = this.expected ??= LOCO_FIELDS.map(() => null);
    let added = false;
    LOCO_FIELDS.forEach(([, key, kind], index) => {
      if (expected[index]) return;
      const cell = fieldImageCell(key);
      if (!cell || cellKind(cell) !== kind) return;
      expected[index] = cell;
      added = true;
      const at = this.fieldsAt + 12 * index;
      view.setUint32(at, cell.offset, true);
      view.setUint32(at + 4, cell.mask >>> 0, true);
      view.setUint32(at + 8, fieldKeyId(key), true);
    });
    if (!added) return;
    this.bits = new WeakMap();
    for (const {address} of this.vm.rows.values())
      view.setUint32(address + 8 + 8 * view.getUint32(address + 4, true) + 8, 0, true);
    view.setUint32(this.namesAt, foldedNameId('pawn'), true);
    view.setUint32(this.namesAt + 4, foldedNameId('inventory'), true);
    this.complete = !expected.includes(null);
    view.setUint32(this.namesAt + 8, this.complete ? 1 : 0, true);
  }
  /** A class's locomotion word: field i is set when `namedField` on an
   * instance of `cls` resolves the spelling to the key and reads a cell
   * the table describes. */
  classBits(cls, cells) {
    let bits = this.bits.get(cls);
    if (bits !== undefined) return bits;
    bits = COMPUTED;
    const expected = this.expected ?? [];
    LOCO_FIELDS.forEach(([name, key], index) => {
      if (!expected[index] || !cells) return;
      let field;
      try { field = this.runtime.lookupMember(cls, 'fields', name); } catch { return; }
      if (field?.key === key && sameCell(cells.get(key), expected[index])) bits |= 1 << index;
    });
    bits >>>= 0;
    this.bits.set(cls, bits);
    return bits;
  }
  /** js_loco_class: the word after the row's perception words (no script
   * runs). */
  classWord(handle) {
    const vm = this.vm, address = vm.classRow(handle);
    if (!address) return;
    const identity = identityOfHandle(handle), runtime = this.runtime;
    const instance = identity[runtime.instanceKey] ?? runtime.instances.get(identity);
    const view = vm.arena.view;
    view.setUint32(address + 8 + 8 * view.getUint32(address + 4, true) + 8, this.classBits(instance.cls, instance.cells), true);
  }
  imports() {
    return {js_loco_class: handle => this.classWord(handle)};
  }
}
