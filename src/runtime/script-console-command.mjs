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
 * a keyword claims, other than the handled KEYNAME, KEYBINDING and FLUSH,
 * throws UnsupportedConsoleCommandError before any of that handler's work.
 */
import {readToken} from './config-text.mjs';
import {scriptStringComplementEqual, scriptStringText} from './script-string-operations.mjs';

export class UnsupportedConsoleCommandError extends Error {
  constructor(message, {body = null, keyword = null} = {}) {
    super(message);
    this.name = 'UnsupportedConsoleCommandError';
    this.body = body;
    this.keyword = keyword;
  }
}

export const IST_PRESS = 1, IST_HOLD = 2, IST_RELEASE = 3;

// Each body's ParseCommand keywords, in the order its fall-through path tests
// them. Keywords a body tests only after another keyword matched are not
// listed; they cannot claim a command on their own.
export const EXEC_KEYWORDS = Object.freeze({
  'UInput::Exec': ['BUTTON', 'PULSE', 'TOGGLE', 'AXIS', 'KEYNAME', 'KEYBINDING'],
  'URenderDevice::Exec': ['GetDetailTextures', 'ToggleDetailTextures'],
  'UGlideRenderDevice::Exec': ['TMUDETAIL', 'GetRes', 'GetColorDepths'],
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

  /** UInput::Exec 0x10393e10 (XInputExt keeps it). */
  function inputExec(cmd, ar) {
    for (const keyword of ['BUTTON', 'PULSE', 'TOGGLE', 'AXIS'])
      if (parseCommand(cmd, keyword) !== null)
        throw new UnsupportedConsoleCommandError(`UInput::Exec ${keyword} (the input axis/button system) is not implemented: ${cmd}`,
          {body: 'UInput::Exec', keyword});
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

  /** UWindowsViewport::Exec 0x11106d90. */
  function viewportExec(cmd, ar) {
    if (uviewportExec(cmd, ar)) return true;
    claims('UWindowsViewport::Exec', cmd);
    return false;
  }

  /** UViewport::Exec 0x10373a60: Input (+0x60), RenDev (+0x64), its keywords,
   * Console (+0x34) with the viewport Actor as executor, then UPlayer::Exec. */
  function uviewportExec(cmd, ar) {
    const viewport = services.viewport(), actor = read(viewport, 'Actor');
    if (!actor) throw new Error('UViewport::Exec requires its Actor (UnPlayer check at line 0x1db)');
    if (inputExec(cmd, ar)) return true;
    // The installed GameRenderDevice: GlideRenderDevice::Exec runs
    // URenderDevice::Exec first.
    claims('URenderDevice::Exec', cmd);
    claims('UGlideRenderDevice::Exec', cmd);
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

  /** DDeusExGameEngine::Exec 0x1000ed70 -> UGameEngine::Exec 0x1038a030 ->
   * UEngine::Exec 0x10380ee0. */
  function engineExec(level, levelInfo, cmd, ar) {
    claims('DDeusExGameEngine::Exec', cmd);
    claims('UGameEngine::Exec', cmd);
    if (levelExec(level, cmd)) return true;
    const game = read(levelInfo, 'Game');
    if (game && scriptExec(game, cmd, null)) return true;
    // GSys, UObject::StaticExec, GCache, GExec (the launcher's FExecHook),
    // Client (UWindowsClient -> UClient), Render, Audio (Galaxy), in order.
    for (const body of ['USystem::Exec', 'UObject::StaticExec', 'FMemCache::Exec', 'FExecHook::Exec',
      'UClient::Exec', 'URender::Exec', 'UGalaxyAudioSubsystem::Exec', 'Galaxy 0x106019b0'])
      claims(body, cmd);
    if (parseCommand(cmd, 'FLUSH') !== null) { flush(1); return true; }
    if (parseCommand(cmd, 'CRACKURL') !== null)
      throw new UnsupportedConsoleCommandError(`UEngine::Exec CRACKURL is not implemented: ${cmd}`, {body: 'UEngine::Exec', keyword: 'CRACKURL'});
    return false;
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

  // UEngine::InputEvent hands Process the Console's FOutputDevice (+0x28).
  function consoleOutput() {
    return {log(text) { throw new UnsupportedConsoleCommandError(`Console output device is not linked: ${text}`); }};
  }

  /** APlayerPawn::execConsoleCommand 0x103ba200: Player's Exec into a string
   * device; no UPlayer returns an empty string. */
  function consoleCommand(receiver, command) {
    const ar = stringOutputDevice();
    if (!read(receiver, 'Player')) return '';
    viewportExec(scriptStringText(command), ar);
    return ar.text;
  }

  /** UInput::ResetInput 0x10394910, first half: the key table (+0xeb0) is
   * zeroed. WinDrv calls it from its focus handlers (after 0x1110a0f5 and
   * 0x1110a1e2, next to Exec("SETPAUSE 1"/"SETPAUSE 0")); Play calls it when
   * the browser window loses focus. The SETPAUSE exec and the actor
   * input-property reset that follows are not driven. */
  function resetInput() { state.held.fill(0); }

  return {state, aliases: input.aliases, inputEvent, process, execInputCommands, viewportExec, inputExec, consoleCommand,
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
