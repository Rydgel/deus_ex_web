/** Stage 4: JC's weapon in a mirror's child frame, in Play's default worker mode (docs/weapon-attachment.md "Mirrors").
 * 05_NYC_UNATCOMJ12lab: the player starts 225 units in front of a mirror pane (surface 3611) and sees his reflection when he
 * looks along +x. The scene is the one the original was captured in (a debugger on the running game, 234 draws of the
 * weapon block in the mirror's child frame; the frame comparison and the logged words are in the doc): `summon
 * DeusEx.WeaponPistol`, the pickup (`ParseRightClick` looking down at it), `ActivateBelt 1`, then the view turned to the pane.
 * The player is excluded from the main frame (first person), so the pistol is drawn in the child frame alone. A second pass of the
 * scene holds a MedKit (`summon DeusEx.MedKit`: a SelectedItem with no Weapon, the block after 0x10b25cdc), drawn with its own Coords.
 * Checks, with the level running (the console commands through the original chain, the ticks of the page):
 *   - the pawn's weapon has a binding drawn in a child frame (frames [1]) and not in the main frame;
 *   - the child frame's PrjXM..PrjYP are its own, the planes of the pane's clipped window (which the special vertices' outcodes
 *     read), not the main frame's; and, with the capture of the original (`.work/live-acceptance/05_NYC_UNATCOMJ12lab`, tag jcm),
 *     the replay of that run gives the words the debugger logged for the frame (3e36ee45 3e6bb90c 3ec81e6e 3e4958ba);
 *   - the Coords handed to the weapon's mesh equal the translation of src/runtime/weapon-attachment.mjs over the special
 *     vertices of that frame (the wiring passes the frame's vertices, the planes and the weapon's Location through);
 *   - `?weaponMirrors=0` leaves the weapon out of the child frame (the switch), `?weapons=off` out of every frame.
 * The original comparison (the logged words, the frames) is the doc's; this validator holds the Play side of it. */
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {handCoords, weaponCoords, selectedCoords, specialOutcode} from '../src/runtime/weapon-attachment.mjs';

const view = new DataView(new ArrayBuffer(4));
const word = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
const probeFor = item => `(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const exec = lines => window.deusExViewer.viewProbe({exec: lines});
  // the original's pose (its trace's last frozen tick: the player lands 0.16 units higher than Play's own settle, which moves the window's y planes)
  await window.deusExViewer.viewProbe({location: [-3086.76978, 1400.20129, -155.809525], region: {zone: 'LevelInfo0', iLeaf: 3650, zoneNumber: 7}});
  await window.deusExViewer.viewProbe({playersOnly: false});
  await wait(1500);
  await exec(['summon DeusEx.${item}']);
  await wait(1500);
  await window.deusExViewer.viewProbe({rotation: [-10130, 16432, 0]});
  await wait(1500);
  await exec(['ParseRightClick']);
  await wait(2500);
  await exec(['ActivateBelt 1']);
  await wait(3500);
  await window.deusExViewer.viewProbe({rotation: [0, 0, 0]});
  await wait(2500);
  const states = await window.deusExViewer.lodProbe({list: 'weapons'});
  return states.filter(s => /^JCDentonMale/.test(s.pawn)).map(s => ({pawn: s.pawn, weapon: s.weapon, item: s.item, binding: s.binding, why: s.why, frames: s.frames,
    last: s.last ? {visible: s.last.visible, childOnly: s.last.childOnly, frames: s.last.frames, coords: s.last.coords, location: s.last.location, prj: s.last.prj, children: s.last.children} : null}));
})()`;
// the weapon states of the frame just drawn (the replay holds the level at its last tick)
const statesProbe = `(async () => {
  await new Promise(resolve => setTimeout(resolve, 500));
  const states = await window.deusExViewer.lodProbe({list: 'weapons'});
  return states.filter(s => /^JCDentonMale/.test(s.pawn)).map(s => ({pawn: s.pawn, weapon: s.weapon, last: s.last ? {children: s.last.children} : null}));
})()`;
mkdirSync('.work/weapon', {recursive: true});

writeFileSync('.work/weapon/validate-weapon-mirror-states.js', statesProbe);
const run = (pageParams, item = 'WeaponPistol') => {
  writeFileSync('.work/weapon/validate-weapon-mirror-play-probe.js', probeFor(item));
  const out = execFileSync('node', ['scripts/live-acceptance.mjs', 'script', '--map', '05_NYC_UNATCOMJ12lab', '--no-ghost', '--expr-file', '.work/weapon/validate-weapon-mirror-play-probe.js',
    ...(pageParams ? ['--page-params', pageParams] : [])], {encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600000});
  return JSON.parse(out.slice(out.indexOf('[')));
};

