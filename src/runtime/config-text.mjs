/**
 * The UProperty ImportText/ExportText bodies config I/O reaches, from the GOTY
 * Core.dll (docs/script-config.md):
 *
 *   ReadToken              0x10164cb0   (thunk 0x101020db)
 *   UBoolProperty   Import 0x10166380   ExportTextItem 0x101662b0
 *   UIntProperty    Import 0x10165f00   ExportTextItem 0x10165e60
 *   UFloatProperty  Import 0x10166940   ExportTextItem 0x10166890
 *   UByteProperty   Import 0x10165aa0   ExportTextItem 0x101659d0
 *   UNameProperty   Import 0x101674d0   ExportTextItem 0x10167420
 *   UStrProperty    Import 0x10167980   ExportTextItem 0x101678a0
 *
 * Import returns `{rest, value}` for a non-NULL result, or `null` for NULL.
 * PortFlags are 0, as LoadConfig and SaveConfig pass them: the bool
 * spellings are the fixed "True"/"False", and strings are neither quoted nor
 * unescaped. Every other property type is an explicit boundary.
 */

import { msvcrtSprintf } from './script-text-format.mjs';

export class UnsupportedConfigTextError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedConfigTextError'; }
}
const unsupported = message => { throw new UnsupportedConfigTextError(message); };

const isAlnum = c => /^[A-Za-z0-9]$/.test(c);
const isDigit = c => c >= '0' && c <= '9';
const lower = value => String(value).toLowerCase();

/** ReadToken(Buffer, Result, MaxLen, DottedNames). `warn` receives its GLog
 * warnings (0x10164e24, 0x10164e44, 0x10164ef5). */
export function readToken(text, maxLength = 0x400, dotted = false, warn = null) {
  let at = 0, token = '';
  const c = text[at];
  if (c === '"') {
    at++;
    for (;;) {
      const ch = text[at];
      if (ch === undefined || ch === '"' || ch === '\r' || ch === '\n' || token.length >= maxLength - 1) break;
      if (ch === '\\') {
        const next = text[at + 1];
        if (next === '\\') { token += '\\'; at += 2; continue; }
        // Two hex digits; a non-hex digit contributes 0.
        const hex = ch2 => /[0-9a-fA-F]/.test(ch2 ?? '') ? parseInt(ch2, 16) : 0;
        token += String.fromCharCode((hex(next) << 4) + hex(text[at + 2]));
        at += 3;
        continue;
      }
      token += ch; at++;
    }
    if (token.length === maxLength - 1) { warn?.('ReadToken: Quoted string too long'); return null; }
    if (text[at++] !== '"') { warn?.('ReadToken: Bad quoted string'); return null; }
    return { token, rest: text.slice(at) };
  }
  if (c !== undefined && isAlnum(c)) {
    for (;;) {
      const ch = text[at];
      const part = ch !== undefined && (isAlnum(ch) || ch === '_' || ch === '-' || (dotted && ch === '.'));
      if (!part || token.length >= maxLength - 1) break;
      token += ch; at++;
    }
    if (token.length === maxLength - 1) { warn?.('ReadToken: Alphanumeric overflow'); return null; }
    return { token, rest: text.slice(at) };
  }
  // Any other first character is a one-character token that is not consumed.
  return { token: c ?? '', rest: text };
}

/** appAtoi = _wtoi. */
function atoi(text) {
  const match = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(text);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
    unsupported('ImportText integer overflow is not recovered');
  return value;
}

/** appAtof = _wtof, stored through fst into a float. */
function atof(text) {
  const match = /^[\t\n\v\f\r ]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?)/.exec(text);
  if (!match) return 0;
  return Math.fround(Number(match[1].replace(/[dD]/, 'e')));
}

/**
 * `kind`: 'bool' | 'int' | 'float' | 'byte' | 'name' | 'string'.
 * `enumNames`: a byte property's enum names, or null.
 */
export function importText(kind, text, { enumNames = null } = {}) {
  text = String(text);
  switch (kind) {
    case 'int': {
      const value = text[0] === '-' || isDigit(text[0] ?? '') ? atoi(text) : undefined;
      let at = 0;
      while (text[at] === '-' || isDigit(text[at] ?? '')) at++;
      return { rest: text.slice(at), value };
    }
    case 'float': {
      const value = atof(text);
      let at = 0;
      while (at < text.length && !',)\r\n'.includes(text[at])) at++;
      return { rest: text.slice(at), value };
    }
    case 'bool': {
      const read = readToken(text, 0x400, false);
      if (!read) return null;
      const token = lower(read.token);
      if (token === '1' || token === 'true') return { rest: read.rest, value: true };
      if (token === '0' || token === 'false') return { rest: read.rest, value: false };
      return null;
    }
    case 'byte': {
      if (enumNames) {
        const read = readToken(text, 0x400, false);
        if (!read) return null;
        const index = enumNames.findIndex(name => lower(name) === lower(read.token));
        if (read.token && index >= 0) return { rest: read.rest, value: index & 255 };
        text = read.rest;
      }
      if (!isDigit(text[0] ?? '')) return null;
      const value = atoi(text) & 255;
      let at = 0;
      while (isDigit(text[at] ?? '')) at++;
      return { rest: text.slice(at), value };
    }
    case 'name': {
      const read = readToken(text, 0x400, false);
      if (!read) return null;
      return { rest: read.rest, value: read.token === '' ? 'None' : read.token };
    }
    case 'string':
      return { rest: text, value: text };
    default:
      return unsupported(`Config ImportText is not linked for ${kind} properties`);
  }
}

/** UFloatProperty::ExportTextItem 0x10166890: appSprintf("%f", (double)value);
 * the formatter is the one measured against the game's MSVCRT.dll
 * (script-text-format.mjs, docs/script-value-format.md), which prints -0.0
 * unsigned. A non-finite float is an explicit boundary. */
function formatFloat(value) {
  if (!Number.isFinite(value)) unsupported('Config ExportText of a non-finite float is not recovered');
  return msvcrtSprintf('%f', value);
}

export function exportText(kind, value, { enumNames = null } = {}) {
  switch (kind) {
    case 'bool': return value ? 'True' : 'False';
    case 'int': return String(value | 0);
    case 'float': return formatFloat(Math.fround(value));
    case 'byte': {
      const index = Number(value) & 255;
      if (!enumNames) return String(index);
      if (index >= enumNames.length) unsupported('Config ExportText of an out-of-range enum value is not recovered');
      return enumNames[index];
    }
    case 'name': return String(value ?? 'None');
    case 'string': return String(value ?? '');
    default:
      return unsupported(`Config ExportText is not linked for ${kind} properties`);
  }
}
