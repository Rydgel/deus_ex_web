/**
 * The host half of FindPathToward's open-list search in the Rust core
 * (native/script-vm/src/nav.rs): script-pawn-nav.mjs `navSearchBFS` over
 * the NavigationPoint fields in the object image, with the JavaScript body as
 * the reference. Host bookkeeping, not an original structure. This module
 * owns:
 *
 * - the field table (N_FIELDS): each NavigationPoint field's offset, bool
 *   mask and key id, from the cell registry, checked against the kind nav.rs
 *   reads;
 * - the level's ReachSpec table in the arena, [radius, height, reachFlags,
 *   distance, start handle] per spec, built once per table;
 * - the level check: every node the search can reach (the
 *   NavigationPointList chain, every spec's start) is an attached instance
 *   whose class resolves each field's spelling to its key and stores it in
 *   the cell the table describes. A level that fails keeps the JavaScript
 *   body.
 *
 * NAV_SEARCH=js in Node or ?navSearch=js in the viewer keeps the JavaScript
 * body; NAV_SEARCH=verify (?navSearch=verify) runs the Rust search, keeps
 * its result and the written fields of every node, restores the fields,
 * runs the JavaScript body and throws on any difference.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell} from './script-object-image.mjs';
import {fieldKeyId} from './script-vm-lower.mjs';
import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {switchReader} from './switch-reader.mjs';

/** The fields nav.rs reads (N_*), in index order: [spelling, key, kind]. */
export const NAV_FIELDS = Object.freeze([
  ['visitedWeight', 'engine.navigationpoint.visitedweight', 'int'],
  ['nextOrdered', 'engine.navigationpoint.nextordered', 'pointer'],
  ['prevOrdered', 'engine.navigationpoint.prevordered', 'pointer'],
  ['previousPath', 'engine.navigationpoint.previouspath', 'pointer'],
  ['cost', 'engine.navigationpoint.cost', 'int'],
  ['bEndPoint', 'engine.navigationpoint.bendpoint', 'bool'],
  ['bestPathWeight', 'engine.navigationpoint.bestpathweight', 'int'],
  ['bPlayerOnly', 'engine.navigationpoint.bplayeronly', 'bool'],
  ['upstreamPaths', 'engine.navigationpoint.upstreampaths', 'int[16]'],
  ['nextNavigationPoint', 'engine.navigationpoint.nextnavigationpoint', 'pointer'],
  // navScoutA's reset and distance reads (nav_scout).
  ['Location', 'engine.actor.location', 'vector'],
  ['bSpecialCost', 'engine.navigationpoint.bspecialcost', 'bool'],
  ['ExtraCost', 'engine.navigationpoint.extracost', 'int'],
]);
/** The fields the search and the scout write, compared under NAV_SEARCH=verify. */
const WRITTEN = ['visitedWeight', 'nextOrdered', 'prevOrdered', 'previousPath'];
const SCOUTED = ['nextOrdered', 'prevOrdered', 'bEndPoint', 'visitedWeight', 'cost'];
const f32Bits = new DataView(new ArrayBuffer(4));
const bitsOf = value => { f32Bits.setFloat32(0, value, true); return f32Bits.getUint32(0, true); };
/** A navList ({items[32], keys Int32Array(32), count}) as nav.rs reads it: [count, items[32], keys[32]]. */
const LIST_BYTES = 260;
const cellIs = (cell, kind) => kind === 'int[16]'
  ? cellKind(cell) === 'fixed' && cellKind(cell.element) === 'int' && cell.element.offset === 0 &&
    cell.stride === 4 && cell.dim === 16
  : cellKind(cell) === kind;

/** nav.rs results. */
const FOUND = 1, HANDBACK = 2, FAULT = 3;

/** 'rust' (default), 'js' or 'verify'. */
export const navSearchMode = switchReader('NAV_SEARCH', 'DEUS_EX_NAV_SEARCH', 'rust');

