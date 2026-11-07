/** Host bookkeeping for the Rust interpreter's receiver table
 * (script-vm-rust.mjs, docs/rust-core.md "Receiver table"), not an original
 * structure. A table entry holds what `receiverInfo` computed for a handle,
 * valid while this counter is unchanged. The counter advances on every event
 * that can change that result for an identity with a live handle: an
 * instance attaches, a host binding is added, a field is poisoned or its
 * poison cleared, storage is restored, or an object is freed. (A handle's
 * own release clears its entry directly.) */
import {existingHandle} from './script-object-handles.mjs';
import {switchReader} from './switch-reader.mjs';

let epoch = 1;
const listeners = [];
export const receiverEpoch = () => epoch;
/** Call `listener(epoch)` after every advance. */
export const onReceiverEpoch = listener => { listeners.push(listener); };
export function bumpReceiverEpoch() {
  epoch++;
  for (const listener of listeners) listener(epoch);
}

/** 'identity' (default) or 'global': EPOCH_SCOPE / DEUS_EX_EPOCH_SCOPE, what `bumpReceiverEpochFor` does. */
export const epochScopeMode = switchReader('EPOCH_SCOPE', 'DEUS_EX_EPOCH_SCOPE', 'identity');

/** The advance for an event that changes `identity` only (an instance attached to it, a host binding added to it). A table entry
 * is per handle, and a handle is allocated at the identity's first use and never reused (script-object-handles.mjs), so an
 * identity without a handle has no entry anywhere and no descriptor: nothing to invalidate. SpawnActor's construction, a
 * script object's `new` and a native window's field bindings all run before the object has a handle; in the Area 51 bunker 97%
 * of the advances were of this kind (4,230 of 4,356 in 1,200 ticks), and each one made the next pass re-describe every actor in
 * JavaScript. 'global' keeps the reference (every such event advances the epoch). */
export function bumpReceiverEpochFor(identity) {
  if (existingHandle(identity) !== 0 || epochScopeMode() === 'global') bumpReceiverEpoch();
}