let failures = 0;
const check = (ok, message) => { if (!ok) { failures++; console.log(`FAIL ${message}`); } };

// The pistol (a Weapon: weaponCoords) and the MedKit (a SelectedItem with no Weapon: selectedCoords, the block after 0x10b25cdc).
function checkScene(item, expectItem) {
  const on = run('antialias=0', item);
  const jc = on.find(s => s.weapon);
  check(Boolean(jc), `${item}: the player holds it (${JSON.stringify(on.map(s => [s.pawn, s.weapon, s.why]))})`);
  if (!jc) return;
  check(jc.item === expectItem, `${item}: drawn as ${expectItem ? 'the SelectedItem' : 'the Weapon'} (${jc.item})`);
  check(jc.binding !== null && jc.why === null, `${item}: ${jc.pawn}/${jc.weapon}: a binding is drawn (${jc.why})`);
  check(jc.last?.visible && jc.last.childOnly && JSON.stringify(jc.last.frames) === '[1]', `${item}: drawn in child frame 1 alone (visible ${jc.last?.visible}, childOnly ${jc.last?.childOnly}, frames ${JSON.stringify(jc.last?.frames)})`);
  const child = jc.last?.children?.[0];
  check(Boolean(child?.prj), `${item}: the child frame has projection planes`);
  if (!child?.prj) return;
  // the pane's clipped window, not the main frame's full viewport
  check(jc.last.prj && child.prj.some((v, i) => word(v) !== word(jc.last.prj[i])), `${item}: child PrjXM..PrjYP are the frame's own, not the main frame's (${child.prj.map(word).map(w => w.toString(16)).join(' ')})`);
  const codes = child.specials.map(v => specialOutcode(v, child.prj));
  const hand = handCoords(child.specials.slice(0, 3), codes.slice(0, 3));
  check(Boolean(hand), `${item}: a hand frame exists in the child frame`);
  const mine = hand ? (expectItem ? selectedCoords : weaponCoords)(hand, jc.last.location).map(word) : [];
  const theirs = child.coords.map(word);
  check(mine.length === 12 && mine.every((w, i) => w === theirs[i]), `${item}: child Coords are the translation of the frame's special vertices (${theirs.map(w => w.toString(16)).join(' ')})`);
}
checkScene('WeaponPistol', false);
checkScene('MedKit', true);

// The words the original logged for this frame (the capture's `special` events: recursion 1, Mirror -1) against Play's replay of the same run
// (the original's trace, its commands and pose), when this checkout has the capture (local files, not versioned: live-original.sh --tag jcm).
if (existsSync('.work/live-acceptance/05_NYC_UNATCOMJ12lab/original-trace-jcm.jsonl')) {
  execFileSync('node', ['scripts/live-acceptance.mjs', 'play', '--map', '05_NYC_UNATCOMJ12lab', '--seed', '1', '--tag', 'jcm', '--no-ghost', '--page-params', 'antialias=0',
    '--after-file', '.work/weapon/validate-weapon-mirror-states.js', '--after-out', '.work/weapon/validate-weapon-mirror-replay.json'], {encoding: 'utf8', maxBuffer: 1 << 28, timeout: 900000});
  const replay = JSON.parse(readFileSync('.work/weapon/validate-weapon-mirror-replay.json', 'utf8')).find(s => /^JCDentonMale/.test(s.pawn));
  const words = replay?.last?.children?.[0]?.prj?.map(word).map(w => w.toString(16)).join(' ');
  check(words === '3e36ee45 3e6bb90c 3ec81e6e 3e4958ba', `the replay's child PrjXM..PrjYP are the words the original logged (${words})`);
} else console.log('no original capture of the scene: the logged projection planes are not compared');

const off = run('antialias=0&weaponMirrors=0', 'WeaponPistol');
check(!off.some(s => s.last?.children?.length), `?weaponMirrors=0: no child frame draws the weapon (${JSON.stringify(off.map(s => [s.pawn, s.weapon, s.why, s.frames]))})`);
const none = run('antialias=0&weapons=off', 'WeaponPistol');
check(!none.some(s => s.weapon && s.binding), '?weapons=off: no weapon binding');

console.log(failures ? `${failures} failures` : 'Held item in a mirror: JC\'s pistol (Weapon) and MedKit (SelectedItem) drawn in the child frame with its own projection planes, off with weaponMirrors=0 and weapons=off');
process.exit(failures ? 1 : 0);
