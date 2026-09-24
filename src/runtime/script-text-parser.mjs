/** DeusExTextParser natives 2210-2221 (DeusExText.dll, SHA-256
 * 5f64ff6be5e44a276906e72325a25e1a27406314267076c2b5ad061b4a339aa1).
 *
 * DDeusExTextParser is `native noexport` (size 0xc0). Every method below is
 * translated from the exported C++ body named beside it; the exec wrappers only
 * evaluate parameters and store the result. The text buffer is the parser's
 * own GMalloc copy of an XExtString, and the parser writes NULs into it while
 * tokenizing, so it is kept as a mutable array of UTF-16 code units. Reads the
 * original makes past that allocation are raised as TextParserBufferError: the
 * original reads unrelated heap there. docs/script-text-parser.md. */

export const TEXT_PARSER_NATIVE = Object.freeze({
  hash: '5f64ff6be5e44a276906e72325a25e1a27406314267076c2b5ad061b4a339aa1',
  classKey: 'deusextext.deusextextparser',
  size: 0xc0,
  vtable: 0x10007190,
  indices: Object.freeze({
    openText: 2210, closeText: 2211, processText: 2212, isEOF: 2213, getText: 2214,
    gotoLabel: 2215, getTag: 2216, getName: 2217, getColor: 2218, getEmailInfo: 2219,
    getFileInfo: 2220, setPlayerName: 2221,
  }),
  bodies: Object.freeze({
    constructor: 0x10001100, destroy: 0x10001210, openText: 0x10001240, closeText: 0x10001430,
    setPlayerName: 0x10001460, setPlayerFirstName: 0x10001660, processText: 0x10001780,
    isEOF: 0x100018c0, getText: 0x100018e0, gotoLabel: 0x10001960, getTag: 0x10001970,
    getName: 0x10001980, getColor: 0x100019c0, parseTextBlock: 0x10001a20, parseTag: 0x10001cc0,
    parseToken: 0x10001f80, parseFile: 0x10002380, parseEmail: 0x10002560, parseName: 0x10002880,
    parseColor: 0x100028c0, parseSubToken: 0x10002960, trimSpaces: 0x100029c0,
    findEndTag: 0x10002ba0, destructor: 0x10004030, deletingDestructor: 0x10004820,
  }),
  // execOpenText's P_GET_STR_OPTX default and empty-package replacement (0x1000a2d4).
  defaultPackage: 'DeusExText',
  // StaticLoadObject(XExtString, NULL, "%s.%s", NULL, LOAD_NoWarn|LOAD_Quiet, NULL).
  loadFlags: 0x2002,
});

// EDeusExTextTags spellings, in the order ParseTag tries them (table 0x1000a070).
export const TEXT_TAG_NAMES = Object.freeze(['TEXT', 'FILE', 'EMAIL', 'NOTE', '/NOTE', 'GOAL', '/GOAL',
  'COMMENT', '/COMMENT', 'PLAYERNAME', 'PLAYERFIRSTNAME', 'NP', 'JC', 'JL', 'JR', 'DC', 'C', '/C', 'P',
  'B', '/B', 'U', '/U', 'I', '/I', 'G', 'F', 'L', '/<', '/>']);
export const TT_TEXT = 0;
export const TT_NEW_PARAGRAPH = 18;
export const TT_NONE = 30;

const LT = 0x3c, GT = 0x3e, SPACE = 0x20, COMMA = 0x2c, EQUALS = 0x3d;

export class TextParserBufferError extends Error {}

const highByte = address => (address >>> 24) & 0xff;
const cstringPrefix = text => {
  const end = text.indexOf('\0');
  return end < 0 ? text : text.slice(0, end);
};
const black = alpha => ({r: 0, g: 0, b: 0, a: alpha});

/** DDeusExTextParser::DDeusExTextParser (0x10001100) after InitProperties.
 * The two FColor(0,0,0) members keep byte 3 of the stack slot that first held
 * `this`, so their alpha is the high byte of the object's address. */
