// The launch trailer's footage: one scripted session of the page as a visitor gets it, from the first frame to a loaded save.
//   node video/launch/trailer-capture.mjs [--scout 30] [--take name] [--until <stretch>] [--dry --marks file (no picture, no sound, not paced: to compare two runs' marks)]
//        -> .work/marketing/out/trailer/<take>/<clip>/f00001.png ..., sound.f32 (what the page played, never heard here) and take.json
// The session: the default start (the flight past the logos), Escape for the main menu, New Game through the original's own screens,
// the intro left with Escape, Liberty Island with the inventory New Game gives, the walk up the dock, MeetPaul and its choice, a fight
// with the pistol, the inventory screen, then the main menu's Load Game with a real desktop save of another player
// (.work/internet-saves/nicouzouf, a 2002 to 2003 playthrough; the page lists it as the installation's Save folder).
// Harness steps, as in ad/scripts/capture-play.mjs: the view is written (turnTo, aimAt), and the fight starts from a placement.
import path from 'node:path';
import {openStage, repo} from './stage.mjs';
import {firstClick, newGame, talk, top, expectTop} from './session.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const until = option('until', null), out = path.join(repo, '.work/marketing/out/trailer', option('take', 'take'));
const SAVES = path.join(repo, '.work/internet-saves/nicouzouf/files/Deus Ex'), SAVE_ROW = Number(option('row', 21));     // row 21: "Hong Kong - Canal Road", 01/03/2003
const stage = await openStage({out, saves: SAVES, scout: Number(option('scout', 0)), dry: argv.includes('--dry'), marks: option('marks', null)});
const {page} = stage, log = (...a) => console.log(`[${stage.steps}]`, ...a);
class Done extends Error {}
const done = async name => { await stage.mark(`end of ${name}`); await stage.drain(); if (until === name) throw new Done(name); };

