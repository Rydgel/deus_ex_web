// Shared XTextWindow / XTextLogWindow / XLargeTextWindow runtime model for
// the recovered Extension.dll text-display bodies.
//
// Faithful translation layer shared by the per-native script-text-*.mjs
// bindings.  All offsets, flag masks, and helper semantics come from the
// original Extension.dll / Core.dll bodies documented in
// docs/script-text-model.md.  Allocator calls, the reconfigure leaf, the
// clock leaf, and script-VM parameter marshalling stay explicit services so
// each native module reproduces the binary's call sequence.
//
// Recovered bodies (Extension.dll image base 0x10000000):
//   0x10045d50  XTextWindow::SetText method (vtable +0x11c)
//   0x10045e60  XTextWindow::AppendText method (vtable +0x120)
//   0x10045fb0  XTextWindow::SetWordWrap
//   0x10046050  XTextWindow::SetTextAlignments
//   0x10046070  XTextWindow::SetTextMargins
//   0x10046120  XTextWindow::SetLines
//   0x100461d0  XTextWindow::SetMinLines
//   0x10046270  XTextWindow::SetMaxLines
//   0x10046310  XTextWindow::ResetLines
//   0x100463b0  XTextWindow::SetMinWidth
//   0x10046450  XTextWindow::ResetMinWidth
//   0x100464e0  XTextWindow::EnableTextAsAccelerator
//   0x10046cd0  XTextWindow::GetText exec body (inline)
//   0x10046d70  XTextWindow::GetTextLength exec body (inline)
//   0x10046dc0  XTextWindow::GetTextPart exec body (inline, FString::Mid)
//   0x100476a0  XTextLogWindow::AddLog method
//   0x10047810  XTextLogWindow::ClearLog method
//   0x100478e0  XTextLogWindow::SetTextTimeout method (raw store)
//   0x10048210  XTextLogWindow::PauseLog exec body (inline flag write)
//   0x1002d7e0  XLargeTextWindow::SetVerticalSpacing method
//   0x10047dc0  log->text rebuild helper (AddLog/ClearLog tail)
//   0x1004f310  SetAcceleratorText helper (|&x scan)
//   0x1004f3b0  SetAcceleratorKey helper (16-bit clamp <0xff, dirty on change)
//   0x1004c580  accelerator root walk (windowType >= 2 ancestor)
//   0x1004c1d0  accelerator dirty flag (root +0x584 |= 1)
//   0x10050710  exec convertPipes (shared with EditWindow — imported)
//
// Leaf boundaries (probe stubs / JS services):
//   0x1004e060  AskParentForReconfigure        -> event
//   0x1004fda0  GetTime (appSecondsSlow/rdtsc) -> configured `now` service
//   Core ?GNatives@@ readers                   -> marshal boundary
//   0x100546da  atexit thunk (convertPipes init) -> no-op

import {
  growArrayMax,
  moveBytes,
  zeroBytes,
  farrayRealloc,
  farrayEmpty,
  farrayRemove,
  farrayDtor,
} from './script-window-list-model.mjs';
import {convertPipes, wcharLen} from './script-edit-model.mjs';

export {convertPipes};

export class TextWindowModelBoundaryError extends Error {
  constructor(message) {
    super(`TextWindow model boundary: ${message}`);
    this.name = 'TextWindowModelBoundaryError';
  }
}

export const TEXT_WINDOW_DLL = Object.freeze({
  dll: 'Extension.dll',
  imageBase: 0x10000000,
  oracleBase: 0x12000000,
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
});

// Recovered object layout (docs/script-text-model.md).
export const TEXT_WINDOW = Object.freeze({
  windowType: 0x28,        // byte: accelerator root walk stops at >= 2
  accelKey: 0xb4,          // dword: accelerator key code
  parent: 0x138,
  hAlign: 0x14c,           // byte
  vAlign: 0x14d,           // byte
  textFlags: 0x150,        // bit0 wordWrap, bit1 textAccelerator
  hMargin: 0x154,          // f32
  vMargin: 0x158,          // f32
  minLines: 0x15c,         // i32 (-1 = unset)
  maxLines: 0x160,         // i32
  minWidth: 0x164,         // f32
  text: 0x168,             // FString {data,num,max}
  textNum: 0x16c,
  textMax: 0x170,
  lineSpacing: 0x174,      // f32 — TextLog timeout / LargeText vSpace
  logData: 0x178,          // TArray of 0x14-byte log records
  logNum: 0x17c,
  logMax: 0x180,
  logFlags: 0x184,         // bit2 pause
  accelFlags: 0x584,       // on the windowType>=2 ancestor: bit0 dirty
});

export const TEXT_LOG = Object.freeze({
  size: 0x14, expire: 0, text: 4, textNum: 8, textMax: 0xc, color: 0x10,
});
export const TEXT_FLAGS = Object.freeze({wordWrap: 1, accelerator: 2});
export const LOG_FLAG_PAUSE = 4;

// Image-global cells (RVA in Extension.dll; mirrored by heap members).
export const TEXT_GLOBALS = Object.freeze({
  emptyWString: 0x99ea8,
  logSeparator: 0x98e58,   // L"\n"
  convertBuffer: 0xaead0,
  convertFlag: 0xaeac8,
  convertRun: 0xadd98,
  zeroF32: 0x59884,        // +0.0f compare constant
});

