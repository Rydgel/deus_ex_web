/** The original-side driver of the Stage 6 chain harness (docs/stage-6-chains.md): runs a chain (scripts/chains/mission*.mjs) in the original DeusEx.exe under Wine
 * through dxinput's keys and console lines, the same steps chain-play.mjs runs in Play, and writes what the original left (the flags, the travel text each map
 * change exported, the intermediate snapshots) to .work/chains/m<mission>/ (outside Git: the texts carry the game's data).
 *
 * The Wine lock, the launch, the quit and the Save folder's restore are scripts/travel-probe.sh's: this driver starts it in `follow` mode (a file of steps it
 * would read) and sends the steps itself through scripts/travel-step.sh and the dump tools (tools/dump-*.c), reading the game's state between them to know when
 * a step took effect (a conversation's event, a map change, a flag). One DeusEx.exe at a time, machine-wide: the probe waits for the lock.
 *
 *   node scripts/chain-original.mjs --mission 00 [--until <snap label>] [--keep]
 *
 * Needs the worktree's ad/build and ad/tools/dxinput.exe (built once in the main checkout, ignored by Git). */
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { placeLines, placementNear, flagsOfDump, loadChain, captureDirectory, STATE_FIELDS, slotDirectory, slotName } from './chain-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// the Mac runs the CrossOver bottle "DeusEx" (scripts/travel-probe.sh's Darwin branch), where a dump tool under Rosetta can take a minute on a loaded host
const MAC = process.platform === 'darwin', BOTTLE = process.env.CX_BOTTLE ?? 'DeusEx';
const env = MAC
  ? { ...process.env, CX_BOTTLE: BOTTLE, DX_WINE: process.env.DX_WINE ?? '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
    DX_GAME: process.env.DX_GAME ?? `${process.env.HOME}/Library/Application Support/CrossOver/Bottles/${BOTTLE}/drive_c/Deus Ex GOTY Edition` }
  : { ...process.env, WINEPREFIX: process.env.WINEPREFIX ?? `${process.env.HOME}/.wine-deusex`, DX_WINE: process.env.DX_WINE ?? '/usr/bin/wine', DX_DESKTOP: process.env.DX_DESKTOP ?? '1400x860' };
env.DX_GAME ??= process.env.DX_GAME ?? `${env.WINEPREFIX}/drive_c/Deus Ex GOTY Edition`;
const clean = text => String(text).split('\n').filter(line => !/MESA|pci id/.test(line)).join('\n').replace(/\r/g, '');
// the dump tools print one byte per character (dump-travel-win.c print_fstring: Latin-1, the speeches' é of mission 10's "Champs-Elysées"; names through
// WideCharToMultiByte(CP_ACP)): read as UTF-8, a byte above 0x7f became U+FFFD
const tool = (name, ...args) => {
  try { return clean(execFileSync(env.DX_WINE, [`ad/build/${name}.exe`, ...args], { env, cwd: ROOT, encoding: 'latin1', timeout: MAC ? 90000 : 30000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 27 })); }
  catch (error) { return ''; }
};
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };

