/** Scratch: the cadet's carcass, its key and the table (not part of the harness). */
import { loadAssets, typeLine } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';
import { placeLines, placementNear } from './chain-lib.mjs';
const assets = await loadAssets();
const { c } = await openSession('00_Training', assets, { travel: {} });
c.frames(600);
const place = (at, view) => { for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at, view })]) { typeLine(c, line); c.frames(20); } c.frames(60); };
const carcass = c.byClass('UNATCOTroopCarcass')[0];
console.log('carcass', carcass.name, c.pos(carcass).map(Math.round));
const keys = () => { const out = []; for (let k = c.read(c.player(), 'KeyList'); k && out.length < 9; k = c.read(k, 'NextKey?')) out.push(k.name); return out; };
const inv = () => { const items = []; for (let i = c.read(c.player(), 'Inventory'); i && items.length < 20; i = c.read(i, 'Inventory')) items.push(`${i.name}@${c.read(i, 'beltPos')}`); return items.join(' '); };
const carcassInv = () => { const items = []; for (let i = c.read(carcass, 'Inventory'); i && items.length < 20; i = c.read(i, 'Inventory')) items.push(i.name); return items.join(' '); };
console.log('carcass inventory', carcassInv());
for (const bearing of [Math.PI / 2, 0, Math.PI, -Math.PI / 2]) {
  const { at, view } = placementNear(c.pos(carcass), 50, bearing);
  console.log('bearing', bearing.toFixed(2), 'place', at, view);
  place(at, view);
  console.log(' frobTarget', c.game.interaction.frobTarget?.name, 'player', c.pos(c.player()).map(Math.round));
  if (c.game.interaction.frobTarget === carcass) break;
}
typeLine(c, 'ParseRightClick'); c.frames(60);
console.log('after frob 1: inventory', inv(), '| carcass inv', carcassInv(), '| carried', c.read(c.player(), 'CarriedDecoration')?.name, 'inHand', c.read(c.player(), 'inHand')?.name);
typeLine(c, 'ParseRightClick'); c.frames(60);
console.log('after frob 2: carried', c.read(c.player(), 'CarriedDecoration')?.name, 'inHand', c.read(c.player(), 'inHand')?.name, 'carcass pos', c.gone(carcass) ? 'gone' : c.pos(carcass).map(Math.round));
const mv = n => { const a = c.actor(n); return `${n} Key ${c.read(a, 'KeyNum')} Prev ${c.read(a, 'PrevKeyNum')} locked ${c.read(a, 'bLocked')}`; };
console.log(mv('DeusExMover3'), mv('DeusExMover25'));
for (const bearing of [Math.PI / 2, -Math.PI / 2, 0, Math.PI]) {
  const t = [3688, 378, -40];
  const { at, view } = placementNear(t, 70, bearing);
  place(at, view);
  console.log('table place', at, view, 'player', c.pos(c.player()).map(Math.round));
  typeLine(c, 'DropItem'); c.frames(120);
  const dropped = c.byClass('UNATCOTroopCarcass');
  console.log(' after DropItem: carcasses', dropped.map(a => `${a.name}@${c.pos(a).map(Math.round)}`), mv('DeusExMover3'), mv('DeusExMover25'), 'inHand', c.read(c.player(), 'inHand')?.name);
  if (dropped.length) break;
}
c.frames(300);
console.log(mv('DeusExMover3'), mv('DeusExMover25'));
process.exit(0);
