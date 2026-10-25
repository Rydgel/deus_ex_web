/** UGameEngine::Tick's travel step (Engine.dll 0x10390868..0x10390d5a) and DDeusExGameEngine::Browse's execution
 * (docs/travel.md "The engine tick's travel step", "Browse: the DeusEx override"). The decision itself is
 * travel-browse.mjs; this module reads and changes the live level around it:
 *
 *   1. a local TravelInfo map; `?RESTART` copies the level's own, else with bTravelItems `Logf("Export travel for: <PlayerName>")`
 *      and TravelInfo[PlayerName] = ExportTravel(player) (travel-export.mjs); bItems = 0 leaves it empty;
 *   2. every `loadonly` option of LastURL is removed and LastURL.Portal cleared (0x10390a8a..0x10390bad);
 *   3. URL = FURL(LastURL, TravelURL, TravelType); Browse(URL, TravelInfo): `Logf("Browse: <URL>")`, then the decision's effects;
 *   4. the viewport's TravelURL is cleared once Browse returns (0x10390c07).
 *
 * A `loadMap` effect hands the page the next level: `{map, portal, url, options, loadUrl, travelInfo, lastURL, classDefaults, ...}` (the page's loadMap
 * builds the new session, whose Login imports the text: travel-import.mjs; `classDefaults` are the class defaults the process keeps,
 * ScriptRuntime.classDefaultsForTravel). `loadUrl` is the URL LoadMap is called with, as plain fields: the next session's GLevel->URL is it or, when it
 * has a `load` option, the URL the loaded file holds (furl.mjs levelUrlAfterLoad, game.mjs). `lastURL` is the engine's LastURL after the load: LoadMap's
 * tail assigns `LastURL = URL` (0x1038e059..0x1038e318), and the loaded-game and filed-level branches of Browse then assign `LastURL = GLevel->URL`
 * (0x1001138b, 0x10011c84), which the next session takes from the file it loads (game.mjs). A branch that is not implemented is a thrown
 * {@link TravelStop} that names the original body; the viewport keeps its TravelURL, and a refused URL form (furl.mjs) is one too. */
import { Furl, parseFurl, UnsupportedFurlForm, TRAVEL_RELATIVE, mapFileStem } from './furl.mjs';
import { browseDecision } from './travel-browse.mjs';
import { formatTravelText } from './travel-text.mjs';
import { saveSlotDirectory } from './save-directory.mjs';

const lower = value => String(value ?? '').toLowerCase();

/** A travel branch Play does not implement: names the original body and carries the URL. */
export class TravelStop extends Error {
  constructor(name, reason, travel = {}) {
    super(`${name}: ${reason}`);
    this.name = 'TravelStop';
    this.stage = 6;
    this.body = name;
    this.travel = Object.freeze({ ...travel });
  }
}

/**
 * @param runtime
 * @param level          the live Level object (`level.travelInfo`: the Map the level was loaded with; `level.actors`)
 * @param viewport       () => the UViewport (travelURL, travelType, bTravelItems; `Actor`)
 * @param exporter       travel-export.mjs createTravelExporter()
 * @param store          script-travel.mjs createSaveStore()
 * @param log            (tag, text) => void  the engine log
 * @param levelSaver     {pruneTravelActors(), saveCurrentLevel(position)} PruneTravelActors and SaveCurrentLevel (travel-save.mjs), or null: the
 *                       same-mission branch is then a {@link TravelStop}
 * @param lastURL        the engine's LastURL (a Furl)
 * @param levelUrlMap    () => GLevel->URL.Map
 * @param packageName    () => the name of the level's package (the loaded level takes a live package's spelling: `loadGame`)
 */
