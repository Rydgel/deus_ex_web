/** FURL (Engine.dll `FURL::FURL(FURL* Base, const TCHAR* TextURL, ETravelType Type)`, body 0x103f7b60), for plain
 * `Map`, `Map#Portal`, `?option` and `Map?option` texts. docs/travel.md "The engine tick's travel step" and "FURL and the level's URL".
 *
 * Read from the original: the fields start at the `[URL]` defaults (0x103f7b9b..0x103f7cdb: DefaultProtocol `deusex`, DefaultHost, DefaultPort 7790,
 * DefaultMap `Index.dx`, DefaultPortal; Valid 1). `TRAVEL_Relative` (`Type == 2`, 0x103f7d22) copies the base's protocol, host, map, portal and port
 * (0x103f7d4a..0x103f7ed0) and then falls into the option copy (`jmp 0x103f7edb`); `TRAVEL_Partial` (`Type == 1`, 0x103f7ed2) only copies the options:
 * every base option but those equal (`appStricmp`, the whole text) to `PUSH`, `POP`, `PEER` or `LOAD` (0x103f7f2b..0x103f7fbc), in the base's order;
 * `TRAVEL_Absolute` copies nothing. The text then supplies the map, `#portal` and `?options` (after the copied ones). Only a `TRAVEL_Absolute` URL with a
 * base and an internal protocol then takes the base's player options (0x103f8900..0x103f8b66): each base option that starts (`appStrnicmp`) with `Name=`,
 * `Team=`, `Class=`, `Skin=`, `Face=`, `Voice=` or `OverrideClass=` and whose key the new URL has no non-empty value for is logged `URL: Adding default
 * option %s` and appended. Measured: `Browse: ..\Save\Current\00_Training.dxs?Name=Player?Class=DeusEx.JCDentonMale?restart` (a relative `?restart`:
 * the base's options before the text's), `Browse: 04_NYC_UNATCOIsland.dx` (a relative travel whose LastURL had no options: none added),
 * `URL: Adding default option Name=Player` before `Browse: Index.dx?loadgame=77?Name=Player?...` (the absolute `?loadgame=77`). The tick clears
 * `LastURL.Portal` before it builds the URL (0x10390b3c), which is why the base's portal never leaks into a relative travel.
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

/** FURL::DefaultMap, measured in `Browse: Index.dx?loadgame=77` (docs/travel.md "Load game, restart and URL forms"). DefaultProtocol and DefaultPort are
 * DeusEx.ini `[URL] Protocol=deusex` and `Port=7790`, the values the original's saved levels hold in their URL (measured in its own `.dxs` files and the
 * installed maps). */
export const DEFAULT_MAP = 'Index.dx';
export const DEFAULT_PROTOCOL = 'deusex';
export const DEFAULT_PORT = 7790;
/** The base options a relative or partial URL does not carry: compared with `appStricmp` against the whole option (0x103f7f31..0x103f7fbc). */
const NOT_COPIED = ['push', 'pop', 'peer', 'load'];
/** The player options an absolute URL takes from its base when it lacks them (0x103f895f..0x103f8a5b, `appStrnicmp` with the key's length). */
const PLAYER_OPTION_KEYS = ['name=', 'team=', 'class=', 'skin=', 'face=', 'voice=', 'overrideclass='];
/** [DefaultPlayer] Name and Class as the installed User.ini holds them: the options the boot's URL has (UGameEngine::Init) and so the cold LastURL Play
 * starts from (measured in every Browse line of a session that has not restarted a level). */
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

export class Furl {
  constructor({ protocol = DEFAULT_PROTOCOL, host = '', port = DEFAULT_PORT, map = DEFAULT_MAP, op = [], portal = '', valid = 1 } = {}) {
    Object.assign(this, { protocol, host, port, map, op: [...op], portal, valid });
  }
  /** FURL::HasOption (0x103f9df0): an option equal to the text, `appStricmp` over the whole option (0x103f9e3b), so `loadgame=3` is not `loadgame`. */
  hasOption(name) {
    const key = lower(name);
    return this.op.some(option => lower(option) === key);
  }
  /** FURL::GetOption(Match, Default) (0x103f9ee0): the text after `Match` in the first option that starts with it (`appStrnicmp` over `appStrlen(Match)`,
   * 0x103f9f35..0x103f9f52), so `GetOption("load")` answers for `load`, `loadonly` and `loadgame` alike (the empty text for `load` itself). */
  getOption(match, fallback = null) {
    const prefix = lower(match);
    for (const option of this.op) if (lower(option).startsWith(prefix)) return option.slice(match.length);
    return fallback;
  }
  /** FURL::IsInternal (0x103f97b0): the protocol is FURL::DefaultProtocol (`appStricmp`). */
  get isInternal() { return lower(this.protocol) === lower(DEFAULT_PROTOCOL); }
  /** FURL::IsLocalInternal (0x103f9890): internal and no host. */
  get isLocal() { return this.isInternal && this.host === ''; }
  clone() { return new Furl(this); }
  /** The fields as plain data (a travel request crosses the page/worker boundary by structuredClone). */
  toPlain() { return { protocol: this.protocol, host: this.host, port: this.port, map: this.map, op: [...this.op], portal: this.portal, valid: this.valid }; }
  /** The text `Browse:` and `LoadMap:` print: the map, every option, then the portal (FURL::String 0x103f9210). */
  toString() {
    return `${this.map}${this.op.map(option => `?${option}`).join('')}${this.portal ? `#${this.portal}` : ''}`;
  }
}