export function constructTextParser({objectAddress}) {
  if (!Number.isInteger(objectAddress)) throw new TypeError('Text parser construction requires the object address model');
  const alpha = highByte(objectAddress);
  return {
    objectAddress,
    text: null, textAddress: null, textPos: null, tagEndPos: null,
    lastText: '', lastTag: TT_NONE, lastName: 'None',
    lastColor: black(alpha), defaultColor: black(alpha),
    bParagraphStarted: false,
    playerName: '', playerFirstName: '',
    lastEmailName: '', lastEmailSubject: '', lastEmailFrom: '', lastEmailTo: '', lastEmailCC: '',
    lastFileName: '', lastFileDescription: '',
  };
}

function read(state, index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.text.length)
    throw new TextParserBufferError(`DeusExTextParser reads outside its text allocation at unit ${index}`);
  return state.text[index];
}

function write(state, index, value) {
  read(state, index);
  state.text[index] = value;
}

/** The TCHAR string starting at `index`, up to its NUL. */
function cstring(state, index) {
  let end = index;
  while (read(state, end) !== 0) end++;
  return String.fromCharCode(...state.text.subarray(index, end));
}

/** appStrchr: the first `code` at or after `index`, or null at the NUL. */
function strchr(state, index, code) {
  for (let at = index; ; at++) {
    const unit = read(state, at);
    if (unit === code) return at;
    if (unit === 0) return null;
  }
}

/** appStrstr(at, tag) == at: the NUL-terminated string at `index` begins with `tag`. */
function startsWith(state, index, tag) {
  for (let offset = 0; offset < tag.length; offset++)
    if (read(state, index + offset) !== tag.charCodeAt(offset)) return false;
  return true;
}

/** CloseText (0x10001430): free the copy and clear both pointers. */
export function textParserCloseText(state) {
  state.text = null; state.textAddress = null;
  state.textPos = null;
}

/** OpenText (0x10001240). `loadText(path)` is StaticLoadObject for the
 * XExtString "<package>.<name>", returning its Text or null. The loaded object
 * is released again by the original (ResetLoaders then delete). */
export function textParserOpenText(state, textName, textPackage, {loadText, allocateText}) {
  if (typeof loadText !== 'function' || typeof allocateText !== 'function')
    throw new TypeError('OpenText requires the XExtString loader and text allocation services');
  textParserCloseText(state);
  const path = `${cstringPrefix(textPackage)}.${textName}`;
  const text = loadText(path);
  if (text !== null && text !== undefined) {
    if (typeof text !== 'string') throw new TypeError('XExtString text must be a string');
    const copied = cstringPrefix(text);
    const units = new Uint16Array(copied.length + 1);
    for (let index = 0; index < copied.length; index++) units[index] = copied.charCodeAt(index);
    state.textAddress = allocateText(units.length * 2);
    if (!Number.isInteger(state.textAddress)) throw new TypeError('Text allocation must return an address');
    state.text = units;
    state.textPos = 0;
  }
  state.bParagraphStarted = false;
  return state.text !== null;
}

/** SetPlayerName (0x10001460) and SetPlayerFirstName (0x10001660): the first
 * name is the text before the first " " of the stored name, else the name. */
export function textParserSetPlayerName(state, name) {
  state.playerName = name;
  const space = cstringPrefix(name).indexOf(' ');
  state.playerFirstName = space < 0 ? name : name.slice(0, space);
}

/** IsEOF (0x100018c0). */
export function textParserIsEOF(state) {
  return state.text === null || state.textPos === null;
}

/** ProcessText (0x10001780). */
export function textParserProcessText(state, services) {
  state.lastText = parseTextBlock(state, services);
  return !textParserIsEOF(state);
}

/** ParseTextBlock (0x10001a20). Text is collected only after the first
 * paragraph has started; the first <P> itself is consumed silently. */
function parseTextBlock(state, services) {
  let block = '', gotText = false;
  state.lastTag = TT_NONE;
  if (state.text === null || state.textPos === null) return '';
  let unit = read(state, state.textPos);
  if (unit === 0) { state.textPos = null; return ''; }
  for (;;) {
    if (unit === LT) {
      if (gotText) break;
      block += cstringPrefix(parseTag(state, services));
      if (state.lastTag !== TT_NEW_PARAGRAPH || state.bParagraphStarted) break;
      state.bParagraphStarted = true;
    } else {
      if (state.bParagraphStarted) {
        block += String.fromCharCode(unit === 0x0d || unit === 0x0a ? SPACE : unit);
        state.lastTag = TT_TEXT;
        gotText = true;
      }
      state.textPos++;
    }
    unit = read(state, state.textPos);
    if (unit === 0) break;
  }
  return block;
}

