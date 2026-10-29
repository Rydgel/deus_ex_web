/**
 * SetActorZone's common case in Rust (native/script-vm/src/zone.rs,
 * docs/rust-core.md step R3-e). The JavaScript body (zone.mjs setActorZone,
 * reached through ScriptRuntime.setSpawnActorZone and the map pawn view's
 * setActorZone) stays the reference: it runs whenever this host declines a
 * call or the kernel hands one back, which happens before any store.
 *
 * A call runs in Rust only when every field the body reads or writes is the
 * image cell that `readNamed` and the field references use: the receiver is
 * not HOST, each spelling resolves to the key and cell of the registry (the
 * R3-c/R3-d rule), no such key is bound on the receiver, and the level
 * carries its zone model (`level.zoneModel`, player-scene.mjs). `force`
 * always runs the JavaScript.
 *
 * Switches (Node only): ZONE_KERNEL=js keeps every call in JavaScript;
 * ZONE_DIFFERENTIAL=1 checks each call completed in Rust against the
 * JavaScript point queries and the regions before the call.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell} from './script-object-image.mjs';
import {handleOf} from './script-object-handles.mjs';

const env = typeof process !== 'undefined' ? process.env ?? {} : {};
const DISABLED = env.ZONE_KERNEL === 'js';
const DIFFERENTIAL = env.ZONE_DIFFERENTIAL === '1';
const differential = {calls: 0, deleted: 0};
if (DIFFERENTIAL) process.on('exit', () => {
  process.stderr.write(`zone differential: ${differential.calls} Rust SetActorZone calls matched the JavaScript ` +
    `point queries (${differential.deleted} deleted actors)\n`);
});

// [spelling, key, kind]; the last four are Pawn's.
const ZONE_FIELDS = [
  ['bDeleteMe', 'engine.actor.bdeleteme', 'bool'],
  ['Location', 'engine.actor.location', 'vector'],
  ['Region', 'engine.actor.region', 'struct'],
  ['CollisionHeight', 'engine.actor.collisionheight', 'float'],
  ['EyeHeight', 'engine.pawn.eyeheight', 'float'],
  ['FootRegion', 'engine.pawn.footregion', 'struct'],
  ['HeadRegion', 'engine.pawn.headregion', 'struct'],
  ['PlayerReplicationInfo', 'engine.pawn.playerreplicationinfo', 'pointer'],
];
const ACTOR_FIELDS = 4;
const REGION_MEMBERS = ['engine.actor.pointregion.zone', 'engine.actor.pointregion.ileaf',
  'engine.actor.pointregion.zonenumber'];
const REGION_KINDS = ['pointer', 'int', 'byte'];
const NODE_BYTES = 40;

export class ZoneHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.cells = null;
    this.members = null;
    this.version = -1;
    this.classes = new Map();
    this.models = new WeakMap();
  }
  attach(exports) {
    this.x = exports;
    this.ioAt = exports.zone_io_ptr();
    this.enabled = !DISABLED;
  }
  /** The registry cells of ZONE_FIELDS (null where a key has none or a
   * different kind) and the PointRegion members' offsets. */
  table() {
    const version = fieldImageCellVersion();
    if (this.version === version) return;
    this.version = version;
    this.classes.clear();
    this.cells = ZONE_FIELDS.map(([, key, kind]) => {
      const cell = fieldImageCell(key);
      return cellKind(cell) === kind ? cell : null;
    });
    // The three regions share one layout: Zone, iLeaf and ZoneNumber.
    this.members = null;
    const regions = [2, 5, 6].map(i => this.cells[i]).filter(Boolean);
    const layout = cell => REGION_MEMBERS.map((key, i) => {
      const member = cell.members.find(item => item.key === key);
      return member && cellKind(member) === REGION_KINDS[i] ? member : null;
    });
    const first = regions[0] && layout(regions[0]);
    if (first && !first.includes(null) &&
      regions.every(cell => layout(cell).every((member, i) => sameCell(member, first[i])))) {
      this.members = first;
    }
  }
  /** A class's eligibility: its spellings resolve to the table's keys and
   * cells (the cell `readNamed` uses, or will cache), and whether it is a
   * Pawn. */
  classInfo(cls, cells, names) {
    let info = this.classes.get(cls);
    if (info && info.names === names.size) return info;
    let pawn = false;
    for (let c = cls; c; c = c.base) if (c.record?.key === 'engine.pawn') { pawn = true; break; }
    const count = pawn ? ZONE_FIELDS.length : ACTOR_FIELDS;
    let ok = Boolean(this.members && cells);
    for (let i = 0; ok && i < count; i++) {
      const [name, key] = ZONE_FIELDS[i], expected = this.cells[i];
      let field;
      try { field = this.runtime.lookupMember(cls, 'fields', name); } catch { ok = false; break; }
      if (!expected || field?.key !== key) { ok = false; break; }
      const cached = names.get(name);
      const cell = cached === undefined ? cells.get(key) : cached?.field === field ? cached.cell : null;
      if (!sameCell(cell, expected)) ok = false;
    }
    info = {names: names.size, ok, pawn, count};
    this.classes.set(cls, info);
    return info;
  }
  /** The level's zone model in this runtime's arena, built once per level
   * (zone.rs). */
  model(level) {
    const source = level.zoneModel;
    if (!source) return 0;
    let entry = this.models.get(level);
    if (entry && entry.zones === source.zoneActors.length) return entry.address;
    const arena = this.vm.arena, size = zoneModelSize(source);
    let address = arena.alloc(size);
    // A model the block cannot describe keeps every call in JavaScript.
    if (!writeZoneModel(arena.view, address, source)) { arena.release(address, size); address = 0; }
    if (entry?.address) arena.release(entry.address, entry.size);
    this.models.set(level, entry = {address, size, zones: source.zoneActors.length});
    return address;
  }
  /** SetActorZone(test, force) on `receiver` in Rust: whether it completed
   * there. False means the JavaScript body must run the call. */
  update(receiver, level, test, force) {
    if (!this.enabled || force || !level?.zoneModel) return false;
    const runtime = this.runtime;
    const instance = receiver?.[runtime.instanceKey] ?? runtime.instances.get(receiver);
    if (instance === undefined || !instance.cells || !instance.base || instance.arena !== this.vm.arena ||
      instance.poison?.size > 0 || instance.imageToken?.released === true || instance.nativeObject?.released === true)
      return false;
    this.table();
    const info = this.classInfo(instance.cls, instance.cells, instance.fieldTable);
    if (!info.ok) return false;
    if (instance.bindings.size) for (let i = 0; i < info.count; i++) if (instance.bindings.has(ZONE_FIELDS[i][1])) return false;
    const model = this.model(level);
    if (!model) return false;
    const view = this.vm.arena.view, io = this.ioAt, cells = this.cells, members = this.members;
    const before = DIFFERENTIAL ? this.regions(receiver, info.pawn) : null;
    view.setUint32(io, instance.base, true);
    view.setUint32(io + 4, (info.pawn ? 1 : 0) | (test ? 2 : 0), true);
    view.setUint32(io + 8, model, true);
    view.setUint32(io + 12, cells[0].offset, true);
    view.setUint32(io + 16, cells[0].mask >>> 0, true);
    view.setUint32(io + 20, cells[1].offset, true);
    view.setUint32(io + 32, cells[2].offset, true);
    if (info.pawn) {
      view.setUint32(io + 24, cells[3].offset, true);
      view.setUint32(io + 28, cells[4].offset, true);
      view.setUint32(io + 36, cells[5].offset, true);
      view.setUint32(io + 40, cells[6].offset, true);
      view.setUint32(io + 44, cells[7].offset, true);
    }
    view.setUint32(io + 48, members[0].offset, true);
    view.setUint32(io + 52, members[1].offset, true);
    view.setUint32(io + 56, members[2].offset, true);
    view.setUint32(io + 60, 0xff, true);
    if (this.x.zone_update() !== 0) return false;
    if (DIFFERENTIAL) this.verify(receiver, level, info.pawn, test, before);
    return true;
  }
  /** The actor's regions as the JavaScript reads them. */
  regions(receiver, pawn) {
    const runtime = this.runtime;
    return (pawn ? ['Region', 'FootRegion', 'HeadRegion'] : ['Region']).map(name => runtime.regionValue(receiver, name));
  }
  /** ZONE_DIFFERENTIAL: the JavaScript body's queries give the regions the
   * kernel stored, and it would have made no event or PRI store. */
  verify(receiver, level, pawn, test, before) {
    const runtime = this.runtime, read = name => runtime.readNamed(receiver, name);
    differential.calls++;
    const fail = message => { throw new Error(`Zone kernel differential (${receiver?.name}): ${message}`); };
    if (read('bDeleteMe')) {
      differential.deleted++;
      const after = this.regions(receiver, pawn);
      if (after.some((region, i) => !sameRegion(region, before[i]))) fail('a deleted actor\'s regions changed');
      return;
    }
    const f = Math.fround, position = read('Location');
    const points = [position.map(f)];
    if (pawn) {
      points.push([f(position[0]), f(position[1]), f(position[2] - read('CollisionHeight'))]);
      points.push([f(position[0]), f(position[1]), f(position[2] + read('EyeHeight'))]);
      if (read('PlayerReplicationInfo')) fail('a PlayerReplicationInfo store was skipped');
    }
    const after = this.regions(receiver, pawn);
    points.forEach((point, i) => {
      const expected = level.pointRegion(point);
      if (!sameRegion(after[i], expected)) fail(`region ${i}: ${describe(after[i])} vs ${describe(expected)}`);
      if (!test && expected.zone !== before[i].zone) fail(`region ${i} changed zone without its events`);
    });
  }
}

