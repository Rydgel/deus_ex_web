/** The page's end of the simulation worker (sim-worker.mjs, ?sim=worker;
 * docs/sim-worker.md "Frame protocol"). The page posts a frame every display
 * frame; the worker merges the posts that arrive while it is busy, so it
 * never waits for the page. Arrived snapshots wait in order until the page
 * takes them, each exactly once. Input commands queue here and go with the
 * next post. `onFrame(snapshot)` takes each snapshot as it arrives instead
 * (lockstep drawing); `onProgress(message)` sees the load's progress and
 * `onFailure(error)` a message the worker could not handle, and `onConfig({leaf, bytes, base})` a config file the game wrote
 * (docs/config-persistence.md); `onSave({op: 'commit', dir, files} | {op: 'remove', dir})` a save slot the game finished or deleted, for the page's storage
 * (docs/save-storage.md "Writing a save"). */
export function createSimClient({ onProgress = () => {}, onFrame = null, onFailure = () => {}, onConfig = () => {}, onSave = () => {} } = {}) {
  const worker = new Worker(new URL('./sim-worker.mjs', import.meta.url), { type: 'module' });
  const pending = new Map(), commands = [], settledWaiters = [];
  // `activeLoad`: the last map load's request id; a snapshot of an earlier
  // load (a frame in flight when the page loaded another map) is dropped.
  // `outstanding`: posts no snapshot has answered yet.
  let nextId = 1, ready = null, outstanding = 0, activeLoad = null;
  const waiting = [], spares = [];
  const settle = () => { for (const resolve of settledWaiters.splice(0)) resolve(); };
  const request = (message, transfer = []) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    if (message.type === 'load') { activeLoad = id; waiting.length = 0; }
    worker.postMessage({ ...message, id }, transfer);
  });
  const clock = () => ({ now: performance.now(), date: Date.now() });
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'ready': ready?.resolve(); break;
      case 'progress': onProgress(data.message); break;
      case 'config': onConfig({ leaf: data.leaf, bytes: data.bytes, base: data.base }); break;
      case 'save': onSave(data); break;
      case 'loaded': case 'result': {
        const entry = pending.get(data.id); pending.delete(data.id);
        entry?.resolve(data.type === 'result' ? data.value : data);
        break;
      }
      case 'frame':
        outstanding = Math.max(0, outstanding - data.posts);
        if (data.load === activeLoad && data.snapshot) {
          if (onFrame) onFrame(data.snapshot); else waiting.push(data.snapshot);
        }
        if (!outstanding) settle();
        break;
      case 'failure': {
        const error = Object.assign(new Error(data.error.message), { stack: data.error.stack });
        if (data.request === 'init') ready?.reject(error);
        const entry = data.id !== null ? pending.get(data.id) : null;
        if (entry) { pending.delete(data.id); entry.reject(error); }
        else {
          if (data.request === 'frame') { outstanding = Math.max(0, outstanding - data.posts); if (!outstanding) settle(); }
          onFailure(error);
        }
        break;
      }
    }
  };
  worker.onerror = event => onFailure(new Error(event.message ?? 'The simulation worker failed'));
  return {
    /** The DEUS_EX_* switches and the game files ({path, file} or {path, url}); `saved` the player's kept config files (a Map of leaf ->
     * {bytes, base}, config-store.mjs), or null where persistence is off; `saves` the Save directory's listing (save-persistence.mjs simSaves). */
    init(flags, files, saved = null, saves = null) {
      return new Promise((resolve, reject) => { ready = { resolve, reject }; worker.postMessage({ type: 'init', flags, files, saved, saves }); });
    },
    /** The Save directory changed (a folder picked, saves imported): the worker's directory is replaced; the Load Game screen reads it when it opens. */
    setSaves(saves) { worker.postMessage({ type: 'saves', saves }); },
    /** The picture the page made for a save's snapshot request (game-save.mjs): `data` the P8 indices of the grey 160 x 120 in the next power of two. */
    snapshotPixels(job, pitch, height, data) { worker.postMessage({ type: 'snapshot', job, pitch, height, data }, [data.buffer]); },
    /** Build a map's simulation side (sim-host.mjs options, plain). */
    load: (map, options) => request({ type: 'load', map, options }),
    /** `view`, `reset`, `stateDigest`, `musicStatus` or `musicDrive`, after
     * the frames posted before it. */
    call: (method, args = null) => request({ type: 'call', method, args, clock: clock() }),
    /** The worker's end of the page's channel to the music worklet. */
    connectMusic(port) { worker.postMessage({ type: 'music', port }, [port]); },
    queue(command) { commands.push(command); },
    get outstanding() { return outstanding; },
    /** Post one frame. `status` asks for the game status. */
    post(input, { status = false } = {}) {
      outstanding++;
      const returned = spares.splice(0);
      worker.postMessage({ type: 'frame', input, commands: commands.splice(0), clock: clock(), status, returned }, returned);
    },
    /** A snapshot's pack buffer the page is done with: it goes back to the
     * worker with the next post, which reuses it for a later frame instead of
     * allocating one (the buffer is detached here from then on). */
    recycle(buffer) { if (buffer instanceof ArrayBuffer && buffer.byteLength && spares.length < 4) spares.push(buffer); },
    /** The oldest snapshot not yet taken, or null. */
    take() { return waiting.shift() ?? null; },
    /** Arrived snapshots not yet taken. */
    get waiting() { return waiting.length; },
    /** Resolves when every post has its snapshot. */
    settled() { return outstanding ? new Promise(resolve => settledWaiters.push(resolve)) : Promise.resolve(); },
    terminate() { worker.terminate(); },
  };
}