const modelFail = message => {
  throw new TextWindowModelBoundaryError(message);
};

export function rejectAsyncText(value, label) {
  if (value && typeof value.then === 'function') {
    modelFail(`TextWindow ${label} suspended`);
  }
  return value;
}

function requireMem(services) {
  const mem = services && services.mem;
  if (!mem || typeof mem.read !== 'function' || typeof mem.write !== 'function'
      || typeof mem.alloc !== 'function' || typeof mem.free !== 'function'
      || typeof mem.realloc !== 'function' || typeof mem.readString !== 'function'
      || typeof mem.allocString !== 'function') {
    modelFail('TextWindow requires a raw native heap service (mem)');
  }
  return mem;
}

/** Checked accessors over the injected byte-addressable heap service. */
export function textMemory(object, services) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    modelFail('TextWindow requires a canonical window object');
  }
  const mem = requireMem(services);
  const base = rejectAsyncText(
    services.objectAddress ? services.objectAddress(object) : object.base,
    'objectAddress',
  );
  if (typeof base !== 'number' || !Number.isInteger(base) || base <= 0) {
    modelFail('TextWindow requires the window heap address');
  }
  const sync = (value, label) => rejectAsyncText(value, label);
  const int32 = value => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      modelFail('TextWindow heap read returned a non-integer');
    }
    return value | 0;
  };
  const uint32 = value => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      modelFail('TextWindow heap read returned a non-integer');
    }
    return value >>> 0;
  };
  const float32 = value => {
    if (typeof value !== 'number') {
      modelFail('TextWindow heap read returned a non-number');
    }
    return Math.fround(value);
  };
  const checked = kind => {
    if (kind === 'i32' || kind === 'i16' || kind === 'i8') return int32;
    if (kind === 'u32' || kind === 'u16' || kind === 'u8') return uint32;
    if (kind === 'f32') return float32;
    return modelFail(`TextWindow unsupported heap kind ${kind}`);
  };
  // rejectAsyncText with the label built only for the failure message.
  const read = (address, kind) => {
    const value = mem.read(address, kind);
    if (value && typeof value.then === 'function') rejectAsyncText(value, `read 0x${address.toString(16)}`);
    return checked(kind)(value);
  };
  const write = (address, kind, value) => {
    const result = mem.write(address, kind, value);
    if (result && typeof result.then === 'function') rejectAsyncText(result, `write 0x${address.toString(16)}`);
    return result;
  };
  const alloc = (size, tag) => uint32(sync(mem.alloc(size, tag), 'alloc'));
  const free = address => sync(mem.free(address), 'free');
  const realloc = (address, size, tag) => uint32(sync(mem.realloc(address, size, tag), 'realloc'));
  const readString = address => {
    const text = sync(mem.readString(address), 'readString');
    if (typeof text !== 'string') modelFail('TextWindow readString returned a non-string');
    return text;
  };
  const allocString = text => uint32(sync(mem.allocString(text), 'allocString'));
  return {mem, object, services, base, read, write, alloc, free, realloc, readString, allocString};
}

function requireService(L, name) {
  const fn = L.services && L.services[name];
  if (typeof fn !== 'function') {
    modelFail(`TextWindow requires services.${name}`);
  }
  return fn;
}

function modelAssert(cond, what) {
  if (!cond) modelFail(`assert failed: ${what}`);
}

// ---------------------------------------------------------------------------
// x87 fcomp flag predicates over raw f32 bit patterns.  The bodies use
// `fcomp dword [mem]` then `fnstsw`/`test ah`: C0 (ah&1) is set iff
// ST0 < operand or the compare is unordered (NaN); C3 (ah&0x40) iff
// ST0 == operand or unordered; C0|C3 (ah&0x41) iff ST0 <= operand or
// unordered.  f32 patterns widen exactly to f64, so JS compares are exact.
const f32box = new DataView(new ArrayBuffer(4));
export function f32Bits(value) {
  f32box.setFloat32(0, value, true);
  return f32box.getUint32(0, true);
}
export function f32Value(bits) {
  f32box.setUint32(0, bits >>> 0, true);
  return f32box.getFloat32(0, true);
}
const nan32 = bits => (bits & 0x7f800000) === 0x7f800000 && (bits & 0x7fffff) !== 0;
export function fcompC0(aBits, bBits) {
  if (nan32(aBits) || nan32(bBits)) return true;
  return f32Value(aBits) < f32Value(bBits);
}
export function fcompC3(aBits, bBits) {
  if (nan32(aBits) || nan32(bBits)) return true;
  return f32Value(aBits) === f32Value(bBits);
}
export function fcompC0C3(aBits, bBits) {
  if (nan32(aBits) || nan32(bBits)) return true;
  return f32Value(aBits) <= f32Value(bBits);
}

// ---------------------------------------------------------------------------
// Wide-character helpers (Core appStrlen/appStrcpy/appStrncpy/appStricmp).

function emptyWString(L) {
  const ptr = L.mem.emptyWString;
  if (!Number.isInteger(ptr)) {
    throw new TextWindowModelBoundaryError('memory service lacks emptyWString');
  }
  return ptr;
}

function logSeparator(L) {
  const ptr = L.mem.logSeparator;
  if (!Number.isInteger(ptr)) {
    throw new TextWindowModelBoundaryError('memory service lacks logSeparator');
  }
  return ptr;
}

