/**
 * Console commands and the key path that reaches them, from the installed
 * GOTY binaries (docs/script-console-command.md):
 *
 *   UEngine::InputEvent         Engine 0x103814e0
 *   XInputExt::Process          Extension 0x1002d0b0   (PreProcess 0x1001c680 returns 1)
 *   UInput::ExecInputCommands   Engine 0x10393bf0
 *   UInput::Exec                Engine 0x10393e10
 *   UWindowsViewport::Exec      WinDrv 0x11106d90 -> UViewport::Exec 0x10373a60
 *   UPlayer::Exec               Engine 0x103d7ed0
 *   ULevel::Exec                Engine 0x1039dfe0
 *   DDeusExGameEngine::Exec     DeusEx 0x1000ed70 -> UGameEngine::Exec 0x1038a030
 *   UEngine::Exec               Engine 0x10380ee0, FLUSH -> UEngine::Flush 0x10380cf0
 *   ParseCommand / ParseLine / ParseToken   Core 0x10147a20 / 0x10147e60 / 0x10147ba0
 *   UStructProperty::ImportText Core 0x101698b0, over UInput::StaticInitInput's Alias struct
 *
 * Every keyword a body tests is listed in EXEC_KEYWORDS in its original
 * order (checked against the DLLs by validate-console-command.mjs). A command
 * a keyword claims, other than the handled KEYNAME, KEYBINDING, FLUSH and
 * OPEN (SetClientTravel; the Browse is UGameEngine::Tick's, game.mjs
 * clientTravel), throws UnsupportedConsoleCommandError before any of that
 * handler's work.
 */
import {gameEngineKey} from './script-window-typed-keys.mjs';
import {readToken, importText} from './config-text.mjs';
import {msvcrtWtoi} from './script-text-parser.mjs';
import {scriptStringComplementEqual, scriptStringText} from './script-string-operations.mjs';
import {x87load, x87double, x87mul, x87div, x87store, x87add, x87cmp} from './script-vm.mjs';

export class UnsupportedConsoleCommandError extends Error {
  constructor(message, {body = null, keyword = null} = {}) {
    super(message);
    this.name = 'UnsupportedConsoleCommandError';
    this.body = body;
    this.keyword = keyword;
  }
}

/** The DirectDraw display-mode enumeration UD3DRenderDevice keeps (`EnumDisplayModes`), as a **host
 * input**: the browser has no display modes to enumerate, so the page's offer stands in. Entries are
 * {width, height, bits}; GetRes lists the 16-bit ones. Callers may supply their own through
 * `services.displayModes()`. */
export const DEFAULT_DISPLAY_MODES = Object.freeze([[640, 480], [800, 600], [1024, 768], [1280, 1024], [1600, 1200]]
  .flatMap(([width, height]) => [16, 32].map(bits => Object.freeze({width, height, bits}))));
export const IST_PRESS = 1, IST_HOLD = 2, IST_RELEASE = 3, IST_AXIS = 4;
// ETravelType (UnURL.h): TRAVEL_Absolute 0, TRAVEL_Partial 1, TRAVEL_Relative 2.
export const TRAVEL_PARTIAL = 1;

// Each body's ParseCommand keywords, in the order its fall-through path tests
// them. Keywords a body tests only after another keyword matched are not
// listed; they cannot claim a command on their own.
export const EXEC_KEYWORDS = Object.freeze({
  'UInput::Exec': ['BUTTON', 'PULSE', 'TOGGLE', 'AXIS', 'KEYNAME', 'KEYBINDING'],
  'URenderDevice::Exec': ['GetDetailTextures', 'ToggleDetailTextures'],
  // GetRes is tested only when the device holds its DirectDraw object (+0x964).
  'UD3DRenderDevice::Exec': ['GetRes', 'LodBias', 'ShowPools'],
  'UViewport::Exec': ['GETPING', 'INJECT', 'NETSPEED', 'LANSPEED', 'SHOWALL', 'REPORT', 'SHOT',
    'SHOWACTORS', 'HIDEACTORS', 'RMODE', 'EXEC'],
  'UWindowsViewport::Exec': ['EndFullscreen', 'ToggleFullscreen', 'GetCurrentRes', 'GetCurrentColorDepth',
    'GetColorDepths', 'GetCurrentRenderDevice', 'GetRes', 'SetRes', 'Preferences'],
  'ULevel::Exec': ['DEMOREC', 'DEMOPLAY'],
  'DDeusExGameEngine::Exec': ['SAVEGAME', 'DELETEGAME'],
  // SAY is tested only when GIsServer && !GIsClient (a dedicated server).
  'UGameEngine::Exec': ['OPEN', 'START', 'SERVERTRAVEL', 'DISCONNECT', 'RECONNECT', 'GETCURRENTTICKRATE',
    'GETMAXTICKRATE', 'GSPYLITE', 'SAVEGAME', 'CANCEL'],
  'USystem::Exec': ['MEMSTAT', 'CONFIGHASH', 'EXIT', 'QUIT', 'RELAUNCH', 'DEBUG'],
  'UObject::StaticExec': ['MEM', 'DUMPNATIVES', 'GET', 'SET', 'OBJ', 'GTIME'],
  'FMemCache::Exec': ['DUMPCACHE'],
  'FExecHook::Exec': ['ShowLog', 'TakeFocus', 'EditActor', 'HideLog', 'Preferences', 'MPLAYER', 'HEAT'],
  'UClient::Exec': ['BRIGHTNESS'],
  'URender::Exec': ['STAT', 'REND', 'TLOD', 'MLOD', 'MLMODE', 'MLFIX'],
  'UGalaxyAudioSubsystem::Exec': ['CDTRACK', 'CDVOLUME', 'MUSICORDER', 'RECORDSOUND', 'ENDRECORDSOUND', 'ASTAT'],
  // Galaxy's tail call 0x10601145(Cmd, Ar, 1).
  'Galaxy 0x106019b0': ['s_occfactor', 's_maxnodedist', 's_reflect', 's_occlude', 's_wavetracing', 's_refgain',
    's_refdelay', 's_maxpoly', 's_maxreflectpoly', 's_polysmall', 's_polylarge', 's_polyreflect', 's_a3dsources'],
  'UEngine::Exec': ['FLUSH', 'CRACKURL'],
});

