/**
 * The Rust interpreter's state table (docs/rust-core.md "State table"):
 * per handle, the object's state as GetStateName and probing read it, so
 * Rust reads it without an import. Host bookkeeping, not an original
 * structure.
 *
 * STATES = [table, capacity, verify] (interp.rs). An entry is three u32 per
 * handle: [row, probe lo, probe hi]. Row 0 means not computed: Rust asks
 * js_state, which computes the entry and enters it. A state row is
 * [node id, n, name ids along the node's base chain], where the node is what
 * the state queries read (script-runtime.mjs, natives 281/284):
 * `instance.state.stateNode ?? instance.cls` for an instance with a
 * ScriptState, and nothing (n = 0) for one without, whose GetStateName is
 * None. The names are `nameId(node.record.name)`, the id js_name returns for
 * GetStateName's value. The probe words are the ScriptState's ProbeMask (0
 * without one).
 *
 * js_state returns 0 for a handle it does not describe (released, a class
 * identity, not attached to this runtime, a chain whose names
 * scriptNameToString rejects): the native then runs in JavaScript, which
 * raises its errors. An entry is cleared when its object's state changes
 * (script-state.mjs stateChanged: setStateNode, a ProbeMask replacement,
 * attachment, InitExecution, a restored StateFrame) and when its handle is
 * released. STATE_VERIFY=1 sets `verify`: Rust asks js_state on every read,
 * and js_state compares a filled entry with what it computes, so a change
 * that missed stateChanged fails at the next read.
 */
import {identityOfHandle} from './script-object-handles.mjs';
import {nameId} from './script-name-ids.mjs';

const STATE_VERIFY = typeof process !== 'undefined' && process.env?.STATE_VERIFY === '1';
const ENTRY = 12;

// State nodes (and class sentinels) as small integers from 1, shared by
// every runtime: a row's first word.
const nodeIds = new WeakMap();
let nextNodeId = 1;
export function stateNodeId(node) {
  let id = nodeIds.get(node);
  if (id === undefined) nodeIds.set(node, id = nextNodeId++);
  return id;
}

export class StateTable {
  constructor(vm) {
    this.vm = vm;
    this.arena = vm.arena;
    this.at = 0;
    this.table = 0;
    this.capacity = 0;
    // Rows by node; `none` is the row of an instance without a ScriptState.
    this.rows = new Map();
    this.none = 0;
  }
  attach(x, limit) {
    this.at = x.vm_states_ptr();
    this.grow(limit);
    if (STATE_VERIFY) this.arena.view.setUint32(this.at + 8, 1, true);
  }
  /** Make the table cover `handle`. New entries are zero (not computed). */
  grow(handle) {
    if (handle < this.capacity) return;
    const capacity = Math.max(4096, (handle + 1) * 2), bytes = capacity * ENTRY, base = this.arena.alloc(bytes);
    this.arena.bytes.fill(0, base, base + bytes);
    if (this.table) {
      this.arena.bytes.copyWithin(base, this.table, this.table + this.capacity * ENTRY);
      this.arena.release(this.table, this.capacity * ENTRY);
    }
    this.table = base;
    this.capacity = capacity;
    const view = this.arena.view;
    view.setUint32(this.at, base, true);
    view.setUint32(this.at + 4, capacity, true);
  }
  /** The handle's state changed or its handle was released. */
  clear(handle) {
    if (handle > 0 && handle < this.capacity) this.arena.view.setUint32(this.table + ENTRY * handle, 0, true);
  }
  /** js_state: `handle`'s row, with its entry filled, or 0. Runs no script. */
  state(handle) {
    const entry = this.compute(handle);
    if (!entry) return 0;
    this.grow(handle);
    const view = this.arena.view, at = this.table + ENTRY * handle;
    if (STATE_VERIFY && view.getUint32(at, true) !== 0 &&
      (view.getUint32(at, true) !== entry.row || view.getUint32(at + 4, true) !== entry.lo || view.getUint32(at + 8, true) !== entry.hi))
      throw new Error(`State table entry of handle ${handle} is stale: [${view.getUint32(at, true)}, ${view.getUint32(at + 4, true)}, ${view.getUint32(at + 8, true)}], now [${entry.row}, ${entry.lo}, ${entry.hi}]`);
    view.setUint32(at, entry.row, true);
    view.setUint32(at + 4, entry.lo, true);
    view.setUint32(at + 8, entry.hi, true);
    return entry.row;
  }
  compute(handle) {
    const identity = identityOfHandle(handle);
    if (identity === null || typeof identity !== 'object' || identity.kind === 'Class') return null;
    const runtime = this.vm.runtime, instance = identity[runtime.instanceKey] ?? runtime.instances.get(identity);
    if (!instance) return null;
    const state = instance.state;
    if (!state) return {row: this.noneRow(), lo: 0, hi: 0};
    const row = this.row(state.stateNode ?? instance.cls);
    if (!row) return null;
    const mask = state.probeMask;
    return {row, lo: mask[0] >>> 0, hi: mask[1] >>> 0};
  }
  noneRow() {
    if (!this.none) {
      const address = this.arena.alloc(8), view = this.arena.view;
      view.setUint32(address, 0, true);
      view.setUint32(address + 4, 0, true);
      this.none = address;
    }
    return this.none;
  }
  /** The row of `node`, or 0 when a name on its chain is not a name
   * scriptNameToString accepts (the query throws in JavaScript). */
  row(node) {
    let address = this.rows.get(node);
    if (address !== undefined) return address;
    const ids = [], seen = new Set();
    for (let n = node; n; n = n.base) {
      const name = n.record?.name;
      if (seen.has(n) || typeof name !== 'string' || name.includes('\0')) { this.rows.set(node, 0); return 0; }
      seen.add(n);
      ids.push(nameId(name));
    }
    address = this.arena.alloc(8 + 4 * ids.length);
    const view = this.arena.view;
    view.setUint32(address, stateNodeId(node), true);
    view.setUint32(address + 4, ids.length, true);
    ids.forEach((id, i) => view.setUint32(address + 8 + 4 * i, id, true));
    this.rows.set(node, address);
    return address;
  }
}
