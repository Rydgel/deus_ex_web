/**
 * Shared recovered model for the Extension.dll XListWindow row/column
 * subsystem (natives 1720-1794).  The original implementation keeps a TArray
 * of 24-byte heap row nodes at this+0x170 and a TArray of 0x38-byte column
 * records at this+0x17c; row nodes carry a second TArray of 24-byte field
 * cells.  All heap traffic goes through the engine allocator (GMalloc ->
 * FMalloc vtable slots Malloc/Realloc/Free), so the translation requires a
 * byte-addressable native heap service instead of hidden JS storage.
 *
 * Evidence: Extension.dll bodies listed in each native module and
 * docs/script-window-list.md.  Nothing here is approximated.
 */

const freeze = Object.freeze;
const f = Math.fround;

export const LIST_WINDOW_DLL = freeze({
  dll: 'Extension.dll',
  imageBase: 0x10000000,
  oracleBase: 0x12000000,
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
});

/** XListWindow/XWindow fields recovered from the native bodies. */
export const LIST_WINDOW = freeze({
  vtable: 0x00,          // virtual 0x10c = selection-changed broadcast
  colPacked: 0x3d,       // dword copied into new column +0x1d
  defFont: 0x54,         // font copied into new column +0x24
  style: 0x130,          // style source read by the measure-context acquire
  context: 0x134,        // pooled measure-context object
  parent: 0x138,         // parent chain walked by the selection broadcast
  delimiter: 0x14c,      // FString row delimiter (data/count/max)
  rowsData: 0x170,       // TArray<RowNode*> data
  rowsCount: 0x174,
  rowsMax: 0x178,
  colsData: 0x17c,       // TArray<Column 0x38> data
  numCols: 0x180,        // the cols TArray count IS the column count
  colsMax: 0x184,
  flags: 0x188,          // bit0 sorting, bit1 autoExpand, bit2 multiSelect
  padX: 0x18c,           // float, doubled into the field width requirement
  padY: 0x190,           // float, doubled into the row height
  rowHeight: 0x19c,      // float, recomputed from column fonts
  numSelected: 0x1a8,
  selected: 0x1ac,       // cached selected row node
  selected2: 0x1b0,
});

export const LIST_ROW = freeze({
  size: 0x18,
  id: 0x00,              // int, renumbered to the array index after insert/sort
  flags: 0x04,           // bit0 selected
  fieldsData: 0x08,      // TArray<Field 0x18>
  fieldsCount: 0x0c,
  fieldsMax: 0x10,
  clientData: 0x14,
});

export const LIST_FIELD = freeze({
  size: 0x18,
  text: 0x00,            // FString data
  textCount: 0x04,
  textMax: 0x08,
  value: 0x0c,           // float parsed numeric value
  width: 0x10,           // float measured width (0 when the column has no font)
  height: 0x14,          // float measured height
});

export const LIST_COL = freeze({
  size: 0x38,
  index: 0x00,
  header: 0x04,          // FString (data/count/max)
  sortPriority: 0x10,    // int; <0 excludes the column, higher compares first
  sortFlags: 0x14,       // bit0 reverse compare, bit1 case sensitive
  width: 0x18,           // float configured width
  flagByte: 0x1c,
  packed: 0x1d,          // dword copied from this+0x3d
  font: 0x24,            // font object (0 -> field measurement is skipped)
  type: 0x28,            // byte, low bits select text/numeric/time formatting
  format: 0x2c,          // FString custom format
});

/** Extension image scratch state (oracle-rebased addresses in metadata). */
export const LIST_GLOBALS = freeze({
  sortList: 0xa6f28,     // column pointer list, capacity 0x100
  sortCount: 0xa7348,
  emptyWString: 0x99ea8,
  fmtDefault: 0x988fc,   // "%f"
  fmtTime: 0x988e8,      // "%02h:%02m"
  tokenBuffer: 0xa5f10,
  sprintfBuffer: 0xa5810,
  fieldCopyBuffer: 0xa380c,
  newTag: 0x97988,       // "new"
});

export const LIST_FLAGS = freeze({sorting: 1, autoExpand: 2, multiSelect: 4});
export const SORT_REVERSE = 1;
export const SORT_CASE_SENSITIVE = 2;
export const ROW_SELECTED = 1;