/** The bytes of the zone model block for `source` ({model, levelInfo,
 * zoneActors}, player-scene.mjs `level.zoneModel`). */
export const zoneModelSize = ({model, zoneActors}) => 20 + 4 * zoneActors.length + NODE_BYTES * model.nodes.length;
/** Write the zone model block (zone.rs) for `source` at `address`: the
 * header, the zone handles (0 for a falsy entry, which pointRegion's `||`
 * replaces by the LevelInfo) and the nodes. Every node fits the block exactly
 * (the node table holds float32 planes, int32 children and leaves and byte zones),
 * so this returns true. */
export function writeZoneModel(view, address, {model, levelInfo, zoneActors}) {
  const nodes = model.nodes, zones = zoneActors.length;
  const handles = address + 20, nodesAt = handles + 4 * zones;
  view.setUint32(address, nodes.length, true);
  view.setUint32(address + 4, zones, true);
  view.setUint32(address + 8, handleOf(levelInfo), true);
  view.setUint32(address + 12, handles, true);
  view.setUint32(address + 16, nodesAt, true);
  zoneActors.forEach((zone, i) => view.setUint32(handles + 4 * i, zone ? handleOf(zone) : 0, true));
  for (let i = 0; i < nodes.length; i++) {
    const at = nodesAt + NODE_BYTES * i;
    for (let j = 0; j < 4; j++) view.setFloat32(at + 4 * j, nodes.plane(i, j), true);
    view.setInt32(at + 16, nodes.front(i), true);
    view.setInt32(at + 20, nodes.back(i), true);
    view.setInt32(at + 24, nodes.leaf(i, 0), true);
    view.setInt32(at + 28, nodes.leaf(i, 1), true);
    view.setUint32(at + 32, nodes.zone(i, 0), true);
    view.setUint32(at + 36, nodes.zone(i, 1), true);
  }
  return true;
}

const sameRegion = (a, b) => a.zone === b.zone && a.leaf === b.leaf && a.zoneNumber === b.zoneNumber;
const describe = region => `${region.zone?.name ?? region.zone} leaf ${region.leaf} zone ${region.zoneNumber}`;
