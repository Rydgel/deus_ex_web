/** The input bindings of User.ini's [Engine.Input], one case each, against an environment that presses the keys
 * (docs/input-bindings.md "The table").
 *
 * Two environments run the same cases: scripts/validate-input-bindings.mjs presses through `game.inputKey` / `inputWheel` /
 * `inputButton` on a headless Play game (fast, deterministic, in frames), browser-tests/input-bindings-table.spec.mjs presses real
 * keyboard, mouse and wheel events in Chromium's new headless mode against the page, with the simulation in its worker (the table is
 * that run's). Both read the state through input-probe.mjs and set a scene up with the same cheats (`summon`, `AugAdd`) and probes.
 *
 * env: {
 *   key(code, {hold}) -> {error}      a KeyboardEvent.code pressed, held `hold` ms, released
 *   down(code) / up(code)
 *   button(name, {hold}) / buttonDown(name) / buttonUp(name)    'LeftMouse' | 'MiddleMouse' | 'RightMouse'
 *   wheel(notches)                    +1 a notch up (WM_MOUSEWHEEL +120), -1 a notch down
 *   look(dx, dy)                      relative pointer motion (the pointer is locked)
 *   pointerTo({x, y})                 the pointer over a point of the drawing buffer (a window's cursor)
 *   wait(ms) / now()                  time passes; the environment's clock in ms (the frames of the headless game, or the wall clock)
 *   probe(args) / state()             input-probe.mjs; `state()` clears the command log
 *   exec(lines) / place(args)         view-probe.mjs `exec`, decal-probe.mjs placeProbe
 *   settings(step)                    settings-probe.mjs
 *   error()                           the page's or the game's last runtime stop or toast, or null
 * }
 * Results: a Map from the [Engine.Input] key name to {status, reached, effect, boundary}: status `ok`, `boundary` (delivered, the
 * command stops at a game system of a later stage, named) or `info`. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GAME_KEY_CODES, inputKeyNameForCode } from '../src/viewer/input-key-names.mjs';
import { gameDirectory } from './game-directory.mjs';

/** User.ini's [Engine.Input] rows (not the aliases), each with its KeyboardEvent.codes. DeusExRootWindow binds five more keys itself
 * when none of them is bound (docs/script-window-typed-keys.md): their rows say so. */
export const SCRIPT_BOUND = { T: 'Talk', Y: 'TeamTalk', B: 'BuySkills', K: 'KillerProfile', Equals: 'ShowScores' };
export async function readBindingRows() {
  const lines = (await readFile(`${gameDirectory()}/System/User.ini`, 'latin1')).split(/\r?\n/);
  const rows = [], aliases = [];
  let section = '';
  for (const line of lines) {
    const header = /^\[(.+)\]\s*$/.exec(line);
    if (header) { section = header[1]; continue; }
    if (section !== 'Engine.Input') continue;
    const alias = /^Aliases\[\d+\]=\(Command="(.*)",Alias=(\w+)\)/.exec(line);
    if (alias) { if (alias[2] !== 'None') aliases.push({ alias: alias[2], command: alias[1] }); continue; }
    const pair = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1];
    rows.push({ key, ini: pair[2], binding: SCRIPT_BOUND[key] ?? pair[2], scriptBound: key in SCRIPT_BOUND && pair[2] === '',
      joy: /^Joy/.test(key), codes: GAME_KEY_CODES.filter(code => inputKeyNameForCode(code)?.toLowerCase() === `ik_${key}`.toLowerCase()) });
  }
  return { rows, aliases };
}

let HOME = null;                                        // the player's start, read when the cases begin
const UNITS = 65536, wrap = value => (((Math.trunc(value) + 32768) % UNITS) + UNITS) % UNITS - 32768;
const KEY_RING = /^NanoKeyRing/;

/** `summon` an item in front of the player and turn the view to it: the name of the new actor. */
async function summonAndAim(env, cls) {
  const made = await env.probe({ op: 'summon', cls: `DeusEx.${cls}` });
  const name = made.actors.find(candidate => candidate.startsWith(cls)) ?? made.actors[0];
  assert.ok(name, `summon ${cls} made ${JSON.stringify(made)}`);
  await env.wait(1500);
  await env.place({ lookAt: name });
  await env.wait(600);
  return name;
}
async function waitOwned(env, name, timeout = 12_000) {
  const deadline = env.now() + timeout;
  for (;;) {
    const info = await env.probe({ op: 'actor', name });
    if (!info || info.owner || info.deleted) break;      // owned, or consumed into a stack (ammunition)
    if (env.now() > deadline) assert.fail(`${name} was not picked up`);
    await env.wait(100);
  }
  await env.wait(300);
}

