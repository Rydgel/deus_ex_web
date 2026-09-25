/** Shared Training probe engine for the reach census and the Stage 3
 * conformance gate (docs/stage-3-exit-criteria.md).
 *
 * Boots 00_Training through Play's createGame, runs startup and idle level
 * ticks, then drives each interaction family through its public Play entry:
 * every actor with a Frob body through game.use() (ParseRightClick), every
 * decoration Bump, every non-pawn Touch, and each exec command bound in the
 * installed User.ini [Engine.Input]. Sequence probes chain two of those entries
 * where the second one's path depends on state the first leaves (a read
 * DataCube adds the note the Goals screen then edits), so a reboot between
 * them in the flat order cannot hide that path. Every probe is followed by
 * painted level ticks, as Play runs them, and a game.reset().
 *
 * The ScriptRuntime prototype is instrumented before the first boot, so the
 * LoadMap startup passes that run inside createGame are observed too. Play's
 * startup and pawn tick loops catch a failing actor's error into
 * `npcFailures` and skip that actor afterwards; those swallowed failures are
 * recorded as `swallowed` after every boot, probe and reset, so a boundary
 * cannot hide behind the catch.
 *
 * continueMode returns the declared zero value from an unsupported native (the
 * Play host's final "Unsupported original door native N" fallthrough) and
 * records it, so one probe lists every native its path reaches rather than only
 * the first. Values after such a return are not original behavior: that mode is
 * planning data, never evidence. */
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PROBE_GROUPS = Object.freeze(['idle', 'frob', 'bump', 'touch', 'exec', 'sequence']);

/** Run `script --child ...args` in its own process and SIGKILL it past capMiB
 * RSS (the fire-path OOM note: heap caps alone do not bound native growth).
 * The child writes its JSON result to `out`. */
export async function runChildWithWatchdog({script, args, out, capMiB, label}) {
  const started = Date.now();
  const proc = spawn(process.execPath, ['--max-old-space-size=6144', script, '--child', '--out', out, ...args],
    {stdio: ['ignore', 'inherit', 'inherit']});
  let peak = 0, killed = false;
  const watch = setInterval(() => {
    try {
      const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(proc.pid)], {encoding: 'utf8'})) / 1024;
      peak = Math.max(peak, rss);
      if (rss > capMiB && !killed) { killed = true; proc.kill('SIGKILL'); }
    } catch { /* exited */ }
  }, 500);
  const code = await new Promise(resolve => proc.on('exit', resolve));
  clearInterval(watch);
  if (killed) { console.error(`${label} child killed at ${capMiB} MiB RSS`); process.exit(2); }
  if (code !== 0 || !existsSync(out)) { console.error(`${label} child exited ${code}`); process.exit(1); }
  return {data: JSON.parse(readFileSync(out, 'utf8')), seconds: Math.round((Date.now() - started) / 1000), peakMiB: Math.round(peak)};
}

const UNSUPPORTED_NATIVE = /^(?:Unsupported original door native|Unimplemented original native|VM does not support native) (\d+)/;

