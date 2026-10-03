/**
 * The host half of execUpdateParticles in Rust (native/script-vm/src/
 * particles.rs, docs/particles.md): the ParticleIterator cells the update
 * reads and writes, checked against the image layout, and the per-iterator
 * admission. Host bookkeeping, not an original structure.
 *
 * PARTICLES=js in Node or ?particles=js in the viewer keeps
 * script-particles.mjs updateParticles over a copied state; PARTICLES=verify
 * also runs that body on the state read before the Rust update, with the
 * same appFrand values, and throws on any difference.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell} from './script-object-image.mjs';

export const particlesMode = () => (typeof process !== 'undefined' && process.env?.PARTICLES)
  || globalThis.DEUS_EX_PARTICLES || 'rust';

const KEY = name => `deusex.particleiterator.${name}`;
const MEMBER = name => `deusex.particleiterator.sparticle.${name}`;
// The iterator fields particles.rs reads, by spelling: [name, kind].
const SCALARS = [['nextFreeParticle', 'int'], ['bOwnerUsesGravity', 'bool'], ['bOwnerScales', 'bool'], ['bOwnerFades', 'bool'],
  ['OwnerZoneGravity', 'float'], ['OwnerRiseRate', 'float'], ['OwnerLifeSpan', 'float'], ['OwnerDrawScale', 'float']];
const MEMBERS = [['bactive', 'bool'], ['initvel', 'vector'], ['velocity', 'vector'], ['location', 'vector'],
  ['drawscale', 'float'], ['scaleglow', 'float'], ['lifespan', 'float']];
const NAMES = ['Particles', ...SCALARS.map(([name]) => name)];
const bits = new DataView(new ArrayBuffer(4));
const f32Bits = value => { bits.setFloat32(0, value, true); return bits.getUint32(0, true); };

export class ParticleHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.version = -1;
    this.cells = null;
    this.classes = new Map();
    this.instances = new WeakMap();
    this.frand = null;
  }
  attach(x) { this.x = x; this.fieldsAt = x.particle_fields_ptr(); }
  imports() { return {js_frand: () => this.frand()}; }
  /** The cell table, from the registry: null while a cell is missing or
   * laid out other than particles.rs reads it. */
  table() {
    const version = fieldImageCellVersion();
    if (version === this.version) return this.cells;
    this.version = version;
    this.classes.clear();
    this.instances = new WeakMap();
    this.cells = null;
    const array = fieldImageCell(KEY('particles'));
    if (cellKind(array) !== 'fixed' || array.dim !== 64 || cellKind(array.element) !== 'struct') return null;
    const members = MEMBERS.map(([name, kind]) => {
      const member = array.element.members.find(item => item.key === MEMBER(name));
      return cellKind(member) === kind ? member : null;
    });
    const scalars = SCALARS.map(([name, kind]) => {
      const cell = fieldImageCell(KEY(name.toLowerCase()));
      return cellKind(cell) === kind ? cell : null;
    });
    if (members.includes(null) || scalars.includes(null)) return null;
    const words = [array.offset + array.element.offset, array.stride,
      members[0].offset, members[0].mask >>> 0, ...members.slice(1).map(member => member.offset)];
    for (const cell of scalars) words.push(cell.offset, ...(cellKind(cell) === 'bool' ? [cell.mask >>> 0] : []));
    const view = this.vm.arena.view;
    words.forEach((word, i) => view.setUint32(this.fieldsAt + 4 * i, word, true));
    this.cells = [array, ...scalars];
    return this.cells;
  }
  /** Whether `iterator`'s fields are its image cells: every spelling
   * resolves on its class to the table's cell, and the object binds none
   * of them and has an image of this arena. */
  instanceOf(iterator) {
    const runtime = this.runtime, instance = iterator?.[runtime.instanceKey] ?? runtime.instances.get(iterator);
    if (!instance?.cells || !instance.base || instance.arena !== this.vm.arena || instance.poison?.size ||
      instance.imageToken?.released || instance.nativeObject?.released) return null;
    const cells = this.table();
    if (!cells) return null;
    let ok = this.classes.get(instance.cls);
    if (ok === undefined) {
      ok = NAMES.every((name, i) => {
        let field;
        try { field = runtime.lookupMember(instance.cls, 'fields', name); } catch { return false; }
        return field?.key === KEY(name.toLowerCase()) && sameCell(instance.cells.get(field.key), cells[i]);
      });
      this.classes.set(instance.cls, ok);
    }
    if (!ok) return null;
    let entry = this.instances.get(instance);
    if (!entry || entry.bindings !== instance.bindings.size) {
      entry = {bindings: instance.bindings.size, ok: NAMES.every(name => !instance.bindings.has(KEY(name.toLowerCase())))};
      this.instances.set(instance, entry);
    }
    return entry.ok ? instance : null;
  }
  /** execUpdateParticles' update of `iterator` for `deltaTime` with the
   * appFrand stream `frand`: the proxy's bHidden afterwards, or null when
   * the update must run in JavaScript (nothing was written). */
  update(iterator, deltaTime, frand) {
    if (particlesMode() === 'js') return null;
    const instance = this.instanceOf(iterator);
    if (!instance) return null;
    this.frand = frand;
    try { return this.x.update_particles(instance.base, f32Bits(deltaTime)) === 1; } finally { this.frand = null; }
  }
}
