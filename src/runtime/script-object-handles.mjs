/**
 * Object handles (docs/rust-core.md, steps R1a and R1a-2).
 *
 * An object or class property is a 4-byte pointer in the original image. Here
 * its bytes hold a handle, a nonzero u32 naming the host identity, so code
 * reading linear memory (the Rust core) can follow the reference. Zero is
 * None. Since R1a-2 the bytes are the only storage of the pointer: a JS read
 * resolves the handle through this table, and a write stores the handle.
 *
 * The table is shared by every runtime, because class default images, which
 * hold handles, are shared. A handle is never reused: a stale one resolves to
 * no object instead of another object. An entry lives until the identity's
 * lifetime ends at an explicit original point (`release`): the LoadMap
 * collection's freeObject, CriticalDelete, DataLink cleanup, and the window
 * system's deleting destructors. The table is the only strong reference an
 * image holds to the identities it names.
 */
const handles = new Map();
// Identity by handle, dense: handles are allocated in order from 1, so the
// array stays packed. Index 0 (None) and released handles hold null.
const identities = [null];

/** The handle of an identity, allocated on first use; 0 for None. */
export function handleOf(identity) {
  if (identity == null) return 0;
  let handle = handles.get(identity);
  if (handle === undefined) {
    handle = identities.length;
    identities.push(identity);
    handles.set(identity, handle);
  }
  return handle;
}

/** The handle of an identity that has one, else 0; allocates nothing. */
export function existingHandle(identity) {
  return identity == null ? 0 : handles.get(identity) ?? 0;
}

/** The identity a handle names, or null for None or a released handle. */
export function identityOfHandle(handle) {
  return identities[handle] ?? null;
}

// Called with each released handle: the Rust interpreter's class tables
// (script-vm-rust.mjs) record it, so a pointer holding it reads None there.
const releaseListeners = [];
/** Call `listener(handle)` whenever a handle is released. */
export const onHandleRelease = listener => { releaseListeners.push(listener); };

/** End an identity's handle; images that still hold it now name nothing. */
export function releaseHandle(identity) {
  const handle = handles.get(identity);
  if (handle === undefined) return;
  handles.delete(identity);
  identities[handle] = null;
  for (const listener of releaseListeners) listener(handle);
}

/** One past the highest handle allocated so far. */
export const handleLimit = () => identities.length;

/** What a handle names, for validators: 'none' (0), 'live', 'released', or
 * 'unallocated' (never returned by handleOf). */
export function handleState(handle) {
  if (handle === 0) return 'none';
  if (!(handle > 0 && handle < identities.length)) return 'unallocated';
  return identities[handle] === null ? 'released' : 'live';
}

/** Live handle count, for lifetime validators. */
export const liveHandleCount = () => handles.size;

/** The live identities, for lifetime validators. */
export const liveHandleIdentities = () => handles.keys();
