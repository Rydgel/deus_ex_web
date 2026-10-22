/** The ways a player reaches a load, in Play against the original under Wine (docs/travel.md "Play, step 4"), headless: the QuickLoad key and its confirm box,
 * the Load Game screen from the running game's Escape menu, a death (`OPEN DXONLY`: the logo level, its Escape menu with Save Game and Back to Game disabled)
 * and the Load Game screen from there. The reference is the interactive session `o2` (scripts/save-probe.sh, `.work/travel/o2`): the original's Training with real
 * state, SaveGame 78, QuickSave, a walk, QuickLoad (the box and its Yes), the Escape menu and Load Game on the first row, `Suicide`, twenty seconds of the dying
 * camera, DXOnly, Escape, Load Game, Load: the engine log of each load and the screens' states are compared.
 *
 *   node scripts/validate-load-ui.mjs */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';
import { createMenuDriver } from '../src/viewer/menu-driver.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-load-ui: no installed game data'); process.exit(0); }
const captures = new URL('../.work/travel/', import.meta.url).pathname, cap = `${captures}o2/`;
const realSaves = new URL('../.work/real-saves/', import.meta.url).pathname;
if (!existsSync(`${cap}o2-slot.Save0078/SaveInfo.dxs`) || !existsSync(`${realSaves}Save0001/SaveInfo.dxs`)) { console.log('SKIP validate-load-ui: the measured captures are not in .work (outside Git)'); process.exit(0); }

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };

async function slot(dir, name) {
  const entries = [];
  for (const file of await readdir(dir)) entries.push({ name: file, bytes: new Uint8Array(await readFile(`${dir}/${file}`)) });
  return { directory: name, files: entries, info: parseSaveInfo(entries.find(entry => entry.name === 'SaveInfo.dxs').bytes) };
}
const directory = createSaveDirectory({ saves: [await slot(`${cap}o2-slot.Save0078`, 'Save0078'), await slot(`${cap}o2-quick.QuickSave`, 'QuickSave'), await slot(`${realSaves}Save0001`, 'Save0001')] });

const MODELLED = /^(Log: (Browse:|Doing load|Current mission number|Attempting to get player|Loading: Package saveInfo|Unloading: Package|LoadMap:|Spawning new actor|Possessed PlayerPawn|Game class is|Bringing Level)|Init: (Shut down|Initialized) moving brush tracker|Warning: |ScriptLog: (Login:|All inventory|DeusExLevelInfo - Spawned|InitGame|Base Mutator|\*\*\*\* InitStateMachine))/;
// (the package of a level loaded from a .dx is named by the URL's text in the original, `DXONLY` for `OPEN DXONLY`; Play names it by the file, `DXOnly`: a cosmetic
// difference compared case-insensitively here, docs/travel.md "Unresolved" 19)
const normalize = line => line.replace(/(Possessed PlayerPawn: \w+ )\S*?\.\w+?\d+$/, '$1<pawn>').replace(/\.Mutator\d+/, '.Mutator#').replace(/\bdxonly\b/gi, 'DXONLY').replace(/\s+$/, '');
const modelled = (lines, left) => lines.filter(line => MODELLED.test(line) && !/^Init: Shut down/.test(line)
  && !(/^Log: Unloading: Package/.test(line) && !(left && line.toLowerCase().endsWith(` ${left.toLowerCase()}`)))).map(normalize);
