/** Stage 6, rows 6.4.NN.2 (docs/stage-6-exit-criteria.md, docs/stage-6-flag-census.md "The census's comparison"): each carried-flag census unit with an
 * original capture (.work/chains/m<unit>/result.json, scripts/chain-original.mjs --file) is run in Play from the same base save, as validate-stage6-chain.mjs
 * runs a chain, and compared on **the unit's observable** only:
 *
 *   1. flags: at every snapshot of the capture, the flags whose names are the unit's own (the census flag and every flag the unit wrote into its base) and
 *      the flags its reader conversations read or set, taken from the conversations' data in DeusExConText (the conversation's flagRefList, its CheckFlag
 *      and SetFlag events, its choices' flag conditions, its <name>_Played and <name>_Interrupted, and the same of a conversation it jumps into);
 *   2. history: in every map change's travel text, the ConHistory records that are a reader's (a record whose first event's speech is one of the reader
 *      conversation's speeches, found by speech and not by position), compared record by record: owner, location, InfoLink, then each event's speaker,
 *      speech and soundID in order (a speech the two runs drew differently from one conversation's random label is accepted: chain-conversations.mjs);
 *   3. states: the unit's `state` reads with `presence` (a pawn a mission script enters, hides or destroys).
 *
 * Everything else (ambient barks the original's drawn NPCs played, the other conversations' history, flags no reader touches, a chain step's door state) is
 * printed as outside the observable and does not fail. Then, per row 6.4.NN.2, whether every carried flag set in mission NN has both sides PASS: the flag's
 * value in each unit's base (the base's manifest, .work/chains/census/bases/<family>.json) puts the unit on a side, and a unit passes a side when none of its
 * failures concerns that flag (the unit's readers that read or set it, its written flags, its states for a script's reader, its course); a side no census unit
 * holds is the chain line's own capture where the reader is on a chain (row 6.4.<reading mission>.1's status in docs/stage-6-exit-criteria.md).
 *
 * runner-timeout: 7200
 *
 *   node scripts/validate-flag-census.mjs [--unit u[,v] | --family f] [--verbose]   units without a capture SKIP; one Play child per unit
 *   node scripts/validate-flag-census.mjs --rows                                       the rows' summary from the stored verdicts only (no Play run) */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gameDirectory } from './game-directory.mjs';
import { captureDirectory, loadChain } from './chain-lib.mjs';
import { UNITS, FAMILIES, FLAGS, unitChain } from './stage6-flag-census.mjs';
import { exportAt } from '../src/unreal/objects.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CENSUS = `${ROOT}/.work/chains/census`;
const VERDICTS = `${CENSUS}/validate-summary.json`;
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1] ?? null; };
const unitById = new Map(UNITS.map(u => [u.id, u]));
const lower = s => String(s).toLowerCase();
const squash = text => String(text).replace(/\s+/g, ' ').trim();
const mapName = name => String(name ?? '').replace(/^.*[\\/]/, '').replace(/\.dxs?$/i, '').toLowerCase();
/** The reading mission of a unit: its id's c<NN>. */
const readingMission = unit => /^c(\d\d)-/.exec(unit.id)[1];

