/** The page's end of the simulation worker (sim-worker.mjs, ?sim=worker;
 * docs/sim-worker.md "Frame protocol"). The page posts a frame every display
 * frame; the worker merges the posts that arrive while it is busy, so it
 * never waits for the page. Arrived snapshots wait in order until the page
 * takes them, each exactly once. Input commands queue here and go with the
 * next post. `onFrame(snapshot)` takes each snapshot as it arrives instead
 * (lockstep drawing); `onProgress(message)` sees the load's progress and
 * `onFailure(error)` a message the worker could not handle. */
export function createSimClient({ onProgress = () => {}, onFrame = null, onFailure = () => {} } = {}) {
  const worker = new Worker(new URL('./sim-worker.mjs', import.meta.url), { type: 'module' });
  const pending = new Map(), commands = [], settledWaiters = [];
  // `activeLoad`: the last map load's request id; a snapshot of an earlier
  // load (a frame in flight when the page loaded another map) is dropped.
  // `outstanding`: posts no snapshot has answered yet.
  let nextId = 1, ready = null, outstanding = 0, activeLoad = null;
  const waiting = [];
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
    /** The DEUS_EX_* switches and the game files ({path, file} or {path, url}). */
    init(flags, files) {
      return new Promise((resolve, reject) => { ready = { resolve, reject }; worker.postMessage({ type: 'init', flags, files }); });
    },
    /** Build a map's simulation side (sim-host.mjs options, plain). */
    load: (map, options) => request({ type: 'load', map, options }),
    /** `view`, `reset` or `stateDigest`, after the frames posted before it. */
    call: method => request({ type: 'call', method, clock: clock() }),
    queue(command) { commands.push(command); },
    get outstanding() { return outstanding; },
    /** Post one frame. `speech` holds the lip-sync channels' mixer
     * positions, `status` asks for the game status. */
    post(input, { speech = [], status = false } = {}) {
      outstanding++;
      worker.postMessage({ type: 'frame', input, commands: commands.splice(0), clock: clock(), speech, status });
    },
    /** The oldest snapshot not yet taken, or null. */
    take() { return waiting.shift() ?? null; },
    /** Arrived snapshots not yet taken. */
    get waiting() { return waiting.length; },
    /** Resolves when every post has its snapshot. */
    settled() { return outstanding ? new Promise(resolve => settledWaiters.push(resolve)) : Promise.resolve(); },
    terminate() { worker.terminate(); },
  };
}