const measured = (await readFile(`${cap}final.log`, 'utf8')).split(/\r?\n/);
/** The measured log from the `occurrence`th line starting with `start` to the next level's `Initialized moving brush tracker`. */
function measuredLoad(start, occurrence) {
  let seen = 0, at = -1;
  for (let i = 0; i < measured.length && at < 0; i++) if (measured[i].startsWith(start) && ++seen === occurrence) at = i;
  if (at < 0) throw new Error(`the original's log has no ${occurrence}th ${start}`);
  let end = measured.length;
  for (let i = at; i < measured.length; i++) if (/Initialized moving brush tracker/.test(measured[i])) { end = i + 1; break; }
  return measured.slice(at, end);
}
const same = (id, got, want) => { check(got.join('\n') === want.join('\n'), `${id}: the engine log differs:\n--- Play\n${got.join('\n')}\n--- original\n${want.join('\n')}`); console.log(`${id}: ${got.length} modelled lines${got.join('\n') === want.join('\n') ? ' in the original\'s order' : ' (DIFFER)'}`); };
const position = async label => (await readFile(`${cap}${label}-player.props.txt`, 'utf8')).split(/\r?\n/).filter(line => /^JCDentonMale JCDentonMale\d+ /.test(line)).at(-1).match(/Location=\(([^)]*)\)/)[1].split(',').map(Number);
/** MenuMain's ten buttons' sensitivity (New Game, Save Game, Load Game, Settings, Training, Play Intro, Credits, Back to Game, Multiplayer, Exit). */
const mainButtons = driver => { const c = driver.controls(); return c.menu.buttons.map(button => c.windows[button.window].sensitive); };

