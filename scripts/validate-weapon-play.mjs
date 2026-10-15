/** Stage 4: a pawn's third-person weapon in Play, in the default worker mode (docs/weapon-attachment.md).
 * The Island view of the live-scene pilots (`CheatView DeusEx.Terrorist` twelve times: Terrorist22 close at its
 * right side, ThugMale3 beside it), the level running, through scripts/live-acceptance.mjs's `script` verb (a headless
 * Chromium, the page and the simulation worker as in Play). Checks, per armed pawn drawn:
 *   - the weapon has a binding of its own on the CPU path, drawn in the main frame with camera points and colours;
 *   - its Coords (the 12 words DrawMesh gets) equal the translation of src/runtime/weapon-attachment.mjs applied to the
 *     pawn's special vertices as Play's own pose gives them in that frame: the wiring passes the frame's vertices, the
 *     weapon's Location and the outcodes through unchanged (the translation itself is validate-weapon-attach.mjs's);
 *   - the state DrawActorSprite writes into the weapon: Rotation zero, OldFlashCount = FlashCount, the weapon still
 *     hidden, its LastRenderTime not stamped (the pawn's is);
 *   - `?weapons=off` draws none.
 * The pixels of the same view against the original (live-acceptance.mjs play/compare, visual-acceptance.mjs compare)
 * are recorded in docs/weapon-attachment.md. */
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {handCoords, weaponCoords, specialOutcode} from '../src/runtime/weapon-attachment.mjs';

const view = new DataView(new ArrayBuffer(4));
const word = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
const cheat = Array.from({length: 12}, () => 'CheatView DeusEx.Terrorist');
const probe = `(async () => {
  const exec = ${JSON.stringify([...cheat, 'set DeusEx.JCDentonMale ViewRotation (Pitch=-500,Yaw=46936,Roll=0)'])};
  await window.deusExViewer.viewProbe({exec});
  await window.deusExViewer.viewProbe({playersOnly: false});
  await new Promise(resolve => setTimeout(resolve, 3000));
  const states = await window.deusExViewer.lodProbe({list: 'weapons'});
  const mine = states.filter(s => s.pawn === 'Terrorist22' || s.pawn === 'ThugMale3');
  const read = (names, props) => window.deusExViewer.liveProbe({read: {names, props}});
  const weapons = await read(mine.map(s => s.weapon).filter(Boolean), ['Rotation', 'FlashCount', 'OldFlashCount', 'bHidden', 'LastRenderTime', 'ThirdPersonMesh']);
  const pawns = await read(mine.map(s => s.pawn), ['LastRenderTime']);
  const bindings = await window.deusExViewer.lodProbe({list: true});
  return {mine, weapons: weapons.read, pawns: pawns.read, thirdPerson: bindings.filter(b => /3rd/.test(b.mesh ?? '')).map(b => ({actor: b.actor, path: b.path}))};
})()`;
mkdirSync('.work/weapon', {recursive: true});
writeFileSync('.work/weapon/validate-weapon-play-probe.js', probe);
const run = extra => {
  const out = execFileSync('node', ['scripts/live-acceptance.mjs', 'script', '--map', '01_NYC_UNATCOIsland', '--expr-file', '.work/weapon/validate-weapon-play-probe.js', ...extra],
    {encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600000});
  return JSON.parse(out.slice(out.indexOf('{')));
};

let failures = 0;
const check = (ok, message) => { if (!ok) { failures++; console.log(`FAIL ${message}`); } };

const on = run([]);
check(on.mine.length === 2, `both armed pawns are in view (${on.mine.length})`);
for (const state of on.mine) {
  const name = `${state.pawn}/${state.weapon}`;
  check(state.binding !== null && state.why === null, `${name}: a binding is drawn (${state.why})`);
  check(state.last?.visible && state.last.points && state.last.colors && JSON.stringify(state.last.frames) === '[null]', `${name}: drawn in the main frame with camera points and colours`);
  if (!state.last?.specials) { check(false, `${name}: no special vertices`); continue; }
  // The outcodes come from the frame's projection planes; Play's frame has them.
  const codes = state.last.specials.map(v => state.last.prj ? specialOutcode(v, state.last.prj) : 0);
  const hand = handCoords([state.last.specials[0], state.last.specials[1], state.last.specials[2]], codes);
  check(Boolean(hand), `${name}: a hand frame exists`);
  const mine = hand ? weaponCoords(hand, state.last.location).map(word) : [];
  const theirs = state.last.coords.map(word);
  check(mine.length === 12 && mine.every((w, i) => w === theirs[i]), `${name}: Coords are the translation of the pawn's special vertices (${theirs.map(w => w.toString(16)).join(' ')})`);
  const weapon = on.weapons[state.weapon];
  check(weapon.Rotation.every(v => v === 0), `${name}: Rotation zeroed (${weapon.Rotation})`);
  check(weapon.OldFlashCount === weapon.FlashCount, `${name}: OldFlashCount = FlashCount (${weapon.OldFlashCount}, ${weapon.FlashCount})`);
  check(weapon.bHidden === 1 || weapon.bHidden === true, `${name}: the weapon actor stays hidden`);
  check(weapon.LastRenderTime <= 0, `${name}: the weapon is not stamped (${weapon.LastRenderTime})`);
  check(on.pawns[state.pawn].LastRenderTime > 0, `${name}: its pawn is`);
}
check(on.thirdPerson.length === 2 && on.thirdPerson.every(b => b.path === 'cpu'), `two third-person bindings on the CPU path (${JSON.stringify(on.thirdPerson)})`);
const off = run(['--page-params', 'weapons=off']);
check(off.thirdPerson.length === 0 && off.mine.every(s => s.binding === null), '?weapons=off: no weapon binding');
console.log(failures ? `${failures} failures` : 'weapon in Play: all checks pass');
process.exit(failures ? 1 : 0);