// Core appStrcpy (0x10123xxx): wstrcpy — copy through the NUL.
export function wcharCopy(L, dst, src) {
  let i = 0;
  for (;;) {
    const ch = L.read(src + i * 2, 'u16');
    L.write(dst + i * 2, 'u16', ch);
    if (ch === 0) return;
    i += 1;
  }
}

// Core appStrncpy: wcsncpy(dst, src, n) then dst[n-1] = 0 — the forced
// terminator overwrites the nth copied slot, so callers pass n+1.
export function wcharCopyN(L, dst, src, n) {
  let i = 0;
  for (; i < n; i += 1) {
    const ch = L.read(src + i * 2, 'u16');
    L.write(dst + i * 2, 'u16', ch);
    if (ch === 0) {
      i += 1;
      break;
    }
  }
  for (; i < n; i += 1) L.write(dst + i * 2, 'u16', 0);
  L.write(dst + (n - 1) * 2, 'u16', 0);
}

// Core appStricmp (0x10123a30 -> MSVCRT _wcsicmp): ASCII-fold compare
// (towlower under the C locale; only A-Z fold).  Non-ASCII case folding in
// the CRT table is not modelled — inputs outside ASCII fold as written.
const fold = c => (c >= 0x41 && c <= 0x5a) ? c + 0x20 : c;
export function wcharCmpI(L, a, b) {
  for (let i = 0; ; i += 1) {
    const ca = fold(L.read(a + i * 2, 'u16'));
    const cb = fold(L.read(b + i * 2, 'u16'));
    if (ca !== cb) return ca - cb;
    if (ca === 0) return 0;
  }
}

// rep movsd/rep movsb byte copy (forward memcpy; the bodies never feed it
// overlapping ranges — the self-pointer guard handles the aliased case).
export function copyBytes(L, dst, src, count) {
  for (let i = 0; i < count; i += 1) L.write(dst + i, 'u8', L.read(src + i, 'u8'));
}

// ---------------------------------------------------------------------------
// FString helpers recovered from the bodies.

// Shared `dst = src-wchar*` assign sequence (0x10045dac / 0x10046e9c /
// 0x10047760 / 0x10047e01 shape): num = max = (*src ? wcslen(src)+1 : 0);
// FArray::Realloc(2); copy num*2 bytes.
export function fstringAssignPtr(L, dst, srcPtr) {
  const n = L.read(srcPtr, 'u16') !== 0 ? wcharLen(L, srcPtr) + 1 : 0;
  L.write(dst + 8, 'i32', n);
  L.write(dst + 4, 'i32', n);
  farrayRealloc(L, dst, 2);
  if (L.read(dst + 4, 'i32') !== 0) {
    copyBytes(L, L.read(dst, 'u32'), srcPtr, n * 2);
  }
}

// Same assign but the source is an FString cell: num = src.num (the stored
// count, including the NUL) — used by the exec marshal's out-string copy.
export function fstringAssignFString(L, dst, src) {
  const n = src !== 0 ? L.read(src + 4, 'i32') : 0;
  L.write(dst + 4, 'i32', n);
  L.write(dst + 8, 'i32', n);
  farrayRealloc(L, dst, 2);
  if (n !== 0) {
    const srcData = L.read(src, 'u32');
    copyBytes(L, L.read(dst, 'u32'), srcData !== 0 ? srcData : emptyWString(L), n * 2);
  }
}

// this->text.data when num != 0, else the shared L"" — the standard
// text-pointer select used by every body that hands the text out.
export function textDataOrEmpty(L) {
  const num = L.read(L.base + TEXT_WINDOW.textNum, 'i32');
  return num !== 0 ? L.read(L.base + TEXT_WINDOW.text, 'u32') : emptyWString(L);
}

// Core FString::Mid(ret, start, count) — thunk 0x10102284 -> 0x101086e0.
// s = min_u(start, len); e = start+count (32-bit); e = (e <u s) ? s :
// min_u(e, len); slice = e - s; ret = {0, slice?slice+1:0, same}; Realloc(2);
// if num: appStrncpy(ret.data, srcOrEmpty + s*2, slice+1).
export function fstringMid(L, dst, srcStr, start, count) {
  const srcNum = L.read(srcStr + 4, 'i32');
  const len = srcNum !== 0 ? srcNum - 1 : 0;
  const s = Math.min(start >>> 0, len >>> 0);
  let e = (start + count) >>> 0;
  e = e < (s >>> 0) ? s : Math.min(e, len >>> 0);
  const slice = (e - (s >>> 0)) | 0;
  const n = slice !== 0 ? (slice + 1) | 0 : 0;
  L.write(dst, 'u32', 0);
  L.write(dst + 4, 'i32', n);
  L.write(dst + 8, 'i32', n);
  farrayRealloc(L, dst, 2);
  if (n !== 0) {
    const srcData = srcNum !== 0 ? L.read(srcStr, 'u32') : emptyWString(L);
    wcharCopyN(L, L.read(dst, 'u32'), srcData + s * 2, slice + 1);
  }
  return dst;
}

// 0x100126d0 — bounds-checked FArray::Remove(&str, index, count, 2).
function boundedRemove(L, str, index, count) {
  const num = L.read(str + 4, 'i32');
  modelAssert(index >= 0, 'boundedRemove index');
  modelAssert(index <= num, 'boundedRemove index>num');
  modelAssert(index + count <= num, 'boundedRemove overflow');
  farrayRemove(L, str, index, count, 2);
}