// ---- the reader conversations' data (DeusExConText, the original's own) ----------------------------------------------------------------------------------
let conText = null;
async function conversationsOf(mission) {
  if (!conText) {
    const { readdir, readFile } = await import('node:fs/promises');
    const { AssetStore } = await import('../src/unreal/assets.mjs');
    const { readObject } = await import('../src/unreal/objects.mjs');
    const root = gameDirectory(), files = [];
    for (const name of await readdir(`${root}/System`)) files.push({ path: `System/${name}`, read: () => readFile(`${root}/System/${name}`) });
    const ctx = await new AssetStore(files).get('DeusExConText');
    conText = { ctx, values: i => Object.fromEntries(Object.entries(readObject(ctx.pkg, ctx.bytes, i).values).map(([k, x]) => [k.toLowerCase(), x])), lists: new Map() };
  }
  if (conText.lists.has(mission)) return conText.lists.get(mission);
  const { ctx, values } = conText;
  const nameOf = v => (v && typeof v === 'object' && 'name' in v) ? v.name : v;
  const className = i => exportAt(ctx.pkg, i).className.replace(/^ConEvent/, '');
  const flagChain = start => { const out = []; for (let ref = start, g = 0; ref && g < 64; g++) { const f = values(ref); out.push(String(nameOf(f.flagname))); ref = f.nextflagref; } return out; };
  const byName = new Map(), byObject = new Map();
  const listRef = ctx.exportsByPath.get(`conlist_mission${mission}`);
  if (!listRef) throw new Error(`no ConList_Mission${mission}`);
  for (let item = values(listRef).conversations ?? 0, guard = 0; item && guard < 5000; guard++) {
    const it = values(item), c = values(it.conobject), name = String(nameOf(c.conname));
    const record = { name, speeches: [], reads: new Set(c.flagreflist ? flagChain(c.flagreflist) : []), sets: new Set(), jumps: new Set() };
    for (let ev = c.eventlist, k = 0; ev && k < 2000; k++) {
      const e = values(ev), kind = className(ev);
      if (kind === 'Speech' && e.conspeech) { const text = values(e.conspeech).speech; if (typeof text === 'string') record.speeches.push(squash(text)); }
      else if (kind === 'CheckFlag') for (const f of flagChain(e.flagref)) record.reads.add(f);
      else if (kind === 'SetFlag') for (const f of flagChain(e.flagref)) record.sets.add(f);
      else if (kind === 'Choice') for (let ch = e.choicelist, g = 0; ch && g < 32; g++) { const choice = values(ch); if (choice.flagref) for (const f of flagChain(choice.flagref)) record.reads.add(f); ch = choice.nextchoice; }
      else if (kind === 'Jump' && e.jumpcon && e.jumpcon !== it.conobject) record.jumps.add(e.jumpcon);
      ev = e.nextevent;
    }
    byName.set(lower(name), record); byObject.set(it.conobject, record);
    item = it.next;
  }
  // a Jump into another conversation plays that conversation's events under this one: its speeches and flags count as this reader's
  for (const record of byName.values()) record.jumped = [...record.jumps].map(o => byObject.get(o)).filter(Boolean);
  conText.lists.set(mission, byName);
  return byName;
}
/** A reader conversation with the conversations it jumps into (transitively): its speeches and the flags it reads and sets. */
async function reader(mission, name) {
  const list = await conversationsOf(mission);
  const first = list.get(lower(name));
  if (!first) throw new Error(`ConList_Mission${mission} has no conversation ${name}`);
  const out = { name: first.name, speeches: new Set(), flags: new Set(), jumpsInto: [] };
  const seen = new Set();
  const walk = r => {
    if (seen.has(r.name)) return;
    seen.add(r.name);
    if (r !== first) out.jumpsInto.push(r.name);
    for (const s of r.speeches) out.speeches.add(s);
    for (const f of [...r.reads, ...r.sets, `${r.name}_Played`, `${r.name}_Interrupted`]) out.flags.add(lower(f));
    for (const j of r.jumped) walk(j);
  };
  walk(first);
  return out;
}

// ---- the travel text's conversation history -----------------------------------------------------------------------------------------------------------
/** The ConHistory records of a travel text, each with its fields and its events (speaker, speech, soundID) in order. Records are keyed by their pointer and
 * followed by the pointer of `firstEvent`/`Next`, never by name: after a LoadGame the objects a session makes can carry the names of loaded ones (c03-hq-line's
 * original text has two `ConHistory0`, the debriefing's and the save's InfoLink, and two `ConHistoryEvent0`; keyed by name, the debriefing's record vanished). */
function histories(text) {
  const records = new Map();
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const head = /^Class=(\S+) Name=(\S+) Ptr=([0-9a-fA-F]+)/.exec(line);
    if (head) { current = { cls: head[1], name: head[2], fields: {} }; records.set(head[3].toLowerCase(), current); continue; }
    const field = /^(\w+)=(.*)$/.exec(line);
    if (current && field) current.fields[field[1]] = field[2];
  }
  const ref = value => value?.split(' ')[0]?.toLowerCase();
  const out = [];
  for (const r of records.values()) {
    if (r.cls !== 'ConSys.ConHistory') continue;
    const events = [];
    for (let e = records.get(ref(r.fields.firstEvent)), n = 0; e && n < 500; e = records.get(ref(e.fields.Next)), n++)
      events.push({ speaker: e.fields.conSpeaker ?? '', speech: e.fields.Speech ?? '', soundID: e.fields.soundID ?? '' });
    out.push({ owner: r.fields.conOwnerName ?? '', location: r.fields.strLocation ?? '', infoLink: r.fields.bInfoLink === 'True', events });
  }
  return out;
}
const belongs = (record, speeches) => record.events.length > 0 && speeches.has(squash(record.events[0].speech));

