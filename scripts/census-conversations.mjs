#!/usr/bin/env node
/** Stage 6, rows 6.4.*.3: the conversation census. Every own conversation and InfoLink of each mission's list (ConList_MissionNN of DeusExConText.u, less the
 * 384 shared AI barks of ConList_Mission16) is started in Play the way the original starts it and run to its end; a stop is named, not hidden.
 *
 *   node scripts/census-conversations.mjs [--missions 00,01] [--maps 00_Training,...] [--only Name,Name] [--jobs 2] [--frame 0.0333] [--out file] [--list]
 *   node scripts/census-conversations.mjs --child <map> [--only ...] [--frame s]       one Play process, one map (the parent spawns these)
 *
 * The plan (parent): the campaign inventory (scripts/inventory-campaign.mjs, `.work/campaign-inventory`, regenerated when missing) gives, per own
 * conversation, its owner (BindName), kind, invocation flags, required flags and speakers, and per mission map the actors that carry those BindNames, the
 * DataLinkTriggers and ConversationTriggers by tag, and the mission script's StartDataLinkTransmission calls. Each conversation is assigned to the first map
 * of its mission where its starter exists (the trigger; the owner and all its speakers; else the mission script's map).
 *
 * The start (child, one session per map, the map opened cold, `game.reset()` after a stop): the harness steps are labelled in the result's `via`:
 *   InfoLink      the DataLinkTrigger by the player's own movement (placed inside its cylinder and walked, as the Stage 5 DataLink drivers do), else the
 *                 trigger's Touch/Trigger event; a mission-script InfoLink the script call StartDataLinkTransmission, which is what the script does.
 *   talk, bump/frob   the owner's Frob through the view trace and `game.use` (the player's right button), else the pawn's Frob event.
 *   talk, radius      the player placed inside the invocation radius; ScriptedPawn.Tick's own StartConversation(Self, IM_Radius) starts it.
 *   named only (no invocation flag, a bark, a sight-only conversation: nothing in the original starts these but a script or trigger by name)
 *                 the ConversationTrigger by touch where the map has one, else StartConversationByName, which is what a script/trigger calls.
 * The flags the conversation needs (its flagRefList) are set through the FlagBase natives, the conversations before it in the owner's chain are put out of
 * the way by their own conditions (`_Played` of a once conversation, one required flag of the others), and the player is placed: all harness steps.
 * The run: a third-person conversation is advanced by Enter every half second (the first option of a choice; a choice seen again takes the next one so
 * that menus end); a first-person one and an InfoLink play to their ends with no input. Result per conversation: started, ended, the events reached, the
 * time, the choices that exist, and any stop by name. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';
import { MISSIONS } from './stage6-criteria.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const INV = path.join(REPO, '.work', 'campaign-inventory');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(`--${name}`);
const lower = s => String(s ?? '').toLowerCase();

// =================================================================================================================================================
// the plan
// =================================================================================================================================================
async function inventory() {
  for (const step of ['conversations', 'maps', 'scripts'])
    if (!existsSync(path.join(INV, `${step}.json`))) {
      const run = spawnSync(process.execPath, [path.join(HERE, 'inventory-campaign.mjs'), step], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
      if (run.status !== 0) throw new Error(`inventory-campaign ${step} failed: ${(run.stderr ?? '').slice(-400)}`);
    }
  const load = async name => JSON.parse(await readFile(path.join(INV, `${name}.json`), 'utf8'));
  return { conv: await load('conversations'), maps: await load('maps'), scripts: await load('scripts') };
}

export async function buildPlan({ missions = MISSIONS } = {}) {
  const { conv, maps, scripts } = await inventory();
  const common = new Set(conv['16'].conversations.map(c => c.name));
  const sourceRoot = process.env.DX_RESEARCH_SRC ?? [path.join(REPO, '.cache/research/src'), '/home/rydgel/projects/deus_ex_web/.cache/research/src'].find(existsSync);
  const scriptText = {};
  const textOf = async name => scriptText[name] ??= sourceRoot ? (await readFile(path.join(sourceRoot, 'DeusEx', `${name}.uc`), 'utf8')).split(/\r?\n/) : [];
  const items = [];
  for (const id of missions) {
    const list = conv[id];
    const mission = Number(id);
    const mm = Object.values(maps).filter(m => (m.level?.missionNumber ?? -9) === mission && !/^(DX|DXOnly|Entry)$/i.test(m.map)).sort((a, b) => a.map.localeCompare(b.map));
    const scriptName = `Mission${id}`;
    const binds = new Map(mm.map(m => [m.map, new Set([...m.pawns.map(p => lower(p.bind)), ...m.boundActors.map(p => lower(p.bind))].filter(Boolean))]));
    const scriptOps = (scripts[scriptName]?.functions ?? []).flatMap(f => f.ops.filter(o => o.kind === 'datalink' || o.kind === 'conversation').map(o => ({ ...o, fn: f.name })));
    const own = list.conversations.filter(c => !common.has(c.name));
    for (const [position, c] of own.entries()) {
      const radius = Number((c.invoke.find(x => x.startsWith('radius')) ?? '').split(' ')[1] ?? 0);
      const item = {
        mission: id, name: c.name, listIndex: position, kind: c.datalink ? 'DL' : (c.firstPerson && c.nonInteractive) ? 'ovh' : 'talk', owner: c.owner,
        bark: c.bark, once: c.once, firstPerson: c.firstPerson, nonInteractive: c.nonInteractive,
        frob: c.invoke.includes('frob') || c.invoke.includes('bump'), radius: c.invoke.some(x => x.startsWith('radius')) ? radius : null, sight: c.invoke.includes('sight'),
        required: c.required.map(f => ({ flag: f.flag, value: f.value })), speakers: c.speakers.filter(s => s !== 'JCDenton'), choices: c.choices.length, events: c.events,
        map: null, starter: null, predicted: [],
      };
      const lname = lower(c.name);
      if (item.kind === 'DL') {
        let found = null;
        for (const m of mm) {
          const t = m.dataLinkTriggers.filter(t => lower(t.datalink) === lname);
          if (t.length) { found = { type: 'trigger', map: m.map, actors: t.map(x => ({ name: x.name, at: x.at, checkFlag: x.checkFlag, checkFalse: x.checkFalse })) }; break; }
        }
        if (!found) for (const m of mm) {
          const t = m.conversationTriggers.filter(t => lower(t.conversation) === lname);
          if (t.length) { found = { type: 'conversation-trigger', map: m.map, actors: t.map(x => ({ name: x.name, at: x.at, checkFlag: x.checkFlag, checkFalse: x.checkFalse, bindName: x.bindName })) }; break; }
        }
        if (!found) {
          const op = scriptOps.find(o => o.kind === 'datalink' && lower(o.arg) === lname);
          if (op) {
            // the map: the nearest localURL test above the call in the script
            const text = await textOf(scriptName);
            let hint = null;
            for (let i = op.line - 1; i >= 0 && !hint; i--) { const m = /localURL\s*==\s*"([^"]+)"/i.exec(text[i] ?? ''); if (m) hint = m[1].toLowerCase(); }
            const map = mm.find(m => lower(m.map) === hint)?.map ?? mm[0]?.map ?? null;
            found = { type: 'script', map, script: `${scriptName}.${op.fn}:${op.line}`, hint };
          }
        }
        item.starter = found ?? { type: 'none', map: mm[0]?.map ?? null };
        item.map = item.starter.map;
      } else {
        // a conversation with an owner: the first map holding the owner and every speaker
        const owner = lower(c.owner);
        const needed = [owner, ...item.speakers.map(lower)];
        const holders = mm.filter(m => binds.get(m.map).has(owner));
        const complete = holders.find(m => needed.every(n => binds.get(m.map).has(n)));
        const chosen = complete ?? holders[0] ?? null;
        item.map = chosen?.map ?? null;
        if (!chosen) item.predicted.push('no actor carries the owner BindName in any map of the mission');
        else if (!complete) item.predicted.push(`speaker(s) without an actor in the owner's maps: ${needed.filter(n => !binds.get(chosen.map).has(n)).join(', ')}`);
        // the starter by name: a ConversationTrigger whose conversationTag is this conversation
        const t = mm.flatMap(m => m.conversationTriggers.filter(t => lower(t.conversation) === lname).map(t => ({ map: m.map, ...t })));
        if (t.length) item.starter = { type: 'conversation-trigger', map: t[0].map, actors: t.filter(x => x.map === t[0].map).map(x => ({ name: x.name, at: x.at, checkFlag: x.checkFlag, checkFalse: x.checkFalse, bindName: x.bindName })) };
        const op = scriptOps.find(o => o.kind === 'conversation' && lower(o.arg) === lname);
        if (op) item.scriptStart = `${scriptName}.${op.fn}:${op.line}`;
        if (!item.starter && item.map === null && t.length) item.map = t[0].map;
      }
      items.push(item);
    }
  }
  return items;
}

// =================================================================================================================================================
// the parent: one child per map
// =================================================================================================================================================
async function parent() {
  const wantedMissions = option('missions', null)?.split(',') ?? MISSIONS;
  const wantedMaps = option('maps', null)?.split(',').map(lower);
  const only = option('only', null)?.split(',').map(lower);
  const frame = option('frame', '0.0333');
  const jobs = Number(option('jobs', 2));
  const plan = (await buildPlan({ missions: wantedMissions })).filter(t => !only || only.includes(lower(t.name)));
  const byMap = new Map();
  const unassigned = [];
  for (const t of plan) { if (!t.map) { unassigned.push(t); continue; } if (!byMap.has(t.map)) byMap.set(t.map, []); byMap.get(t.map).push(t); }
  const maps = [...byMap.keys()].filter(m => !wantedMaps || wantedMaps.includes(lower(m))).sort();
  if (flag('list')) {
    for (const m of maps) console.log(`${m}\t${byMap.get(m).length}\t${byMap.get(m).map(t => t.kind).join(',').slice(0, 80)}`);
    console.log(`${plan.length} conversations, ${maps.length} maps, ${unassigned.length} without a map`);
    return;
  }
  const out = path.resolve(REPO, option('out', '.work/census-conversations.json'));
  await mkdir(path.dirname(out), { recursive: true });
  const results = unassigned.map(t => ({ ...brief(t), map: null, outcome: 'unbound', stop: { family: 'unbound', message: t.predicted.join('; ') } }));
  const timeout = Number(option('timeout', 5400)) * 1000;
  let next = 0, running = 0;
  const save = async () => writeFile(out, JSON.stringify({ at: new Date().toISOString(), frame: Number(frame), results }, null, 1));
  await new Promise(resolve => {
    const launch = () => {
      while (running < jobs && next < maps.length) {
        const map = maps[next++];
        running++;
        const started = Date.now();
        const args = ['--max-old-space-size=7168', fileURLToPath(import.meta.url), '--child', map, '--frame', frame];
        if (only) args.push('--only', only.join(','));
        const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
        let buffer = '', errors = '';
        const lines = [];
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.stdout.on('data', d => {
          buffer += d;
          let i;
          while ((i = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
            if (line.startsWith('{"census"')) { const r = JSON.parse(line).census; lines.push(r); console.log(`${r.outcome.padEnd(9)} ${map} ${r.name} ${r.stop ? `[${r.stop.family}] ${String(r.stop.message).slice(0, 110)}` : `${r.seconds}s ${r.events} events`}`); }
          }
        });
        child.stderr.on('data', d => { errors += d; if (errors.length > 4000) errors = errors.slice(-4000); });
        child.on('exit', async (code, signal) => {
          clearTimeout(timer);
          const have = new Set(lines.map(r => r.name));
          for (const t of byMap.get(map)) if (!have.has(t.name)) lines.push({ ...brief(t), map, outcome: 'process', stop: { family: 'process', message: `the child of ${map} ended (${signal ?? code}) before this conversation: ${errors.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}` } });
          results.push(...lines);
          running--;
          console.log(`-- ${map} done in ${Math.round((Date.now() - started) / 1000)} s (${lines.length} conversations)`);
          await save();
          launch();
          if (!running && next >= maps.length) resolve();
        });
      }
      if (!running && next >= maps.length) resolve();
    };
    launch();
  });
  await save();
  await writeFile(out.replace(/\.json$/, '-summary.txt'), summarize(results) + '\n');
}

const brief = t => ({ mission: t.mission, name: t.name, kind: t.kind, owner: t.owner, map: t.map, bark: t.bark });

export function summarize(results) {
  const out = [];
  const say = line => { out.push(line); console.log(line); };
  const count = (list, key) => list.reduce((m, r) => (m[key(r)] = (m[key(r)] ?? 0) + 1, m), {});
  say(`by outcome: ${JSON.stringify(count(results, r => r.outcome))}`);
  const perMission = {};
  for (const r of results) { const m = perMission[r.mission] ??= {}; m[r.outcome] = (m[r.outcome] ?? 0) + 1; }
  for (const [m, v] of Object.entries(perMission)) say(`  mission ${m}: ${JSON.stringify(v)}`);
  const stops = results.filter(r => r.stop);
  const fam = count(stops, r => `${r.stop.family}`);
  say('stops by family:');
  for (const [f, n] of Object.entries(fam).sort((a, b) => b[1] - a[1])) {
    const sample = stops.find(r => r.stop.family === f);
    say(`  ${String(n).padStart(4)} ${f}  e.g. ${sample.name} (${sample.map}): ${String(sample.stop.message).slice(0, 120)}`);
  }
  return out.join('\n');
}

if (flag('summarize')) { const data = JSON.parse(await readFile(path.resolve(REPO, option('summarize', '.work/census-conversations.json')), 'utf8')); summarize(data.results); process.exit(0); }

if (!process.argv.includes('--child')) { if (import.meta.url === `file://${process.argv[1]}`) await parent(); else { /* imported for buildPlan */ } }
else await childMain();

// =================================================================================================================================================
// the child: one Play session on one map
// =================================================================================================================================================
async function childMain() {
  const { runChild } = await import('./census-conversations-child.mjs');
  await runChild({ map: option('child'), only: option('only', null)?.split(',').map(lower), frameSeconds: Number(option('frame', '0.0333')), buildPlan });
}
