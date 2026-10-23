/** Transition census (docs/travel.md "Play, step 5, second part"): every way out of every installed single-player map, driven in Play from a realistic state.
 *
 * The plan lists, from the installed maps (decodeMap), every `MapExit` and every enabled `Teleporter` with a URL, plus the two scripted `SendPlayer`s of
 * the missions (Mission04's captured player, Mission11's Toby Atanwe teleport). Each transition runs in one child process: the source level is opened
 * from a real save slot whose level is the source map (the 41 desktop slots of the main checkout's `.work/internet-saves`, loaded through `LoadGame N`
 * as the page does) or, where no slot reaches the map, cold; the exit is reached the way the original's actor would reach it (the player walks into a
 * Teleporter or a touched MapExit; a triggered MapExit is fired by the Button1 the player frobs, or by the Trigger call of the actor that owns it in the
 * map); the tick's travel step makes the request for the next level; the arrival opens from that request and ticks 60 frames. A transition that leads
 * back to the source map (the Hong Kong lifts, the Teleporter pairs) is then driven the other way, so the filed level is restored.
 *
 * Per transition the record names the Browse branch taken against the branch the mission numbers and the `Save\Current` listing call for (independent of
 * Play's own decision), the arrival (map, portal, where the player stands against the start spots the portal names, the player's state), the engine log of
 * the leg, and a stop by stage and name. The report groups the stops by family. Nothing in a slot is executed: the files are only parsed (docs/travel.md
 * "Play, step 4: loading a saved game").
 *
 *   node scripts/census-transitions.mjs [--plan] [--only <regex on the id>] [--reuse] [--timeout 900] [--report] [--out <file>] [--reverse] [--also <file>] [--frames 60]
 *   node scripts/census-transitions.mjs --one <id>          (the child: one transition, one JSON line)
 *
 * Output: `.work/census-transitions.json` (outside Git), one record per transition, written as the walk goes. */
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const here = new URL('.', import.meta.url).pathname;
const WORK = path.resolve(here, '../.work');
const PLAN_FILE = path.join(WORK, 'census-transitions-plan.json');
const OUT_FILE = path.resolve(option('out', path.join(WORK, 'census-transitions.json')));
const INTERNET = process.env.DX_INTERNET_SAVES ?? '/home/rydgel/projects/deus_ex_web/.work/internet-saves';
const SLOT_ROOTS = [path.join(INTERNET, 'nicouzouf/files/Deus Ex'), path.join(INTERNET, 'retromaggedon/files')];

let root;
try { root = gameDirectory(); } catch { console.log('SKIP census-transitions: no installed game data'); process.exit(0); }

const lower = value => String(value ?? '').toLowerCase();
/** `Map.dx #Portal` / `Map#Portal` / `Map` -> {map, portal} as FURL splits them (the map keeps a trailing space; the stem is what files are named by). */
const splitDest = text => { const s = String(text ?? ''); const i = s.indexOf('#'); return { map: i < 0 ? s : s.slice(0, i), portal: i < 0 ? '' : s.slice(i + 1) }; };
const stemOf = text => lower(splitDest(text).map).trim().replace(/\.dx$/, '');
/** DDeusExGameEngine::GetNextMissionNumber (0x10011ef0): -1 for an empty name or two leading characters that are not both digits, else atoi(Left(name, 2)). */
const nextMission = map => /^\d\d/.test(map) ? Number(map.slice(0, 2)) : -1;

