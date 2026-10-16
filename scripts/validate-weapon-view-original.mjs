/** Stage 4 gate row 4.1.10: the first-person weapon against the original (docs/weapon-attachment.md "The first-person weapon against
 * the original"). The original's capture (main `.work`, the Mac, tag fpw): 00_Training, a normal player (`--no-ghost`), 300 traced ticks with
 * `summon DeusEx.WeaponCrowbar` (20), the view down at it (50), `ParseRightClick` (90), `ActivateBelt 1` (130), the view ahead (170), the level
 * held by the tracer at tick 300 and its frame taken; the tracer's `fpdraw` call breakpoint (URender::DrawActor 0x10b262c0, which
 * Canvas.DrawActor reaches from the weapon's RenderOverlays) logged the crowbar's draw in every frame of the hold. This replays the trace in
 * Play (worker mode) and checks:
 *   - per tick: the clock, the stream's draw count and every watched actor equal, but for the measured start-state difference of the player's
 *     own animation frame (Play's first replayed tick advances the BreatheLight frame by 0.003875 where the original's advances 0.016375; the lag
 *     holds until the animation restarts with the pickup at tick 90 and the frames are equal from 91 to 300; not attributed, the one the
 *     conversation rows list too): only `@player`'s `Frame`, from tick 1, at most PLAYER_FRAME_TICKS ticks;
 *   - the held frame and the crowbar's region (CROWBAR) at the gate's frame thresholds (edge recall .90, precision .85, no outlier block);
 *   - the held first-person draw, bit for bit: the weapon's Location, Rotation, AnimFrame/AnimRate/TweenRate and the frame's Coords
 *     (scripts/weapon-view-compare.mjs over Play's scripts/weapon-view-probe.js), the original's draws of the hold all the same words.
 * Exits 1 with the first problem; SKIP (exit 0) when the capture is not in this checkout. */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MAP = '00_Training', TAG = 'fpw', SHOT = 'fpw';
const CROWBAR = '280x600+790+120';           // the crowbar and the hand in the 1280x720 frame (both programs)
const PLAYER_FRAME_TICKS = 90;               // measured: ticks 1 to 90 (the pickup restarts the player's animation)
const FRAME = {edgeRecall: 0.90, edgePrecision: 0.85, outlierBlocks: 0};
const live = path.join(root, '.work/live-acceptance', MAP), acceptance = path.join(root, '.work/acceptance', MAP);
const needed = [path.join(live, `original-trace-${TAG}.jsonl`), path.join(live, `original-trace-${TAG}.jsonl.calls.jsonl`), path.join(acceptance, `${SHOT}-original.png`)];
const absent = needed.filter(file => !existsSync(file));
if (absent.length) { console.log(`SKIP validate-weapon-view-original: the original's capture is not here (${absent.map(f => path.relative(root, f)).join(', ')})`); process.exit(0); }
const node = (args, seconds = 900) => execFileSync(process.execPath, args, {cwd: root, encoding: 'utf8', timeout: seconds * 1000, maxBuffer: 1 << 26});
const problems = [];

const playOut = path.join(live, `weapon-view-play-${TAG}.json`);
const play = node(['scripts/live-acceptance.mjs', 'play', '--map', MAP, '--seed', '1', '--tag', TAG, '--shot', SHOT, '--no-ghost', '--page-params', 'antialias=0',
  '--after-file', 'scripts/weapon-view-probe.js', '--after-out', playOut], 1500);
if (/errors:/.test(play)) problems.push(`replay: ${play.trim().split('\n').pop()}`);

node(['scripts/live-acceptance.mjs', 'compare', '--map', MAP, '--tag', TAG], 600);
const report = JSON.parse(readFileSync(path.join(live, 'report.json'), 'utf8'));
if (report.clock?.firstDifference) problems.push('the clock differs');
if (report.rng?.firstTickWithDifferentDrawCount) problems.push(`stream draws differ at tick ${report.rng.firstTickWithDifferentDrawCount.tick}`);
for (const [name, entry] of Object.entries(report.actors)) {
  if (entry.firstDifference === null) continue;
  const fields = Object.entries(entry.fields ?? {});
  const allowed = name === '@player' && fields.length === 1 && fields[0][0] === 'Frame' && fields[0][1].tick === 1 && fields[0][1].count <= PLAYER_FRAME_TICKS;
  if (!allowed) problems.push(`${name} differs at tick ${entry.firstDifference} (${fields.map(([field, f]) => `${field}@${f.tick} x${f.count}`).join(', ')})`);
}

const frameRow = (extra = []) => {
  const line = node(['scripts/visual-acceptance.mjs', 'compare', '--maps', MAP, '--view', `${SHOT}:0,0,0:0,0,0`, ...extra], 300).trim().split('\n').find(l => l.startsWith(`${MAP} ${SHOT} `));
  if (!line) return null;
  return {...JSON.parse(line.slice(`${MAP} ${SHOT} `.length, line.lastIndexOf('}') + 1)), blocks: Number(/ (\d+) outlier blocks/.exec(line)?.[1])};
};
const judge = (label, m) => {
  if (!m) { problems.push(`${label}: no comparison`); return; }
  if (!(m.edgeRecall >= FRAME.edgeRecall)) problems.push(`${label}: edge recall ${m.edgeRecall}`);
  if (!(m.edgePrecision >= FRAME.edgePrecision)) problems.push(`${label}: edge precision ${m.edgePrecision}`);
  if (!(m.blocks <= FRAME.outlierBlocks)) problems.push(`${label}: ${m.blocks} outlier blocks`);
};
const frame = frameRow(), crowbar = frameRow(['--crop', CROWBAR]);
judge('frame', frame); judge('crowbar', crowbar);

const draw = JSON.parse(node(['scripts/weapon-view-compare.mjs', '--map', MAP, '--tag', TAG, '--play', playOut], 120).trim().split('\n').pop());
if (draw.error) problems.push(`first-person draw: ${draw.error}`);
else {
  if (!draw.steady) problems.push('the original\'s draws of the hold are not all the same');
  for (const [field, same] of Object.entries(draw.equal)) if (!same) problems.push(`first-person draw: ${field} differs (${JSON.stringify(draw.fields[field])})`);
}

const summary = `${report.ticks} ticks (actors, clock, stream draws), frame ${frame?.edgeRecall}/${frame?.edgePrecision}/${frame?.blocks}, crowbar ${crowbar?.edgeRecall}/${crowbar?.edgePrecision}/${crowbar?.blocks}, ` +
  `held draw ${draw.heldDraws ?? 0} x ${draw.weapon?.join('/')}: Location, Rotation, animation and Coords ${draw.equal && Object.values(draw.equal).every(Boolean) ? 'equal' : 'differ'}`;
if (problems.length) { console.log(`FAIL validate-weapon-view-original: ${problems.join('; ')} | ${summary}`); process.exit(1); }
console.log(`validate-weapon-view-original: ${summary}`);
