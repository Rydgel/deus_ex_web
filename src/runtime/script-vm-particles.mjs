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
import {handleOf} from './script-object-handles.mjs';
import {switchReader} from './switch-reader.mjs';

export const particlesMode = switchReader('PARTICLES', 'DEUS_EX_PARTICLES', 'rust');
/** The render-iterator protocol's CurrentItem loop (particles.rs `particle_items`, script-particles.mjs
 * `particleIteratorItems`): 'rust' (default), 'js' (the reference loop, with FarMoveActor as the caller gives it) or
 * 'verify' (every Rust run is repeated by the JavaScript loop from the same state, with the recovered relocation
 * body as FarMoveActor, and every written field and item compared). */
export const particleItemsMode = switchReader('PARTICLE_ITEMS', 'DEUS_EX_PARTICLE_ITEMS', 'rust');
/** What the loop did, for the browser runs (viewer/process-probe.mjs): iterators run in Rust, steps they ran, particles moved,
 * deleted by a move FindSpot refused, steps handed to JavaScript (a move `far_plan` declines), iterators the JavaScript loop ran
 * (no iterator image, no world model), and the verify mode's comparisons, steps compared, and sprite records compared with the
 * per-item reads (sprite-scan.mjs). */
export const particleItemCounts = {iterators: 0, steps: 0, moved: 0, failed: 0, handedBack: 0, jsIterators: 0, verified: 0, verifiedSteps: 0, recordsVerified: 0};

/** `particle_items`' answer for a proxy the image cannot address: nothing ran (particles.rs NOT_RUN). */
export const NOT_RUN = 0xffffffff;
const KEY = name => `deusex.particleiterator.${name}`;
// RenderIterator.Index, the one field `particle_items` stores that Engine declares.
const INDEX_KEY = 'engine.renderiterator.index';
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
    // `particle_items`: Index's cell (null while it is missing or not an int), the P_FIELDS words, the classes whose Index
    // resolves to it and the output views.
    this.indexCell = null;
    this.layout = null;
    this.itemClasses = new Map();
    this.itemView = null;
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
    this.itemClasses.clear();
    this.instances = new WeakMap();
    this.cells = null;
    this.indexCell = null;
    this.layout = null;
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
    const index = fieldImageCell(INDEX_KEY);
    if (cellKind(index) === 'int') this.indexCell = index;
    words.push(this.indexCell ? this.indexCell.offset : 0);
    this.layout = words;
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
      entry = {bindings: instance.bindings.size, ok: NAMES.every(name => !instance.bindings.has(KEY(name.toLowerCase()))),
        index: !instance.bindings.has(INDEX_KEY)};
      this.instances.set(instance, entry);
    }
    return entry.ok ? instance : null;
  }
  /** `iterator`'s image for `particle_items`: `instanceOf` and Index as its image cell, unbound. */
  itemsInstance(iterator) {
    const instance = this.instanceOf(iterator);
    if (!instance || !this.indexCell || !this.instances.get(instance)?.index) return null;
    let ok = this.itemClasses.get(instance.cls);
    if (ok === undefined) {
      let field;
      try { field = this.runtime.lookupMember(instance.cls, 'fields', 'Index'); } catch { field = null; }
      ok = field?.key === INDEX_KEY && sameCell(instance.cells.get(field.key), this.indexCell);
      this.itemClasses.set(instance.cls, ok);
    }
    return ok ? instance : null;
  }
  /** CurrentItem's loop in Rust from `start` below `max` (particles.rs `particle_items`): the Index of the first step the host
   * must take (`max` when the loop is complete), the items made appended to `into` as script-particles.mjs makes them. */
  items(instance, proxy, model, world, start, max, into) {
    const next = this.x.particle_items(instance.base, handleOf(proxy), model, world, start, max) >>> 0;
    const buffer = this.vm.arena.memory.buffer;
    if (this.itemView?.buffer !== buffer) this.itemView = {buffer, words: new Uint32Array(buffer, this.x.particle_items_ptr(), 322),
      floats: new Float32Array(buffer, this.x.particle_items_ptr(), 322)};
    const {words, floats} = this.itemView, count = words[0];
    for (let i = 0; i < count; i++) {
      const at = 2 + 5 * i;
      into.push({actor: proxy, location: [floats[at + 2], floats[at + 3], floats[at + 4]], drawScale: floats[at], scaleGlow: floats[at + 1]});
    }
    particleItemCounts.moved += count;
    particleItemCounts.failed += words[1];
    return next;
  }
  /** Particle `index` as the loop reads it: whether it is active, its Location, DrawScale and ScaleGlow. */
  particle(instance, index) {
    const view = this.vm.arena.view, w = this.layout, at = instance.base + w[0] + index * w[1];
    return {active: (view.getUint32(at + w[2], true) & w[3]) !== 0,
      location: [view.getFloat32(at + w[6], true), view.getFloat32(at + w[6] + 4, true), view.getFloat32(at + w[6] + 8, true)],
      drawScale: view.getFloat32(at + w[7], true), scaleGlow: view.getFloat32(at + w[8], true)};
  }
  /** UParticleIterator::DeleteParticle (0x1001aaf0) on an active particle in range. */
  deleteParticle(instance, index) {
    const view = this.vm.arena.view, w = this.layout, active = instance.base + w[0] + index * w[1] + w[2];
    view.setUint32(active, (view.getUint32(active, true) & ~w[3]) >>> 0, true);
    view.setUint32(instance.base + w[10], index, true);
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
