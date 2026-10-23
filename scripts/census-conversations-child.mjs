/** The child of scripts/census-conversations.mjs: one Play session on one map, every conversation assigned to it started and run to its end.
 * See that file for what each start is and which steps are the harness's. One JSON line per conversation: {"census": {...}}. */
import './census-stage5-drivers.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';
import { Undriven } from './census-stage5-drivers.mjs';

const lower = s => String(s ?? '').toLowerCase();
const nm = x => x && typeof x === 'object' && 'name' in x ? x.name : x;
const PI = Math.PI;
const wallNow = () => Number(process.hrtime.bigint() / 1000000n);

/** A stop's family: the message with its numbers, names of actors and objects reduced, so that one cause is one family. */
export function familyOf(message) {
  return String(message).split('\n')[0]
    .replace(/0x[0-9a-f]+/gi, '0x#').replace(/-?\d+(\.\d+)?/g, '#')
    .replace(/\b[A-Za-z]+#+\b/g, m => m.replace(/#+/g, '#')).slice(0, 140);
}

export async function runChild({ map, only, frameSeconds, buildPlan }) {
  const root = gameDirectory();
  const { AssetStore } = await import('../src/unreal/assets.mjs');
  const files = [];
  for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
  const assets = new AssetStore(files);
  const { openSession } = await import('./census-stage5-session.mjs');

  const everything = await buildPlan();
  const meta = new Map(everything.map(t => [lower(t.name), t]));
  let targets = everything.filter(t => t.map === map && (!only || only.includes(lower(t.name))));
  // InfoLinks first (any time), then the conversations by owner in the owner's list order
  const rank = t => (t.kind === 'DL' ? 0 : 1);
  targets.sort((a, b) => rank(a) - rank(b) || lower(a.owner).localeCompare(lower(b.owner)) || a.listIndex - b.listIndex);

  let session = null, c = null, H = null;
  const open = async () => {
    session = await openSession(map, assets, { frameSeconds, paintEvery: 10 });
    c = session.c;
    c.frames(30);
    H = harness(c, frameSeconds, meta);
    H.godMode();
  };
  const t0 = wallNow();
  await open();
  console.error(`[${map}] opened in ${Math.round((wallNow() - t0) / 1000)} s, ${targets.length} conversations`);

  const results = new Map();        // name -> result (a direct run, or an incidental one that upgrades an earlier refusal)
  const restartSession = async () => {
    try { c.restart(); H = harness(c, frameSeconds, meta); H.godMode(); if (H.playerDead()) await open(); }
    catch { await open(); }
  };
  const attempt = async t => {
    const result = base(t);
    const w0 = wallNow();
    try {
      await H.runTarget(t, result);
    } catch (error) {
      result.stop = { family: error instanceof Undriven ? `undriven: ${familyOf(error.message)}` : familyOf(error.message), message: String(error.message).split('\n')[0].slice(0, 300),
        where: String(error.stack ?? '').split('\n').slice(1, 6).map(l => l.trim().replace(/^at /, '').replace(/\(?file:\/\/.*\/(src\/[^)]*|scripts\/[^)]*)\)?/, '$1')) };
      result.error = true;
    }
    result.wallMs = wallNow() - w0;
    result.outcome = outcomeOf(result);
    return result;
  };
  const retryable = r => r.outcome === 'unstarted' && !r.error && /^(refused|not started|owner)/.test(r.stop?.family ?? '');
  for (const t of targets) {
    if (results.get(lower(t.name))?.outcome === 'ran') continue;
    let result = await attempt(t);
    // the level drifted (a pawn killed, turned hostile or sent away by an earlier conversation): the original Player start again, once
    if (retryable(result)) {
      const first = result.stop.family;
      await restartSession();
      result = await attempt(t);
      result.notes.unshift(`second attempt after restarting the level (the first: ${first})`);
    }
    results.set(lower(t.name), result);
    for (const other of H.incidentals()) {
      const m = meta.get(lower(other.name));
      if (!m || m.map !== map || results.get(lower(other.name))?.outcome === 'ran') continue;
      const r = { ...base(m), via: `incidental while starting ${t.name}`, started: true, ended: other.ended, events: other.events, seconds: other.seconds, eventKinds: other.eventKinds };
      r.outcome = outcomeOf(r); results.set(lower(other.name), r);
    }
    // a stop, a death or a travel request: the original Player start again; the player and the actors are new objects
    if (result.error || H.needsRestart()) await restartSession();
  }
  for (const t of targets) emit(results.get(lower(t.name)) ?? { ...base(t), outcome: 'unstarted', stop: { family: 'not reached', message: 'the child did not reach this conversation' } });
  console.error(`[${map}] finished in ${Math.round((wallNow() - t0) / 1000)} s`);
  process.exit(0);
}