// ---- one unit -------------------------------------------------------------------------------------------------------------------------------------------
async function validateUnit(unit) {
  const dir = captureDirectory(unit.id);
  const stored = existsSync(`${dir}result.json`) ? readFileSync(`${dir}result.json`, 'utf8') : null;
  if (!stored) return { unit: unit.id, status: 'SKIP', why: `no capture in .work/chains/m${unit.id}/` };
  const original = JSON.parse(stored);
  const file = `${CENSUS}/${unit.id}.mjs`;
  const chain = existsSync(file) ? await loadChain(null, file) : await unitChain(unit);
  const family = FAMILIES[unit.family];
  const runs = unit.readers ?? Object.keys(family.blocks);
  const mission = readingMission(unit);
  const readers = [];
  for (const r of family.readers ?? []) if (!r.block || runs.includes(r.block)) readers.push(await reader(mission, r.conv));
  const own = new Set([unit.flag, ...(unit.set ?? []).map(([n]) => n), ...(unit.clear ?? [])].filter(Boolean).map(lower));
  const observable = new Set([...own, ...readers.flatMap(r => [...r.flags])]);
  const censusStates = new Set(chain.steps.filter(s => s.op === 'state' && s.presence).map(s => s.label));

  const { runChainInPlay } = await import('./chain-play.mjs');
  const { randomAlternatives } = await import('./chain-conversations.mjs');
  const play = await runChainInPlay(chain, { log: line => { if (args.includes('--verbose')) console.log(`  play: ${line}`); } });

  // each failure names the part of the observable it is about (a reader's name, 'own' for the unit's written flags, 'state', or 'run' for the unit's
  // course: a snapshot, a map or a map change missing), so a row's side is judged by its flag's reader alone (validate rows below)
  const failures = [], outside = [], compared = [];
  const fail = (message, tags) => failures.push({ message, tags });
  const tagsOf = names => { const t = new Set(); for (const n of names) { const k = lower(n.split('|')[0]); if (own.has(k)) t.add('own'); for (const r of readers) if (r.flags.has(k)) t.add(r.name); } return [...t]; };
  // 1. the flags at each snapshot
  const inObservable = f => observable.has(lower(f.split('|')[0]));
  for (const [label, want] of Object.entries(original.snaps)) {
    const got = play.snaps[label];
    if (!got) { fail(`snapshot ${label}: Play has none`, ['run']); continue; }
    if (mapName(got.map) !== mapName(want.map)) fail(`snapshot ${label}: Play is in ${got.map}, the original in ${want.map}`, ['run']);
    const a = new Set(got.flags.filter(inObservable)), b = new Set(want.flags.filter(inObservable));
    const onlyPlay = [...a].filter(f => !b.has(f)), onlyOriginal = [...b].filter(f => !a.has(f));
    if (onlyPlay.length || onlyOriginal.length) fail(`snapshot ${label}: observable flags differ: only Play ${JSON.stringify(onlyPlay)}; only the original ${JSON.stringify(onlyOriginal)}`, tagsOf([...onlyPlay, ...onlyOriginal]));
    compared.push(`snapshot ${label} (${mapName(want.map)}): ${b.size} observable flags present in the original, ${a.size} in Play${onlyPlay.length || onlyOriginal.length ? ' (DIFFER)' : ', equal'}`);
    const all = new Set(got.flags), allWant = new Set(want.flags);
    const rest = [...new Set([...got.flags.filter(f => !allWant.has(f)), ...want.flags.filter(f => !all.has(f))])].filter(f => !inObservable(f));
    if (rest.length) outside.push(`snapshot ${label}: flags no reader touches differ: ${[...new Set(rest.map(f => f.split('|')[0]))].join(', ')}`);
    if (got.defaultExpiration !== want.defaultExpiration) outside.push(`snapshot ${label}: default expiration Play ${got.defaultExpiration}, the original ${want.defaultExpiration}`);
  }
  // 2. the readers' history in each map change's text
  for (const want of original.legs) {
    const got = play.legs.find(leg => leg.label === want.label);
    if (!got) { fail(`leg ${want.label}: Play made no such map change`, ['run']); continue; }
    if (!want.text) { fail(`leg ${want.label}: the capture holds no text`, ['run']); continue; }
    const hw = histories(want.text), hg = histories(got.text);
    for (const r of readers) {
      const a = hw.filter(h => belongs(h, r.speeches)), b = hg.filter(h => belongs(h, r.speeches));
      let differ = a.length !== b.length ? `${a.length} record(s) in the original, ${b.length} in Play` : null, excused = 0;
      for (let i = 0; !differ && i < a.length; i++) {
        const x = a[i], y = b[i];
        if (x.owner !== y.owner || x.location !== y.location || x.infoLink !== y.infoLink) { differ = `record ${i + 1}: owner/location/InfoLink ${JSON.stringify([x.owner, x.location, x.infoLink])} against Play's ${JSON.stringify([y.owner, y.location, y.infoLink])}`; break; }
        if (x.events.length !== y.events.length) { differ = `record ${i + 1}: ${x.events.length} events in the original, ${y.events.length} in Play`; break; }
        for (let k = 0; k < x.events.length; k++) {
          const e = x.events[k], f = y.events[k];
          if (e.speaker !== f.speaker) { differ = `record ${i + 1} event ${k + 1}: speaker ${JSON.stringify(e.speaker)} against ${JSON.stringify(f.speaker)}`; break; }
          if (e.speech === f.speech && e.soundID === f.soundID) continue;
          // only two different speeches of one random label are excused (randomAlternatives also answers true for one speech: then a soundID differs)
          if (e.speech !== f.speech && await randomAlternatives(e.speech, f.speech)) { excused++; continue; }
          differ = `record ${i + 1} event ${k + 1}: the speeches (or their soundIDs ${e.soundID}/${f.soundID}) differ`;
          break;
        }
      }
      if (differ) fail(`leg ${want.label}: ${r.name}'s history: ${differ}`, [r.name]);
      compared.push(`leg ${want.label}: ${r.name}'s history: ${a.length} record(s), ${a.reduce((n, h) => n + h.events.length, 0)} events${differ ? ' (DIFFER)' : ', equal'}${excused ? `, ${excused} random-label speech(es) accepted` : ''}`);
    }
    const mine = h => readers.some(r => belongs(h, r.speeches));
    const key = h => JSON.stringify([h.owner, h.location, h.infoLink, h.events]);
    const otherW = hw.filter(h => !mine(h)).map(key), otherG = hg.filter(h => !mine(h)).map(key);
    const onlyW = otherW.filter(k => !otherG.includes(k)).length, onlyG = otherG.filter(k => !otherW.includes(k)).length;
    if (onlyW || onlyG) outside.push(`leg ${want.label}: other conversations' history: ${onlyW} record(s) only in the original (${[...new Set(hw.filter(h => !mine(h) && !otherG.includes(key(h))).map(h => h.owner))].join(', ')}), ${onlyG} only in Play`);
    const { compareTravelTexts } = await import('./chain-conversations.mjs');
    const whole = await compareTravelTexts(want.text, got.text);
    if (whole.difference) outside.push(`leg ${want.label}: the whole text first differs at line ${whole.difference.line} (validate-stage6-chain.mjs's comparison)`);
  }
  for (const got of play.legs) if (!original.legs.some(leg => leg.label === got.label)) outside.push(`leg ${got.label}: Play's map change has no counterpart in the capture`);
  // 3. the census's state reads
  for (const [label, want] of Object.entries(original.states ?? {})) {
    const got = play.states?.[label];
    const same = JSON.stringify(got) === JSON.stringify(want);
    if (censusStates.has(label)) {
      if (!same) fail(`state ${label}: Play ${JSON.stringify(got ?? null)}, the original ${JSON.stringify(want)}`, ['state']);
      compared.push(`state ${label}: ${JSON.stringify(want)}${same ? ' equal' : ' (DIFFER)'}`);
    } else if (!same) outside.push(`state ${label} (a chain step's): Play ${JSON.stringify(got ?? null)}, the original ${JSON.stringify(want)}`);
  }
  return {
    unit: unit.id, status: failures.length ? 'FAIL' : 'PASS', failures, outside, compared,
    observable: { own: [...own], readers: readers.map(r => ({ name: r.name, jumpsInto: r.jumpsInto, flags: [...r.flags].sort(), speeches: r.speeches.size })), flags: [...observable].sort(), states: [...censusStates] },
    capture: statSync(`${dir}result.json`).mtime.toISOString(),
  };
}