export async function runChainInOriginal(chain, { log = console.log, until = null, tag = `chain-m${chain.mission}`, outDir = captureDirectory(chain.mission) } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const followFile = `${outDir}follow.txt`;
  writeFileSync(followFile, '');
  const probeOut = `${ROOT}/.work/travel/${tag}`;
  rmSync(probeOut, { recursive: true, force: true });
  const probeEnv = { ...env, DX_SAVE_BACKUP: `${ROOT}/.work/save-backup-${tag}`, ...(chain.userSet ? { DX_USER_SET: chain.userSet } : {}) };
  const probeLog = `${outDir}probe.log`;
  const probe = spawn('scripts/travel-probe.sh', [tag, `follow:${followFile}`], { cwd: ROOT, env: probeEnv, stdio: ['ignore', openLog(probeLog), openLog(probeLog)] });
  let probeExited = false;
  probe.on('exit', () => { probeExited = true; });
  const quit = async () => {
    if (!probeExited) { appendFileSync(followFile, 'quit\n'); for (let i = 0; i < 60 && !probeExited; i++) await sleep(1000); }
    if (!probeExited) probe.kill('SIGTERM');   // the probe this driver started (its trap quits the game)
  };
  process.on('SIGINT', () => { quit().then(() => process.exit(130)); });

  const result = { mission: chain.mission, snaps: {}, legs: [], steps: [], conversations: [], raw: {} };
  const note = text => { result.steps.push(text); log(text); };
  const step = (verb, ...args) => execFileSync('scripts/travel-step.sh', [probeOut, verb, ...args], { env, cwd: ROOT, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });

  /** The controlled player: the JCDentonMale whose Player (viewport) is set, with its level object. */
  const controlled = () => {
    for (const line of tool('dump-actor-win', 'JCDentonMale', 'Player:0x5d4:u32', 'XLevel:0xac:u32').split('\n')) {
      const m = /^JCDentonMale (JCDentonMale\d+) Player=0x([0-9a-f]+) XLevel=0x([0-9a-f]+)/.exec(line);
      if (m && parseInt(m[2], 16)) return { name: m[1], level: parseInt(m[3], 16) };
    }
    return null;
  };
  /** The level object a player stands in: its URL.Map and the TravelInfo text it kept. */
  const levelOf = pointer => {
    const dump = tool('dump-travel-win');
    for (const block of dump.split(/^(?=Level )/m)) {
      const header = /^Level \S+ slot \d+ at 0x([0-9a-f]+)/.exec(block);
      if (!header || parseInt(header[1], 16) !== pointer) continue;
      const map = /^ {2}URL\.Map: (.*)$/m.exec(block)?.[1] ?? null;
      const start = block.split('\n').findIndex(line => /^ {2}\[\d+\] value:$/.test(line));
      let text = null;
      if (start >= 0) { const lines = block.split('\n').slice(start + 1); const end = lines.findIndex(line => /^ {2}\[\d+\] end$/.test(line)); text = lines.slice(0, end < 0 ? undefined : end).join('\r\n'); }
      return { map, text, dump: block };
    }
    return null;
  };
  const flagsNow = () => { const p = controlled(); if (!p) return null; const raw = tool('dump-flags-win', p.name); return { raw, ...flagsOfDump(raw) }; };
  const where = () => { const p = controlled(); return p ? { ...p, ...(levelOf(p.level) ?? {}) } : null; };
  const hasFlag = (flags, name) => flags.flags.some(f => f.toLowerCase().startsWith(`${name.toLowerCase()}|`));
  const locationOf = () => {
    const p = controlled(); if (!p) return null;
    const line = tool('dump-actor-win', p.name, 'Location:0x114:f3', 'Physics:0x30:u8').split('\n').find(row => row.startsWith(`JCDentonMale ${p.name} `));
    const m = line && /Location=\(([^,]+),([^,]+),([^)]+)\) Physics=(\d+)/.exec(line);
    return m ? { at: [Number(m[1]), Number(m[2]), Number(m[3])], physics: Number(m[4]) } : null;
  };
  const type = async (line, settle = 700) => { step('cmd', line); await sleep(settle); };
  const press = async name => { step('key', name); };
  let current = null;   // { name, level, map }
  const refresh = () => { const w = where(); if (w) current = w; return w; };
  const waitArrival = async (previous, seconds = 150) => {
    for (let i = 0; i < seconds / 2; i++) {
      const p = controlled();
      if (p && p.level !== previous.level) {
        await sleep(3000);
        const w = where();
        if (w?.map) return w;
      }
      await sleep(1000);
    }
    throw new Error(`no arrival after ${seconds}s (the level is still ${previous.map})`);
  };

  const ops = {
    async start(s) {
      for (let i = 0; i < 90 && !(controlled()); i++) await sleep(2000);
      const first = where();
      if (!first?.map) throw new Error('the game did not come up (or tools/dump-travel-win.c is not built into ad/build: i686-w64-mingw32-gcc -O2 -o ad/build/dump-travel-win.exe tools/dump-travel-win.c -lpsapi)');
      current = first;
      if (s.kind === 'menu-training') {
        step('click', '640 360'); await sleep(800);
        step('click', '641 340');
        const arrived = await waitArrival(first);
        result.legs.push({ label: 'start', from: first.map, to: arrived.map, text: arrived.text });
        current = arrived;
        note(`start menu-training: in ${arrived.map}`);
      } else if (s.kind === 'new-game') {
        // the logo map's MenuMain by a click, New Game, a difficulty, Start Game (docs/travel.md "Play, step 2"; the prefix's User.ini has bAskedToTrain True: no box),
        // then Escape on the intro (ShowMainMenu on mission 98: PostIntro -> StartNewGame -> SendPlayer)
        step('click', '640 360'); await sleep(800);
        step('click', '641 196'); await sleep(800);
        step('click', `641 ${[287, 323, 359, 395][s.difficulty ?? 1]}`); await sleep(800);
        step('click', '797 565');
        const intro = await waitArrival(first);
        result.legs.push({ label: 'newgame-intro', from: first.map, to: intro.map, text: intro.text });
        current = intro;
        await sleep(3000);
        step('key', 'ESC');
        const island = await waitArrival(intro);
        result.legs.push({ label: 'newgame-island', from: intro.map, to: island.map, text: island.text });
        current = island;
        note(`start new-game: in ${island.map}`);
      } else if (s.kind === 'slot') {
        // the slot's files into the prefix's Save folder after the probe set the folder aside (DX_SAVE_BACKUP: it is put back whole when the session ends),
        // then the console's LoadGame from the logo map
        cpSync(slotDirectory(s), `${env.DX_GAME}/Save/${slotName(s.index)}`, { recursive: true });
        await type(`LoadGame ${s.index}`, 700);
        const arrived = await waitArrival(first);
        current = arrived;
        note(`start slot ${s.source} ${s.slot}: in ${arrived.map}`);
      } else if (s.kind === 'open') {
        await type(`LocalTravel ${s.map}`, 700);
        const arrived = await waitArrival(first);
        result.legs.push({ label: 'start', from: first.map, to: arrived.map, text: arrived.text });
        current = arrived;
        note(`start open ${s.map}: in ${arrived.map}`);
      } else throw new Error(`start ${s.kind} (not written yet)`);
    },
    async wait(s) {
      if (s.seconds !== undefined) { await sleep(s.seconds * 1000); note(`wait ${s.seconds}s`); return; }
      const limit = (s.timeout ?? 120) / 2;
      for (let i = 0; i < limit; i++) {
        const f = flagsNow();
        if (f && ((s.flag && hasFlag(f, s.flag)) || (s.notFlag && !hasFlag(f, s.notFlag)))) { note(`wait ${JSON.stringify(s)}`); return; }
        await sleep(2000);
      }
      throw new Error(`wait ${JSON.stringify(s)}: timed out`);
    },
    async line(s) { await type(s.text); note(`line ${s.text}`); },
    async place(s) {
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines(s)]) await type(line, 500);
        if (s.drop) { note(`place ${s.at.join(',')} (${s.harness ? 'harness' : 'player'}): dropped`); return; }
        await sleep((s.settle ?? 1) * 1000 + 800);
        const here = locationOf();
        if (here && Math.hypot(here.at[0] - s.at[0], here.at[1] - s.at[1]) < 25) { note(`place ${s.at.join(',')} (${s.harness ? 'harness' : 'player'}): the player is at ${here.at.map(v => Math.round(v * 10) / 10)}`); return; }
        note(`place attempt ${attempt + 1}: the player is at ${JSON.stringify(here)}`);
      }
      throw new Error(`place ${s.at}: the player never arrived`);
    },
    async placeNear(s) {
      const name = s.actor ?? s.class;
      let target = null;
      for (const line of tool('dump-actor-win', name, 'Location:0x114:f3', 'Owner:0x3c:obj').split('\n')) {
        const m = new RegExp(`^(\\S+) (${s.actor ?? `${s.class}\\d+`}) Location=\\(([^,]+),([^,]+),([^)]+)\\) Owner=(\\S+)`).exec(line);
        if (m && m[1] !== 'Class' && (s.actor || m[6] === 'None')) { target = [Number(m[3]), Number(m[4]), Number(m[5])].map(Math.fround); break; }
      }
      if (!target) throw new Error(`placeNear: the original has no ${name}`);
      const { at, view } = placementNear(target, s.distance, s.bearing);
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at, view, turnFirst: s.turnFirst })]) await type(line, 500);
        await sleep((s.settle ?? 1) * 1000 + 800);
        const here = locationOf();
        if (here && Math.hypot(here.at[0] - at[0], here.at[1] - at[1]) < 25) { note(`placeNear ${name} at ${target.map(v => Math.round(v))}: the player is at ${here.at.map(v => Math.round(v * 10) / 10)}`); return; }
      }
      throw new Error(`placeNear ${name}: the player never arrived`);
    },
    /** `placeNear`, then the right button once the view selects the actor, placed again while it does not (chain-play.mjs frobNear: a wandering owner). */
    async frobNear(s) {
      const tries = s.tries ?? 5;
      // `hold`: a wandering owner walks out of the view while the placement's lines are typed (about 1.5 s here, a few frames in Play): its class's
      // GroundSpeed is 0 from before the placement to the right button, then the owner's own value again (Pawn.GroundSpeed +0x378, chain-offsets.mjs)
      let release = null;
      if (s.hold) {
        const row = tool('dump-actor-win', s.actor, 'GroundSpeed:0x378:f').split('\n').find(line => new RegExp(`^\\S+ ${s.actor} `).test(line) && !line.startsWith('Class '));
        const cls = /^(\S+) /.exec(row ?? '')?.[1], speed = Number(/GroundSpeed=(\S+)/.exec(row ?? '')?.[1]);
        if (!cls || !Number.isFinite(speed)) throw new Error(`frobNear ${s.actor}: no GroundSpeed to hold`);
        await type(`set DeusEx.${cls} GroundSpeed 0`, 500); await sleep(1000);
        release = `set DeusEx.${cls} GroundSpeed ${speed}`;
        note(`frobNear ${s.actor}: held (${cls} GroundSpeed ${speed})`);
      }
      for (let attempt = 1; attempt <= tries; attempt++) {
        // a list of bearings is tried in turn: the original's owner can stand elsewhere than Play's, where one side of him is a wall
        const bearing = Array.isArray(s.bearing) ? s.bearing[(attempt - 1) % s.bearing.length] : s.bearing;
        try { await ops.placeNear({ ...s, bearing, turnFirst: true }); }
        catch (error) { if (!/never arrived/.test(error.message)) throw error; note(`frobNear ${s.actor}: placement ${attempt} (bearing ${bearing}) never arrived`); continue; }
        const p = controlled();
        const row = p ? tool('dump-actor-win', p.name, 'FrobTarget:0x9e8:obj').split('\n').find(line => line.startsWith(`JCDentonMale ${p.name} `)) : null;
        const target = /FrobTarget=(\S+)/.exec(row ?? '')?.[1] ?? '?';
        if (target !== s.actor) { note(`frobNear ${s.actor}: placement ${attempt} selects ${target}`); continue; }
        await type('ParseRightClick', 900); await sleep(600);
        if (release) await type(release, 500);
        note(`frobNear ${s.actor}: the right button after ${attempt} placement(s)`);
        return;
      }
      throw new Error(`frobNear ${s.actor}: the view never selected it in ${tries} placements`);
    },
    async frob(s) {
      // what the view selects, read before the press (DeusExPlayer.FrobTarget, the linked offset chain-offsets.mjs prints): a miss shows in the log
      const p = controlled();
      const row = p ? tool('dump-actor-win', p.name, 'FrobTarget:0x9e8:obj').split('\n').find(line => line.startsWith(`JCDentonMale ${p.name} `)) : null;
      const target = /FrobTarget=(\S+)/.exec(row ?? '')?.[1] ?? '?';
      await type('ParseRightClick', 900); await sleep(600);
      note(`frob ${target}${s.target && !target.toLowerCase().startsWith(s.target.toLowerCase()) ? ` (the chain names ${s.target})` : ''}`);
    },
    async click(s) {
      let n = 0;
      for (;;) {
        await press('ENTER'); n++;
        if (!s.until) break;
        await sleep((s.gap ?? 0.5) * 1000);
        const f = flagsNow();
        if (f && hasFlag(f, s.until.flag)) break;
        if (n >= (s.max ?? 8)) throw new Error(`click: ${s.until.flag} is not set after ${n} clicks`);
      }
      // `settle` counts Play's frames (60 a second) after the last click, as chain-play.mjs's click: a rocket still in flight when the next step places the player
      await sleep((s.settle ?? 30) / 60 * 1000);
      note(`click${n > 1 || s.until ? ` x${n}` : ''}`);
    },
    async belt(s) { await type(`ActivateBelt ${s.n}`, 900); await sleep(1000); note(`belt ${s.n}`); },
    async key(s) { for (const name of s.names) { await press(name); } note(`key ${s.names.join(' ')}`); },
    async type(s) { step('type', s.text); await sleep(500); note(`type ${s.text.length} characters`); },
    async point(s) { step('click', `${s.at[0]} ${s.at[1]}`); await sleep((s.settle ?? 1) * 1000); note(`point ${s.at.join(',')}`); },
    async walk(s) {
      // `untilTravel`: pulses of 0.1 s (the key up between them) until the player's level is another or gone (a map change under way), as chain-play.mjs
      if (s.untilTravel) {
        const before = controlled();
        let n = 0;
        for (; n * 0.1 < s.seconds; n++) {
          step('hold', s.key ?? 'UP', '100');
          const p = controlled();
          if (!p || (before && p.level !== before.level)) break;
        }
        note(`walk ${s.key ?? 'UP'} in ${n + 1} pulses`);
        return;
      }
      step('hold', s.key ?? 'UP', String(Math.round(s.seconds * 1000))); note(`walk ${s.key ?? 'UP'} ${s.seconds}s`);
    },
    /** A conversation, played as it comes (no key skips a speech: a skip races the choice that follows): wait for the player's conPlay, read its current event each round,
     * pick the listed choices (ArrowDown by their index, Enter) when the event is a ConEventChoice, and finish when the conPlay is gone. */
    async conv(s) {
      const picks = [...(s.choose ?? [])];
      const read = () => {
        const p = controlled(); if (!p) return null;
        const row = tool('dump-actor-win', p.name, 'conPlay:0x9f4:obj').split('\n').find(line => line.startsWith(`JCDentonMale ${p.name} `));
        const conPlay = /conPlay=(\S+)/.exec(row ?? '')?.[1];
        if (!conPlay || conPlay === 'None') return { conPlay: null };
        const ev = tool('dump-actor-win', conPlay, 'currentEvent:0x3c0:obj').split('\n').find(line => line.startsWith(`ConPlay ${conPlay} `));
        return { conPlay, event: /currentEvent=(\S+)/.exec(ev ?? '')?.[1] ?? null };
      };
      const deadline = Date.now() + (s.timeout ?? 180) * 1000 * 2;   // real time runs slower than the chain's Level seconds: twice the limit
      let started = false, lastPicked = null, rounds = 0;
      const trace = [], startMap = where()?.map ?? null;
      // a short conversation (a first-person bark, a radius conversation that fires a map exit) can begin and end between two reads: its _Played flag says it ran
      const played = () => Boolean(s.name) && (flagsNow()?.flags ?? []).some(f => f.toLowerCase().startsWith(`${s.name.toLowerCase()}_played|`) && f.endsWith('|1'));
      while (Date.now() < deadline) {
        const state = read();
        if (!state) { await sleep(2000); continue; }
        if (!state.conPlay && !started && ++rounds % 3 === 0 && played()) { started = true; trace.push('(played between reads)'); break; }
        // a conversation whose end fires a map exit can begin and end between two reads too, and its _Played flag may never be set (the exit cuts it
        // before SetPlayedFlag): the level changing under the step is it having run (mission 6's M06JockExit)
        if (!state.conPlay && !started && rounds % 3 === 0) {
          const here = where();
          if (here?.map && startMap && here.map.toLowerCase() !== startMap.toLowerCase()) { started = true; trace.push('(ran between reads: the level changed)'); break; }
        }
        if (state.conPlay) {
          started = true;
          if (state.event && trace.at(-1) !== state.event) trace.push(state.event);
          if (state.event?.startsWith('ConEventChoice') && state.event !== lastPicked) {
            const pick = picks.shift();
            if (!pick) throw new Error(`conversation ${s.name} reached a choice (${state.event}) with none to pick (trace ${trace.join(' ')})`);
            for (let i = 0; i < pick.index; i++) await press('DOWN');
            await press('ENTER');
            lastPicked = state.event;
            trace.push(`pick#${pick.index}${pick.label ? `(${pick.label})` : ''}`);
          }
        } else if (started) {
          // a conversation that ended without the named one's _Played flag was another one (an awake owner's ambient bark first, mission 12's
          // Savage_assistant_FBarks): the step waits on for its own (chain-play.mjs conv lets it run the same way)
          // (a conversation the step picked a choice in is its own: a branch that fires a map exit ends it before its _Played flag, mission 2's JockExit)
          if (!s.name || trace.some(t => t.startsWith('pick#'))) break;
          // its flag is read again for up to 30 s: a conversation whose end fires a map exit (mission 6's M06JockExit) has the flags unreadable while the
          // level changes, and its _Played is in the next level's table once the player is controlled again
          // A conversation whose end changes the level is the step's own as well: its map exit can cut it short before ConPlayBase.SetPlayedFlag
          // (mission 12's M12JockFinal2), and an owner's bark changes no level
          let own = false;
          for (let i = 0; i < 15 && !own; i++) {
            own = played();
            if (!own) { const here = where(); own = Boolean(here?.map && startMap && here.map.toLowerCase() !== startMap.toLowerCase()); }
            if (!own) await sleep(2000);
          }
          if (own) break;
          note(`conv ${s.name}: another conversation played first (${trace.join(' ')})`);
          started = false; lastPicked = null; trace.length = 0;
        }
        await sleep(1000);
      }
      if (!started) throw new Error(`conversation ${s.name} never started`);
      if (Date.now() >= deadline) throw new Error(`conversation ${s.name}: not over (trace ${trace.join(' ')})`);
      result.conversations.push({ name: s.name, trace });
      note(`conv ${s.name}: ${trace.join(' ')}`);
    },
    async travel(s) {
      const arrived = await waitArrival(current);
      if (s.to && arrived.map.toLowerCase().replace(/\.dx$/, '') !== s.to.toLowerCase().replace(/\.dx$/, '')) note(`travel: arrived in ${arrived.map} (the chain says ${s.to})`);
      result.legs.push({ label: s.label ?? `to-${s.to}`, from: current.map, to: arrived.map, text: arrived.text });
      note(`leg ${s.label}: ${current.map} -> ${arrived.map}, ${arrived.text?.length ?? 0} bytes`);
      current = arrived;
      await sleep((s.settle ?? 2) * 1000);
    },
    async gobjects(s) {
      step('gobjects', s.label);
      const from = `${probeOut}/${s.label}.gobjects.txt`;
      writeFileSync(`${outDir}${s.label}.gobjects.txt`, readFileSync(from));
      note(`gobjects ${s.label}`);
    },
    async watch(s) { note(`watch ${s.actors.join(' ')} (Play's stand-in for the original's rendering)`); },
    async save(s) { note(`save ${s.label} (Play's: the next chain's start)`); },
    async state(s) {
      const specs = s.fields.map(f => { const [off, type, mask] = STATE_FIELDS[f] ?? (() => { throw new Error(`state: no offset for ${f}`); })(); return `${f}:${off}:${type}${mask ? `:${mask}` : ''}`; });
      let line;
      if (s.presence) {
        // `presence` (chain-lib.mjs): the object of that name in the controlled player's level with bDeleteMe clear; a Destroy()ed actor stays in GObjObjects with
        // bDeleteMe set until the next purge, and an older level's object of the same name can still be in memory
        const p = controlled();
        const [off, type, mask] = STATE_FIELDS.bDeleteMe;
        const rows = tool('dump-actor-win', s.actor, 'XLevel:0xac:u32', `bDeleteMe:${off}:${type}:${mask}`, ...specs).split('\n').filter(row => new RegExp(`^\\S+ ${s.actor} `).test(row) && !row.startsWith('Class '));
        line = rows.find(row => p && parseInt(/XLevel=0x([0-9a-f]+)/.exec(row)?.[1] ?? '0', 16) === p.level && /bDeleteMe=0\b/.test(row));
        if (!line) { (result.states ??= {})[s.label] = { actor: s.actor, present: 0 }; note(`state ${s.label}: ${s.actor} absent (${rows.length} object(s) of that name)`); return; }
      } else line = tool('dump-actor-win', s.actor, ...specs).split('\n').find(row => new RegExp(`^\\S+ ${s.actor} `).test(row));
      if (!line) throw new Error(`state ${s.label}: the original has no ${s.actor}`);
      const row = s.presence ? { present: 1 } : {};
      // an object or a name reads as its text, a vector as its three numbers
      const value = text => text.startsWith('0x') ? parseInt(text, 16) : text.startsWith('(') ? text.slice(1, -1).split(',').map(Number) : Number.isNaN(Number(text)) ? text : Number(text);
      for (const f of s.fields) { const m = new RegExp(`${f}=(\\S+)`).exec(line); row[f] = m ? value(m[1]) : null; }
      (result.states ??= {})[s.label] = { actor: s.actor, ...row };
      note(`state ${s.label}: ${s.actor} ${JSON.stringify(row)}`);
    },
    async report(s) {
      const here = locationOf();
      result.reports ??= {};
      result.reports[s.label] = { map: current?.map, location: here?.at.map(v => Math.round(v * 10) / 10) ?? null };
      note(`report ${s.label}: ${current?.map} at ${result.reports[s.label].location}`);
    },
    async snap(s) {
      const f = flagsNow();
      if (!f) throw new Error('snap: no controlled player');
      const w = where();
      result.snaps[s.label] = { map: w?.map, flags: f.flags, defaultExpiration: f.defaultExpiration };
      writeFileSync(`${outDir}${s.label}.flags.txt`, f.raw);
      if (w?.text) writeFileSync(`${outDir}${s.label}.travel.txt`, w.text);
      step('snap', s.label);
      note(`snap ${s.label}: ${w?.map}, ${f.flags.length} flags`);
    },
  };

  try {
    for (const s of chain.steps) {
      if (!ops[s.op]) throw new Error(`unknown op ${s.op}`);
      try { await ops[s.op](s); } catch (error) { error.message = `step ${result.steps.length + 1} (${JSON.stringify(s)}): ${error.message}`; throw error; }
      if (until && s.op === 'snap' && s.label === until) break;
    }
    // the exit's own snapshot is the last leg's arrival text (already in result.legs)
    delete result.raw;
    writeFileSync(`${outDir}result.json`, JSON.stringify(result, null, 1));
    return result;
  } finally {
    await quit();
  }
}

function openLog(path) { return openSync(path, 'a'); }

if (import.meta.url === `file://${process.argv[1]}`) {
  const chain = await loadChain(option('mission', '00'), option('file', null));
  const result = await runChainInOriginal(chain, { until: option('until', null), tag: option('tag', undefined), outDir: option('out', undefined) });
  console.log(`done: ${result.legs.length} legs, ${Object.keys(result.snaps).length} snaps`);
  process.exit(0);
}
