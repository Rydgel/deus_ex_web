import { scriptGetStateName } from '../runtime/script-state-queries.mjs';

/** Validation only (scripts/capture-play-views.mjs, docs/visual-acceptance.md):
 * the original-game captures' camera commands, on whichever side runs the
 * simulation (sim-worker.mjs `call`, or the page with ?sim=inline).
 *
 * `ghost` does what the capture script types into the original's console:
 * `set DeusEx.JCDentonMale bCheatsEnabled True` (written here directly), then
 * `ghost` and `ShowHud False` through the original console command chain
 * (APlayerPawn::execConsoleCommand, so PlayerPawn.Ghost and
 * DeusExPlayer.ShowHud run). `location`/`rotation` write Location, a zero
 * Velocity and ViewRotation directly, as the console's SET does
 * (UObject::GlobalSetProperty imports the text into the field; for a
 * non-brush actor nothing else follows). `exec` runs further console
 * commands the same way, after the same bCheatsEnabled write (main.mjs
 * ?cheat=, e.g. DeusExPlayer.Summon). Returns the player's state.
 *
 * `windowHold` (live-acceptance.mjs --frozen-frames): true stops the page's own frames from ticking the windows (game.tick), which
 * then tick only with `windowFrames`, the original's RootTick deltas traced around its frozen-phase console lines: list k ticks the
 * windows before this call's command k, the last list after its last command (`ghost`'s two commands, then `exec`'s). */
/** Validation: the HUD message log's clock (HUDLogDisplay.lastLogMsg against the player's logTimeout: a line logged in a capture's frozen phase,
 * a `ghost`'s, still waits while lastLogMsg is under the timeout), or null without the HUD. */
export function hudLogClock(game) {
  const hud = game.hud, log = hud?.hud ? hud.read(hud.hud, 'msgLog') : null;
  if (!log) return null;
  return { lastLogMsg: hud.read(log, 'lastLogMsg'), logTimeout: hud.read(game.player.collisionActor, 'logTimeout') };
}