// ---- 1. QuickLoad -----------------------------------------------------------------------------------------------------------------------
console.log('--- QuickLoad key, the confirm box, Yes');
const { c } = await openSession('00_Training', assets, { travel: {}, saveDirectory: directory });
c.frames(60);
const driver = createMenuDriver(c.game);
c.game.inputKey('NumpadDivide', true); c.frames(2); c.game.inputKey('NumpadDivide', false); c.frames(20);
check(driver.top() === 'deusex.menuuimessageboxwindow', `QuickLoad: the key opened ${driver.top()} (the original: the Quick Load? box)`);
const title = c.runtime.readNamed(driver.topWindow(), 'mbMode');
check(title === 0, `QuickLoad: the box mode is ${title} (MB_YesNo = 0)`);
check(driver.windowText('winText').includes('You will lose your current game in progress, are you sure you wish to Quick Load?'), `QuickLoad: the box text is ${driver.windowText('winText')}`);
c.game.hud.scoped(() => driver.pressField('btnYes')); c.frames(4);
const quick = c.takeTravel();
if (check(quick?.restore, 'QuickLoad: Yes made no loaded-game request')) {
  const { c: d } = await openSession(quick.map, assets, { travel: { arrival: quick, lastURL: quick.lastURL }, saveDirectory: directory });
  const at = d.pos(d.player()), want = await position('o2-quickloaded');
  check(Math.fround(at[0]) === Math.fround(want[0]) && Math.fround(at[1]) === Math.fround(want[1]), `QuickLoad: the player is at ${at}, the original's loaded QuickSave put it at ${want}`);
  const old = c.game.doors.scriptRuntime.engineLog, log = d.game.doors.scriptRuntime.engineLog;
  const start = old.findIndex(line => line.startsWith('Log: Browse: Index.dx?loadgame=-1'));
  // (the original's session had already saved in that level: SaveGame's DeleteSaveGameFiles released the level's loaders then, so its QuickLoad prints no `Unloading` line)
  same('QuickLoad', modelled([...old.slice(start), ...log], null), modelled(measuredLoad('Log: Browse: Index.dx?loadgame=-1', 1), null));

  // ---- 2. the running game's Escape menu, Load Game, the first row -------------------------------------------------------------------------
  console.log('--- Escape menu of the loaded game, Load Game, Load');
  d.frames(30);
  const menu = createMenuDriver(d.game);
  d.key('Escape'); d.frames(20);
  check(menu.top() === 'deusex.menumain', `Escape in the loaded game opened ${menu.top()}`);
  // the original's menu in a running game (screenshot o2-menu-ingame.png): every button enabled, Save Game and Back to Game included
  check(mainButtons(menu).every(Boolean), `Escape menu in game: sensitivity ${JSON.stringify(mainButtons(menu))} (the original: all enabled)`);
  menu.invoke('MenuScreenLoadGame'); d.frames(10);
  const rows = menu.listRows('lstGames');
  check(rows.rows.map(row => row[0]).join('|') === 'Quick Save|Untitled|UNATCO Training Course', `Load Game rows ${rows.rows.map(row => row[0])} (the original's screen: Quick Save, Untitled, UNATCO Training Course)`);
  check(rows.selected === 0, `Load Game selects row ${rows.selected} (the original: the first, Quick Save)`);
  d.game.hud.scoped(() => menu.pressActionKey('LOAD')); d.frames(4);
  const second = d.takeTravel();
  if (check(second?.restore, 'Load Game: the button made no request')) {
    const { c: e } = await openSession(second.map, assets, { travel: { arrival: second, lastURL: second.lastURL }, saveDirectory: directory });
    same('Load Game (menu)', modelled([...d.game.doors.scriptRuntime.engineLog.slice(d.game.doors.scriptRuntime.engineLog.findIndex(line => line.startsWith('Log: Browse: Index.dx?loadgame=-1'))), ...e.game.doors.scriptRuntime.engineLog], '00_Training'),
      modelled(measuredLoad('Log: Browse: Index.dx?loadgame=-1', 2), '00_Training'));

    // ---- 3. death: Suicide, the dying camera, `OPEN DXONLY` -------------------------------------------------------------------------
    console.log('--- death, DXOnly, Escape, Load Game, Load');
    e.exec('set DeusEx.JCDentonMale bCheatsEnabled True'); e.game.hud.scoped(() => e.runtime.writeNamed(e.player(), 'bCheatsEnabled', true));
    e.exec('Suicide');
    let death = null;
    for (let i = 0; i < 60 * 45 && !death; i++) { e.frames(1); death = e.takeTravel(); }
    if (check(death, 'death: no travel after 45 s')) {
      check(death.url === 'DXONLY?Name=Player?Class=DeusEx.JCDentonMale', `death: the URL is ${death.url} (the original: DXONLY?Name=Player?Class=DeusEx.JCDentonMale, a loaded game's LastURL being the file's)`);
      const { c: f } = await openSession(death.map, assets, { travel: { arrival: death, lastURL: death.lastURL }, saveDirectory: directory });
      const oldLog = e.game.doors.scriptRuntime.engineLog;
      same('death -> DXOnly', modelled([...oldLog.slice(oldLog.findLastIndex(line => line.startsWith('Log: Browse: DXONLY'))), ...f.game.doors.scriptRuntime.engineLog], '00_Training'),
        modelled(measuredLoad('Log: Browse: DXONLY', 1), '00_Training'));
      f.frames(60);
      check(f.state(f.player()) === 'deusex.deusexplayer.paralyzed', `DXOnly: the player is ${f.state(f.player())} (the original's TravelPostAccept hack: Paralyzed)`);
      const dx = createMenuDriver(f.game);
      f.key('Escape'); f.frames(20);
      check(dx.top() === 'deusex.menumain', `DXOnly: Escape opened ${dx.top()} (the original: MenuMain over the logo)`);
      // the original's menu there (screenshot o2-dxonly-esc.png): Save Game and Back to Game greyed, the rest enabled
      const sens = mainButtons(dx);
      check(JSON.stringify(sens) === JSON.stringify([true, false, true, true, true, true, true, false, true, true]), `DXOnly menu: sensitivity ${JSON.stringify(sens)} (the original: Save Game and Back to Game greyed)`);
      dx.invoke('MenuScreenLoadGame'); f.frames(10);
      f.game.hud.scoped(() => dx.pressActionKey('LOAD')); f.frames(4);
      const third = f.takeTravel();
      if (check(third?.restore, 'DXOnly: Load Game made no request')) {
        const { c: g } = await openSession(third.map, assets, { travel: { arrival: third, lastURL: third.lastURL }, saveDirectory: directory });
        const oldest = f.game.doors.scriptRuntime.engineLog;
        same('Load Game (DXOnly)', modelled([...oldest.slice(oldest.findLastIndex(line => line.startsWith('Log: Browse: Index.dx?loadgame'))), ...g.game.doors.scriptRuntime.engineLog], 'DXONLY'),
          modelled(measuredLoad('Log: Browse: Index.dx?loadgame=-1', 3), 'DXONLY'));
        const pos = g.pos(g.player()), want3 = await position('o2-loaded-after-death');
        check(Math.fround(pos[0]) === Math.fround(want3[0]) && Math.fround(pos[1]) === Math.fround(want3[1]), `after the death the loaded player is at ${pos} (the original: ${want3})`);
      }
    }
  }
}
if (failures.length) { console.log(`FAIL validate-load-ui:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-load-ui');