const nonAscii = /[^\x00-\x7f]/;
const equalName = (left, right) => {
  if (nonAscii.test(left) || nonAscii.test(right)) throw new UnsupportedConsoleCommandError('Non-ASCII FName folding is not recovered');
  return scriptStringComplementEqual(left, right);
};

/** Core ParseCommand 0x10147a20: space/tab skip, case-insensitive keyword,
 * no ASCII letter/digit right after it, then space/tab skip. Returns the text
 * after the keyword, or null (the stream is not advanced). */
export function parseCommand(text, keyword) {
  const start = text.replace(/^[ \t]*/, '');
  if (!scriptStringComplementEqual(start.slice(0, keyword.length), keyword)) return null;
  const rest = start.slice(keyword.length);
  if (/^[a-zA-Z0-9]/.test(rest)) return null;
  return rest.replace(/^[ \t]*/, '');
}

/** Core ParseLine 0x10147e60 (thunk 0x10103125). Unless Exact, `//` starts an
 * ignored comment and `|` ends the line, both outside quotes; afterwards every
 * CR, LF and `|` is skipped. Exact eats one CR then one LF. At most MaxLen-1
 * characters are kept. */
export function parseLine(stream, maxLength = 256, exact = false) {
  let at = 0, line = '', quoted = false, ignore = false, got = false, room = maxLength;
  while (at < stream.length && stream[at] !== '\n' && stream[at] !== '\r' && --room > 0) {
    const c = stream[at];
    if (!quoted && !exact) {
      if (c === '/' && stream[at + 1] === '/') ignore = true;
      if (c === '|') break;
    }
    quoted = quoted !== (c === '"');
    got = true;
    if (!ignore) line += c;
    at++;
  }
  if (exact) {
    if (stream[at] === '\r') at++;
    if (stream[at] === '\n') at++;
  } else while (stream[at] === '\n' || stream[at] === '\r' || stream[at] === '|') at++;
  return {line, rest: stream.slice(at), ok: at < stream.length || got};
}

/** Core ParseToken 0x10147ba0: space/tab skip; a quoted token (backslash
 * escapes when UseEscape) or a run up to space/tab; at most MaxLen-1 kept.
 * True only for a nonempty token. */
export function parseToken(text, maxLength, useEscape) {
  let at = 0, token = '';
  while (text[at] === ' ' || text[at] === '\t') at++;
  if (text[at] === '"') {
    at++;
    while (at < text.length && text[at] !== '"' && token.length + 1 < maxLength) {
      let c = text[at++];
      if (c === '\\' && useEscape) {
        // The original steps past the terminator here and keeps reading the
        // memory after the string; the browser string ends instead.
        if (at >= text.length) break;
        c = text[at++];
      }
      token += c;
    }
    if (text[at] === '"') at++;
  } else {
    while (at < text.length && text[at] !== ' ' && text[at] !== '\t') {
      if (token.length + 1 < maxLength) token += text[at];
      at++;
    }
  }
  return {token, rest: text.slice(at), ok: token.length !== 0};
}

/**
 * UStructProperty::ImportText (Core 0x101698b0) into `value`, over `members`
 * in TFieldIterator order: [{name, kind: 'name'|'string', arrayDim}]. Members
 * import with PortFlags|2 (delimited). Returns the rest after ')' or null;
 * the members already imported keep their values, as the in-place original
 * does. Warnings are the GLog/GWarn texts.
 */
export function importStructText(text, members, value, warn = () => {}) {
  let at = 0;
  const fail = message => { warn(message); return null; };
  if (text[at++] !== '(') return fail("ImportText: Struct missing '('");
  for (;;) {
    if (text[at] === ')') return text.slice(at + 1);
    let name = '';
    while (name.length < 0x3f && at < text.length && text[at] !== '=' && text[at] !== '[') name += text[at++];
    // The subscript digit scan starts on the '[' itself, so any '[' fails.
    if (text[at] === '[') return fail('ImportText: Illegal array element');
    if (text[at++] !== '=') return fail('ImportText: Illegal or missing key name');
    let parsed = false;
    for (const member of members) {
      if (!equalName(member.name, name) || !(member.arrayDim > 0)) continue;
      if (member.kind !== 'name' && member.kind !== 'string')
        throw new UnsupportedConsoleCommandError(`Struct ImportText member kind ${member.kind} is not linked`);
      const imported = member.kind === 'string'
        ? delimitedString(text.slice(at), warn)
        : nameText(text.slice(at), warn);
      if (!imported) return null;
      value[member.name] = imported.value;
      at = text.length - imported.rest.length;
      parsed = true;
    }
    if (!parsed) {
      // Skip the value. The quote test starts on the quote itself, so a quote
      // is skipped as one character and a quoted ',' still ends the value.
      let depth = 0;
      while (at < text.length && text[at] !== '\n' && text[at] !== '\r') {
        const c = text[at];
        if (depth <= 0 && (c === ')' || c === ',')) break;
        if (c === '(') depth++;
        else if (c === ')' && --depth < 0) return fail('ImportText: Bad parenthesised struct');
        at++;
      }
      if (depth > 0) return fail('ImportText: Incomplete parenthesised struct');
    }
    if (text[at] === ',') { at++; continue; }
    if (text[at] === ')') continue;
    return fail('ImportText: Bad termination');
  }
}

// The token is a TCHAR buffer: FString and FName assignment end at a NUL an
// escape produced.
const cString = text => { const end = text.indexOf('\0'); return end < 0 ? text : text.slice(0, end); };

/** UStrProperty::ImportText 0x10167980 with PPF_Delimited: ReadToken(0x1000). */
function delimitedString(text, warn) {
  const read = readToken(text, 0x1000, false, warn);
  return read ? {value: cString(read.token), rest: read.rest} : null;
}

/** UNameProperty::ImportText 0x101674d0: ReadToken(0x400), FName(FNAME_Add). */
function nameText(text, warn) {
  const read = readToken(text, 0x400, false, warn);
  if (!read) return null;
  const name = cString(read.token);
  return {value: name === '' || equalName(name, 'None') ? 'None' : name, rest: read.rest};
}

