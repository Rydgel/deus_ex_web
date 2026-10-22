/** DDeusExGameEngine::Browse (DeusEx.dll 0x10010b90) as a pure decision. docs/travel.md "Browse: the DeusEx override" and
 * "Which branch each single-player entry takes" are the evidence (script, native listing and the measured logs). The
 * function takes what Browse reads (the URL, the engine's LastURL, the level being left, the player, the files in
 * `Save\Current`) and returns what it does, in order, as data; travel.mjs executes the effects. Branches Play does not
 * implement come back as a `boundary` effect that names the original body, never as a substitute.
 *
 * Effects, in the order the original performs them:
 *   {op: 'log', text}                  Logf (the engine log: docs/travel.md "What each travel did")
 *   {op: 'deleteSaveGameFiles'}        DeleteSaveGameFiles(""): the `Current` directory is emptied
 *   {op: 'clearStartingNewGame'}       the looked-up player's bStartingNewGame (DeusExPlayer +0xaf8 bit 0) is cleared
 *   {op: 'pruneTravelActors'}          PruneTravelActors (DeusEx.dll 0x1000f9b0): the player's managers, flag base and carried decoration go
 *   {op: 'saveCurrentLevel', position} SaveCurrentLevel(-2) (0x1000fac0): the level left is written to `Save\Current\<MapName>.dxs`
 *   {op: 'loadMap', url, travelInfo, saved}  LoadMap(URL, NULL, TravelInfo, Error); `travelInfo` 'argument' (the Browse argument) or 'level'
 *                                      (a ?restart reuses the TravelInfo the level was loaded with, which the tick passes). `saved`, only in
 *                                      the same-mission branch: {name, file, url}; after the save, a level filed as `file` in `Current` is loaded
 *                                      from there with `url` (FURL(&URL, path, TRAVEL_Partial), Portal copied back), else `url` is loaded fresh
 *   {op: 'boundary', name, reason}     a branch that is not implemented; execution stops there
 *
 * The retry after a failed LoadMap (the old map's name replaces URL.Map, 0x10011e38) is not part of the decision: a failed
 * load is a boundary in the executor (docs/travel.md "Unresolved" 9). */
import { Furl, savedLevelUrl, SAVE_EXTENSION } from './furl.mjs';

/** DDeusExGameEngine::GetNextMissionNumber 0x10011ef0: -1 for an empty name or when the first two characters are not both
 * digits, else atoi(Left(name, 2)). (`dx`, `dxonly`, `entry` are -1; `00_Training` is 0; `99_Endgame1` is 99.) */
export function getNextMissionNumber(name) {
  const text = String(name ?? '');
  if (text.length === 0 || !/^[0-9]{2}/.test(text)) return -1;
  return parseInt(text.slice(0, 2), 10);
}

/** GetCurrentMissionNumber: the DeusExLevelInfo's missionNumber (+0x33c), or -1 with no level (or no level info). */
export function getCurrentMissionNumber(level) {
  return level?.info ? level.info.missionNumber | 0 : -1;
}

const boundary = (name, reason) => ({ op: 'boundary', name, reason });

/**
 * @param {Furl} url                 the URL Browse was called with
 * @param {Furl} lastURL             the engine's LastURL (its portal feeds the ?restart URL)
 * @param {{info: ({missionNumber:number, mapName:string}|null), urlMap: string}|null} level  GLevel: its DeusExLevelInfo
 *        (missionNumber, MapName) and URL.Map; null before the first level is loaded
 * @param {{bStartingNewGame: boolean}|null} player  Client->Viewports(0)->Actor, null-safe
 */
export function browseDecision({ url, lastURL, level = null, player = null }) {
  const effects = [];
  if (!(url instanceof Furl)) throw new TypeError('browseDecision requires a Furl');
  // 2. ?restart: the level reloaded from its file with `loadonly` (the travel text is not read back), `Current` emptied.
  if (url.hasOption('restart')) {
    const info = level?.info ?? null;
    const next = info ? new Furl({ map: info.mapName, portal: lastURL?.portal ?? '', op: ['loadonly'], protocol: url.protocol, host: url.host, port: url.port })
      : (lastURL ?? url).clone();
    effects.push({ op: 'deleteSaveGameFiles' }, { op: 'loadMap', url: next, travelInfo: 'level' });
    return effects;
  }
  // 3. ?loadgame=N: the slot copied over `Current`, the saved level loaded (Stage 6, docs/travel.md order step 4).
  if (url.getOption('loadgame=') !== null) {
    effects.push(boundary('DDeusExGameEngine::Browse loadgame', 'loading a saved game is not implemented (docs/travel.md order step 4)'));
    return effects;
  }
  // 4. A URL that is neither `load=` nor local-internal ends in ServerOpen / InvalidURL (multiplayer, unsupported).
  const loadOption = url.getOption('load=');
  if (loadOption === null && !url.isLocal) {
    effects.push(boundary('DDeusExGameEngine::Browse network URL', 'a network or external URL is multiplayer, which is unsupported'));
    return effects;
  }
  // 5. The mission logic.
  const nextMap = loadOption ?? url.map;
  const cur = getCurrentMissionNumber(level), next = getNextMissionNumber(nextMap);
  effects.push({ op: 'log', text: 'Doing load, not loadgame' });
  effects.push({ op: 'log', text: `Current mission number is ${cur}, next is ${next}` });
  let wipePlayer = null;
  if (next !== -1 && !url.hasOption('loadonly')) {
    effects.push({ op: 'log', text: 'Attempting to get player' });
    wipePlayer = player;
    if (next === cur && !(player && player.bStartingNewGame)) {
      // Within one mission: the level left is filed in `Current` (PruneTravelActors, SaveCurrentLevel(-2)) and a level filed for the
      // destination is restored instead of the fresh .dx (0x10011716..): which of the two happens depends on the directory after the save, so
      // the executor looks (a map may be filed under the name of the level it just left).
      const name = String(nextMap).replace(/\.dx$/i, '');
      effects.push({ op: 'pruneTravelActors' }, { op: 'saveCurrentLevel', position: -2 });
      effects.push({ op: 'loadMap', url, travelInfo: 'argument', saved: { name, file: `${name}.${SAVE_EXTENSION}`, url: savedLevelUrl(url, name) } });
      return effects;
    }
  }
  // Otherwise (next == -1, loadonly, another mission, or bStartingNewGame): `Current` is wiped, the player's flag cleared.
  effects.push({ op: 'deleteSaveGameFiles' });
  if (wipePlayer) effects.push({ op: 'clearStartingNewGame' });
  effects.push({ op: 'loadMap', url, travelInfo: 'argument' });
  return effects;
}
