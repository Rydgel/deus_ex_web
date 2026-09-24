/** Report-only Training reach census (docs/stage-3-exit-criteria.md, "First step").
 *
 * Boots 00_Training, runs startup and idle level ticks, then drives each
 * interaction family through its public Play entry: every actor with a Frob
 * body through game.use() (ParseRightClick), every decoration Bump, every
 * non-pawn Touch, and each exec command bound in the installed User.ini
 * [Engine.Input]. Every probe is followed by painted level ticks, as Play runs
 * them, and a game.reset(). It prints the boundaries the probes reach, grouped
 * so a whole family can be recovered and verified together.
 *
 * --continue returns the declared zero value from an unsupported native (the
 * Play host's final "Unsupported original door native N" fallthrough) and
 * records it, so one probe lists every native its path reaches rather than only
 * the first. Values after such a return are not original behavior: this is
 * planning data for choosing families, never evidence for a translation.
 *
 *   node scripts/census-training-reach.mjs [--continue] [--all] [--groups idle,frob,bump,touch,exec] [--only regex]
 *        [--json .cache/training-reach-census.json] [--mem-cap MiB]
 *
 * The census runs in a child process whose RSS the parent samples, and kills it
 * past the cap (docs: OOM fire-path note). Fire/AltFire are not probed. */
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i === -1 ? fallback : argv[i + 1]; };
const continueMode = argv.includes('--continue');
const groups = String(flag('--groups', 'idle,frob,bump,touch,exec')).split(',').filter(Boolean);

if (!argv.includes('--child')) await parent();
else await child();

async function parent() {
  const out = path.resolve(root, flag('--json', '.cache/training-reach-census.json'));
  const capMiB = Number(flag('--mem-cap', 8192));
  mkdirSync(path.dirname(out), {recursive: true});
  const partial = `${out}.partial`;
  const args = ['--max-old-space-size=6144', fileURLToPath(import.meta.url), '--child', '--out', partial,
    '--groups', groups.join(','), ...(continueMode ? ['--continue'] : []), ...(argv.includes('--all') ? ['--all'] : []),
    ...(flag('--only') ? ['--only', flag('--only')] : [])];
  const started = Date.now();
  const proc = spawn(process.execPath, args, {stdio: ['ignore', 'inherit', 'inherit']});
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
  if (killed) { console.error(`census child killed at ${capMiB} MiB RSS`); process.exit(2); }
  if (code !== 0 || !existsSync(partial)) { console.error(`census child exited ${code}`); process.exit(1); }
  const census = JSON.parse(readFileSync(partial, 'utf8'));
  census.meta = {...census.meta, seconds: Math.round((Date.now() - started) / 1000), peakMiB: Math.round(peak)};
  writeFileSync(out, JSON.stringify(census, null, 1) + '\n');
  report(census, out);
}