// ---- the rows -------------------------------------------------------------------------------------------------------------------------------------------
function chainRowStatus(mission) {
  const doc = readFileSync(`${ROOT}/docs/stage-6-exit-criteria.md`, 'utf8');
  const row = doc.split('\n').find(line => line.startsWith(`| 6.4.${mission}.1 |`));
  return row ? row.trim().split('|').filter(Boolean).pop().trim() : 'unknown';
}
function baseFlagValue(unit, flag) {
  const file = `${CENSUS}/bases/${unit.family}.json`;
  const manifest = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const flags = manifest?.units?.[unit.id]?.flags;
  if (flags) return flags.some(f => { const [name, type, , value] = f.split('|'); return lower(name) === lower(flag) && type === '0' && value === '1'; }) ? 1 : 0;
  if (unit.flag === flag) return unit.side === '1' ? 1 : 0;
  return null;
}
/** A unit's verdict for one flag: PASS when none of its failures concerns that flag's part of the observable: the unit's readers that read or set the flag
 * (from the conversations' data, kept with the verdict), its written flags when it wrote the flag, its states when no reader of the unit reads the flag (a
 * mission script's reader), and its course (a snapshot, a map, a map change). A unit FAILs as a whole on any failure; a row's side looks at its flag's. */
function verdictFor(verdicts, id, flag) {
  const v = verdicts[id];
  if (!v) return existsSync(`${captureDirectory(id)}result.json`) ? 'NOT VALIDATED' : 'NOT CAPTURED';
  if (!v.readers) return v.status;
  const k = lower(flag);
  const readersOf = Object.entries(v.readers).filter(([, flags]) => flags.includes(k)).map(([name]) => name);
  const tags = new Set(['run', ...readersOf]);
  if (v.own?.includes(k)) tags.add('own');
  if (!readersOf.length) tags.add('state');
  return v.failures.some(f => typeof f === 'string' || f.tags.some(t => tags.has(t))) ? 'FAIL' : 'PASS';
}
function rows(verdicts) {
  const lines = [];
  const rowIds = [...new Set(FLAGS.map(f => f.row))];
  for (const row of rowIds) {
    let both = 0, flags = 0;
    lines.push(`row 6.4.${row}.2:`);
    for (const f of FLAGS.filter(x => x.row === row)) {
      flags++;
      const parts = [];
      let ok = true, any = false;
      for (const read of f.reads) {
        if (!read.units?.length) { parts.push(`M${read.m}: no reader (${read.notRun.slice(0, 60)}...)`); continue; }
        any = true;
        // the units the table names, and the line unit of their family (it runs every reader block of the family with the line's flags)
        const members = new Set(read.units);
        for (const id of read.units) { const line = UNITS.find(u => u.family === unitById.get(id).family && u.side === 'line'); if (line) members.add(line.id); }
        const sides = { 1: [], 0: [] };
        for (const id of members) { const v = baseFlagValue(unitById.get(id), f.flag); if (v !== null) sides[v].push(id); }
        const judge = ids => {
          if (!ids.length) return null;
          const s = ids.map(id => verdictFor(verdicts, id, f.flag));
          return s.every(x => x === 'PASS') ? 'PASS' : s.includes('FAIL') ? 'FAIL' : 'PENDING';
        };
        const set = judge(sides[1]), unset = judge(sides[0]) ?? (read.chain ? `the chain line (row 6.4.${read.m}.1 ${chainRowStatus(read.m)})` : 'MISSING');
        const unsetOk = unset === 'PASS' || / PASS\)$/.test(unset);
        if (!(set === 'PASS' && unsetOk)) ok = false;
        parts.push(`M${read.m}: set ${set ?? 'MISSING'} [${sides[1].join(' ')}], not set ${unset} [${sides[0].join(' ')}]`);
      }
      if (any && ok) both++;
      lines.push(`  ${f.flag}: ${any ? (ok ? 'both sides PASS' : 'not yet') : 'no reader in any mission'}; ${parts.join('; ')}`);
    }
    lines.push(`  -> ${both} of ${flags} flags with both sides PASS`);
  }
  return lines;
}