function freeIfData(L, str) {
  const data = L.read(str, 'u32');
  if (data !== 0) L.free(data);
}

// 0x10003990 — Extension-side FString destroy: Remove(0, num, 2) then Free.
function extFStringDtor(L, str) {
  const num = L.read(str + 4, 'i32');
  modelAssert(num >= 0, 'fstring dtor num');
  farrayRemove(L, str, 0, num, 2);
  freeIfData(L, str);
  L.write(str, 'u32', 0);
  L.write(str + 4, 'i32', 0);
  L.write(str + 8, 'i32', 0);
}

// Core FArray::Add (0x10106ff0): num += count; grow by growArrayMax when the
// new count exceeds max; returns the old index.
export function farrayAdd(L, array, count, elemSize) {
  const num = L.read(array + 4, 'i32');
  const newNum = num + count;
  L.write(array + 4, 'i32', newNum);
  if (newNum > L.read(array + 8, 'i32')) {
    L.write(array + 8, 'i32', growArrayMax(newNum));
    farrayRealloc(L, array, elemSize);
  }
  return num;
}

// ---------------------------------------------------------------------------
// Leaf service wrappers.

// 0x1004e060 — AskParentForReconfigure(this): intercepted leaf.
export function askParentForReconfigure(L) {
  rejectAsyncText(
    requireService(L, 'askParentForReconfigure')(L.object, L.base),
    'askParentForReconfigure');
}