export async function runInputBindings(env, { rows, aliases }) {
  // 200 units in front of Training's start, where all four directions have 100 units or more to walk
  { const start = (await env.probe({ op: 'state', clear: false })).position; HOME = [start[0] + 200, start[1], start[2]]; }
  const byKey = new Map(rows.map(row => [row.key.toLowerCase(), row]));
  const row = key => { const found = byKey.get(key.toLowerCase()); assert.ok(found, `User.ini has ${key}`); return found; };
  const results = new Map();
  const note = (key, info) => results.set(key, { ...results.get(key), ...info });
  const logged = (state, binding) => binding.split('|').map(part => part.trim()).every(part =>
    state.commands.some(entry => entry.action === 1 && entry.line.trim().toLowerCase() === part.toLowerCase()));
  const until = async (label, test, timeout = 10_000) => {
    const start = env.now();
    for (;;) {
      const state = await env.probe({ op: 'state', clear: false });
      const value = await test(state);
      if (value) return state;
      if (env.now() - start > timeout) throw new Error(`timed out waiting for ${label}: ${JSON.stringify({ inHand: state.inHand, top: state.top, belt: state.belt, weapon: state.weapon?.state })}`);
      await env.wait(50);
    }
  };
  // The command log is cleared by every state(): `commandsSince` keeps what the reads of one case took, `fresh()` starts a case.
  const commandsSince = [];
  const read = async () => { const state = await env.state(); commandsSince.push(...state.commands); return state; };
  const fresh = async () => { commandsSince.length = 0; await env.state(); };
  /** A binding's evidence: it reached the command (the log), and `check` saw its effect. */
  const mark = (key, state, effect, extra = {}) => {
    const binding = row(key).binding;
    const reached = state ? logged({ commands: [...state.commands, ...commandsSince] }, binding) : null;   // the lines the binding ran
    note(key, { status: 'ok', reached, effect, ...extra });
  };
  const idle = () => env.wait(300);
  const home = async () => { await env.place({ location: HOME, rotation: [0, 0, 0] }); await env.wait(500); await fresh(); };
  const closeWindows = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await env.probe({ op: 'state', clear: false });
      if (!state.top && state.console !== 'Typing') return;
      await env.key('Escape', { hold: 40 }); await env.wait(400);
    }
    assert.fail('a window stayed open');
  };
  const heldSample = async (code, { ms = 500, name = null } = {}) => {
    await read();
    if (name) await env.buttonDown(name); else await env.down(code);
    await env.wait(ms);
    const during = await env.probe({ op: 'state', clear: false });
    if (name) await env.buttonUp(name); else await env.up(code);
    await env.wait(250);
    return { during, after: await read() };
  };

  // ---- the keys that move and turn the player ----------------------------------------------------------------------------------------------
  for (const [key, axis, sign, what] of [['Up', 0, 1, 'forward'], ['W', 0, 1, 'forward'], ['Down', 0, -1, 'backward'], ['S', 0, -1, 'backward'],
    ['Left', 1, -1, 'left'], ['A', 1, -1, 'left'], ['Comma', 1, -1, 'left'], ['Right', 1, 1, 'right'], ['D', 1, 1, 'right'], ['Period', 1, 1, 'right']]) {
    for (const code of row(key).codes) {
      await home();
      const before = await read();
      const { after } = await heldSample(code, { ms: 600 });
      const d = after.position.map((value, i) => value - before.position[i]);
      assert.ok(sign * d[axis] > 20 && Math.abs(d[1 - axis]) < Math.abs(d[axis]), `${code} moves ${what}: ${d.map(Math.round)}`);
      mark(key, after, `the player moves ${what} (${Math.round(sign * d[axis])} units in 0.6 s)`);
    }
  }
  for (const [key, field, sign, what] of [['C', 'yaw', 1, 'turns right'], ['Z', 'yaw', -1, 'turns left'], ['R', 'pitch', 1, 'looks up'], ['Delete', 'pitch', 1, 'looks up'],
    ['V', 'pitch', -1, 'looks down'], ['PageDown', 'pitch', -1, 'looks down']]) {
    for (const code of row(key).codes) {
      await home();
      const before = await read();
      const { after } = await heldSample(code, { ms: 300 });
      const index = field === 'yaw' ? 1 : 0;
      const d = wrap(after.viewRotation[index] - before.viewRotation[index]);
      assert.ok(sign * d > 200, `${code} ${what}: ${d}`);
      mark(key, after, `the view ${what} (${field} ${d > 0 ? '+' : ''}${d} units)`);
    }
  }
  for (const key of ['Space', 'Insert']) {
    for (const code of row(key).codes) {
      await home();
      const before = await read();
      await env.down(code);
      let peak = before.position[2];
      for (let sample = 0; sample < 10; sample++) { await env.wait(60); peak = Math.max(peak, (await env.probe({ op: 'state', clear: false })).position[2]); }
      await env.up(code); await env.wait(600);
      assert.ok(peak - before.position[2] > 15, `${code} jumps: ${peak - before.position[2]}`);
      mark(key, await read(), `the player jumps (${Math.round(peak - before.position[2])} units up)`);
    }
  }
  // lean: held still, aExtra0 +-0.05 builds curLeanDist, which rolls the view (DeusExPlayer.ProcessMove)
  for (const [key, sign] of [['E', 1], ['Q', -1]]) {
    await home(); await idle();
    const { during, after } = await heldSample(row(key).codes[0], { ms: 700 });
    assert.ok(sign * during.lean > 0, `${key} leans: curLeanDist ${during.lean}`);
    mark(key, after, `the player leans ${sign > 0 ? 'right' : 'left'} (curLeanDist ${(+during.lean).toFixed(1)}, view roll ${wrap(during.viewRotation[2])})`);
    await env.wait(600);
  }

  // ---- the keys that hold a Button property ----------------------------------------------------------------------------------------------
  for (const [key, flag, what] of [['Shift', 'bRun', 'walks (bIsWalking: bAlwaysRun is on)'], ['Alt', 'bStrafe', 'the strafe modifier'], ['M', 'bLook', 'the look modifier'],
    ['X', 'bDuck', 'crouches'], ['NumPadPeriod', 'bDuck', 'crouches']]) {
    for (const code of row(key).codes) {
      await home();
      const { during, after } = await heldSample(code, { ms: 400 });
      assert.equal(during.flags[flag], 1, `${code} holds ${flag}`);
      assert.equal(after.flags[flag], 0, `${code} releases ${flag}`);
      let effect = `${flag} while held`;
      if (key === 'Shift') { assert.equal(during.flags.bIsWalking, 1); effect = `${flag} while held; the player ${what}`; }
      if (flag === 'bDuck') { assert.equal(during.flags.bIsCrouching, 1); effect = `bDuck while held; the player crouches (eye ${(+during.eyeHeight).toFixed(1)})`; }
      mark(key, after, effect);
    }
  }
  { // CenterView (bSnapLevel): from a view pitched up by LookUp the pitch returns to level
    for (const key of ['F', 'End']) for (const code of row(key).codes) {
      await home();
      await env.key('KeyR', { hold: 700 }); await env.wait(300);
      const before = await read();
      assert.ok(wrap(before.viewRotation[0]) > 3000, `the view is pitched up: ${before.viewRotation}`);
      const { during, after } = await heldSample(code, { ms: 700 });
      assert.equal(during.flags.bSnapLevel, 1, `${code} holds bSnapLevel`); assert.equal(after.flags.bSnapLevel, 0);
      assert.ok(Math.abs(wrap(after.viewRotation[0])) < 1500, `${code} centers the view: ${wrap(before.viewRotation[0])} -> ${wrap(after.viewRotation[0])}`);
      mark(key, after, `bSnapLevel while held; the view pitch ${wrap(before.viewRotation[0])} -> ${wrap(after.viewRotation[0])}`);
    }
  }

  // ---- the mouse ------------------------------------------------------------------------------------------------------------------------
  {
    await home();
    const before = await read();
    await env.look(60, 40); await env.wait(400);
    const after = await read();
    const dyaw = wrap(after.viewRotation[1] - before.viewRotation[1]), dpitch = wrap(after.viewRotation[0] - before.viewRotation[0]);
    assert.ok(dyaw !== 0, `MouseX turns the view: ${dyaw}`); assert.ok(dpitch !== 0, `MouseY pitches the view: ${dpitch}`);
    note('MouseX', { status: 'ok', reached: true, effect: `relative pointer motion turns the view (yaw ${dyaw > 0 ? '+' : ''}${dyaw})` });
    note('MouseY', { status: 'ok', reached: true, effect: `relative pointer motion pitches the view (pitch ${dpitch > 0 ? '+' : ''}${dpitch})` });
    await home();
  }
  {
    const { during, after } = await heldSample(null, { name: 'LeftMouse', ms: 300 });
    assert.equal(during.flags.bFire, 1); assert.equal(after.flags.bFire, 0);
    note('LeftMouse', { status: 'ok', reached: logged({ commands: [...commandsSince] }, 'ParseLeftClick|Fire'), effect: 'bFire while held (no weapon in hand)' });
    for (const code of row('Enter').codes) {
      const sample = await heldSample(code, { ms: 300 });
      assert.equal(sample.during.flags.bFire, 1);
      note('Enter', { status: 'ok', reached: logged({ commands: [...commandsSince] }, 'ParseLeftClick|Fire'), effect: 'bFire while held (no weapon in hand)' });
    }
  }

  // ---- windows, the menu, the console, the pause ----------------------------------------------------------------------------------------------
  for (const [key, top, what] of [['F1', /inventory/, 'the inventory screen opens'], ['I', /inventory/, 'the inventory screen opens'], ['F2', /goals/, 'the goals screen opens'],
    ['G', /goals/, 'the goals screen opens'], ['Escape', /menumain/, 'the main menu opens']]) {
    for (const code of row(key).codes) {
      await read();
      await env.key(code, { hold: 60 });
      const state = await until(`${code} to open a window`, s => s.top);
      assert.match(state.top, top, `${code} opens ${top}`);
      mark(key, state, `${what} (${state.top})`);
      await closeWindows();
    }
  }
  {
    await fresh();
    await env.key('NumpadDivide', { hold: 60 });
    const state = await until('QuickLoad to ask', s => s.top);
    assert.match(state.top, /messagebox/);
    note('GreySlash', { status: 'boundary', reached: logged({ commands: [...state.commands, ...commandsSince] }, 'QuickLoad'),
      effect: `the original's confirmation opens (${state.top}); answering it would read a save`,
      boundary: "loading a save (Stage 6's save system; only the confirmation is implemented)" });
    await closeWindows();
  }
  {
    await fresh();
    await env.key('KeyT', { hold: 60 });
    const state = await until('the console to type', s => s.console === 'Typing');
    mark('T', state, 'the console enters its Typing state (Talk)');
    await closeWindows();
    for (const key of ['B', 'K', 'Y', 'Equals']) {
      await fresh();
      await env.key(row(key).codes[0], { hold: 60 }); await env.wait(300);
      const s = await read();
      assert.equal(s.top, null, `${key} opens no window in single player`);
      mark(key, s, `${row(key).binding} ran; a multiplayer command, nothing opens in single player`);
      await closeWindows();
    }
  }
  {
    await fresh();
    await env.key('Pause', { hold: 60 });
    const paused = await until('Pause', s => s.paused);
    mark('Pause', paused, 'the level pauses; a second press resumes');
    await env.key('Pause', { hold: 60 });
    await until('the resume', s => !s.paused);
    const walking = await read();
    await env.key('CapsLock', { hold: 60 }); await env.wait(300);
    const on = await read();
    assert.notEqual(on.flags.bToggleWalk, walking.flags.bToggleWalk);
    mark('CapsLock', on, `ToggleWalk flips bToggleWalk (${walking.flags.bToggleWalk} -> ${on.flags.bToggleWalk}) and bIsWalking (${walking.flags.bIsWalking} -> ${on.flags.bIsWalking})`);
    await env.key('CapsLock', { hold: 60 }); await env.wait(300);
  }

  // ---- the keys without a binding: the press reaches the engine and runs nothing --------------------------------------------------------------------
  for (const unbound of rows.filter(candidate => !candidate.binding && !candidate.joy && candidate.codes.length)) {
    for (const code of unbound.codes) {
      await fresh();
      const pressed = await env.key(code, { hold: 40 });
      if (pressed.error) { note(unbound.key, { status: 'info', reached: null, effect: `not pressed here: ${pressed.error}` }); continue; }
      await env.wait(100);
      const state = await read();
      assert.deepEqual(state.commands, [], `${code} (${unbound.key}) has no binding and runs nothing`);
      if (state.top || state.console === 'Typing') await closeWindows();
      note(unbound.key, { status: 'ok', reached: null, effect: 'no binding: the press runs no command' });
    }
  }

  // ---- the belt, the hand and the weapons ------------------------------------------------------------------------------------------------
  await home();
  const give = async (cls, { rightMouse = false } = {}) => {
    const name = await summonAndAim(env, cls);
    await fresh();
    if (rightMouse) await env.button('RightMouse', { hold: 80 }); else await env.exec(['ParseRightClick']);
    await waitOwned(env, name);
    return name;
  };
  const multitool = await give('Multitool', { rightMouse: true });
  mark('RightMouse', await read(), `ParseRightClick picks up the highlighted ${multitool} (belt slot 1)`);
  const items = { Multitool: multitool };
  for (const cls of ['MedKit', 'Lockpick', 'BioelectricCell', 'Flare', 'Candybar', 'WeaponPistol']) items[cls] = await give(cls);
  items.Ammo10mm = await give('Ammo10mm');
  items.WeaponSawedOffShotgun = await give('WeaponSawedOffShotgun');
  items.AmmoShell = await give('AmmoShell'); items.AmmoSabot = await give('AmmoSabot');
  items.WeaponCrowbar = await give('WeaponCrowbar');
  await fresh();
  const filled = await read();
  assert.match(filled.belt[0], KEY_RING);
  assert.deepEqual(filled.belt.slice(1), [items.Multitool, items.MedKit, items.Lockpick, items.BioelectricCell, items.Flare, items.Candybar, items.WeaponPistol, items.WeaponSawedOffShotgun, items.WeaponCrowbar],
    'the pickups fill belt slots 1 to 9 in order');
  // ActivateBelt n: Digit n puts slot n's item in hand
  for (let slot = 0; slot < 10; slot++) {
    const code = `Digit${slot}`;
    await fresh();
    await env.key(code, { hold: 60 });
    const state = await until(`${code} to take belt slot ${slot}`, s => s.inHand === filled.belt[slot]);
    mark(String(slot), state, `ActivateBelt ${slot} puts ${filled.belt[slot]} in hand`);
    await env.wait(slot >= 7 ? 1200 : 300);
  }
  // the wheel: NextBeltItem and PrevBeltItem
  await env.key('Digit0', { hold: 60 });
  await until('the key ring', s => s.inHand === filled.belt[0]); await env.wait(300);
  const order = [...filled.belt];
  for (const [notches, expected, binding, key] of [[-1, order[1], 'NextBeltItem', 'MouseWheelDown'], [-1, order[2], 'NextBeltItem', 'MouseWheelDown'], [1, order[1], 'PrevBeltItem', 'MouseWheelUp']]) {
    await fresh();
    await env.wheel(notches);
    const state = await until(`the wheel to select ${expected}`, s => s.inHand === expected, 12_000);
    mark(key, state, `${binding} puts ${expected} in hand`);
    await env.wait(400);
  }
  {
    await fresh(); await env.wheel(1);
    await until('PrevBeltItem back to the key ring', s => s.inHand === order[0], 12_000);
    await env.wheel(1);
    const wrapped = await until('PrevBeltItem wraps to the last item', s => s.inHand === order[9], 12_000);
    note('MouseW', { status: 'ok', reached: null, effect: 'IK_MouseW is sent with every notch (the raw delta on the axis); User.ini binds nothing to it' });
    void wrapped;
  }
  // DropItem: Tab and the middle button. Each drops in front of the view, so the second faces another way: an item dropped where the
  // first lies has no room (DeusExPlayer.DropItem refuses it).
  for (const [key, slot, how, yaw] of [['Tab', 6, 'key', 0], ['MiddleMouse', 5, 'button', 16384]]) {
    await home();
    await env.place({ rotation: [0, yaw, 0] }); await env.wait(400);
    await env.key(`Digit${slot}`, { hold: 60 });
    await until(`slot ${slot}`, s => s.inHand === filled.belt[slot]); await env.wait(300);
    await fresh();
    if (how === 'key') await env.key('Tab', { hold: 60 }); else await env.button('MiddleMouse', { hold: 60 });
    const state = await until(`${filled.belt[slot]} to be dropped`, s => s.inHand === null && s.belt[slot] === null);
    const dropped = await env.probe({ op: 'actor', name: filled.belt[slot] });
    assert.equal(dropped.owner, null, `${filled.belt[slot]} left the inventory`);
    mark(key, state, `DropItem drops ${filled.belt[slot]} from the hand to the floor`);
    await env.wait(400);
  }
  // putting the hand away: Backspace (PutInHand) and a right click with nothing highlighted (ParseRightClick, PutInHand(None))
  for (const [key, how] of [['Backspace', 'key'], ['RightMouse', 'button']]) {
    await home();
    await env.key('Digit9', { hold: 60 });
    await until('the crowbar in hand', s => s.inHand === filled.belt[9] && s.inHandState?.state === 'Idle', 12_000);
    await env.place({ rotation: [6000, 0, 0] }); await env.wait(500);
    const ready = await read();
    assert.equal(ready.frobTarget, null, 'nothing is highlighted');
    if (how === 'key') await env.key('Backspace', { hold: 40 }); else await env.button('RightMouse', { hold: 40 });
    let first = null;
    const deadline = env.now() + 8000;
    for (;;) {
      const s = await env.probe({ op: 'state', clear: false });
      if (!first && s.inHandState?.state === 'DownWeapon') first = s.inHandState;
      if (s.inHand === null && s.weapon === null) { first = first ?? { anim: 'none seen' }; break; }
      if (env.now() > deadline) assert.fail(`${key}: the crowbar stayed in hand ${JSON.stringify(s.inHandState)}`);
      await env.wait(20);
    }
    const final = await read();
    const text = `the hand is put away: the weapon plays ${first.anim} in state ${first.state ?? 'DownWeapon'}, then inHand and Weapon are None`;
    if (key === 'Backspace') mark(key, final, `PutInHand: ${text}`);
    else note(key, { ...results.get(key), effect: `${results.get(key).effect}; with nothing highlighted: ${text}` });
    await env.wait(400);
  }
  // the pistol: Fire, ReloadWeapon, ToggleLaser, ToggleScope
  await home();
  await env.key('Digit7', { hold: 60 });
  await until('the pistol ready', s => s.weapon?.name === items.WeaponPistol && s.weapon.state === 'Idle', 15_000);
  const loaded = await read();
  assert.ok(loaded.weapon.ammo?.amount > 0, `the pistol has ammunition ${JSON.stringify(loaded.weapon.ammo)}`);
  const shots = async (action, label) => {
    const before = await env.probe({ op: 'state', clear: false });
    await action();
    const state = await until(`${label} to fire`, s => s.weapon && s.weapon.clip > before.weapon.clip, 8000);
    await until('the pistol idle', s => s.weapon.state === 'Idle', 8000);
    return { before, state };
  };
  {
    const { before, state } = await shots(() => env.button('LeftMouse', { hold: 60 }), 'LeftMouse');
    note('LeftMouse', { ...results.get('LeftMouse'), effect: `${results.get('LeftMouse').effect}; with the pistol: ClipCount ${before.weapon.clip} -> ${state.weapon.clip}` });
    const second = await shots(() => env.key('Enter', { hold: 60 }), 'Enter');
    note('Enter', { ...results.get('Enter'), effect: `${results.get('Enter').effect}; with the pistol: ClipCount ${second.before.weapon.clip} -> ${second.state.weapon.clip}` });
    const numpad = await shots(() => env.key('NumpadEnter', { hold: 60 }), 'NumpadEnter');
    void numpad;
  }
  {
    await fresh();
    const before = await read();
    assert.ok(before.weapon.clip >= 3);
    await env.key('Semicolon', { hold: 60 });
    const state = await until('the reload to finish', s => s.weapon && s.weapon.clip === 0, 15_000);
    mark('Semicolon', state, `ReloadWeapon reloads the pistol: ClipCount ${before.weapon.clip} -> 0 (${state.weapon.ammo.amount} rounds left)`);
    await until('the pistol idle', s => s.weapon.state === 'Idle', 8000);
  }
  await env.place({ set: { actor: items.WeaponPistol, fields: { bHasLaser: true, bHasScope: true } } });
  for (const [key, flag, what] of [['RightBracket', 'lasing', 'the laser sight'], ['LeftBracket', 'zoomed', 'the scope']]) {
    await fresh();
    await env.key(key === 'RightBracket' ? 'BracketRight' : 'BracketLeft', { hold: 60 });
    const on = await until(`${what} on`, s => s.weapon?.[flag], 6000);
    mark(key, on, `${row(key).binding} turns ${what} on (${flag})`);
    await env.wait(300);
    await env.key(key === 'RightBracket' ? 'BracketRight' : 'BracketLeft', { hold: 60 });
    await until(`${what} off`, s => !s.weapon?.[flag], 6000);
    await env.wait(300);
  }
  await env.key('Digit8', { hold: 60 });
  await until('the shotgun ready', s => s.weapon?.name === items.WeaponSawedOffShotgun && s.weapon.state === 'Idle', 15_000);
  {
    await fresh();
    const before = await read();
    assert.ok(before.weapon.ammo, 'the shotgun has an ammunition type');
    await env.key('Quote', { hold: 60 });
    const state = await until('the ammunition to change', s => s.weapon?.ammo && s.weapon.ammo.cls !== before.weapon.ammo.cls, 15_000);
    mark('SingleQuote', state, `SwitchAmmo cycles the shotgun's ammunition: ${before.weapon.ammo.cls} -> ${state.weapon.ammo.cls}`);
  }

  // ---- the augmentation keys -------------------------------------------------------------------------------------------------------------
  await env.key('Digit0', { hold: 60 }); await env.wait(600);
  await env.exec(['AugAdd AugLight', 'AugAdd AugSpeed', 'AugAdd AugBallistic']);
  await env.wait(500);
  const augState = await read();
  const slots = new Map(augState.augs.filter(aug => aug.has).map(aug => [aug.hotKey - 3, aug]));
  assert.ok(slots.size >= 2, `augmentations in slots ${[...slots.keys()]}`);
  for (let slot = 0; slot < 10; slot++) {
    const key = `F${slot + 3}`;
    const aug = slots.get(slot);
    if (!aug) await until('the HUD log to be quiet', state => state.logAge === null || state.logAge > 1.0, 8000);
    await fresh();
    const before = await read();
    await env.key(key, { hold: 60 });
    await env.wait(500);
    const after = await read();
    if (aug) {
      const now = after.augs.find(candidate => candidate.name === aug.name);
      assert.notEqual(now.active, aug.active, `${key} toggles ${aug.cls}`);
      mark(key, after, `ActivateAugmentation ${slot} toggles ${aug.cls} (active ${aug.active} -> ${now.active})`);
      await env.key(key, { hold: 60 }); await env.wait(400);
    } else {
      assert.ok(after.logAge < 1.0, `${key}: the empty slot is reported in the HUD log (${before.logAge} -> ${after.logAge})`);
      assert.deepEqual(after.augs.map(aug => aug.active), before.augs.map(aug => aug.active), `${key} toggles nothing`);
      mark(key, after, `ActivateAugmentation ${slot}: no augmentation in that slot; the HUD log gets its message (${before.logAge.toFixed(1)} s since the last -> ${after.logAge.toFixed(1)} s), nothing toggles`);
    }
  }

  void aliases;
  return results;
}

