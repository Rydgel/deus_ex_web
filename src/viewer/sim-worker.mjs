/** Play's simulation in a module worker (docs/sim-worker.md, ?sim=worker).
 * The worker holds its own asset store and the map's simulation side
 * (sim-host.mjs); the page keeps three.js, the DOM and Web Audio. Messages
 * are handled one at a time, in arrival order:
 *
 * - `init` {flags, files}: the page's DEUS_EX_* switches, set before the
 *   runtime's modules load, and the game files (File objects or dev-server
 *   URLs).
 * - `load` {id, map, options}: decode the map and build the simulation side;
 *   replies `loaded` with the first events, the HUD's textures, the notes
 *   and the actor layer's summary.
 * - `frame` {input, commands, clock, status}: apply the queued input
 *   commands in order, then one simulation frame (sim-session.mjs frame);
 *   replies `frame` with the snapshot, the audio events since the last one,
 *   the input answers and, when asked, the game status. The snapshot's
 *   packed words are transferred. Posts that arrive while the worker is
 *   busy merge into one frame (the latest page state, their dts summed,
 *   every command in order); the reply says how many posts it consumed.
 * - `music` {port}: the page's channel to Galaxy's worklet
 *   (galaxy-music-output.mjs). The library service on it
 *   (galaxy-music-library.mjs; music and, with its sample registry, the
 *   effect voices) lives as long as the worker, across map loads; batches
 *   go to the worklet and its reports come back on the port, never through
 *   the page.
 * - `call` {id, method, args}: `view`, `reset` (Player start: reset, then the
 *   movers and PlayerCalcView), `stateDigest`, `musicStatus` (the library
 *   service's counters), `musicDrive` (galaxy-music-library.mjs
 *   driveMusicLibrary, validation only).
 *
 * Everything that crosses is plain data (sim-session.mjs plainError for
 * errors). */
// `loadId`: the map load (its request id) that frames belong to.
let host = null, loadId = null, assets = null, decodeMap = null, createSimHost = null, setHostClock = null, plainError = null, stateDigest = null;
// Galaxy's music library service and its module (set by `music`).
let musicLibrary = null, music = null;
// Audio events since the last snapshot; sound bytes cross once per key.
const audio = [], sentSounds = new Set();
// The last answer to each key code and to the last pointer sample, for the
// page's synchronous decisions (preventDefault, pointer capture).
const keyAnswers = {};
let pointerGrab = false, toasts = [];
// Lip-sync channels' mixer positions, sampled by the page at the frame post.
const speechPositions = new Map();

const send = (message, transfer = []) => self.postMessage(message, transfer);
const errorOf = error => plainError ? plainError(error) : { name: 'Error', message: String(error?.message ?? error), stack: error?.stack ?? null };

function plainVoice(event) {
  const out = { ...event };
  if (event.op === 'start') {
    out.bytes = sentSounds.has(event.sound) ? null : event.bytes.slice();
    sentSounds.add(event.sound);
  }
  return out;
}
function plainSpeech(event) {
  if (event.kind === 'stop') return { kind: 'stop', id: event.id };
  const sound = event.audio.sound?.key ?? null;
  return { kind: event.kind, id: event.id, parameters: [...event.parameters],
    audio: { sound: sound ? { key: sound } : null, soundObject: event.audio.soundObject ?? null, bytes: event.audio.bytes.slice() } };
}

function command(game, entry, errors) {
  try {
    switch (entry.op) {
      case 'key': keyAnswers[entry.code] = game.inputKey(entry.code, entry.pressed) ?? { handled: false }; break;
      case 'button': game.inputButton(entry.name, entry.pressed); break;
      case 'motion': game.mouseMotion(entry.dx, entry.dy); break;
      case 'pointer': pointerGrab = game.windowPointer(entry.sample); break;
      case 'resetInput': game.resetInput(entry.options); break;
      case 'subtitles': game.subtitles = entry.value; break;
      case 'lipsync-attach': {
        const { id, pcm, rate } = entry;
        host.lipSync.attach(id, { pcm, rate, position: () => speechPositions.get(id) ?? 0 });
        break;
      }
      case 'lipsync-stop': host.lipSync.stop(entry.id); break;
      case 'lipsync-clear': host.lipSync.clear(); break;
      default: throw new Error(`Unknown simulation command ${entry.op}`);
    }
  } catch (error) {
    // A console-command keyword claim throws before its handler does any
    // work, so Play continues (main.mjs inputKey).
    if (entry.op === 'key' && error?.name === 'UnsupportedConsoleCommandError' && !error.partial) {
      keyAnswers[entry.code] = { handled: true };
      if (entry.pressed) toasts.push(`${entry.code}: ${error.message}`);
      return;
    }
    errors.push(errorOf(error));
  }
}