/**
 * UStructProperty::ImportText (Core 0x101698b0) over a Rotator (int Pitch/Yaw/Roll) or Vector (float X/Y/Z): `(Pitch=-10130,Yaw=49096)`
 * into `value` (an array of the three components; members the text omits keep theirs). The members import as UIntProperty::ImportText
 * 0x10165f00 (appAtoi only when the text starts with '-' or a digit, then skip every '-'/digit) and UFloatProperty::ImportText 0x10166940
 * (appAtof, then skip to ',' ')' CR LF). A malformed struct warns and stops; the members already imported keep their values.
 */
export function importNumericStruct(text, names, integer, value, warn = () => {}) {
  let at = 0;
  const fail = message => { warn(message); return null; };
  if (text[at++] !== '(') return fail("ImportText: Struct missing '('");
  for (;;) {
    if (text[at] === ')') return text.slice(at + 1);
    let name = '';
    while (name.length < 0x3f && at < text.length && text[at] !== '=' && text[at] !== '[') name += text[at++];
    if (text[at] === '[') return fail('ImportText: Illegal array element');
    if (text[at++] !== '=') return fail('ImportText: Illegal or missing key name');
    const index = names.findIndex(member => equalName(member, name));
    if (index >= 0) {
      const rest = text.slice(at);
      if (integer) {
        if (/^[-0-9]/.test(rest)) value[index] = importText('int', rest).value | 0;
        while (text[at] === '-' || /[0-9]/.test(text[at] ?? '')) at++;
      } else {
        const parsed = importText('float', rest);
        value[index] = Math.fround(parsed.value);
        at = text.length - parsed.rest.length;
      }
    } else {
      let depth = 0;
      while (at < text.length && text[at] !== '\n' && text[at] !== '\r') {
        const c = text[at];
        if (depth <= 0 && (c === ')' || c === ',')) break;
        if (c === '(') depth++;
        else if (c === ')' && --depth < 0) return fail('ImportText: Bad parenthesised struct');
        at++;
      }
      if (depth > 0) return fail('ImportText: Incomplete parenthesised struct');
    }
    if (text[at] === ',') { at++; continue; }
    if (text[at] === ')') continue;
    return fail('ImportText: Bad termination');
  }
}

/** UInput::StaticInitInput 0x103930c0: `Alias` struct {Alias name +0, Command
 * string +4}, Aliases[40] at +0x2c, both CPF_Config, then LoadConfig from
 * [Engine.Input] `Aliases[i]`. Children are prepended, so Command comes first. */
export const ALIAS_MEMBERS = Object.freeze([
  {name: 'Command', kind: 'string', arrayDim: 1},
  {name: 'Alias', kind: 'name', arrayDim: 1},
]);
export const ALIAS_COUNT = 40;

/** One LoadConfig pass over `Aliases[i]`. A missing key keeps the element;
 * a present one imports over it, leaving unnamed members as they were.
 * `target` defaults to 40 fresh zero elements. */
export function readInputAliases(read, warn = () => {},
  target = Array.from({length: ALIAS_COUNT}, () => ({Alias: 'None', Command: ''}))) {
  for (let index = 0; index < ALIAS_COUNT; index++) {
    const text = read(`Aliases[${index}]`);
    if (text !== null && text !== undefined) importStructText(String(text), ALIAS_MEMBERS, target[index], warn);
  }
  return target;
}

/** FStringOutputDevice: Log/Logf append their text with no line break. */
export function stringOutputDevice() {
  return {text: '', log(text) { this.text += text; }};
}

/**
 * The dispatch over Play's objects. `input` is the prepared binding data
 * ({names, bindings, aliases, keyName, keyBinding}); `services`:
 *   viewport()               the local UViewport (Actor, Console)
 *   rootProcess(k,a,d)       XRootWindow::Process on the player's root
 *   hostBinding(k,a)         true when the browser's own stand-in owns key k
 *   flushRenderDevice(p)     the browser render device's Flush(AllowPrecache)
 */