function report(census, out) {
  const {records, probes, meta} = census;
  const natives = new Map(), errors = new Map();
  for (const record of records) {
    const bucket = record.kind === 'native' ? natives : errors;
    const key = record.kind === 'native' ? record.index : record.message;
    const entry = bucket.get(key) ?? {record, first: record.probe, probes: new Set(), callers: new Set(), hits: 0};
    entry.hits++; entry.probes.add(record.probe); if (record.caller) entry.callers.add(record.caller);
    bucket.set(key, entry);
  }
  // game.use() turns a non-pawn Frob boundary into a message, so a probe also
  // counts as ending on a boundary when it recorded a terminal error.
  const errored = new Set(records.filter(record => record.kind === 'error' && record.probe !== 'reboot').map(record => record.probe));
  const failed = probes.filter(probe => probe.error || errored.has(`${probe.group}:${probe.label}`));
  console.log(`Training reach census${meta.continue ? ' (--continue)' : ''}: ${probes.length} probes, ` +
    `${failed.length} ended on a boundary, ${meta.boots} boots, ${meta.seconds}s, peak ${meta.peakMiB} MiB`);
  console.log(`\nUnsupported natives reached: ${natives.size}` + (meta.continue ? '' : ' (first per path; use --continue for all)'));
  const byOwner = new Map();
  for (const [index, entry] of natives) {
    const owner = entry.record.name?.split('.').slice(0, 2).join('.') ?? '?';
    (byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)).push([index, entry]);
  }
  for (const [owner, list] of [...byOwner].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${owner} (${list.length})`);
    for (const [index, entry] of list.sort((a, b) => b[1].probes.size - a[1].probes.size))
      console.log(`    ${String(index).padStart(5)} ${entry.record.name ?? '?'}  probes=${entry.probes.size} hits=${entry.hits}` +
        `  first ${entry.first}  from ${[...entry.callers].slice(0, 3).join(', ')}${entry.callers.size > 3 ? ', …' : ''}`);
  }
  console.log(`\nOther boundaries: ${errors.size}`);
  for (const [message, entry] of [...errors].sort((a, b) => b[1].probes.size - a[1].probes.size))
    console.log(`  probes=${String(entry.probes.size).padStart(3)}  ${message.slice(0, 180)}\n      first ${entry.first} at ${entry.record.stack?.slice(-3).join(' < ') ?? '?'}`);
  const open = probes.filter(probe => probe.stillOpen);
  if (open.length) console.log(`\nScreens Escape did not close: ${open.map(probe => `${probe.label} (${probe.stillOpen})`).join(', ')}`);
  console.log(`\nWrote ${path.relative(root, out)}`);
}

async function child() {
  const out = flag('--out');
  const {AssetStore} = await import('../src/unreal/assets.mjs');
  const {decodeMap} = await import('../src/unreal/map.mjs');
  const {createGame} = await import('../src/viewer/game.mjs');
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

  const records = [], probes = [], stack = [], seen = new WeakSet();
  let probe = 'startup', game, runtime, player, level, boots = 0;
  const classKey = object => { try { return runtime.instance(object).cls.record.key; } catch { return null; } };
  const recordError = error => {
    if (!error || typeof error !== 'object' || seen.has(error)) return;
    seen.add(error);
    records.push({kind: 'error', probe, message: String(error.message).split('\n')[0], stack: [...stack].slice(-8)});
  };
  // A fresh game per dirty probe: a throw can leave a half-pushed screen or a
  // partial state that game.reset() does not undo, which would otherwise be
  // charged to every later probe.
  const boot = async () => {
    boots++;
    game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
    runtime = game.doors.scriptRuntime.runtime;
    player = game.player.collisionActor; level = runtime.levelFor(player);
    for (const method of ['callFunction', 'processEvent']) {
      const original = runtime[method].bind(runtime);
      runtime[method] = (first, second, ...rest) => {
        stack.push(method === 'callFunction' ? first?.key ?? '?' : `${classKey(first) ?? '?'}.${String(second).toLowerCase()}`);
        try { return original(first, second, ...rest); }
        catch (error) { recordError(error); throw error; }
        finally { stack.pop(); }
      };
    }
    const invokeNative = runtime.invokeNative.bind(runtime);
    runtime.invokeNative = call => {
      try { return invokeNative(call); }
      catch (error) {
        const match = /^(?:Unsupported original door native|Unimplemented original native|VM does not support native) (\d+)/.exec(error?.message ?? '');
        if (!match || Number(match[1]) !== call.index) throw error;
        const name = call.record?.key ?? names.get(call.index) ?? null;
        const caller = String(call.script?.entry?.path ?? stack.at(-1) ?? '').toLowerCase();
        records.push({kind: 'native', probe, index: call.index, name, caller, stack: [...stack].slice(-8)});
        if (!continueMode) { seen.add(error); throw error; }
        let result = call.record?.function?.result;
        if (!result && name) try { result = runtime.lookup(call.receiver, name.split('.').at(-1))?.function?.result; } catch { /* no receiver */ }
        return result ? zeroValue(result) : undefined;
      }
    };
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
  const run = async ({group, label, body, frames = 30}) => {
    const started = performance.now();
    probe = `${group}:${label}`;
    const entry = {group, label};
    try {
      body(); tick(frames);
      for (let attempt = 0, open; attempt < 3 && (open = topModal()); attempt++) {
        (entry.closed ??= []).push(classKey(open) ?? '?');
        game.windowKey('Escape', true); game.windowKey('Escape', false); tick(10);
      }
      if (topModal()) entry.stillOpen = classKey(topModal()) ?? '?';
    } catch (error) { recordError(error); entry.error = String(error.message).split('\n')[0]; }
    if (entry.error || entry.stillOpen) { probe = 'reboot'; await boot(); entry.rebooted = true; }
    else try { game.reset(); } catch (error) { recordError(error); entry.resetError = String(error.message).split('\n')[0]; probe = 'reboot'; await boot(); }
    entry.ms = Math.round(performance.now() - started);
    probes.push(entry);
    process.stderr.write(`${probes.length} ${entry.group}:${entry.label} ${entry.ms}ms${entry.closed ? ` closed=${entry.closed.join(',')}` : ''}` +
      `${entry.stillOpen ? ` OPEN=${entry.stillOpen}` : ''}${entry.error ? ` ! ${entry.error.slice(0, 100)}` : ''}\n`);
  };

  // Probes are named descriptors resolved against the current game, so a
  // reboot re-targets the same map actor.
  const plan = [{group: 'idle', label: 'startup+10s', body: () => {}, frames: 600}];
  const actors = level.actors.filter(actor => actor && actor !== player);
  // Actor declares empty Frob/Bump/Touch events; only an overriding body is an
  // interaction. One actor per class unless --all (instances share the body).
  const has = (actor, event) => {
    try { const record = runtime.lookup(actor, event); return Boolean(record?.function) && record.key !== `engine.actor.${event.toLowerCase()}`; }
    catch { return false; }
  };
  const perClass = list => {
    if (argv.includes('--all')) return list;
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
      const [name, ...rest] = command.split(/\s+/);
      if (!has(player, name)) { probes.push({group: 'exec', label: command, error: `no player exec function ${name}`}); continue; }
      const args = rest.map(Number);
      plan.push({group: 'exec', label: command, body: () => game.hud.scoped(() => runtime.dispatchSpawnedEvent(player, name, args))});
    }
  }
  const only = flag('--only') ? new RegExp(flag('--only'), 'i') : null;
  for (const entry of plan) if (!only || only.test(`${entry.group}:${entry.label}`)) await run(entry);
  writeFileSync(out, JSON.stringify({meta: {continue: continueMode, groups, boots}, probes, records}));
  process.exit(0);
}
