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
 * A `loadMap` effect hands the page the next level: `{map, portal, url, options, travelInfo, lastURL, log}` (the page's loadMap
 * builds the new session, whose Login imports the text: travel-import.mjs). A branch that is not implemented is a thrown
 * {@link TravelStop} that names the original body; the viewport keeps its TravelURL, and a refused URL form (furl.mjs) is one too.
 *
 * Unverified (docs/travel.md "Unresolved" 7): the engine's LastURL is only ever changed here (the `loadonly` removal and the portal
 * clear), the way the plain local-load path leaves it; the load-game and saved-level branches that assign it are not implemented. */
import { Furl, parseFurl, UnsupportedFurlForm, TRAVEL_RELATIVE } from './furl.mjs';
import { browseDecision } from './travel-browse.mjs';
import { formatTravelText } from './travel-text.mjs';

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
 */
export function createTravelStep({ runtime, level, viewport, exporter, store, log, lastURL, levelUrlMap, levelSaver = null }) {
  const read = (object, name) => runtime.readNamed(object, name);
  const levelInfo = () => {
    const actor = level.actors.find(a => a && runtime.attachedInstance(a)?.cls.record.key === 'deusex.deusexlevelinfo');
    return actor ? { missionNumber: read(actor, 'missionNumber'), mapName: String(read(actor, 'MapName')) } : null;
  };
  function browse(url, travelInfo) {
    log('Log', `Browse: ${url}`);
    const player = read(viewport(), 'Actor');
    const effects = browseDecision({ url, lastURL, level: { info: levelInfo(), urlMap: levelUrlMap() },
      player: player ? { bStartingNewGame: Boolean(read(player, 'bStartingNewGame')) } : null });
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
        case 'loadMap': {
          // Within one mission a level filed in `Current` for the destination (also the one just saved, when the destination is the level
          // left) is loaded from there: FURL(&URL, path, TRAVEL_Partial) with the portal copied back (0x10011716..).
          const restored = effect.saved && store.has(effect.saved.file) ? effect.saved : null;
          const loadUrl = restored ? restored.url : effect.url;
          log('Log', `LoadMap: ${loadUrl}`);
          const info = effect.travelInfo === 'level' ? level.travelInfo ?? new Map() : travelInfo;
          return { kind: 'loadMap', map: restored ? restored.name : effect.url.map, portal: loadUrl.portal, url: String(loadUrl), options: [...loadUrl.op],
            // on success a filed level's load sets LastURL = GLevel->URL (docs/travel.md "Browse: the DeusEx override" step 5, "Unresolved" 7); a fresh load leaves it
            travelInfo: [...info], lastURL: restored ? { map: loadUrl.map, portal: loadUrl.portal, op: [...loadUrl.op] }
              : { map: lastURL.map, portal: lastURL.portal, op: [...lastURL.op] },
            ...(restored ? { restore: { file: restored.file, name: restored.name } } : {}) };
        }
        default: throw new Error(`Unknown Browse effect ${effect.op}`);
      }
    }
    throw new Error('Browse ended without a LoadMap or a boundary');
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
      try { url = parseFurl(lastURL, travelURL, vp.travelType ?? TRAVEL_RELATIVE); }
      catch (error) {
        if (error instanceof UnsupportedFurlForm) throw new TravelStop('FURL::FURL', error.message, { url: travelURL });
        throw error;
      }
      const request = browse(url, travelInfo);
      vp.travelURL = '';
      return request;
    },
  };
}

export { Furl };
