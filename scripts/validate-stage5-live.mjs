#!/usr/bin/env node
/** Stage 5 proof check (docs/stage-5-exit-criteria.md, class O1): a live capture of the original playing a gameplay scene, replayed in Play.
 *
 * Each scene is a stored trace of the original (`scripts/live-original.sh <map> --tag <tag> ...` with the flags and command list below, under the
 * bottle lock), taken with the AI event manager's breakpoints (`.work/live-acceptance/cfg/combat-900.cfg`). The check replays it in Play
 * (`live-acceptance.mjs play`: the original's deltas, stream state per tick and per key edge, the placement the original's frozen phase left,
 * the same console lines and key edges at the same ticks) and passes only when
 *   - every watched field of every watched actor (all ScriptedPawns, the player's pose, gear and hit regions, the perception fields) is equal
 *     (float32) at every tick (`live-acceptance.mjs compare`),
 *   - the level clock and the stream draws per tick are equal,
 *   - every AI event manager call and delivered callback is equal in order and value (`live-events-compare.mjs`),
 *   - every object the scene creates is the original's, in class and tick, in order (`live-sound-compare.mjs`'s registry part; the slots are reported).
 * The original is never started here: a scene whose stored trace is absent prints SKIP and exits 0 (the gate counts it as not passing). The validator sweep
 * leaves this check out (scripts/run-validators.mjs SWEEP_EXCLUDED): it runs as a Stage 5 proof check, with --scene.
 *
 *   node scripts/validate-stage5-live.mjs --scene cmb1
 *
 * Scenes (01_NYC_UNATCOIsland, Terrorist0 standing on open ground at (9651, 190) facing yaw 8624; the player placed in the original's frozen
 * phase (after `KillAll FlyGenerator`) by `ghost`, a SET of Location while out of the collision hash, `walk` (PlayerPawn.StartWalk re-adds it), and a SET of ViewRotation):
 *   cmb1  700 units in front of Terrorist0 (bearing 45 degrees, inside its view): the pistol summoned, picked up and drawn, aimed at Terrorist0, three
 *         Enter key edges (ParseLeftClick|Fire) at ticks 420, 480 and 540; 900 ticks. Sight at 700, the Terrorists' attack on the player, hits both ways.
 *   cmb2  700 units behind Terrorist0 (bearing 180 degrees, the census's island-sight pose), facing away: the pistol taken the same way, then at tick 590
 *         turned on Terrorist0; Enter edges at 600, 630 and 660 (the press at 630 falls inside the pistol's refire time and fires nothing); 900 ticks.
 *         The stored original: no Terrorist notices the player for 600 ticks; the two hits take Terrorist0 to 43 (TakingHit) and 30 (Fleeing) and wake the others.
 *   cmb3  150 units behind Terrorist0 (bearing 227 degrees), facing its back at head height: the pistol taken the same way, four Enter edges at 300, 360,
 *         420 and 480; 900 ticks. The stored original: Terrorist0 and ThugMale7 notice the player at tick 42; the first shot hits ThugMale7 (100 to 68), who
 *         stepped into the line, and the others miss; no kill.
 *   cmb4  cmb1's pose with BallisticArmor instead of the pistol: picked up, put in hand (ActivateBelt 1) and activated by the Enter edge at 180
 *         (ParseLeftClick: an activatable inHand's Activate); 900 ticks of the Terrorists' fire on an armored player.
 * cmb1's stored original: Terrorist0 and ThugMale7 seek the player from tick 41 and attack from 178; the player's first shot (420) kills Terrorist0
 * (TerroristCarcass1 at 469). */
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };

