/** Original Extension Window natives 1497/1498/1499 and PlayerPawnExt's
 * fixed actor-reference table. Native instructions and original comparisons:
 * docs/script-window-actor-refs.md. Per-pawn JS storage represents the native
 * +0x898 entries and +0x998 count without assigning a second actor identity.
 */
import {refValue} from './script-vm.mjs';
import {getRootWindow, ROOT} from './script-window-tree-natives.mjs';

export function createActorReferenceTable() {
  return {count: 0, slots: Array.from({length: 32}, () => ({actor: null, refs: 0}))};
}

/** 0x10038400: retain slot tails exactly; even a lookup compacts the table. */
export function findActorReference(table, actor, isDeleted) {
  let found = -1, compacted = 0;
  for (let i = 0; i < table.count; i++) {
    const slot = table.slots[i];
    if (slot.actor && isDeleted(slot.actor)) slot.actor = null;
    if (slot.actor === actor) found = compacted;
    if (slot.actor) {
      table.slots[compacted].actor = slot.actor;
      table.slots[compacted].refs = slot.refs;
      compacted++;
    }
  }
  table.count = compacted;
  return found;
}

function shiftDown(table, start) {
  for (let i = start; i < table.count; i++) {
    table.slots[i - 1].actor = table.slots[i].actor;
    table.slots[i - 1].refs = table.slots[i].refs;
  }
  table.count--;
}

export function addActorReference(table, actor, isDeleted) {
  if (!actor) return;
  const index = findActorReference(table, actor, isDeleted);
  if (index >= 0) {table.slots[index].refs = (table.slots[index].refs + 1) | 0; return;}
  if (table.count >= 32) shiftDown(table, 1);
  if (table.count < 32) {
    table.slots[table.count].actor = actor;
    table.slots[table.count].refs = 1;
    table.count++;
  }
}

export function removeActorReference(table, actor, isDeleted) {
  if (!actor) return;
  const index = findActorReference(table, actor, isDeleted);
  if (index < 0) return;
  const refs = table.slots[index].refs = (table.slots[index].refs - 1) | 0;
  if (refs < 1) shiftDown(table, index + 1);
}

export function isActorReferenceValid(table, actor, isDeleted) {
  return !!actor && findActorReference(table, actor, isDeleted) >= 0;
}

/** isDeleted(actor) reads the live original bDeleteMe field (Actor+28 bit80).
 * The returned dispatcher owns one table per canonical pawn, shared by every
 * rooted window. tableFor exposes that storage to lifecycle/validation code.
 */
export function createWindowActorRefDispatcher(W, {isDeleted}) {
  if (typeof isDeleted !== 'function') throw new TypeError('Actor references require a live bDeleteMe reader');
  const tables = new WeakMap();
  const tableFor = pawn => {
    if (!tables.has(pawn)) tables.set(pawn, createActorReferenceTable());
    return tables.get(pawn);
  };
  const dispatch = call => {
    if (![1497, 1498, 1499].includes(call.index)) return {handled: false};
    const actor = call.argumentCount ? refValue(call.evaluateArgument(0)) ?? null : null;
    const root = getRootWindow(W, call.receiver);
    const pawn = root ? W.ptr(root, ROOT.parentPawn) : null;
    let value = call.index === 1499 ? false : undefined;
    if (pawn) {
      const table = tableFor(pawn);
      if (call.index === 1497) addActorReference(table, actor, isDeleted);
      else if (call.index === 1498) removeActorReference(table, actor, isDeleted);
      else value = isActorReferenceValid(table, actor, isDeleted);
    }
    return {handled: true, value};
  };
  dispatch.tableFor = tableFor;
  return dispatch;
}