// ---- the plan ----------------------------------------------------------------------------------------------------------------------------
async function buildPlan() {
  const { decodeMap } = await import('../src/unreal/map.mjs');
  const { parseSaveInfo } = await import('../src/runtime/save-info.mjs');
  const maps = {};
  for (const name of (await readdir(`${root}/Maps`)).filter(n => n.toLowerCase().endsWith('.dx')).sort()) {
    if (/^DXMP_/i.test(name) || /^Entry\.dx$/i.test(name)) continue;
    const map = decodeMap(new Uint8Array(await readFile(`${root}/Maps/${name}`)));
    const events = new Map();
    for (const a of map.actors) {
      const event = a.values.Event;
      if (event !== undefined && event !== 'None' && event !== '') { const key = lower(event); if (!events.has(key)) events.set(key, []); events.get(key).push({ cls: a.className, name: a.name, location: a.values.Location ?? null }); }
    }
    const info = map.actors.find(a => a.className === 'DeusExLevelInfo');
    const entry = { file: name, stem: lower(name).replace(/\.dx$/, ''), mission: info?.values.missionNumber ?? 0, mapName: info?.values.MapName ?? null, hasLevelInfo: Boolean(info),
      exits: [], teleporters: [], starts: [] };
    for (const a of map.actors) {
      const v = a.values;
      if (a.className === 'MapExit') entry.exits.push({ name: a.name, tag: v.Tag ?? 'MapExit', destMap: v.DestMap ?? '', bPlayTransition: Boolean(v.bPlayTransition), cameraPathTag: v.cameraPathTag ?? null,
        touch: v.bCollideActors !== false, radius: v.CollisionRadius ?? null, location: v.Location ?? null, owners: events.get(lower(v.Tag ?? 'MapExit')) ?? [] });
      if (a.className === 'Teleporter') entry.teleporters.push({ name: a.name, tag: v.Tag ?? 'Teleporter', url: v.URL ?? '', enabled: v.bEnabled !== false, location: v.Location ?? null,
        owners: events.get(lower(v.Tag ?? 'Teleporter')) ?? [] });
      if (a.className === 'PlayerStart') entry.starts.push({ name: a.name, location: v.Location ?? null, enabled: v.bEnabled !== false, single: v.bSinglePlayerStart !== false });
    }
    maps[entry.stem] = entry;
  }
  // the real slots: SaveInfo's MapName is the level the player stood in, the listing is what `Current` holds after the load
  const slots = [];
  for (const base of SLOT_ROOTS) {
    if (!existsSync(base)) continue;
    const walk = async dir => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (!e.isDirectory()) continue;
        if (/^Save\d+$/.test(e.name)) {
          const files = (await readdir(full)).sort();
          const info = parseSaveInfo(new Uint8Array(await readFile(path.join(full, 'SaveInfo.dxs'))));
          slots.push({ id: `${path.basename(base) === 'Deus Ex' ? 'nicouzouf' : 'retromaggedon'}/${e.name}`, dir: full, index: Number(/\d+/.exec(e.name)[0]), map: lower(info.properties.MapName), files });
        } else await walk(full);
      }
    };
    await walk(base);
  }
  slots.sort((a, b) => a.id.localeCompare(b.id));
  const transitions = [];
  const sourceFor = stem => slots.find(s => s.map === stem && s.id.startsWith('nicouzouf/')) ?? slots.find(s => s.map === stem) ?? null;
  for (const m of Object.values(maps)) {
    const slot = sourceFor(m.stem);
    const base = { map: m.stem, mission: m.mission, source: slot ? { slot: slot.id } : { cold: true } };
    for (const e of m.exits) {
      const dest = splitDest(e.destMap);
      transitions.push({ id: `${m.stem}|${e.name}`, kind: 'mapexit', ...base, actor: e.name, tag: e.tag, destMap: e.destMap, dest: stemOf(e.destMap), portal: dest.portal.trim(),
        touch: e.touch, bPlayTransition: e.bPlayTransition, radius: e.radius, owners: e.owners, noDestination: !String(e.destMap).trim() });
    }
    for (const t of m.teleporters) {
      if (!t.url) continue;
      const dest = splitDest(t.url);
      transitions.push({ id: `${m.stem}|${t.name}`, kind: 'teleporter', ...base, actor: t.name, tag: t.tag, destMap: t.url, dest: stemOf(t.url), portal: dest.portal.trim(), enabled: t.enabled, owners: t.owners });
    }
  }
  // the scripted SendPlayers (DeusEx/Mission04.uc:93, Mission11.uc:61): the conditions are the mission script's, the fixture sets the flags a conversation sets
  const scripted = [
    { id: 'mission04|captured', kind: 'scripted', how: 'Mission04.Timer: TalkedToPaulAfterMessage_Played and the player Dying -> SendPlayer(05_NYC_UNATCOMJ12Lab)', map: '04_nyc_hotel', dest: '05_nyc_unatcomj12lab', portal: '', destMap: '05_NYC_UNATCOMJ12Lab', mission: 4 },
    { id: 'mission11|toby', kind: 'scripted', how: 'Mission11.Timer: MeetTobyAtanwe_Played -> SendPlayer(11_PARIS_EVERETT)', map: '11_paris_underground', dest: '11_paris_everett', portal: '', destMap: '11_PARIS_EVERETT', mission: 11 },
  ];
  for (const s of scripted) { const slot = sourceFor(s.map); transitions.push({ ...s, source: slot ? { slot: slot.id } : { cold: true } }); }
  return { maps, slots, transitions };
}

