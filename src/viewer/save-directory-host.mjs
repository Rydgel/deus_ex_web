/** The page's half of the Save directory (docs/save-directory.md "Host inputs"): the free space GetSaveFreeSpace reports.
 *
 * The original asks the volume that holds its working directory (GetDiskFreeSpaceEx, lpFreeBytesAvailable); the Load Game screen shows it as
 * `Free Space: <KB / 1024>MB`. Play's saves will live in browser storage (IndexedDB, docs/travel.md order step 4), whose room is what
 * StorageManager.estimate() reports: quota minus usage. It is an estimate by design (the browser rounds it and may pad it), so it is a HOST INPUT,
 * labelled as such, not a measurement of the original. Without a StorageManager (a validator under Node, an old browser) the fixed default of
 * save-directory.mjs stays. The result is capped at what the original's int (kilobytes, a signed 32-bit value) can hold: 2 TiB less 1 KiB.
 * It is read once, before a session is created, because the native is synchronous. */
import {hostSaveDirectory} from '../runtime/save-directory.mjs';

const MOST = (2 ** 31 - 1) * 1024;

export async function primeSaveDirectoryHost({storage = globalThis.navigator?.storage, directory = hostSaveDirectory()} = {}) {
  try {
    const estimate = await storage?.estimate?.();
    if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
      directory.setFreeSpaceBytes(Math.min(MOST, Math.max(0, Math.floor(estimate.quota - estimate.usage))));
      return {source: 'StorageManager.estimate', quota: estimate.quota, usage: estimate.usage};
    }
  } catch { /* the estimate is optional */ }
  return {source: 'default'};
}