const PISTOL = yaw => `20:summon DeusEx.WeaponPistol|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=${yaw},Roll=0)|90:ParseRightClick|130:ActivateBelt 1`;
const SHOTS = ticks => ticks.map(t => `${t}:@down Enter|${t}:@up Enter`).join('|');
// `KillAll FlyGenerator` first: the load's chance FlyGenerators (10% per fly-making decoration) removed in both programs, as row 4.2.13 does.
const PLACE = (x, y, z, yaw) => `KillAll FlyGenerator|ghost|set DeusEx.JCDentonMale Location (X=${x},Y=${y},Z=${z})|walk|set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=${yaw},Roll=0)`;
export const SCENES = {
  cmb1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(10146.3, 685.2, -88, 40960),
    cmds: `${PISTOL(40960)}|170:set DeusEx.JCDentonMale ViewRotation (Pitch=-536,Yaw=40960,Roll=0)|${SHOTS([420, 480, 540])}`},
  cmb2: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(8951.3, 190.2, -84, 32768),
    cmds: `${PISTOL(32768)}|170:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=32768,Roll=0)|590:set DeusEx.JCDentonMale ViewRotation (Pitch=-536,Yaw=0,Roll=0)|${SHOTS([600, 630, 660])}`},
  cmb3: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(9549, 80.5, -84, 8624),
    cmds: `${PISTOL(8624)}|170:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=8624,Roll=0)|${SHOTS([300, 360, 420, 480])}`},
  // ballistic armor instead of the pistol: picked up the same way, put in hand by ActivateBelt 1 and activated by the Enter edge (ParseLeftClick: inHand.bActivatable -> Activate)
  cmb4: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(10146.3, 685.2, -88, 40960),
    cmds: '20:summon DeusEx.BallisticArmor|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=40960,Roll=0)|90:ParseRightClick|130:ActivateBelt 1'
      + `|170:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=40960,Roll=0)|${SHOTS([180])}`},
};
export const SCENE_FLAGS = ['--no-ghost', '--perception', '--player-gear', '--player-health', '--los-flag'];
// The replay's measured inputs beyond the trace rows: --render-history writes each pawn's LastRenderTime at the original's last frozen tick (the frames the
// original drew at the map's start pose, before the placement, stamped Paul, SecurityBot0 and UNATCOTroop1 at the dock; the stasis gate reads them).
const PLAY_FLAGS = ['--render-history'];
// The tracer's breakpoints of the captures (tools/dx-live-win.c `call`, docs/object-index-captures.md): the registry (AddObject, UnhashObject), the key
// edges' stream state (UEngine::InputEvent), the AI event manager (AISendEvent, AIStartEvent, AIEndEvent, AIClearEvent, the AIEvent callback) and the
// window system's frame deltas (Extension RootTick).
export const CAPTURE_CONFIG = ['call-ticks 1 900', 'call-frames', 'call 0x10157830 addobj 1 always retname', 'call 0x10157760 unhash 1 always retname',
  'call 0x103814e0 inputevent 4 always', 'call 0x10382c60 aisend 5 always name0 fname 1', 'call 0x10382fe0 aistart 5 always name0 fname 1',
  'call 0x103831e0 aiend 3 always name0 fname 1', 'call 0x103832c0 aiclear 2 always name0 fname 1',
  'call 0x10384980 aievent 5 always name0 fname 1 fname 4 namearg 3 0 deref 3 5 0', 'call Extension.dll@0x1003be90 roottick 1 always'];
/** The original's capture command of a scene (for the doc and a recapture). */
export const captureCommand = tag => {
  const s = SCENES[tag];
  return `scripts/live-original.sh ${s.map} --tag ${tag} --ticks ${s.ticks} --delta 0.0166666675 ${SCENE_FLAGS.join(' ')} --registry --extra-config .work/live-acceptance/cfg/combat-900.cfg --early-cmds "${s.early}" --cmds "${s.cmds}"`;
};