/** The options FURL(Base, ..., TRAVEL_Relative or TRAVEL_Partial) copies from its base: all but PUSH, POP, PEER and LOAD (each compared whole). */
const copiedOptions = base => base.op.filter(option => !NOT_COPIED.includes(lower(option)));

/** TRAVEL_Absolute's player options from the base (0x103f8900..0x103f8b66; only with a base and an internal URL, 0x103f8900..0x103f8920): for each base
 * option that starts with a player key, the text before its `=` (appStrncpy to the `=`, 0x103f8a88..0x103f8ac8) is looked up in `out` with
 * `GetOption(key, "")`; when that is empty (`appStrcmp`, 0x103f8b17) the option is logged and appended. `log(option)` gets each one. */
function addBaseOptions(out, base, log) {
  if (!base || !out.isInternal) return;
  for (const option of base.op) {
    const text = lower(option);
    if (!PLAYER_OPTION_KEYS.some(k => text.startsWith(k))) continue;
    if (out.getOption(option.slice(0, option.indexOf('=')), '') !== '') continue;
    log?.(option);
    out.op.push(option);
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

/** FURL(Base, TextURL, Type). `base` is a Furl (the engine's LastURL) or null; `log(option)` receives each player option an absolute URL takes from it. */
export function parseFurl(base, text, type, { log = null } = {}) {
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
    if (type === TRAVEL_RELATIVE) Object.assign(out, { protocol: base.protocol, host: base.host, map: base.map, portal: base.portal, port: base.port });
    out.op = copiedOptions(base);
  }
  if (mapText) out.map = mapText;
  if (portalText !== null) out.portal = portalText;
  out.op.push(...options);
  if (type === TRAVEL_ABSOLUTE) addBaseOptions(out, base, log);
  return out;
}

/** UGameEngine::LoadMap's level URL (0x1038ce8b..0x1038ceed): `if (!URL.GetOption(L"load", NULL)) GLevel->URL = URL;` (GLevel is the engine's +0x68,
 * ULevelBase::URL its +0x44, assigned field by field). A URL with any option that starts with `load` (case-insensitive: `load`, `loadonly`, `loadgame`)
 * leaves the level the URL its file holds (ULevel::Serialize): a saved `.dxs` its saved URL, an installed map `deusex://Index.dx:7790` (87 maps;
 * 99_Endgame4.dx holds `unreal://Index.unr:7777`). `fileUrl` is readLevel's `url` (options as `options`) and `urlValid`. Returns a plain URL. */
export function levelUrlAfterLoad(loadUrl, fileUrl, fileValid = 1) {
  const url = loadUrl instanceof Furl ? loadUrl : new Furl(loadUrl);
  if (url.getOption('load') !== null)
    return new Furl({ protocol: fileUrl.protocol, host: fileUrl.host, port: fileUrl.port, map: fileUrl.map, portal: fileUrl.portal, op: fileUrl.options ?? fileUrl.op ?? [],
      valid: fileValid }).toPlain();
  return url.toPlain();
}

/** FURL::DefaultSaveExt (the `dxs` of every saved level) and `GSys->SavePath` (`DeusEx.ini` `[Core.System] SavePath`). */
export const SAVE_EXTENSION = 'dxs';
export const SAVE_PATH = '..\\Save';

/** The URL Browse loads a filed level with (DDeusExGameEngine::Browse 0x10011716..): `FURL(&URL, "<SavePath>\\Current\\<name>.dxs", TRAVEL_Partial)`
 * with the portal of the URL copied back. The only path form Play parses: TRAVEL_Partial keeps the base's options (but PUSH, POP, PEER and LOAD), the
 * protocol, host and port are the defaults, and the text supplies the map. Measured:
 * `LoadMap: ..\Save\Current\01_NYC_UNATCOIsland.dxs?Name=Player?Class=DeusEx.JCDentonMale` (docs/travel.md "Restoring a level"). */
export function savedLevelUrl(base, name) {
  return new Furl({ map: `${SAVE_PATH}\\Current\\${name}.${SAVE_EXTENSION}`, op: copiedOptions(base), portal: base.portal });
}

/** The URL Browse loads a saved game with (`?loadgame=N`, DDeusExGameEngine::Browse 0x10010f4f..0x1001151e): `FURL(&URL, "<SavePath>\\Current\\<MapName>.dxs?load?loadonly?loadgame",
 * TRAVEL_Absolute)`. TRAVEL_Absolute copies nothing, the text supplies the map and the three options, and the constructor adds the player options of
 * its base, the Browse URL. Measured: `URL: Adding default option Name=Player`, `... Class=DeusEx.JCDentonMale`, then
 * `LoadMap: ..\Save\Current\01_NYC_UNATCOIsland.dxs?load?loadonly?loadgame?Name=Player?Class=DeusEx.JCDentonMale` (docs/travel.md
 * "Load game, restart and URL forms"). `mapName` is the slot's DeusExSaveInfo.MapName. */
export function loadGameUrl(mapName, base, { log = null } = {}) {
  const out = new Furl({ map: `${SAVE_PATH}\\Current\\${mapName}.${SAVE_EXTENSION}`, op: ['load', 'loadonly', 'loadgame'] });
  addBaseOptions(out, base, log);
  return out;
}
