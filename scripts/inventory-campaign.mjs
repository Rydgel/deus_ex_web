#!/usr/bin/env node
/** Stage 6 campaign inventory (docs/stage-6-inventory.md): what the original's data says about every mission of the single-player campaign.
 * Read-only extraction; nothing is executed and nothing is driven. Output goes to `.work/campaign-inventory/` (outside Git).
 *
 *   node scripts/inventory-campaign.mjs conversations   every ConversationList of DeusExConText.u: owners, kinds, choices, flags, goals, transfers
 *   node scripts/inventory-campaign.mjs maps            every installed map: level info, exits, triggers, important pawns, doors, keys
 *   node scripts/inventory-campaign.mjs scripts         the MissionNN.uc sources (.cache/research/src/DeusEx): functions, flag operations, travel calls
 *   node scripts/inventory-campaign.mjs flags           the flag cross-reference (needs the three steps above): setters, readers, lifetimes
 *   node scripts/inventory-campaign.mjs slots           the real desktop save slots (SaveInfo.dxs and the saved FlagBase; needs `flags`)
 *   node scripts/inventory-campaign.mjs report          the markdown fragments of docs/stage-6-inventory.md under .work/campaign-inventory/md (needs the five steps above)
 *   node scripts/inventory-campaign.mjs all             the six steps in order
 *   node scripts/inventory-campaign.mjs chain <map> <tag> [depth]   the upstream of an event tag in a map, as an AND/OR tree (needs conversations, maps, scripts, flags)
 *
 * The conversation sources are the compiled ConversationLists (`ConList_MissionNN` in DeusExConText.u, read with the repository's package and
 * object readers); the maps are `decodeMap` plus the class defaults (`ClassDefaults.forActor`); the scripts are the extracted `.uc` files, which are
 * not in Git (`.cache/research/src`, the main checkout's); the slots are the files of `.work/internet-saves` (third-party, never modified). */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT = path.join(REPO, '.work', 'campaign-inventory');
const SOURCE_ROOT = process.env.DX_RESEARCH_SRC ?? [path.join(REPO, '.cache/research/src'), '/home/rydgel/projects/deus_ex_web/.cache/research/src'].find(existsSync);
const SAVES_ROOT = process.env.DX_INTERNET_SAVES ?? '/home/rydgel/projects/deus_ex_web/.work/internet-saves';
const step = process.argv[2] ?? 'all';

const nameOf = v => (v && typeof v === 'object' && 'name' in v) ? v.name : v;
const write = async (file, data) => { await mkdir(OUT, { recursive: true }); await writeFile(path.join(OUT, file), JSON.stringify(data, null, 1)); };
const read = async file => JSON.parse(await readFile(path.join(OUT, file), 'utf8'));

async function systemAssets() {
  const root = gameDirectory(), files = [];
  for (const directory of ['Maps', 'System'])
    for (const name of await readdir(path.join(root, directory))) files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
  const { AssetStore } = await import('../src/unreal/assets.mjs');
  return { root, assets: new AssetStore(files) };
}

// ---- conversations ---------------------------------------------------------------------------------------------------------------------------
const LISTS = ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '14', '15', '16', '98', '99'];
const EVENT_KEYS = ['Speech', 'Choice', 'SetFlag', 'CheckFlag', 'Jump', 'Trigger', 'TransferObject', 'CheckObject', 'AddGoal', 'AddNote', 'AddSkillPoints', 'AddCredits',
  'Animation', 'MoveCamera', 'RandomLabel', 'CheckPersona', 'Trade', 'End', 'Comment'];

async function conversations() {
  const { assets } = await systemAssets();
  const { readObject } = await import('../src/unreal/objects.mjs');
  const ctx = await assets.get('DeusExConText');
  const values = i => Object.fromEntries(Object.entries(readObject(ctx.pkg, ctx.bytes, i).values).map(([k, x]) => [k.toLowerCase(), x]));
  const className = i => ctx.pkg.exports[i - 1].className.replace(/^ConEvent/, '');
  const refName = i => { if (!i) return null; const e = i > 0 ? ctx.pkg.exports[i - 1] : ctx.pkg.imports[-i - 1]; return e?.name ?? null; };
  const flagChain = start => {
    const list = [];
    for (let ref = start, guard = 0; ref && guard < 64; guard++) {
      const f = values(ref);
      list.push({ flag: nameOf(f.flagname), value: !!f.value, expiration: f.expiration ?? 0 });
      ref = f.nextflagref;
    }
    return list;
  };
  const result = {};
  for (const number of LISTS) {
    const listRef = ctx.exportsByPath.get(`conlist_mission${number}`);
    if (!listRef) { result[number] = null; continue; }
    const list = values(listRef);
    const cons = [];
    for (let item = list.conversations ?? 0, guard = 0; item && guard < 5000; guard++) {
      const it = values(item), c = values(it.conobject);
      const owner = c.conownername ?? '', name = nameOf(c.conname);
      const isBark = name.startsWith(`${owner}_Bark`) && name.length >= owner.length + 5;
      const record = {
        name, owner, bark: isBark, datalink: !!c.bdatalinkcon, firstPerson: !!c.bfirstperson, nonInteractive: !!c.bnoninteractive, once: !!c.bdisplayonce,
        invoke: [c.binvokebump && 'bump', c.binvokefrob && 'frob', c.binvokesight && 'sight', c.binvokeradius && `radius ${c.radiusdistance ?? 0}`].filter(Boolean),
        audio: c.audiopackagename ?? '', id: c.conversationid ?? 0, description: c.description ?? '',
        required: c.flagreflist ? flagChain(c.flagreflist) : [],
        events: {}, speakers: [], choices: [], setFlags: [], checkFlags: [], triggers: [], goals: [], notes: [], transfers: [], checks: [], jumps: [],
        skillPoints: 0, credits: 0, firstLine: '', randomLabels: 0, personaChecks: [],
      };
      const speakers = new Set();
      let branch = '(main)';
      for (let ev = c.eventlist, k = 0; ev && k < 2000; k++) {
        const e = values(ev), kind = className(ev);
        record.events[kind] = (record.events[kind] ?? 0) + 1;
        if (e.label) branch = e.label;
        switch (kind) {
          case 'Speech': {
            if (e.speakername) speakers.add(e.speakername);
            if (!record.firstLine && e.conspeech) record.firstLine = String(values(e.conspeech).speech ?? '').replace(/\s+/g, ' ').slice(0, 160);
            break;
          }
          case 'Choice': {
            for (let ch = e.choicelist, g = 0; ch && g < 32; g++) {
              const choice = values(ch);
              record.choices.push({ text: String(choice.choicetext ?? '').replace(/\s+/g, ' '), label: choice.choicelabel ?? '', branch,
                flag: choice.flagref ? flagChain(choice.flagref) : null, skill: refName(choice.skillneeded), skillLevel: choice.skilllevelneeded ?? 0 });
              ch = choice.nextchoice;
            }
            break;
          }
          case 'SetFlag': for (const f of flagChain(e.flagref)) record.setFlags.push({ ...f, branch }); break;
          case 'CheckFlag': for (const f of flagChain(e.flagref)) record.checkFlags.push({ ...f, jump: e.setlabel ?? '', branch }); break;
          case 'Jump': record.jumps.push({ label: e.jumplabel ?? '', con: e.jumpcon ? nameOf(values(e.jumpcon).conname) : null, branch }); break;
          case 'Trigger': record.triggers.push({ tag: nameOf(e.triggertag), branch }); break;
          case 'TransferObject': record.transfers.push({ object: e.objectname ?? refName(e.giveobject) ?? '', count: e.transfercount ?? 1, from: e.fromname ?? '', to: e.toname ?? '', failLabel: e.faillabel ?? '', branch }); break;
          case 'CheckObject': record.checks.push({ object: e.objectname ?? refName(e.checkobject) ?? '', failLabel: e.faillabel ?? '', branch }); break;
          case 'AddGoal': record.goals.push({ name: nameOf(e.goalname), completed: !!e.bgoalcompleted, primary: !!e.bprimarygoal, text: String(e.goaltext ?? '').replace(/\s+/g, ' '), branch }); break;
          case 'AddNote': record.notes.push({ text: String(e.notetext ?? '').replace(/\s+/g, ' ').slice(0, 200), branch }); break;
          case 'AddSkillPoints': record.skillPoints += e.pointstoadd ?? 0; break;
          case 'AddCredits': record.credits += e.creditstoadd ?? 0; break;
          case 'RandomLabel': record.randomLabels++; break;
          case 'CheckPersona': record.personaChecks.push({ type: e.personatype ?? 0, condition: e.condition ?? 0, value: e.value ?? 0, jump: e.jumplabel ?? '', branch }); break;
          default: break;
        }
        ev = e.nextevent;
      }
      record.speakers = [...speakers];
      cons.push(record);
      item = it.next;
    }
    result[number] = { description: list.missiondescription ?? '', missionNumber: list.missionnumber ?? Number(number), conversations: cons };
  }
  await write('conversations.json', result);
  for (const [n, list] of Object.entries(result)) if (list) {
    const c = list.conversations, real = c.filter(x => !x.bark);
    console.log(`mission ${n}: ${c.length} conversations, ${c.length - real.length} barks, ${real.filter(x => x.datalink).length} DataLinks, ${real.filter(x => x.choices.length).length} with choices, ${real.filter(x => x.setFlags.length).length} set flags`);
  }
}


