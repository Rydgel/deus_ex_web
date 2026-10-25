/** The Play driver of the Stage 6 chain harness (docs/stage-6-chains.md): runs a chain (scripts/chains/mission*.mjs) in Play's headless session through the
 * player's inputs and returns the result shape of scripts/chain-lib.mjs. A placement is a labelled harness step; everything else is a key edge, a console
 * line the original's console takes (an exec function the bindings call, `ParseRightClick`, `ActivateBelt`) or Level time passing.
 *
 *   node scripts/chain-play.mjs --mission 00 [--json out.json] [--until <label>] */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createMenuDriver } from '../src/viewer/menu-driver.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { PLAY_KEY, placeLines, placementNear, flagsOfPlay, loadChain, slotDirectory, slotName } from './chain-lib.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';

export async function loadAssets() {
  const root = gameDirectory(), files = [];
  for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
  return new AssetStore(files);
}

const FRAME = 1 / 60;

/** One console line as the original's input path takes it (live-probe.mjs): T goes to the root window first, and a window that takes it (a conversation's)
 * swallows the line; else the command chain runs it. The cheats flag is written as the capture's `set DeusEx.JCDentonMale bCheatsEnabled True` does. */
export function typeLine(c, line) {
  const game = c.game;
  if (game.windowKey('KeyT', true)) {
    game.windowKey('KeyT', false);
    for (let i = 0; i < 10; i++) { game.windowKey('Backspace', true); game.windowKey('Backspace', false); }
    game.windowKey('Enter', true); game.windowKey('Enter', false);
    return 'the keys went to the window that holds them';
  }
  game.windowKey('KeyT', false);
  const commands = game.doors.scriptRuntime.windowHost?.consoleCommands;
  if (!commands) throw new Error('no console command chain');
  if (/^(ghost|god|summon|set DeusEx|ActivateBelt|ParseRightClick)/i.test(line)) c.runtime.writeNamed(c.player(), 'bCheatsEnabled', true);
  return game.hud.scoped(() => commands.consoleCommand(c.player(), line));
}

/** A key press and release as the original's input path takes it: the root window is offered the key first (XInputExt::Process), the binding gets it otherwise. */
export function pressKey(c, name) {
  const code = PLAY_KEY[name];
  if (!code) throw new Error(`no key ${name}`);
  const game = c.game;
  const taken = game.windowKey(code, true);
  game.windowKey(code, false);
  if (!taken) { game.inputKey(code, true); c.frames(1); game.inputKey(code, false); }
  c.frames(1);
  return taken;
}

