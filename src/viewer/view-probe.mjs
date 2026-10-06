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
 * non-brush actor nothing else follows). Returns the player's state. */
export function viewProbe(game, { ghost = false, location = null, rotation = null } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const read = name => runtime.readNamed(player, name);
  const commands = game.doors.scriptRuntime.windowHost?.consoleCommands;
  const output = [];
  if (ghost) {
    if (!commands) throw new Error('viewProbe: the console command chain needs the window host');
    runtime.writeNamed(player, 'bCheatsEnabled', true);
    for (const command of ['ghost', 'ShowHud False']) output.push(commands.consoleCommand(player, command));
  }
  if (location) {
    runtime.writeNamed(player, 'Location', location.map(Math.fround));
    runtime.writeNamed(player, 'Velocity', [0, 0, 0]);
  }
  if (rotation) runtime.writeNamed(player, 'ViewRotation', rotation.map(v => v | 0));
  const instance = runtime.instance(player), node = instance?.state ? (instance.state.stateNode ?? instance.cls) : null;
  return { location: [...read('Location')], viewRotation: [...read('ViewRotation')], eyeHeight: read('EyeHeight'),
    baseEyeHeight: read('BaseEyeHeight'), physics: read('Physics'), bCollideWorld: read('bCollideWorld'),
    state: scriptGetStateName(node), output };
}