export class NavSearchHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.expected = null;
    this.tableVersion = -1;
    this.complete = false;
    this.classes = new WeakMap();
    this.levels = new WeakMap();
    this.chains = new WeakMap();
    this.out = 0;
  }
  attach(exports) {
    this.x = exports;
    this.fieldsAt = exports.nav_fields_ptr();
  }
  /** Fill the table's missing entries from the registry when it changed;
   * whether every entry is filled. */
  table() {
    if (this.complete) return true;
    const version = fieldImageCellVersion();
    if (this.tableVersion === version) return false;
    this.tableVersion = version;
    const view = this.vm.arena.view, expected = this.expected ??= NAV_FIELDS.map(() => null);
    NAV_FIELDS.forEach(([, key, kind], index) => {
      if (expected[index]) return;
      const cell = fieldImageCell(key);
      if (!cell || !cellIs(cell, kind)) return;
      expected[index] = cell;
      const at = this.fieldsAt + 12 * index;
      view.setUint32(at, cell.offset, true);
      view.setUint32(at + 4, cell.mask >>> 0, true);
      view.setUint32(at + 8, fieldKeyId(key), true);
    });
    return this.complete = !expected.includes(null);
  }
  /** Whether `identity` is an attached instance whose class reads every
   * field in the cell the table describes. */
  answers(identity) {
    const runtime = this.runtime;
    const instance = identity && (identity[runtime.instanceKey] ?? runtime.instances.get(identity));
    if (!instance?.cells) return false;
    let ok = this.classes.get(instance.cls);
    if (ok === undefined) {
      ok = NAV_FIELDS.every(([name, key], index) => {
        let field;
        try { field = runtime.lookupMember(instance.cls, 'fields', name); } catch { return false; }
        return field?.key === key && sameCell(instance.cells.get(key), this.expected[index]);
      });
      this.classes.set(instance.cls, ok);
    }
    return ok;
  }
  /** The level of ReachSpec table `specs` with the NavigationPointList chain
   * from `head`: {ok, ptr, count, nodes}. Built once per table and head. */
  level(specs, head) {
    let level = this.levels.get(specs);
    if (level && level.head === head) return level;
    const chain = this.chain(head), nodes = new Set(chain.nodes);
    let ok = chain.ok;
    for (const spec of specs) if (spec.start && (nodes.add(spec.start), !this.answers(spec.start))) ok = false;
    let ptr = 0;
    if (ok) {
      ptr = this.vm.arena.alloc(Math.max(20, 20 * specs.length));
      const view = this.vm.arena.view;
      specs.forEach((spec, i) => {
        const at = ptr + 20 * i;
        view.setInt32(at, spec.radius | 0, true);
        view.setInt32(at + 4, spec.height | 0, true);
        view.setInt32(at + 8, spec.reachFlags | 0, true);
        view.setInt32(at + 12, spec.distance | 0, true);
        view.setUint32(at + 16, spec.start ? handleOf(spec.start) : 0, true);
      });
    }
    if (level?.ptr) this.vm.arena.release(level.ptr, Math.max(20, 20 * level.count));
    level = {ok, ptr, count: specs.length, head, nodes: [...nodes]};
    this.levels.set(specs, level);
    return level;
  }
  /** The NavigationPointList chain from `head`: {ok, nodes}, ok when every
   * node answers in the image. Kept per head. */
  chain(head) {
    let chain = this.chains.get(head);
    if (chain) return chain;
    const nodes = [];
    let ok = true;
    for (let node = head, steps = 0; node && ok; node = this.runtime.readNamed(node, 'nextNavigationPoint') ?? null) {
      if (++steps > 1 << 16 || !this.answers(node)) ok = false;
      nodes.push(node);
    }
    this.chains.set(head, chain = {ok, nodes});
    return chain;
  }
  /** navSearchBFS in Rust: its result (0 or 1, with `found.node` set on 1),
   * or undefined when the JavaScript body must run (the mode is js, the
   * table is not complete, the level or a node does not answer in the
   * image). `reference(found)` is the JavaScript body, run under verify. */
  search({start, cri, chi, f318, single, mask, specs, head, found, reference}) {
    const mode = navSearchMode();
    if (mode === 'js' || !specs?.length || !start || !this.table()) return undefined;
    const level = this.level(specs, head);
    if (!level.ok) return undefined;
    const nodes = level.nodes.includes(start) ? level.nodes : [...level.nodes, start];
    const before = mode === 'verify' ? this.snapshot(nodes) : null;
    this.out ||= this.vm.arena.alloc(4);
    const status = this.x.nav_search(level.ptr, level.count, head ? handleOf(head) : 0, handleOf(start),
      cri | 0, chi | 0, f318 >>> 0, single ? 1 : 0, mask | 0, this.out);
    if (status === HANDBACK) return undefined;
    if (status === FAULT) throw new Error('navSearchBFS (nav.rs): a ReachSpec with no start, or a node the image cannot answer, reached mid-search');
    const node = status === FOUND ? identityOfHandle(this.vm.arena.view.getUint32(this.out, true)) : null;
    if (before) {
      const after = this.snapshot(nodes);
      this.restore(nodes, before);
      const reached = {node: null}, want = reference(reached);
      const differences = [];
      if (want !== status) differences.push(`result ${status} in Rust, ${want} in JavaScript`);
      if (status === FOUND && reached.node !== node) differences.push(`endpoint ${node?.name} in Rust, ${reached.node?.name} in JavaScript`);
      const expected = this.snapshot(nodes);
      nodes.forEach((n, i) => WRITTEN.forEach((name, j) => {
        if (!Object.is(after[i][j], expected[i][j]))
          differences.push(`${n.name}.${name} ${after[i][j]?.name ?? after[i][j]} in Rust, ${expected[i][j]?.name ?? expected[i][j]} in JavaScript`);
      }));
      if (differences.length) throw new Error(`NAV_SEARCH=verify: ${differences.slice(0, 6).join('; ')}`);
    }
    if (status === FOUND) found.node = node;
    return status;
  }
  snapshot(nodes, names = WRITTEN) {
    return nodes.map(node => names.map(name => this.runtime.readNamed(node, name)));
  }
  restore(nodes, values, names = WRITTEN) {
    nodes.forEach((node, i) => names.forEach((name, j) => this.runtime.writeNamed(node, name, values[i][j])));
  }
  /** navScoutA's loop from node `nav` in Rust: null when it reached the
   * chain's end, the node it stopped before (whose iteration the caller
   * runs), or undefined when the caller must run every node (the mode is
   * js, the table is not complete). The lists are updated in place.
   * `reference(start, stop)` is the JavaScript loop over [start, stop), run
   * under verify. */
  scout({head, nav, clear, anchor, seeded, ploc, targetLoc, thisList, otherList, reference}) {
    const mode = navSearchMode();
    if (mode === 'js' || !nav || !head || !this.table() || !this.chain(head).ok) return undefined;
    const view = () => this.vm.arena.view;
    this.scoutAt ||= this.vm.arena.alloc(2 * LIST_BYTES + 32);
    const at = this.scoutAt, lists = [thisList, otherList];
    const put = (list, base) => {
      view().setUint32(base, list.count, true);
      for (let i = 0; i < 32; i++) {
        view().setUint32(base + 4 + 4 * i, list.items[i] ? handleOf(list.items[i]) : 0, true);
        view().setInt32(base + 132 + 4 * i, list.keys[i], true);
      }
    };
    const get = (list, base) => {
      list.count = view().getUint32(base, true);
      for (let i = 0; i < 32; i++) {
        const handle = view().getUint32(base + 4 + 4 * i, true);
        list.items[i] = handle ? identityOfHandle(handle) : null;
        list.keys[i] = view().getInt32(base + 132 + 4 * i, true);
      }
    };
    lists.forEach((list, i) => put(list, at + LIST_BYTES * i));
    const locations = at + 2 * LIST_BYTES, out = locations + 24;
    [...ploc, ...targetLoc].forEach((value, i) => view().setUint32(locations + 4 * i, bitsOf(value), true));
    // verify: the chain's nodes and both lists before the scan
    const chain = this.chain(head).nodes;
    const before = mode === 'verify' ? {nodes: this.snapshot(chain, SCOUTED), lists: lists.map(copyList)} : null;
    const status = this.x.nav_scout(handleOf(nav), clear ? 1 : 0, anchor ? 1 : 0, seeded ? 1 : 0, locations, locations + 12,
      at, at + LIST_BYTES, out);
    const stop = status === 1 ? identityOfHandle(view().getUint32(out, true)) : null;
    lists.forEach((list, i) => get(list, at + LIST_BYTES * i));
    if (before) {
      const after = {nodes: this.snapshot(chain, SCOUTED), lists: lists.map(copyList)};
      this.restore(chain, before.nodes, SCOUTED);
      lists.forEach((list, i) => Object.assign(list, copyList(before.lists[i])));
      reference(nav, stop);
      const expected = {nodes: this.snapshot(chain, SCOUTED), lists: lists.map(copyList)}, differences = [];
      chain.forEach((n, i) => SCOUTED.forEach((name, j) => {
        if (!Object.is(after.nodes[i][j], expected.nodes[i][j]))
          differences.push(`${n.name}.${name} ${after.nodes[i][j]?.name ?? after.nodes[i][j]} in Rust, ${expected.nodes[i][j]?.name ?? expected.nodes[i][j]} in JavaScript`);
      }));
      after.lists.forEach((list, i) => {
        if (list.count !== expected.lists[i].count || list.items.some((item, k) => item !== expected.lists[i].items[k]) ||
          list.keys.some((key, k) => key !== expected.lists[i].keys[k]))
          differences.push(`list ${i}: ${list.count} in Rust, ${expected.lists[i].count} in JavaScript`);
      });
      if (differences.length) throw new Error(`NAV_SEARCH=verify (nav_scout): ${differences.slice(0, 6).join('; ')}`);
    }
    return stop;
  }
}

const copyList = list => ({items: [...list.items], keys: Int32Array.from(list.keys), count: list.count});