/** ParseTag (0x10001cc0). The tag body ends at the first '>' (or the
 * terminator), which is overwritten with NUL; textPos then steps past it. */
function parseTag(state, services) {
  if (state.text === null || state.textPos === null) return '';
  const tagStart = state.textPos + 1;
  if (read(state, state.textPos) !== GT) {
    for (;;) {
      if (read(state, state.textPos) === 0) break;
      state.textPos++;
      if (read(state, state.textPos) === GT) break;
    }
  }
  state.tagEndPos = state.textPos;
  write(state, state.textPos, 0);
  state.textPos++;
  let token = '';
  for (let tag = 0; tag < TEXT_TAG_NAMES.length; tag++) {
    if (!startsWith(state, tagStart, TEXT_TAG_NAMES[tag])) continue;
    state.lastTag = tag;
    token = parseToken(state, tag, tagStart + TEXT_TAG_NAMES[tag].length, services);
    break;
  }
  state.tagEndPos = null;
  return token;
}

/** ParseToken (0x10001f80), including its switch table 0x10002318/0x10002354. */
function parseToken(state, tag, after, services) {
  switch (tag) {
    case 1: parseFile(state, after); return '';
    case 2: parseEmail(state, after); return '';
    case 3: findEndTag(state, 4, services); return '';
    case 5: parseName(state, after, services); findEndTag(state, 6, services); return '';
    case 7: findEndTag(state, 8, services); return '';
    case 9: return state.playerName;
    case 10: return state.playerFirstName;
    case 15: case 16: case 17: parseColor(state, after); return '';
    case 25: case 26: parseName(state, after, services); return '';
    case 28: return '<';
    case 29: return '>';
    default: return '';
  }
}

/** FindEndTag (0x10002ba0). Nested tags run through ParseTag with all their
 * side effects; after one that is not `endTag` the original also steps over
 * the character that follows its '>'. */
function findEndTag(state, endTag, services) {
  let body = '';
  if (read(state, state.textPos) === 0) return '';
  for (;;) {
    const unit = read(state, state.textPos);
    if (unit === LT) {
      body += cstringPrefix(parseTag(state, services));
      if (state.lastTag === endTag) return body;
    } else {
      body += String.fromCharCode(unit === 0x0d || unit === 0x0a ? SPACE : unit);
    }
    state.textPos++;
    if (read(state, state.textPos) === 0) return body;
  }
}

/** ParseSubToken (0x10002960): the next ','-separated field of the tag body. */
function parseSubToken(state, cursor) {
  const start = cursor.at;
  if (start >= state.tagEndPos) return state.tagEndPos;
  let end = strchr(state, start, COMMA);
  if (end === null) end = strchr(state, cursor.at, GT);
  if (end !== null) {
    write(state, end, 0);
    cursor.at = end + 1;
  } else {
    cursor.at = state.tagEndPos + 1;
  }
  return start;
}

/** TrimSpaces (0x100029c0): skip leading spaces; overwrite trailing ones with NUL. */
function trimSpaces(state, index) {
  if (read(state, index) === 0) return '';
  let start = index;
  while (read(state, start) === SPACE) start++;
  let end = index + cstring(state, index).length - 1;
  while (end !== start && read(state, end) === SPACE) { write(state, end, 0); end--; }
  return cstring(state, start);
}

function subTokens(state, after, count) {
  const equals = strchr(state, after, EQUALS);
  if (equals === null) return null;
  const cursor = {at: equals + 1}, fields = [];
  for (let index = 0; index < count; index++) fields.push(trimSpaces(state, parseSubToken(state, cursor)));
  return fields;
}

/** ParseFile (0x10002380): FILE=name,description. */
function parseFile(state, after) {
  const fields = subTokens(state, after, 2);
  if (fields) [state.lastFileName, state.lastFileDescription] = fields;
}

/** ParseEmail (0x10002560): EMAIL=name,subject,from,to,cc. */
function parseEmail(state, after) {
  const fields = subTokens(state, after, 5);
  if (fields) [state.lastEmailName, state.lastEmailSubject, state.lastEmailFrom,
    state.lastEmailTo, state.lastEmailCC] = fields;
}