export class ListWindowModelBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowModelBoundaryError';
    this.code = `LIST_MODEL_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const modelFail = (message, details) => {
  throw new ListWindowModelBoundaryError(message, details);
};

export function rejectAsync(value, label) {
  if (value && typeof value.then === 'function')
    modelFail(`ListWindow ${label} suspended`, {kind: 'ASYNC'});
  return value;
}

function requireMem(services) {
  const mem = services.mem;
  if (!mem || typeof mem.read !== 'function' || typeof mem.write !== 'function'
      || typeof mem.alloc !== 'function' || typeof mem.free !== 'function'
      || typeof mem.realloc !== 'function' || typeof mem.readString !== 'function'
      || typeof mem.allocString !== 'function')
    modelFail('ListWindow requires a raw native heap service (mem)', {kind: 'SERVICE'});
  return mem;
}

/** Checked accessors over the injected byte-addressable heap service. */
export function listMemory(object, services) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    modelFail('ListWindow requires a canonical window object', {kind: 'REFERENCE', value: object});
  const mem = requireMem(services);
  const base = rejectAsync(services.objectAddress ? services.objectAddress(object) : object.base, 'objectAddress');
  if (typeof base !== 'number' || !Number.isInteger(base) || base <= 0)
    modelFail('ListWindow requires the window heap address', {kind: 'SERVICE', value: base});
  const sync = (value, label) => rejectAsync(value, label);
  const int32 = value => {
    if (typeof value !== 'number' || !Number.isInteger(value))
      modelFail('ListWindow heap read returned a non-integer', {kind: 'VALUE', value});
    return value | 0;
  };
  const uint32 = value => {
    if (typeof value !== 'number' || !Number.isInteger(value))
      modelFail('ListWindow heap read returned a non-integer', {kind: 'VALUE', value});
    return value >>> 0;
  };
  const float32 = value => {
    if (typeof value !== 'number')
      modelFail('ListWindow heap read returned a non-number', {kind: 'VALUE', value});
    return f(value);
  };
  const checked = kind => {
    if (kind === 'i32' || kind === 'i16' || kind === 'i8') return int32;
    if (kind === 'u32' || kind === 'u16' || kind === 'u8') return uint32;
    if (kind === 'f32') return float32;
    return modelFail(`ListWindow unsupported heap kind ${kind}`, {kind: 'VALUE', value: kind});
  };
  const read = (address, kind) => checked(kind)(sync(mem.read(address, kind), `read 0x${address.toString(16)}`));
  const write = (address, kind, value) => sync(mem.write(address, kind, value), `write 0x${address.toString(16)}`);
  const alloc = (size, tag) => {
    const address = sync(mem.alloc(size, tag), 'alloc');
    return uint32(address);
  };
  const free = address => sync(mem.free(address), 'free');
  const realloc = (address, size, tag) => uint32(sync(mem.realloc(address, size, tag), 'realloc'));
  const readString = address => {
    const text = sync(mem.readString(address), 'readString');
    if (typeof text !== 'string')
      modelFail('ListWindow readString returned a non-string', {kind: 'VALUE', value: text});
    return text;
  };
  const allocString = text => uint32(sync(mem.allocString(text), 'allocString'));
  return {mem, object, services, base, read, write, alloc, free, realloc, readString, allocString};
}

function requireService(L, name) {
  const fn = L.services && L.services[name];
  if (typeof fn !== 'function')
    modelFail(`ListWindow requires services.${name}`, {kind: 'SERVICE'});
  return fn;
}

// ================= recovered native internals =================
// The wave-2+ natives all funnel through the same Extension.dll helper bodies
// and Core.dll TArray/FString methods; they are translated once here so each
// native module stays a thin method-body port.  Addresses cited are the
// preferred image base (oracle runs them rebased to 0x12000000).

const LIST_TOKEN_CAP = 0x7ff;      // TOKEN_BUFFER wchar bound (0x100a5f10)
const LIST_SORT_CAP = 0x100;       // sort-column list bound (0x100a6f28)

/** TArray capacity growth: newMax = n + floor((3n + adj) / 8) + 0x20. */
export function growArrayMax(num) {
  const tripled = num * 3;
  return num + ((tripled + (tripled < 0 ? 7 : 0)) >> 3) + 0x20;
}

/** Raw byte copy with memmove overlap semantics (temp buffer). */
export function moveBytes(L, dst, src, count) {
  const temp = new Array(count);
  for (let i = 0; i < count; i++) temp[i] = L.read(src + i, 'u8');
  for (let i = 0; i < count; i++) L.write(dst + i, 'u8', temp[i]);
}

/** rep stosd/rep stosb zero fill. */
export function zeroBytes(L, address, count) {
  let n = count >>> 0;
  let p = address;
  while (n >= 4) { L.write(p, 'u32', 0); p += 4; n -= 4; }
  while (n > 0) { L.write(p, 'u8', 0); p += 1; n -= 1; }
}

/** Core FArray::Realloc (0x10145440): data = GMalloc->Realloc(data, max*elemSize, "FArray"). */
export function farrayRealloc(L, array, elemSize) {
  const data = L.read(array, 'u32');
  const max = L.read(array + 8, 'i32');
  L.write(array, 'u32', L.realloc(data, (max * elemSize) >>> 0, 'FArray'));
}

/**
 * Grow an FArray to `num` elements (the shared sequence used by the row
 * model): caller writes num first; capacity expands via growArrayMax.
 */
export function farraySetNum(L, array, num, elemSize) {
  L.write(array + 4, 'i32', num);
  if (num > L.read(array + 8, 'i32')) {
    L.write(array + 8, 'i32', growArrayMax(num));
    farrayRealloc(L, array, elemSize);
  }
}

/** Core FArray::Empty (0x10107190): num = 0, max = newMax, Realloc(elemSize). */
export function farrayEmpty(L, array, elemSize, newMax) {
  L.write(array + 4, 'i32', 0);
  L.write(array + 8, 'i32', newMax);
  farrayRealloc(L, array, elemSize);
}

/**
 * Core FArray::Remove (0x101454f0): memmoves the tail down, then shrinks the
 * allocation when (num*3 < max*2 || (max-num)*elemSize >= 0x4000) and
 * (max-num > 0x40 || num == 0).
 */
export function farrayRemove(L, array, index, count, elemSize) {
  if (!count) return;
  const num = L.read(array + 4, 'i32');
  const data = L.read(array, 'u32');
  const tail = num - index - count;
  if (tail > 0)
    moveBytes(L, data + index * elemSize, data + (index + count) * elemSize, tail * elemSize);
  const newNum = num - count;
  L.write(array + 4, 'i32', newNum);
  const max = L.read(array + 8, 'i32');
  if (newNum * 3 < max * 2 || (max - newNum) * elemSize >= 0x4000) {
    if (max - newNum > 0x40 || newNum === 0) {
      L.write(array + 8, 'i32', newNum);
      farrayRealloc(L, array, elemSize);
    }
  }
}

/** Core ~FArray (0x10107200): Free(data) when set, then zero the triplet. */
export function farrayDtor(L, array) {
  const data = L.read(array, 'u32');
  if (data) L.free(data);
  L.write(array, 'u32', 0);
  L.write(array + 8, 'u32', 0);
  L.write(array + 4, 'u32', 0);
}

/**
 * Inlined FString::operator= used by setFieldText (0x12031b35/0x12031c10):
 * len = text ? wcslen+1 : 0; num = max = len; Realloc(2); copy len*2 bytes.
 * The native self-assign guard (data == src) can never trigger here because
 * the source is always a scratch buffer, not this FString's own data.
 */
export function fstringAssign(L, str, text) {
  const len = text.length ? text.length + 1 : 0;
  L.write(str + 8, 'u32', len);
  L.write(str + 4, 'u32', len);
  L.write(str, 'u32', L.realloc(L.read(str, 'u32'), len * 2, 'FArray'));
  if (!len) return;
  const data = L.read(str, 'u32');
  for (let i = 0; i < text.length; i++)
    L.write(data + 2 * i, 'u16', text.charCodeAt(i));
  L.write(data + 2 * text.length, 'u16', 0);
}

/** Extension FString reset helper 0x10012630: num = 0, max = newMax, Realloc(2). */
export function fstringReset(L, str, newMax) {
  L.write(str + 4, 'u32', 0);
  L.write(str + 8, 'u32', newMax);
  farrayRealloc(L, str, 2);
}

/**
 * Core ~FString (0x101075a0): num = max = 0 + Realloc(2), then
 * FArray::Remove(0, 0, 2) (a no-op when count is 0) and Free(data) when set.
 */
export function fstringDtor(L, str) {
  L.write(str + 4, 'u32', 0);
  L.write(str + 8, 'u32', 0);
  farrayRealloc(L, str, 2);
  farrayRemove(L, str, 0, 0, 2);
  const data = L.read(str, 'u32');
  if (data) L.free(data);
  L.write(str, 'u32', 0);
  L.write(str + 8, 'u32', 0);
  L.write(str + 4, 'u32', 0);
}

/**
 * Extension field destructor 0x100368e0: the field FString is emptied
 * (num = max = 0 + Realloc, which frees the data) and then destructed via
 * ~FString (a second Realloc(0, 0) plus the Remove/Free tail).
 */
export function fieldDtor(L, field) {
  fstringReset(L, field + LIST_FIELD.text, 0);
  fstringDtor(L, field + LIST_FIELD.text);
}

/**
 * Extension range destructor 0x10036810: fieldDtor over
 * [index, index + count), then FArray::Remove(index, count, 0x18).
 */
export function fieldRangeDtor(L, array, index, count) {
  const data = L.read(array, 'u32');
  for (let i = 0; i < count; i++) fieldDtor(L, data + (index + i) * LIST_FIELD.size);
  farrayRemove(L, array, index, count, LIST_FIELD.size);
}

/** Extension column bounds check 0x10033240: 0 <= col < numCols. */
export function colIndexValid(L, col) {
  return col >= 0 && col < L.read(L.base + LIST_WINDOW.numCols, 'i32');
}

/** Field text as a JS string: num ? data : "" (the native uses EMPTY_WSTRING). */
export function fieldText(L, field) {
  return L.read(field + LIST_FIELD.textCount, 'u32')
    ? L.readString(L.read(field + LIST_FIELD.text, 'u32')) : '';
}

/**
 * Extension numeric parser 0x100317c0.  x87 semantics: seg/total accumulate in
 * extended precision while `scale` persists through f32 memory each fraction
 * digit.  Base handling: leading '0' selects octal, '0x' hex; '.',',' switch
 * to fraction mode; '\'' folds seg*3600*sign into the total and ':'/'"' fold
 * seg*60*sign (the sign is not reset between segments); whitespace is skipped
 * only while cl bit2 is set; a sign is consumed only while cl bit0 is set;
 * any digit >= base or other character terminates the parse.
 */
export function parseListNumber(text) {
  if (text == null || !text.length) return 0;
  let total = 0, seg = 0, sign = 1, base = 10, scale = 1, frac = 0, cl = 7;
  const fold = mult => { total += seg * mult * sign; seg = 0; frac = 0; cl = 4; };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) {
      if (c === 0x30 && (cl & 2)) {
        base = 8;
        const c2 = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
        if (c2 === 0x78 || c2 === 0x58) { i++; base = 16; }
        cl = 0;
        continue;
      }
      const digit = c - 0x30;
      if (!(digit < base)) break;
      if (!frac) seg = seg * base + digit;
      else { const grown = scale * base; scale = f(grown); seg += digit / grown; }
      cl = 0;
      continue;
    }
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) {
      const digit = (c > 0x5a ? c - 0x20 : c) - 0x37;
      if (!(digit < base)) break;
      if (!frac) seg = seg * base + digit;
      else { const grown = scale * base; scale = f(grown); seg += digit / grown; }
      cl = 0;
      continue;
    }
    if (((c >= 9 && c <= 0xd) || c === 0x20) && (cl & 4)) continue;
    if ((c === 0x2b || c === 0x2d) && (cl & 1)) {
      if (c === 0x2d) sign = -1;
      cl &= 2;
      continue;
    }
    if (c === 0x2e || c === 0x2c) { frac = 1; cl = 0; continue; }
    if (c === 0x27) { fold(3600); continue; }
    if (c === 0x3a || c === 0x22) { fold(60); continue; }
    break;
  }
  return total + seg * sign;
}

/** Wrapper 0x100319a0: types 1/2 parse; every other type produces 0.0f. */
export function parseNumberWrap(type, text) {
  return (type === 1 || type === 2) ? f(parseListNumber(text)) : 0;
}

// ----- appSprintf float subset --------------------------------------------
// Core appSprintf (0x10123490) is intercepted in the oracle: formats without
// float conversions jump to the real body; float conversions are produced by
// correctly-rounded digit generation matching MSVCRT _fcvt/_ecvt (verified on
// exact ties).  The JS side mirrors that leaf: it consumes an explicit
// little-endian vararg buffer (the caller's pushed arguments).  Reading past
// the supplied arguments models native stack garbage and is an explicit
// boundary error instead of an invented result.

function decimalExpansion(value) {
  // Exact decimal of |value| from the f64 bit pattern (value = mant * 2^exp).
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(value), true);
  const bits = buf.getBigUint64(0, true);
  const e = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n), exp2;
  if (e === 0) exp2 = -1074; else { mant |= 1n << 52n; exp2 = e - 1075; }
  let num = mant;
  const shift = exp2 >= 0 ? 0 : -exp2;
  if (exp2 >= 0) num <<= BigInt(exp2);
  const den = 1n << BigInt(shift);
  const ip = (num / den).toString();
  const rem = num % den;
  const frac = rem ? (rem * (5n ** BigInt(shift))).toString().padStart(shift, '0') : '';
  return {ip, frac};
}

function roundScaled(ip, frac, prec) {
  // round(ip.frac * 10^prec) half-away-from-zero -> BigInt scaled integer.
  const digits = ip + frac;
  const scale = frac.length - prec;
  if (scale <= 0) return BigInt(digits) * (10n ** BigInt(-scale));
  const num = BigInt(digits), den = 10n ** BigInt(scale);
  const q = num / den;
  return (num % den) * 2n >= den ? q + 1n : q;
}

function decimalExponent(ip, frac) {
  if (ip !== '0') return ip.length - 1;
  const i = frac.search(/[1-9]/);
  return i < 0 ? 0 : -(i + 1);
}

function fmtSign(negative, flags) {
  return negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
}

function fmtFloatF(value, prec, flags) {
  if (Number.isNaN(value))
    return Object.is(Math.sign(value), -0) || value < 0 ? '-1.#QNAN' : '1.#QNAN';
  if (!Number.isFinite(value)) return value < 0 ? '-1.#INF' : '1.#INF';
  const d = decimalExpansion(value);
  const scaled = roundScaled(d.ip, d.frac, prec).toString().padStart(prec + 1, '0');
  let body = prec ? `${scaled.slice(0, -prec)}.${scaled.slice(-prec)}` : scaled;
  if (!prec && flags.includes('#')) body += '.';
  const negative = Object.is(value, -0) || value < 0;
  return fmtSign(negative, flags) + body;
}

function fmtFloatE(value, prec, flags, upper) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return fmtFloatF(value, prec, flags);
  const d = decimalExpansion(value);
  let exp = 0, mant;
  if (value === 0) {
    mant = '0' + ((prec || flags.includes('#')) ? '.' + '0'.repeat(prec) : '');
  } else {
    exp = decimalExponent(d.ip, d.frac);
    let ds = roundScaled(d.ip, d.frac, prec - exp).toString();
    if (ds.length > prec + 1) { exp += 1; ds = ds.slice(0, -1); }
    ds = ds.padStart(prec + 1, '0');
    mant = prec ? `${ds[0]}.${ds.slice(1)}` : ds[0];
    if (!prec && flags.includes('#')) mant += '.';
  }
  const body = fmtSign(value < 0 || Object.is(value, -0), flags) + mant
    + (upper ? 'E' : 'e') + (exp >= 0 ? '+' : '-')
    + String(Math.abs(exp)).padStart(2, '0');
  return body;
}

function fmtFloatG(value, prec, flags, upper) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return fmtFloatF(value, prec, flags);
  const strip = mant => mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
  let body;
  if (value === 0) {
    body = '0';
  } else {
    const d = decimalExpansion(value);
    const exp = decimalExponent(d.ip, d.frac);
    if (exp < -4 || exp >= prec) {
      const p = prec - 1;
      let ds = roundScaled(d.ip, d.frac, p - exp).toString();
      if (ds.length > p + 1) { exp += 1; ds = ds.slice(0, -1); }
      ds = ds.padStart(p + 1, '0');
      let mant = p ? `${ds[0]}.${ds.slice(1)}` : ds[0];
      if (!flags.includes('#')) mant = strip(mant);
      body = mant + (upper ? 'E' : 'e') + (exp >= 0 ? '+' : '-')
        + String(Math.abs(exp)).padStart(2, '0');
    } else {
      const p = prec - 1 - exp;
      const s = roundScaled(d.ip, d.frac, p).toString().padStart(p + 1, '0');
      let mant = p ? `${s.slice(0, -p)}.${s.slice(-p)}` : s;
      if (!flags.includes('#')) mant = strip(mant);
      body = mant;
    }
  }
  return fmtSign(value < 0, flags) + body;
}

function fmtInt(value, base, flags, signed) {
  const digits = base === 16 ? (value >>> 0).toString(16)
    : base === 8 ? (value >>> 0).toString(8)
    : String(signed ? Math.abs(value | 0) : value >>> 0);
  return (signed && value < 0 ? '-' : fmtSign(false, flags)) + digits;
}

function padPiece(piece, width, flags, numeric) {
  if (piece.length >= width) return piece;
  const fill = flags.includes('0') && !flags.includes('-') && numeric ? '0' : ' ';
  const n = width - piece.length;
  if (flags.includes('-')) return piece + ' '.repeat(n);
  if (fill === '0' && '+- '.includes(piece[0])) return piece[0] + '0'.repeat(n) + piece.slice(1);
  return fill.repeat(n) + piece;
}

/**
 * appSprintf over an explicit little-endian vararg buffer.  Conversions
 * consume 4-byte ints or 8-byte doubles exactly like the native vararg walk;
 * a conversion that reads past the buffer would consume native stack garbage
 * and raises the model boundary error instead.
 */
export function appSprintfVarArgs(fmt, argBytes) {
  const view = new DataView(argBytes.buffer, argBytes.byteOffset, argBytes.byteLength);
  let argp = 0;
  const readArg = size => {
    if (argp + size > argBytes.length)
      modelFail('ListWindow appSprintf conversion exceeds supplied varargs',
        {kind: 'UNSUPPORTED', value: fmt});
    const v = size === 8 ? view.getFloat64(argp, true) : view.getInt32(argp, true);
    argp += size;
    return v;
  };
  let out = '';
  for (let i = 0; i < fmt.length;) {
    if (fmt[i] !== '%') { out += fmt[i++]; continue; }
    let j = i + 1;
    if (fmt[j] === '%') { out += '%'; i = j + 1; continue; }
    let flags = '';
    while ('-+ #0'.includes(fmt[j])) flags += fmt[j++];
    let width = 0;
    if (fmt[j] === '*') { width = readArg(4); j++; }
    else while (fmt[j] >= '0' && fmt[j] <= '9') width = width * 10 + (fmt[j++].charCodeAt(0) - 0x30);
    let prec = null;
    if (fmt[j] === '.') {
      j++;
      if (fmt[j] === '*') { prec = readArg(4); j++; }
      else { prec = 0; while (fmt[j] >= '0' && fmt[j] <= '9') prec = prec * 10 + (fmt[j++].charCodeAt(0) - 0x30); }
    }
    while ('hlLzI346'.includes(fmt[j])) j++;
    const conv = fmt[j++];
    i = j;
    let piece;
    if (conv === 'f' || conv === 'F') piece = fmtFloatF(readArg(8), prec ?? 6, flags);
    else if (conv === 'e' || conv === 'E') piece = fmtFloatE(readArg(8), prec ?? 6, flags, conv === 'E');
    else if (conv === 'g' || conv === 'G') piece = fmtFloatG(readArg(8), prec === null ? 6 : Math.max(prec, 1), flags, conv === 'G');
    else if (conv === 'd' || conv === 'i') piece = fmtInt(readArg(4), 10, flags, true);
    else if (conv === 'u') piece = fmtInt(readArg(4), 10, flags, false);
    else if (conv === 'x' || conv === 'X') { piece = fmtInt(readArg(4), 16, flags, false); if (conv === 'X') piece = piece.toUpperCase(); }
    else if (conv === 'o') piece = fmtInt(readArg(4), 8, flags, false);
    else if (conv === 'c') piece = String.fromCharCode(readArg(4) & 0xffff);
    else if (conv === 'p') piece = `0x${(readArg(4) >>> 0).toString(16).padStart(8, '0')}`;
    else if (conv === 's')
      modelFail('ListWindow appSprintf %s dereferences a native pointer', {kind: 'UNSUPPORTED', value: fmt});
    else
      modelFail(`ListWindow appSprintf unsupported conversion %${conv}`, {kind: 'UNSUPPORTED', value: fmt});
    out += padPiece(piece, width, flags, conv !== 's' && conv !== 'c');
  }
  return out;
}

/**
 * formatNumber 0x10031a40: appSprintf(buf, fmt, (double)f32value) where fmt is
 * the column format for type 1 and "%f" otherwise.  Returns the string the
 * caller assigns into the field FString.
 */
export function formatListNumber(L, colPtr, type, value) {
  let fmt = '%f';
  if (type === 1) {
    fmt = L.read(colPtr + LIST_COL.format + 4, 'u32')
      ? L.readString(L.read(colPtr + LIST_COL.format, 'u32')) : '';
  }
  const args = new Uint8Array(8);
  new DataView(args.buffer).setFloat64(0, value, true);
  return appSprintfVarArgs(fmt, args);
}

/**
 * setFieldText 0x10031af0: text columns (type 0) zero field.value and assign
 * the token; every other type parses the token through parseNumberWrap,
 * stores the f32 value, and assigns the formatNumber output.
 */
export function setFieldText(L, node, col, token) {
  const cdata = L.read(L.base + LIST_WINDOW.colsData, 'u32');
  const colPtr = cdata + col * LIST_COL.size;
  const type = L.read(colPtr + LIST_COL.type, 'u8');
  const field = L.read(node + LIST_ROW.fieldsData, 'u32') + col * LIST_FIELD.size;
  if (type === 0) {
    L.write(field + LIST_FIELD.value, 'u32', 0);
    fstringAssign(L, field + LIST_FIELD.text, token);
    return;
  }
  const value = parseNumberWrap(type, token);
  const out = formatListNumber(L, colPtr, type, value);
  L.write(field + LIST_FIELD.value, 'f32', value);
  fstringAssign(L, field + LIST_FIELD.text, out);
}

/**
 * measureField 0x10031e60: pokes the ctx word, then when the context and the
 * column font are both present measures the field text through the leaf
 * service; otherwise the measured extents are zeroed.
 */
export function measureField(L, ctx, node, col) {
  const field = L.read(node + LIST_ROW.fieldsData, 'u32') + col * LIST_FIELD.size;
  // ctx helper 0x10027740(ctx, 0): clears bit1 of ctx+0x98 (unconditional).
  L.write(ctx + 0x98, 'u32', L.read(ctx + 0x98, 'u32') & ~2 >>> 0);
  const cdata = L.read(L.base + LIST_WINDOW.colsData, 'u32');
  const font = ctx && cdata ? L.read(cdata + col * LIST_COL.size + LIST_COL.font, 'u32') : 0;
  if (!ctx || !font) {
    L.write(field + LIST_FIELD.width, 'u32', 0);
    L.write(field + LIST_FIELD.height, 'u32', 0);
    return;
  }
  const savedA = L.read(ctx + 0x7c, 'u32');
  const savedB = L.read(ctx + 0x80, 'u32');
  // ctx helper 0x10027640(font, font): installs the column font pair.
  L.write(ctx + 0x7c, 'u32', font);
  L.write(ctx + 0x80, 'u32', font);
  const num = L.read(field + LIST_FIELD.textCount, 'u32');
  const textPtr = num ? L.read(field + LIST_FIELD.text, 'u32') : emptyWString(L);
  rejectAsync(requireService(L, 'measureString')(
    L.object, ctx, field + LIST_FIELD.width, field + LIST_FIELD.height, textPtr, 0),
    'measureString');
  L.write(ctx + 0x7c, 'u32', savedA);
  L.write(ctx + 0x80, 'u32', savedB);
}

function emptyWString(L) {
  const ptr = L.mem.emptyWString;
  if (typeof ptr !== 'number' || !ptr)
    modelFail('ListWindow requires the empty wstring cell on the heap service', {kind: 'SERVICE'});
  return ptr;
}

/**
 * updateColWidth 0x10031f80: needed = 2*padX + field.width (x87 wide add);
 * when needed > col.width it stores the f32-rounded sum and returns 1.
 */
export function updateColWidth(L, node, col) {
  const fieldW = L.read(
    L.read(node + LIST_ROW.fieldsData, 'u32') + col * LIST_FIELD.size + LIST_FIELD.width, 'f32');
  const needed = L.read(L.base + LIST_WINDOW.padX, 'f32') * 2 + fieldW;
  const cdata = L.read(L.base + LIST_WINDOW.colsData, 'u32');
  const colW = cdata + col * LIST_COL.size + LIST_COL.width;
  if (!(needed > L.read(colW, 'f32'))) return 0;
  L.write(colW, 'f32', needed);
  return 1;
}

/**
 * resizeRowFields 0x100320b0: shrink destructs fields [numCols, count) then
 * FArray::Remove (or destructs all + empties when numCols <= 0); growth uses
 * the shared TArray grow then zero-fills the added fields.
 */
export function resizeRowFields(L, node) {
  if (!node) return;
  const numCols = L.read(L.base + LIST_WINDOW.numCols, 'i32');
  const fields = node + LIST_ROW.fieldsData;
  const count = L.read(fields + 4, 'i32');
  if (numCols < count) {
    const data = L.read(fields, 'u32');
    if (numCols > 0) {
      for (let i = numCols; i < count; i++) {
        fstringReset(L, data + i * LIST_FIELD.size, 0);
        fstringDtor(L, data + i * LIST_FIELD.size);
      }
      farrayRemove(L, fields, numCols, count - numCols, LIST_FIELD.size);
    } else {
      for (let i = 0; i < count; i++) fieldDtor(L, data + i * LIST_FIELD.size);
      farrayEmpty(L, fields, LIST_FIELD.size, 0);
    }
  } else if (numCols > count) {
    farraySetNum(L, fields, numCols, LIST_FIELD.size);
    zeroBytes(L, L.read(fields, 'u32') + count * LIST_FIELD.size,
      (numCols - count) * LIST_FIELD.size);
  }
}

/**
 * parseRow 0x100322a0: acquires the measure context, resizes the field array
 * to the column count, then per column copies the next delimiter-bounded
 * token (<= 0x7ff wchars) into the field, measures it, and auto-expands the
 * column width.  Returns 1 when any column width changed.
 */
export function parseRow(L, node, text) {
  let changed = 0;
  const ctx = rejectAsync(
    requireService(L, 'acquireContext')(L.object, L.base), 'acquireContext') | 0;
  if (node) {
    resizeRowFields(L, node);
    const numCols = L.read(L.base + LIST_WINDOW.numCols, 'i32');
    const dnum = L.read(L.base + LIST_WINDOW.delimiter + 4, 'u32');
    const delim = dnum ? L.read(L.read(L.base + LIST_WINDOW.delimiter, 'u32'), 'u16') : 0;
    let pos = 0;
    for (let col = 0; col < numCols; col++) {
      let token = '';
      if (text != null) {
        let i = pos;
        while (i < text.length && text.charCodeAt(i) !== delim) i++;
        token = text.substr(pos, Math.min(i - pos, LIST_TOKEN_CAP));
        pos = i < text.length ? i + 1 : i;
      }
      setFieldText(L, node, col, token);
      measureField(L, ctx, node, col);
      if ((L.read(L.base + LIST_WINDOW.flags, 'u32') & LIST_FLAGS.autoExpand)
          && updateColWidth(L, node, col)) changed = 1;
    }
  }
  if (ctx)
    rejectAsync(requireService(L, 'releaseContext')(L.object, L.base, ctx), 'releaseContext');
  return changed;
}

/**
 * createNode 0x10032420: GMalloc->Malloc(24, "new"), fields array grown to
 * numCols via the TArray formula and zero-filled, then parseRow fills fields.
 * Returns the node (0 on allocation failure).
 */
export function createRowNode(L, text, clientData) {
  const node = L.alloc(LIST_ROW.size, 'new');
  if (!node) return 0;
  const fields = node + LIST_ROW.fieldsData;
  L.write(fields, 'u32', 0);
  L.write(fields + 4, 'u32', 0);
  L.write(fields + 8, 'u32', 0);
  L.write(node + LIST_ROW.id, 'i32', -1);
  L.write(node + LIST_ROW.flags, 'u32', L.read(node + LIST_ROW.flags, 'u32') & ~1 >>> 0);
  L.write(node + LIST_ROW.clientData, 'i32', clientData);
  const numCols = L.read(L.base + LIST_WINDOW.numCols, 'i32');
  const count = L.read(fields + 4, 'i32');
  farraySetNum(L, fields, count + numCols, LIST_FIELD.size);
  zeroBytes(L, L.read(fields, 'u32') + count * LIST_FIELD.size, numCols * LIST_FIELD.size);
  parseRow(L, node, text);
  return node;
}

/**
 * buildSortList 0x10032560: columns with sortPriority >= 0 are inserted into
 * the sort list in ascending priority order, stable with respect to column
 * order; the list is capped at 0x100 entries.
 */
export function buildSortList(L) {
  const sortList = L.mem.sortList;
  const sortCount = L.mem.sortCount;
  if (typeof sortList !== 'number' || typeof sortCount !== 'number')
    modelFail('ListWindow requires sort-list globals on the heap service', {kind: 'SERVICE'});
  const numCols = L.read(L.base + LIST_WINDOW.numCols, 'i32');
  const cdata = L.read(L.base + LIST_WINDOW.colsData, 'u32');
  let count = 0;
  L.write(sortCount, 'i32', 0);
  for (let i = 0; i < numCols; i++) {
    const colPtr = cdata + i * LIST_COL.size;
    const prio = L.read(colPtr + LIST_COL.sortPriority, 'i32');
    if (prio < 0) continue;
    let slot = count - 1;
    while (slot >= 0
           && prio > L.read(L.read(sortList + 4 * slot, 'u32') + LIST_COL.sortPriority, 'i32')) {
      L.write(sortList + 4 * (slot + 1), 'u32', L.read(sortList + 4 * slot, 'u32'));
      slot -= 1;
    }
    L.write(sortList + 4 * (slot + 1), 'u32', colPtr);
    count += 1;
    L.write(sortCount, 'i32', count);
    if (count >= LIST_SORT_CAP) break;
  }
}

/**
 * Row comparator 0x100326d0: walks the sort list; text columns compare with
 * appStricmp (bit1 clear) or appStrcmp (bit1 set) on num?data:EMPTY, with
 * bit0 swapping operand order; numeric columns (type 1/2) compare the f32
 * field values honoring bit0; ties fall through to the signed row id.
 */
export function compareRows(L, a, b) {
  const sortList = L.mem.sortList;
  const sortCount = L.mem.sortCount;
  if (typeof sortList !== 'number' || typeof sortCount !== 'number')
    modelFail('ListWindow requires sort-list globals on the heap service', {kind: 'SERVICE'});
  const count = L.read(sortCount, 'i32');
  for (let i = 0; i < count; i++) {
    const colPtr = L.read(sortList + 4 * i, 'u32');
    const colIndex = L.read(colPtr + LIST_COL.index, 'i32');
    const type = L.read(colPtr + LIST_COL.type, 'u8');
    const sortFlags = L.read(colPtr + LIST_COL.sortFlags, 'u32');
    const offset = colIndex * LIST_FIELD.size;
    let result = 0;
    if (type === 1 || type === 2) {
      const av = L.read(L.read(a + LIST_ROW.fieldsData, 'u32') + offset + LIST_FIELD.value, 'f32');
      const bv = L.read(L.read(b + LIST_ROW.fieldsData, 'u32') + offset + LIST_FIELD.value, 'f32');
      if (sortFlags & SORT_REVERSE) result = av > bv ? -1 : av < bv ? 1 : 0;
      else result = av < bv ? -1 : av > bv ? 1 : 0;
    } else {
      const af = L.read(a + LIST_ROW.fieldsData, 'u32') + offset;
      const bf = L.read(b + LIST_ROW.fieldsData, 'u32') + offset;
      const at = fieldText(L, af);
      const bt = fieldText(L, bf);
      const [x, y] = sortFlags & SORT_REVERSE ? [bt, at] : [at, bt];
      result = sortFlags & SORT_CASE_SENSITIVE ? wcsCompare(x, y) : wcsiCompare(x, y);
    }
    if (result) return result;
  }
  const aid = L.read(a + LIST_ROW.id, 'i32');
  const bid = L.read(b + LIST_ROW.id, 'i32');
  return aid < bid ? -1 : aid > bid ? 1 : 0;
}

/** MSVCRT wcscmp on u16 code units. */
function wcsCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d) return d < 0 ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** MSVCRT _wcsicmp in the C locale: ASCII-only tolower. */
function wcsiCompare(a, b) {
  return wcsCompare(asciiLower(a), asciiLower(b));
}

function asciiLower(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
  }
  return out;
}

/**
 * bsearch 0x10032600: rebuilds the sort list, then binary-searches the rows
 * array for `node` via the comparator; returns {pos, found} where pos is the
 * (hi+lo)>>1 slot and found is 1 on an exact compare-equal hit.
 */
export function bsearchRow(L, node) {
  buildSortList(L);
  const rdata = L.read(L.base + LIST_WINDOW.rowsData, 'u32');
  const count = L.read(L.base + LIST_WINDOW.rowsCount, 'i32');
  let lo = 0, hi = Math.max(count, 0), found = 0;
  while (lo !== hi) {
    const mid = (lo + hi) >> 1;
    const cmp = compareRows(L, L.read(rdata + 4 * mid, 'u32'), node);
    if (!cmp) { found = 1; break; }
    if (cmp > 0) hi = mid; else lo = mid + 1;
  }
  return {pos: (lo + hi) >> 1, found};
}

/**
 * insert 0x10032b50: sorted windows binary-search the position (inserting
 * after equal entries), memmove the tail, and renumber row ids from pos;
 * unsorted windows append and stamp the new row id.
 */
export function insertRowNode(L, node) {
  if (!node) return;
  const rows = L.base + LIST_WINDOW.rowsData;
  const count = L.read(rows + 4, 'i32');
  if (L.read(L.base + LIST_WINDOW.flags, 'u32') & LIST_FLAGS.sorting) {
    const {pos, found} = bsearchRow(L, node);
    const at = found ? pos + 1 : pos;
    farraySetNum(L, rows, count + 1, 4);
    const data = L.read(rows, 'u32');
    moveBytes(L, data + (at + 1) * 4, data + at * 4, (count - at) * 4);
    L.write(data + 4 * at, 'u32', node);
    const total = L.read(rows + 4, 'i32');
    for (let i = at; i < total; i++)
      L.write(L.read(data + 4 * i, 'u32') + LIST_ROW.id, 'i32', i);
  } else {
    farraySetNum(L, rows, count + 1, 4);
    const data = L.read(rows, 'u32');
    L.write(data + 4 * count, 'u32', node);
    L.write(node + LIST_ROW.id, 'i32', count);
  }
}

/**
 * Selection broadcast 0x100331a0: walks the parent chain calling the
 * receiver's selection-changed virtual (slot 0x10c) with
 * (sender=this, count=numSelected, node=selected); stops at a nonzero return
 * or the end of the chain and propagates the last return value.
 */
export function broadcastSelection(L) {
  let receiver = L.base;
  while (receiver) {
    const ret = rejectAsync(requireService(L, 'selectionChanged')(
      L.object, receiver, L.base,
      L.read(L.base + LIST_WINDOW.numSelected, 'i32'),
      L.read(L.base + LIST_WINDOW.selected, 'u32')), 'selectionChanged') | 0;
    if (ret) return ret;
    receiver = L.read(receiver + LIST_WINDOW.parent, 'u32');
  }
  return 0;
}

/** AskParentForReconfigure 0x1004e060 — leaf boundary: event only. */
export function askParentReconfigure(L) {
  rejectAsync(requireService(L, 'askParentForReconfigure')(L.object, L.base),
    'askParentForReconfigure');
}

/** Measure-context acquire 0x1004ddc0 — leaf boundary: event + ctx handle. */
export function acquireContext(L) {
  return rejectAsync(requireService(L, 'acquireContext')(L.object, L.base),
    'acquireContext') | 0;
}

/** Measure-context release 0x1004de50 — leaf boundary: event only. */
export function releaseContext(L, ctx) {
  rejectAsync(requireService(L, 'releaseContext')(L.object, L.base, ctx),
    'releaseContext');
}

/**
 * Column initializer 0x100314f0(this, col, index): stamps the column index,
 * assigns the header and format FStrings from the shared empty wstring (the
 * len-0 assign: num = max = 0 then Realloc — a Realloc(0, 0) event on fresh
 * columns), clears the sort priority and the low three sort-flag bits, sets
 * width = f32(2*padX + 20.0), zeroes the flag byte and type, and copies the
 * window's packed dword (+0x3d) and default font (+0x54).  The native
 * self-assign guard (data == EMPTY_WSTRING) cannot fire for a zeroed column.
 */
export function initColumn(L, colPtr, index) {
  L.write(colPtr + LIST_COL.index, 'i32', index);
  fstringAssign(L, colPtr + LIST_COL.header, '');
  L.write(colPtr + LIST_COL.sortPriority, 'i32', 0);
  L.write(colPtr + LIST_COL.sortFlags, 'u32',
    (L.read(colPtr + LIST_COL.sortFlags, 'u32') & ~7) >>> 0);
  L.write(colPtr + LIST_COL.width, 'f32',
    L.read(L.base + LIST_WINDOW.padX, 'f32') * 2 + 20.0);
  L.write(colPtr + LIST_COL.flagByte, 'u8', 0);
  L.write(colPtr + LIST_COL.packed, 'u32',
    L.read(L.base + LIST_WINDOW.colPacked, 'u32'));
  L.write(colPtr + LIST_COL.font, 'u32',
    L.read(L.base + LIST_WINDOW.defFont, 'u32'));
  L.write(colPtr + LIST_COL.type, 'u8', 0);
  fstringAssign(L, colPtr + LIST_COL.format, '');
}

/**
 * Column destructor 0x100161c0 (also inlined by SetNumColumns' shrink path
 * 0x1002fb3d): resets header then format (each num = max = 0 + Realloc,
 * freeing the data), then ~FString on format then header (a second
 * Realloc(0, 0) each plus the Remove/Free tail).  Four allocator events per
 * destroyed column, in exactly this order.
 */
export function columnDtor(L, colPtr) {
  fstringReset(L, colPtr + LIST_COL.header, 0);
  fstringReset(L, colPtr + LIST_COL.format, 0);
  fstringDtor(L, colPtr + LIST_COL.format);
  fstringDtor(L, colPtr + LIST_COL.header);
}

/**
 * Two-level glyph lookup 0x10026950 behind 0x10026880: row = id/perRow,
 * col = id - row*perRow (id & 0xffff first); hit requires row < font row
 * count and col < the row record's count; the glyph pointer is the row run
 * base + col*0x10.  Returns 0 on a miss (the caller then substitutes the
 * zeroed image pair 0x100aeba0).  A zero perRow is a native divide fault,
 * surfaced as a boundary error rather than an invented glyph.
 */
function glyphLookup(L, font, glyphId) {
  const ch = glyphId & 0xffff;
  const perRow = L.read(font + 0x28, 'i32');
  if (!perRow)
    modelFail('ListWindow glyph lookup hit a font with no columns-per-row',
      {kind: 'BOUNDARY', value: font});
  const row = Math.trunc(ch / perRow);
  const col = ch - row * perRow;
  if (row >= L.read(font + 0x30, 'i32')) return 0;
  const rec = L.read(font + 0x2c, 'u32') + row * 0x10;
  if (col >= L.read(rec + 8, 'i32')) return 0;
  return L.read(rec + 4, 'u32') + col * 0x10;
}

/**
 * glyphEntry 0x100267e0: *outW = rec+8 and *outH = rec+0xc when the
 * out-pointer is nonzero.  On a lookup miss the native zeroes the image
 * globals 0x100aeba8/0x100aebac and returns 0x100aeba0, so both outputs read
 * as zero through the returned record.
 */
export function glyphEntry(L, font, glyphId, outW, outH) {
  let rec = glyphLookup(L, font, glyphId);
  if (!rec) {
    rec = L.mem.glyphMiss;
    if (typeof rec !== 'number' || !rec)
      modelFail('ListWindow requires the glyph-miss pair on the heap service',
        {kind: 'SERVICE'});
    L.write(rec + 8, 'u32', 0);
    L.write(rec + 0xc, 'u32', 0);
  }
  if (outW) L.write(outW, 'u32', L.read(rec + 8, 'u32'));
  if (outH) L.write(outH, 'u32', L.read(rec + 0xc, 'u32'));
}

/**
 * Row-height recompute 0x10031fd0: rowHeight = 0, then per column with a
 * font the space glyph's height (fild of the int at rec+0xc) replaces
 * rowHeight only when strictly greater (fcom + test ah,0x41 skips on
 * less/equal/unordered); finally rowHeight = f32(rowHeight + 2*padY).
 */
export function recomputeRowHeight(L) {
  const heightAt = L.base + LIST_WINDOW.rowHeight;
  L.write(heightAt, 'f32', 0);
  const numCols = L.read(L.base + LIST_WINDOW.numCols, 'i32');
  const cdata = L.read(L.base + LIST_WINDOW.colsData, 'u32');
  const scratch = L.mem.glyphScratch;
  if (typeof scratch !== 'number' || !scratch)
    modelFail('ListWindow requires the glyph scratch cell on the heap service',
      {kind: 'SERVICE'});
  for (let i = 0; i < numCols; i++) {
    const font = L.read(cdata + i * LIST_COL.size + LIST_COL.font, 'u32');
    if (!font) continue;
    glyphEntry(L, font, 0x20, 0, scratch);
    const h = L.read(scratch, 'i32');
    if (h > L.read(heightAt, 'f32')) L.write(heightAt, 'f32', h);
  }
  L.write(heightAt, 'f32',
    L.read(heightAt, 'f32') + 2 * L.read(L.base + LIST_WINDOW.padY, 'f32'));
}

/**
 * Auto-expand driver 0x1002fc40(this, reset): when reset is 0 every column
 * width is first set to f32(2*padX); then for every row/column pair
 * updateColWidth 0x10031f80 widens columns to fit the measured field width
 * plus 2*padX; always ends with AskParentForReconfigure.
 */
export function autoExpandColumns(L, reset) {
  const numCols = L.read(L.base + LIST_WINDOW.numCols, 'i32');
  const cdata = L.read(L.base + LIST_WINDOW.colsData, 'u32');
  if (!(reset | 0)) {
    const w = L.read(L.base + LIST_WINDOW.padX, 'f32') * 2;
    for (let i = 0; i < numCols; i++)
      L.write(cdata + i * LIST_COL.size + LIST_COL.width, 'f32', w);
  }
  const count = L.read(L.base + LIST_WINDOW.rowsCount, 'i32');
  const rdata = L.read(L.base + LIST_WINDOW.rowsData, 'u32');
  for (let r = 0; r < count; r++) {
    const node = L.read(rdata + 4 * r, 'u32');
    for (let c = 0; c < numCols; c++) updateColWidth(L, node, c);
  }
  askParentReconfigure(L);
}

/**
 * appQsort — Core 0x1010194c forwarding to the shipped MSVCRT qsort
 * 0x7802543d.  Byte-faithful port of that body: while the run exceeds 8
 * elements the midpoint element is swapped to the front (swap only, no
 * median compare), the partition scans loguy upward while
 * comp(loguy, lo) <= 0 and higuy downward while comp(higuy, lo) >= 0, swaps
 * equal-passing pairs until the scans cross, then plants the pivot at higuy
 * with swap(lo, higuy).  The larger half is pushed on the 30-entry lo/hi
 * stack and the loop continues on the smaller; runs of <= 8 go through
 * shortsort 0x780255e2, which selection-sorts each pass's max element to the
 * shrinking back edge.  Element access is by byte address through the heap;
 * the only caller uses width 4 on the rows pointer array.
 */
function swapBytes(L, a, b, width) {
  if (a === b) return;
  for (let i = 0; i < width; i++) {
    const t = L.read(a + i, 'u8');
    L.write(a + i, 'u8', L.read(b + i, 'u8'));
    L.write(b + i, 'u8', t);
  }
}

function shortsort(L, lo, hi, width, cmp) {
  for (let end = hi; end > lo; end -= width) {
    let max = lo;
    for (let p = lo + width; p <= end; p += width)
      if (cmp(p, max) > 0) max = p;
    swapBytes(L, max, end, width);
  }
}

export function appQsort(L, base, num, width, cmp) {
  if (num < 2 || !width) return;
  const lostk = [], histk = [];
  let lo = base, hi = base + width * (num - 1);
  for (;;) {
    const size = Math.trunc((hi - lo) / width) + 1;
    if (size <= 8) {
      shortsort(L, lo, hi, width, cmp);
    } else {
      const mid = lo + Math.trunc(size / 2) * width;
      swapBytes(L, mid, lo, width);
      let loguy = lo, higuy = hi + width;
      for (;;) {
        do { loguy += width; } while (loguy <= hi && cmp(loguy, lo) <= 0);
        do { higuy -= width; } while (higuy > lo && cmp(higuy, lo) >= 0);
        if (higuy < loguy) break;
        swapBytes(L, loguy, higuy, width);
      }
      swapBytes(L, lo, higuy, width);
      if (higuy - lo - 1 < hi - loguy) {
        if (loguy < hi) { lostk.push(hi); histk.push(loguy); }
        if (lo + width >= higuy) { /* pop below */ }
        else { hi = higuy - width; continue; }
      } else {
        if (lo + width < higuy) { histk.push(lo); lostk.push(higuy - width); }
        if (loguy < hi) { lo = loguy; continue; }
      }
    }
    if (!lostk.length) return;
    hi = lostk.pop();
    lo = histk.pop();
  }
}

/**
 * Renumber 0x10031660: row[i].id = i for every row in order.
 */
export function renumberRowIds(L) {
  const count = L.read(L.base + LIST_WINDOW.rowsCount, 'i32');
  const rdata = L.read(L.base + LIST_WINDOW.rowsData, 'u32');
  for (let i = 0; i < count; i++)
    L.write(L.read(rdata + 4 * i, 'u32') + LIST_ROW.id, 'i32', i);
}

/**
 * Sort driver 0x100329b0: rebuilds the sort-column list, qsorts the rows
 * pointer array when count > 1 through the qsort callback 0x10032a50
 * (compareRows on the two dereferenced nodes), then renumbers row ids.
 */
export function sortRows(L) {
  buildSortList(L);
  const count = L.read(L.base + LIST_WINDOW.rowsCount, 'i32');
  if (count > 1) {
    const rdata = L.read(L.base + LIST_WINDOW.rowsData, 'u32');
    appQsort(L, rdata, count, 4,
      (pa, pb) => compareRows(L, L.read(pa, 'u32'), L.read(pb, 'u32')));
  }
  renumberRowIds(L);
}

/**
 * Selection-bit helper 0x10032dc0(this, index, newState, out): when the row's
 * selected bit differs from the full newState dword the bit is replaced
 * ((flags ^ newState) & 1) ^ flags, numSelected is decremented for a zero
 * newState and incremented for any nonzero value, and *out is set to 1.
 * Returns the value the native would write to *out (0 when unchanged).
 */
export function selectRowAt(L, index, newState) {
  const node = L.read(
    L.read(L.base + LIST_WINDOW.rowsData, 'u32') + 4 * index, 'u32');
  const flags = L.read(node + LIST_ROW.flags, 'u32');
  if ((flags & 1) === (newState | 0)) return 0;
  L.write(node + LIST_ROW.flags, 'u32', (((flags ^ newState) & 1) ^ flags) >>> 0);
  const n = L.read(L.base + LIST_WINDOW.numSelected, 'i32');
  L.write(L.base + LIST_WINDOW.numSelected, 'i32', newState ? n + 1 : n - 1);
  return 1;
}