async function loadPlan({ rebuild = false } = {}) {
  if (!rebuild && existsSync(PLAN_FILE)) return JSON.parse(await readFile(PLAN_FILE, 'utf8'));
  const plan = await buildPlan();
  await mkdir(WORK, { recursive: true });
  await writeFile(PLAN_FILE, JSON.stringify(plan));
  return plan;
}

// ---- the parent --------------------------------------------------------------------------------------------------------------------------
if (!option('one')) {
  if (argv.includes('--plan')) {
    const plan = await loadPlan({ rebuild: true });
    const by = {};
    for (const t of plan.transitions) by[t.kind] = (by[t.kind] ?? 0) + 1;
    console.log(`plan: ${Object.keys(plan.maps).length} maps, ${plan.slots.length} slots, ${plan.transitions.length} transitions`, by, `${plan.transitions.filter(t => t.source.slot).length} from a slot`);
    process.exit(0);
  }
  const plan = await loadPlan();
  const only = option('only') ? new RegExp(option('only'), 'i') : null;
  const timeout = Number(option('timeout', 900)) * 1000;
  const records = existsSync(OUT_FILE) && argv.includes('--reuse') ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : [];
  const have = new Set(records.map(r => r.id));
  // a second worker (`--reverse`) walks the plan from the end and skips what another worker's file (`--also`) already holds
  const alsoIds = () => { try { return new Set(JSON.parse(readFileSync(path.resolve(option('also', '/nonexistent')), 'utf8')).map(r => r.id)); } catch { return new Set(); } };
  if (!argv.includes('--report')) {
    const order = argv.includes('--reverse') ? [...plan.transitions].reverse() : plan.transitions;
    for (const t of order) {
      if ((only && !only.test(t.id)) || have.has(t.id) || alsoIds().has(t.id)) continue;
      const started = process.hrtime.bigint();   // (census-stage5-drivers replaces Date.now with the simulated clock)
      const run = spawnSync(process.execPath, ['--max-old-space-size=7168', new URL(import.meta.url).pathname, '--one', t.id, ...(option('frames') ? ['--frames', option('frames')] : [])], { encoding: 'utf8', timeout, maxBuffer: 1 << 26 });
      const last = (run.stdout ?? '').trim().split('\n').filter(line => line.startsWith('{')).at(-1);
      let result;
      try { result = JSON.parse(last); } catch { result = { id: t.id, kind: t.kind, stage: 'process', ok: false, stop: { stage: 'process', message: run.error ? String(run.error.message) : `exit ${run.status}: ${(run.stderr ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}` } }; }
      result.seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e9);
      const i = records.findIndex(r => r.id === t.id);
      if (i >= 0) records[i] = result; else records.push(result);
      console.log(`${result.ok ? 'OK  ' : 'STOP'} ${t.id} -> ${result.request?.map ?? '-'}${result.request?.portal ? `#${result.request.portal}` : ''} ${result.branch ?? ''} [${result.stage}] ${result.ok ? `${result.seconds}s` : result.stop?.message?.slice(0, 160)}`);
      await writeFile(OUT_FILE, JSON.stringify(records, null, 1));
    }
  }
  // --merge a.json,b.json: the records of several workers into this run's file (a later file wins per id)
  if (option('merge')) {
    const byId = new Map(records.map(r => [r.id, r]));
    for (const file of option('merge').split(',')) for (const r of JSON.parse(readFileSync(path.resolve(file), 'utf8'))) byId.set(r.id, r);
    records.length = 0; records.push(...plan.transitions.map(t => byId.get(t.id)).filter(Boolean));
    await writeFile(OUT_FILE, JSON.stringify(records, null, 1));
  }
  // who fires a triggered exit: the Stage 6 inventory's exit tables ("tag `T`: conversation X / Dispatcher Y"), read from docs/stage-6-inventory.md
  const inventory = path.resolve(here, '../docs/stage-6-inventory.md');
  const firedBy = new Map();
  if (existsSync(inventory)) for (const line of readFileSync(inventory, 'utf8').split('\n')) {
    const m = /^\| `([^`]+)` \| MapExit `([^`]+)` \| [^|]* \| [^|]* \| (tag `[^|]*|touch[^|]*)\|/.exec(line);
    if (m) firedBy.set(`${m[1].toLowerCase()}|${m[2]}`, m[3].trim());
  }
  for (const r of records) if (firedBy.has(r.id)) r.firedBy = firedBy.get(r.id);
  if (records.length) await writeFile(OUT_FILE, JSON.stringify(records, null, 1));
  const tally = {};
  for (const r of records) { const t = plan.transitions.find(x => x.id === r.id); const k = `${r.kind}/${r.sourceLevel ?? '-'}/${r.forward?.driven ?? r.deferred ? (r.forward?.driven ?? 'deferred') : '-'}`; tally[k] = (tally[k] ?? 0) + 1; }
  console.log('driven:', JSON.stringify(tally));
  // the report: the stops by family
  const stops = records.filter(r => !r.ok);
  const family = r => `${r.stop?.stage ?? r.stage}: ${String(r.stop?.name ?? '')} ${String(r.stop?.message ?? '').replace(/\d+(\.\d+)?/g, 'N').replace(/\b[A-Za-z]+N\b/g, 'X#').slice(0, 110)}`;
  const families = new Map();
  for (const r of stops) { const key = family(r); if (!families.has(key)) families.set(key, []); families.get(key).push(r.id); }
  console.log(`\n${records.length - stops.length} of ${records.length} transitions arrive; ${stops.length} stop in ${families.size} families`);
  for (const [key, ids] of [...families].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${ids.length}x ${key}\n      ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', ...' : ''}`);
  // Stage 6 row 6.3.1's proof (docs/stage-6-exit-criteria.md): a stop fails it
  process.exit(stops.length ? 1 : 0);
}

// ---- one transition (the child) ----------------------------------------------------------------------------------------------------------
const plan = await loadPlan();
const spec = plan.transitions.find(t => t.id === option('one'));
const ARRIVAL_FRAMES = Number(option('frames', 60));
const result = { id: spec?.id ?? option('one'), kind: spec?.kind, source: spec?.source, stage: 'start', ok: false };
let peakRss = 0;
const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
const finish = () => { sample(); result.peakRssMiB = Math.round(peakRss / 1048576); console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1); };
const fail = (stage, error) => {
  result.stop = { stage, name: error?.name ?? 'Error', message: String(error?.message ?? error).split('\n')[0].slice(0, 400),
    where: String(error?.stack ?? '').split('\n').slice(1, 8).map(line => line.trim().replace(/^at /, '').replace(/\(?file:\/\/.*\/(src\/[^)]*|scripts\/[^)]*)\)?/, '$1')) };
  finish();
};
if (!spec) { fail('plan', new Error(`no transition ${option('one')}`)); }
if (spec.id === '00_intro|MapExit1') {   // the intro ends through MissionIntro.Timer -> PostIntro (travel step 5, first part); this exit has no DestMap and is never triggered
  result.stage = 'deferred'; result.ok = true; result.deferred = 'the intro ends through MissionIntro/PostIntro (travel step 5, first part)'; finish();
}