/** ParseName (0x10002880): FName(text after '=', FNAME_Add), else NAME_None. */
function parseName(state, after, {name} = {}) {
  const equals = strchr(state, after, EQUALS);
  if (equals === null) { state.lastName = 'None'; return; }
  if (typeof name !== 'function') throw new TypeError('DeusExTextParser tag names require the FName service');
  state.lastName = name(cstring(state, equals + 1));
}

/** Core appAtoi -> shipped MSVCRT _wtoi (0x7801c812): WideCharToMultiByte
 * (CP_ACP) into a 20-byte buffer, then the C-locale atol (0x78005d30) with
 * 32-bit wraparound. Only the ASCII, NUL-fitting domain is reproducible. */
export function msvcrtWtoi(text) {
  if (text.length + 1 > 20) throw new RangeError('_wtoi input exceeds its 20-byte conversion buffer');
  if (/[^\x00-\x7f]/.test(text)) throw new RangeError('_wtoi code-page conversion is only reproduced for ASCII');
  let index = 0;
  while (/[\t\n\v\f\r ]/.test(text[index] ?? '')) index++;
  const sign = text[index];
  if (sign === '-' || sign === '+') index++;
  let total = 0;
  for (; index < text.length && text[index] >= '0' && text[index] <= '9'; index++)
    total = (Math.imul(total, 10) + (text.charCodeAt(index) - 0x30)) | 0;
  return sign === '-' ? (-total) | 0 : total;
}

/** ParseColor (0x100028c0). The colour is assembled in the argument slot of
 * the tag pointer, so its alpha is the high byte of that pointer. */
function parseColor(state, after) {
  const alpha = highByte(state.textAddress + after * 2);
  const equals = strchr(state, after, EQUALS);
  if (equals === null) { state.lastColor = black(alpha); return; }
  const cursor = {at: equals + 1}, channel = () => msvcrtWtoi(cstring(state, parseSubToken(state, cursor))) & 0xff;
  const r = channel(), g = channel(), b = channel();
  state.lastColor = {r, g, b, a: alpha};
}

/** GetText (0x100018e0). */
export function textParserGetText(state) {
  return state.lastText;
}

/** GetTag (0x10001970); execGetTag stores the whole enum dword. */
export function textParserGetTag(state) {
  return state.lastTag;
}

/** GetName (0x10001980): lastName for NOTE, G, F and L; any other tag builds
 * FName(NULL), which fails Core's check(Name) assertion. */
export function textParserGetName(state) {
  const tag = state.lastTag;
  if (tag === 3 || (tag > 24 && tag <= 27)) return state.lastName;
  throw new Error('DeusExTextParser.GetName reaches the original FName(NULL) assertion');
}

/** GetColor (0x100019c0): the local default keeps `this`'s high byte as alpha. */
export function textParserGetColor(state) {
  const tag = state.lastTag;
  if (tag < 15 || tag > 17) return black(highByte(state.objectAddress));
  return {...(tag === 17 ? state.defaultColor : state.lastColor)};
}

/** execGetEmailInfo (0x100038a0) copies the five parsed fields into its out parameters. */
export function textParserGetEmailInfo(state) {
  return [state.lastEmailName, state.lastEmailSubject, state.lastEmailFrom, state.lastEmailTo, state.lastEmailCC];
}

/** execGetFileInfo (0x10003c40). */
export function textParserGetFileInfo(state) {
  return [state.lastFileName, state.lastFileDescription];
}

/** GotoLabel (0x10001960) is an unimplemented stub returning false. */
export function textParserGotoLabel() {
  return false;
}

/** A comparable snapshot of every field the harness reads from native memory. */
export function textParserSnapshot(state) {
  const color = value => [value.r, value.g, value.b, value.a];
  return {
    text: state.text ? [...state.text] : null,
    textPos: state.textPos, tagEndPos: state.tagEndPos,
    lastText: state.lastText, lastTag: state.lastTag, lastName: state.lastName,
    lastColor: color(state.lastColor), defaultColor: color(state.defaultColor),
    bParagraphStarted: state.bParagraphStarted,
    playerName: state.playerName, playerFirstName: state.playerFirstName,
    email: textParserGetEmailInfo(state), file: textParserGetFileInfo(state),
  };
}
