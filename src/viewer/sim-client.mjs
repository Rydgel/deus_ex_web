/** The page's end of the simulation worker (sim-worker.mjs, ?sim=worker;
 * docs/sim-worker.md "Frame protocol"). At most one frame is in flight: the
 * page posts frame N+1 when snapshot N has arrived, then draws N, so the
 * worker simulates while the page draws. Input commands queue here and go
 * with the next frame. `onFrame(snapshot)` sees each snapshot as it
 * arrives (lockstep drawing); `onProgress(message)` the load's progress;
 * `onFailure(error)` a message the worker could not handle. */
export function createSimClient({ onProgress = () => {}, onFrame = null, onFailure = () => {} } = {}) {
  const worker = new Worker(new URL('./sim-worker.mjs', import.meta.url), { type: 'module' });
  const pending = new Map(), commands = [], settledWaiters = [];
  // `activeLoad`: the last map load's request id; a snapshot of an earlier
  // load (a frame in flight when the page loaded another map) is dropped.
  let nextId = 1, ready = null, inflight = false, latest = null, activeLoad = null;
  const settle = () => { for (const resolve of settledWaiters.splice(0)) resolve(); };
  const request = (message, transfer = []) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    if (message.type === 'load') { activeLoad = id; latest = null; }
    worker.postMessage({ ...message, id }, transfer);
  });
  const clock = () => ({ now: performance.now(), date: Date.now() });
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'ready': ready?.resolve(); break;
      case 'progress': onProgress(data.message); break;
      case 'loaded': case 'result': {
        const entry = pending.get(data.id); pending.delete(data.id);
        entry?.resolve(data.type === 'result' ? data.value : data);
        break;
      }
      case 'frame':
        inflight = false;
        if (data.load === activeLoad && data.snapshot) { if (onFrame) onFrame(data.snapshot); else latest = data.snapshot; }
        settle();
        break;
      case 'failure': {
        const error = Object.assign(new Error(data.error.message), { stack: data.error.stack });
        if (data.request === 'init') ready?.reject(error);
        const entry = data.id !== null ? pending.get(data.id) : null;
        if (entry) { pending.delete(data.id); entry.reject(error); }
        else { if (data.request === 'frame') { inflight = false; settle(); } onFailure(error); }
        break;
      }
    }
  };
  worker.onerror = event => onFailure(new Error(event.message ?? 'The simulation worker failed'));
  return {
    /** The DEUS_EX_* switches and the game files ({path, file} or {path, url}). */
    init(flags, files) {
      return new Promise((resolve, reject) => { ready = { resolve, reject }; worker.postMessage({ type: 'init', flags, files }); });
    },
    /** Build a map's simulation side (sim-host.mjs options, plain). */
    load: (map, options) => request({ type: 'load', map, options }),
    /** `view`, `reset` or `stateDigest`, after the frames posted before it. */
    call: method => request({ type: 'call', method, clock: clock() }),
    queue(command) { commands.push(command); },
    get inflight() { return inflight; },
    /** Post one frame unless one is in flight; true when posted. `speech`
     * holds the lip-sync channels' mixer positions, `status` asks for the
     * game status. */
    post(input, { speech = [], status = false } = {}) {
      if (inflight) return false;
      inflight = true;
      worker.postMessage({ type: 'frame', input, commands: commands.splice(0), clock: clock(), speech, status });
      return true;
    },
    /** The newest snapshot not yet taken, or null. */
    take() { const snapshot = latest; latest = null; return snapshot; },
    /** Resolves when no frame is in flight. */
    settled() { return inflight ? new Promise(resolve => settledWaiters.push(resolve)) : Promise.resolve(); },
    terminate() { worker.terminate(); },
  };
}