// ---- maps ------------------------------------------------------------------------------------------------------------------------------------
/** Case-insensitive property bag: the class defaults under the actor's stored values (names keep the spelling of the map's name table). */
const lcBag = (...bags) => { const out = Object.create(null); for (const bag of bags) for (const [k, v] of Object.entries(bag ?? {})) out[k.toLowerCase()] = v; return out; };
const round = v => Array.isArray(v) ? v.map(x => Math.round(x)) : v;
const clean = s => String(s ?? '').replace(/\s*#\s*/, '#').replace(/\.dx\b/i, '').trim();

async function maps() {
  const { root, assets } = await systemAssets();
  const { decodeMap } = await import('../src/unreal/map.mjs');
  const { ClassDefaults } = await import('../src/unreal/classes.mjs');
  const defaults = new ClassDefaults(assets);
  const names = (await readdir(path.join(root, 'Maps'))).filter(n => /\.dx$/i.test(n) && !/^DXMP_/i.test(n)).map(n => n.replace(/\.dx$/i, '')).sort();
  const result = {};
  const lineageCache = new Map();
  for (const mapName of names) {
    const asset = await assets.get(mapName), map = decodeMap(asset.bytes);
    const lineageOf = async a => {
      const idx = asset.pkg.exports[a.index - 1].classIndex;
      const key = `${asset.pkg.exports[a.index - 1].className}`;
      if (!lineageCache.has(key)) lineageCache.set(key, defaults.lineage(asset, idx).catch(() => []));
      return lineageCache.get(key);
    };
    const record = { map: mapName, actors: map.actors.length, level: null, exits: [], teleporters: [], flagTriggers: [], dataLinkTriggers: [], conversationTriggers: [],
      skillAwards: [], eventSources: [], logic: [], pawns: [], keys: [], doors: [], keypads: [], computers: [], boundActors: [], playerStarts: [], dataCubes: [], goalTriggers: [], classes: {} };
    for (const a of map.actors) {
      record.classes[a.className] = (record.classes[a.className] ?? 0) + 1;
      const lineage = await lineageOf(a);
      for (const [key, value] of Object.entries(a.values)) if (/^(Event|OutEvents(\[\d+\])?|UnTriggerEvent(\[\d+\])?|FailEvent)$/i.test(key) && nameOf(value) && nameOf(value) !== 'None')
        record.eventSources.push({ class: a.className, name: a.name, via: key, event: nameOf(value), tag: nameOf(a.values.Tag) === a.className ? '' : nameOf(a.values.Tag) });
      const is = c => lineage.includes(c);
      let v = null;
      const merged = async () => v ??= lcBag(await defaults.forActor(asset, a).catch(() => ({})), a.values);
      const base = async () => ({ class: a.className, name: a.name, at: round(a.values.Location) });
      const tagOf = x => { const t = nameOf(x.tag); return t === a.className ? '' : t; };
      if (a.className === 'DeusExLevelInfo') {
        const m = await merged();
        record.level = { mapName: m.mapname, author: m.mapauthor, location: m.missionlocation, missionNumber: m.missionnumber ?? 0, script: nameOf(m.script) ? m.script : null,
          startup: [m.startupmessage, m['startupmessage[1]'], m['startupmessage[2]'], m['startupmessage[3]']].filter(Boolean), trueNorth: m.truenorth, multiplayer: !!m.bmultiplayermap };
        const scriptRef = a.values.Script;
        if (scriptRef) { try { record.level.scriptClass = asset.pkg.imports[-scriptRef - 1]?.name ?? asset.pkg.exports[scriptRef - 1]?.name ?? null; } catch { /* leave */ } }
      } else if (is('deusex.mapexit')) {
        const m = await merged();
        record.exits.push({ ...await base(), tag: tagOf(m), dest: m.destmap ?? '', transition: !!m.bplaytransition, cameraPath: nameOf(m.camerapathtag) || '', event: nameOf(m.event) || '' });
      } else if (is('engine.teleporter')) {
        const m = await merged();
        record.teleporters.push({ ...await base(), tag: tagOf(m), url: m.url ?? '', enabled: m.benabled !== false, event: nameOf(m.event) || '' });
      } else if (is('deusex.flagtrigger')) {
        const m = await merged();
        record.flagTriggers.push({ ...await base(), tag: tagOf(m), flag: nameOf(m.flagname), value: m.flagvalue !== false && m.flagvalue !== 0, set: !!m.bsetflag, trigger: !!m.btrigger,
          expiration: m.flagexpiration ?? -1, event: nameOf(m.event) || '', once: !!m.btriggeroncenly || !!m.btriggeronceonly, type: m.triggertype ?? null, standing: !!m.bwhilestandingonly });
      } else if (is('deusex.datalinktrigger')) {
        const m = await merged();
        record.dataLinkTriggers.push({ ...await base(), tag: tagOf(m), datalink: nameOf(m.datalinktag), checkFlag: nameOf(m.checkflag) || '', checkFalse: !!m.bcheckfalse, event: nameOf(m.event) || '', type: m.triggertype ?? null, once: !!m.btriggeronceonly });
      } else if (is('deusex.conversationtrigger')) {
        const m = await merged();
        record.conversationTriggers.push({ ...await base(), tag: tagOf(m), conversation: nameOf(m.conversationtag), bindName: m.bindname ?? '', checkFlag: nameOf(m.checkflag) || '', checkFalse: !!m.bcheckfalse, event: nameOf(m.event) || '' });
      } else if (is('deusex.skillawardtrigger')) {
        const m = await merged();
        record.skillAwards.push({ ...await base(), tag: tagOf(m), points: m.skillpointsadded ?? 0, message: m.awardmessage ?? '' });
      } else if (is('deusex.goalcompletetrigger')) {
        const m = await merged();
        record.goalTriggers.push({ ...await base(), tag: tagOf(m), goal: nameOf(m.goalname) || '', event: nameOf(m.event) || '' });
      } else if (is('deusex.nanokey')) {
        const m = await merged();
        record.keys.push({ ...await base(), keyId: nameOf(m.keyid), description: m.description ?? '' });
      } else if (is('deusex.deusexmover') || is('engine.mover')) {
        const m = await merged();
        if (is('deusex.deusexmover')) record.doors.push({ ...await base(), tag: tagOf(m), key: nameOf(m.keyidneeded) || '', locked: !!m.blocked, pickable: !!m.bpickable, lockStrength: m.lockstrength ?? null, breakable: !!m.bbreakable, doorStrength: m.doorstrength ?? null,
          frobbable: m.bfrobbable !== false, event: nameOf(m.event) || '', oneWay: !!m.boneway });
      } else if (is('deusex.keypad')) {
        const m = await merged();
        record.keypads.push({ ...await base(), tag: tagOf(m), code: m.validcode ?? '', event: nameOf(m.event) || '', hackStrength: m.hackstrength ?? null, failEvent: nameOf(m.failevent) || '' });
      } else if (is('deusex.computers')) {
        const m = await merged();
        record.computers.push({ ...await base(), tag: tagOf(m), node: m.nodename ?? '', title: m.titlestring ?? '', text: m.textpackage ?? '' });
      } else if (is('deusex.datacube')) {
        const m = await merged();
        record.dataCubes.push({ ...await base(), tag: tagOf(m), textTag: nameOf(m.texttag) || '', image: nameOf(m.imagetag) || '' });
      } else if (is('engine.playerstart')) {
        const m = await merged();
        record.playerStarts.push({ ...await base(), tag: tagOf(m) });
      }
      if (is('deusex.scriptedpawn')) {
        const m = await merged();
        record.pawns.push({ ...await base(), bind: m.bindname ?? '', important: !!m.bimportant, alliance: nameOf(m.alliance) || '', orders: nameOf(m.orders) || '', ordersTag: nameOf(m.orderTag) || nameOf(m.ordertag) || '',
          tag: tagOf(m), familiar: m.familiarname ?? '', hidden: !!m.bhidden, invincible: !!m.binvincible, event: nameOf(m.event) || '' });
      } else if (!is('deusex.scriptedpawn')) {
        // anything else that is bound to a conversation by name (decorations, computers, switches) or fires/receives events
        const bn = a.values.BindName ?? a.values.bindName;
        if (bn) record.boundActors.push({ ...await base(), bind: bn });
        if (/Trigger$|^(Dispatcher|SpecialEvent|AlarmUnit|OrdersTrigger|AllianceTrigger|SequenceTrigger|SpawnPoint|Switch1|Switch2|Button1|ControlPanel|ElevatorMover|LogicTrigger|Counter|Teleporter|MapExit)$/.test(a.className) || is('engine.triggers')) {
          if (!record.logic.some(x => x.name === a.name)) {
            const m = await merged();
            record.logic.push({ ...await base(), tag: tagOf(m), event: nameOf(m.event) || '', type: m.triggertype ?? null, once: !!m.btriggeroncenly || !!m.btriggeronceonly, ordersTag: nameOf(m.ordertag) || nameOf(m.orders) || '', alliance: nameOf(m.alliancename) || '', initiallyActive: m.binitiallyactive });
          }
        }
      }
    }
    result[mapName] = record;
    process.stderr.write(`${mapName} ${record.actors}\n`);
  }
  await write('maps.json', result);
  for (const r of Object.values(result)) console.log(`${r.map.padEnd(32)} mission ${r.level?.missionNumber ?? '-'} actors ${r.actors} exits ${r.exits.length} tele ${r.teleporters.length} pawns ${r.pawns.length} (important ${r.pawns.filter(p => p.important).length})`);
}

// ---- scripts ---------------------------------------------------------------------------------------------------------------------------------
const MISSION_OF_SCRIPT = { Mission00: 0, Mission01: 1, Mission02: 2, Mission03: 3, Mission04: 4, Mission05: 5, Mission06: 6, Mission08: 8, Mission09: 9, Mission10: 10, Mission11: 11,
  Mission12: 12, Mission14: 14, Mission15: 15, MissionIntro: 98, MissionEndgame: 99 };

function parseScript(name, text) {
  const lines = text.split(/\r?\n/);
  const functions = [];
  let current = null, depth = 0, pending = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '');
    const n = i + 1;
    const header = /^\s*(?:simulated\s+)?function\s+(?:\w+\s+)?(\w+)\s*\(/.exec(line);
    if (!current && header) { pending = { name: header[1], start: n, ops: [] }; }
    const opens = (line.match(/\{/g) ?? []).length, closes = (line.match(/\}/g) ?? []).length;
    if (pending && !current && opens) { current = pending; pending = null; depth = 0; }
    if (current) {
      const ops = current.ops;
      const push = (kind, arg, extra = {}) => ops.push({ line: n, kind, arg, ...extra });
      let m;
      const flagRe = /(?:flags|flagBase|FlagBase)\.(Get|Set)(Bool|Int|Byte|Name)\(\s*(?:'([^']+)'|(\w+))\s*(?:,\s*([^,)]+))?(?:,\s*([^,)]*))?(?:,\s*([^)]*))?\)/g;
      while ((m = flagRe.exec(line))) {
        const flag = m[3] ?? `<${m[4]}>`;
        if (m[1] === 'Get') push('flag-get', flag);
        else push('flag-set', flag, { value: (m[5] ?? '').trim(), expiration: (m[7] ?? '').trim() || null });
      }
      if ((m = /DeleteFlag\(\s*'([^']+)'/.exec(line))) push('flag-delete', m[1]);
      if (/DeleteAllFlags/.test(line)) push('flag-delete-all', '*');
      if ((m = /StartDataLinkTransmission\(\s*"([^"]+)"/.exec(line))) push('datalink', m[1]);
      if ((m = /StartConversationByName\(\s*'([^']+)'/.exec(line))) push('conversation', m[1]);
      if ((m = /GoalCompleted\(\s*'([^']+)'/.exec(line))) push('goal-complete', m[1]);
      if ((m = /\bAddGoal\(\s*'([^']+)'/.exec(line))) push('goal-add', m[1]);
      if (/\bAddNote\(/.test(line)) push('note', '');
      if (/SendPlayer|ClientTravel|LocalTravel|NextMap\b/.test(line)) push('travel', line.trim());
      if ((m = /Spawn\(\s*class'([^']+)'/.exec(line))) push('spawn', m[1]);
      if (/\.Destroy\(\)/.test(line)) push('destroy', line.trim());
      if (/\.(EnterWorld|LeaveWorld)\(\)/.test(line)) push('hide', line.trim());
      if (/\bSetLocation\(|\bTeleport\(|SetOrders\(|ChangeAlly\(|SetHomeBase\(|\.Trigger\(|\.UnTrigger\(|BlowItUp\(|SetCollision\(|DeleteInventory\(|AddInventory\(|SetPhysics\(|\.Explode\(|TakeDamage\(/.test(line)) push('act', line.trim());
      if ((m = /foreach\s+AllActors\(\s*class'([^']+)'\s*,\s*(\w+)(?:\s*,\s*'([^']+)')?/.exec(line))) push('iterate', m[1], { var: m[2], tag: m[3] ?? null });
      if ((m = /BindName\s*==\s*"([^"]+)"/.exec(line))) push('bindname', m[1]);
      depth += opens - closes;
      if (depth <= 0 && closes) { current.end = n; functions.push(current); current = null; }
    }
  });
  return { name, mission: MISSION_OF_SCRIPT[name] ?? null, lines: lines.length, functions: functions.map(f => ({ name: f.name, start: f.start, end: f.end, ops: f.ops })) };
}

async function scripts() {
  const dir = path.join(SOURCE_ROOT, 'DeusEx');
  const result = {};
  for (const name of Object.keys(MISSION_OF_SCRIPT)) {
    const text = await readFile(path.join(dir, `${name}.uc`), 'utf8');
    result[name] = parseScript(name, text);
  }
  await write('scripts.json', result);
  for (const s of Object.values(result)) {
    const ops = s.functions.flatMap(f => f.ops);
    console.log(`${s.name}: ${s.lines} lines, functions ${s.functions.map(f => f.name).join(' ')}; flag sets ${ops.filter(o => o.kind === 'flag-set').length}, reads ${ops.filter(o => o.kind === 'flag-get').length}, datalinks ${ops.filter(o => o.kind === 'datalink').length}, travel ${ops.filter(o => o.kind === 'travel').length}`);
  }
}

// ---- flags -----------------------------------------------------------------------------------------------------------------------------------
/** The flag cross-reference. A flag is created with an expiration: 0 never expires; omitted (-1 in FlagTrigger) it is the creating level's MissionNumber + 1 (MissionScript.InitStateMachine's
 * SetDefaultExpiration). Entering a level of mission M by travel runs DeleteExpiredFlags(M), which removes every flag whose expiration is non-zero and <= M (docs/travel.md "PlayerTraveling"),
 * so a flag set in mission S with expiration E is still there in mission R > S exactly when E == 0 or E > R. Every conversation SetFlag event is permanent: all 4000 ConFlagRefs of
 * DeusExConText.u carry expiration 0 (checked in `conversations`: no stored `expiration` property), and ConPlayBase.SetFlag applies `SetExpiration(flag, ref.expiration)`. */
const defaultExpiration = mission => mission + 1;
const lowerKey = name => String(name).toLowerCase();

async function flags() {
  const conversationsData = await read('conversations.json'), mapsData = await read('maps.json'), scriptsData = await read('scripts.json');
  const table = new Map();
  const entry = name => { const k = lowerKey(name); if (!table.has(k)) table.set(k, { name, setters: [], readers: [] }); return table.get(k); };
  const common = new Set(conversationsData['16'].conversations.map(c => c.name));
  const conversationMission = new Map();      // conversation name -> missions of the lists that hold it (06/07 are the same list: 6 only)
  for (const [number, list] of Object.entries(conversationsData)) {
    if (!list || number === '07' || number === '16' || number === '98') continue;
    const mission = list.missionNumber;
    for (const c of list.conversations) {
      if (common.has(c.name)) continue;
      if (!conversationMission.has(c.name)) conversationMission.set(c.name, new Set());
      conversationMission.get(c.name).add(mission);
      const where = `${c.name}`;
      for (const f of c.setFlags) entry(f.flag).setters.push({ kind: 'conversation', mission, where, value: f.value, expiration: 0, branch: f.branch });
      for (const f of c.required) entry(f.flag).readers.push({ kind: 'conversation-requires', mission, where, value: f.value });
      for (const f of c.checkFlags) entry(f.flag).readers.push({ kind: 'conversation-checks', mission, where, value: f.value, branch: f.branch });
      for (const ch of c.choices) for (const f of ch.flag ?? []) entry(f.flag).readers.push({ kind: 'choice-requires', mission, where: `${c.name}: choice ${ch.label}`, value: f.value });
      entry(`${c.name}_Played`).setters.push({ kind: 'played', mission, where, value: true, expiration: defaultExpiration(mission), branch: '' });
    }
  }
  for (const s of Object.values(scriptsData)) {
    if (s.mission === null) continue;
    for (const f of s.functions) for (const op of f.ops) {
      const where = `${s.name}.${f.name}:${op.line}`;
      if (op.kind === 'flag-set') {
        const explicit = op.expiration !== null && /^-?\d+$/.test(op.expiration) ? Number(op.expiration) : null;
        entry(op.arg).setters.push({ kind: 'script', mission: s.mission, where, value: /false/i.test(op.value) ? false : true, expiration: explicit ?? defaultExpiration(s.mission), explicit: explicit !== null });
      } else if (op.kind === 'flag-get') entry(op.arg).readers.push({ kind: 'script', mission: s.mission, where });
    }
  }
  const importantMissions = new Map();       // BindName -> Set of missions with an important pawn
  for (const m of Object.values(mapsData)) {
    const mission = m.level?.missionNumber;
    if (mission === undefined) continue;
    for (const t of m.flagTriggers) {
      if (!t.flag) continue;
      const where = `${m.map}/${t.name}`;
      if (t.set) entry(t.flag).setters.push({ kind: 'trigger', mission, where, value: t.value, expiration: t.expiration === -1 ? defaultExpiration(mission) : t.expiration, explicit: t.expiration !== -1 });
      if (t.trigger) entry(t.flag).readers.push({ kind: 'trigger', mission, where, value: t.value });
    }
    for (const t of m.dataLinkTriggers) if (t.checkFlag) entry(t.checkFlag).readers.push({ kind: 'datalink-trigger', mission, where: `${m.map}/${t.name} (${t.datalink})`, value: !t.checkFalse });
    for (const t of m.conversationTriggers) if (t.checkFlag) entry(t.checkFlag).readers.push({ kind: 'conversation-trigger', mission, where: `${m.map}/${t.name} (${t.conversation})`, value: !t.checkFalse });
    for (const p of m.pawns) if (p.important && p.bind) {
      if (!importantMissions.has(p.bind)) importantMissions.set(p.bind, new Map());
      const byMap = importantMissions.get(p.bind);
      byMap.set(m.map, mission);
    }
  }
  for (const [bind, byMap] of importantMissions) {
    const missions = [...new Set(byMap.values())];
    for (const mission of missions) {
      entry(`${bind}_Dead`).setters.push({ kind: 'death', mission, where: `${bind} dies (ScriptedPawn.Died, bImportant)`, value: true, expiration: 0 });
      entry(`${bind}_Dead`).readers.push({ kind: 'firstframe-destroy', mission, where: `MissionScript.FirstFrame destroys ${bind} in ${[...byMap].filter(([, ms]) => ms === mission).map(([mp]) => mp).join(', ')}`, value: true });
      entry(`${bind}_Unconscious`).setters.push({ kind: 'death', mission, where: `${bind} is knocked out and dies (ScriptedPawn.Died, bStunned)`, value: true, expiration: 0 });
    }
  }
  // relations
  const rows = [];
  for (const f of table.values()) {
    const lasting = [], deadReads = [];
    for (const s of f.setters) for (const r of f.readers) {
      if (r.mission <= s.mission) continue;
      const alive = s.expiration === 0 || s.expiration > r.mission;
      (alive ? lasting : deadReads).push({ set: s, read: r });
    }
    const missionsSet = [...new Set(f.setters.map(s => s.mission))].sort((a, b) => a - b);
    const missionsRead = [...new Set(f.readers.map(r => r.mission))].sort((a, b) => a - b);
    rows.push({ flag: f.name, missionsSet, missionsRead, setters: f.setters, readers: f.readers, crossMission: lasting.length > 0, lasting, deadReads });
  }
  rows.sort((a, b) => a.flag.localeCompare(b.flag));
  await write('flags.json', rows);
  const cross = rows.filter(r => r.crossMission);
  console.log(`${rows.length} flag names (${rows.filter(r => r.setters.length && r.readers.length).length} set and read), ${cross.length} read in a later mission than one that sets them while alive, ${rows.filter(r => r.deadReads.length && !r.crossMission).length} read only after expiry, ${rows.filter(r => !r.setters.length).length} read never set, ${rows.filter(r => !r.readers.length).length} set never read`);
}

// ---- slots -----------------------------------------------------------------------------------------------------------------------------------
/** The 41 real desktop save slots (SOURCES.md of `.work/internet-saves`: 39 slots of one 2002-03 playthrough from nicouzouf, 2 GOTY slots from retromaggedon). Read-only: the SaveInfo with the
 * repository's reader, then the level file named by `MapName`: the player's FlagBase (the walk `script-restore-objects.mjs` does: each `hashTable` head and its `nextFlag` chain), the player's
 * goals and a few counters. Nothing is executed. */
const FLAG_VALUE_KEYS = { FlagBool: 'bvalue', FlagByte: 'bytevalue', FlagInt: 'intvalue', FlagFloat: 'floatvalue', FlagName: 'namevalue', FlagVector: 'vectorvalue', FlagRotator: 'rotatorvalue' };

async function slotDirectories() {
  const found = [];
  const walk = async (dir, source) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (/^Save\d+$/.test(entry.name)) found.push({ source, dir: full }); else await walk(full, source);
    }
  };
  for (const [source, sub] of [['nicouzouf', 'nicouzouf/files/Deus Ex'], ['retromaggedon', 'retromaggedon/files']]) await walk(path.join(SAVES_ROOT, sub), source);
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

async function slots() {
  const { parsePackage } = await import('../src/unreal/package.mjs');
  const { readObject } = await import('../src/unreal/objects.mjs');
  const { parseSaveInfo } = await import('../src/runtime/save-info.mjs');
  const maps = await read('maps.json');
  const missionOfMap = new Map(Object.values(maps).map(m => [m.map.toLowerCase(), m.level?.missionNumber ?? null]));
  const result = [];
  for (const { source, dir } of await slotDirectories()) {
    const name = path.basename(dir);
    const files = (await readdir(dir)).filter(n => /\.dxs$/i.test(n));
    const info = parseSaveInfo(new Uint8Array(await readFile(path.join(dir, 'SaveInfo.dxs'))));
    const props = info?.properties ?? {};
    const mapName = props.MapName ?? '';
    const levelFile = files.find(n => n.toLowerCase() === `${mapName.toLowerCase()}.dxs`);
    const record = { source, slot: name, directoryIndex: props.DirectoryIndex ?? null, description: props.Description ?? '', location: props.MissionLocation ?? '', map: mapName, mission: missionOfMap.get(mapName.toLowerCase()) ?? null,
      saveCount: props.saveCount ?? 0, saveTime: props.saveTime ?? 0, stamp: [props.Year, props.Month, props.Day, props.Hour, props.Minute, props.Second], cheats: !!props.bCheatsEnabled,
      levels: files.map(n => n.replace(/\.dxs$/i, '')), flags: [], goals: [], player: {} };
    if (levelFile) {
      const bytes = new Uint8Array(await readFile(path.join(dir, levelFile)));
      const pkg = parsePackage(bytes);
      const lc = i => Object.fromEntries(Object.entries(readObject(pkg, bytes, i).values).map(([k, x]) => [k.toLowerCase(), x]));
      const base = pkg.exports.findIndex(e => e.className === 'FlagBase') + 1;
      if (base) {
        const fb = lc(base);
        const seen = new Set();
        for (let h = 0; h < 64; h++) {
          for (let ref = fb[`hashtable[${h}]`] ?? 0, guard = 0; ref && guard < 64 && !seen.has(ref); guard++) {
            seen.add(ref);
            const e = pkg.exports[ref - 1], f = lc(ref), key = FLAG_VALUE_KEYS[e.className];
            let value = key ? f[key] : undefined;
            if (e.className === 'FlagBool') value = !!value;
            else if (value === undefined) value = e.className === 'FlagInt' || e.className === 'FlagByte' ? 0 : null;
            record.flags.push({ flag: nameOf(f.flagname), type: e.className.replace(/^Flag/, ''), value: value && typeof value === 'object' && 'name' in value ? value.name : value, expiration: f.expiration ?? 0 });
            ref = f.nextflag ?? 0;
          }
        }
        record.defaultExpiration = fb.defaultflagexpiration ?? 0;
      }
      record.flags.sort((a, b) => a.flag.localeCompare(b.flag));
      for (let i = 0; i < pkg.exports.length; i++) {
        const e = pkg.exports[i];
        if (e.className === 'DeusExGoal') { const g = lc(i + 1); record.goals.push({ name: nameOf(g.goalname), text: String(g.text ?? '').replace(/\s+/g, ' ').slice(0, 120), primary: !!g.bprimarygoal, completed: !!g.bcompleted }); }
        else if (/^JCDentonMale/.test(e.className) && !record.player.health) {
          const p = lc(i + 1);
          record.player = { health: p.health ?? 100, credits: p.credits ?? 0, skillPointsTotal: p.skillpointstotal ?? 0, skillPointsAvail: p.skillpointsavail ?? 0, energy: p.energy ?? null };
        } else if (e.className === 'DeusExNote') record.notes = (record.notes ?? 0) + 1;
      }
    }
    result.push(record);
    process.stderr.write(`${source}/${name} ${record.map} flags ${record.flags.length} goals ${record.goals.length}\n`);
  }
  await write('slots.json', result);
  for (const r of result) console.log(`${r.source.slice(0, 4)} ${r.slot} M${r.mission} ${r.map.padEnd(28)} ${r.description.slice(0, 28).padEnd(28)} flags ${String(r.flags.length).padStart(3)} goals ${r.goals.length} levels ${r.levels.length}`);
}

// ---- report ----------------------------------------------------------------------------------------------------------------------------------
/** Markdown fragments per mission (`.work/campaign-inventory/md/`): the tables of docs/stage-6-inventory.md are these files, pasted. Needs the five extraction steps. */
const MISSION_IDS = ['00', '01', '02', '03', '04', '05', '06', '08', '09', '10', '11', '12', '14', '15'];
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mapKey = s => clean(s).split('#')[0].toLowerCase();
const portalOf = s => clean(s).split('#')[1] ?? '';

function edgesOf(mapsData) {
  const edges = [];
  for (const m of Object.values(mapsData)) {
    for (const e of m.exits) if (e.dest) edges.push({ from: m.map, actor: e.name, kind: 'MapExit', dest: mapKey(e.dest), portal: portalOf(e.dest), transition: e.transition, camera: e.cameraPath, at: e.at });
    for (const t of m.teleporters) if (t.url) edges.push({ from: m.map, actor: t.name, kind: 'Teleporter', dest: mapKey(t.url), portal: portalOf(t.url), transition: false, camera: '', at: t.at });
  }
  return edges;
}

const kindOf = c => c.datalink ? 'DL' : (c.firstPerson && c.nonInteractive) ? 'ovh' : 'talk';
/** A cell: the items joined, cut after about `max` characters with the count of what was left out. */
const cap = (items, max = 220) => { const out = []; let n = 0; for (const it of items) { if (n + it.length > max && out.length) break; out.push(it); n += it.length + 2; } return out.join(', ') + (out.length < items.length ? ` (+${items.length - out.length} more)` : ''); };
const flagText = f => `${f.value === false ? '!' : ''}${f.flag}`;

async function report() {
  const conv = await read('conversations.json'), mapsData = await read('maps.json'), scriptsData = await read('scripts.json'), flagRows = await read('flags.json'), slotRows = await read('slots.json');
  const edges = edgesOf(mapsData);
  const common = new Set(conv['16'].conversations.map(c => c.name));
  const readers = new Map(flagRows.map(f => [f.flag.toLowerCase(), f.readers]));
  const setters = new Map(flagRows.map(f => [f.flag.toLowerCase(), f.setters]));
  const scriptText = {};
  for (const name of Object.keys(MISSION_OF_SCRIPT)) scriptText[name] = (await readFile(path.join(SOURCE_ROOT, 'DeusEx', name + '.uc'), 'utf8')).split(/\r?\n/);
  const scriptRefs = (tag, mission) => Object.entries(scriptText).filter(([name]) => MISSION_OF_SCRIPT[name] === mission).flatMap(([name, lines]) => lines.map((l, i) => [name, i + 1, l]).filter(([, , l]) => l.toLowerCase().includes("'" + tag.toLowerCase() + "'") && !l.trim().startsWith('//')).map(([n, i]) => name + ':' + i));
  const convTriggersOf = number => {
    const map = new Map();
    for (const c of (conv[number]?.conversations ?? []).filter(c => !common.has(c.name))) for (const x of c.triggers) {
      const k = x.tag.toLowerCase(); if (!map.has(k)) map.set(k, new Set()); map.get(k).add(c.name + (x.branch !== '(main)' ? '[' + x.branch + ']' : ''));
    }
    return map;
  };
  const outDir = path.join(OUT, 'md');
  await mkdir(outDir, { recursive: true });
  const emit = async (name, text) => writeFile(path.join(outDir, name), text);
  const missionMaps = id => Object.values(mapsData).filter(m => (m.level?.missionNumber ?? -9) === Number(id) && !/^(DX|DXOnly|Entry)$/i.test(m.map));
  const bindIndex = new Map();             // lower(BindName) -> [map]
  for (const m of Object.values(mapsData)) for (const p of [...m.pawns.map(x => x.bind), ...m.boundActors.map(x => x.bind)]) if (p) {
    const k = String(p).toLowerCase(); if (!bindIndex.has(k)) bindIndex.set(k, new Set()); bindIndex.get(k).add(m.map);
  }
  const realMap = lower => Object.values(mapsData).find(m => m.map.toLowerCase() === lower)?.map ?? lower;
  const missionOfMapAll = new Map(Object.values(mapsData).map(m => [m.map.toLowerCase(), m.level?.missionNumber ?? null]));
  const short = map => map.replace(/^\d\d_/, '');
  const carriedFlags = flagRows.filter(r => r.crossMission && !/_(Dead|Unconscious)$/.test(r.flag) && r.lasting.some(l => !new Set(r.setters.map(x => x.mission)).has(l.read.mission))).map(r => r.flag);
  await emit('carried-flags.json', JSON.stringify(carriedFlags));
  for (const id of [...MISSION_IDS, '98', '99']) {
    const list = conv[id]; if (!list) continue;
    const mission = list.missionNumber;
    const mm = id === '98' ? [mapsData['00_Intro']] : id === '99' ? ['99_Endgame1', '99_Endgame2', '99_Endgame3', '99_Endgame4'].map(n => mapsData[n]) : missionMaps(id);
    // the script's calls, by kind (generated from the parsed source, with the line of the first occurrence)
    const scr = Object.values(scriptsData).find(x => x.mission === mission);
    if (scr) {
      const ops = scr.functions.flatMap(f => f.ops.map(o => ({ ...o, fn: f.name })));
      const uniq = (kind, fmt = o => '\`' + o.arg + '\`') => { const seen = new Map(); for (const o of ops.filter(o => o.kind === kind)) if (!seen.has(o.arg)) seen.set(o.arg, o); return [...seen.values()].map(o => fmt(o) + ' (:' + o.line + ')'); };
      const sets = uniq('flag-set', o => '\`' + o.arg + '\`' + (o.expiration !== null ? ' e' + o.expiration : ''));
      const reads = [...new Set(ops.filter(o => o.kind === 'flag-get').map(o => o.arg))];
      let sf = `Generated from the script's calls (\`inventory-campaign.mjs scripts\`; \`:N\` is the first line):\n\n`;
      sf += `* **Flags set** (${sets.length}; \`eN\` = explicit expiration N, otherwise the default): ${sets.join(', ') || 'none'}.\n`;
      sf += `* **Flags read** (${reads.length}): ${reads.map(r => '\`' + r + '\`').join(', ') || 'none'}.\n`;
      const dls = uniq('datalink'), cons = uniq('conversation'), goalsDone = uniq('goal-complete'), travel = ops.filter(o => o.kind === 'travel').map(o => '\`:' + o.line + ' ' + o.arg.replace(/\`/g, "'") + '\`');
      sf += `* **InfoLinks it starts**: ${dls.join(', ') || 'none'}. **Conversations it starts by name**: ${cons.join(', ') || 'none'}. **Goals it completes**: ${goalsDone.join(', ') || 'none'}.\n`;
      sf += `* **Spawns**: ${uniq('spawn').join(', ') || 'none'}. **Destroy calls**: ${ops.filter(o => o.kind === 'destroy').length}; **EnterWorld/LeaveWorld calls**: ${ops.filter(o => o.kind === 'hide').length}. **Travel calls**: ${travel.join('; ') || 'none'}.\n`;
      await emit(`${id}-scriptflags.md`, sf);
    }
    // maps
    let t = '| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |\n| --- | --- | --- | --- | --- | --- | --- |\n';
    for (const m of mm) {
      const groupEdges = (list, other) => { const by = new Map(); for (const e of list) { const k = other(e); if (!by.has(k)) by.set(k, { n: 0, portals: new Set(), path: new Set() }); const g = by.get(k); g.n++; if (e.portal) g.portals.add(e.portal); if (e.transition) g.path.add(e.camera); } return [...by].map(([k, g]) => `${k}${g.portals.size && g.portals.size <= 2 ? '#' + [...g.portals].join('/') : ''}${g.n > 1 ? ' x' + g.n : ''}${g.path.size ? ' (path ' + [...g.path].join('/') + ')' : ''}`); };
      const inbound = groupEdges(edges.filter(e => e.dest === m.map.toLowerCase()), e => e.from);
      const outbound = groupEdges(edges.filter(e => e.from === m.map), e => realMap(e.dest));
      t += `| \`${m.map}\` | ${m.actors} | ${esc(m.level?.mapName ?? '-')}; ${esc(m.level?.location ?? '-')} | ${esc((m.level?.startup ?? []).join(' / ') || '-')} | ${m.level?.scriptClass ?? '(none)'} | ${inbound.length ? esc(inbound.join('; ')) : '-'} | ${outbound.length ? esc(outbound.join('; ')) : '-'} |\n`;
    }
    await emit(`${id}-maps.md`, t);
    // conversations
    const own = list.conversations.filter(c => !common.has(c.name));
    const boundIn = c => { const maps = bindIndex.get(String(c.owner).toLowerCase()); return maps ? [...maps].filter(m => mm.some(x => x?.map === m)).map(short) : null; };
    const isAmbient = c => !c.datalink && c.firstPerson && c.nonInteractive;
    const effects = c => c.choices.length || c.setFlags.length || c.goals.length || c.transfers.length || c.checks.length || c.triggers.length || c.skillPoints || c.credits || c.notes.length;
    let rows = '';
    const gated = [], plain = { DL: [], talk: [], ovh: [] };
    for (const c of own) {
      if (!effects(c)) {
        if (c.required.length || c.checkFlags.length) gated.push(`\`${c.name}\` (${cap([...new Set([...c.required.map(flagText), ...c.checkFlags.map(f => '? ' + flagText(f))])], isAmbient(c) ? 36 : 90)})`);
        else plain[kindOf(c)].push(c);
        continue;
      }
      const bound = boundIn(c);
      const cells = [];
      cells.push(`\`${c.name}\``);
      cells.push(esc(c.owner || '-') + (c.owner && c.owner !== 'JCDenton' ? (bound === null ? ' (no actor)' : bound.length ? ` (${bound.slice(0, 3).join(', ')}${bound.length > 3 ? ', ...' : ''})` : ' (other missions)') : ''));
      cells.push(`${kindOf(c)}${c.invoke.length && !c.datalink ? ' ' + c.invoke.join('/') : ''}${c.once ? ' once' : ''}`);
      cells.push(c.choices.length ? String(c.choices.length) : '');
      cells.push(esc(cap([...new Map(c.setFlags.map(f => [`${f.flag}${f.value ? '' : '=0'}${f.branch !== '(main)' ? '@' + f.branch : ''}`, 1])).keys()])));
      cells.push(esc(cap([...new Set([...c.required.map(f => 'req ' + flagText(f)), ...c.checkFlags.map(f => '? ' + flagText(f))])])));
      cells.push(esc(cap([...new Set([...c.goals.map(g => `${g.completed ? 'done' : g.primary ? '+P' : '+S'} ${g.name}`), ...c.notes.map(() => '+note')])])));
      cells.push(esc(cap([...new Set([...c.triggers.map(x => 'trig ' + x.tag), ...c.transfers.map(x => `${x.to === 'JCDenton' ? 'give' : x.from === 'JCDenton' ? 'take' : 'move'} ${x.object}${x.count > 1 ? '*' + x.count : ''}`), ...c.checks.map(x => 'has? ' + x.object), c.skillPoints ? `sp ${c.skillPoints}` : '', c.credits ? `cr ${c.credits}` : ''].filter(Boolean))])));
      rows += `| ${cells.join(' | ')} |\n`;
    }
    await emit(`${id}-conversations.md`, `| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows}`);
    const group = list2 => { const by = new Map(); for (const c of list2) { const k = c.owner || '-'; if (!by.has(k)) by.set(k, []); by.get(k).push(c.name); } return [...by].map(([k, v]) => `${k}: ${v.join(' ')}`).join('; '); };
    await emit(`${id}-conversations-rest.md`, [
      `Conversations that only wait for a flag or check one, and change no state (${gated.length}; \`?\` = a \`CheckFlag\` event): ${gated.join(', ') || 'none'}.`,
      `Plain InfoLinks, no flag and no event: ${plain.DL.length} (listed with their starters in the InfoLink table).`,
      `Plain conversations with an actor (${plain.talk.length}): ${group(plain.talk) || 'none'}.`,
      `Plain overheard conversations (${plain.ovh.length}): ${group(plain.ovh) || 'none'}.`].join('\n\n') + '\n');
    // InfoLinks and what starts them
    let dt = '| InfoLink | Started by | Needs | Sets / does |\n| --- | --- | --- | --- |\n';
    for (const c of own.filter(c => c.datalink)) {
      const key = c.name.toLowerCase(), starters = [];
      for (const m of mm) {
        for (const t of m.dataLinkTriggers) if (String(t.datalink).toLowerCase() === key) starters.push(`${short(m.map)}/${t.name} (${(t.at ?? []).slice(0, 2).join(',')})${t.checkFlag ? ` needs ${t.checkFalse ? '!' : ''}${t.checkFlag}` : ''}`);
        for (const t of m.conversationTriggers) if (String(t.conversation).toLowerCase() === key) starters.push(`ConversationTrigger ${short(m.map)}/${t.name}`);
      }
      for (const [name, lines] of Object.entries(scriptText)) if (MISSION_OF_SCRIPT[name] === mission) lines.forEach((l, i) => { if (!l.trim().startsWith('//') && l.toLowerCase().includes('"' + key + '"')) starters.push(`${name}.uc:${i + 1}`); });
      for (const o of list.conversations) if (!common.has(o.name)) for (const j of o.jumps) if (j.con && j.con.toLowerCase() === key && o.name !== c.name) { starters.push(`jump from ${o.name}`); break; }
      const needs = [...c.required.map(f => flagText(f)), ...c.checkFlags.map(f => flagText(f))];
      const does = [...c.setFlags.map(f => `set ${f.flag}${f.value ? '' : '=0'}`), ...c.goals.map(g => `${g.completed ? 'done' : '+goal'} ${g.name}`), ...c.triggers.map(x => 'trig ' + x.tag), ...c.transfers.map(x => `${x.to === 'JCDenton' ? 'give' : 'take'} ${x.object}`), c.skillPoints ? 'sp ' + c.skillPoints : ''].filter(Boolean);
      dt += `| \`${c.name}\` | ${esc(cap([...new Set(starters)], 160) || '(none found)')} | ${esc(cap([...new Set(needs)], 120))} | ${esc(cap([...new Set(does)], 160))} |\n`;
    }
    await emit(`${id}-datalinks.md`, dt);
    // choices: each choice, the block its speech jumps to, and what that block (and the blocks it jumps to) does
    let ct = '| Conversation | Owner | Choice | Effects of the branch |\n| --- | --- | --- | --- |\n';
    for (const c of own.filter(c => c.choices.length)) {
      const effectsOf = start => {
        const seen = new Set(), eff = [];
        const visit = label => {
          if (seen.has(label.toLowerCase()) || seen.size > 12) return; seen.add(label.toLowerCase());
          for (const f of c.setFlags.filter(x => x.branch.toLowerCase() === label.toLowerCase())) eff.push(`set ${f.flag}${f.value ? '' : '=0'}`);
          for (const x of c.transfers.filter(x => x.branch.toLowerCase() === label.toLowerCase())) eff.push(`${x.to === 'JCDenton' ? 'give' : x.from === 'JCDenton' ? 'take' : 'move'} ${x.object}`);
          for (const g of c.goals.filter(x => x.branch.toLowerCase() === label.toLowerCase())) eff.push(`${g.completed ? 'done' : '+goal'} ${g.name}`);
          for (const x of c.triggers.filter(x => x.branch.toLowerCase() === label.toLowerCase())) eff.push(`trig ${x.tag}`);
          for (const j of c.jumps.filter(x => x.branch.toLowerCase() === label.toLowerCase() && (!x.con || x.con.toLowerCase() === c.name.toLowerCase()))) visit(j.label);
        };
        visit(start); return [...new Set(eff)];
      };
      let quiet = 0;
      for (const ch of c.choices) {
        const jump = c.jumps.find(j => j.branch.toLowerCase() === ch.label.toLowerCase());
        const eff = jump ? effectsOf(jump.label) : [];
        if (jump && !eff.length) { quiet++; continue; }
        // the choice is named by its branch label: the game's dialogue text stays out of the docs (AGENTS.md: extracted original text outside Git)
        ct += `| \`${c.name}\` | ${esc(c.owner)} | \`${esc(jump?.label ?? ch.label)}\`${ch.skill ? ` [needs ${ch.skill} ${ch.skillLevel}]` : ''}${ch.flag ? ` [needs ${ch.flag.map(flagText).join(', ')}]` : ''} | ${esc(jump ? `-> ${jump.label}: ` + (eff.join(', ') || 'no state change') : '(no jump found)')} |\n`;
      }
      if (quiet) ct += `| \`${c.name}\` | ${esc(c.owner)} | (${quiet} further choice${quiet > 1 ? 's' : ''} that change no state) | - |\n`;
    }
    await emit(`${id}-choices.md`, ct);
    // counts
    const dl = own.filter(c => c.datalink), talk = own.filter(c => !c.datalink && !(c.firstPerson && c.nonInteractive)), ovh = own.filter(c => !c.datalink && c.firstPerson && c.nonInteractive);
    const counts = { total: own.length, datalinks: dl.length, talk: talk.length, overheard: ovh.length, withChoices: own.filter(c => c.choices.length).length, setFlags: own.filter(c => c.setFlags.length).length,
      requireFlags: own.filter(c => c.required.length).length, goalConvs: own.filter(c => c.goals.length).length, transfers: own.filter(c => c.transfers.length || c.checks.length).length, triggers: own.filter(c => c.triggers.length).length, barkNamed: own.filter(c => c.bark).length };
    counts.maps = mm.filter(Boolean).length;
    counts.choiceRows = own.reduce((n, c) => n + c.choices.length, 0);
    // goals
    const goals = new Map();
    for (const c of own) for (const g of c.goals) {
      const k = g.name.toLowerCase();
      if (!goals.has(k)) goals.set(k, { name: g.name, text: '', primary: false, adds: [], completes: [] });
      const r = goals.get(k);
      if (g.completed) r.completes.push(c.name); else { r.adds.push(c.name); r.text ||= g.text; r.primary ||= g.primary; }
    }
    for (const s of Object.values(scriptsData)) if (s.mission === mission) for (const f of s.functions) for (const op of f.ops) if (op.kind === 'goal-complete') {
      const k = op.arg.toLowerCase(); if (!goals.has(k)) goals.set(k, { name: op.arg, text: '', primary: false, adds: [], completes: [] });
      goals.get(k).completes.push(`${s.name}.${f.name}:${op.line}`);
    }
    for (const m of mm) for (const g of m.goalTriggers ?? []) { const k = String(g.goal).toLowerCase(); if (!goals.has(k)) goals.set(k, { name: g.goal, text: '', primary: false, adds: [], completes: [] }); goals.get(k).completes.push(`${m.map}/${g.name}`); }
    // goals by name only: the goal's text is the game's (outside Git)
    let gt = '| Goal | Kind | Added by | Completed by |\n| --- | --- | --- | --- |\n';
    for (const g of [...goals.values()]) gt += `| \`${g.name}\` | ${g.adds.length ? (g.primary ? 'primary' : 'secondary') : 'carried'} | ${esc([...new Set(g.adds)].join(', ') || '-')} | ${esc([...new Set(g.completes)].join(', ') || '-')} |\n`;
    await emit(`${id}-goals.md`, gt);
    // exits
    let et = '| Map | Actor | At | Leads to | Fired by (events targeting its tag) |\n| --- | --- | --- | --- | --- |\n';
    for (const m of mm) {
      const items = [...m.exits.map(e => ({ ...e, dest: e.dest })), ...m.teleporters.filter(t => t.url && missionOfMapAll.get(mapKey(t.url)) !== mission).map(t => ({ ...t, dest: t.url }))];
      for (const e of items) {
        const by = (m.eventSources ?? []).filter(x => e.tag && x.event.toLowerCase() === e.tag.toLowerCase()).map(x => `${x.class} ${x.name}`);
        if (e.tag && e.class === 'MapExit') { for (const c of convTriggersOf(id).get(e.tag.toLowerCase()) ?? []) by.push('conversation ' + c); for (const r of scriptRefs(e.tag, mission)) by.push('script ' + r); }
        et += `| \`${m.map}\` | ${e.class} \`${e.name}\` | ${(e.at ?? []).join(',')} | \`${esc(e.dest)}\`${e.transition ? ` (path \`${e.cameraPath}\`)` : ''} | ${esc(e.class === 'Teleporter' ? `touch${e.tag ? ' (portal \`' + e.tag + '\`)' : ''}` : e.tag ? `tag \`${e.tag}\`${by.length ? ': ' + [...new Set(by)].join(', ') : ' (no source found)'}` : 'touch')} |\n`;
      }
    }
    await emit(`${id}-exits.md`, et);
    let ch = '';
    for (const m of mm) for (const e of m.exits) {
      if (!e.dest) continue;
      ch += `**${m.map} ${e.name} -> ${clean(e.dest)}**${e.tag ? ' (tag \`' + e.tag + '\`)' : ''}\n\n`;
      if (!e.tag) { ch += 'Touch only: no event source in the data; what keeps the player from the actor is geometry (doors, locks) and is not read here.\n\n'; continue; }
      ch += '```text\n' + await chainText(m.map, e.tag, 6) + '\n```\n\n';
    }
    await emit(`${id}-chains.md`, ch);
    // gates: movers that start locked, need a key that exists, or are fired by something other than a frob
    let gt2 = '| Map | Tag (movers) | Lock | Opened by |\n| --- | --- | --- | --- |\n', skippedPickable = 0; const keyDoors = new Map();
    const keyIds = new Set(Object.values(mapsData).flatMap(m => m.keys.map(k => String(k.keyId).toLowerCase())));
    for (const m of mm) {
      const groups = new Map();
      for (const d of m.doors) { const k = d.tag || d.name; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
      for (const [tag, doors] of groups) {
        const sources = (m.eventSources ?? []).filter(x => doors[0].tag && x.event.toLowerCase() === doors[0].tag.toLowerCase()).map(x => `${x.class} ${x.name}`);
        if (doors[0].tag) { for (const c of convTriggersOf(id).get(doors[0].tag.toLowerCase()) ?? []) sources.push('conversation ' + c); for (const r of scriptRefs(doors[0].tag, mission)) sources.push('script ' + r); }
        const d0 = doors[0], keyed = d0.key && keyIds.has(String(d0.key).toLowerCase());
        if (!sources.length && keyed && d0.frobbable && d0.pickable) { keyDoors.set(d0.key, (keyDoors.get(d0.key) ?? 0) + doors.length); continue; }
        if (!keyed && !sources.length && !(d0.locked && !d0.pickable)) { if (d0.locked) skippedPickable += doors.length; continue; }
        const lock = [d0.locked ? 'locked' : 'unlocked', keyed ? `key ${d0.key}` : '', d0.pickable ? `pick ${(d0.lockStrength ?? 0).toFixed(2)}` : '', d0.breakable ? `breakable ${(d0.doorStrength ?? 0).toFixed(2)}` : '', d0.frobbable ? '' : 'not frobbable'].filter(Boolean).join(', ');
        gt2 += `| \`${m.map}\` | \`${tag}\` (${doors.length}) | ${lock} | ${esc([...new Set(sources)].slice(0, 6).join(', ') || (d0.frobbable ? 'frob' : '(nothing found)'))} |\n`;
      }
    }
    await emit(`${id}-gates.md`, gt2 + (keyDoors.size ? `\nKey doors (a placed \`NanoKey\` opens them, or the lock is picked; frob only): ${[...keyDoors].map(([k, n]) => `\`${k}\`${n > 1 ? ' x' + n : ''}`).join(', ')}.\n` : '') + `\n(${skippedPickable} further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed \`NanoKey\` and are fired by no event: not listed.)\n`);
    // lasting flags: set in this mission and still alive in a later one; read here and set earlier
    const carriedRows = flagRows.filter(r => carriedFlags.includes(r.flag));
    const short2 = r => `M${r.mission} ${r.kind === 'conversation-checks' ? 'checks in' : r.kind === 'conversation-requires' ? 'needed by' : r.kind === 'choice-requires' ? 'choice in' : r.kind} ${r.where}`;
    let lt = '| Flag | Set here by | Expires | Read later by |\n| --- | --- | --- | --- |\n', rt = '| Flag | Set earlier by | Read here by |\n| --- | --- | --- |\n';
    for (const r of carriedRows) {
      const setHere = r.setters.filter(x => x.mission === mission && r.lasting.some(l => l.set === x || (l.set.where === x.where && l.set.mission === x.mission)));
      if (setHere.length) {
        const later = r.lasting.filter(l => l.set.mission === mission && !new Set(r.setters.map(x => x.mission)).has(l.read.mission)).map(l => l.read);
        lt += `| \`${r.flag}\` | ${esc([...new Set(setHere.map(x => `${x.kind} ${x.where}${x.branch && x.branch !== '(main)' ? '@' + x.branch : ''}${x.value === false ? ' (=0)' : ''}`))].join('; '))} | ${[...new Set(setHere.map(x => x.expiration === 0 ? 'never' : 'mission ' + x.expiration))].join('; ')} | ${esc([...new Set(later.map(short2))].slice(0, 5).join('; '))}${new Set(later.map(short2)).size > 5 ? '; ...' : ''} |\n`;
      }
      const readHere = r.lasting.filter(l => l.read.mission === mission && l.set.mission < mission && !r.setters.some(x => x.mission === mission));
      if (readHere.length) rt += `| \`${r.flag}\` | ${esc([...new Set(readHere.map(l => `M${l.set.mission} ${l.set.kind} ${l.set.where}${l.set.branch && l.set.branch !== '(main)' ? '@' + l.set.branch : ''}`))].slice(0, 3).join('; '))} | ${esc([...new Set(readHere.map(l => `${l.read.kind === 'conversation-checks' ? 'checks in' : l.read.kind === 'conversation-requires' ? 'needed by' : l.read.kind} ${l.read.where}`))].slice(0, 6).join('; '))} |\n`;
    }
    await emit(`${id}-lasting-set.md`, lt);
    await emit(`${id}-lasting-read.md`, rt);
    counts.carriedSet = lt.split('\n').length - 3;
    counts.carriedRead = rt.split('\n').length - 3;
    // slots
    const here = slotRows.filter(s => s.mission === mission);
    await emit(`${id}-slots.json`, JSON.stringify(here.map(s => `${s.source === 'nicouzouf' ? 'N' : 'R'}${s.slot.slice(4)}`)));
    let st = '| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |\n| --- | --- | --- | --- | --- | --- | --- |\n';
    for (const sl of here) {
      const fl = new Map(sl.flags.map(f => [f.flag.toLowerCase(), f]));
      const prev = null;                       // cumulative: a slot is a start point, so its whole state is listed
      const prevFlags = new Map((prev?.flags ?? []).map(f => [f.flag.toLowerCase(), f]));
      const isNew = f => !prevFlags.has(f.flag.toLowerCase()) || prevFlags.get(f.flag.toLowerCase()).value !== f.value;
      const dead = sl.flags.filter(f => /_Dead$/.test(f.flag) && f.value && isNew(f)).map(f => f.flag.replace(/_Dead$/, ''));
      const ko = sl.flags.filter(f => /_Unconscious$/.test(f.flag) && f.value && isNew(f)).map(f => f.flag.replace(/_Unconscious$/, ''));
      const chosen = carriedFlags.filter(f => fl.has(f.toLowerCase()) && (!prev || isNew(fl.get(f.toLowerCase())))).map(f => fl.get(f.toLowerCase()).value ? f : f + '=0');
      const open = sl.goals.filter(g => !g.completed).map(g => g.name);
      const mins = Math.round(sl.saveTime / 60);
      st += `| ${sl.source === 'nicouzouf' ? 'N' : 'R'}${sl.slot.slice(4)} | \`${sl.map}\` | ${esc(sl.description)} | ${sl.saveCount}, ${mins} min | ${esc(dead.join(', ') || '-')}${ko.length ? esc('; knocked out: ' + ko.join(', ')) : ''} | ${esc(chosen.join(', ') || '-')} | ${esc(open.slice(0, 5).join(', ') || '-')}${open.length > 5 ? ', ...' : ''} |\n`;
    }
    await emit(`${id}-slots.md`, st);
    counts.slots = here.length;
    counts.importantPawns = new Set(mm.filter(Boolean).flatMap(m => m.pawns.filter(x => x.important && x.bind && x.bind.toLowerCase() !== 'none').map(x => x.bind.toLowerCase()))).size;
    counts.goals = goals.size;
    await emit(`${id}-counts.json`, JSON.stringify(counts));
  }
  // ---- global fragments
  const missionOfMap = new Map(Object.values(mapsData).map(m => [m.map.toLowerCase(), m.level?.missionNumber ?? null]));
  let ov = '| Mission | Maps | Location (`MissionLocation`) | Script | Arrives from | Leaves to | Real slots |\n| --- | --- | --- | --- | --- | --- | --- |\n';
  const groupsDef = [['00', 0], ['01', 1], ['02', 2], ['03', 3], ['04', 4], ['05', 5], ['06', 6], ['08', 8], ['09', 9], ['10', 10], ['11', 11], ['12', 12], ['14', 14], ['15', 15], ['98', 98], ['99', 99]];
  for (const [id, n] of groupsDef) {
    const mm = Object.values(mapsData).filter(m => m.level?.missionNumber === n && !/^(DX|DXOnly|Entry)$/i.test(m.map));
    const inbound = [...new Set(edges.filter(e => mm.some(m => m.map.toLowerCase() === e.dest) && missionOfMap.get(e.from.toLowerCase()) !== n).map(e => `${e.from}${e.portal ? '#' + e.portal : ''}`))];
    const real = lower => Object.values(mapsData).find(m => m.map.toLowerCase() === lower)?.map ?? lower;
    const outbound = [...new Set(edges.filter(e => mm.some(m => m.map === e.from) && missionOfMap.get(e.dest) !== n).map(e => `${real(e.dest)}${e.portal ? '#' + e.portal : ''}`))];
    ov += `| ${id === '00' ? '0 (Training)' : id === '98' ? '98 (Intro)' : id === '99' ? '99 (Endgames)' : Number(id)} | ${mm.map(m => short(m.map)).join(', ')} | ${esc([...new Set(mm.map(m => m.level?.location))].join('; '))} | ${[...new Set(mm.map(m => m.level?.scriptClass ?? '(none)'))].join(', ')} | ${esc(inbound.join('; ') || (id === '00' ? 'the menu: Training button' : id === '01' ? 'New Game (the intro, then StartNewGame)' : id === '98' ? 'the menu: New Game or Intro' : '-'))} | ${esc(outbound.join('; ') || '-')} | ${slotRows.filter(x => x.mission === n).length} |\n`;
  }
  await emit('overview.md', ov);
  let sl = '| Slot | Mission | Map | Saved as | Saves | Play time | Level files in the slot | Flags in the file | Open goals |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
  for (const x of slotRows) sl += `| ${x.source === 'nicouzouf' ? 'N' : 'R'}${x.slot.slice(4)} | ${x.mission} | \`${x.map}\` | ${esc(x.description)} | ${x.saveCount} | ${Math.round(x.saveTime / 60)} min | ${x.levels.length} | ${x.flags.length} | ${x.goals.filter(g => !g.completed).length} |\n`;
  await emit('slots-all.md', sl);
  // who can die: important pawns by BindName
  const people = new Map();
  for (const m of Object.values(mapsData)) for (const x of m.pawns) if (x.important && x.bind && x.bind.toLowerCase() !== 'none') {
    const k = x.bind.toLowerCase(); if (!people.has(k)) people.set(k, { bind: x.bind, classes: new Set(), maps: new Map() });
    const r = people.get(k); r.classes.add(x.class); const mn = m.level?.missionNumber ?? 'no level info'; if (!r.maps.has(mn)) r.maps.set(mn, new Set()); r.maps.get(mn).add(short(m.map));
  }
  let dt2 = '| BindName | Class | Important in (mission: maps) | Other places the flag is read |\n| --- | --- | --- | --- |\n';
  for (const r of [...people.values()].sort((a, b) => Math.min(...[...a.maps.keys()].filter(Number.isFinite)) - Math.min(...[...b.maps.keys()].filter(Number.isFinite)) || a.bind.localeCompare(b.bind))) {
    const row = flagRows.find(f => f.flag.toLowerCase() === (r.bind + '_Dead').toLowerCase());
    const others = (row?.readers ?? []).filter(x => x.kind !== 'firstframe-destroy').map(x => `M${x.mission} ${x.kind.replace('conversation-', '')} ${x.where}`);
    dt2 += `| ${r.bind} | ${[...r.classes].join('/')} | ${esc([...r.maps].sort((a, b) => (Number.isFinite(a[0]) ? a[0] : 999) - (Number.isFinite(b[0]) ? b[0] : 999)).map(([mn, ms]) => `${mn}: ${[...ms].join(', ')}`).join('; '))} | ${esc(cap([...new Set(others)], 200) || '-')} |\n`;
  }
  await emit('deaths.md', dt2);
  let cr = '| Flag | Set by | Expires | Read later by |\n| --- | --- | --- | --- |\n';
  for (const r of flagRows.filter(r => carriedFlags.includes(r.flag))) {
    const sets = r.lasting.map(l => l.set), reads = r.lasting.filter(l => !new Set(r.setters.map(x => x.mission)).has(l.read.mission)).map(l => l.read);
    cr += `| \`${r.flag}\` | ${esc(cap([...new Set(sets.map(x => `M${x.mission} ${x.kind} ${x.where}${x.branch && x.branch !== '(main)' ? '@' + x.branch : ''}${x.value === false ? ' (=0)' : ''}`))], 240))} | ${[...new Set(sets.map(x => x.expiration === 0 ? 'never' : 'mission ' + x.expiration))].join('; ')} | ${esc(cap([...new Set(reads.map(x => `M${x.mission} ${x.kind === 'conversation-checks' ? 'checks in' : x.kind === 'conversation-requires' ? 'needed by' : x.kind} ${x.where}`))], 300))} |\n`;
  }
  await emit('carried.md', cr);
  let un = '| Flag | Read by (mission, kind, place) |\n| --- | --- |\n';
  const unset = flagRows.filter(r => !r.setters.length && r.readers.length);
  for (const r of unset) un += `| \`${r.flag}\` | ${esc(cap([...new Set(r.readers.map(x => `M${x.mission} ${x.kind.replace('conversation-', '').replace('-', ' ')} ${x.where}`))], 240))} |\n`;
  await emit('unset-flags.md', un);
  await emit('unset-flags.json', JSON.stringify(unset.map(r => r.flag)));
  console.log('fragments in', outDir);
}

// ---- chain -----------------------------------------------------------------------------------------------------------------------------------
/** `chain <map> <tag>`: what fires an event tag in a map, upstream: the actors whose Event/OutEvents name it, the conversations whose Trigger event names it (the mission's own list), the mission
 * script's literal mentions, and for each conversation how it starts (DataLinkTrigger, ConversationTrigger, the script's StartDataLinkTransmission, or its actor's invoke mode) and which flags it needs with
 * the places that set them. An AND/OR graph read off the data: the flags of one conversation are ANDed, the setters of one flag are alternatives. */
let chainData = null;
async function chainText(mapName, tag, depthArg) {
  chainData ??= { conv: await read('conversations.json'), mapsData: await read('maps.json'), scriptsData: await read('scripts.json'), flagRows: await read('flags.json') };
  const { conv, mapsData, flagRows } = chainData;
  const m = Object.values(mapsData).find(x => x.map.toLowerCase() === String(mapName).toLowerCase());
  if (!m) throw new Error('no such map ' + mapName);
  const mission = m.level?.missionNumber;
  const listId = String(mission).padStart(2, '0');
  const common = new Set(conv['16'].conversations.map(c => c.name));
  const list = (conv[listId]?.conversations ?? []).filter(c => !common.has(c.name));
  const byName = new Map(list.map(c => [c.name.toLowerCase(), c]));
  const scriptName = Object.entries(MISSION_OF_SCRIPT).find(([, n]) => n === mission)?.[0];
  const scriptLines = scriptName ? (await readFile(path.join(SOURCE_ROOT, 'DeusEx', `${scriptName}.uc`), 'utf8')).split(/\r?\n/) : [];
  const flagIndex = new Map(flagRows.map(f => [f.flag.toLowerCase(), f]));
  const maxDepth = Number(depthArg ?? 5);
  const seenFlags = new Set(), seenTags = new Set(), seenConvs = new Set();
  const out = [];
  const say = (depth, text) => out.push(`${'  '.repeat(depth)}${text}`);
  const flagLine = (depth, f, want) => {
    const key = f.toLowerCase();
    const row = flagIndex.get(key);
    const sets = (row?.setters ?? []).filter(s => s.mission === mission && s.kind !== 'played').map(s => `${s.kind} ${s.where}${s.branch && s.branch !== '(main)' ? '@' + s.branch : ''}${s.value === false ? ' (=false)' : ''}`);
    const played = /_played$/i.test(f) ? ` (set when conversation ${f.replace(/_played$/i, '')} ends)` : '';
    say(depth, `flag ${want === false ? '!' : ''}${f}${played}: ${sets.length ? 'set by ' + sets.slice(0, 6).join('; ') + (sets.length > 6 ? '; ...' : '') : (/_played$/i.test(f) ? '' : 'no setter in this mission')}`);
    if (seenFlags.has(key) || depth >= maxDepth) return;
    seenFlags.add(key);
    for (const s of (row?.setters ?? []).filter(s => s.mission === mission && s.kind === 'conversation')) {
      const c = byName.get(String(s.where).toLowerCase()); if (c) conversationLine(depth + 1, c);
    }
    for (const st of (row?.setters ?? []).filter(x => x.mission === mission && x.kind === 'trigger')) {
      const [tm, tn] = String(st.where).split('/'), tt = (mapsData[tm]?.flagTriggers ?? []).find(x => x.name === tn);
      if (tt && tt.tag && !seenTags.has(tt.tag.toLowerCase())) tagLine(depth + 1, tt.tag, mapsData[tm]);
    }
    const pm = /^(.*)_played$/i.exec(f);
    if (pm && byName.get(pm[1].toLowerCase())) conversationLine(depth + 1, byName.get(pm[1].toLowerCase()));
  };
  const conversationLine = (depth, c) => {
    const key = c.name.toLowerCase();
    say(depth, `conversation ${c.name} [${kindOf(c)}${c.invoke.length ? ' ' + c.invoke.join('/') : ''}; owner ${c.owner}]${seenConvs.has(key) ? ' (seen above)' : ''}`);
    if (seenConvs.has(key) || depth >= maxDepth) return;
    seenConvs.add(key);
    const starters = [];
    for (const x of Object.values(mapsData).filter(x => x.level?.missionNumber === mission)) {
      for (const t of x.dataLinkTriggers) if (String(t.datalink).toLowerCase() === key) starters.push(`DataLinkTrigger ${x.map}/${t.name}${t.checkFlag ? ` needs ${t.checkFalse ? '!' : ''}${t.checkFlag}` : ''}${t.event ? ' event ' + t.event : ''}`);
      for (const t of x.conversationTriggers) if (String(t.conversation).toLowerCase() === key) starters.push(`ConversationTrigger ${x.map}/${t.name}${t.checkFlag ? ` needs ${t.checkFalse ? '!' : ''}${t.checkFlag}` : ''}`);
    }
    scriptLines.forEach((l, i) => { if (!l.trim().startsWith('//') && (l.toLowerCase().includes(`"${key}"`) || l.toLowerCase().includes(`'${key}'`))) starters.push(`${scriptName}.uc:${i + 1}`); });
    const jumpers = list.filter(o => o.name !== c.name && o.jumps.some(j => j.con && j.con.toLowerCase() === key));
    for (const o of jumpers) starters.push(`jump from ${o.name}`);
    if (!c.invoke.length && !c.datalink && !starters.length) starters.push('(no invoke flag and nothing starts it by name in the data)');
    else if (c.invoke.length && !c.datalink) starters.push(`its actor (${c.invoke.join('/')})`);
    say(depth + 1, `starts: ${starters.join('; ') || '(no starter found in the mission data)'}`);
    for (const o of jumpers) conversationLine(depth + 2, o);
    for (const r of c.required) flagLine(depth + 1, r.flag, r.value);
    for (const s of starters) { const mm = / needs (!?)(\w+)/.exec(s); if (mm) flagLine(depth + 1, mm[2], mm[1] ? false : true); }
  };
  const tagLine = (depth, t, mp = m) => {
    const key = t.toLowerCase();
    say(depth, `event ${t}${seenTags.has(key) ? ' (seen above)' : ''}`);
    if (seenTags.has(key) || depth >= maxDepth) return;
    seenTags.add(key);
    if (mp !== m) say(depth + 1, `(in ${mp.map})`);
    const src = (mp.eventSources ?? []).filter(x => x.event.toLowerCase() === key);
    for (const s of src) {
      say(depth + 1, `${s.class} ${s.name} (${s.via})${s.tag ? ` tag ${s.tag}` : ''}`);
      const fl = mp.flagTriggers.find(x => x.name === s.name);
      if (fl) say(depth + 2, `FlagTrigger flag ${fl.flag}${fl.trigger ? ' (needs ' + fl.value + ')' : ''}${fl.set ? ' (sets)' : ''}`);
      if (s.tag) tagLine(depth + 2, s.tag, mp);
    }
    for (const c of list) for (const x of c.triggers) if (x.tag.toLowerCase() === key) { say(depth + 1, `conversation event Trigger "${x.tag}" in ${c.name}${x.branch !== '(main)' ? ' branch ' + x.branch : ''}`); conversationLine(depth + 2, c); }
    scriptLines.forEach((l, i) => { if (!l.trim().startsWith('//') && l.toLowerCase().includes(`'${key}'`)) say(depth + 1, `${scriptName}.uc:${i + 1}: ${l.trim()}`); });
  };
  tagLine(0, tag);
  return out.join('\n');
}
async function chain() { const [mapName, tag, depthArg] = process.argv.slice(3); console.log(await chainText(mapName, tag, depthArg)); }

const steps = { conversations, maps, scripts, flags, slots, report };
if (step === 'chain') { await chain(); process.exit(0); }
if (step !== 'all' && !steps[step]) { console.error('usage: inventory-campaign.mjs conversations|maps|scripts|flags|slots|report|chain|all'); process.exit(2); }
for (const name of step === 'all' ? Object.keys(steps) : [step]) await steps[name]();
