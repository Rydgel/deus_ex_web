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
 * Not ported, and refused with {@link UnsupportedFurlForm} rather than approximated (docs/travel.md "Unresolved" 1): a
 * protocol or host (`unreal://`), a path (`..\Save\Current\X.dxs`, the `?loadgame=` / `?load` forms), a `.dx` suffix, a
 * space before the `#` (measured to load, with the space kept in `Map`), and a text with both a portal and options. The
 * order of the portal and the options in {@link Furl#toString} is the one `FURL::String` is remembered to use and is
 * **unverified**: only option-only URLs were measured.
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
 * and `-` only. Everything else the installed data holds (`.dx`, a space) is a refused form. */
const NAME = /^[A-Za-z0-9_-]+$/;

/** FURL(Base, TextURL, Type). `base` is a Furl (the engine's LastURL) or null; `defaults` the `[DefaultPlayer]` options added when absent. */
export function parseFurl(base, text, type, { defaults = DEFAULT_PLAYER_OPTIONS } = {}) {
  text = String(text ?? '');
  if (!Number.isInteger(type) || type < 0 || type > 2) throw new TypeError(`FURL travel type ${type}`);
  if (/[\\/:\s]/.test(text.replace(/=[^?#]*/g, ''))) throw new UnsupportedFurlForm(text, 'protocol, path or space');
  const hash = text.indexOf('#'), query = text.indexOf('?');
  if (hash >= 0 && query >= 0) throw new UnsupportedFurlForm(text, 'portal together with options');
  let mapText = text, portalText = null, options = [];
  if (hash >= 0) { mapText = text.slice(0, hash); portalText = text.slice(hash + 1); }
  else if (query >= 0) { mapText = text.slice(0, query); options = text.slice(query + 1).split('?').filter(Boolean); }
  if (mapText && !NAME.test(mapText)) throw new UnsupportedFurlForm(text, mapText.includes('.') ? 'file extension' : 'map name characters');
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