try {
  await stage.begin();

  // ---- the start: the flight past the Eidos, Ion Storm and Deus Ex logos (DX.dx), as the original starts
  await stage.start('flight');
  await firstClick(stage);
  await stage.frames(1500);
  await done('flight');

  // ---- the main menu, and New Game through the original's screens
  await stage.start('menu');
  await stage.key('Escape', {after: 60});
  await newGame(stage, {onMenu: () => stage.stop(), onScreen: async () => { await stage.start('newgame'); await stage.frames(40); }, onStart: () => stage.stop()});
  await done('menu');

  // ---- Liberty Island: the dock (the level's title text, then a walk along it)
  await stage.start('dock');
  await stage.frames(110);
  await stage.turnTo([0, 0, 0], 80);
  await page.keyboard.down('w');
  await stage.frames(140);
  await stage.turnTo([700, 62500, 0], 120);                         // a look up at the statue, walking
  await stage.frames(60);
  await page.keyboard.up('w');
  await stage.frames(30);
  await stage.stop();
  await done('dock');

  // ---- MeetPaul: Paul runs up; the first exchange, the choice of a weapon, the rest skipped with clicks as a player skips it
  const waited = await stage.until(async () => (await talk(stage))?.con === 'MeetPaul', 60 * 60);
  if (waited < 0) throw new Error('MeetPaul did not start');
  log('MeetPaul after', waited, 'steps');
  await stage.start('paul');
  await stage.until(async () => /^What are we waiting/.test((await talk(stage))?.text ?? ''), 60 * 40);    // the first four lines, at their own pace
  await stage.stop();
  for (let i = 0; i < 40; i++) {                                    // the next lines, a click each
    const t = await talk(stage);
    if (!t || t.cls === 'ConEventChoice') break;
    await stage.click({hold: 2, after: 28});
  }
  if ((await talk(stage))?.cls !== 'ConEventChoice') throw new Error('MeetPaul did not reach its choice');
  await stage.start('choice');
  await stage.frames(50);
  const choice = (await stage.menu({op: 'controls'})).result.windows.filter(w => w.class === 'deusex.conchoicewindow')[0];     // "I'll take the rifle."
  // (the root window's units are the mouse's page pixels one to one, and drawn twice as large at this size: where the page's free pointer
  // is at (x, y) over the picture, the game's cursor is at root (x, y); settingsProbe `center` and `controls` give root units)
  const {box} = stage.canvas, k = 1;
  await stage.glide({x: box[0] + (choice.x + 250) * k, y: box[1] + (choice.y + choice.h / 2) * k}, 45);
  await stage.frames(20);
  await stage.click({hold: 4, after: 40});
  await stage.stop();
  if ((await talk(stage))?.cls === 'ConEventChoice') throw new Error('the click did not take a choice');
  for (let i = 0; i < 60 && await talk(stage); i++) await stage.click({hold: 2, after: 28});
  if (await talk(stage)) throw new Error('MeetPaul did not end');
  log('MeetPaul over; belt', JSON.stringify((await stage.call('inputProbe', {op: 'state'})).belt));
  await done('paul');

  // ---- a fight: the pistol against the NSF by the statue (a placement in front of Terrorist0, as ad/scripts/capture-play.mjs `fight`)
  await page.mouse.move(box[0] + box[2] / 2, box[1] + box[3] / 2);
  await stage.click({hold: 2, after: 10});                           // takes the pointer back (the conversation's choice was clicked with it free)
  await stage.key('1', {after: 70});                                 // ActivateBelt 1: the pistol
  await stage.frames(300);                                           // the conversation's goal messages leave the log
  const target = (await stage.read(['Terrorist0'], ['Location', 'Rotation'])).Terrorist0;
  const bearing = target.Rotation[1] / 32768 * Math.PI, distance = Number(option('distance', 420));
  await stage.place({location: [target.Location[0] + Math.cos(bearing) * distance, target.Location[1] + Math.sin(bearing) * distance, target.Location[2] + 4]});
  await stage.frames(8);
  await stage.aimAt('Terrorist0', 2, 30); await stage.frames(6);
  // who is there: read once, before the clip (the whole level's pawns are a heavy read; in the clip only these few are asked after)
  const everyone = (await stage.call('liveProbe', {census: true})).census.pawns.map(p => p.name).filter(n => !/^JCDenton/i.test(n));
  const first = await stage.read(['@player', ...everyone], ['Location', 'Health']);
  const pawns = everyone.filter(n => first[n]?.Location && first[n].Health > 0 && Math.hypot(...first[n].Location.map((v, i) => v - first['@player'].Location[i])) < 1100);
  log('fight: against', pawns.join(' '));
  const nearest = async () => {
    const r = await stage.read(['@player', ...pawns], ['Location', 'Health']), me = r['@player'].Location;
    return pawns.map(n => [n, r[n]]).filter(([, a]) => a?.Location && a.Health > 0).map(([n, a]) => [n, Math.hypot(...a.Location.map((v, i) => v - me[i])), a.Health])
      .filter(([, d]) => d < 1100).sort((x, y) => x[1] - y[1]);
  };
  await stage.start('fight');
  await stage.frames(50);
  const down = [];
  let current = null, quiet = 0;
  for (let frame = 0; frame < 60 * 15 && down.length < 3; ) {
    const list = await nearest();
    if (current && !list.some(([n]) => n === current)) { down.push(current); log('down:', current, 'at fight frame', frame); }
    current = list[0]?.[0] ?? null;
    if (!current) { if (++quiet > 6) break; await stage.frames(12); frame += 12; continue; }
    quiet = 0;
    await stage.aimAt(current, 8, 30);                              // toward the head
    await stage.click({hold: 4, after: 18});
    frame += 30;
  }
  await stage.frames(120);
  await stage.stop();
  log('fight: down', down.join(' ') || 'nobody', '; health', (await stage.read(['@player'], ['Health']))['@player'].Health);
  await done('fight');

  // ---- the inventory screen (I, ShowInventoryWindow)
  await stage.start('inventory');
  await stage.frames(20);
  await stage.key('i', {after: 50});
  log('inventory top:', await top(stage));
  const item = (await stage.menu({op: 'controls'})).result.windows.filter(win => /inventorybutton|personaitembutton|inventoryitem/i.test(win.class));
  log('item buttons:', JSON.stringify(item.slice(0, 6).map(win => [win.class, win.x, win.y, win.w, win.h])));
  if (item.length) {
    await stage.glide({x: box[0] + (item[0].x + item[0].w / 2) * k, y: box[1] + (item[0].y + item[0].h / 2) * k}, 40);
    await stage.frames(10);
    await stage.click({hold: 4, after: 100});
  } else await stage.frames(150);
  await stage.stop();
  await stage.key('Escape', {after: 30});
  if (await top(stage)) { log('still open:', await top(stage)); await stage.key('Escape', {after: 30}); }
  await done('inventory');

  // ---- Load Game: the main menu, the list of the 2002-2003 saves, one of them loaded
  await stage.start('load');
  await stage.key('Escape', {after: 50});
  await expectTop(stage, 'deusex.menumain');
  await stage.clickControl({field: 'winButtons', index: 2}, {glide: 36, settle: 12, after: 2});      // Load Game
  for (let i = 0; i < 240 && await top(stage) !== 'deusex.menuscreenloadgame'; i++) await stage.frames(1);
  await expectTop(stage, 'deusex.menuscreenloadgame');
  await stage.frames(70);
  const rows = (await stage.menu({op: 'list', field: 'lstGames'})).result.rows;
  log('saves listed:', rows.length, '; picking', JSON.stringify(rows[SAVE_ROW]?.slice(0, 2)));
  await stage.clickControl({field: 'lstGames', row: SAVE_ROW}, {glide: 50, settle: 12, after: 70});
  log('info:', JSON.stringify((await stage.menu({op: 'text', field: 'winSaveInfo'})).result));
  await stage.clickControl({actionKey: 'LOAD'}, {glide: 40, settle: 12, after: 2});
  await stage.stop();
  await stage.arrive(null, {shot: path.join(out, 'loading.png')});
  log('loaded', JSON.stringify(await stage.status()));
  await stage.start('loaded');
  await stage.frames(60);
  const view = (await stage.read(['@player'], ['ViewRotation']))['@player'].ViewRotation;
  await page.keyboard.down('w');
  await stage.frames(100);
  await page.keyboard.up('w');
  await stage.turnTo([view[0], view[1] - 3200, 0], 150);              // a look round, to the left
  await stage.frames(40);
  await stage.stop();
  await stage.frames(360);                                           // the level goes on: its sound runs under the trailer's last card
  await done('load');
} catch (error) {
  if (!(error instanceof Done)) { console.error('FAILED at step', stage.steps, error); process.exitCode = 1; }
} finally {
  await stage.close();
}