export function createConsoleCommands({runtime, input, services}) {
  const read = (object, name) => runtime.readNamed(object, name);
  const state = {action: 0, delta: 0, inAlias: false, held: new Uint8Array(255), flushes: 0, lines: 0};

  function claims(body, cmd) {
    for (const keyword of EXEC_KEYWORDS[body])
      if (parseCommand(cmd, keyword) !== null)
        throw new UnsupportedConsoleCommandError(`${body} ${keyword} is not implemented: ${cmd}`, {body, keyword});
  }
  const scriptExec = (object, cmd, executor) => runtime.scriptConsoleExec(object, cmd, executor);

  function inputActor() {
    const viewport = services.viewport(), actor = read(viewport, 'Actor');
    if (!actor) throw new UnsupportedConsoleCommandError('UInput requires a linked viewport Actor');
    return {viewport, actor};
  }

  function findActorField(actor, name, kind) {
    const field = runtime.namedField(actor, name);
    if (!field || field.metadata.type !== kind || !(field.metadata.flags & 0x4))
      throw new UnsupportedConsoleCommandError(`UInput CPF_Input ${kind} property ${name} is not linked`);
    return field;
  }

  function readInputField(actor, field) {
    const value = runtime.readField(actor, field);
    return field.metadata.arrayDim > 1 ? value[0] : value;
  }

  function writeInputField(actor, field, value) {
    if (field.metadata.arrayDim > 1) {
      const array = runtime.readField(actor, field);
      array[0] = value;
      runtime.writeField(actor, field, array);
    } else runtime.writeField(actor, field, value);
  }

  function inputPropertyFields(instance) {
    const fields = [];
    for (let cls = instance.cls; cls; cls = cls.base) {
      for (const field of cls.propertyOrder) {
        if (field.metadata.flags & 0x4) fields.push(field);
      }
    }
    return fields;
  }

  function inputCommand(cmd) {
    const action = state.action;
    let rest = parseCommand(cmd, 'BUTTON');
    if (rest !== null) {
      const token = parseToken(rest, 256, false);
      if (!token.ok) throw new UnsupportedConsoleCommandError(`UInput BUTTON requires a property: ${cmd}`);
      const {actor} = inputActor(), field = findActorField(actor, token.token, 'byte');
      if (action === IST_PRESS) writeInputField(actor, field, 1);
      else if (action === IST_RELEASE && readInputField(actor, field) !== 0) writeInputField(actor, field, 0);
      return true;
    }
    rest = parseCommand(cmd, 'PULSE');
    if (rest !== null) {
      const token = parseToken(rest, 256, false);
      if (!token.ok) throw new UnsupportedConsoleCommandError(`UInput PULSE requires a property: ${cmd}`);
      const {actor} = inputActor(), field = findActorField(actor, token.token, 'byte');
      if (action === IST_PRESS) writeInputField(actor, field, 1);
      return true;
    }
    rest = parseCommand(cmd, 'TOGGLE');
    if (rest !== null) {
      const token = parseToken(rest, 256, false);
      if (!token.ok) throw new UnsupportedConsoleCommandError(`UInput TOGGLE requires a property: ${cmd}`);
      const {actor} = inputActor(), field = findActorField(actor, token.token, 'byte');
      if (action === IST_PRESS) writeInputField(actor, field, (readInputField(actor, field) ^ 0x80) & 0xff);
      return true;
    }
    rest = parseCommand(cmd, 'AXIS');
    if (rest !== null) {
      const property = parseToken(rest, 256, false);
      if (!property.ok) throw new UnsupportedConsoleCommandError(`UInput AXIS requires a property: ${cmd}`);
      const speedMatch = /(?:^|[\t ])Speed[\t ]*=[\t ]*([^\t ]+)/i.exec(property.rest);
      let scalar = 1;
      if (speedMatch) {
        const value = speedMatch[1];
        scalar = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
          ? Math.fround(Number(value)) : NaN;
        if (!Number.isFinite(scalar))
          throw new UnsupportedConsoleCommandError(`UInput AXIS Speed expression is not linked: ${cmd}`);
      }
      const {actor} = inputActor(), field = findActorField(actor, property.token, 'float');
      if (action === IST_HOLD || action === IST_AXIS) {
        const current = runtime.readField(actor, field), prior = x87load(field.metadata.arrayDim > 1 ? current[0] : current);
        let product = x87mul(x87load(state.delta), x87load(scalar));
        if (action === IST_AXIS) product = x87mul(product, x87double(0.01));
        const result = x87store(x87add(product, prior));
        if (field.metadata.arrayDim > 1) current[0] = result;
        runtime.writeField(actor, field, field.metadata.arrayDim > 1 ? current : result);
      }
      return true;
    }
    return false;
  }

  /** UInput::Exec 0x10393e10 (XInputExt keeps it). */
  function inputExec(cmd, ar) {
    if (inputCommand(cmd)) return true;
    let rest = parseCommand(cmd, 'KEYNAME');
    if (rest !== null) { ar.log(input.keyName(inputInteger(rest))); return true; }
    rest = parseCommand(cmd, 'KEYBINDING');
    if (rest !== null) { ar.log(input.keyBinding(rest)); return true; }
    if (state.inAlias) return false;
    const token = parseToken(cmd, 256, false);
    if (!token.ok || equalName(token.token, 'None')) return false;
    const alias = input.aliases.find(entry => entry.Alias !== 'None' && equalName(entry.Alias, token.token));
    if (!alias) return false;
    state.inAlias = true;
    try { execInputCommands(alias.Command, ar); }
    finally { state.inAlias = false; }
    return true;
  }

  /** UInput::ExecInputCommands 0x10393bf0 (GIsRunning holds in Play). */
  function execInputCommands(cmd, ar) {
    let stream = scriptStringText(cmd);
    for (;;) {
      const next = parseLine(stream, 256, false);
      if (!next.ok) return;
      stream = next.rest;
      if (state.action === IST_PRESS) viewportExec(next.line, ar);
      else {
        const rest = state.action === IST_RELEASE ? parseCommand(next.line, 'OnRelease') : null;
        if (rest !== null) viewportExec(rest, ar);
        else inputExec(next.line, ar);
      }
      state.lines++;
    }
  }

  /** UWindowsViewport::Exec 0x11106d90. Its `this` is the viewport's FExec
   * subobject (+0x2c). GetCurrentRes (0x11106e23-0x11106e63) is
   * Ar.Logf("%ix%i", SizeX +0x78, SizeY +0x7c, ...): the third argument,
   * ColorBytes +0x80 (2 when 0) times 8, has no conversion in the format. */
  function viewportExec(cmd, ar) {
    if (uviewportExec(cmd, ar)) return true;
    for (const keyword of EXEC_KEYWORDS['UWindowsViewport::Exec']) {
      if (parseCommand(cmd, keyword) === null) continue;
      if (keyword === 'SetRes') return setRes(parseCommand(cmd, 'SetRes'));
      if (keyword !== 'GetCurrentRes')
        throw new UnsupportedConsoleCommandError(`UWindowsViewport::Exec ${keyword} is not implemented: ${cmd}`,
          {body: 'UWindowsViewport::Exec', keyword});
      const {sizeX, sizeY} = services.viewportSize();
      ar.log(`${sizeX | 0}x${sizeY | 0}`);
      return true;
    }
    return false;
  }

  /** UD3DRenderDevice::Exec (D3DDrv.dll 0x100061b0): URenderDevice::Exec first, then GetRes (only with a
   * DirectDraw object, +0x964): walk the device's display modes (element 0x7c bytes), keep the 16-bit
   * ones (+0x54 == 0x10), skip a (width, height) already listed, and log up to 16 as "%ix%i" then
   * " %ix%i", each only when the device's two size limits (members filled at Init, not recovered) are not
   * below it. Then LodBias and ShowPools, which stay refused. GetColorDepths is not the device's: it
   * falls through to UWindowsViewport::Exec, also refused. The mode list is the host's
   * (DEFAULT_DISPLAY_MODES); with no size limits recovered the list is unfiltered. */
  function d3dExec(cmd, ar) {
    if (parseCommand(cmd, 'GetRes') !== null) {
      const listed = [];
      for (const mode of services.displayModes?.() ?? DEFAULT_DISPLAY_MODES)
        if (mode.bits === 16 && !listed.some(entry => entry.width === mode.width && entry.height === mode.height)) listed.push(mode);
      listed.slice(0, 16).forEach((mode, index) => ar.log(`${index ? ' ' : ''}${mode.width}x${mode.height}`));
      return true;
    }
    for (const keyword of ['LodBias', 'ShowPools'])
      if (parseCommand(cmd, keyword) !== null)
        throw new UnsupportedConsoleCommandError(`UD3DRenderDevice::Exec ${keyword} is not implemented: ${cmd}`, {body: 'UD3DRenderDevice::Exec', keyword});
    return false;
  }

  /** UWindowsViewport::Exec SetRes (WinDrv.dll 0x1110715f-0x11107291): X = appAtoi(Str); Y = appAtoi
   * after the first 'x' (or 'X'); the colour depth after the next one, ColorBytes = depth / 8 (signed
   * division) or the viewport's own when 0. With X and Y both nonzero it calls
   * RenDev->SetRes(X, Y, ColorBytes, IsFullscreen()) (vtable +0x60) and returns 1 either way. The
   * render device is the browser (D3D's stand-in): SetRes is handed to `services.setResolution` as a request for that
   * drawing-buffer size; there is no display mode to switch. */
  function setRes(rest) {
    // appStrchr(S, 'x'), else 'X', else the empty string: the text after that character.
    const afterX = text => {
      const at = text.includes('x') ? text.indexOf('x') : text.indexOf('X');
      return at >= 0 ? text.slice(at + 1) : '';
    };
    const text = String(rest), yText = afterX(text), depthText = afterX(yText);
    const width = msvcrtWtoi(text), height = msvcrtWtoi(yText), depth = msvcrtWtoi(depthText);
    if (width && height) {
      if (typeof services.setResolution !== 'function')
        throw new UnsupportedConsoleCommandError('UWindowsViewport::Exec SetRes has no render device to resize', {body: 'UWindowsViewport::Exec', keyword: 'SetRes'});
      services.setResolution({width, height, colorBytes: depth ? Math.trunc(depth / 8) : null});
    }
    return true;
  }

  /** UViewport::Exec 0x10373a60: Input (+0x60), RenDev (+0x64), its keywords,
   * Console (+0x34) with the viewport Actor as executor, then UPlayer::Exec. */
  function uviewportExec(cmd, ar) {
    const viewport = services.viewport(), actor = read(viewport, 'Actor');
    if (!actor) throw new Error('UViewport::Exec requires its Actor (UnPlayer check at line 0x1db)');
    if (inputExec(cmd, ar)) return true;
    // Play's render device (PLAY_RENDER_DEVICE): D3DRenderDevice::Exec runs URenderDevice::Exec first.
    claims('URenderDevice::Exec', cmd);
    if (d3dExec(cmd, ar)) return true;
    // 0x10373ae5-0x10373b0c: GETPING logs the literal "0" (0x1047c2b4).
    if (parseCommand(cmd, 'GETPING') !== null) { ar.log('0'); return true; }
    claims('UViewport::Exec', cmd);
    const console = read(viewport, 'Console');
    if (console && scriptExec(console, cmd, actor)) return true;
    return playerExec(cmd, ar);
  }

  /** ULevel::Exec 0x1039dfe0: NetDriver (+0x3c), DemoRecDriver (+0x88), keywords. */
  function levelExec(level, cmd) {
    if ((level.netDriver ?? null) !== null || (level.demoRecDriver ?? null) !== null)
      throw new UnsupportedConsoleCommandError('ULevel::Exec net/demo driver Exec is not implemented');
    claims('ULevel::Exec', cmd);
    return false;
  }

  /** UPlayer::Exec 0x103d7ed0. */
  function playerExec(cmd, ar) {
    const actor = read(services.viewport(), 'Actor');
    if (!actor) return false;
    const level = runtime.levelFor(actor);
    if (levelExec(level, cmd)) return true;
    const game = read(read(actor, 'Level'), 'Game');
    if (game && scriptExec(game, cmd, actor)) return true;
    const hud = read(actor, 'myHUD');
    if (hud && scriptExec(hud, cmd, actor)) return true;
    if (scriptExec(actor, cmd, actor)) return true;
    for (let item = read(actor, 'Inventory'); item; item = read(item, 'Inventory'))
      if (scriptExec(item, cmd, actor)) return true;
    return engineExec(level, read(actor, 'Level'), cmd, ar);
  }

  /** UGameEngine::SetClientTravel 0x1038fa10 (thunk 0x10303f2b): CastChecked<UViewport>(Player), then the viewport's TravelURL (+0xa0) = NextURL,
   * TravelType (+0x9c) and bTravelItems (+0xac) (0x1038faf2..0x1038fb3d). Then every slot of GLevel->Actors (Num re-read each pass, 0x1038fb4b)
   * that holds an actor whose FindFunction(PreTravel, 0) finds one (0x1038fb7b; the name at 0x1047f080) gets ProcessEvent(PreTravel, NULL)
   * (vtable +0x10, 0x1038fb95): MissionScript turns its timer off and drops its flags, DeusExPlayer sets PlayerTraveling, saves its skill points,
   * aborts a DataLink and puts its fire out, AugLight destroys its beams. The URL is browsed by UGameEngine::Tick's client travel (game.mjs
   * clientTravel), not here. */
  function setClientTravel(url, items, type) {
    const viewport = services.viewport(), actor = read(viewport, 'Actor');
    if (!actor) throw new Error('SetClientTravel requires the viewport Actor');
    viewport.travelURL = url; viewport.travelType = type; viewport.bTravelItems = items;
    // GLevel: the viewport actor's level (Play's session holds one level)
    const actors = runtime.levelFor(actor).actors;
    for (let index = 0; index < actors.length; index++) {
      const target = actors[index];
      if (!target) continue;
      const record = runtime.lookup(target, 'PreTravel');
      if (record?.function) runtime.processEvent(target, 'PreTravel', [], null, record);
    }
  }

  /** DDeusExGameEngine::Exec 0x1000ed70 -> UGameEngine::Exec 0x1038a030 ->
   * UEngine::Exec 0x10380ee0. */
  function engineExec(level, levelInfo, cmd, ar) {
    claims('DDeusExGameEngine::Exec', cmd);
    // UGameEngine::Exec's first keyword, OPEN (0x1038a061, the text at 0x1047eaa4): with a client viewport (Client +0x44, Viewports.Num +0x30)
    // SetClientTravel(Client->Viewports(0), Cmd, 0, TRAVEL_Partial) (vtable +0x88, 0x1038a0a9), Cmd past the keyword and its spaces; without one
    // it browses at once (0x1038a0d3), which Play's one-viewport session never takes. Either way it returns 1.
    const openUrl = parseCommand(cmd, 'OPEN');
    if (openUrl !== null) { setClientTravel(openUrl, 0, TRAVEL_PARTIAL); return true; }
    claims('UGameEngine::Exec', cmd);
    if (levelExec(level, cmd)) return true;
    const game = read(levelInfo, 'Game');
    if (game && scriptExec(game, cmd, null)) return true;
    // GSys, UObject::StaticExec, GCache, GExec (the launcher's FExecHook),
    // Client (UWindowsClient -> UClient), Render, Audio (Galaxy), in order.
    claims('USystem::Exec', cmd);
    if (staticExec(cmd, ar)) return true;
    for (const body of ['FMemCache::Exec', 'FExecHook::Exec',
      'UClient::Exec', 'URender::Exec', 'UGalaxyAudioSubsystem::Exec', 'Galaxy 0x106019b0'])
      claims(body, cmd);
    if (parseCommand(cmd, 'FLUSH') !== null) { flush(1); return true; }
    if (parseCommand(cmd, 'CRACKURL') !== null)
      throw new UnsupportedConsoleCommandError(`UEngine::Exec CRACKURL is not implemented: ${cmd}`, {body: 'UEngine::Exec', keyword: 'CRACKURL'});
    return false;
  }

  /** UObject::StaticExec 0x10153110 in keyword order MEM, DUMPNATIVES, GET (0x101531ad), SET
   * (0x101532da), OBJ, GTIME. GET and SET reach a native config class (script-native-config.mjs:
   * the viewport manager, audio device and render device) or, for SET, the InputExt class
   * (script-input-console.mjs). ParseToken(256, escapes) for the class, StaticFindObject(UClass,
   * ANY_PACKAGE) (which resolves "ini:Section.Key" through GConfig), ParseToken for the property,
   * FindField; a missing class or property logs its NAME_ExecWarning line and still returns 1. GET
   * then logs ExportText of the class default (port flags 1); SET skips spaces and runs
   * GlobalSetProperty(value, class, property, offset, 1). */
  function staticExec(cmd, ar) {
    for (const keyword of ['MEM', 'DUMPNATIVES'])
      if (parseCommand(cmd, keyword) !== null)
        throw new UnsupportedConsoleCommandError(`UObject::StaticExec ${keyword} is not implemented: ${cmd}`, {body: 'UObject::StaticExec', keyword});
    const config = services.nativeConfig?.();
    const getRest = parseCommand(cmd, 'GET');
    if (getRest !== null) {
      const className = parseToken(getRest, 256, true);
      if (!className.ok) { ar.log(`Unrecognized class ${className.token}`); return true; }
      const cls = nativeClass(config, className.token, 'GET', cmd);
      if (!cls) { ar.log(`Unrecognized class ${className.token}`); return true; }
      const propertyName = parseToken(className.rest, 256, true);
      if (!propertyName.ok) { ar.log(`Unrecognized property ${propertyName.token}`); return true; }
      const field = config.findField(cls, propertyName.token);
      if (!field) { ar.log(`Unrecognized property ${propertyName.token}`); return true; }
      ar.log(config.getText(cls, field));
      return true;
    }
    const rest = parseCommand(cmd, 'SET');
    if (rest === null) {
      for (const keyword of ['OBJ', 'GTIME'])
        if (parseCommand(cmd, keyword) !== null)
          throw new UnsupportedConsoleCommandError(`UObject::StaticExec ${keyword} is not implemented: ${cmd}`, {body: 'UObject::StaticExec', keyword});
      return false;
    }
    const className = parseToken(rest, 256, true);
    const native = className.ok ? nativeClass(config, className.token, 'SET', cmd, true) : null;
    if (native) {
      const propertyName = parseToken(className.rest, 256, true);
      const field = propertyName.ok ? config.findField(native, propertyName.token) : null;
      if (!field) { ar.log(`Unrecognized property ${propertyName.token}`); return true; }
      let value = propertyName.rest;
      while (value[0] === ' ') value = value.slice(1);
      config.globalSetProperty(native, field, value);
      return true;
    }
    if (className.ok && !scriptStringComplementEqual(className.token, 'InputExt')) {
      if (isIniName(className.token)) { ar.log(`Unrecognized class ${className.token}`); return true; }
      if (scriptClassSet(className.token, className.rest, cmd, ar)) return true;
      throw new UnsupportedConsoleCommandError(`UObject::StaticExec SET of class ${className.token} is not implemented: ${cmd}`, {body: 'UObject::StaticExec', keyword: 'SET'});
    }
    if (!className.ok || typeof input.findField !== 'function') { ar.log(`Unrecognized class ${className.token}`); return true; }
    const propertyName = parseToken(className.rest, 256, true);
    const field = propertyName.ok ? input.findField(propertyName.token) : null;
    if (!field) { ar.log(`Unrecognized property ${propertyName.token}`); return true; }
    let value = propertyName.rest;
    while (value[0] === ' ') value = value.slice(1);
    input.globalSetProperty(field, value);
    return true;
  }

  /** UObject::GlobalSetProperty 0x101523a0 (Immediate) for a script class (`set JCDentonMale ViewRotation (Pitch=-10130,Yaw=49096,Roll=0)`):
   * ParseToken for the property, FindField, spaces skipped, then for every object that IsA the class ImportText of the value into the property
   * followed by PostEditChange (vtable +0x40: AActor::PostEditChange 0x10369140 is UObject::PostEditChange and an Editor-only flag, a game
   * no-op). The live actors of the player's level are the objects modelled. Then the text is imported into the named class's own Defaults
   * (0x101524b1..0x101524ca: ImportText into `Class+0x4d4` plus the offset; a subclass's defaults are its own copy and keep their value), so an
   * object spawned from the class afterwards carries it (a `summon` typed after the `set`, the Player start's second Login). The
   * SaveConfig(CPF_Config) of the class that follows (0x10152505) is not modelled: it writes the class's config properties to its INI.
   * Property kinds: int (UIntProperty::ImportText 0x10165f00), float, bool, name, and the Rotator/Vector structs over int/float members
   * (UStructProperty::ImportText 0x101698b0); other kinds are not linked and throw. Returns false when no live actor IsA the class (the class
   * lookup is left to the caller's unsupported report). */
  function scriptClassSet(token, rest, cmd, ar) {
    const viewportActor = services.viewport ? read(services.viewport(), 'Actor') : null;
    if (!viewportActor) return false;
    const wanted = token.toLowerCase();
    const isA = cls => { for (let c = cls; c; c = c.base) { const key = c.record?.key?.toLowerCase(); if (key === wanted || (!wanted.includes('.') && key?.endsWith(`.${wanted}`))) return true; } return false; };
    const targets = runtime.levelFor(viewportActor).actors.filter(actor => actor && isA(runtime.instance(actor).cls));
    if (!targets.length) return false;
    const propertyName = parseToken(rest, 256, true);
    let field = null;
    if (propertyName.ok) { try { field = runtime.namedField(targets[0], propertyName.token); } catch { field = null; } }
    if (!field) { ar.log(`Unrecognized property ${propertyName.token}`); return true; }
    let value = propertyName.rest;
    while (value[0] === ' ') value = value.slice(1);
    const meta = field.metadata, kind = meta.type;
    if ((meta.arrayDim ?? 1) > 1) throw new UnsupportedConsoleCommandError(`UObject::GlobalSetProperty of a fixed array (${propertyName.token}) is not linked: ${cmd}`);
    const importInto = current => {
      let imported;
      if (kind === 'int') {
        // UIntProperty::ImportText 0x10165f00: appAtoi only when the text starts with '-' or a digit; otherwise NULL and the value stays
        imported = /^[-0-9]/.test(value) ? (importText('int', value).value | 0) : current;
      } else if (kind === 'float' || kind === 'bool' || kind === 'name') {
        const parsed = importText(kind, value);
        imported = parsed ? (kind === 'float' ? Math.fround(parsed.value) : parsed.value) : current;
      } else if (kind === 'struct' && (meta.structKey === 'core.object.rotator' || meta.structKey === 'core.object.vector')) {
        const rotator = meta.structKey === 'core.object.rotator', names = rotator ? ['Pitch', 'Yaw', 'Roll'] : ['X', 'Y', 'Z'];
        const next = [...current];
        importNumericStruct(value, names, rotator, next, message => ar.log(message));
        imported = next;
      } else throw new UnsupportedConsoleCommandError(`UObject::GlobalSetProperty of ${kind} property ${propertyName.token} is not linked: ${cmd}`);
      return imported;
    };
    for (const actor of targets) runtime.writeField(actor, field, importInto(runtime.readField(actor, field)));
    // The named class's own Defaults (Class->Defaults, not its subclasses' copies).
    let named = null;
    for (let c = runtime.instance(targets[0]).cls; c && !named; c = c.base) {
      const key = c.record?.key?.toLowerCase();
      if (key === wanted || (!wanted.includes('.') && key?.endsWith(`.${wanted}`))) named = c;
    }
    const defaults = runtime.classDefaultReference(named, field);
    defaults.set(importInto(defaults.get()));
    return true;
  }

  const isIniName = token => /^(ini|usr):/i.test(token);
  /** StaticFindObject(UClass, ANY_PACKAGE, token) over the modelled native classes. A name that
   * resolves (or an ini: key that is missing) but names no modelled class is not claimed
   * unrecognized: the original would find any loaded script class. */
  function nativeClass(config, token, keyword, cmd, inputFallback = false) {
    if (!config) return null;
    const found = config.findClass(token);
    if (found) return found;
    if (isIniName(token) && config.resolveName(token) === null) return null;   // ResolveName fails: not found
    if (inputFallback && scriptStringComplementEqual(token, 'InputExt')) return null;
    if (isIniName(token) || keyword === 'GET')
      throw new UnsupportedConsoleCommandError(`UObject::StaticExec ${keyword} of class ${token} is not implemented: ${cmd}`, {body: 'UObject::StaticExec', keyword});
    return null;
  }

  /** UEngine::Flush 0x10380cf0: GCache.Flush(0,0,0), then Client->Flush
   * (UClient::Flush 0x10375ca0: each viewport's RenDev->Flush). The browser
   * keeps no FMemCache items; the render device is the browser renderer. */
  function flush(allowPrecache) {
    state.flushes++;
    services.flushRenderDevice?.(allowPrecache);
  }

  /** XInputExt::Process 0x1002d0b0. Returns {handled, consumed, host}. */
  function process(key, action, delta, ar) {
    if (!(key >= 0 && key < 0xff)) throw new Error('XInputExt::Process key assertion (line 0x41)');
    const actor = read(services.viewport(), 'Actor');
    if (actor && services.rootProcess(key, action, delta)) {
      for (let held = 0; held < 0xff; held++) {
        if (!state.held[held]) continue;
        state.held[held] = 0;
        if (services.hostBinding(held, IST_RELEASE)) continue;
        const binding = input.bindings[held] ?? '';
        if (!binding) continue;
        run(binding, IST_RELEASE, 0, ar);
      }
      return {handled: true, consumed: true, host: false};
    }
    if (action === IST_PRESS) { if (state.held[key]) return {handled: false}; state.held[key] = 1; }
    else if (action === IST_RELEASE) { if (!state.held[key]) return {handled: false}; state.held[key] = 0; }
    if (services.hostBinding(key, action)) return {handled: true, consumed: false, host: true};
    const binding = input.bindings[key] ?? '';
    if (!binding) return {handled: false};
    run(binding, action, delta, ar);
    return {handled: true, consumed: false, host: false};
  }

  function run(binding, action, delta, ar) {
    state.action = action; state.delta = delta; state.lines = 0;
    try { execInputCommands(binding, ar); }
    catch (error) { if (error instanceof UnsupportedConsoleCommandError) error.partial = state.lines > 0; throw error; }
    finally { state.action = 0; state.delta = 0; }
  }

  /** UEngine::InputEvent 0x103814e0 through XInputExt::PreProcess (always 1). */
  function inputEvent(key, action, delta = 0) {
    const viewport = services.viewport(), console = read(viewport, 'Console'), actor = read(viewport, 'Actor');
    if (console && actor) {
      const hud = read(actor, 'myHUD'), menu = hud && read(hud, 'MainMenu');
      if (menu) throw new UnsupportedConsoleCommandError('InputEvent HUD.MainMenu Y/N key remap is not implemented');
    }
    const ar = consoleOutput();
    if (console) {
      // ProcessEvent(FindFunctionChecked(NAME_KeyEvent)): state version first.
      // A true result on a release also runs PreProcess, which does nothing.
      const result = {reference: {}, value: false, get() { return this.value; }, set(value) { this.value = value; }};
      runtime.processEvent(console, 'KeyEvent', [key, action, delta], result);
      if (result.value) return {handled: true, consumed: true, host: false, console: true};
    }
    return process(key, action, delta, ar);
  }

  /** XGameEngineExt::Key 0x10026650 for one WM_CHAR/WM_SYSCHAR unit
   * (script-window-typed-keys.mjs gameEngineKey, docs/script-window-typed-keys.md).
   * The viewport's Input is the UInput this module models: DeusEx.ini's
   * Input=Extension.InputExt, so it IsA XInputExt and its viewport is the
   * local one. Console.KeyType runs through ProcessEvent (state version
   * first) with the key as a BYTE. */
  function key(char) {
    const viewport = services.viewport();
    let console = false;
    const handled = gameEngineKey(viewport, char, {
      console: v => read(v, 'Console'),
      keyType(object, byte) {
        const result = {reference: {}, value: false, get() { return this.value; }, set(value) { this.value = value; }};
        runtime.processEvent(object, 'KeyType', [byte], result);
        return (console = Boolean(result.value));
      },
      input: () => input, isInputExt: () => true, actor: () => read(viewport, 'Actor'),
      isPlayerPawnExt: actor => services.isPlayerPawnExt(actor),
      rootWindow: actor => read(actor, 'rootWindow'),
      rootKey: (root, unit) => services.rootKey(root, unit),
    });
    return {handled: Boolean(handled), console};
  }

  // UEngine::InputEvent hands Process the Console's FOutputDevice (+0x28).
  function consoleOutput() {
    return {log(text) { throw new UnsupportedConsoleCommandError(`Console output device is not linked: ${text}`); }};
  }

  function gLogOutput() {
    return {log(text) { throw new UnsupportedConsoleCommandError(`GLog output device is not linked: ${text}`); }};
  }

  /** APlayerPawn::execConsoleCommand 0x103ba200: Player's Exec into a string
   * device; no UPlayer returns an empty string. */
  function consoleCommand(receiver, command) {
    const ar = stringOutputDevice();
    if (!read(receiver, 'Player')) return '';
    viewportExec(scriptStringText(command), ar);
    return ar.text;
  }

  /** UInput::ReadInput 0x10394580: replay non-sentinel holds, then scale each
   * CPF_Input float. This takes the selected GLog/Console output device from
   * its caller because original Input::Process can log while replaying. */
  function readInput(delta, ar = consoleOutput()) {
    const {actor} = inputActor(), fields = inputPropertyFields(runtime.instance(actor)), dt = Math.fround(delta);
    const comparison = x87cmp(x87load(dt), x87double(-1));
    if (comparison !== 'eq' && comparison !== 'un') {
      for (let key = 0; key < 0xff; key++)
        if (state.held[key]) process(key, IST_HOLD, dt, ar);
    }
    const scale = comparison === 'eq' || comparison === 'un'
      ? x87double(0) : x87div(x87double(20), x87load(dt));
    for (const field of fields) if (field.metadata.type === 'float') {
      const current = runtime.readField(actor, field), first = field.metadata.arrayDim > 1 ? current[0] : current;
      const result = x87store(x87mul(x87load(first), scale));
      if (field.metadata.arrayDim > 1) current[0] = result;
      runtime.writeField(actor, field, field.metadata.arrayDim > 1 ? current : result);
    }
    return undefined;
  }

  /** UViewport::ReadInput 0x10374990: sample platform input unless Delta is
   * the -1 sentinel, then call UInput::ReadInput with the original GLog. */
  function viewportReadInput(delta, ar = gLogOutput()) {
    const viewport = services.viewport(), dt = Math.fround(delta);
    const comparison = x87cmp(x87load(dt), x87double(-1));
    if (comparison !== 'eq' && comparison !== 'un') {
      if (typeof services.updateInput !== 'function')
        throw new UnsupportedConsoleCommandError('UWindowsViewport::UpdateInput(0) is not linked');
      services.updateInput(viewport, 0);
    }
    return readInput(dt, ar);
  }

  /** UInput::ResetInput 0x10394910. Native clears ByteProperty input bytes,
   * then FloatProperty input DWORDs in a second pass, and invokes the
   * viewport's UpdateInput(1) through vtable +0x7c. */
  function resetInput() {
    state.held.fill(0);
    const {viewport, actor} = inputActor(), instance = runtime.instance(actor);
    for (const field of inputPropertyFields(instance)) if (field.metadata.type === 'byte') {
      writeInputField(actor, field, 0);
    }
    for (const field of inputPropertyFields(instance)) if (field.metadata.type === 'float') {
      if (field.metadata.arrayDim > 1) {
        const value = runtime.readField(actor, field); value[0] = 0;
        runtime.writeField(actor, field, value);
      } else runtime.writeField(actor, field, 0);
    }
    state.action = 0; state.delta = 0;
    if (typeof services.updateInput !== 'function')
      throw new UnsupportedConsoleCommandError('UWindowsViewport::UpdateInput(1) virtual at viewport +0x7c is not linked');
    services.updateInput(viewport, 1);
  }

  return {state, aliases: input.aliases, inputEvent, key, process, readInput, viewportReadInput, execInputCommands, viewportExec, inputExec, consoleCommand,
    flush, resetInput};
}

function inputInteger(text) {
  // appAtoi -> original CRT _wtoi. Overflow has no host-defined substitution.
  const number = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(text);
  if (!number) return 0;
  const value = Number(number[1]);
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
    throw new UnsupportedConsoleCommandError('Input KEYNAME decimal overflow is not recovered');
  return value;
}
