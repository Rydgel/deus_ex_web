/**
 * Object handles (docs/rust-core.md, step R1a).
 *
 * An object or class property is a 4-byte pointer in the original image. Here
 * its bytes hold a handle, a nonzero u32 naming the host identity, so code
 * reading linear memory (the Rust core) can follow the reference. Zero is
 * None. The reference array still holds the identity itself, and every JS
 * access reads that, so the handle bytes change nothing observable.
 *
 * The table is shared by every runtime, because class default images, which
 * hold handles, are shared. A handle is never reused: a stale one resolves to
 * no object instead of another object. An entry lives until the identity's
 * lifetime ends at an explicit original point (`release`): the LoadMap
 * collection's freeObject, CriticalDelete, DataLink cleanup, and the window
 * system's deleting destructors.
 */
let next = 1;
const handles = new Map();
const identities = new Map();

/** The handle of an identity, allocated on first use; 0 for None. */
export function handleOf(identity) {
  if (identity == null) return 0;
  let handle = handles.get(identity);
  if (handle === undefined) {
    handle = next++;
    handles.set(identity, handle);
    identities.set(handle, identity);
  }
  return handle;
}

/** The identity a handle names, or null for None or a released handle. */
export function identityOfHandle(handle) {
  return identities.get(handle) ?? null;
}

/** End an identity's handle; images that still hold it now name nothing. */
export function releaseHandle(identity) {
  const handle = handles.get(identity);
  if (handle === undefined) return;
  handles.delete(identity);
  identities.delete(handle);
}

/** Live handle count, for lifetime validators. */
export const liveHandleCount = () => handles.size;

/** The live identities, for lifetime validators. */
export const liveHandleIdentities = () => handles.keys();