export function createTravelStep({ runtime, level, viewport, exporter, store, log, lastURL, levelUrlMap, levelSaver = null, packageName = null }) {
  const read = (object, name) => runtime.readNamed(object, name);
  const levelInfo = () => {
    const actor = level.actors.find(a => a && runtime.attachedInstance(a)?.cls.record.key === 'deusex.deusexlevelinfo');
    return actor ? { missionNumber: read(actor, 'missionNumber'), mapName: String(read(actor, 'MapName')) } : null;
  };
  /** LoadSaveInfo(index) (DeusEx.dll 0x100108a0): the slot's parsed SaveInfo.dxs from the save directory, or null (no file, not a package). */
  const slotInfo = index => {
    const info = store.directory.info(saveSlotDirectory(index));
    return info ? { mapName: String(info.properties?.MapName ?? '') } : null;
  };
  function browse(url, travelInfo) {
    log('Log', `Browse: ${url}`);
    const player = read(viewport(), 'Actor');
    const effects = browseDecision({ url, lastURL, level: { info: levelInfo(), urlMap: levelUrlMap() },
      player: player ? { bStartingNewGame: Boolean(read(player, 'bStartingNewGame')) } : null,
      saveInfo: typeof store.directory?.info === 'function' ? slotInfo : null });
    let copied = null;
    for (const effect of effects) {
      switch (effect.op) {
        case 'log': log('Log', effect.text); break;
        case 'deleteSaveGameFiles': store.deleteCurrent(); break;
        case 'clearStartingNewGame': runtime.writeNamed(read(viewport(), 'Actor'), 'bStartingNewGame', false); break;
        case 'boundary': throw new TravelStop(effect.name, effect.reason, { url: String(url) });
        case 'pruneTravelActors':
          if (!levelSaver) throw new TravelStop('PruneTravelActors', 'the level cannot be filed in this session (no level saver)', { url: String(url) });
          levelSaver.pruneTravelActors();
          break;
        case 'saveCurrentLevel':
          if (!levelSaver) throw new TravelStop('SaveCurrentLevel', 'the level cannot be filed in this session (no level saver)', { url: String(url) });
          levelSaver.saveCurrentLevel(effect.position);
          break;
        case 'copySaveGameFiles': {
          // CopySaveGameFiles (0x10010000): every `*.dxs` of the slot, in Current. The directory the simulation holds lists a slot without its bytes (the page keeps them in
          // its storage): the request names the files the page still has to read and hand over before the level loads.
          const names = store.directory.copyFiles(effect.from, effect.to);
          copied = { dir: effect.from, names, fetch: names.filter(name => !store.directory.readFile(effect.to, name)) };
          break;
        }
        case 'loadGameFailed':
          // Browse returned 0 (LoadSaveInfo found no SaveInfo): the tick does not test the result, the level goes on. The line is Play's (the original's
          // message for the failed StaticLoadObject was not measured).
          log('Warning', `Browse loadgame=${effect.index}: ${effect.reason} (${saveSlotDirectory(effect.index)}); the saved game is not loaded`);
          return null;
        case 'loadMap': {
          if (effect.loadgame) return loadGame(effect, copied);
          // Within one mission a level filed in `Current` for the destination (also the one just saved, when the destination is the level
          // left) is loaded from there: FURL(&URL, path, TRAVEL_Partial) with the portal copied back (0x10011716..).
          const restored = effect.saved && store.has(effect.saved.file) ? effect.saved : null;
          const loadUrl = restored ? restored.url : effect.url;
          log('Log', `LoadMap: ${loadUrl}`);
          const info = effect.travelInfo === 'level' ? level.travelInfo ?? new Map() : travelInfo;
          return { kind: 'loadMap', map: restored ? restored.name : mapFileStem(effect.url.map), portal: loadUrl.portal, url: String(loadUrl), options: [...loadUrl.op],
            // LoadMap's tail: LastURL = URL; a filed level's branch then sets LastURL = GLevel->URL (game.mjs reads it from the file)
            loadUrl: loadUrl.toPlain(), travelInfo: [...info], lastURL: loadUrl.toPlain(),
            // the file as the directory spells it (the save wrote it under DeusExLevelInfo.MapName): its stem names the loaded package
            ...(restored ? { restore: { file: store.files().find(file => lower(file.name) === lower(restored.file)).name, name: restored.name } } : {}) };
        }
        default: throw new Error(`Unknown Browse effect ${effect.op}`);
      }
    }
    throw new Error('Browse ended without a LoadMap or a boundary');
  }

  /** `?loadgame=N`'s LoadMap(FURL(&URL, "<Current>\\<MapName>.dxs?load?loadonly?loadgame", TRAVEL_Absolute), NULL, NULL): the slot's level, saved with the player in it, is
   * loaded from `Current` with no travel text; on success LastURL = GLevel->URL (0x10010f4f..0x1001151e), the URL the file holds (its `load` option keeps it,
   * game.mjs). The level keeps the TravelInfo its file holds. */
  function loadGame(effect, copied) {
    const { loadgame, url: loadUrl } = effect;
    const file = store.files().find(entry => lower(entry.name) === lower(loadgame.file));
    // LoadMap fails on a slot without the level its SaveInfo names: Play stops by name (the original's failed-load path is Unresolved 9).
    if (!file) throw new TravelStop('DDeusExGameEngine::Browse loadgame', `${saveSlotDirectory(loadgame.index)} holds no ${loadgame.file}`, { url: String(loadUrl) });
    log('Log', `LoadMap: ${loadUrl}`);
    return { kind: 'loadMap', map: loadgame.mapName, portal: '', url: String(loadUrl), options: [...loadUrl.op], loadUrl: loadUrl.toPlain(), travelInfo: [],
      lastURL: loadUrl.toPlain(),
      // The package takes the name of a live package of the same name (case-insensitive) rather than the file's spelling: measured, a QuickLoad of `00_training.dxs`
      // in the level `00_Training` printed `Level 00_Training.MyLevel` and `Possessed PlayerPawn: ... 00_Training.JCDentonMale1`, while the same load from DXOnly
      // (no live package of that name) printed `00_training`. (docs/travel.md "Play, step 4")
      restore: { file: file.name, name: loadgame.mapName,
        ...(packageName && lower(packageName()) === lower(file.name.replace(/\.dxs$/i, '')) ? { package: packageName() } : {}) },
      loadgame: { index: loadgame.index, dir: copied?.dir ?? saveSlotDirectory(loadgame.index), fetch: copied?.fetch ?? [] } };
  }

  return {
    /** The travel step: null when the viewport has no TravelURL, else the request for the next level (or a TravelStop). */
    run() {
      const vp = viewport();
      const travelURL = vp.travelURL;
      if (!travelURL) return null;
      const travelInfo = new Map();
      if (lower(travelURL) === '?restart') for (const [key, text] of level.travelInfo ?? []) travelInfo.set(key, text);
      else if (vp.bTravelItems) {
        const player = read(vp, 'Actor');
        const name = String(read(read(player, 'PlayerReplicationInfo'), 'PlayerName'));
        log('Log', `Export travel for: ${name}`);
        travelInfo.set(name, formatTravelText(exporter.exportTravel(player).records));
      }
      lastURL.op = lastURL.op.filter(option => lower(option) !== 'loadonly');
      lastURL.portal = '';
      let url;
      // an absolute URL logs each player option it takes from LastURL (`URL: Adding default option Name=Player` before `Browse: Index.dx?loadgame=77?...`)
      try { url = parseFurl(lastURL, travelURL, vp.travelType ?? TRAVEL_RELATIVE, { log: option => log('Log', `URL: Adding default option ${option}`) }); }
      catch (error) {
        if (error instanceof UnsupportedFurlForm) throw new TravelStop('FURL::FURL', error.message, { url: travelURL });
        throw error;
      }
      const request = browse(url, travelInfo);
      vp.travelURL = '';
      // The process's class defaults go with every LoadMap Browse makes (a map, a level filed in Current, a loaded game): the next level's
      // runtime builds its classes from them (docs/travel.md "Class defaults across a travel").
      if (request) request.classDefaults = runtime.classDefaultsForTravel();
      return request;
    },
  };
}

export { Furl };
