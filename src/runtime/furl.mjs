/** FURL (Engine.dll `FURL::FURL(FURL* Base, const TCHAR* TextURL, ETravelType Type)`, body 0x103f7b60), for plain
 * `Map`, `Map#Portal`, `?option` and `Map?option` texts. docs/travel.md "The engine tick's travel step".
 *
 * Read from the original (docs/travel.md): `TRAVEL_Relative` copies the base's protocol, host, port, map and portal and
 * keeps no options; `TRAVEL_Partial` copies protocol, host, port and the base's options except PUSH, POP, PEER and LOAD;
 * `TRAVEL_Absolute` copies nothing; the text then supplies the map, `#portal` and `?options`. The constructor adds the
 * `[DefaultPlayer]` `Name=` and `Class=` options to a URL that lacks them (measured: `Browse: 00_Training?Name=Player?
 * Class=DeusEx.JCDentonMale`). The tick clears `LastURL.Portal` before it builds the URL (0x10390b3c), which is why the
 * base's portal never leaks into a relative travel.
 *
 * A *pure filename* head (`Map.dx`, `Map.dx ` before a `#`; Engine.dll 0x103f8680..0x103f875d: the first `.` of the head is followed by
 * the map extension `dx` (or the save extension `dxs`) and then a character that is not a letter or digit, so the host and port
 * parsing is skipped) keeps its text as the map, the extension and the blank included: measured `URL.Map` `04_NYC_UNATCOIsland.dx` and
 * `15_area51_bunker.dx ` (docs/travel.md "Load game, restart and URL forms"). {@link mapFileStem} is the file such a map names.
 *
 * Not ported, and refused with {@link UnsupportedFurlForm} rather than approximated (docs/travel.md "Unresolved" 1): a
 * protocol or host (`unreal://`), a path (`..\Save\Current\X.dxs`, the `?loadgame=` / `?load` forms), other blanks, and a text
 * with both a portal and options. {@link Furl#toString} follows FURL::String (0x103f9210): the map, each option behind a `?`, then
 * `#` and the portal.
 *
 * `TRAVEL_*` are Engine/Actor.uc ETravelType (Absolute 0, Partial 1, Relative 2). */
export const TRAVEL_ABSOLUTE = 0, TRAVEL_PARTIAL = 1, TRAVEL_RELATIVE = 2;

/** FURL::DefaultMap, measured in `Browse: Index.dx?loadgame=77` (docs/travel.md "Load game, restart and URL forms"). */
export const DEFAULT_MAP = 'Index.dx';
export const DEFAULT_PROTOCOL = 'unreal';
export const DEFAULT_PORT = 7777;
/** The base options a partial travel does not carry (docs/travel.md). */
const PARTIAL_DROPPED = ['push', 'pop', 'peer', 'load'];
/** [DefaultPlayer] Name and Class as the installed User.ini holds them (docs/travel.md; measured in every Browse line). */
export const DEFAULT_PLAYER_OPTIONS = Object.freeze([Object.freeze(['Name', 'Player']), Object.freeze(['Class', 'DeusEx.JCDentonMale'])]);

export class UnsupportedFurlForm extends Error {
  constructor(text, reason) {
    super(`FURL form is not supported (${reason}): ${JSON.stringify(text)}`);
    this.name = 'UnsupportedFurlForm';
    this.text = text;
    this.reason = reason;
  }
}

const lower = value => String(value ?? '').toLowerCase();
const optionKey = option => lower(option).split('=')[0];

export class Furl {
  constructor({ protocol = DEFAULT_PROTOCOL, host = '', port = DEFAULT_PORT, map = DEFAULT_MAP, op = [], portal = '' } = {}) {
    Object.assign(this, { protocol, host, port, map, op: [...op], portal });
  }
  /** FURL::HasOption: an option equal to the key, or the key with a value (`restart`, `loadonly`, `loadgame=3`). */
  hasOption(name) {
    const key = lower(name);
    return this.op.some(option => optionKey(option) === key);
  }
  /** FURL::GetOption(Match, Default): the text after `Match` (for instance `loadgame=`) in the first option that starts with it. */
  getOption(match, fallback = null) {
    const prefix = lower(match);
    for (const option of this.op) if (lower(option).startsWith(prefix)) return option.slice(match.length);
    return fallback;
  }
  /** FURL::IsLocalInternal for the supported forms: no host and the default protocol. */
  get isLocal() { return this.host === '' && this.protocol === DEFAULT_PROTOCOL; }
  clone() { return new Furl(this); }
  /** The text `Browse:` and `LoadMap:` print: the map, every option, then the portal (the order is unverified, see above). */
  toString() {
    return `${this.map}${this.op.map(option => `?${option}`).join('')}${this.portal ? `#${this.portal}` : ''}`;
  }
}

/** The map and portal of the installed `Map` / `Map#Portal` strings (SendPlayer, MapExit, Teleporter): letters, digits, `_`
 * and `-`; a head may carry the map extension (`Map.dx`) and blanks after it (`Map.dx #Portal`, three installed MapExits and five Teleporters). */
const NAME = /^[A-Za-z0-9_-]+$/;
const FILE_HEAD = /^[A-Za-z0-9_-]+\.dx +$|^[A-Za-z0-9_-]+\.dx$/;