/** One character typed as the keyboard sends it: the key's press, its WM_CHAR unit and its release (an edit field takes the unit; validate-terminals-play.mjs). */
export function typeChar(c, ch) {
  const code = ch === ' ' ? 'Space' : /[0-9]/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`, shift = ch !== ch.toLowerCase();
  if (shift) c.game.inputKey('ShiftLeft', true);
  c.game.inputKey(code, true); c.game.inputChar(ch.charCodeAt(0)); c.game.inputKey(code, false);
  if (shift) c.game.inputKey('ShiftLeft', false);
  c.frames(1);
}

/** The player's conversation as Play shows it: { name, event class, event label, state } or null. */
export function conversationOf(c) {
  const conPlay = c.read(c.player(), 'conPlay');
  if (!conPlay) return null;
  const event = c.read(conPlay, 'currentEvent');
  const cls = event ? c.runtime.instance(event).cls.record.key.split('.').pop().replace('conevent', '') : null;
  const con = c.read(conPlay, 'con');
  return { name: con ? String(c.read(con, 'conName')) : null, event: cls, label: event ? c.read(event, 'label') || null : null, state: c.state(conPlay).split('.').pop(),
    choices: c.read(conPlay, 'conWinThird') ? c.read(c.read(conPlay, 'conWinThird'), 'numChoices') : null };
}

/** `sessionTravel`: more travel options for every level session the run opens (a save's `snapshotSource`, scripts/validate-save-load-play.mjs). */
export async function runChainInPlay(chain, { assets = null, log = () => {}, until = null, onStep = null, sessionTravel = {} } = {}) {
  assets ??= await loadAssets();
  // a save's picture: headless frames draw nothing, so a black one at once (no pending snapshot job that would wait for a frame)
  sessionTravel = { snapshotSource: () => null, ...sessionTravel };
  const directory = createSaveDirectory();
  const result = { mission: chain.mission, snaps: {}, legs: [], steps: [], conversations: [] };
  let session = null, c = null, pending = null, map = null, done = false;
  // a session that another replaces is disposed of before the next one opens (census-stage5-session.mjs dispose, as the page's map host does): a chain through
  // many maps otherwise keeps every level it left (about 425 MB each for 02_NYC_Street), and a level loading beside the one it replaces ran mission 3's ninth map
  // out of heap. Two turns of the event loop follow: the weak references this job dereferenced (the Rust VM registry's) keep their targets until the job ends,
  // and the finalization callbacks that release the level's image run as tasks of their own
  const open = async (name, options) => {
    session?.dispose();
    session = null; c = null;
    for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve));
    session = await openSession(name, assets, options);
    c = session.c;
  };
  const note = text => { result.steps.push(text); log(text); };
  const frames = (n, stopOnTravel = true) => {
    for (let i = 0; i < n; i++) {
      // an actor the run destroyed (a used Lockpick) is no longer stamped: its feedback would read a released object
      for (const a of [...c.watched]) { let gone = false; try { gone = c.gone(a); } catch { gone = true; } if (gone) c.watched.delete(a); }
      c.frames(1);
      // the first request is the travel (a player still in a teleporter's cylinder can raise another on a later tick, exported after more of the old level ran)
      const request = c.takeTravel();
      if (request) { pending ??= request; if (stopOnTravel) return; }
    }
  };
  const flag = name => c.flag(name.toLowerCase());
  const arrive = async (request, label) => {
    // a loaded game carries no travel text (LoadGame's request: no pairs): it is not a leg
    if (request.travelInfo.length) {
      result.legs.push({ label, from: map, to: request.map, text: request.travelInfo[0][1], restore: Boolean(request.restore), portal: request.portal ?? null, url: request.url });
      note(`leg ${label}: ${map} -> ${request.map}${request.portal ? `#${request.portal}` : ''}${request.restore ? ' (restored)' : ''}, ${request.travelInfo[0][1].length} bytes`);
    } else note(`loaded ${request.map} (${request.url})`);
    await open(request.map, { travel: { ...sessionTravel, arrival: request, lastURL: request.lastURL }, saveDirectory: directory });
    map = request.map;
    pending = null;
    if (process.env.CHAIN_HEAP) { globalThis.gc?.(); note(`heap ${Math.round(process.memoryUsage().heapUsed / 2 ** 20)} MB in ${map}; request keys ${Object.keys(request).join(',')}`); }
  };
  const stamp = names => { for (const name of names ?? []) { const a = c.actor(name); if (a) c.watched.add(a); else throw new Error(`no actor ${name} to stamp`); } };

  const ops = {
    async start(step) {
      await open('DX', { travel: { ...sessionTravel }, saveDirectory: directory });
      map = 'DX';
      c.frames(120);
      if (step.kind === 'menu-training') {
        c.key('Escape'); c.frames(20);
        const driver = createMenuDriver(c.game);
        if (driver.top() !== 'deusex.menumain') throw new Error(`Escape opened ${driver.top()}`);
        c.game.hud.scoped(() => driver.pressButton(4));
        frames(2);
        if (!pending) throw new Error('the Training button made no request');
        await arrive(pending, 'start');
      } else if (step.kind === 'new-game') {
        c.key('Escape'); c.frames(20);
        const driver = createMenuDriver(c.game);
        const scoped = fn => c.game.hud.scoped(fn);
        const expect = (label, top) => { if (driver.top() !== top) throw new Error(`${label}: the top window is ${driver.top()} (expected ${top})`); };
        scoped(() => driver.pressButton(0)); c.frames(30); expect('New Game', 'deusex.menuuimessageboxwindow');
        scoped(() => driver.pressField('btnNo')); c.frames(30); expect('the training box', 'deusex.menuselectdifficulty');
        scoped(() => driver.pressButton(step.difficulty ?? 1)); c.frames(30); expect('difficulty', 'deusex.menuscreennewgame');
        scoped(() => driver.pressActionKey('START')); frames(3);
        if (!pending) throw new Error('Start Game made no request');
        await arrive(pending, 'newgame-intro');
        c.frames(180);
        pressKey(c, 'ESC');                                    // ShowMainMenu on mission 98: PostIntro -> StartNewGame -> SendPlayer
        frames(600);
        if (!pending) throw new Error('Escape on the intro made no request');
        await arrive(pending, 'newgame-island');
      } else if (step.kind === 'slot') {
        // the slot's files in the save folder, then the console's LoadGame from the logo map (as the Load Game screen does: DeusExPlayer.LoadGame)
        const files = [];
        for (const name of await readdir(slotDirectory(step))) files.push({ name, bytes: new Uint8Array(await readFile(`${slotDirectory(step)}/${name}`)) });
        const info = files.find(file => file.name === 'SaveInfo.dxs');
        directory.put({ directory: slotName(step.index), files, info: info ? parseSaveInfo(info.bytes) : null });
        c.exec(`LoadGame ${step.index}`); frames(3);
        if (!pending) throw new Error(`LoadGame ${step.index} made no request`);
        await arrive(pending, 'start');
      } else if (step.kind === 'open') {
        // the console's LocalTravel from the logo map (the travel captures' way into a map: a player with no mission state)
        typeLine(c, `LocalTravel ${step.map}`); frames(3);
        if (!pending) throw new Error(`LocalTravel ${step.map} made no request`);
        await arrive(pending, 'start');
      } else throw new Error(`start ${step.kind}`);
      note(`start ${step.kind}: in ${map}`);
    },
    async wait(step) {
      const limit = Math.round((step.timeout ?? 120) / FRAME);
      if (step.seconds !== undefined) { frames(Math.round(step.seconds / FRAME), false); note(`wait ${step.seconds}s`); return; }
      let n = 0;
      for (; n < limit; n += 10) {
        if (step.flag && flag(step.flag)) break;
        if (step.notFlag && !flag(step.notFlag)) break;
        if (step.map && map.toLowerCase() === step.map.toLowerCase() && !pending) break;
        if (pending && !step.map) break;
        frames(10, false);
      }
      if (n >= limit) throw new Error(`wait ${JSON.stringify(step)}: timed out after ${step.timeout ?? 120}s`);
      note(`wait ${JSON.stringify(step)} after ${n / 60}s`);
    },
    async line(step) { const out = typeLine(c, step.text); frames(step.settle ?? 20); note(`line ${step.text}${out ? `: ${String(out).slice(0, 60)}` : ''}`); },
    async place(step) {
      const lines = step.cheats === false ? placeLines(step) : ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines(step)];
      for (const line of lines) { typeLine(c, line); frames(20); }
      if (step.drop) { note(`place ${step.at.join(',')} (${step.harness ? 'harness' : 'player'}): dropped`); return; }
      frames(Math.round((step.settle ?? 1) / FRAME));
      const at = c.pos(c.player());
      note(`place ${step.at.join(',')} (${step.harness ? 'harness' : 'player'}): the player is at ${at.map(v => Math.round(v * 10) / 10)}`);
    },
    async placeNear(step) {
      const target = step.actor ? c.actor(step.actor) : c.byClass(step.class).find(a => !c.read(a, 'Owner') && !c.gone(a));
      if (!target) throw new Error(`placeNear: no ${step.actor ?? step.class}`);
      const { at, view } = placementNear(c.pos(target), step.distance, step.bearing);
      c.watched.add(target);
      for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at, view, turnFirst: step.turnFirst })]) { typeLine(c, line); frames(20); }
      frames(Math.round((step.settle ?? 1) / FRAME));
      note(`placeNear ${target.name} at ${c.pos(target).map(Math.round)}: the player is at ${c.pos(c.player()).map(v => Math.round(v * 10) / 10)}, frob target ${c.game.interaction.frobTarget?.name ?? 'none'}`);
    },
    /** `placeNear`, then the right button once the view selects the actor; while it does not, the placement is made again (up to `tries`): an owner with
     * Wandering orders walks away from the place the view was aimed at during the placement's lines (the flag census's Filben and Alex). */
    async frobNear(step) {
      const tries = step.tries ?? 5;
      // `hold` (chain-original.mjs frobNear): the owner's class GroundSpeed is 0 from before the placement to the right button, then its own value again
      let release = null;
      if (step.hold) {
        const owner = c.actor(step.actor);
        if (!owner) throw new Error(`frobNear: no ${step.actor} to hold`);
        const cls = c.runtime.instance(owner).cls.record.key.split('.').pop(), speed = c.read(owner, 'GroundSpeed');
        typeLine(c, `set DeusEx.${cls} GroundSpeed 0`); frames(60);
        release = `set DeusEx.${cls} GroundSpeed ${speed}`;
        note(`frobNear ${step.actor}: held (${cls} GroundSpeed ${speed})`);
      }
      for (let attempt = 1; attempt <= tries; attempt++) {
        // a list of bearings is tried in turn (chain-original.mjs frobNear: the original's owner can stand elsewhere, beside a wall)
        const bearing = Array.isArray(step.bearing) ? step.bearing[(attempt - 1) % step.bearing.length] : step.bearing;
        await ops.placeNear({ ...step, bearing, turnFirst: true });
        if (c.game.interaction.frobTarget?.name !== step.actor) continue;
        stamp([step.actor]);
        typeLine(c, 'ParseRightClick'); frames(step.frobSettle ?? 30);
        if (release) typeLine(c, release);
        note(`frobNear ${step.actor}: the right button after ${attempt} placement(s)`);
        return;
      }
      throw new Error(`frobNear ${step.actor}: the view never selected it in ${tries} placements`);
    },
    async frob(step) {
      stamp(step.watch);
      const actor = c.game.interaction.frobTarget ?? null, target = actor?.name ?? null;
      // a step names its target by name, tag or class (a carcass, a lockpick on the floor, a door pair's tag)
      const names = actor ? [target, c.read(actor, 'Tag'), c.runtime.instance(actor).cls.record.key.split('.').pop()].map(n => String(n).toLowerCase()) : [];
      typeLine(c, 'ParseRightClick'); frames(step.settle ?? 30);
      if (step.target && !names.includes(step.target.toLowerCase())) throw new Error(`frob ${step.target}: the view selects ${target ?? 'nothing'}`);
      note(`frob ${target ?? ''}`.trim());
    },
    /** The left button (Enter): once, or, with `until: { flag }`, repeated every `gap` seconds up to `max` times until the flag is set (a weapon's swings: how many break a crate is the run's own). */
    async click(step) {
      stamp(step.watch);
      let n = 0;
      do { pressKey(c, 'ENTER'); n++; frames(Math.round((step.gap ?? 0.5) / FRAME)); } while (step.until && !flag(step.until.flag) && n < (step.max ?? 8));
      if (step.until && !flag(step.until.flag)) throw new Error(`click: ${step.until.flag} is not set after ${n} clicks`);
      frames(step.settle ?? 30);
      note(`click${n > 1 || step.until ? ` x${n}` : ''}`);
    },
    /** A held key (the forward key by default): the player walks, as in the original's held-key captures; a travel the walk causes ends it. */
    /** `untilTravel`: a walk into a teleporter or an exit, in pulses of 0.1 s with the key up between them, ending at the first pulse after which a map change
     * is under way, so no key is down when the next map starts (the original's driver pulses alike: its wall-clock hold outlasted the travel and walked the
     * player on in the next map, mission 3's hangar). */
    async walk(step) {
      const code = PLAY_KEY[step.key ?? 'UP'];
      const before = c.pos(c.player());
      if (step.untilTravel) {
        for (let held = 0; held < step.seconds && !pending; held += 0.1) { c.game.inputKey(code, true); frames(6); c.game.inputKey(code, false); if (!pending) frames(4); }
        const after = c.pos(c.player());
        note(`walk ${step.key ?? 'UP'} in pulses: ${Math.round(Math.hypot(after[0] - before[0], after[1] - before[1]))} units${pending ? `, travel to ${pending.map}` : ''}`);
        return;
      }
      c.game.inputKey(code, true);
      frames(Math.round(step.seconds / FRAME));
      c.game.inputKey(code, false);
      c.frames(2);
      const after = c.pos(c.player());
      note(`walk ${step.key ?? 'UP'} ${step.seconds}s: ${Math.round(Math.hypot(after[0] - before[0], after[1] - before[1]))} units${pending ? `, travel to ${pending.map}` : ''}`);
    },
    async belt(step) { typeLine(c, `ActivateBelt ${step.n}`); frames(step.settle ?? 60); note(`belt ${step.n}`); },
    async key(step) { for (const name of step.names) { pressKey(c, name); frames(Math.round((step.gap ?? 0.5) / FRAME)); } note(`key ${step.names.join(' ')}`); },
    async type(step) { for (const ch of step.text) typeChar(c, ch); frames(step.settle ?? 15); note(`type ${step.text.length} characters`); },
    async point(step) {
      const root = c.read(c.player(), 'rootWindow'), W = c.game.doors.scriptRuntime.windowHost.W;
      const x = step.at[0] - 640 + W.f32(root, 0xe4) / 2, y = step.at[1] - 360 + W.f32(root, 0xe8) / 2;
      for (const action of [1, 3]) { if (!c.game.windowPointer({ relative: false, x, y, key: 1, action })) throw new Error(`point ${step.at}: the root does not take the pointer`); frames(2); }
      frames(step.settle ?? 30);
      note(`point ${step.at.join(',')} (Play's root ${x},${y})`);
    },
    async conv(step) {
      stamp(step.watch);
      const choices = [...(step.choose ?? [])];
      let started = null, n = 0;
      const limit = Math.round((step.timeout ?? 180) / FRAME);
      const trace = [];
      for (; n < limit; n += 15) {
        const state = conversationOf(c);
        if (state && !started) { started = state; if (step.name && String(state.name).toLowerCase() !== step.name.toLowerCase()) throw new Error(`conversation ${state.name} started, expected ${step.name}`); }
        if (!state) { if (started) break; frames(15, false); continue; }
        if (trace.at(-1) !== `${state.event}@${state.label}`) trace.push(`${state.event}@${state.label}`);
        if (state.event === 'choice' || state.state === 'WaitForInput' && state.choices) {
          const pick = choices.shift();
          // the buttons the window shows (ConWindowActive.DisplayChoice: each button's userObject is its ConChoice), by the label each jumps to
          // (a choice's own label is a ChoiceSpeechLabel_N: its speech, then the Jump to the branch the chain names; the label shown is that branch)
          const conPlay = c.read(c.player(), 'conPlay'), win = c.read(conPlay, 'conWinThird'), con = c.read(conPlay, 'con');
          const branch = label => {
            let event = c.read(con, 'eventList');
            while (event && String(c.read(event, 'label') ?? '').toLowerCase() !== String(label).toLowerCase()) event = c.read(event, 'nextEvent');
            for (let n = 0; event && n < 8; n++, event = c.read(event, 'nextEvent'))
              if (c.runtime.instance(event).cls.record.key.endsWith('coneventjump')) return String(c.read(event, 'jumpLabel'));
            return String(label);
          };
          const shown = (c.read(win, 'conChoices') ?? []).slice(0, c.read(win, 'numChoices')).map(b => { const choice = b ? c.read(b, 'userObject') : null; return choice ? branch(c.read(choice, 'choiceLabel')) : null; });
          if (!pick) throw new Error(`conversation ${state.name} reached a choice with none to pick: ${JSON.stringify(shown)} (trace ${trace.join(' ')})`);
          if (pick.label && shown[pick.index]?.toLowerCase() !== pick.label.toLowerCase())
            throw new Error(`conversation ${state.name}: choice ${pick.index} jumps to ${shown[pick.index]}, not ${pick.label}: ${JSON.stringify(shown)}`);
          for (let i = 0; i < pick.index; i++) { pressKey(c, 'DOWN'); frames(3); }
          pressKey(c, 'ENTER'); frames(30);
          trace.push(`pick#${pick.index}${pick.label ? `(${pick.label})` : ''}`);
          continue;
        }
        pressKey(c, 'ENTER'); frames(30);
      }
      if (n >= limit) throw new Error(`conversation ${step.name}: not over after ${step.timeout ?? 180}s (trace ${trace.join(' ')})`);
      if (!started) throw new Error(`conversation ${step.name} never started`);
      result.conversations.push({ name: started.name, trace });
      note(`conv ${started.name}: ${trace.join(' ')}`);
    },
    async travel(step) {
      const limit = Math.round((step.timeout ?? 60) / FRAME);
      let n = 0;
      for (; !pending && n < limit; n += 30) frames(30);
      if (!pending) throw new Error(`travel to ${step.to}: no request after ${step.timeout ?? 60}s`);
      if (step.to && pending.map.toLowerCase() !== step.to.toLowerCase()) throw new Error(`travel went to ${pending.map} (expected ${step.to})`);
      await arrive(pending, step.label ?? `to-${step.to}`);
      frames(step.settle ?? 120, false);
    },
    async gobjects(step) { note(`gobjects ${step.label} (the original's capture only)`); },
    /** A headless frame draws no actor mesh, so a pawn is never 'rendered' and its radius conversation or low-priority tick never runs: the named actors are stamped as the renderer
     * stamps an actor in view (the Stage 5 census's feedback), for the rest of the map. The original's frames render them (a harness stand-in for the page's drawing). */
    async watch(step) { stamp(step.actors); note(`watch ${step.actors.join(' ')}`); },
    async state(step) {
      const a = c.actor(step.actor);
      // `presence`: a pawn a mission script destroyed (or one the level never had) is a reading, not a failure (the flag census's FirstFrame readers)
      if (step.presence) {
        let gone = !a;
        try { gone ||= c.gone(a); } catch { gone = true; }
        if (gone) { (result.states ??= {})[step.label] = { actor: step.actor, present: 0 }; note(`state ${step.label}: ${step.actor} absent`); return; }
      }
      if (!a) throw new Error(`state ${step.label}: no actor ${step.actor}`);
      const row = step.presence ? { present: 1 } : {};
      // an object reads as its name (the original's dump prints the name)
      for (const f of step.fields) { const v = c.read(a, f); row[f] = typeof v === 'boolean' ? Number(v) : v && typeof v === 'object' && !Array.isArray(v) && 'name' in v ? v.name : v; }
      (result.states ??= {})[step.label] = { actor: step.actor, ...row };
      note(`state ${step.label}: ${step.actor} ${JSON.stringify(row)}`);
    },
    async report(step) {
      result.reports ??= {};
      result.reports[step.label] = { map, location: c.pos(c.player()).map(v => Math.round(v * 10) / 10) };
      note(`report ${step.label}: ${map} at ${result.reports[step.label].location}`);
    },
    async snap(step) {
      const { flags, defaultExpiration } = flagsOfPlay(c);
      result.snaps[step.label] = { map, flags, defaultExpiration };
      note(`snap ${step.label}: ${map}, ${flags.length} flags`);
    },
    /** The console's SaveGame: the slot the next mission's chain starts from in both programs (`--save-exit` pins it under the chain's capture directory). */
    async save(step) {
      // a conversation holds the keyboard (a bark that started after the last step): the save waits for it to end, then goes through the viewport's Exec chain
      // as a harness line (the console's own path would hand its keys to the conversation)
      for (let n = 0; conversationOf(c) && n < 3600; n += 30) frames(30, false);
      if (conversationOf(c)) throw new Error(`save ${step.label}: conversation ${conversationOf(c).name} still playing`);
      c.game.hud.scoped(() => c.game.hud.host.consoleCommands.consoleCommand(c.player(), `SaveGame ${step.index}`)); frames(5, false);
      const name = slotName(step.index);
      const files = directory.files(name).map(file => ({ name: file.name, bytes: directory.readFile(name, file.name) }));
      if (!files.length) throw new Error(`SaveGame ${step.index} left no ${name}`);
      (result.saves ??= {})[step.label] = { slot: name, files };
      note(`save ${step.label}: ${name}, ${files.length} files in ${map}`);
    },
  };

  for (const step of chain.steps) {
    if (done) break;
    if (!ops[step.op]) throw new Error(`unknown op ${step.op}`);
    try { await ops[step.op](step); } catch (error) { error.message = `step ${result.steps.length + 1} (${JSON.stringify(step)}): ${error.message}`; throw error; }
    onStep?.(step, { c, map });
    if (until && step.op === 'snap' && step.label === until) done = true;
  }
  // the leg a last request left pending (a chain ends at the exit: its text is the last thing compared)
  if (pending) { result.legs.push({ label: 'exit', from: map, to: pending.map, text: pending.travelInfo[0][1], restore: Boolean(pending.restore), portal: pending.portal ?? null, url: pending.url }); note(`exit request ${map} -> ${pending.map}`); }
  result.session = c;
  result.saveDirectory = directory;
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
  const chain = await loadChain(option('mission', '00'), option('file', null));
  const result = await runChainInPlay(chain, { log: line => console.log(line), until: option('until', null) });
  delete result.session; delete result.saveDirectory;
  if (process.argv.includes('--save-exit')) {
    for (const [label, { slot, files }] of Object.entries(result.saves ?? {})) {
      const target = slotDirectory({ source: 'chain', chain: chain.mission, label, slot });
      rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
      for (const file of files) await writeFile(`${target}/${file.name}`, file.bytes);
      console.log(`pinned ${label}: ${target} (${files.length} files)`);
    }
  }
  for (const save of Object.values(result.saves ?? {})) delete save.files;
  if (option('json', null)) await writeFile(option('json'), JSON.stringify(result, null, 1));
  console.log(`done: ${result.legs.length} legs, ${Object.keys(result.snaps).length} snaps`);
  process.exit(0);
}