// ---- main ---------------------------------------------------------------------------------------------------------------------------------------------
if (args.includes('--child')) {
  const result = await validateUnit(unitById.get(option('child')));
  writeFileSync(option('out'), JSON.stringify(result, null, 1));
  process.exit(0);
}
// A unit's verdict entry from its own result file (validate-<unit>.json). The summary is rebuilt from those files, the latest result of each unit: runs of
// this script that overlap (a --unit run beside a whole one) each wrote the shared summary from what it had loaded, and the last write kept only its units
const entryOf = (r, at) => ({ status: r.status, failures: r.failures, own: r.observable.own, readers: Object.fromEntries(r.observable.readers.map(x => [x.name, x.flags])),
  states: r.observable.states, capture: r.capture, at });
const verdicts = existsSync(VERDICTS) ? JSON.parse(readFileSync(VERDICTS, 'utf8')) : {};
for (const unit of UNITS) {
  const file = `${CENSUS}/validate-${unit.id}.json`;
  if (!existsSync(file)) continue;
  try { verdicts[unit.id] = entryOf(JSON.parse(readFileSync(file, 'utf8')), statSync(file).mtime.toISOString()); } catch { /* a result being written */ }
}
if (!args.includes('--rows')) {
  try { gameDirectory(); } catch { console.log('SKIP validate-flag-census: no installed game data'); process.exit(0); }
  let units = UNITS;
  if (option('unit')) units = option('unit').split(',').map(id => unitById.get(id) ?? (() => { throw new Error(`no unit ${id}`); })());
  else if (option('family')) units = UNITS.filter(u => u.family === option('family'));
  const captured = units.filter(u => existsSync(`${captureDirectory(u.id)}result.json`));
  if (!captured.length) { console.log(`SKIP validate-flag-census: none of ${units.length} unit(s) has a capture in .work/chains/m<unit>/`); process.exit(0); }
  mkdirSync(CENSUS, { recursive: true });
  let failed = 0;
  for (const unit of captured) {
    const out = `${CENSUS}/validate-${unit.id}.json`;
    const run = spawnSync(process.execPath, ['--max-old-space-size=12288', new URL(import.meta.url).pathname, '--child', unit.id, '--out', out], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (run.status !== 0 || !existsSync(out)) { console.log(`FAIL ${unit.id}: the Play run stopped (exit ${run.status})`); verdicts[unit.id] = { status: 'FAIL', failures: [{ message: 'the Play run stopped', tags: ['run'] }], at: new Date().toISOString() }; failed++; continue; }
    const r = JSON.parse(readFileSync(out, 'utf8'));
    verdicts[unit.id] = entryOf(r, new Date().toISOString());
    console.log(`${r.status} ${unit.id}: the observable: ${r.observable.own.length} own flag(s) [${r.observable.own.join(' ')}], readers ${r.observable.readers.map(x => `${x.name} (${x.flags.length} flags, ${x.speeches} speeches${x.jumpsInto.length ? `, jumps into ${x.jumpsInto.join(' ')}` : ''})`).join(', ') || 'none (a mission script\'s)'}${r.observable.states.length ? `, states ${r.observable.states.join(' ')}` : ''}`);
    for (const c of r.compared) console.log(`  ${c}`);
    for (const f of r.failures) console.log(`  FAIL (${f.tags.join(', ')}): ${f.message}`);
    for (const o of r.outside) console.log(`  outside the observable: ${o}`);
    if (args.includes('--verbose')) console.log(`  observable flags: ${r.observable.flags.join(' ')}`);
    if (r.status === 'FAIL') failed++;
  }
  writeFileSync(VERDICTS, JSON.stringify(verdicts, null, 1));
  for (const line of rows(verdicts)) console.log(line);
  console.log(failed ? `FAIL validate-flag-census: ${failed} of ${captured.length} unit(s)` : `PASS validate-flag-census: ${captured.length} unit(s) with a capture equal the original on their observable`);
  process.exit(failed ? 1 : 0);
}
for (const line of rows(verdicts)) console.log(line);