const exec = (args, limitSeconds) => new Promise(resolve => {
  const proc = spawn(process.execPath, args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  proc.stdout.on('data', d => { out += d; }); proc.stderr.on('data', d => { out += d; });
  const timer = setTimeout(() => proc.kill('SIGKILL'), limitSeconds * 1000);
  proc.on('exit', code => { clearTimeout(timer); resolve({code, out}); });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = option('scene');
  const scene = SCENES[tag];
  if (!scene) { console.error(`--scene ${Object.keys(SCENES).join('|')}`); process.exit(2); }
  if (argv.includes('--print-capture')) {
    mkdirSync(path.join(root, '.work/live-acceptance/cfg'), {recursive: true});
    writeFileSync(path.join(root, '.work/live-acceptance/cfg/combat-900.cfg'), CAPTURE_CONFIG.join('\n') + '\n');
    console.log(captureCommand(tag)); process.exit(0);
  }
  const dir = path.join(root, '.work/live-acceptance', scene.map);
  const stored = ['original-trace', 'watch', 'population', 'commands'].map(base => path.join(dir, `${base}-${tag}.${base === 'original-trace' ? 'jsonl' : 'json'}`));
  const absent = stored.filter(file => !existsSync(file));
  // (exit 0, as the sweep's store-dependent validators do; the Stage 5 gate counts a SKIP as not passing)
  if (absent.length) { console.log(`SKIP no stored original for ${tag}: ${absent.map(f => path.relative(root, f)).join(', ')}`); process.exit(0); }
  const problems = [];
  const play = await exec(['scripts/live-acceptance.mjs', 'play', '--map', scene.map, '--seed', '1', '--tag', tag, ...SCENE_FLAGS, ...PLAY_FLAGS, '--early-cmds', scene.early,
    '--event-trace', `1:${scene.ticks}`, '--object-trace', `1:${scene.ticks}`], 1800);
  if (play.code !== 0) { console.log(play.out.trim().split('\n').slice(-12).join('\n')); console.log(`FAIL ${tag}: the replay stopped (exit ${play.code})`); process.exit(1); }
  const compare = await exec(['scripts/live-acceptance.mjs', 'compare', '--map', scene.map, '--tag', tag, ...SCENE_FLAGS], 600);
  console.log(compare.out.trim());
  const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
  const actors = Object.entries(report.actors), different = actors.filter(([, e]) => e.firstDifference !== null);
  if (different.length) problems.push(`${different.length} of ${actors.length} actors differ (${different.sort((a, b) => a[1].firstDifference - b[1].firstDifference).slice(0, 4).map(([n, e]) => `${n}@${e.firstDifference}`).join(' ')})`);
  if (report.clock?.firstDifference) problems.push(`clock differs at tick ${report.clock.firstDifference.tick}`);
  if (report.rng?.firstTickWithDifferentDrawCount) problems.push(`stream draws differ at tick ${report.rng.firstTickWithDifferentDrawCount.tick}`);
  const events = await exec(['scripts/live-events-compare.mjs', '--map', scene.map, '--tag', tag, '--show', '4'], 600);
  console.log(events.out.trim());
  if (events.code !== 0) problems.push(`AI events differ (${/(\d+) ticks differ/.exec(events.out)?.[1] ?? '?'} ticks)`);
  // Every object the scene creates (UObject::AddObject: weapons, ammo, tracers, decals, the carcass and what it holds) in class and tick, in order: the
  // registry part of live-sound-compare.mjs (its Galaxy half is not this check's: the scenes carry no `gplay` breakpoint). The registry slot each one takes is
  // reported, not judged: it follows the free list, and cmb3's tick-821 purge (ULevel::CleanupDestroyed) still releases two objects of the frozen start at
  // another place, and a pending-deleted pre-placed actor under another run's index (open, docs/stage-5-exit-criteria.md "First original captures"; the bark
  // subtitles' windows, the first cause, are fixed: a held tick's window frames are split at its commands).
  const registry = await exec(['scripts/live-sound-compare.mjs', '--map', scene.map, '--tag', tag], 600);
  const sequence = existsSync(path.join(dir, `sound-compare-${tag}.json`)) ? JSON.parse(readFileSync(path.join(dir, `sound-compare-${tag}.json`), 'utf8')) : null;
  if (registry.code !== 0 || !sequence) problems.push(`no registry comparison (${registry.out.trim().split('\n').slice(-1)[0]})`);
  else {
    const stem = cls => String(cls).replace(/\d+$/, '').toLowerCase(), {oAdds: a, pAdds: b} = sequence;
    let i = 0; while (i < a.length && i < b.length && stem(a[i].cls) === stem(b[i].cls) && a[i].u === b[i].u) i++;
    const slots = a.filter((o, k) => b[k] && o.index !== b[k].index).length;
    console.log(`registry: ${i} of ${a.length}/${b.length} creations equal in class and tick, in order; ${slots} take another slot`);
    if (i !== a.length || i !== b.length) problems.push(`creations differ at ${i} (original ${JSON.stringify(a[i] ?? null)}, Play ${JSON.stringify(b[i] ?? null)})`);
  }
  if (problems.length) { console.log(`FAIL ${tag}: ${problems.join('; ')}`); process.exit(1); }
  console.log(`PASS ${tag}: ${actors.length} actors equal for ${report.ticks} ticks, clock, stream draws, AI events and object creations equal`);
}
