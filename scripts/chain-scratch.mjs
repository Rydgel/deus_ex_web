/** Scratch: the Final map's door trigger (not part of the harness). */
import { loadAssets, typeLine } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';
import { placeLines } from './chain-lib.mjs';
const assets = await loadAssets();
const { c } = await openSession('00_TrainingFinal', assets, { travel: {} });
c.frames(120);
const place = (at, view) => { for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at, view })]) { typeLine(c, line); c.frames(20); } c.frames(60); };
const d1 = c.actor('DeusExMover1'), d3 = c.actor('DeusExMover3');
for (const n of ['DeusExMover1', 'DeusExMover3']) { const a = c.actor(n); console.log(n, 'at', c.pos(a).map(Math.round), 'KeyNum', c.read(a, 'KeyNum'), 'Prev', c.read(a, 'PrevKeyNum'), 'bLocked', c.read(a, 'bLocked'), 'StayOpenTime', c.read(a, 'StayOpenTime'), 'bTriggerOnceOnly?', c.read(a, 'bOneWay')); }
place([3584, -697, -126], [0, 49152]);
c.game.inputKey('ArrowUp', true);
for (let i = 0; i < 24; i++) { c.frames(15); console.log((i + 1) * 0.25, 'player', c.pos(c.player()).map(Math.round), 'door1', c.read(d1, 'KeyNum'), c.read(d1, 'PrevKeyNum'), 'door3', c.read(d3, 'KeyNum'), c.read(d3, 'PrevKeyNum'), 'interp', c.read(d1, 'bInterpolating')); }
c.game.inputKey('ArrowUp', false);
process.exit(0);