/** The level file a URL's map names: DDeusExGameEngine::Browse cuts the map at the first `.dx` (`appStrstr`, case-sensitive, 0x100119d7..0x10011a3c) for the
 * name of a filed level, and the file system drops the blanks after an extension (`15_area51_bunker.dx ` opens `15_area51_bunker.dx`). */
export function mapFileStem(map) {
  const text = String(map ?? ''), dx = text.indexOf('.dx');
  return (dx >= 0 ? text.slice(0, dx) : text).trimEnd();
}

/** FURL(Base, TextURL, Type). `base` is a Furl (the engine's LastURL) or null; `defaults` the `[DefaultPlayer]` options added when absent. */
export function parseFurl(base, text, type, { defaults = DEFAULT_PLAYER_OPTIONS } = {}) {
  text = String(text ?? '');
  if (!Number.isInteger(type) || type < 0 || type > 2) throw new TypeError(`FURL travel type ${type}`);
  // The head ends at the first `?` or `#` (0x103f803d..0x103f8065); leading blanks are skipped (0x103f8029)
  text = text.replace(/^ +/, '');
  const hash = text.indexOf('#'), query = text.indexOf('?');
  if (hash >= 0 && query >= 0) throw new UnsupportedFurlForm(text, 'portal together with options');
  let mapText = text, portalText = null, options = [];
  if (hash >= 0) { mapText = text.slice(0, hash); portalText = text.slice(hash + 1); }
  else if (query >= 0) { mapText = text.slice(0, query); options = text.slice(query + 1).split('?').filter(Boolean); }
  if (/[\\/:]/.test(mapText) || (/\s/.test(mapText) && !FILE_HEAD.test(mapText))) throw new UnsupportedFurlForm(text, 'protocol, path or space');
  if (/[\\/:\s]/.test(options.join('?').replace(/=[^?#]*/g, '')) || (portalText !== null && /[\\/:\s]/.test(portalText))) throw new UnsupportedFurlForm(text, 'protocol, path or space');
  if (mapText && !NAME.test(mapText) && !FILE_HEAD.test(mapText)) throw new UnsupportedFurlForm(text, mapText.includes('.') ? 'file extension' : 'map name characters');
  if (portalText !== null && !NAME.test(portalText)) throw new UnsupportedFurlForm(text, 'portal characters');
  const out = new Furl();
  if (type !== TRAVEL_ABSOLUTE && base) {
    Object.assign(out, { protocol: base.protocol, host: base.host, port: base.port });
    if (type === TRAVEL_RELATIVE) { out.map = base.map; out.portal = base.portal; }
    else out.op = base.op.filter(option => !PARTIAL_DROPPED.includes(optionKey(option)));
  }
  if (mapText) out.map = mapText;
  if (portalText !== null) out.portal = portalText;
  out.op.push(...options);
  for (const [name, value] of defaults)
    if (!out.op.some(option => lower(option).startsWith(`${lower(name)}=`))) out.op.push(`${name}=${value}`);
  return out;
}

/** FURL::DefaultSaveExt (the `dxs` of every saved level) and `GSys->SavePath` (`DeusEx.ini` `[Core.System] SavePath`). */
export const SAVE_EXTENSION = 'dxs';
export const SAVE_PATH = '..\\Save';

/** The URL Browse loads a filed level with (DDeusExGameEngine::Browse 0x10011716..): `FURL(&URL, "<SavePath>\\Current\\<name>.dxs", TRAVEL_Partial)`
 * with the portal of the URL copied back. The only path form Play parses: TRAVEL_Partial keeps the base's protocol, host, port and options (but
 * PUSH, POP, PEER and LOAD) and the text supplies the map, so the result is the base with the file as its map. Measured:
 * `LoadMap: ..\Save\Current\01_NYC_UNATCOIsland.dxs?Name=Player?Class=DeusEx.JCDentonMale` (docs/travel.md "Restoring a level"). */
export function savedLevelUrl(base, name) {
  const out = new Furl({ protocol: base.protocol, host: base.host, port: base.port, map: `${SAVE_PATH}\\Current\\${name}.${SAVE_EXTENSION}`,
    op: base.op.filter(option => !PARTIAL_DROPPED.includes(optionKey(option))), portal: base.portal });
  return out;
}

/** The URL Browse loads a saved game with (`?loadgame=N`, DDeusExGameEngine::Browse 0x10010f4f..0x1001151e): `FURL(&URL, "<SavePath>\\Current\\<MapName>.dxs?load?loadonly?loadgame",
 * TRAVEL_Absolute)`. TRAVEL_Absolute copies nothing, the text supplies the map and the three options, and the constructor adds the `[DefaultPlayer]`
 * options. Measured: `LoadMap: ..\Save\Current\01_NYC_UNATCOIsland.dxs?load?loadonly?loadgame?Name=Player?Class=DeusEx.JCDentonMale` (docs/travel.md
 * "Load game, restart and URL forms"). `mapName` is the slot's DeusExSaveInfo.MapName. */
export function loadGameUrl(mapName, { defaults = DEFAULT_PLAYER_OPTIONS } = {}) {
  const out = new Furl({ map: `${SAVE_PATH}\\Current\\${mapName}.${SAVE_EXTENSION}`, op: ['load', 'loadonly', 'loadgame'] });
  for (const [name, value] of defaults) out.op.push(`${name}=${value}`);
  return out;
}
