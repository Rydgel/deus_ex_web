/** Validation only (the typed-character browser check,
 * docs/script-window-typed-keys.md): the player's root window as the
 * simulation sees it, on whichever side runs it (sim-worker.mjs `call`, or
 * the page with ?sim=inline). Reads only: the topmost modal's class, the
 * focus window's class and, for a text window, its text (+0x168), the
 * keyboard grab count, the Console's state and TypedStr, and the player's
 * DeusExNote texts. */
export function windowProbe(game) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const host = game.doors.scriptRuntime.windowHost, W = host.W;
  const cls = win => win ? runtime.instance(win).cls.record.key : null;
  const root = runtime.readNamed(player, 'rootWindow');
  let top = root ? W.ptr(root, 0x140) : null;
  while (top && W.u8(top, 0x28) < 2) top = W.ptr(top, 0x144);
  const focus = root ? W.ptr(root, 0x5c8) : null;
  const family = focus ? host.families(focus) : null;
  const text = ['extension.editwindow', 'extension.textwindow', 'extension.largetextwindow'].includes(family) ? W.heap.read(focus, 0x168, 'string') : null;
  const console_ = runtime.readNamed(runtime.readNamed(player, 'Player'), 'Console');
  const notes = [];
  for (let note = runtime.readNamed(player, 'FirstNote'); note; note = runtime.readNamed(note, 'next')) notes.push(runtime.readNamed(note, 'text'));
  // Window.PlaySound requests (script-window-sound.mjs) and Galaxy's channels
  // that hold such a sound (no actor, a counter id), by sound name.
  const soundName = sound => String(sound?.key ?? sound?.name ?? sound);
  const audio = runtime.audio;
  const sounds = host.soundRequests.map(request => ({sound: soundName(request.sound), volume: request.volume, pan: request.pan,
    played: request.played ?? null}));
  const galaxy = audio ? {counter: audio.galaxy.state.counter, voices: audio.voices.size, galaxyVoices: audio.galaxyVoices,
    channels: audio.galaxy.state.channels.filter(c => c.sound && c.actor === null).map(c => ({sound: soundName(c.sound), id: c.id,
      voice: c.voice, radius: c.radius, volume: c.volume}))} : null;
  return {top: cls(top), focus: cls(focus), family, text, keyboardGrab: root ? W.i32(root, 0x5d0) : null,
    console: {state: runtime.instance(console_).state?.stateNode?.record.name ?? null, typed: runtime.readNamed(console_, 'TypedStr')}, notes,
    sounds, galaxy};
}