/** The wheel and the rebinding in the original's windows, after the world cases (docs/input-bindings.md). */
export async function runWindowCases(env, { rows }, results) {
  const until = async (label, test, timeout = 10_000) => {
    const start = env.now();
    for (;;) {
      const state = await env.probe({ op: 'state', clear: false });
      if (await test(state)) return state;
      if (env.now() - start > timeout) throw new Error(`timed out waiting for ${label}: ${JSON.stringify({ top: state.top, scroll: state.scroll })}`);
      await env.wait(50);
    }
  };
  const closeWindows = async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const state = await env.probe({ op: 'state', clear: false });
      if (!state.top && state.console !== 'Typing') return;
      await env.key('Escape', { hold: 40 }); await env.wait(400);
    }
    assert.fail('a window stayed open');
  };
  const windowNote = (key, text) => results.set(key, { ...results.get(key), windowEffect: text });
  await closeWindows();
  await env.place({ location: HOME, rotation: [0, 0, 0] }); await env.wait(500);

  // A screen that holds the mouse takes the wheel keys (XRootWindow::Process): the world's NextBeltItem does not run.
  await env.key('KeyI', { hold: 60 });
  await until('the inventory screen', s => /inventory/.test(s.top ?? ''));
  const held = await env.state();
  await env.wheel(-1); await env.wheel(1); await env.wait(500);
  const after = await env.state();
  assert.equal(after.inHand, held.inHand, 'the wheel did not change the hand while the inventory screen was open');
  assert.ok(!after.commands.some(entry => /BeltItem/.test(entry.line)), `no belt command ran: ${JSON.stringify(after.commands)}`);
  windowNote('MouseWheelDown', 'while a screen holds the mouse the root consumes the wheel keys and NextBeltItem does not run');
  windowNote('MouseWheelUp', 'while a screen holds the mouse the root consumes the wheel keys and PrevBeltItem does not run');
  await closeWindows();

  // The Customize Keys list is a scroll area: the wheel over it moves the thumb (XScrollAreaWindow's press of IK_MouseWheelUp/Down).
  await env.settings({ op: 'menu' }); await env.wait(400);
  await env.settings({ op: 'invoke', screen: 'MenuSettings' }); await env.wait(400);
  await env.settings({ op: 'invoke', screen: 'MenuScreenCustomizeKeys' }); await env.wait(600);
  const screen = await until('the Customize Keys screen', s => s.top === 'deusex.menuscreencustomizekeys' && s.scroll);
  assert.ok(screen.scroll.rows > screen.scroll.visible, `the key list scrolls (${screen.scroll.rows} rows, ${screen.scroll.visible} visible)`);
  assert.equal(screen.scroll.position, 0);
  await env.pointerTo(screen.scroll.center); await env.wait(300);
  await env.wheel(-1); await env.wait(300);
  assert.equal((await env.probe({ op: 'state', clear: false })).scroll.position, screen.scroll.step, 'a notch down scrolls the list one step');
  await env.wheel(-1); await env.wait(300);
  assert.equal((await env.probe({ op: 'state', clear: false })).scroll.position, 2 * screen.scroll.step);
  await env.wheel(1); await env.wheel(1); await env.wait(300);
  assert.equal((await env.probe({ op: 'state', clear: false })).scroll.position, 0, 'a notch up scrolls it back');
  windowNote('MouseWheelDown', `${results.get('MouseWheelDown').windowEffect}; over a scroll area (the Customize Keys list) it scrolls the list down`);
  windowNote('MouseWheelUp', `${results.get('MouseWheelUp').windowEffect}; over a scroll area it scrolls the list up`);

  // Rebinding: the second row's action goes to G, OK applies it (SET InputExt G ...), and the key runs the new binding.
  const binding = async key => (await env.settings({ op: 'console', command: `KEYBINDING ${key}` })).result;
  assert.equal(await binding('G'), 'ShowGoalsWindow');
  await env.key('ArrowDown', { hold: 40 }); await env.wait(300);
  await env.key('Enter', { hold: 40 }); await env.wait(300);
  await env.key('KeyG', { hold: 40 }); await env.wait(300);
  await env.settings({ op: 'action', action: 1 }); await env.wait(500);
  const rebound = await binding('G');
  assert.equal(rebound, 'ParseRightClick', "G now runs the second row's action");
  await closeWindows();
  await env.place({ location: HOME, rotation: [0, 0, 0] }); await env.wait(500);
  const item = await summonAndAim(env, 'Multitool');
  await env.state();
  await env.key('KeyG', { hold: 80 });
  await waitOwned(env, item);
  const picked = await env.state();
  assert.equal(picked.top, null, 'G no longer opens the goals screen');
  assert.ok(picked.commands.some(entry => entry.action === 1 && entry.line === 'ParseRightClick'), 'the rebound key ran ParseRightClick');
  windowNote('G', `rebound in MenuScreenCustomizeKeys to ${rebound}: the key then picks up the highlighted ${item} and opens no goals screen`);

  // The wheel is a key the menu takes too (the row waits for any key, mouse keys included): MouseWheelUp rebound runs its new binding.
  await env.settings({ op: 'menu' }); await env.wait(400);
  await env.settings({ op: 'invoke', screen: 'MenuSettings' }); await env.wait(400);
  await env.settings({ op: 'invoke', screen: 'MenuScreenCustomizeKeys' }); await env.wait(600);
  const list = await until('the Customize Keys screen', s => s.top === 'deusex.menuscreencustomizekeys' && s.scroll);
  await env.pointerTo(list.scroll.center); await env.wait(300);
  await env.key('ArrowDown', { hold: 40 }); await env.wait(300);
  await env.key('Enter', { hold: 40 }); await env.wait(300);
  await env.wheel(1); await env.wait(300);
  await env.settings({ op: 'action', action: 1 }); await env.wait(500);
  const wheelBinding = await binding('MouseWheelUp');
  assert.equal(wheelBinding, 'ParseRightClick', "the wheel was taken as the new key of the second row");
  await closeWindows();
  await env.place({ location: HOME, rotation: [0, 0, 0] }); await env.wait(500);
  const second = await summonAndAim(env, 'Multitool');
  await env.state();
  await env.wheel(1);
  await waitOwned(env, second);
  const wheeled = await env.state();
  assert.ok(wheeled.commands.some(entry => entry.action === 1 && entry.line === wheelBinding), `the wheel ran ${wheelBinding}`);
  windowNote('MouseWheelUp', `${results.get('MouseWheelUp').windowEffect}; rebound in MenuScreenCustomizeKeys (the wheel is taken as a key) to ${wheelBinding}, a notch up then runs it`);
  void rows;
}

