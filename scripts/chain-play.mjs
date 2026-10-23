/** The Play driver of the Stage 6 chain harness (docs/stage-6-chains.md): runs a chain (scripts/chains/mission*.mjs) in Play's headless session through the
 * player's inputs and returns the result shape of scripts/chain-lib.mjs. A placement is a labelled harness step; everything else is a key edge, a console
 * line the original's console takes (an exec function the bindings call, `ParseRightClick`, `ActivateBelt`) or Level time passing.
 *
 *   node scripts/chain-play.mjs --mission 00 [--json out.json] [--until <label>] */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createMenuDriver } from '../src/viewer/menu-driver.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { PLAY_KEY, placeLines, flagsOfPlay, loadChain } from './chain-lib.mjs';

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
  if (/^(ghost|summon|set DeusEx|ActivateBelt|ParseRightClick)/i.test(line)) c.runtime.writeNamed(c.player(), 'bCheatsEnabled', true);
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

export async function runChainInPlay(chain, { assets = null, log = () => {}, until = null, onStep = null } = {}) {
  assets ??= await loadAssets();
  const directory = createSaveDirectory();
  const result = { mission: chain.mission, snaps: {}, legs: [], steps: [], conversations: [] };
  let c = null, pending = null, map = null, done = false;
  const note = text => { result.steps.push(text); log(text); };
  const frames = (n, stopOnTravel = true) => {
    for (let i = 0; i < n; i++) {
      c.frames(1);
      const request = c.takeTravel();
      if (request) { pending = request; if (stopOnTravel) return; }
    }
  };
  const flag = name => c.flag(name.toLowerCase());
  const arrive = async (request, label) => {
    result.legs.push({ label, from: map, to: request.map, text: request.travelInfo[0][1], restore: Boolean(request.restore), portal: request.portal ?? null, url: request.url });
    note(`leg ${label}: ${map} -> ${request.map}${request.portal ? `#${request.portal}` : ''}${request.restore ? ' (restored)' : ''}, ${request.travelInfo[0][1].length} bytes`);
    ({ c } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL }, saveDirectory: directory }));
    map = request.map;
    pending = null;
  };
  const stamp = names => { for (const name of names ?? []) { const a = c.actor(name); if (a) c.watched.add(a); else throw new Error(`no actor ${name} to stamp`); } };

  const ops = {
    async start(step) {
      ({ c } = await openSession('DX', assets, { travel: {}, saveDirectory: directory }));
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
    async frob(step) {
      stamp(step.watch);
      typeLine(c, 'ParseRightClick'); frames(step.settle ?? 30);
      note(`frob ${step.target ?? ''}`.trim());
    },
    async click(step) { pressKey(c, 'ENTER'); frames(step.settle ?? 30); note('click'); },
    /** A held key (the forward key by default): the player walks, as in the original's held-key captures; a travel the walk causes ends it. */
    async walk(step) {
      const code = PLAY_KEY[step.key ?? 'UP'];
      c.game.inputKey(code, true);
      const before = c.pos(c.player());
      frames(Math.round(step.seconds / FRAME));
      c.game.inputKey(code, false);
      c.frames(2);
      const after = c.pos(c.player());
      note(`walk ${step.key ?? 'UP'} ${step.seconds}s: ${Math.round(Math.hypot(after[0] - before[0], after[1] - before[1]))} units${pending ? `, travel to ${pending.map}` : ''}`);
    },
    async belt(step) { typeLine(c, `ActivateBelt ${step.n}`); frames(step.settle ?? 60); note(`belt ${step.n}`); },
    async key(step) { for (const name of step.names) { pressKey(c, name); frames(step.gap ?? 30); } note(`key ${step.names.join(' ')}`); },
    async conv(step) {
      stamp(step.watch);
      const choices = [...(step.choose ?? [])];
      let started = null, n = 0;
      const limit = Math.round((step.timeout ?? 180) / FRAME);
      const trace = [];
      for (; n < limit; n += 15) {
        const state = conversationOf(c);
        if (state && !started) { started = state; if (step.name && state.name !== step.name) throw new Error(`conversation ${state.name} started, expected ${step.name}`); }
        if (!state) { if (started) break; frames(15, false); continue; }
        if (trace.at(-1) !== `${state.event}@${state.label}`) trace.push(`${state.event}@${state.label}`);
        if (state.event === 'choice' || state.state === 'WaitForInput' && state.choices) {
          const pick = choices.shift();
          if (!pick) throw new Error(`conversation ${state.name} reached a choice with none to pick (trace ${trace.join(' ')})`);
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
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
  const chain = await loadChain(option('mission', '00'), option('file', null));
  const result = await runChainInPlay(chain, { log: line => console.log(line), until: option('until', null) });
  delete result.session;
  if (option('json', null)) await writeFile(option('json'), JSON.stringify(result, null, 1));
  console.log(`done: ${result.legs.length} legs, ${Object.keys(result.snaps).length} snaps`);
  process.exit(0);
}