// 0x1004fda0 — clock leaf (appSecondsSlow / rdtsc): returns an f64 in ST0.
// The probe patches the body with a deterministic `fld qword; ret` stub; the
// JS side resolves the configured `now` through the service.
export function getTime(L) {
  const value = rejectAsyncText(
    requireService(L, 'getTime')(L.object, L.base), 'getTime');
  if (typeof value !== 'number') {
    modelFail('TextWindow getTime returned a non-number');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Accelerator helpers (real Extension bodies, run natively in the oracle).

// 0x1004c580 — first ancestor-or-self with windowType byte >= 2, else 0.
export function acceleratorRoot(L) {
  let addr = L.base;
  while (addr !== 0 && (L.read(addr + TEXT_WINDOW.windowType, 'u8') >>> 0) < 2) {
    addr = L.read(addr + TEXT_WINDOW.parent, 'u32');
  }
  return addr;
}

// 0x1004c1d0 — set bit0 of +0x584 on the accelerator root when one exists.
export function markAcceleratorDirty(L) {
  const root = acceleratorRoot(L);
  if (root !== 0) {
    L.write(root + TEXT_WINDOW.accelFlags, 'u32',
      L.read(root + TEXT_WINDOW.accelFlags, 'u32') | 1);
  }
}

// 0x1004f3b0 — SetAcceleratorKey(arg): key = (arg & 0xffff) <u 0xff ? that :
// 0; unconditional store to +0xb4; the dirty helper runs only on change.
export function setAcceleratorKey(L, arg) {
  const old = L.read(L.base + TEXT_WINDOW.accelKey, 'u32');
  const key = ((arg & 0xffff) >>> 0) < 0xff ? (arg & 0xffff) : 0;
  L.write(L.base + TEXT_WINDOW.accelKey, 'u32', key);
  if (old !== key) markAcceleratorDirty(L);
}

// 0x1004f310 — SetAcceleratorText(textPtr): scan for the first '|&x'
// sequence and pass the char after '&' (or 0) to SetAcceleratorKey.  A '|'
// followed by a non-'&' consumes BOTH chars (the body advances past '|'
// then past the next char).  A trailing '|' reads the word past the NUL —
// deterministic in the flat heaps because the padding is zero.
export function setAcceleratorText(L, textPtr) {
  let key = 0;
  if (textPtr !== 0) {
    let p = textPtr;
    for (;;) {
      const ch = L.read(p, 'u16');
      if (ch === 0) break;
      if (ch === 0x7c) {                       // '|'
        p += 2;
        if (L.read(p, 'u16') === 0x26) {       // '&'
          key = L.read(p + 2, 'u16');
          break;
        }
        p += 2;
      } else {
        p += 2;
      }
    }
  }
  setAcceleratorKey(L, key);
}

// ---------------------------------------------------------------------------
// XTextWindow method bodies.

// 0x10045d50 — SetText method (vtable +0x11c).  appStricmp equal (case
// INSENSITIVE) returns early with no writes and no reconfigure; a data
// pointer equal to the argument skips the assign but still reconfigures.
// textFlags bit1 routes the NEW argument through SetAcceleratorText.
export function setTextMethod(L, textPtr) {
  const str = L.base + TEXT_WINDOW.text;
  const num = L.read(str + 4, 'i32');
  const old = num !== 0 ? L.read(str, 'u32') : emptyWString(L);
  if (wcharCmpI(L, old, textPtr) === 0) return;
  if (L.read(str, 'u32') !== (textPtr >>> 0)) {
    fstringAssignPtr(L, str, textPtr);
  }
  if ((L.read(L.base + TEXT_WINDOW.textFlags, 'u32') & TEXT_FLAGS.accelerator) !== 0) {
    setAcceleratorText(L, textPtr);
  }
  askParentForReconfigure(L);
}

// 0x10045e60 — AppendText method (vtable +0x120).  num != 0: num += strlen
// (the copy lands on the old NUL); grow by growArrayMax when num exceeds
// max.  num == 0: an empty argument skips the assign entirely (still
// reconfigures); otherwise num = strlen+1 with the same grow.
export function appendTextMethod(L, textPtr) {
  const str = L.base + TEXT_WINDOW.text;
  const num = L.read(str + 4, 'i32');
  if (num !== 0) {
    const newNum = num + wcharLen(L, textPtr);
    L.write(str + 4, 'i32', newNum);
    if (newNum > L.read(str + 8, 'i32')) {
      L.write(str + 8, 'i32', growArrayMax(newNum));
      farrayRealloc(L, str, 2);
    }
    wcharCopy(L, L.read(str, 'u32') + (num - 1) * 2, textPtr);
  } else if (L.read(textPtr, 'u16') !== 0) {
    const n = wcharLen(L, textPtr) + 1;
    L.write(str + 4, 'i32', n);
    if (n > L.read(str + 8, 'i32')) {
      L.write(str + 8, 'i32', growArrayMax(n));
      farrayRealloc(L, str, 2);
    }
    wcharCopy(L, L.read(str, 'u32'), textPtr);
  }
  if ((L.read(L.base + TEXT_WINDOW.textFlags, 'u32') & TEXT_FLAGS.accelerator) !== 0) {
    const n2 = L.read(str + 4, 'i32');
    setAcceleratorText(L, n2 !== 0 ? L.read(str, 'u32') : emptyWString(L));
  }
  askParentForReconfigure(L);
}

// 0x10045fb0 — SetWordWrap(bWrap).  Quirk: the guard compares the isolated
// bit ((flags & 1)) against the RAW dword argument — arg 3/2 still enters
// the write path and reconfigures.  newFlags = flags ^ ((flags ^ arg) & 1).
export function setWordWrapMethod(L, bWrap) {
  const flags = L.read(L.base + TEXT_WINDOW.textFlags, 'u32');
  if ((flags & TEXT_FLAGS.wordWrap) === (bWrap >>> 0)) return;
  L.write(L.base + TEXT_WINDOW.textFlags, 'u32',
    (flags ^ ((flags ^ bWrap) & TEXT_FLAGS.wordWrap)) >>> 0);
  askParentForReconfigure(L);
}

// 0x10046050 — SetTextAlignments(h, v): unconditional byte stores of the
// stack dwords' low bytes; NO reconfigure call.
export function setTextAlignmentsMethod(L, newHAlign, newVAlign) {
  L.write(L.base + TEXT_WINDOW.hAlign, 'u8', newHAlign);
  L.write(L.base + TEXT_WINDOW.vAlign, 'u8', newVAlign);
}

// 0x10046070 — SetTextMargins(h, v): x87 fcomp; the write+reconfigure runs
// iff NOT (hMargin equal-or-unordered h AND vMargin equal-or-unordered v) —
// a NaN arg or field makes its compare "equal" and is skipped, but a NaN
// arg still gets stored when the OTHER margin differs.
export function setTextMarginsMethod(L, hBits, vBits) {
  const same = fcompC3(L.read(L.base + TEXT_WINDOW.hMargin, 'u32'), hBits)
    && fcompC3(L.read(L.base + TEXT_WINDOW.vMargin, 'u32'), vBits);
  if (same) return;
  L.write(L.base + TEXT_WINDOW.hMargin, 'u32', hBits);
  L.write(L.base + TEXT_WINDOW.vMargin, 'u32', vBits);
  askParentForReconfigure(L);
}

// 0x10046120 — SetLines(min, max): each arg clamps negative to 0 (signed);
// min further clamps to max.  Writes + reconfigures iff either differs.
export function setLinesMethod(L, newMinLines, newMaxLines) {
  let mn = newMinLines | 0;
  let mx = newMaxLines | 0;
  if (mn < 0) mn = 0;
  if (mx < 0) mx = 0;
  if (mn > mx) mn = mx;
  if (L.read(L.base + TEXT_WINDOW.minLines, 'i32') === mn
      && L.read(L.base + TEXT_WINDOW.maxLines, 'i32') === mx) return;
  L.write(L.base + TEXT_WINDOW.minLines, 'i32', mn);
  L.write(L.base + TEXT_WINDOW.maxLines, 'i32', mx);
  askParentForReconfigure(L);
}

// 0x100461d0 — SetMinLines(n): clamps negative to 0, then clamps to the
// CURRENT maxLines; writes + reconfigures iff +0x15c differs.
export function setMinLinesMethod(L, newMinLines) {
  let n = newMinLines | 0;
  if (n < 0) n = 0;
  const maxLines = L.read(L.base + TEXT_WINDOW.maxLines, 'i32');
  if (n > maxLines) n = maxLines;
  if (L.read(L.base + TEXT_WINDOW.minLines, 'i32') === n) return;
  L.write(L.base + TEXT_WINDOW.minLines, 'i32', n);
  askParentForReconfigure(L);
}

// 0x10046270 — SetMaxLines(n): clamps negative to 0, then clamps UP to the
// CURRENT minLines; writes + reconfigures iff +0x160 differs.
export function setMaxLinesMethod(L, newMaxLines) {
  let n = newMaxLines | 0;
  if (n < 0) n = 0;
  const minLines = L.read(L.base + TEXT_WINDOW.minLines, 'i32');
  if (n < minLines) n = minLines;
  if (L.read(L.base + TEXT_WINDOW.maxLines, 'i32') === n) return;
  L.write(L.base + TEXT_WINDOW.maxLines, 'i32', n);
  askParentForReconfigure(L);
}

// 0x10046310 — ResetLines(): writes -1/-1 + reconfigures, but ONLY when at
// least one field is non-negative; both-negative is already "reset".
export function resetLinesMethod(L) {
  if (L.read(L.base + TEXT_WINDOW.minLines, 'i32') < 0
      && L.read(L.base + TEXT_WINDOW.maxLines, 'i32') < 0) return;
  L.write(L.base + TEXT_WINDOW.minLines, 'i32', -1);
  L.write(L.base + TEXT_WINDOW.maxLines, 'i32', -1);
  askParentForReconfigure(L);
}

// 0x100463b0 — SetMinWidth(w): the arg normalizes through `fcomp 0.0f` —
// arg < 0 OR NaN (C0) becomes +0.0f.  The write + reconfigure runs iff the
// stored field is not equal-or-unordered to the normalized arg — a stored
// NaN permanently suppresses the write.
export function setMinWidthMethod(L, argBits) {
  let bits = argBits >>> 0;
  if (fcompC0(bits, 0)) bits = 0;
  if (fcompC3(L.read(L.base + TEXT_WINDOW.minWidth, 'u32'), bits)) return;
  L.write(L.base + TEXT_WINDOW.minWidth, 'u32', bits);
  askParentForReconfigure(L);
}

// 0x10046450 — ResetMinWidth(): writes +0.0f + reconfigures only when the
// stored minWidth is strictly greater than 0 (ordered) — zero, negative and
// NaN fields all skip.
export function resetMinWidthMethod(L) {
  if (fcompC0C3(L.read(L.base + TEXT_WINDOW.minWidth, 'u32'), 0)) return;
  L.write(L.base + TEXT_WINDOW.minWidth, 'u32', 0);
  askParentForReconfigure(L);
}

// 0x100464e0 — EnableTextAsAccelerator(bEnable).  Quirk: the guard compares
// the isolated bit ((flags >> 1) & 1) against the RAW dword.  newFlags =
// (flags & ~2) | ((arg & 1) << 1); enabling feeds the CURRENT text through
// SetAcceleratorText, disabling passes NULL (which writes key 0).
export function enableAcceleratorMethod(L, bEnable) {
  const flags = L.read(L.base + TEXT_WINDOW.textFlags, 'u32');
  if (((flags >>> 1) & 1) === (bEnable >>> 0)) return;
  const newFlags = ((flags & ~TEXT_FLAGS.accelerator) | ((bEnable & 1) << 1)) >>> 0;
  L.write(L.base + TEXT_WINDOW.textFlags, 'u32', newFlags);
  if ((newFlags & TEXT_FLAGS.accelerator) !== 0) {
    setAcceleratorText(L, textDataOrEmpty(L));
  } else {
    setAcceleratorText(L, 0);
  }
}

// ---------------------------------------------------------------------------
// XTextLogWindow method bodies.

// 0x10047dc0 — refresh: reset this->text to L"" when it isn't the shared
// empty buffer, then append each log line separated by L"\n" (0x10098e58),
// then AskParentForReconfigure.  Both append paths mirror the bodies:
// num != 0 appends at data + (num-1)*2 after num += strlen (no +1);
// num == 0 skips an empty source entirely, else num = strlen+1.
export function refreshLogText(L) {
  const text = L.base + TEXT_WINDOW.text;
  if (L.read(text, 'u32') !== emptyWString(L)) {
    const n = L.read(emptyWString(L), 'u16') !== 0
      ? wcharLen(L, emptyWString(L)) + 1 : 0;
    L.write(text + 8, 'i32', n);
    L.write(text + 4, 'i32', n);
    farrayRealloc(L, text, 2);
    const num = L.read(text + 4, 'i32');
    if (num !== 0) moveBytes(L, L.read(text, 'u32'), emptyWString(L), num * 2);
  }
  for (let i = 0; i < L.read(L.base + TEXT_WINDOW.logNum, 'i32'); i += 1) {
    if (i > 0) {
      const sep = logSeparator(L);
      const cur = L.read(text + 4, 'i32');
      if (cur !== 0) {
        const sepLen = wcharLen(L, sep);
        farrayAdd(L, text, sepLen, 2);
        wcharCopy(L, L.read(text, 'u32') + (cur - 1) * 2, sep);
      } else if (L.read(sep, 'u16') !== 0) {
        const n = cur + wcharLen(L, sep) + 1;
        L.write(text + 4, 'i32', n);
        if (n > L.read(text + 8, 'i32')) {
          L.write(text + 8, 'i32', growArrayMax(n));
          farrayRealloc(L, text, 2);
        }
        wcharCopy(L, L.read(text, 'u32'), sep);
      }
    }
    const rec = L.read(L.base + TEXT_WINDOW.logData, 'u32') + i * TEXT_LOG.size;
    const recNum = L.read(rec + TEXT_LOG.textNum, 'i32');
    const src = recNum !== 0 ? L.read(rec + TEXT_LOG.text, 'u32') : emptyWString(L);
    const cur = L.read(text + 4, 'i32');
    if (cur !== 0) {
      const newNum = cur + wcharLen(L, src);
      L.write(text + 4, 'i32', newNum);
      if (newNum > L.read(text + 8, 'i32')) {
        L.write(text + 8, 'i32', growArrayMax(newNum));
        farrayRealloc(L, text, 2);
      }
      wcharCopy(L, L.read(text, 'u32') + (cur - 1) * 2, src);
    } else if (L.read(src, 'u16') !== 0) {
      const n = wcharLen(L, src) + 1;
      L.write(text + 4, 'i32', n);
      if (n > L.read(text + 8, 'i32')) {
        L.write(text + 8, 'i32', growArrayMax(n));
        farrayRealloc(L, text, 2);
      }
      wcharCopy(L, L.read(text, 'u32'), src);
    }
  }
  askParentForReconfigure(L);
}

// 0x100476a0 — AddLog(textPtr, color): grow the +0x178 TArray by one
// 0x14-byte record (num++ first; growArrayMax when over max), memset the
// record, expire = f32(now_f64 + f32(timeout @+0x174)), assign the text
// FString (skipped iff textPtr == rec.text.num — always true after memset,
// so effectively iff textPtr == 0), store the color, then refresh.
export function addLogMethod(L, textPtr, color) {
  const log = L.base + TEXT_WINDOW.logData;
  const num = L.read(log + 4, 'i32');
  const newNum = num + 1;
  L.write(log + 4, 'i32', newNum);
  if (newNum > L.read(log + 8, 'i32')) {
    L.write(log + 8, 'i32', growArrayMax(newNum));
    farrayRealloc(L, log, TEXT_LOG.size);
  }
  const rec = L.read(log, 'u32') + num * TEXT_LOG.size;
  zeroBytes(L, rec, TEXT_LOG.size);
  const now = getTime(L);
  const timeout = f32Value(L.read(L.base + TEXT_WINDOW.lineSpacing, 'u32'));
  L.write(rec + TEXT_LOG.expire, 'f32', now + timeout);
  const recText = rec + TEXT_LOG.text;
  if (L.read(recText + 4, 'i32') !== (textPtr >>> 0)) {
    fstringAssignPtr(L, recText, textPtr);
  }
  L.write(rec + TEXT_LOG.color, 'u32', color >>> 0);
  refreshLogText(L);
}

// 0x10047810 — ClearLog(): per record Empty(2,0) + boundedRemove(0,num) +
// ~FArray on the embedded text FString, then num = max = 0 + Realloc(0x14)
// (which frees the record array), then refresh (empty text + reconfigure).
export function clearLogMethod(L) {
  const log = L.base + TEXT_WINDOW.logData;
  const num = L.read(log + 4, 'i32');
  const data = L.read(log, 'u32');
  for (let i = 0; i < num; i += 1) {
    const recText = data + i * TEXT_LOG.size + TEXT_LOG.text;
    farrayEmpty(L, recText, 2, 0);
    boundedRemove(L, recText, 0, L.read(recText + 4, 'i32'));
    farrayDtor(L, recText);
  }
  L.write(log + 4, 'i32', 0);
  L.write(log + 8, 'i32', 0);
  farrayRealloc(L, log, TEXT_LOG.size);
  refreshLogText(L);
}

// 0x100478e0 — SetTextTimeout(t): raw dword store into +0x174.
export function setTextTimeoutMethod(L, bits) {
  L.write(L.base + TEXT_WINDOW.lineSpacing, 'u32', bits >>> 0);
}

// ---------------------------------------------------------------------------
// XLargeTextWindow method body.

// 0x1002d7e0 — SetVerticalSpacing(v): same shape as SetMinWidth — the arg
// normalizes through `fcomp 0.0f` (negative or NaN -> +0.0f), then writes
// +0x174 + reconfigures iff the stored field is not equal-or-unordered.
export function setVerticalSpacingMethod(L, argBits) {
  let bits = argBits >>> 0;
  if (fcompC0(bits, 0)) bits = 0;
  if (fcompC3(L.read(L.base + TEXT_WINDOW.lineSpacing, 'u32'), bits)) return;
  L.write(L.base + TEXT_WINDOW.lineSpacing, 'u32', bits);
  askParentForReconfigure(L);
}

// ---------------------------------------------------------------------------
// Inline exec bodies (the native IS the trampoline) and exec-level marshal
// mirrors.  The GNatives string/int readers are a marshalling boundary: the
// oracle services them from a per-case queue while the JS side replays the
// reader's observable contract — a string read deep-copies the marshalled
// cell into the exec local (num = max = src.num; Realloc(2); copy) and
// records the lvalue in the GPropAddr global cell.

// Exec local FString teardown shared by every marshalled-string exec:
// num = max = 0; Realloc(2); boundedRemove(0, num=0); ~FArray tail.
function execLocalTeardown(L, local) {
  L.write(local + 4, 'i32', 0);
  L.write(local + 8, 'i32', 0);
  farrayRealloc(L, local, 2);
  boundedRemove(L, local, 0, L.read(local + 4, 'i32'));
  farrayDtor(L, local);
}

// Exec string-marshal read into the scratch local + GPropAddr record.
function execStringRead(L, local, cell) {
  L.write(local, 'u32', 0);
  L.write(local + 4, 'i32', 0);
  L.write(local + 8, 'i32', 0);
  fstringAssignFString(L, local, cell);
  L.write(L.mem.gpropCell, 'u32', cell);
}

// 0x10046a30 — SetText exec: marshal NewText into the stack local,
// convertPipes(local.num ? local.data : L""), dispatch vtable +0x11c, then
// tear the local down through the allocator.
export function setTextExec(L, newTextCell) {
  const local = L.mem.marshalLocal;
  execStringRead(L, local, newTextCell);
  const num = L.read(local + 4, 'i32');
  const conv = convertPipes(L, num !== 0 ? L.read(local, 'u32') : emptyWString(L));
  setTextMethod(L, conv);
  execLocalTeardown(L, local);
}

// 0x10046b80 — AppendText exec: same marshal, dispatches vtable +0x120.
export function appendTextExec(L, newTextCell) {
  const local = L.mem.marshalLocal;
  execStringRead(L, local, newTextCell);
  const num = L.read(local + 4, 'i32');
  const conv = convertPipes(L, num !== 0 ? L.read(local, 'u32') : emptyWString(L));
  appendTextMethod(L, conv);
  execLocalTeardown(L, local);
}

// 0x10046cd0 — GetText exec: out == &this->text is a dead guard (a real
// result cell never aliases the field); otherwise out.num = out.max =
// text.num, Realloc(2), and num*2 bytes are copied from text.data-or-L"".
export function getTextExec(L, out) {
  const str = L.base + TEXT_WINDOW.text;
  if (out === str) return;
  const num = L.read(str + 4, 'i32');
  L.write(out + 8, 'i32', num);
  L.write(out + 4, 'i32', num);
  farrayRealloc(L, out, 2);
  if (L.read(out + 4, 'i32') !== 0) {
    const src = num !== 0 ? L.read(str, 'u32') : emptyWString(L);
    copyBytes(L, L.read(out, 'u32'), src, num * 2);
  }
}

// 0x10046d70 — GetTextLength exec: *out = num ? num-1 : 0.
export function getTextLengthExec(L, out) {
  const num = L.read(L.base + TEXT_WINDOW.textNum, 'i32');
  L.write(out, 'i32', num !== 0 ? num - 1 : 0);
}

// 0x10046dc0 — GetTextPart exec: marshal startPos/count and the out-string
// lvalue (GPropAddr), run FString::Mid into a stack temp, assign the temp to
// the destination (or the marshal local when GPropAddr is 0), tear down the
// temp, write *out = target.num ? num-1 : 0, then tear down the local.
// Heap scratch cells stand in for the native stack slots; the gprop cell
// mirrors the Core GPropAddr global.
export function getTextPartExec(L, startPos, count, dest, out) {
  const local = L.mem.scratchLocal;
  const temp = L.mem.scratchTemp;
  const gprop = L.mem.gpropCell;
  L.write(local, 'u32', 0);
  L.write(local + 4, 'i32', 0);
  L.write(local + 8, 'i32', 0);
  L.write(gprop, 'u32', 0);
  // Out-string marshal: deep-copy the destination's current value into the
  // local and record the lvalue in GPropAddr (the reader contract).
  fstringAssignFString(L, local, dest);
  L.write(gprop, 'u32', dest);
  const target = L.read(gprop, 'u32') !== 0 ? L.read(gprop, 'u32') : local;
  fstringMid(L, temp, L.base + TEXT_WINDOW.text, startPos, count);
  if (target !== temp) {
    const n = L.read(temp + 4, 'i32');
    L.write(target + 8, 'i32', n);
    L.write(target + 4, 'i32', n);
    farrayRealloc(L, target, 2);
    if (L.read(target + 4, 'i32') !== 0) {
      const src = n !== 0 ? L.read(temp, 'u32') : emptyWString(L);
      copyBytes(L, L.read(target, 'u32'), src, n * 2);
    }
  }
  farrayEmpty(L, temp, 2, 0);
  extFStringDtor(L, temp);
  const outNum = L.read(target + 4, 'i32');
  L.write(out, 'i32', outNum !== 0 ? outNum - 1 : 0);
  // Marshal-local teardown: num = max = 0, Realloc(2), boundedRemove(0,num),
  // ~FArray.
  execLocalTeardown(L, local);
}

// 0x10048010 — AddLog exec: marshal NewText into the stack local (a deep
// copy) and linecol into a dword, then call the method with
// local.num ? local.data : L"", then tear the local down.
export function addLogExec(L, newTextCell, linecol) {
  const local = L.mem.marshalLocal;
  execStringRead(L, local, newTextCell);
  const num = L.read(local + 4, 'i32');
  const textPtr = num !== 0 ? L.read(local, 'u32') : emptyWString(L);
  addLogMethod(L, textPtr, linecol);
  execLocalTeardown(L, local);
}

// 0x10048210 — PauseLog exec (inline): [+0x184] = ([+0x184] & ~4) |
// ((arg & 1) << 2).
export function pauseLogExec(L, bNewPauseState) {
  const flags = L.read(L.base + TEXT_WINDOW.logFlags, 'u32');
  L.write(L.base + TEXT_WINDOW.logFlags, 'u32',
    ((flags & ~LOG_FLAG_PAUSE) | ((bNewPauseState & 1) << 2)) >>> 0);
}
