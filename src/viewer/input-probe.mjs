import { windowProbe } from './window-probe.mjs';
import { hudLogClock } from './view-probe.mjs';

/** Validation only (scripts/input-binding-cases.mjs, docs/input-bindings.md): what a key, button or wheel left behind, on whichever
 * side runs the simulation (sim-worker.mjs `call`, or the page with ?sim=inline). Reads only, except `summon`:
 *   {op: 'state', clear?}  the player's input flags and view, the item in hand and the weapon, the belt, the augmentations, the top
 *                          window and the console, the pause, the HUD log's row count and the seconds since its last message (HUDLogDisplay.lastLogMsg: AddLog resets it), and the binding lines run since the last
 *                          read (UInput::Exec's per-line dispatch, script-console-command.mjs `commandLog`; cleared unless
 *                          `clear: false`)
 *   {op: 'actor', name}    one level actor: class, owner, location, deleted
 *   {op: 'summon', cls}    the `summon` cheat (bCheatsEnabled written first, as view-probe.mjs `exec` does) and the name of the new actor */
export function inputProbe(game, { op = 'state', clear = true, name = null, cls = null } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor, host = game.hud.host;
  const level = runtime.levelFor(player);
  const read = (actor, field) => { try { return actor ? runtime.readNamed(actor, field) : undefined; } catch { return undefined; } };
  const classKey = actor => actor ? runtime.instance(actor).cls.record.key : null;
  const stateName = actor => actor ? runtime.instance(actor).state?.stateNode?.record.name ?? '' : null;
  if (op === 'summon') {
    const before = new Set(level.actors.map(actor => actor?.name));
    runtime.writeNamed(player, 'bCheatsEnabled', true);
    host.consoleCommands.consoleCommand(player, `summon ${cls}`);
    const made = level.actors.filter(actor => actor && !before.has(actor.name));
    return { actors: made.map(actor => actor.name), cls: made.map(classKey) };
  }
  if (op === 'actor') {
    const actor = level.actors.find(candidate => candidate?.name === name);
    if (!actor) return null;
    const owner = read(actor, 'Owner');
    return { name, cls: classKey(actor), owner: owner?.name ?? null, deleted: Boolean(read(actor, 'bDeleteMe')), hidden: Boolean(read(actor, 'bHidden')),
      location: [...read(actor, 'Location')], inObjectBelt: Boolean(read(actor, 'bInObjectBelt')), beltPos: read(actor, 'beltPos') };
  }
  if (op !== 'state') throw new Error(`inputProbe: unknown op ${op}`);
  const item = actor => actor && { name: actor.name, cls: classKey(actor), state: stateName(actor), anim: read(actor, 'AnimSequence'), frame: read(actor, 'AnimFrame') };
  const weapon = read(player, 'Weapon'), inHand = read(player, 'inHand'), ammo = read(weapon, 'AmmoType');
  const weaponState = weapon && { ...item(weapon), clip: read(weapon, 'ClipCount'), reloadCount: read(weapon, 'ReloadCount'),
    ammo: ammo ? { name: ammo.name, cls: classKey(ammo), amount: read(ammo, 'AmmoAmount') } : null,
    hasLaser: Boolean(read(weapon, 'bHasLaser')), lasing: Boolean(read(weapon, 'bLasing')), hasScope: Boolean(read(weapon, 'bHasScope')), zoomed: Boolean(read(weapon, 'bZoomed')) };
  const augs = [];
  for (let aug = read(read(player, 'AugmentationSystem'), 'FirstAug'); aug; aug = read(aug, 'next'))
    augs.push({ name: aug.name, cls: classKey(aug), hotKey: read(aug, 'HotKeyNum'), has: Boolean(read(aug, 'bHasIt')), active: Boolean(read(aug, 'bIsActive')) });
  const win = windowProbe(game);
  // The top window's first scroll area (a menu's list, a persona screen's): its rows, the visible rows, the thumb's position and step, and the
  // centre of its clip in drawing-buffer pixels (where a pointer lands on it).
  const W = host.W, rootWindow = read(player, 'rootWindow');
  let top = rootWindow ? W.ptr(rootWindow, 0x140) : 0;
  while (top && W.u8(top, 0x28) < 2) top = W.ptr(top, 0x144);
  const inherits = (window, key) => { for (let c = runtime.instance(window).cls; c; c = c.base) if (c.record.key === key) return true; return false; };
  const findArea = window => {
    if (inherits(window, 'extension.scrollareawindow')) return window;
    for (let child = W.ptr(window, 0x13c); child; child = W.ptr(child, 0x148)) { const found = findArea(child); if (found) return found; }
    return null;
  };
  const area = top ? findArea(top) : null, scale = area && W.ptr(area, 0x158), clip = area && W.ptr(area, 0x16c);
  const scroll = scale && clip ? { rows: W.i32(scale, 0x1c4), visible: W.i32(scale, 0x1cc), position: W.i32(scale, 0x1c8), step: W.i32(scale, 0x1d0),
    center: { x: W.f32(clip, 0xd4) + W.f32(clip, 0xe4) / 2, y: W.f32(clip, 0xd8) + W.f32(clip, 0xe8) / 2 } } : null;
  const hud = game.hud, log = hud?.hud ? hud.read(hud.read(hud.hud, 'msgLog'), 'winLog') : null;
  const commands = host.consoleCommands.state.commandLog;
  const flags = Object.fromEntries(['bRun', 'bDuck', 'bStrafe', 'bLook', 'bSnapLevel', 'bFire', 'bAltFire', 'bIsWalking', 'bIsCrouching', 'bAlwaysRun', 'bToggleWalk']
    .map(field => [field, Number(read(player, field)) || (read(player, field) === true ? 1 : 0)]));
  const result = {
    position: [...read(player, 'Location')], velocity: [...read(player, 'Velocity')], viewRotation: [...read(player, 'ViewRotation')],
    rotation: [...read(player, 'Rotation')], flags, lean: read(player, 'curLeanDist'), eyeHeight: read(player, 'EyeHeight'), fov: read(player, 'FOVAngle'),
    inHand: inHand?.name ?? null, inHandState: item(inHand), weapon: weaponState, belt: win.belt, top: win.top, console: win.console.state,
    paused: Boolean(read(level.actors[0], 'Pauser')), augs, scroll, logRows: log ? host.raw.read(log, 0x17c, 'i32') : null, logAge: hudLogClock(game)?.lastLogMsg ?? null,
    carried: read(player, 'CarriedDecoration')?.name ?? null, frobTarget: read(player, 'FrobTarget')?.name ?? null, commands: commands.map(entry => ({ ...entry })),
  };
  if (clear) commands.length = 0;
  return result;
}