export async function runTrainingProbes({groups = PROBE_GROUPS, continueMode = false, all = false, only = null,
  finalIdle = false, log = message => process.stderr.write(`${message}\n`)} = {}) {
  const {AssetStore} = await import('../src/unreal/assets.mjs');
  const {decodeMap} = await import('../src/unreal/map.mjs');
  const {createGame} = await import('../src/viewer/game.mjs');
  const {ScriptRuntime} = await import('../src/runtime/script-runtime.mjs');
  const {zeroValue} = await import('../src/runtime/script-values.mjs');
  const {gameDirectory} = await import('./game-directory.mjs');

  // Native names from the decoded package declarations (inventory-script-runtime.mjs).
  const names = new Map();
  const inventoryPath = path.join(root, '.cache/script-runtime-inventory.json');
  if (existsSync(inventoryPath))
    for (const pkg of JSON.parse(readFileSync(inventoryPath, 'utf8')).packages ?? [])
      for (const declaration of pkg.nativeDeclarations ?? [])
        if (declaration.index && !names.has(declaration.index)) names.set(declaration.index, declaration.function);

  const gameRoot = gameDirectory(), files = [];
  for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const name of await readdir(`${gameRoot}/${dir}`))
      files.push({path: `${dir}/${name}`, read: () => readFile(`${gameRoot}/${dir}/${name}`)});
  const assets = new AssetStore(files), asset = await assets.get('00_Training');

  const records = [], probes = [], stack = [], seen = new WeakSet(), reached = new Map();
  let probe = 'startup', game, runtime, player, level, boots = 0;
  const classKey = object => { try { return runtime.instance(object).cls.record.key; } catch { return null; } };
  const actorLabel = actor => `${classKey(actor) ?? '?'}:${actor?.name ?? '?'}`;
  const recordError = error => {
    if (!error || typeof error !== 'object' || seen.has(error)) return;
    seen.add(error);
    records.push({kind: 'error', probe, message: String(error.message).split('\n')[0], stack: [...stack].slice(-8)});
  };

  // Instrument the prototype, not the instance, so createGame's own startup
  // passes run under the same stack/native tracking as the probes.
  const proto = ScriptRuntime.prototype;
  for (const method of ['callFunction', 'processEvent']) {
    const original = proto[method];
    proto[method] = function (first, second, ...rest) {
      runtime ??= this;
      stack.push(method === 'callFunction' ? first?.key ?? '?' : `${classKey(first) ?? '?'}.${String(second).toLowerCase()}`);
      try { return original.call(this, first, second, ...rest); }
      catch (error) { recordError(error); throw error; }
      finally { stack.pop(); }
    };
  }
  const invokeNative = proto.invokeNative;
  proto.invokeNative = function (call) {
    runtime ??= this;
    const name = call.record?.key ?? names.get(call.index) ?? null;
    const key = call.index || name || '?';
    const entry = reached.get(key) ?? {index: call.index, name, calls: 0, unsupported: 0, probes: new Set()};
    reached.set(key, entry);
    entry.calls++; entry.probes.add(probe);
    try { return invokeNative.call(this, call); }
    catch (error) {
      const match = UNSUPPORTED_NATIVE.exec(error?.message ?? '');
      if (!match || Number(match[1]) !== call.index) throw error;
      entry.unsupported++;
      const caller = String(call.script?.entry?.path ?? stack.at(-1) ?? '').toLowerCase();
      records.push({kind: 'native', probe, index: call.index, name, caller, stack: [...stack].slice(-8)});
      if (!continueMode) { seen.add(error); throw error; }
      let result = call.record?.function?.result;
      if (!result && name) try { result = this.lookup(call.receiver, name.split('.').at(-1))?.function?.result; } catch { /* no receiver */ }
      return result ? zeroValue(result) : undefined;
    }
  };

  // Every ULevel::SpawnActor request, by class and outcome.
  const spawns = new Map();
  const spawnActor = proto.spawnActor;
  proto.spawnActor = function (args) {
    const key = args?.cls?.linkedClass?.record?.key ?? '?';
    const entry = spawns.get(key) ?? {key, spawned: 0, rejected: 0, failed: 0, first: probe};
    spawns.set(key, entry);
    try {
      const actor = spawnActor.call(this, args);
      if (actor) entry.spawned++; else entry.rejected++;
      return actor;
    } catch (error) { entry.failed++; throw error; }
  };

  // Swallowed failures: Play's startup/tick loops catch into npcFailures and
  // skip the actor afterwards. `known` holds the entries already recorded.
  let known = new Map();
  const collectSwallowed = (label, {fresh = false} = {}) => {
    const failures = game.doors.scriptRuntime.npcFailures;
    if (fresh) known = new Map();
    let count = 0;
    for (const [actor, message] of failures) {
      if (known.get(actor) === message) continue;
      known.set(actor, message);
      count++;
      records.push({kind: 'swallowed', probe: label, actor: actorLabel(actor), message: String(message).split('\n')[0]});
    }
    return count;
  };

  const startup = {prepFailures: [], excluded: null};
  // A fresh game per dirty probe: a throw can leave a half-pushed screen or a
  // partial state that game.reset() does not undo, which would otherwise be
  // charged to every later probe.
  const boot = async () => {
    boots++;
    runtime = null;
    game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
    runtime = game.doors.scriptRuntime.runtime;
    player = game.player.collisionActor; level = runtime.levelFor(player);
    collectSwallowed(probe, {fresh: true});
    if (boots === 1) {
      for (const [key, message] of game.doors.scriptRuntime.scriptPreparationFailures)
        startup.prepFailures.push({key, message: String(message).split('\n')[0]});
      const excluded = game.doors.scriptRuntime.loadMapStartupExclusions?.();
      startup.excluded = excluded ? excluded.map(actorLabel) : null;
    }
  };
  await boot();

  const idle = {forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false};
  const paint = () => game.hud?.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
  const tick = frames => { for (let i = 0; i < frames; i++) { game.tick(1 / 60, idle); paint(); } };
  // The top modal (the keypad validator's walk): root +0x140 child list, +0x144
  // next sibling, +0x28 type byte >= 2. A screen a probe opened is closed the
  // way a player closes it, Escape through XRootWindow::Process, so window
  // teardown is probed too.
  const topModal = () => {
    const W = game.hud?.host?.W, rootWindow = runtime.namedReference(player, 'rootWindow').get();
    if (!W || !rootWindow) return null;
    let w = W.ptr(rootWindow, 0x140);
    while (w && W.u8(w, 0x28) < 2) w = W.ptr(w, 0x144);
    return w;
  };
  const actorNamed = name => level.actors.find(actor => actor?.name === name);
  const closeScreens = entry => {
    for (let attempt = 0, open; attempt < 3 && (open = topModal()); attempt++) {
      (entry.closed ??= []).push(classKey(open) ?? '?');
      game.windowKey('Escape', true); game.windowKey('Escape', false); tick(10);
    }
  };
  const run = async ({group, label, body, frames = 30}) => {
    const started = performance.now();
    probe = `${group}:${label}`;
    const entry = {group, label}, recordedFrom = records.length;
    try {
      body(entry); tick(frames);
      closeScreens(entry);
      if (topModal()) entry.stillOpen = classKey(topModal()) ?? '?';
    } catch (error) { recordError(error); entry.error = String(error.message).split('\n')[0]; }
    const swallowed = collectSwallowed(probe);
    if (swallowed) entry.swallowed = swallowed;
    // game.use() turns some failures into a message; the recorded throw still
    // leaves partial state (a half-lifted decoration), so it dirties the game.
    entry.error ??= records.slice(recordedFrom).find(record => record.kind === 'error')?.message;
    if (entry.error || entry.stillOpen) { probe = 'reboot'; await boot(); entry.rebooted = true; }
    else {
      probe = `reset:${group}:${label}`;
      try { game.reset(); collectSwallowed(probe, {fresh: true}); }
      catch (error) { recordError(error); entry.resetError = String(error.message).split('\n')[0]; probe = 'reboot'; await boot(); }
    }
    entry.ms = Math.round(performance.now() - started);
    probes.push(entry);
    log(`${probes.length} ${entry.group}:${entry.label} ${entry.ms}ms${entry.closed ? ` closed=${entry.closed.join(',')}` : ''}` +
      `${entry.stillOpen ? ` OPEN=${entry.stillOpen}` : ''}${entry.swallowed ? ` swallowed=${entry.swallowed}` : ''}` +
      `${entry.error ? ` ! ${entry.error.slice(0, 100)}` : ''}`);
  };

  // Probes are named descriptors resolved against the current game, so a
  // reboot re-targets the same map actor.
  const plan = [];
  if (groups.includes('idle')) plan.push({group: 'idle', label: 'startup+10s', body: () => {}, frames: 600});
  const actors = level.actors.filter(actor => actor && actor !== player);
  // Actor declares empty Frob/Bump/Touch events; only an overriding body is an
  // interaction. One actor per class unless `all` (instances share the body).
  const has = (actor, event) => {
    try { const record = runtime.lookup(actor, event); return Boolean(record?.function) && record.key !== `engine.actor.${event.toLowerCase()}`; }
    catch { return false; }
  };
  const perClass = list => {
    if (all) return list;
    const chosen = new Map();
    for (const actor of list) if (!chosen.has(classKey(actor))) chosen.set(classKey(actor), actor);
    return [...chosen.values()];
  };
  const lineage = actor => actor.lineage ?? [];
  if (groups.includes('frob'))
    for (const actor of perClass(actors.filter(actor => has(actor, 'Frob')))) {
      const name = actor.name;
      plan.push({group: 'frob', label: `${classKey(actor)}:${name}`, body: () => { game.interaction.frobTarget = actorNamed(name); game.use(); }});
    }
  if (groups.includes('bump'))
    for (const actor of perClass(actors.filter(actor => lineage(actor).includes('deusex.deusexdecoration') && has(actor, 'Bump')))) {
      const name = actor.name;
      plan.push({group: 'bump', label: `${classKey(actor)}:${name}`, body: () => game.doors.scriptRuntime.dispatchEvent(actorNamed(name), 'Bump', [player])});
    }
  if (groups.includes('touch'))
    for (const actor of perClass(actors.filter(actor => !lineage(actor).includes('engine.pawn') && has(actor, 'Touch')))) {
      const name = actor.name;
      plan.push({group: 'touch', label: `${classKey(actor)}:${name}`, body: () => game.doors.scriptRuntime.dispatchEvent(actorNamed(name), 'Touch', [player])});
    }
  if (groups.includes('exec')) {
    const ini = readFileSync(`${gameRoot}/System/User.ini`, 'utf8').replace(/\r/g, '');
    const section = ini.split('[Engine.Input]')[1].split(/\n\[/)[0], commands = new Set();
    const aliases = new Set();
    for (const line of section.split('\n')) {
      const alias = /^Aliases\[\d+\]=\(Command=".*",Alias=(\w+)\)$/.exec(line);
      if (alias) { aliases.add(alias[1].toLowerCase()); continue; }
      const match = /^([A-Za-z0-9]+)=(.+)$/.exec(line);
      if (match && match[1] !== 'Aliases') for (const command of match[2].split('|')) commands.add(command.trim());
    }
    // Movement axes/buttons are player input, not exec bodies; Fire is excluded
    // (latent weapon path outside the real scheduler); QuickLoad/Shot leave the level.
    const skip = /^(Axis|Button|Toggle |Fire|AltFire|Jump|Duck|Walking|Strafe|Look|Turn|Move|CenterView|QuickLoad|Shot)\b/i;
    // An [Engine.Input] alias (MoveForward, LookUp, ...) expands to input axes/buttons.
    for (const command of [...commands].filter(command => command && !skip.test(command) && !aliases.has(command.split(/\s+/)[0].toLowerCase()))) {
      const [name] = command.split(/\s+/);
      if (!has(player, name)) { probes.push({group: 'exec', label: command, error: `no player exec function ${name}`}); continue; }
      // The command line itself goes through the translated
      // UObject::ScriptConsoleExec, which parses its arguments.
      plan.push({group: 'exec', label: command, body: () => game.hud.scoped(() => {
        if (!runtime.scriptConsoleExec(player, command)) throw new Error(`ScriptConsoleExec did not consume ${command}`);
      })});
    }
  }
  const frob = name => { game.interaction.frobTarget = actorNamed(name); game.use(); };
  const exec = command => game.hud.scoped(() => {
    if (!runtime.scriptConsoleExec(player, command)) throw new Error(`ScriptConsoleExec did not consume ${command}`);
  });
  if (groups.includes('sequence')) {
    const cube = actors.find(actor => classKey(actor) === 'deusex.datacube');
    if (cube) {
      const name = cube.name;
      plan.push({group: 'sequence', label: `frob ${name} -> ShowGoalsWindow`, body: entry => {
        frob(name); tick(30); closeScreens(entry); exec('ShowGoalsWindow');
      }});
    }
  }
  // The Player-start reset leg: after the last probe's reset, the level ticks
  // again from its re-run startup.
  if (finalIdle && groups.includes('idle')) plan.push({group: 'idle', label: 'reset+10s', body: () => {}, frames: 600});
  const filter = only ? new RegExp(only, 'i') : null;
  for (const entry of plan) if (!filter || filter.test(`${entry.group}:${entry.label}`)) await run(entry);
  return {
    meta: {continue: continueMode, groups, boots},
    probes, records, startup, spawns: [...spawns.values()],
    reached: [...reached.values()].map(({probes: seenIn, ...entry}) => ({...entry, probes: seenIn.size, first: seenIn.values().next().value})),
  };
}
