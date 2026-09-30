/** Host bookkeeping for the Rust interpreter's receiver table
 * (script-vm-rust.mjs, docs/rust-core.md "Receiver table"), not an original
 * structure. A table entry holds what `receiverInfo` computed for a handle,
 * valid while this counter is unchanged. The counter advances on every event
 * that can change that result for an identity with a live handle: an
 * instance attaches, a host binding is added, a field is poisoned or its
 * poison cleared, storage is restored, or an object is freed. (A handle's
 * own release clears its entry directly.) */
let epoch = 1;
const listeners = [];
export const receiverEpoch = () => epoch;
/** Call `listener(epoch)` after every advance. */
export const onReceiverEpoch = listener => { listeners.push(listener); };
export function bumpReceiverEpoch() {
  epoch++;
  for (const listener of listeners) listener(epoch);
}