/** The two keys whose command stops at a game system of a later stage; last, because QuickSave's stop pauses a page's Play. */
export async function runBoundaryCases(env, _table, results) {
  const note = (key, info) => results.set(key, { ...results.get(key), ...info });
  const fresh = async () => { await env.state(); };
  // ---- the keys whose command stops at a game system of a later stage ---------------------------------------------------------------------------
  await fresh();
  const shot = await env.key('NumpadMultiply', { hold: 60 });
  await env.wait(400);
  const shotError = shot.error ?? await env.error();
  assert.match(shotError ?? '', /SHOT is not implemented/, 'Shot stops at the viewport command');
  const shotLog = await env.state();
  assert.ok(shotLog.commands.some(entry => entry.action === 1 && entry.line === 'Shot'), 'the binding line Shot ran');
  note('GreyStar', { status: 'boundary', reached: true, effect: 'the binding line Shot ran; the viewport command is refused with a toast and Play goes on',
    boundary: 'the screenshot command (UViewport::Exec SHOT is not implemented)' });
  const save = await env.key('NumpadAdd', { hold: 60 });
  await env.wait(400);
  const saveError = save.error ?? await env.error();
  assert.match(saveError ?? '', /quicksave|3011/i, 'QuickSave stops at an unimplemented native');
  const saveLog = await env.state();
  assert.ok(saveLog.commands.some(entry => entry.action === 1 && entry.line === 'QuickSave'), 'the binding line QuickSave ran');
  note('GreyPlus', { status: 'boundary', reached: true, effect: 'the binding line QuickSave ran; DeusExPlayer.QuickSave reached its native and Play paused with the runtime error',
    boundary: "the save game system (original native 3011 is not implemented; Stage 6)" });
}