async function handle(data) {
  switch (data.type) {
    case 'init': {
      for (const [name, value] of Object.entries(data.flags)) globalThis[name] = value;
      const [{ AssetStore }, map, simHost, clock, session, digest, library] = await Promise.all([import('../unreal/assets.mjs'),
        import('../unreal/map.mjs'), import('./sim-host.mjs'), import('../runtime/host-clock.mjs'), import('./sim-session.mjs'),
        import('../runtime/state-digest.mjs'), import('../runtime/galaxy-music-library.mjs')]);
      decodeMap = map.decodeMap; createSimHost = simHost.createSimHost; setHostClock = clock.setHostClock; music = library;
      plainError = session.plainError; stateDigest = digest.stateDigest;
      assets = new AssetStore(data.files.map(file => ({ path: file.path, read: file.file ? () => file.file.arrayBuffer()
        : file.url ? async () => { const response = await fetch(file.url); if (!response.ok) throw new Error(`Cannot read ${file.path}`); return response.arrayBuffer(); }
        : async () => { throw new Error(`Native library bytes are not served: ${file.path}`); } })));
      send({ type: 'ready' });
      return;
    }
    case 'music': musicLibrary = music.connectMusicLibraryPort(data.port, { effects: true }); return;
    case 'load': {
      // The old map's audio unregisters its music first (sim-host.mjs
      // disposeAudio), so that batch reaches the worklet before any of the
      // next map's.
      host?.dispose?.(); host = null; loadId = data.id; audio.length = 0; speechPositions.clear(); pending = null;
      const asset = await assets.get(data.map);
      host = await createSimHost(decodeMap(asset.bytes), asset, assets, { ...data.options, musicLibrary,
        onConversationSpeech: event => {
          // Galaxy's lip-sync channels follow the speech on this side
          // (main.mjs playConversationSpeech on the page before).
          host?.lipSync.stop(event.id);
          if (event.kind !== 'stop') host?.lipSync.start(event);
          audio.push({ kind: 'speech', event: plainSpeech(event) });
        },
        onAudioVoice: event => audio.push({ kind: 'voice', event: plainVoice(event) }),
        onProgress: message => send({ type: 'progress', message }) });
      const summary = host.actorSim?.summary;
      send({ type: 'loaded', id: data.id, game: Boolean(host.game), hud: Boolean(host.game?.hud), lit: Boolean(host.meshLighting), notes: host.notes, gameNotes: host.game?.notes ?? [],
        events: host.events.splice(0), hudTextures: host.hudTextures,
        summary: summary ? structuredClone(summary) : null });
      return;
    }
    case 'frame': {
      if (!host?.game) { send({ type: 'frame', load: loadId, posts: data.posts, snapshot: null }); return; }
      setHostClock(data.clock);
      for (const [id, position] of data.speech ?? []) speechPositions.set(id, position);
      const errors = [];
      for (const entry of data.commands) command(host.game, entry, errors);
      const input = errors.length ? { ...data.input, halted: true } : data.input;
      const snapshot = host.session.frame(input);
      snapshot.errors.unshift(...errors);
      snapshot.audio = audio.splice(0);
      snapshot.answers = { keys: { ...keyAnswers }, pointerGrab };
      snapshot.toasts = toasts.splice(0);
      // Inspect: the camera this frame was culled for, which draws it; the
      // page's clock at the post (seconds), which animates its textures.
      snapshot.inspect = data.input.inspect ? { camera: data.input.inspect.camera, view: data.input.inspect.view } : null;
      snapshot.now = data.input.now;
      if (data.status) snapshot.status = { gameplay: host.game.status(), summary: host.actorSim ? structuredClone(host.actorSim.summary) : null,
        music: musicLibrary?.status() ?? null };
      send({ type: 'frame', load: loadId, posts: data.posts, snapshot }, snapshot.pack ? [snapshot.pack.buffer] : []);
      return;
    }
    case 'call': {
      // The frames posted before this call run first.
      await runPending();
      const game = host?.game;
      let value = null;
      if (data.method === 'musicStatus') value = musicLibrary?.status() ?? null;
      else if (data.method === 'musicDrive') value = await music.driveMusicLibrary(musicLibrary, assets, data.args ?? {});
      else if (game) {
        if (data.clock) setHostClock(data.clock);
        if (data.method === 'view') value = host.session.view();
        else if (data.method === 'reset') { host.session.reset(); value = { movers: host.session.movers(), view: host.session.view() }; }
        else if (data.method === 'stateDigest') value = stateDigest(game.doors.scriptRuntime.runtime,
          game.doors.scriptRuntime.runtime.levelFor(game.player.collisionActor));
        else throw new Error(`Unknown simulation call ${data.method}`);
      }
      // Events the call queued (Player start's lighting and mesh records)
      // reach the page with the next frame, as on the page.
      send({ type: 'result', id: data.id, value });
      return;
    }
    default: throw new Error(`Unknown simulation message ${data.type}`);
  }
}

// Frame posts not yet run, merged, and the scheduled run that takes them
// once the messages already queued have arrived.
let pending = null, runScheduled = false;
function mergeFrame(data) {
  pending = !pending ? { ...data, commands: [...data.commands], posts: 1 } : { ...data,
    input: { ...data.input, dt: pending.input.dt + data.input.dt }, commands: [...pending.commands, ...data.commands],
    status: pending.status || data.status, posts: pending.posts + 1 };
}
let chain = Promise.resolve();
const enqueue = (data, run) => {
  chain = chain.then(run).catch(error =>
    send({ type: 'failure', id: data.id ?? null, request: data.type, posts: error?.posts ?? 0, error: errorOf(error) }));
};
// A merged frame's run; a failure reports the posts it consumed.
async function runPending() {
  const frame = pending; pending = null;
  if (!frame) return;
  try { await handle(frame); } catch (error) { throw Object.assign(error, { posts: frame.posts }); }
}
self.onmessage = ({ data }) => {
  if (data.type !== 'frame') { enqueue(data, () => handle(data)); return; }
  mergeFrame(data);
  if (runScheduled) return;
  runScheduled = true;
  setTimeout(() => { runScheduled = false; enqueue({ type: 'frame' }, runPending); }, 0);
};