try {
  const { AssetStore } = await import('../src/unreal/assets.mjs');
  const { openSession } = await import('./census-stage5-session.mjs');
  const { createSaveDirectory } = await import('../src/runtime/save-directory.mjs');
  const { parseSaveInfo } = await import('../src/runtime/save-info.mjs');
  const { parseTravelText } = await import('../src/runtime/travel-text.mjs');
  const files = [];
  for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
  const assets = new AssetStore(files);
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 80 && Math.abs(a[2] - b[2]) < 120;
  const round = v => v?.map?.(n => Math.round(n)) ?? v;

  // 1. the source level
  result.stage = 'source';
  let directory, slotInfo = null;
  let c;
  if (spec.source.slot) {
    const slot = plan.slots.find(s => s.id === spec.source.slot);
    const entries = [];
    for (const name of await readdir(slot.dir)) entries.push({ name, bytes: new Uint8Array(await readFile(path.join(slot.dir, name))) });
    const info = parseSaveInfo(entries.find(e => e.name === 'SaveInfo.dxs').bytes);
    directory = createSaveDirectory({ saves: [{ directory: `Save${String(slot.index).padStart(4, '0')}`, files: entries, info }] });
    slotInfo = { slot: slot.id, current: slot.files };
    const { c: boot } = await openSession('DXOnly', assets, { travel: {}, saveDirectory: directory });
    boot.frames(10);
    boot.exec(`LoadGame ${slot.index}`); boot.frames(2);
    const load = boot.takeTravel();
    if (!load?.restore) throw Object.assign(new Error(`LoadGame ${slot.index} made no restore request`), { stageName: 'source' });
    ({ c } = await openSession(load.map, assets, { travel: { arrival: load, lastURL: load.lastURL }, saveDirectory: directory }));
    c.frames(60);
    result.sourceLevel = 'slot';
  } else {
    directory = createSaveDirectory();
    ({ c } = await openSession(spec.map === 'mission11|toby' ? '11_Paris_Underground' : plan.maps[spec.map].file.replace(/\.dx$/i, ''), assets, { travel: {}, saveDirectory: directory }));
    c.frames(60);
    result.sourceLevel = 'cold';
  }
  const sourceMap = plan.maps[spec.map];
  const lookupRestorable = stem => directory.files('Current').some(f => lower(f.name).replace(/\.dxs$/, '') === stem);
  result.currentBefore = directory.files('Current').map(f => f.name).sort();

  // 2. fire the exit the way the original's actor would be reached
  /** The player walks into `actor` (a placement alone raises no Touch: a touch comes from a move into the cylinder); null when nothing was touched. */
  const walkInto = (session, actor, radius) => {
    const at = session.pos(actor);
    const distance = Math.max(150, (radius ?? 0) + 120);
    let from = null, yaw = 0;
    for (let k = 0; k < 8 && !from; k++) {
      const bearing = k * Math.PI / 4, p = [at[0] + Math.cos(bearing) * distance, at[1] + Math.sin(bearing) * distance, at[2] + 10];
      if (session.inWorld(p)) { from = p; yaw = bearing + Math.PI; }
    }
    if (!from) return null;
    session.fixture.place(from, { yaw });
    session.fixture.drive({ keys: { ArrowUp: true } });
    const request = advance(session, 200);
    session.fixture.releaseAll();
    return request;
  };
  /** Tick one frame at a time and take the request the moment the tick's travel step makes it: the level left does not tick again (the page's simulation sets `travelled`,
   * sim-session.mjs), so a player still standing in the Teleporter must not touch it a second time and make a second request over the first (its flag base is pruned by then). */
  const advance = (session, frames) => {
    for (let n = 0; n < frames; n++) { session.frames(1); const request = session.takeTravel(); if (request) return request; }
    return null;
  };
  const waitRequest = (session, frames) => advance(session, frames);
  /** Fire transition `t` in `session`; returns {request, driven, noTravel}. A stop inside the frames is the caller's catch. */
  const fire = async (session, t) => {
    const actor = t.actor ? session.actor(t.actor) : null;
    if (t.kind === 'teleporter') {
      if (!actor) throw new Error(`the level has no ${t.actor}`);
      let request = walkInto(session, actor, 0);
      if (request) return { request, driven: 'walk' };
      session.game.hud.scoped(() => session.runtime.processEvent(actor, 'Touch', [session.player()]));
      request = waitRequest(session, 40);
      return { request, driven: 'touch-call' };
    }
    if (t.kind === 'mapexit') {
      if (!actor) throw new Error(`the level has no ${t.actor}`);
      const wait = t.bPlayTransition ? 9000 : 200;
      if (t.touch) {
        const request = walkInto(session, actor, t.radius);
        if (request) return { request, driven: 'walk' };
        if (t.bPlayTransition) { const late = waitRequest(session, wait); if (late) return { request: late, driven: 'walk' }; }
        session.game.hud.scoped(() => session.runtime.processEvent(actor, 'Touch', [session.player()]));
        return { request: waitRequest(session, wait), driven: 'touch-call', noTravel: t.noDestination };
      }
      // triggered: the Button1 the player frobs (docs/travel.md: the Hong Kong lifts), else the Trigger call of the actor that owns the exit's Tag in the map
      const button = (t.owners ?? []).find(o => o.cls === 'Button1');
      if (button) {
        try {
          await session.frob(session.actor(button.name));
          const request = waitRequest(session, wait);
          if (request || t.noDestination) return { request, driven: 'frob', via: button.name, noTravel: t.noDestination };
        } catch (error) { if (error?.name !== 'Undriven' && !/no approach selects|View trace/.test(String(error?.message))) throw error; }
      }
      session.game.hud.scoped(() => session.runtime.processEvent(actor, 'Trigger', [session.player(), session.player()]));
      return { request: waitRequest(session, wait), driven: 'trigger-call', via: (t.owners ?? []).map(o => o.cls).join(',') || 'no owner in the map', noTravel: t.noDestination };
    }
    if (t.kind === 'scripted') {
      const flags = session.read(session.player(), 'FlagBase');
      if (t.id === 'mission04|captured') {
        flags.setBool('TalkedToPaulAfterMessage_Played', true, true, -1);
        session.exec('set DeusExPlayer bCheatsEnabled True');
        session.damage(session.player(), 5000, 'Shot');
        return { request: waitRequest(session, 1200), driven: 'fixture: the flag a conversation sets, then lethal damage' };
      }
      if (t.id === 'mission11|toby') {
        flags.setBool('MeetTobyAtanwe_Played', true, true, -1);
        return { request: waitRequest(session, 1200), driven: 'fixture: the flag the conversation sets' };
      }
    }
    throw new Error(`no driver for ${t.kind}`);
  };

  // 3. what each leg must do, from the mission numbers and the listing (independent of Play's Browse)
  const expectLeg = (from, to, currentBefore) => {
    const cur = from.mission ?? 0;
    const next = nextMission(to.stem ?? to);
    const filed = to.mapName ? currentBefore.some(f => lower(f).replace(/\.dxs$/, '') === lower(to.mapName)) : false;
    return { cur, next, branch: next === -1 ? 'wipe' : next === cur ? (filed ? 'restore' : 'fresh-save') : 'wipe' };
  };
  const destEntry = stem => plan.maps[stem] ?? null;
  const portalStart = (dest, portal, session) => {
    // FindPlayerStart: the first Teleporter whose Tag is the portal, else the first enabled single-player PlayerStart
    const matches = portal ? dest.teleporters.filter(t => lower(t.tag) === lower(portal)) : [];
    if (matches.length) return { kind: 'teleporter', candidates: matches.map(m => ({ name: m.name, at: m.location })) };
    return { kind: 'PlayerStart', candidates: dest.starts.filter(s => s.enabled && s.single).map(s => ({ name: s.name, at: s.location })) };
  };
  /** The classes of the player's inventory chain (Inventory.Inventory links). */
  const inventoryOf = session => {
    const names = [];
    for (let item = session.read(session.player(), 'Inventory'); item && names.length < 400; item = session.read(item, 'Inventory')) names.push(session.runtime.instance(item).cls.record.name);
    return names;
  };
  const leg = async (session, t, label) => {
    const out = { label, transition: t.id };
    const invBefore = inventoryOf(session);
    out.flagsBefore = [...(session.read(session.player(), 'FlagBase')?.entries?.values() ?? [])].length;
    Object.defineProperty(out, 'invBefore', { value: invBefore, enumerable: false });
    const log = session.game.doors.scriptRuntime.engineLog;
    const logStart = log.length;
    const before = directory.files('Current').map(f => f.name).sort();
    let fired;
    try { fired = await fire(session, t); }
    catch (error) { out.stop = { stage: 'fire', name: error?.name, message: String(error?.message).split('\n')[0].slice(0, 300), where: String(error?.stack ?? '').split('\n').slice(1, 7).map(l => l.trim().replace(/^at /, '').replace(/\(?file:\/\/.*\/(src\/[^)]*|scripts\/[^)]*)\)?/, '$1')) }; return out; }
    out.driven = fired.driven; if (fired.via) out.via = fired.via;
    out.logLines = log.slice(logStart).filter(l => /^(Log: (Export travel|Browse:|Current mission|Attempting|Unloading|LoadMap:|Moving)|ScriptLog: )/.test(l)).slice(0, 30);
    const request = fired.request;
    if (!request) {
      out.noTravel = true;
      out.expectedNoTravel = Boolean(t.noDestination || t.enabled === false);
      return out;
    }
    Object.defineProperty(out, 'raw', { value: request, enumerable: false });
    out.request = { map: request.map, portal: request.portal, url: request.url, restore: request.restore ? request.restore.file : null, travelBytes: request.travelInfo?.[0]?.[1]?.length ?? 0 };
    // the records of the exported text: the flag objects are what the mission scripts' memory is made of
    const exportedRecords = parseTravelText(request.travelInfo?.[0]?.[1] ?? '');
    out.request.records = exportedRecords.length; out.request.flagRecords = exportedRecords.filter(r => /^Extension\.Flag/.test(r.class) || /\.Flag(Bool|Int|Float|Name|Vector|String|Rotator|Base)?$/i.test(r.class)).length;
    const to = destEntry(t.dest);
    const expect = to ? expectLeg(plan.maps[t.map] ?? sourceMap, to, before) : { cur: sourceMap.mission, next: nextMission(t.dest), branch: nextMission(t.dest) === -1 ? 'wipe' : 'unknown' };
    out.expect = expect;
    const after = directory.files('Current').map(f => f.name).sort();
    out.currentAfter = after;
    out.branch = request.restore ? 'restore' : after.length === 0 ? 'wipe' : 'fresh-save';
    out.branchOk = out.branch === expect.branch;
    const missionLine = out.logLines.find(l => l.startsWith('Log: Current mission'));
    out.missionLine = missionLine ?? null;
    if (missionLine && missionLine !== `Log: Current mission number is ${expect.cur}, next is ${expect.next}`) out.missionLineOk = false;
    return out;
  };
  const arrive = async (request, t, out) => {
    result.stage = 'arrival';
    let d;
    try { ({ c: d } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL }, saveDirectory: directory })); }
    catch (error) { out.stop = { stage: 'arrival-open', name: error?.name, message: String(error?.message).split('\n')[0].slice(0, 300), where: String(error?.stack ?? '').split('\n').slice(1, 7).map(l => l.trim().replace(/^at /, '').replace(/\(?file:\/\/.*\/(src\/[^)]*|scripts\/[^)]*)\)?/, '$1')) }; return null; }
    const at0 = d.pos(d.player());   // where the login put the player, before any tick: a start spot high above the floor drops the player (950 u/s^2) within the 60 frames
    try { d.frames(ARRIVAL_FRAMES); }
    catch (error) { out.stop = { stage: 'arrival-ticks', name: error?.name, message: String(error?.message).split('\n')[0].slice(0, 300), where: String(error?.stack ?? '').split('\n').slice(1, 7).map(l => l.trim().replace(/^at /, '').replace(/\(?file:\/\/.*\/(src\/[^)]*|scripts\/[^)]*)\)?/, '$1')) }; return d; }
    const p = d.player();
    const at = d.pos(p);
    const dest = destEntry(t.dest);
    const start = dest ? portalStart(dest, request.portal, d) : null;
    out.arrival = { state: d.state(p).split('.').pop(), at: round(at), health: d.read(p, 'Health'), start: start && { kind: start.kind, candidates: start.candidates.slice(0, 3).map(s => ({ name: s.name, at: round(s.at) })) },
      at0: round(at0), atStart: start ? start.candidates.some(s => s.at && (near(at0, s.at) || near(at, s.at))) : null, restored: Boolean(request.restore) };
    const log = d.game.doors.scriptRuntime.engineLog;
    out.arrival.beginPlayLines = log.filter(l => /^(Log: (Game class is|Bringing Level)|ScriptLog: (InitGame|Base Mutator))/.test(l)).length;
    out.arrival.pawns = d.actors().filter(a => d.isA(a, 'engine.playerpawn')).length;
    const flagNames = [...(d.read(p, 'FlagBase')?.entries?.values() ?? [])].map(e => `${e.name}${e.expiration ? `@${e.expiration}` : ''}`).sort();
    out.arrival.flagCount = flagNames.length;
    out.arrival.flagsOfNote = flagNames.filter(n => /^(PlayerTraveling|MS_|M\d+MissionStart|Nicolette|FordSchick)/.test(n));
    out.arrival.frames = ARRIVAL_FRAMES;
    // what the travel import and the mission scripts did with the carried items; a loss is a note (Mission05.FirstFrame takes the inventory into a room), the import's own complaints are failures
    if (out.invBefore) {
      const after = inventoryOf(d), count = list => list.reduce((m, n) => (m.set(n, (m.get(n) ?? 0) + 1), m), new Map());
      const a = count(out.invBefore), b = count(after);
      const lost = [...a].flatMap(([n, k]) => Array(Math.max(0, k - (b.get(n) ?? 0))).fill(n)), gained = [...b].flatMap(([n, k]) => Array(Math.max(0, k - (a.get(n) ?? 0))).fill(n));
      out.inventory = { before: out.invBefore.length, after: after.length, ...(lost.length ? { lost: lost.slice(0, 12) } : {}), ...(gained.length ? { gained: gained.slice(0, 12) } : {}) };
    }
    const problems = log.filter(l => /Cannot accept travelling class|Failed to spawn travelling class|Accessed None|Script call stack|ScriptWarning/i.test(l));
    if (problems.length) out.arrival.problems = problems.slice(0, 4);
    out.arrival.level = d.read(d.actors().find(a => d.isA(a, 'deusex.deusexlevelinfo')), 'MapName');
    return d;
  };

  const first = await leg(c, spec, 'forward');
  result.forward = first;
  result.request = first.request; result.branch = first.branch;
  if (first.stop) { result.stage = first.stop.stage; result.stop = first.stop; finish(); }
  if (first.noTravel) {
    result.stage = 'no-travel';
    result.ok = Boolean(first.expectedNoTravel);
    if (!result.ok) result.stop = { stage: 'fire', name: 'NoTravel', message: `${spec.kind} ${spec.actor ?? spec.id} made no request for the next level (${first.driven})` };
    // an exit with no destination still sends PreTravel to every actor: the viewport keeps an empty TravelURL and the level goes on
    if (first.expectedNoTravel) {
      const flagsAfter = [...(c.read(c.player(), 'FlagBase')?.entries?.values() ?? [])].map(e => e.name);
      result.noTravelEffects = { playerTraveling: flagsAfter.includes('PlayerTraveling'), state: c.state(c.player()).split('.').pop() };
      try { c.frames(120); } catch (error) { result.stop = { stage: 'after-no-travel', name: error?.name, message: String(error?.message).split('\n')[0] }; result.ok = false; }
    }
    finish();
  }
  // The entries the first part of step 5 owns (Play Intro, Credits, `dxonly`, the three endings: docs/travel.md "Play, step 5 (first part)"): the request is checked here,
  // the arrival is that part's validators'
  const DEFERRED = new Set(['dx', 'dxonly', '99_endgame1', '99_endgame2', '99_endgame3']);
  if (DEFERRED.has(spec.dest)) {
    result.stage = 'deferred'; result.ok = first.branchOk && first.missionLineOk !== false;
    result.deferred = 'the arrival at the logo map, DXOnly or an ending belongs to travel step 5, first part';
    if (!result.ok) result.stop = { stage: 'check', name: 'Mismatch', message: `branch ${first.branch}, expected ${first.expect?.branch}` };
    finish();
  }
  const d = await arrive(first.raw, spec, first);
  if (first.stop) { result.stage = first.stop.stage; result.stop = first.stop; finish(); }
  const bad = [];
  if (!first.branchOk) bad.push(`the branch was ${first.branch}, the mission numbers and the listing call for ${first.expect.branch}`);
  if (first.missionLineOk === false) bad.push(`the log says "${first.missionLine}"`);
  if (first.arrival.atStart === false) bad.push(`the player stands at ${first.arrival.at}, not at the ${first.arrival.start?.kind} ${first.arrival.start?.candidates.map(s => `${s.name}@${s.at}`).join(' | ')}`);
  if (first.arrival.restored && first.arrival.beginPlayLines) bad.push('the restored level ran a begin-play line');
  if (first.arrival.pawns !== 1) bad.push(`${first.arrival.pawns} player pawns`);
  if (first.arrival.problems) bad.push(`the arrival log holds ${first.arrival.problems[0]}`);
  // within a mission the flags travel with the player: an arrival that holds fewer than the player had (less the one FirstFrame deletes) lost them in the text
  if (first.expect.next === first.expect.cur && first.arrival.flagCount < first.flagsBefore - 2) bad.push(`the flags: ${first.flagsBefore} before, ${first.arrival.flagCount} at the arrival`);
  if (first.arrival.state !== 'playerwalking' && !/conversation|swimming|falling|interpolating|dying|paralyzed/.test(first.arrival.state)) bad.push(`the arrived player is in ${first.arrival.state}`);
  // 4. the way back, when the arrival level leads to the source map: the source is filed and is restored
  const back = plan.transitions.find(t => t.map === first.raw.map.toLowerCase().replace(/\.dx$/, '') && t.dest === spec.map && t.kind !== 'scripted' && !t.noDestination && (t.kind !== 'teleporter' || t.enabled));
  if (back && d) {
    result.stage = 'return';
    const second = await leg(d, back, 'return');
    result.return = second;
    if (second.stop) { result.stage = second.stop.stage; result.stop = second.stop; finish(); }
    if (second.noTravel) bad.push(`the way back (${back.id}) made no request`);
    else {
      await arrive(second.raw, back, second);
      if (second.stop) { result.stage = second.stop.stage; result.stop = second.stop; finish(); }
      if (!second.branchOk) bad.push(`the way back: the branch was ${second.branch}, the numbers call for ${second.expect.branch}`);
      if (second.arrival.atStart === false) bad.push(`the way back: the player stands at ${second.arrival.at}, not at the ${second.arrival.start?.kind} ${second.arrival.start?.candidates.map(s => `${s.name}@${s.at}`).join(' | ')}`);
      if (second.arrival.restored && second.arrival.beginPlayLines) bad.push('the way back: the restored level ran a begin-play line');
      if (second.arrival.pawns !== 1) bad.push(`the way back: ${second.arrival.pawns} player pawns`);
      if (second.expect.next === second.expect.cur && second.arrival.flagCount < second.flagsBefore - 2) bad.push(`the way back: the flags: ${second.flagsBefore} before, ${second.arrival.flagCount} at the arrival`);
    }
  }
  result.stage = 'done';
  result.ok = bad.length === 0;
  if (bad.length) result.stop = { stage: 'check', name: 'Mismatch', message: bad.join('; ') };
  finish();
} catch (error) {
  fail(result.stage, error);
}
