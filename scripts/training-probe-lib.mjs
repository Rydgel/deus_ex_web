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
 * LoadMap startup passes that run inside createGame are observed too. Any
 * actor errors collected during startup/reset are recorded as `swallowed`;
 * the level tick rethrows a pending actor boundary before advancing another
 * frame, and the probe reports it instead of silently continuing past it.
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
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import {interactionDirection} from '../src/runtime/interaction.mjs';
import {actorRenderFeedback} from '../src/viewer/actor-render-feedback.mjs';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PROBE_GROUPS = Object.freeze(['idle', 'frob', 'bump', 'touch', 'exec', 'fire', 'sequence', 'route']);

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
  let probe = 'startup', game, runtime, player, level, fixture, boots = 0;
  let renderFeedbackTarget = null, renderFeedbackCallback = null, renderFeedbackNotifications = 0;
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

  // Criterion 4: every ULevel::DestroyActor request by class and outcome, the
  // ULevel::CleanupDestroyed passes and what they finalized, and every
  // DynamicLoadObject by route. Play's instance destroyActor wraps the
  // prototype method it binds at boot, so this sees Play's requests too.
  const destroys = new Map(), cleanups = {calls: 0, compacted: 0, finalized: 0, failed: 0}, loads = new Map();
  const destroyedInProbe = new Set(), hostRemovals = [];
  const destroyActor = proto.destroyActor;
  proto.destroyActor = function (receiver, netForce) {
    const key = classKey(receiver) ?? '?';
    const entry = destroys.get(key) ?? {key, accepted: 0, refused: 0, failed: 0, first: probe};
    destroys.set(key, entry);
    try {
      const accepted = destroyActor.call(this, receiver, netForce);
      if (accepted) { entry.accepted++; destroyedInProbe.add(receiver); } else entry.refused++;
      return accepted;
    } catch (error) { entry.failed++; entry.error ??= String(error.message).split('\n')[0]; throw error; }
  };
  const cleanupDestroyed = proto.cleanupDestroyed;
  proto.cleanupDestroyed = function (world, force) {
    const chain = () => { let n = 0; for (let a = world.pendingDeleted; a; a = this.readNamed(a, 'Deleted')) n++; return n; };
    const length = world.actors.length, pending = chain();
    cleanups.calls++;
    try {
      const result = cleanupDestroyed.call(this, world, force);
      cleanups.compacted += length - world.actors.length; cleanups.finalized += pending - chain();
      return result;
    } catch (error) { cleanups.failed++; cleanups.error ??= String(error.message).split('\n')[0]; throw error; }
  };
  const loadPrepared = proto.loadPreparedDynamicObject;
  proto.loadPreparedDynamicObject = function (request) {
    const packageName = String(request.name).split('.')[0].toLowerCase();
    const route = this.dynamicLoadGraph?.ownsPackage(packageName) ? 'prepared dynamic graph' : 'shared graph StaticLoadObject';
    const key = `${request.name} (${route})`;
    const entry = loads.get(key) ?? {key, calls: 0, failed: 0, loaded: null, first: probe};
    loads.set(key, entry); entry.calls++;
    try {
      const object = loadPrepared.call(this, request);
      entry.loaded ??= object === null ? 'None' : String(object?.kind ?? classKey(object) ?? typeof object);
      return object;
    } catch (error) { entry.failed++; entry.error ??= String(error.message).split('\n')[0]; throw error; }
  };

  // Criterion 5: every call that ends in a host callback rather than a
  // runtime body. `runtime.native` is assigned plainly (the constructor, then
  // scoped hosts that wrap the previous callback), so a prototype accessor
  // sees each layer; one call object is counted once. Scripted functions a
  // host replaces through boundaryFunctions are counted in callFunction.
  const hostNatives = new Map(), hostFunctions = new Map(), hostInputs = new Map(), hostCalls = new WeakSet();
  const HOST = Symbol('probe host native'), WRAPPED = Symbol('probe wrapped');
  const countHost = (map, key, fields) => {
    const entry = map.get(key) ?? {...fields, calls: 0, callers: new Map(), probes: new Set()};
    map.set(key, entry); entry.calls++; entry.probes.add(probe);
    const caller = stack.at(-1) ?? '?';
    entry.callers.set(caller, (entry.callers.get(caller) ?? 0) + 1);
  };
  Object.defineProperty(proto, 'native', {configurable: true,
    get() { return this[HOST]; },
    set(fn) {
      this[HOST] = typeof fn !== 'function' || fn[WRAPPED] ? fn : Object.assign(function (call) {
        if (call && typeof call === 'object' && !hostCalls.has(call)) {
          hostCalls.add(call);
          const name = call.record?.key ?? names.get(call.index) ?? null;
          countHost(hostNatives, `${call.index}|${name}`, {index: call.index, name});
        }
        return fn.call(this, call);
      }, {[WRAPPED]: true});
    }});
  const callFunction = proto.callFunction;
  proto.callFunction = function (record, ...rest) {
    if (record?.key && this.boundaryFunctions?.has(record.key)) countHost(hostFunctions, record.key, {key: record.key});
    // A flag the host writes itself (no script frame on the stack) is state
    // the original would carry in from elsewhere, e.g. PreTravel's
    // PlayerTraveling marker on fresh mission entry. The gate classifies each.
    if (!stack.length && /flagbase\.setbool$/.test(record?.key ?? '')) {
      const [, argumentCount, evaluate] = rest;
      const flag = argumentCount > 0 ? String(evaluate(0)) : '?';
      countHost(hostInputs, `flag ${flag}`, {key: `flag ${flag}`});
    }
    return callFunction.call(this, record, ...rest);
  };

  // Startup/LoadMap collectors retain the first actor failure for the next
  // level-tick boundary; `known` tracks failures already surfaced in reports.
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
  const paint = () => {
    if (renderFeedbackTarget && game.interaction.frobTarget === renderFeedbackTarget) {
      renderFeedbackCallback?.();
      renderFeedbackNotifications++;
    }
    return game.hud?.commands(1432, 1268, game.view());
  };
  // A fresh game per dirty probe: a throw can leave a half-pushed screen or a
  // partial state that game.reset() does not undo, which would otherwise be
  // charged to every later probe.
  const boot = async () => {
    boots++;
    runtime = null;
    game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
    runtime = game.doors.scriptRuntime.runtime;
    player = game.player.collisionActor; level = runtime.levelFor(player);
    renderFeedbackTarget = null; renderFeedbackCallback = null; renderFeedbackNotifications = 0;
    fixture = createPlayerInputFixture(game, {paint});
    collectSwallowed(probe, {fresh: true});
    if (boots === 1) {
      for (const [key, message] of game.doors.scriptRuntime.scriptPreparationFailures)
        startup.prepFailures.push({key, message: String(message).split('\n')[0]});
      const excluded = game.doors.scriptRuntime.loadMapStartupExclusions?.();
      startup.excluded = excluded ? excluded.map(actorLabel) : null;
    }
  };
  await boot();

  const tick = frames => fixture.tick(frames);
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
  // These map-authored targets need scoped starting sides to clear their
  // authored BSP geometry. Each offset is verified through the live
  // HighlightCenterObject TraceActors path; aim still must observe FrobTarget.
  const scopedFrobPose = actor => {
    const at = runtime.readNamed(actor, 'Location');
    if (actor?.name === 'DataCube0') {
      const side = 48 * Math.SQRT1_2;
      return {position: [at[0] - side, at[1] - side, at[2]]};
    }
    if (actor?.name === 'Plant11') {
      const side = 48 * Math.SQRT1_2;
      return {position: [at[0] + side, at[1] - side, at[2]]};
    }
    if (actor?.name === 'Multitool0') return {position: [at[0] - 40, at[1], at[2]]};
    if (actor?.name === 'Candybar0') return {position: [at[0], at[1] - 64, at[2]]};
    return undefined;
  };
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
    // Criterion 4: an actor that leaves Level.Actors during the probe without
    // an accepted DestroyActor was removed by a host path.
    const liveLevel = runtime.levelFor(game.player.collisionActor), before = new Set(liveLevel.actors.filter(Boolean));
    destroyedInProbe.clear();
    try {
      await body(entry); tick(frames);
      closeScreens(entry);
      if (topModal()) entry.stillOpen = classKey(topModal()) ?? '?';
    } catch (error) { recordError(error); entry.error = String(error.message).split('\n')[0]; }
    const remaining = new Set(runtime.levelFor(game.player.collisionActor).actors);
    for (const actor of before)
      if (!remaining.has(actor) && !destroyedInProbe.has(actor)) hostRemovals.push({probe, actor: actorLabel(actor)});
    const swallowed = collectSwallowed(probe);
    if (swallowed) entry.swallowed = swallowed;
    // A recorded throw leaves partial state (a half-lifted decoration), so it
    // dirties the game.
    entry.error ??= records.slice(recordedFrom).find(record => record.kind === 'error')?.message;
    if (entry.error || entry.stillOpen) { probe = 'reboot'; await boot(); entry.rebooted = true; }
    else {
      probe = `reset:${group}:${label}`;
      // Player start logs a new player in; later probes act on that one.
      try { game.reset(); player = game.player.collisionActor; collectSwallowed(probe, {fresh: true}); }
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
      plan.push({group: 'frob', label: `${classKey(actor)}:${name}`, body: async () => {
        const target = actorNamed(name); await fixture.frob(target, scopedFrobPose(target));
      }});
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
  const frob = name => { const target = actorNamed(name); return fixture.frob(target, scopedFrobPose(target)); };
  const exec = command => game.hud.scoped(() => {
    if (!runtime.scriptConsoleExec(player, command)) throw new Error(`ScriptConsoleExec did not consume ${command}`);
  });
  // Fire through Play's public binding (LeftMouse/Enter = ParseLeftClick|Fire,
  // Fire = Button bFire | Fire) under real ticks only: the latent NormalFire
  // body must suspend in the tick scheduler (the fire-path OOM note). Each
  // weapon or tool class placed in the map is walked to, frobbed into the
  // inventory, selected through the original PutInHand, fired twice (one tap,
  // one held press that Finish re-swings on) and AltFire'd. The installed
  // User.ini binds no AltFire key, so AltFire is the console exec a player
  // types. The empty-hand press is its own probe.
  if (groups.includes('fire')) {
    const fire = hold => { fixture.button('LeftMouse', true); tick(hold); fixture.button('LeftMouse', false); tick(90); };
    const altFire = () => exec('AltFire');
    plan.push({group: 'fire', label: 'empty hand', body: () => { fire(5); fire(60); altFire(); }});
    // Items lying in the map; the player's own key ring is already carried.
    const heldTools = actors.filter(actor => ['deusex.deusexweapon', 'deusex.skilledtool'].some(key => lineage(actor).includes(key)) &&
      !runtime.readNamed(actor, 'Owner'));
    for (const item of perClass(heldTools)) {
      const name = item.name;
      plan.push({group: 'fire', label: `${classKey(item)}:${name}`, body: async entry => {
        const target = actorNamed(name);
        if (!(await fixture.frob(target, scopedFrobPose(target))).ok) throw new Error(`fire probe could not pick up ${name}`);
        tick(10);
        // The digit key User.ini binds to ActivateBelt at the item's belt slot.
        const slot = runtime.readNamed(target, 'beltPos');
        await game.activateBelt(slot);
        tick(60);
        if (runtime.readNamed(player, 'inHand') !== target) throw new Error(`fire probe: ActivateBelt ${slot} did not select ${name}`);
        entry.inHand = classKey(runtime.readNamed(player, 'inHand'));
        fire(5); fire(60); altFire(); tick(60);
      }, frames: 60});
    }
  }
  if (groups.includes('sequence')) {
    const cube = actors.find(actor => classKey(actor) === 'deusex.datacube');
    if (cube) {
      const name = cube.name;
      plan.push({group: 'sequence', label: `frob ${name} -> ShowGoalsWindow`, body: async entry => {
        await frob(name); tick(30); closeScreens(entry); exec('ShowGoalsWindow');
      }});
    }
  }
  if (groups.includes('route')) plan.push({group: 'route', label: 'PlayerStart -> DL_part2', body: async entry => {
    const must = (condition, message) => { if (!condition) throw new Error(message); };
    const checkpoint = name => log(`route checkpoint: ${name} ${JSON.stringify(game.player.position.map(Math.round))}`);
    let routeTicks = 0;
    const levelInfo = game.collision.queries.levelInfo;
    const routeStartTime = runtime.readNamed(levelInfo, 'TimeSeconds');
    const flags = runtime.readNamed(player, 'FlagBase');
    const flag = name => Boolean(flags?.getBool(name));
    const location = actor => runtime.readNamed(actor, 'Location');
    // Capture the authored living pawn before the first route tick. Mission00
    // FirstFrame kills and retires this actor, then spawns its named Carcass.
    const cadet = actorNamed('UNATCOTroop2');
    must(cadet && runtime.readNamed(cadet, 'Tag') === 'Test_Subject' &&
      runtime.readNamed(cadet, 'Health') === 100,
      'route did not begin with the authored living Test_Subject pawn');
    entry.cadetStart = {name:cadet.name, tag:runtime.readNamed(cadet, 'Tag'),
      health:runtime.readNamed(cadet, 'Health')};
    const tickRoute = (frames = 1) => { routeTicks += frames; return fixture.tick(frames); };
    const tap = async (code, frames = 1) => { fixture.key(code, true); fixture.key(code, false); tickRoute(frames); };
    const use = () => game.use();
    const fire = async (frames = 1) => { fixture.button('LeftMouse', true); tickRoute(frames); fixture.button('LeftMouse', false); tickRoute(1); };
    const yawTo = point => Math.atan2(point[1] - game.player.position[1], point[0] - game.player.position[0]);
    const walkStraight = async (yaw, frames) => {
      fixture.driveLegacy({forward: 0}); fixture.steer(yaw); fixture.driveLegacy({forward: 1});
      tickRoute(frames); fixture.driveLegacy({forward: 0});
    };
    const walkToPoint = async (point, distance = 18, maxFrames = 1800) => {
      const settle = async () => {
        fixture.driveLegacy({forward: 0});
        let still = 0, previous = game.player.position.slice();
        for (let frame = 0; frame < 120 && still < 8; frame++) {
          tickRoute(1);
          const next = game.player.position;
          if (Math.hypot(next[0] - previous[0], next[1] - previous[1]) < .02) still++; else still = 0;
          previous = next.slice();
        }
      };
      fixture.driveLegacy({forward: 1});
      let stuck = 0, previous = game.player.position.slice();
      for (let frame = 0; frame < maxFrames; frame++) {
        const current = game.player.position;
        if (Math.hypot(point[0] - current[0], point[1] - current[1]) <= distance) {
          await settle();
          if (Math.hypot(point[0] - game.player.position[0], point[1] - game.player.position[1]) <= distance + 10) return;
          fixture.driveLegacy({forward: 1});
          stuck = 0; previous = game.player.position.slice();
          continue;
        }
        fixture.steer(yawTo(point)); tickRoute(1);
        const next = game.player.position;
        if (Math.hypot(next[0] - previous[0], next[1] - previous[1]) < .02) stuck++; else stuck = 0;
        previous = next.slice();
        if (stuck > 90) break;
      }
      fixture.driveLegacy({forward: 0});
      throw new Error(`could not reach authored waypoint ${JSON.stringify(point)} through collision; `+
        `player=${JSON.stringify(game.player.position)} stalled=${stuck}`);
    };
    const blocked = async (axis, yaw, maxFrames = 800) => {
      fixture.driveLegacy({forward: 0}); fixture.steer(yaw);
      let stuck = 0, frames = 0; fixture.driveLegacy({forward: 1});
      while (stuck < 18 && frames < maxFrames) {
        const before = game.player.position[axis]; tickRoute(1); frames++;
        if (Math.abs(game.player.position[axis] - before) < .05) stuck++; else stuck = 0;
      }
      fixture.driveLegacy({forward: 0});
      must(frames < maxFrames, `route stalled before its authored wall on axis ${axis}: ${JSON.stringify(game.player.position)}`);
      entry[`${axis === 0 ? 'x' : 'y'}Stop`] = game.player.position.map(Math.round);
      (entry.routeStops ??= []).push({axis, yaw, position: game.player.position.map(Math.round)});
    };
    const atTrace = async actor => {
      fixture.driveLegacy({forward: 0});
      // Braking can move the pawn after approach() reaches its radius. Re-aim
      // from the live pose on each original scheduler tick until the ordinary
      // trace selects the actor; never write target or trace state directly.
      for (let i = 0; i < 60; i++) {
        fixture.steerAt(actor); tickRoute(1);
        if (game.interaction.frobTarget === actor) break;
      }
      const eye = game.player.position.map(Math.fround);
      eye[2] = Math.fround(eye[2] + Math.fround(game.interaction.baseEyeHeight));
      const direction = interactionDirection(game.interaction.viewRotation);
      const end = eye.map((value, i) => Math.fround(value + Math.fround(direction[i] * game.interaction.maxFrobDistance)));
      const hits = game.collision.queries.multiLineCheck({
        start: eye, end, extent: [0, 0, 0], checkActors: 1,
        worldActor: game.collision.queries.levelInfo, extra: 0,
      }).slice(0, 8).map(hit => ({name: hit.actor?.name ?? 'None', location: hit.location, time: hit.time}));
      must(game.interaction.frobTarget === actor,
        `original trace missed ${actor?.name ?? 'missing actor'} at ${JSON.stringify(location(actor))}; ` +
        `player=${JSON.stringify(game.player.position)} view=${JSON.stringify(game.interaction.viewRotation)} `+
        `selected=${game.interaction.frobTarget?.name ?? 'None'} ray=${JSON.stringify({start:eye,end,hits})}`);
    };
    const frob = async actor => { await atTrace(actor); const result = use(); must(result.ok, `game.use rejected ${actor.name}`); };
    const approach = async (actor, {distance = 130, maxFrames = 900, trace = true} = {}) => {
      let stuck = 0, previous = game.player.position.slice();
      fixture.driveLegacy({forward: 1});
      for (let frame = 0; frame < maxFrames; frame++) {
        const target = location(actor), current = game.player.position;
        const horizontal = Math.hypot(target[0] - current[0], target[1] - current[1]);
        if (horizontal <= distance && Math.abs(target[2] - current[2]) < 180) {
          fixture.driveLegacy({forward: 0}); if (trace) await atTrace(actor); return;
        }
        fixture.steer(yawTo(target)); tickRoute(1);
        const next = game.player.position;
        if (Math.hypot(next[0] - previous[0], next[1] - previous[1]) < .02) stuck++; else stuck = 0;
        previous = next.slice();
        if (stuck > 90) break;
      }
      fixture.driveLegacy({forward: 0});
      throw new Error(`could not approach ${actor.name} through authored collision; player=${JSON.stringify(game.player.position)} `+
        `target=${JSON.stringify(location(actor))} stalled=${stuck}`);
    };
    const moveToActor = async (actor, distance = 130) => { await approach(actor, {distance}); };
    const visitActor = async (actor, distance = 130) => { await approach(actor, {distance, trace: false}); };
    const trigger = tag => level.actors.find(actor => actor?.lineage?.includes('deusex.datalinktrigger') &&
      String(runtime.readNamed(actor, 'dataLinkTag')).toLowerCase() === tag.toLowerCase());
    const waitPlayed = async (name, maxFrames = 3600) => {
      for (let frame = 0; frame < maxFrames && !flag(name); frame++) tickRoute(1);
      must(flag(name), `original DataLink ${name} did not complete within ${maxFrames} scheduler frames; `+
        `player=${JSON.stringify(game.player.position)}`);
    };
    const openMover = async actor => {
      await atTrace(actor);
      const mover = game.collision.movers.find(item => item.name === actor.name);
      const tag = String(mover?.values.Tag ?? '');
      const pair = game.collision.movers.filter(item => String(item.values.Tag ?? '') === tag);
      const before = mover?.interpolation.key;
      const used = use();
      must(used.ok, `${actor.name} original mover Frob was rejected`);
      let frames = 0;
      while (pair.length && (!pair.every(item => item.interpolation.key === 1 && !item.interpolation.interpolating)) && frames < 360) {
        tickRoute(1); frames++;
      }
      must(pair.length >= 2 && pair.every(item => item.interpolation.key === 1 && !item.interpolation.interpolating) && before !== 1,
        `${actor.name} pair did not finish opening through original mover Frob `+
        `(tag=${tag}, before=${before}, pair=${JSON.stringify(pair.map(item => ({name:item.name,key:item.interpolation.key,interpolating:item.interpolation.interpolating})))})`);
    };

    must(game.start?.name === 'PlayerStart1', 'route did not start at authored PlayerStart1');
    const startDoor = actorNamed('DeusExMover16');
    must(startDoor && !runtime.readNamed(startDoor, 'bLocked'), 'authored unlocked start door is missing/locked');
    await blocked(0, 0, 500);
    must(game.interaction.frobTarget === startDoor, `start route stopped without targeting ${startDoor?.name}`);
    const startMover = game.collision.movers.find(item => item.name === startDoor.name);
    const startKeyBefore = startMover?.interpolation.key, startUse = use();
    entry.startUse = startUse; entry.startKeyBefore = startKeyBefore;
    // The original Play probe establishes this as a completed two-panel
    // opening: KeyNum changes when interpolation starts, so it is not a
    // crossing-ready signal. Match the verified nanokey route's 150 ticks.
    for (let openingFrames = 0; openingFrames < 150; openingFrames++) tickRoute(1);
    const startKeyAfter = startMover?.interpolation.key; entry.startKeyAfter = startKeyAfter;
    const pairedStart = game.collision.movers.find(item => item.name === 'DeusExMover17');
    must(startKeyAfter === 1 && pairedStart?.interpolation.key === 1 &&
      !startMover?.interpolation.interpolating && !pairedStart?.interpolation.interpolating,
      `start door did not open from the real right-click path (key=${startKeyBefore}->${startKeyAfter}, `+
      `pairedKey=${pairedStart?.interpolation.key}, target=${game.interaction.frobTarget?.name}, `+
      `player=${JSON.stringify(game.player.position)})`);
    await blocked(0, 0);
    await waitPlayed('DL_Start_Played'); await waitPlayed('DL_door_Played'); checkpoint('start doors and DataLinks');
    await blocked(1, Math.PI / 2);
    await blocked(0, Math.PI);
    const trainKey = actorNamed('NanoKey0');
    // The authored opening route's native trace reaches NanoKey0 from its
    // west waypoint; do not steer into the intervening wall.
    await frob(trainKey);
    must(runtime.readNamed(runtime.readNamed(player, 'KeyList'), 'KeyID') === 'Train', 'Train NanoKey did not enter KeyList');
    must(!level.actors.includes(trainKey), 'Train NanoKey world actor survived original pickup');
    await waitPlayed('DL_key_Played');
    await blocked(0, 0);
    fixture.steer(-Math.PI / 2); fixture.driveLegacy({forward: 1});
    let southFrames = 0;
    while (game.player.position[1] > 840 && southFrames < 800) { tickRoute(1); southFrames++; }
    fixture.driveLegacy({forward: 0});
    must(southFrames < 800, `route did not reach the authored south waypoint: ${JSON.stringify(game.player.position)}`);
    fixture.steer(-2.4); fixture.driveLegacy({forward: 1}); tickRoute(70); fixture.driveLegacy({forward: 0});
    const trainerDoor = actorNamed('DeusExMover47'), trainerPair = actorNamed('DeusExMover48');
    await atTrace(trainerDoor);
    await tap('Digit0', 10);
    await fire(1);
    must(!runtime.readNamed(trainerDoor, 'bLocked') && !runtime.readNamed(trainerPair, 'bLocked'),
      'the selected NanoKeyRing did not unlock the authored trainer-door pair');
    entry.trainerBefore = game.player.position.map(Math.round);
    await openMover(trainerDoor);
    entry.trainerOpen = game.player.position.map(Math.round);
    await walkStraight(0, 140);
    entry.trainerCrossing = game.player.position.map(Math.round);
    const f1f2Trigger = trigger('dl_f1f2');
    must(f1f2Trigger, 'authored DL_F1F2 trigger is missing');
    await visitActor(f1f2Trigger, 120);
    await waitPlayed('DL_F1F2_Played');

    const crateTrigger = trigger('dl_crate');
    must(crateTrigger, 'authored DL_crate trigger is missing');
    await visitActor(crateTrigger, 120);
    await waitPlayed('DL_crate_Played');
    const crowbar = actorNamed('WeaponCrowbar1'); await moveToActor(crowbar, 50); await frob(crowbar);
    await game.activateBelt(runtime.readNamed(crowbar, 'beltPos')); tickRoute(80);
    must(runtime.readNamed(player, 'inHand') === crowbar, 'crowbar did not enter hand through original belt path');
    const crate = actorNamed('CrateBreakableMedGeneral1');
    must(crate, 'authored Cratepick2 crate is missing');
    await moveToActor(crate, 60);
    const hp = runtime.readNamed(crate, 'HitPoints');
    await fire(5); tickRoute(70); await fire(5); tickRoute(70);
    must(runtime.instance(crate).pendingKill, 'two crowbar notifies did not destroy the authored lower crate');
    must(runtime.readNamed(crate, 'HitPoints') < hp, 'crate damage did not come from its original Fire notify'); checkpoint('crate destroyed and contents spawned');
    const lockpick = level.actors.find(actor => actor && runtime.instance(actor).cls.record.key === 'deusex.lockpick' && actor.scriptView);
    must(lockpick, 'destroying either named Mission00 crate did not create original Lockpick contents');
    await moveToActor(lockpick, 70); await frob(lockpick);
    must(runtime.readNamed(lockpick, 'Owner') === player, 'revealed lockpick did not enter inventory');
    await waitPlayed('DL_Lockpick_Played');
    must(flag('DL_Lockpick_Played'), 'Mission00 did not play its original DL_Lockpick after one crate destruction');
    const lockstrTrigger = trigger('dl_lockstr'); must(lockstrTrigger, 'DL_lockstr trigger is missing');
    await visitActor(lockstrTrigger, 40); await waitPlayed('DL_lockstr_Played');

    const gunDoor = actorNamed('DeusExMover45'); must(gunDoor, 'authored FrontDoor gundoor pair is missing');
    await moveToActor(gunDoor, 80); await atTrace(gunDoor);
    await game.activateBelt(runtime.readNamed(lockpick, 'beltPos')); tickRoute(80);
    must(runtime.readNamed(player, 'inHand') === lockpick, 'Lockpick did not enter hand through original belt path');
    await atTrace(gunDoor); await fire(1);
    const gunPair = game.collision.movers.filter(mover => String(mover.values.Tag).toLowerCase() === 'gundoor');
    const moverActor = mover => actorNamed(mover.name);
    const moverField = (mover, name) => runtime.readNamed(moverActor(mover), name);
    const pickSnapshot = () => gunPair.map(mover => ({name:mover.name,
      locked:moverField(mover, 'bLocked'), picking:moverField(mover, 'bPicking'),
      lockStrength:moverField(mover, 'lockStrength'), pickValue:moverField(mover, 'pickValue'),
      picks:moverField(mover, 'numPicks'), ticksPerPick:moverField(mover, 'TicksPerPick')}));
    must(runtime.readNamed(gunDoor, 'bPicking'),
      `original Lockpick input did not enter bPicking: ${JSON.stringify(pickSnapshot())}`);
    let pickFrames = 0;
    while (gunPair.some(mover => moverField(mover, 'bLocked')) && pickFrames < 1200) { tickRoute(1); pickFrames++; }
    must(gunPair.length === 2 && gunPair.every(mover => !moverField(mover, 'bLocked')) &&
      gunPair.every(mover => !moverField(mover, 'bPicking')),
      `original Lockpick did not unlock both gundoor panels (frames=${pickFrames}, `+
      `state=${JSON.stringify(pickSnapshot())})`);
    await tap('Backspace', 10); await openMover(gunDoor);
    // The original mover brush spans X=1316..1324 and its safe opening
    // centerline is Y=144. Approach and cross with public forward/look input.
    await walkToPoint([1280, 144], 12);
    await walkToPoint([1360, 144], 12);
    // The direct north segment east of the gundoor is BSP-blocked at player
    // height. These fixture points skirt that BSP wall; they are geometric
    // waypoints, not an authored NavigationPoint route.
    await walkToPoint([1360, 200], 12); checkpoint('east gundoor skirt');
    await walkToPoint([1760, 200], 12); checkpoint('keypad corridor east turn');
    await walkToPoint([1760, 850], 12); checkpoint('keypad corridor north leg');

    const cube = actorNamed('DataCube0'); await moveToActor(cube, 70); checkpoint('DataCube approach'); await frob(cube);
    const rootWindow = runtime.readNamed(player, 'rootWindow'), hud = runtime.readNamed(rootWindow, 'hud');
    must(runtime.readNamed(cube, 'infoWindow') === runtime.readNamed(hud, 'info'),
      'DataCube did not open its original information window');
    await walkToPoint([1940, 848], 12); checkpoint('paddoor west centerline');
    const keypad = actorNamed('Keypad0'); await moveToActor(keypad, 80); await frob(keypad); tickRoute(10);
    const modal = topModal(); must(modal && classKey(modal) === 'deusex.hudkeypadwindow', 'Keypad0 did not open HUDKeypadWindow');
    for (const digit of '0012') { await tap(`Digit${digit}`, 12); }
    const keypadWindow = () => topModal() && classKey(topModal()) === 'deusex.hudkeypadwindow';
    for (let delayFrames = 0; keypadWindow() && delayFrames < 120; delayFrames++) tickRoute(1);
    must(!keypadWindow(), 'successful Keypad0 code did not close its one-second HUDKeypadWindow delay');
    const padPair = game.collision.movers.filter(mover => String(mover.values.Tag).toLowerCase() === 'paddoor');
    let padFrames = 0;
    while (padPair.some(mover => mover.interpolation.key !== 1 || mover.interpolation.interpolating) && padFrames < 360) {
      tickRoute(1); padFrames++;
    }
    must(padPair.length === 2 && padPair.every(mover => mover.interpolation.key === 1 && !mover.interpolation.interpolating),
      `original keypad code did not finish opening both paddoor panels: ${JSON.stringify(padPair.map(mover =>
        ({name:mover.name,key:mover.interpolation.key,interpolating:mover.interpolation.interpolating})))}`);
    await walkToPoint([1980, 848], 12);
    await walkToPoint([2040, 848], 12);
    checkpoint('keypad and paddoor');
    const keypadTrigger = trigger('dl_keypad'); must(keypadTrigger, 'DL_keypad trigger is missing');
    await waitPlayed('DL_keypad_Played');
    checkpoint('DL_keypad played');
    const multitool = actorNamed('Multitool1'); must(multitool, 'authored multitool pickup is missing');
    await moveToActor(multitool, 70); await frob(multitool);
    checkpoint('Multitool1 picked up');
    await game.activateBelt(runtime.readNamed(multitool, 'beltPos')); tickRoute(80);
    must(runtime.readNamed(player, 'inHand') === multitool, 'multitool did not enter hand through original belt path');
    const multitoolTrigger = trigger('dl_multitool'); must(multitoolTrigger, 'DL_multitool trigger is missing');
    await visitActor(multitoolTrigger, 80); await waitPlayed('DL_multitool_Played');
    checkpoint('DL_multitool played');
    const hackKeypad = actorNamed('Keypad2'); must(hackKeypad, 'authored hackdoor keypad is missing');
    await walkToPoint([2500, 848], 12); checkpoint('hackdoor keypad centerline');
    await moveToActor(hackKeypad, 80); await atTrace(hackKeypad);
    renderFeedbackTarget = hackKeypad;
    renderFeedbackCallback = actorRenderFeedback(runtime, hackKeypad);
    renderFeedbackNotifications = 0;
    await fire(1);
    let hackTimerDispatches = 0;
    const originalProcessEvent = runtime.processEvent;
    runtime.processEvent = function (receiver, event, ...args) {
      const eventName = typeof event === 'string' ? event : event?.key ?? event?.name;
      if (receiver === hackKeypad && String(eventName).toLowerCase() === 'timer') hackTimerDispatches++;
      return originalProcessEvent.call(this, receiver, event, ...args);
    };
    const readHack = name => { try { return runtime.readNamed(hackKeypad, name); } catch { return null; } };
    const hackSnapshot = () => {
      const refName = name => { const value = readHack(name); return value?.name ?? (value == null ? value : '[object]'); };
      let zoneLastRenderTime = null;
      try { zoneLastRenderTime = level.zoneLastRenderTime(hackKeypad); } catch {}
      return {timeSeconds:runtime.readNamed(levelInfo, 'TimeSeconds'), zoneLastRenderTime,
        bHacking:readHack('bHacking'), hackStrength:readHack('hackStrength'), LastTickTime:readHack('LastTickTime'),
        TicksSinceLastHack:readHack('TicksSinceLastHack'), TicksPerHack:readHack('TicksPerHack'),
        numHacks:readHack('numHacks'), hackTime:readHack('hackTime'), hackValue:readHack('hackValue'),
        TimerRate:readHack('TimerRate'), TimerCounter:readHack('TimerCounter'), bTimerLoop:readHack('bTimerLoop'),
        Flags:readHack('Flags'), Role:readHack('Role'), RemoteRole:readHack('RemoteRole'), Physics:readHack('Physics'),
        bStasis:readHack('bStasis'), bForceStasis:readHack('bForceStasis'), LastRenderTime:readHack('LastRenderTime'),
        DistanceFromPlayer:readHack('DistanceFromPlayer'), curTool:refName('curTool'), hackPlayer:refName('hackPlayer'),
        playerFrobTarget:game.interaction.frobTarget?.name ?? null,
        playerInHand:runtime.readNamed(player, 'inHand')?.name ?? null,
        timerDispatches:hackTimerDispatches, observedDrawNotifications:renderFeedbackNotifications};
    };
    const hackStartState = hackSnapshot();
    const hackdoorPanels = game.collision.movers.filter(mover => String(mover.values.Tag).toLowerCase() === 'hackdoor');
    let hackFrames = 0;
    while (runtime.readNamed(hackKeypad, 'bHacking') && hackFrames < 3600) { tickRoute(1); hackFrames++; }
    must(!runtime.readNamed(hackKeypad, 'bHacking') && runtime.readNamed(hackKeypad, 'hackStrength') === 0,
      `original Multitool timer did not complete Keypad2 hack: frames=${hackFrames}, `+
      `start=${JSON.stringify(hackStartState)}, end=${JSON.stringify(hackSnapshot())}`);
    runtime.processEvent = originalProcessEvent;
    renderFeedbackTarget = null; renderFeedbackCallback = null;
    entry.actorRenderFeedback = {actor:'Keypad2',
      notifications:renderFeedbackNotifications, onlyWhileOriginalFrobTargetMatches:true,
      source:'actorRenderFeedback from browser mesh onAfterRender'};
    checkpoint('Keypad2 hack completed');
    let hackWindowFrames = 0;
    while (keypadWindow() && hackWindowFrames < 120) { tickRoute(1); hackWindowFrames++; }
    must(!keypadWindow(), 'instant-success Keypad2 modal did not close through its one-second timer');
    let hackDoorFrames = 0;
    while (hackdoorPanels.some(mover => mover.interpolation.key !== 1 || mover.interpolation.interpolating) && hackDoorFrames < 360) {
      tickRoute(1); hackDoorFrames++;
    }
    must(hackdoorPanels.length === 2 && hackdoorPanels.every(mover => mover.interpolation.key === 1 && !mover.interpolation.interpolating),
      `original Multitool Fire did not finish opening both hackdoor panels: ${JSON.stringify(hackdoorPanels.map(mover =>
        ({name:mover.name,key:mover.interpolation.key,interpolating:mover.interpolation.interpolating})))}`);
    await walkToPoint([2540, 848], 12);
    await walkToPoint([2600, 848], 12);
    checkpoint('multitool and hackdoor');

    const bodyEntry = actorNamed('DeusExMover2'); must(bodyEntry, 'authored Body_Room_Entry mover is missing');
    await walkToPoint([3400, 848], 12);
    await moveToActor(bodyEntry, 80); await openMover(bodyEntry);
    await walkToPoint([3460, 848], 12); checkpoint('Body_Room_Entry');
    const bodies = level.actors.filter(actor => actor?.lineage?.includes('deusex.deusexcarcass') &&
      runtime.readNamed(actor, 'CarcassName') === cadet.name);
    const body = bodies[0];
    must(!level.actors.includes(cadet) && bodies.length === 1 && body &&
      runtime.readNamed(body, 'bNotDead'),
      `Mission00 did not retire Test_Subject and make exactly one authored unconscious body: `+
      `pawnLive=${level.actors.includes(cadet)} bodies=${JSON.stringify(bodies.map(actor =>
        ({name:actor.name,notDead:runtime.readNamed(actor, 'bNotDead')})))}`);
    entry.cadetAfterFirstFrame = {pawnRetired:!level.actors.includes(cadet), body:body.name,
      bNotDead:runtime.readNamed(body, 'bNotDead')};
    const bodyTrigger = trigger('dl_body'); await visitActor(bodyTrigger, 120); await waitPlayed('DL_body_Played');
    await moveToActor(body, 80); await frob(body);
    must(runtime.readNamed(runtime.readNamed(player, 'KeyList'), 'KeyID') === 'Body_Search_Room',
      'searching the cadet did not transfer his authored medical-room key');
    const medicalDoor = actorNamed('DeusExMover50'); await moveToActor(medicalDoor, 80); await atTrace(medicalDoor);
    await tap('Digit0', 10); await fire(1);
    must(!runtime.readNamed(medicalDoor, 'bLocked'), 'medical-room key did not unlock its authored door');
    use();
    let medicalOpenFrames = 0;
    const medicalMover = game.collision.movers.find(mover => mover.name === medicalDoor.name);
    while (medicalMover && (medicalMover.interpolation.key !== 1 || medicalMover.interpolation.interpolating) && medicalOpenFrames < 360) { tickRoute(1); medicalOpenFrames++; }
    must(medicalMover?.interpolation.key === 1 && !medicalMover.interpolation.interpolating,
      'medical-room door did not finish opening through its original mover path');
    await tap('Backspace', 10);
    // Backspace is the installed PutInHand binding. NanoKeyRing is a
    // SkilledTool, so PutInHand(None) only takes effect after the original
    // Down animation returns to Idle2 and UpdateInHand consumes its pending
    // item. Keep the input edge real and wait on that lifecycle, bounded.
    let putAwayFrames = 0;
    while ((runtime.readNamed(player, 'inHand') || runtime.readNamed(player, 'inHandPending')) && putAwayFrames < 300) {
      tickRoute(1); putAwayFrames++;
    }
    const remainingHandItem = runtime.readNamed(player, 'inHand');
    const pendingHandItem = runtime.readNamed(player, 'inHandPending');
    must(!remainingHandItem && !pendingHandItem, `cadet carry began while a tool remained in hand: `+
      `item=${remainingHandItem?.name ?? 'None'} class=${classKey(remainingHandItem)} `+
      `pending=${pendingHandItem?.name ?? 'None'} putAwayFrames=${putAwayFrames} `+
      `carriedDecoration=${runtime.readNamed(player, 'CarriedDecoration')?.name ?? 'None'} `+
      `keyRing=${runtime.readNamed(player, 'KeyRing')?.name ?? 'None'} `+
      `handIsKeyRing=${remainingHandItem === runtime.readNamed(player, 'KeyRing')}`);
    must(!runtime.readNamed(body, 'Inventory'), 'cadet carry began before the body-held room key was removed');
    await moveToActor(body, 80); await frob(body); tickRoute(30);
    must(runtime.readNamed(player, 'inHand')?.lineage?.includes('deusex.povcorpse'), 'right click did not carry the original body');
    const table = actorNamed('Trigger0'); must(table, 'authored medical table trigger is missing');
    const tablePosition = location(table);
    await walkToPoint([3688, 640], 12);
    await walkToPoint([tablePosition[0], tablePosition[1] + 100], 18);
    fixture.steer(-Math.PI / 2, 0);
    await tap('Tab', 200);
    const exitDoors = level.actors.filter(actor => actor?.lineage?.includes('deusex.deusexmover') &&
      runtime.readNamed(actor, 'Tag') === 'bodydoorsopen');
    await waitPlayed('DL_bodyexit_Played');
    let exitFrames = 0;
    const exitMovers = game.collision.movers.filter(mover => String(mover.values.Tag).toLowerCase() === 'bodydoorsopen');
    while (exitMovers.some(mover => mover.interpolation.key !== 1 || mover.interpolation.interpolating) && exitFrames < 360) {
      tickRoute(1); exitFrames++;
    }
    must(exitDoors.length === 2 && exitMovers.length === 2 && exitMovers.every(mover =>
      mover.interpolation.key === 1 && !mover.interpolation.interpolating),
      'dropped unconscious body did not touch the authored table and finish opening both exits');
    checkpoint('cadet medical table and exits');
    await walkToPoint([3688, 620], 12);
    await walkToPoint([3688, 848], 12);
    await walkToPoint([3900, 848], 12);
    await walkToPoint([3980, 848], 12);

    const darkDoor = actorNamed('DeusExMover19'); must(darkDoor, 'authored darkdoor panel is missing');
    await walkToPoint([4300, 848], 12);
    await moveToActor(darkDoor, 80); await openMover(darkDoor);
    const darkTrigger = trigger('dl_dark'); must(darkTrigger, 'DL_dark trigger is missing');
    await waitPlayed('DL_dark_Played');
    await walkToPoint([4360, 848], 12);
    must(game.collision.movers.find(mover => mover.name === darkDoor.name)?.interpolation.key === 1,
      'dark-door pair did not open through its original tag fanout');
    const darkDoor2 = actorNamed('DeusExMover29'); must(darkDoor2, 'authored darkdoor2 mover is missing');
    // The dark room between the two door pairs is a walled maze; a straight
    // leg to darkdoor2 meets the BSP wall at X=4735.5. These route points come
    // from a compiled-BSP grid search at a 24-unit extent, each leg confirmed
    // clear by the swept world query (docs/script-training-route.md).
    for (const point of [[4376, 788], [4520, 788], [4568, 828], [4696, 828], [4824, 732], [4848, 564]])
      await walkToPoint(point, 12);
    await walkToPoint([4860, 544], 12);
    await moveToActor(darkDoor2, 80); await openMover(darkDoor2);
    await walkToPoint([4920, 544], 12);
    const repairTrigger = trigger('dl_repairbot'), part2Trigger = trigger('dl_part2');
    await visitActor(repairTrigger, 120); await waitPlayed('DL_repairbot_Played');
    await visitActor(part2Trigger, 120); await waitPlayed('DL_part2_Played'); checkpoint('DL_part2');
    entry.endPosition = game.player.position.map(Math.round);
    const routeEndTime = runtime.readNamed(levelInfo, 'TimeSeconds');
    entry.routeTiming = {levelStartSeconds:routeStartTime, levelEndSeconds:routeEndTime,
      elapsedGameSeconds:Number((routeEndTime - routeStartTime).toFixed(3)),
      explicitRouteTickFrames:routeTicks,
      lockpickFrames:pickFrames, hackFrames};
    entry.route = ['DL_Start','DL_door','DL_key','DL_F1F2','DL_crate','DL_Lockpick','DL_lockstr','gundoor','DL_keypad',
      'paddoor','DL_multitool','hackdoor','Body_Room_Entry','DL_body','DL_bodyexit','DL_dark','darkdoor','darkdoor2','DL_repairbot','DL_part2'];
    must(runtime.levelFor(player).actors.includes(part2Trigger), 'route exited its original level before DL_part2');
  }, frames: 1});
  // The Player-start reset leg: after the last probe's reset, the level ticks
  // again from its re-run startup.
  if (finalIdle && groups.includes('idle')) plan.push({group: 'idle', label: 'reset+10s', body: () => {}, frames: 600});
  const filter = only ? new RegExp(only, 'i') : null;
  for (const entry of plan) if (!filter || filter.test(`${entry.group}:${entry.label}`)) await run(entry);
  return {
    meta: {continue: continueMode, groups, boots},
    probes, records, startup, spawns: [...spawns.values()],
    reached: [...reached.values()].map(({probes: seenIn, ...entry}) => ({...entry, probes: seenIn.size, first: seenIn.values().next().value})),
    lifecycle: {destroys: [...destroys.values()], cleanups, loads: [...loads.values()], hostRemovals},
    host: Object.fromEntries([['natives', hostNatives], ['functions', hostFunctions], ['inputs', hostInputs]].map(([kind, map]) => [kind,
      [...map.values()].map(({callers, probes: seenIn, ...entry}) => ({...entry, probes: seenIn.size, first: seenIn.values().next().value,
        callers: [...callers].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([caller, n]) => `${caller} x${n}`)}))])),
  };
}