const emit = result => console.log(JSON.stringify({ census: result }));
const base = t => ({ mission: t.mission, map: t.map, name: t.name, kind: t.kind, owner: t.owner, bark: t.bark, via: null, started: false, ended: false, events: 0, eventKinds: {},
  seconds: 0, choices: [], stop: null, notes: [], predicted: t.predicted });

function outcomeOf(r) {
  if (r.stop) return r.started ? 'stopped' : 'unstarted';
  if (r.started && r.ended) return 'ran';
  return r.started ? 'stopped' : 'unstarted';
}

// =================================================================================================================================================
function harness(c, frameSeconds, meta) {
  const read = (a, n) => c.read(a, n);
  const player = () => c.player();
  const flagBase = () => read(player(), 'FlagBase');
  let frame = 0;
  const runs = [];            // every conversation seen playing: {name, kind, start, end, events:Set, kinds, last}
  const live = new Map();     // name -> run
  const choiceVisits = new Map();
  let travel = null;
  const seconds = frames => Math.round(frames * frameSeconds * 10) / 10;
  const className = a => { try { return c.runtime.instance(a).cls.record.name; } catch { return '?'; } };

  function observe() {
    const p = player();
    const now = new Set();
    for (const field of ['conPlay', 'dataLinkPlay']) {
      const play = read(p, field);
      if (!play) continue;
      // the conversation that was started (startCon): a ConEventJump into another conversation changes `con` but not the one the owner or the trigger started
      const con = read(play, 'con'), startCon = read(play, 'startCon') ?? con;
      if (!con) continue;
      const name = String(nm(read(startCon, 'conName')));
      now.add(name);
      let run = live.get(name);
      if (!run) { run = { name, kind: field === 'conPlay' ? 'con' : 'dl', firstPerson: !!read(startCon, 'bFirstPerson'), start: frame, end: null, events: new Set(), kinds: {}, last: frame, played: new Set([name]) }; live.set(name, run); runs.push(run); }
      run.played.add(String(nm(read(con, 'conName'))));
      const ev = read(play, 'currentEvent');
      if (ev && !run.events.has(ev)) { run.events.add(ev); const k = className(ev).replace(/^ConEvent/, ''); run.kinds[k] = (run.kinds[k] ?? 0) + 1; run.last = frame; }
    }
    for (const [name, run] of live) if (!now.has(name)) { run.end = frame; live.delete(name); }
    if (process.env.CC_TRACE2 && frame % 30 === 0) console.error(`  OBS f${frame} live=[${[...live.keys()]}] conPlay=${Boolean(read(p, 'conPlay'))} dlp=${Boolean(read(p, 'dataLinkPlay'))}`);
  }
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      c.frames(1); frame++;
      const request = c.takeTravel();
      if (request) travel = request;
      observe();
    }
  };
  // The script calls counted for the whole session: a StartConversation that returned true but ended at once (DeusExPlayer.AbortConversation: ConPlay's
  // StartConversation refused, CheckActors/CheckActorDistances) and the conversations ConPlay refused. CC_TRACE=1 CC_TRACE_FLAGS=A,B also prints
  // every GetActiveConversation / StartConversation the script makes, with the frame and those flags, on stderr.
  const counters = c.runtime.__census ??= { aborts: 0, refused: 0 };
  if (!c.runtime.__wrapped) {
    c.runtime.__wrapped = true;
    const orig = c.runtime.callFunction.bind(c.runtime), watchFlags = (process.env.CC_TRACE_FLAGS ?? '').split(',').filter(Boolean);
    c.runtime.callFunction = (record, receiver, argc, evalArg, context) => {
      const r = orig(record, receiver, argc, evalArg, context);
      const key = record.key;
      if (key === 'deusex.deusexplayer.abortconversation') counters.aborts++;
      else if (key === 'deusex.conplay.startconversation' && r === false) counters.refused++;
      if (process.env.CC_TRACE && /getactiveconversation|player\.startconversation$|abortconversation/.test(key)) {
        const args = [0, 1].slice(0, argc).map(i => { try { const v = evalArg(i); return v && v.name ? v.name : v; } catch { return '?'; } }).join(',');
        const flagsNow = watchFlags.map(f => `${f}=${Number(Boolean(flagBase()?.getBool?.(f)))}`).join(' ');
        if (r !== false) console.error(`  TRACE f${frame} ${key.split('.').pop()}(${args}) -> ${r && r.index ? String(nm(read(r, 'conName'))) : r}  [${flagsNow}]`);
      }
      return r;
    };
  }
  const idle = () => live.size === 0;
  const playsActive = () => Boolean(read(player(), 'conPlay') || read(player(), 'dataLinkPlay'));
  const stateName = a => { try { return c.runtime.instance(a)?.state?.stateNode?.record?.name ?? null; } catch { return null; } };
  const tapKey = (code, between = 2) => { c.game.windowKey(code, true); step(between); c.game.windowKey(code, false); step(1); };
  const setFlag = (name, value) => flagBase().setBool(name, value, true, 0);
  const getFlag = name => Boolean(flagBase().getBool(name));
  const call = (obj, fn, ...args) => c.game.hud.scoped(() => c.runtime.callFunction(c.runtime.lookup(obj, fn), obj, args.length, i => args[i]));
  const aliveOwner = a => { if (c.gone(a)) return false; try { if (read(a, 'Health') <= 0) return false; } catch { /* no Health: not a pawn */ } try { return !read(a, 'bHidden'); } catch { return true; } };

  function godMode() {
    if (process.env.CC_NOGOD) return;
    try { c.exec('god'); } catch { /* the property below */ }
    try { c.runtime.writeNamed(player(), 'ReducedDamageType', 'All'); } catch { /* none */ }
  }

  function actorsWithBind(bind) {
    const out = [];
    for (const a of c.actors()) {
      let b; try { b = read(a, 'BindName'); } catch { continue; }
      if (b && lower(b) === lower(bind)) out.push(a);
    }
    return out;
  }
  function chainOf(actor) {
    const names = [];
    try { for (let it = read(actor, 'conListItems'); it && names.length < 800; it = read(it, 'next')) names.push(String(nm(read(read(it, 'con'), 'conName')))); } catch { /* an unbound chain */ }
    return names;
  }

  /** Wait (Level time) until `cond` or the cap; Enter every half second when `press`; a stuck conversation (no new event for `stuck` seconds) ends the wait. */
  function drive(cond, { max = 600, press = false, stuck = 240, watch = null } = {}) {
    const limit = Math.ceil(max / frameSeconds), pressEvery = Math.max(2, Math.round(0.5 / frameSeconds));
    for (let i = 0; i < limit; i++) {
      if (cond()) return true;
      if (travel || playerDead()) return false;
      // a third-person conversation on the screen (the target's, or one that started on the way: Paul walking up) is advanced by the player's input
      if (i % pressEvery === 0) handleInput();
      else step(1);
      const run = watch && runs.find(r => r.name === watch && !r.end);
      if (run && (frame - run.last) * frameSeconds > stuck) return false;
    }
    return cond();
  }

  /** The third-person input: the next line by Enter; at a choice the option by arrow keys (a choice met again takes the next option, so that menus end). */
  function handleInput() {
    const play = read(player(), 'conPlay');
    // Enter is bound to ParseLeftClick|Fire (DefUser.ini): only while a third-person conversation owns the screen
    const con = play && read(play, 'con');
    if (!play || !con || read(con, 'bFirstPerson')) { step(1); return; }
    if (stateName(play) === 'WaitForInput') {
      const win = read(play, 'conWinThird');
      const n = win ? read(win, 'numChoices') : 0;
      const ev = read(play, 'currentEvent');
      if (n > 1) {
        const k = (choiceVisits.get(ev) ?? 0); choiceVisits.set(ev, k + 1);
        step(2);
        for (let i = 0; i < k % n; i++) tapKey('ArrowDown');
        const rec = noteChoices; if (rec) rec(n, k % n);
      }
    }
    tapKey('Enter');
  }
  let noteChoices = null;

  function playerDead() { try { return read(player(), 'Health') <= 0 || H_state(player()).endsWith('dying'); } catch { return false; } }
  const H_state = a => String(c.runtime.instance(a)?.state?.stateNode?.record?.key ?? '');

  // ---- starts --------------------------------------------------------------------------------------------------------------------------
  const walkInto = (at, yaw = 0) => {
    for (const lift of [45, 20, 70]) {
      const from = [at[0] - 20, at[1], at[2] + lift];
      if (!c.inWorld(from)) continue;
      c.fixture.place(from, { yaw }); step(6);
      c.fixture.driveLegacy({ forward: 1 }); step(Math.round(0.6 / frameSeconds)); c.fixture.driveLegacy({ forward: 0 });
      return true;
    }
    return false;
  };
  const runStarted = name => runs.some(r => lower(r.name) === lower(name));

  async function runTarget(t, result) {
    runs.length = 0; live.clear(); travel = null; counters.aborts = 0; counters.refused = 0;
    if (process.env.CC_CLEARCALLS) flagBase().calls.length = 0;
    // let whatever plays finish first (a started InfoLink of an earlier step, a bark)
    if (playsActive()) drive(() => !playsActive(), { max: 400 });
    // harness: the conversation's own flags
    for (const f of t.required) setFlag(f.flag, f.value);
    setFlag(`${t.name}_Played`, false);
    let started;
    if (t.kind === 'DL') started = await startDL(t, result);
    else started = await startTalk(t, result);
    result.started = Boolean(started);
    if (started === 'bark') return;
    result.aborts = counters.aborts; result.refusedByConPlay = counters.refused;
    if (!started) { result.stop = result.stop ?? classifyUnstarted(result); return; }
    const press = t.kind !== 'DL' && !t.firstPerson;
    noteChoices = (n, k) => { result.choices.push({ options: n, took: k }); };
    const ended = drive(() => !runStarted(t.name) ? false : !live.has(t.name) && idle(), { max: press ? 900 : 900, press, watch: t.name });
    noteChoices = null;
    const run = runs.find(r => lower(r.name) === lower(t.name));
    if (run) {
      result.events = run.events.size; result.eventKinds = run.kinds; result.seconds = seconds((run.end ?? frame) - run.start);
      result.ended = Boolean(run.end);
      // TerminateConversation sets <con>_Played for the conversation playing at the end: after a jump that is the one jumped to
      result.playedFlag = [...run.played].some(n => getFlag(`${n}_Played`));
      if (run.played.size > 1) result.jumpedTo = [...run.played].filter(n => lower(n) !== lower(t.name));
      if (!result.playedFlag) result.notes.push('ended without its _Played flag (interrupted or terminated early)');
    }
    if (travel) { result.notes.push(`travel requested: ${travel.url ?? JSON.stringify(travel).slice(0, 80)}`); result.travel = true; }
    if (!ended && !result.stop) {
      const play = read(player(), 'conPlay') ?? read(player(), 'dataLinkPlay');
      result.stop = { family: playerDead() ? 'player died' : travel ? 'travel' : 'did not end', message: `${playerDead() ? 'the player died' : travel ? 'a travel request' : `no end in ${seconds(frame - (run?.start ?? 0))} s`}; state ${play ? stateName(play) : 'none'}; events ${run?.events.size ?? 0}` };
      if (travel || playerDead()) result.stop = null;
    }
    // what else ran while this did (incidental)
    result.also = runs.filter(r => lower(r.name) !== lower(t.name)).map(r => r.name);
    // let a short tail pass so the end's effects (a Trigger, a flag, a pawn leaving) happen
    if (!travel && !playerDead()) step(Math.round(1 / frameSeconds));
  }

  const incidentals = () => runs.filter(r => r.end).map(r => ({ name: r.name, ended: true, events: r.events.size, seconds: seconds(r.end - r.start), eventKinds: r.kinds }));

  async function startDL(t, result) {
    const s = t.starter ?? { type: 'none' };
    const tag = t.name;
    if (s.type === 'trigger' || s.type === 'conversation-trigger') {
      const trig = s.actors.map(a => c.actor(a.name)).find(Boolean);
      const spec = s.actors.find(a => c.actor(a.name) === trig);
      if (trig) {
        if (spec.checkFlag) setFlag(spec.checkFlag, !spec.checkFalse);
        const at = read(trig, 'Location');
        if (walkInto(at)) {
          if (drive(() => runStarted(tag), { max: 3 })) { result.via = `${s.type}: walked into ${spec.name}`; return true; }
        }
        // the trigger's Touch event, as the engine delivers it
        c.game.hud.scoped(() => c.runtime.processEvent(trig, 'Touch', [player()]));
        step(4);
        if (runStarted(tag)) { result.via = `${s.type}: Touch event on ${spec.name}`; return true; }
        c.game.hud.scoped(() => c.runtime.processEvent(trig, 'Trigger', [player(), player()]));
        step(4);
        if (runStarted(tag)) { result.via = `${s.type}: Trigger event on ${spec.name}`; return true; }
        result.notes.push(`${spec.name} (${spec.at?.join(',')}) did not start it`);
      } else result.notes.push(`no ${s.actors.map(a => a.name).join('/')} in the map`);
    }
    const ok = c.game.hud.scoped(() => call(player(), 'StartDataLinkTransmission', tag));
    step(2);
    result.via = s.type === 'script' ? `script call (${s.script})` : s.type === 'none' ? 'direct call (no starter in the data)' : 'direct call (trigger start failed)';
    if (!ok && !runStarted(tag)) result.notes.push('StartDataLinkTransmission returned false');
    return runStarted(tag);
  }

  async function startTalk(t, result) {
    const owners = actorsWithBind(t.owner).filter(a => chainOf(a).some(n => lower(n) === lower(t.name)));
    if (!owners.length) {
      const anyOwner = actorsWithBind(t.owner);
      result.notes.push(anyOwner.length ? `${anyOwner.length} actor(s) carry BindName ${t.owner} but none has ${t.name} in its chain (${chainOf(anyOwner[0]).length} entries)` : `no actor carries BindName ${t.owner}`);
      result.stop = { family: anyOwner.length ? 'owner has no such conversation' : 'owner absent', message: result.notes.at(-1) };
      return false;
    }
    const owner = owners.find(aliveOwner) ?? owners[0];
    c.watched.add(owner);
    result.ownerActor = owner.name;
    if (t.bark) return startBark(t, owner, result);
    const method = t.frob ? 'frob' : t.radius !== null ? 'radius' : 'named';
    setFlag(`${t.name}_Played`, false);
    for (const f of t.required) setFlag(f.flag, f.value);
    if (method === 'named') return startNamed(t, owner, result, t.sight ? 'named (a sight-only conversation: nothing in the original invokes IM_Sight)' : 'named (no invocation flag)');

    /** The conversation the owner's chain would pick for this invocation, by the original's own GetActiveConversation; while it is another conversation, that one
     * is put out of the way by its own condition (a once conversation by its _Played flag, another by a required flag the target does not need). */
    const IM = method === 'frob' ? 1 : 3;
    const prepare = () => {
      const mine = new Set(t.required.map(f => lower(f.flag)));
      // a frob also stands inside the radius of the owner's radius conversations: those are put out of the way too, so that none starts on the way in
      for (const m of method === 'frob' ? [3, 1] : [3]) {
        for (let i = 0; i < 12; i++) {
          for (const f of t.required) setFlag(f.flag, f.value);
          setFlag(`${t.name}_Played`, false);
          const pick = pickOf(owner, m);
          if (!pick || lower(pick) === lower(t.name)) break;
          const meta1 = meta.get(lower(pick));
          if (meta1?.once) setFlag(`${meta1.name}_Played`, true);
          else if (meta1?.required.some(f => !mine.has(lower(f.flag)))) { const f = meta1.required.find(f => !mine.has(lower(f.flag))); setFlag(f.flag, !f.value); }
          else { result.notes.push(`${pick} comes first in the chain, repeats and shares every condition with ${t.name}`); if (m === IM) result.shadowedBy = pick; break; }
          result.notes.push(`put ${pick} out of the way`);
        }
      }
      // nothing valid right now: GetActiveConversation refuses for one second after a conversation with the owner (LastConEndTime) and a radius one for ten
      // after the last one played (lastPlayedTime, lastThirdPersonConvoTime): Level time passes, as it does for the player standing there
      for (let waited = 0; waited < (IM === 3 ? 12 : 3); waited += 1.5) {
        const pick = pickOf(owner, IM);
        if (process.env.CC_PICKS) console.error(`  WAIT f${frame} pick=${pick} ownerState=${c.state(owner).split('.').pop()} lastEnd=${read(owner, 'LastConEndTime')} conPlay=${Boolean(read(player(), 'conPlay'))} t=${read(read(player(), 'Level'), 'TimeSeconds')}`);
        if (pick) return pick;
        step(Math.round(1.5 / frameSeconds));
      }
      return pickOf(owner, IM);
    };
    // up to four tries: a conversation of the owner (or of its twin pawn) that starts on the way in is played to its end, and put out of the way, then the
    // invocation is repeated; the fixture's own ticks are not observed, so the plays are looked at after each of its steps
    let started = false, gathered = false;
    for (let attempt = 0; attempt < 5 && !started; attempt++) {
      const before = runs.length;
      if (method === 'frob') {
        let how = 'frob (the right button)';
        try {
          await c.approach_(owner, [48, 70, 36], async options => {
            c.fixture.aim(owner, options); observe();
            if (playsActive()) { drive(() => !playsActive(), { max: 600 }); c.fixture.aim(owner, options); observe(); }
            const picked = prepare();
            if (picked && lower(picked) === lower(t.name)) await c.game.use();
            return true;
          });
        } catch (error) {
          result.notes.push(`frob: ${String(error.message).slice(0, 100)}`);
          const picked = prepare(); how = 'Frob event on the owner';
          if (picked && lower(picked) === lower(t.name)) c.game.hud.scoped(() => c.runtime.processEvent(owner, 'Frob', [player(), null]));
        }
        step(10);
        if (drive(() => runStarted(t.name), { max: 3 })) { result.via = how; started = true; break; }
        if (counters.refused && !gathered) { gathered = true; gatherSpeakers(owner, t, result); continue; }
      } else {
        const distance = Math.max(20, Math.min(t.radius - 8, 120));
        try {
          const spot = c.openStand(owner, distance); observe();
          if (attempt === 0) result.notes.push(`stood ${distance} units from the owner (bearing ${spot.bearing.toFixed(2)})`);
        } catch (error) { result.notes.push(`openStand: ${String(error.message).slice(0, 100)}`); }
        c.watched.add(owner);
        if (process.env.CC_PICKS) console.error(`  PICKS before prepare f${frame}: r=${pickOf(owner, 3)} f=${pickOf(owner, 1)} flags GothAtButcher=${getFlag('GothAtButcher')}`);
        if (playsActive()) drive(() => !playsActive(), { max: 600 });
        const picked = prepare();
        if (process.env.CC_PICKS) console.error(`  PICKS after prepare f${frame}: ${picked} r=${pickOf(owner, 3)} flags GothAtButcher=${getFlag('GothAtButcher')} played=${getFlag('GothAtButcher_Played')}`);
        // the target may have started by itself while the gates passed (prepare steps Level time): ScriptedPawn.Tick's IM_Radius call
        if (runStarted(t.name) || (!(picked && lower(picked) !== lower(t.name)) && followWait(owner, distance, t.radius, gathered ? 30 : 90, () => runStarted(t.name), () => !gathered && counters.refused >= 2))) { result.via = 'radius (ScriptedPawn.Tick)'; started = true; break; }
        if (counters.refused && !gathered) { gathered = true; gatherSpeakers(owner, t, result); continue; }
      }
      if (runs.length === before) break;
      const others = runs.slice(before).filter(r => lower(r.name) !== lower(t.name)).map(r => r.name);
      result.notes.push(`${others.join(', ')} started instead`);
      drive(() => !playsActive(), { max: 600, watch: others.at(-1) });
      step(Math.round(12 / frameSeconds));
    }
    if (started) { if (gathered) result.via += ' (speakers placed together first)'; return true; }
    result.diag = diagnose(owner, t);
    return startNamed(t, owner, result, `named (${method} did not start it)`);
  }

  /** Wait up to `seconds` of Level time for `cond`, one second at a time, standing next to the owner again whenever it patrols out of the radius (a radius
   * conversation needs its speakers together and the player inside the radius). */
  function followWait(owner, distance, radius, seconds, cond, stop = () => false) {
    for (let i = 0; i < seconds; i++) {
      if (cond()) return true;
      if (stop()) return false;
      drive(cond, { max: 1 });
      try {
        const a = c.pos(owner), b = c.pos(player());
        if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > radius - 12) { c.openStand(owner, distance); observe(); }
      } catch { /* where it stands */ }
    }
    return cond();
  }

  /** A conversation's speakers must all be bound and within 300 units of each other (Conversation.CheckActors and CheckActorDistances, which
   * ConPlayBase.StartConversation applies): the NPCs of a two-person conversation meet on their patrols or by orders another event gives. When the original's
   * check refused, the other speakers are set down near the owner (a harness step like the player's placement: the check itself and everything after it are
   * the original's). */
  function gatherSpeakers(owner, t, result) {
    let con = null;
    try { for (let it = read(owner, 'conListItems'); it && !con; it = read(it, 'next')) { const x = read(it, 'con'); if (lower(String(nm(read(x, 'conName')))) === lower(t.name)) con = x; } } catch { /* none */ }
    if (!con) return;
    const others = new Set(), absent = new Set(), p = player();
    for (let ev = read(con, 'eventList'), n = 0; ev && n < 3000; ev = read(ev, 'nextEvent'), n++) {
      if (className(ev) !== 'ConEventSpeech') continue;
      for (const [actorField, nameField] of [['speaker', 'speakerName'], ['speakingTo', 'speakingToName']]) {
        const a = read(ev, actorField);
        if (!a) absent.add(String(read(ev, nameField))); else if (a !== p && a !== owner) others.add(a);
      }
    }
    if (absent.size) result.notes.push(`speakers without an actor: ${[...absent].join(', ')}`);
    const at = c.pos(owner);
    let k = 0;
    for (const a of others) {
      for (let tries = 0; tries < 12; tries++, k++) {
        const angle = (k * 2.399) % (2 * PI), spot = [at[0] + Math.cos(angle) * 90, at[1] + Math.sin(angle) * 90, at[2]];
        if (!c.inWorld(spot)) continue;
        call(a, 'SetLocation', spot); break;
      }
    }
    result.gathered = [...others].map(a => a.name);
    result.notes.push(`placed ${result.gathered.join(', ') || 'nobody'} within 90 units of the owner (the original's CheckActorDistances had refused: speakers more than 300 apart)`);
    counters.refused = 0; counters.aborts = 0;
    step(Math.round(1.5 / frameSeconds));
  }

  const pickOf = (owner, method) => {
    try { const con = call(player(), 'GetActiveConversation', owner, method); return con ? String(nm(read(con, 'conName'))) : null; } catch { return null; }
  };

  function classifyUnstarted(result) {
    const d = result.diag;
    const message = `${result.notes.join('; ')}${d ? ` | ${JSON.stringify(d)}` : ''}`.slice(0, 900);
    if (result.refusedByConPlay || result.aborts) return { family: 'refused by the original: StartConversation started it and ConPlay.StartConversation refused (CheckActors / CheckActorDistances: the speakers are not all present and together)', message: `${message} | aborts ${result.aborts}, refused ${result.refusedByConPlay}` };
    if (!d) return { family: 'not started', message };
    if (d.canConverse === false) return { family: `refused by the original: the owner cannot converse (state ${String(d.state).split('.').pop()})`, message };
    if (d.canStart === false) return { family: 'refused by the original: the player cannot start a conversation', message };
    if (!d.frobPick && !d.radiusPick) return { family: 'refused by the original: no conversation of the owner\'s chain is valid', message };
    return { family: 'not started: the original would pick one but the invocation did nothing', message };
  }

  /** Why an invocation did nothing: the pawn's and the player's conditions the original checks, and the conversation the chain would pick. */
  function diagnose(owner, t) {
    const d = {};
    const get = (a, n) => { try { return read(a, n); } catch { return 'ERR'; } };
    d.state = stateName(owner) ?? c.state(owner); d.runsSeen = runs.map(r => `${r.name}@${r.start}-${r.end}`);
    for (const n of ['bCanConverse', 'bInterruptState', 'Physics', 'Health', 'bHidden', 'bInWorld', 'Orders']) d[n] = get(owner, n);
    d.enemy = nm(get(owner, 'Enemy'));
    try { d.canConverse = call(owner, 'CanConverse'); } catch { /* none */ }
    try { d.canStart = call(player(), 'CanStartConversation'); } catch { /* none */ }
    try { d.frobPick = nm(read(call(player(), 'GetActiveConversation', owner, 1), 'conName')); } catch { d.frobPick = null; }
    try { d.radiusPick = nm(read(call(player(), 'GetActiveConversation', owner, 3), 'conName')); } catch { d.radiusPick = null; }
    try { const a = c.pos(owner), b = c.pos(player()); d.distance = Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])); } catch { /* none */ }
    if (t) {
      // the radius invocation's own checks (DeusExPlayer.GetActiveConversation, IM_Radius), read one by one
      const chainCon = (() => { try { for (let it = read(owner, 'conListItems'); it; it = read(it, 'next')) { const con = read(it, 'con'); if (lower(String(nm(read(con, 'conName')))) === lower(t.name)) return con; } } catch { /* none */ } return null; })();
      const p = player();
      d.radiusChecks = {
        con: chainCon && { radiusDistance: get(chainCon, 'radiusDistance'), bInvokeRadius: get(chainCon, 'bInvokeRadius'), lastPlayedTime: get(chainCon, 'lastPlayedTime'), bDisplayOnce: get(chainCon, 'bDisplayOnce'), bFirstPerson: get(chainCon, 'bFirstPerson') },
        lastConEndTime: get(owner, 'LastConEndTime'), timeSeconds: get(get(p, 'Level'), 'TimeSeconds'),
        lastThirdPersonConvoTime: get(p, 'lastThirdPersonConvoTime'), lastThirdPersonConvoActor: nm(get(p, 'lastThirdPersonConvoActor')), lastFirstPersonConvoTime: get(p, 'lastFirstPersonConvoTime'),
        lastFirstPersonConvoActor: nm(get(p, 'lastFirstPersonConvoActor')),
        heightDiffOk: (() => { try { return call(p, 'CheckConversationHeightDifference', owner, 20); } catch { return 'ERR'; } })(),
        invokeRadiusOk: chainCon ? (() => { try { return call(p, 'CheckConversationInvokeRadius', owner, chainCon); } catch { return 'ERR'; } })() : null,
        canSee: (() => { try { return call(p, 'CanActorSeePlayer', owner); } catch { return 'ERR'; } })(),
        flagRefs: chainCon ? (() => { try { return call(p, 'CheckFlagRefs', get(chainCon, 'flagRefList')); } catch { return 'ERR'; } })() : null,
        player: c.pos(p).map(Math.round), ownerAt: c.pos(owner).map(Math.round),
      };
      // the speakers ConPlayBase.StartConversation checks: Conversation.CheckActors (every Speech event's speaker and speakingTo bound) and CheckActorDistances (300 units)
      if (chainCon) {
        const pairs = new Map();
        try {
          for (let ev = read(chainCon, 'eventList'), n = 0; ev && n < 3000; ev = read(ev, 'nextEvent'), n++) {
            if (className(ev) !== 'ConEventSpeech') continue;
            const a = read(ev, 'speaker'), b = read(ev, 'speakingTo');
            const key = `${a ? a.name : `none(${read(ev, 'speakerName')})`} -> ${b ? b.name : `none(${read(ev, 'speakingToName')})`}`;
            if (!pairs.has(key)) {
              let dist = null;
              if (a && b && a !== p && b !== p) { const x = c.pos(a), y = c.pos(b); dist = Math.round(Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])); }
              pairs.set(key, dist);
            }
          }
        } catch (error) { pairs.set(`ERR ${error.message}`, null); }
        d.speakerPairs = [...pairs].map(([k, v]) => v === null ? k : `${k} ${v}`);
      }
      const chain = chainOf(owner), here = chain.findIndex(n => lower(n) === lower(t.name));
      d.chainBefore = chain.slice(0, here + 1).filter(n => meta.has(lower(n)) && !meta.get(lower(n)).bark).map(n => {
        const m = meta.get(lower(n));
        return `${n}${m.once ? ' once' : ''}${m.once && getFlag(`${n}_Played`) ? '(played)' : ''} [${m.required.map(f => `${f.flag}=${getFlag(f.flag)}/${f.value}`).join(', ')}]`;
      });
    }
    return d;
  }

  /** An AI bark (`Owner_BarkMode`): the AI's own call. PlayFutzSound is the pawn's function (StartConversationByName on a Futz name); the alliance barks are
   * StartAIBarkConversation(pawn, mode) on the player (what PlayAllianceHostileSound/FriendlySound call once the pawn's Enemy is the player). The bark ends
   * when BarkManager's slot timer (the speech length) removes it. */
  const BARK_MODES = ['Idle', 'CriticalDamage', 'AreaSecure', 'TargetAcquired', 'TargetLost', 'GoingForAlarm', 'OutOfAmmo', 'Scanning', 'Futz', 'OnFire', 'TearGas', 'Gore',
    'Surprise', 'PreAttackSearching', 'PreAttackSighting', 'PostAttackSearching', 'SearchGiveUp', 'AllianceHostile', 'AllianceFriendly'];
  function barkSlots() {
    const bm = read(player(), 'barkManager');
    if (!bm) return null;
    return (read(bm, 'currentBarks') ?? []).filter(s => s && s['deusex.barkmanager.barkinfo.barkpawn']).map(s => String(nm(s['deusex.barkmanager.barkinfo.conname'])));
  }
  function startBark(t, owner, result) {
    const suffix = t.name.replace(/^.*_Bark/, '');
    const mode = BARK_MODES.indexOf(suffix);
    result.notes.push(`bark mode ${suffix} (${mode})`);
    if (mode < 0) return startNamed(t, owner, result, `named (bark suffix ${suffix} is no EBarkModes name)`);
    const near = c.approach(owner, 120);
    try { c.stand(c.inWorld(near) ? near : c.pos(owner), c.pos(owner)); step(8); } catch { /* where it stands */ }
    let ok;
    if (suffix === 'Futz') {
      // PlayFutzSound is StartConversationByName(BuildBarkName(self, BM_Futz), self, !bInterruptState): a ConPlay conversation, not a BarkManager slot
      call(owner, 'PlayFutzSound'); result.via = 'PlayFutzSound on the owner (the AI call)'; step(4);
      if (runStarted(t.name)) return true;
      result.diag = diagnose(owner, t);
      return false;
    }
    ok = call(player(), 'StartAIBarkConversation', owner, mode); result.via = 'StartAIBarkConversation (the AI call)';
    step(2);
    const slots = barkSlots();
    result.notes.push(`bark slots: ${JSON.stringify(slots)}`);
    if (slots?.some(n => lower(n) === lower(t.name))) {
      // the bark plays for its speech length; it is "ended" when its slot is released
      result.started = true;
      let i = 0;
      for (; i < 60 / frameSeconds && barkSlots()?.some(n => lower(n) === lower(t.name)); i++) step(1);
      result.seconds = seconds(i);
      result.ended = !barkSlots()?.some(n => lower(n) === lower(t.name));
      result.events = 1; result.eventKinds = { Bark: 1 };
      result.playedFlag = null;
      result.barkDone = true;
      return 'bark';
    }
    if (!ok) result.notes.push('the AI call returned false');
    return false;
  }

  function startNamed(t, owner, result, label) {
    // a ConversationTrigger of the map first
    const s = t.starter;
    if (s?.type === 'conversation-trigger') {
      const trig = s.actors.map(a => c.actor(a.name)).find(Boolean);
      if (trig) {
        const spec = s.actors.find(a => c.actor(a.name) === trig);
        if (spec.checkFlag) setFlag(spec.checkFlag, !spec.checkFalse);
        walkInto(read(trig, 'Location'));
        if (drive(() => runStarted(t.name), { max: 3 })) { result.via = `ConversationTrigger ${spec.name} (walked into)`; return runStarted(t.name); }
      }
    }
    const near = c.approach(owner, 100);
    try { c.stand(c.inWorld(near) ? near : c.pos(owner), c.pos(owner)); step(8); } catch { /* where it stands */ }
    const ok = call(player(), 'StartConversationByName', t.name, owner);
    step(4);
    result.via = label;
    if (!ok && !runStarted(t.name)) result.notes.push('StartConversationByName returned false');
    return runStarted(t.name);
  }

  return {
    runTarget, godMode,
    incidentals,
    needsRestart: () => Boolean(travel) || playerDead(),
    playerDead,
  };
}