export function viewProbe(game, { playersOnly = null, timeDilation = null, ghost = false, location = null, rotation = null, region = null, exec = [], rehash = false, rngPin = undefined,
  windowHold = null, windowFrames = null } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  // `set LevelInfo bPlayersOnly True`, which the original capture types
  // before `open` so the new level's LevelInfo starts with it: written here
  // before the held page's first tick (?hold=1), so Level.Tick runs only the
  // player from the start (level-tick.mjs).
  const info = runtime.levelFor(player).actors[0];
  // (`playersOnly: false` clears it: `set LevelInfo bPlayersOnly False`, the capture's unfrozen run, visual-acceptance.mjs --unfreeze)
  if (playersOnly !== null) runtime.writeNamed(info, 'bPlayersOnly', Boolean(playersOnly));
  // `rngPin` (a CRT rand state, hex text, or null to release): every SetupDynamics run of Play's frames starts from that state of the shared stream,
  // as the original's does with tools/dx-live-win.c `rngpin` (visual-acceptance.mjs --rng-pin): a frame whose items draw from the stream
  // (the lasers' last item) is then the same frame in both programs.
  if (rngPin !== undefined) game.rngPin = rngPin === null ? null : parseInt(rngPin, 16) >>> 0;
  // `set LevelInfo TimeDilation <x>`, which the capture uses to hold both
  // sides' level clocks at the same TimeSeconds (pulsing lights, panning).
  if (timeDilation !== null) runtime.writeNamed(info, 'TimeDilation', Math.fround(timeDilation));
  const read = name => runtime.readNamed(player, name);
  const commands = game.doors.scriptRuntime.windowHost?.consoleCommands;
  const output = [];
  if (windowHold !== null) game.windowHold = Boolean(windowHold);
  let windowFramesRun = 0;
  const tickWindows = k => { for (const delta of windowFrames?.[k] ?? []) if (game.hud) { game.hud.tick(delta); windowFramesRun++; } };
  const list = [...(ghost ? ['ghost', 'ShowHud False'] : []), ...exec];
  if (list.length) {
    if (!commands) throw new Error('viewProbe: the console command chain needs the window host');
    runtime.writeNamed(player, 'bCheatsEnabled', true);
    list.forEach((command, k) => {
      tickWindows(k);
      // `@rng <hex>`: the shared stream's state before the next command (visual-acceptance.mjs --cmd), as the original's
      // `dx-live-win.exe rngpin` writes it at the next ULevel::SpawnActor (nothing between the console line and the spawn draws).
      const rng = /^@rng ([0-9a-f]{1,8})$/i.exec(command);
      if (rng) { game.random.seed(parseInt(rng[1], 16) >>> 0); output.push(null); return; }
      output.push(commands.consoleCommand(player, command));
    });
  }
  tickWindows(list.length);
  if (location) {
    // The harness places the player where a capture's player stood (live-acceptance.mjs play, snap): the hash entry moves with
    // it. A bare write of Location leaves the registered cells and location stale, so the player's first later move (a
    // SetRotation from UpdateRotation) fails its RemoveActor check ("Remove actor before changing its registered location").
    const move = () => runtime.writeNamed(player, 'Location', location.map(Math.fround));
    // A ghost has no collision (PlayerPawn.Ghost: SetCollision(false, false, false) removed the hash entry; `actorRegistered` is the host's
    // flag and does not follow it): a bare write is what the original's SET does, and `walk` re-adds the actor at the new Location. Moving it
    // through changeActor there would register a ghost (Battery Park's Anna touched it and stopped two ticks early), and the next
    // SetCollision(true) fails ("Actor is already registered"). `rehash` (live-acceptance --ghost-in-hash) keeps the old behaviour.
    if (game.player.actorRegistered && (rehash || read('bCollideActors'))) game.player.collision.queries.changeActor(player, move); else move();
    runtime.writeNamed(player, 'Velocity', [0, 0, 0]);
  }
  if (rotation) runtime.writeNamed(player, 'ViewRotation', rotation.map(v => v | 0));
  // `set DeusEx.JCDentonMale Region (Zone=..., iLeaf=..., ZoneNumber=...)`.
  if (region) {
    const zone = runtime.levelFor(player).actors.find(actor => actor?.name === region.zone);
    if (!zone) throw new Error(`viewProbe: no zone actor ${region.zone}`);
    runtime.writeNamed(player, 'Region', { ...runtime.readNamed(player, 'Region'), 'engine.actor.pointregion.zone': zone,
      'engine.actor.pointregion.ileaf': region.iLeaf, 'engine.actor.pointregion.zonenumber': region.zoneNumber });
  }
  const instance = runtime.instance(player), node = instance?.state ? (instance.state.stateNode ?? instance.cls) : null;
  // Region.iLeaf and ZoneNumber: they decide the static lights the player's
  // mesh sees (docs/mesh-lighting.md), and `set Location` leaves the ones
  // the last move set.
  const current = read('Region');
  return { location: [...read('Location')],
    region: { iLeaf: current['engine.actor.pointregion.ileaf'], zoneNumber: current['engine.actor.pointregion.zonenumber'] }, viewRotation: [...read('ViewRotation')], eyeHeight: read('EyeHeight'),
    baseEyeHeight: read('BaseEyeHeight'), physics: read('Physics'), bCollideWorld: read('bCollideWorld'),
    state: scriptGetStateName(node), playersOnly: runtime.readNamed(info, 'bPlayersOnly'),
    timeSeconds: runtime.readNamed(info, 'TimeSeconds'), timeDilation: runtime.readNamed(info, 'TimeDilation'), output, windowFramesRun, windowHold: Boolean(game.windowHold), hudLog: hudLogClock(game),
    // The player's own animation (its mesh's pose follows it): a capture's reflection can differ by it.
    anim: { sequence: read('AnimSequence'), frame: read('AnimFrame'), rate: read('AnimRate'), blendFrames: [...read('BlendAnimFrame')] } };
}
