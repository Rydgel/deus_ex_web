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
 * ?cheat=, e.g. DeusExPlayer.Summon). Returns the player's state. */
export function viewProbe(game, { playersOnly = null, timeDilation = null, ghost = false, location = null, rotation = null, region = null, exec = [] } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  // `set LevelInfo bPlayersOnly True`, which the original capture types
  // before `open` so the new level's LevelInfo starts with it: written here
  // before the held page's first tick (?hold=1), so Level.Tick runs only the
  // player from the start (level-tick.mjs).
  const info = runtime.levelFor(player).actors[0];
  // (`playersOnly: false` clears it: `set LevelInfo bPlayersOnly False`, the capture's unfrozen run, visual-acceptance.mjs --unfreeze)
  if (playersOnly !== null) runtime.writeNamed(info, 'bPlayersOnly', Boolean(playersOnly));
  // `set LevelInfo TimeDilation <x>`, which the capture uses to hold both
  // sides' level clocks at the same TimeSeconds (pulsing lights, panning).
  if (timeDilation !== null) runtime.writeNamed(info, 'TimeDilation', Math.fround(timeDilation));
  const read = name => runtime.readNamed(player, name);
  const commands = game.doors.scriptRuntime.windowHost?.consoleCommands;
  const output = [];
  if (ghost || exec.length) {
    if (!commands) throw new Error('viewProbe: the console command chain needs the window host');
    runtime.writeNamed(player, 'bCheatsEnabled', true);
    for (const command of [...(ghost ? ['ghost', 'ShowHud False'] : []), ...exec])
      output.push(commands.consoleCommand(player, command));
  }
  if (location) {
    runtime.writeNamed(player, 'Location', location.map(Math.fround));
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
    timeSeconds: runtime.readNamed(info, 'TimeSeconds'), timeDilation: runtime.readNamed(info, 'TimeDilation'), output,
    // The player's own animation (its mesh's pose follows it): a capture's reflection can differ by it.
    anim: { sequence: read('AnimSequence'), frame: read('AnimFrame'), rate: read('AnimRate'), blendFrames: [...read('BlendAnimFrame')] } };
}
