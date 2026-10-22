/** Where the simulation's finished saves go (docs/save-storage.md "Writing a save"): the one place a JavaScript realm keeps the page's storage.
 *
 * The simulation holds a replica of the Save directory (save-directory.mjs, listed by the page); a save it makes reaches the page's storage through the
 * realm's SINK, set by whoever owns that storage: the sim worker (sim-worker.mjs, which posts the files to the page) or the page itself when the simulation
 * runs inline. A sink has
 *
 *   commitSlot({dir, files})   a save slot, whole: `files` is [{name, bytes, modified}], the level files first and `SaveInfo.dxs` last; the files the slot
 *                              held before and this list lacks are removed (DeleteSaveGameFiles). Resolves when the storage has taken it, rejects with the
 *                              StorageError that stopped it.
 *   removeSlot({dir})          DeleteGame: the directory and its files.
 *
 * With no sink (a headless validator, a page without storage) a save lives in the replica only. */
let sink = null;
export const setSaveSink = value => { sink = value; };
export const saveSink = () => sink;
