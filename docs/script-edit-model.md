# Extension XEditWindow text-editor model (natives 1880-1920)

Recovered from Extension.dll (base `0x10000000`, SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`) by
disassembling the GNatives exec trampolines `0x10021af0`-`0x10022a40` and the
XEditWindow method bodies they call.  Every statement below cites the body it
came from; anything not verified against the Unicorn oracle is labelled.

The runtime translation lives in `src/runtime/script-edit-model.mjs` (shared
helpers) plus one `src/runtime/script-edit-<name>.mjs` per native; the Unicorn
probe is `scripts/native-editwindow-probe.py` with one
`scripts/native-edit-<name>-oracle.py` / `scripts/validate-edit-<name>.mjs`
per native.

## Class layout

XEditWindow derives from XTextWindow (text FString at `+0x168`, see
`docs/script-window-text.md`).  The XEditWindow vtable is `0x1005b50c`
(`mov [esi], 0x1005b50c` in the constructor `0x1001cea0` at `0x1001ce91`).

### XTextWindow fields used by the edit bodies

| offset | type | meaning | evidence |
|---|---|---|---|
| `+0x14c` | byte | horizontal alignment (0/1/2) | `0x1001e7f0` |
| `+0x14d` | byte | vertical alignment | `0x1001e740` |
| `+0x150` | dword | text flags, bit0 word wrap | `0x10045fb0` EnableWordWrap |
| `+0x154/+0x158` | float | h/v margins | `0x1001e7f0`, `0x1001e740` |
| `+0x168/+0x16c/+0x170` | FString | text buffer data / num (chars incl. NUL) / max | everywhere |
| `+0x174` | float | line spacing | `0x1001d29a` |
| `+0x178` | float | line height | `0x1001d29a` |
| `+0x17c` | dword | relayout flags, bit0 = full relayout pending | `0x1002d8ce` |
| `+0x180/+0x184` | int | pending change range: position / length (0 = none) | `0x1002d8da` |
| `+0x194/+0x198/+0x19c` | TArray | line table: data / count / max, 0x24-byte records | `0x1001eba0` etc. |
| `+0x1a0` | dword | second relayout flags (bit0) | `0x1002d94f` |
| `+0x1a4/+0x1a8` | int | second pending range position / length | `0x1002d961` |
| `+0x1b8/+0x1bc` | TArray | second line table (same 0x24 records) | `0x1002d987` |
| `+0xe8` | float | window height (page size divisor) | `0x1001d2a6` |
| `+0x84`, `+0x80` | float | inner width/height used by pixel helpers | `0x1001e789`, `0x1001e853` |
| `+0x138` | ptr | parent window (TextChanged broadcast walk) | `0x1001fb03` |

Line record (0x24 bytes): `+0` float x offset/width (pixel helpers only),
`+4` first character index, `+8` visible length (chars measured for pixel
column), `+0xc` full length including the line break, `+0x10` measurement
scratch passed to the font measure (`0x1001e8c0`).  The line table is NOT
rebuilt by the edit bodies: `0x1002d8b0` only shifts record starts after an
edit (see below) and defers the rebuild to XTextWindow layout.  In the probe
and the JS replay the table is constructed input.

### XEditWindow fields (constructor `0x1001cea0` defaults in brackets)

| offset | type | meaning | evidence |
|---|---|---|---|
| `+0x1d0` | dword | flags: bit0 editing enabled [1], bit1 single-line [0], bit2 uppercase only [0] | `0x1001d600`, `0x1001d620`, `0x1001d7d0` |
| `+0x1d4` | int | insertion point [0] | `0x10021c2b` GetInsertionPoint |
| `+0x1d8` | int | selection anchor [0] | `0x1001f197` |
| `+0x1dc` | byte | insertion point type [0] | `0x1001dba4` |
| `+0x1e0/+0x1e4` | int | selection start / end (end exclusive; `-1/-1` = none) [0/0] | `0x1001d5c0`, `0x1001f010` |
| `+0x1e8` | int | max size in characters [200000 = `0x30d40`] | `0x1001d980` |
| `+0x1ec/+0x1f0` | ptr/dword | insertion point texture / packed colour [0 / ff ff ff] | `0x1001daf0` |
| `+0x1f4/+0x1f8` | ptr/dword | selected-area texture / colour [0 / c4 c4 c4] | `0x1001dc10` |
| `+0x1fc` | dword | selected-area text colour [0] | `0x1001dc30` |
| `+0x200/+0x204/+0x208` | dword x3 | edit cursor (cursor object, shadow object, packed colour) [0] | `0x1001dc40` |
| `+0x20c..+0x218` | dword x4 | edit sounds [0] | `0x1001dc70` |
| `+0x21c/+0x220/+0x224` | TArray | undo stack: data / num / max, 0x1c-byte records | `0x1001ddf0` |
| `+0x228` | int | undo position (records below it are undoable) [0] | `0x1001e0a0` |
| `+0x22c` | int | max undos [0x40]; `-1` = unlimited | `0x1001da60` |
| `+0x230` | int | saved undo position; `-1` = "changed" sentinel [0] | `0x1001ddc0` |
| `+0x234` | float | (cursor timer, render) [0] | `0x1002087a` |
| `+0x238` | float | blink timer (render) [-1 + 0.75] | `0x1001cfa6` |
| `+0x23c/+0x240` | float | blink on / off durations [0.75 / 1.0] | `0x1001d960` |
| `+0x244` | dword | state flags: bit0 caret visible [1], bit1 ?, bit2 word-select mode | `0x1001f04a`, `0x1001d54e` |
| `+0x248..+0x26c` | floats | caret rectangle geometry (render) [`-1`,0,...] | `0x1001f680` |
| `+0x258/+0x25c` | float | preferred caret width/height for the insertion-point type [0]; inside the caret-rect region updateCaret rewrites | `0x1001db80` |
| `+0x270` | float | sticky caret x for vertical moves [-1] | `0x1001f891` |
| `+0x274/+0x278/+0x27c/+0x280` | dword | [-1,-1,-1,-1] mouse tracking (unused here) | ctor |

Undo record (0x1c bytes): `+0` position, `+4/+8/+0xc` FString A = text that
was replaced (old), `+0x10/+0x14/+0x18` FString B = text that was inserted
(new).  FString `num` includes the terminating NUL; a NULL/0 FString is empty.

### In-image globals

| address | meaning | evidence |
|---|---|---|
| `0x1009ae00` | clipboard FString (data/num/max), constructed by `0x1001cda0` | `0x1001e648` Copy, `0x1001e6cb` Paste |
| `0x10099ea8` | shared empty wide string `L""` | everywhere an empty FString is read |
| `0x100aead0` | static FString scratch of the `|n` converter `0x10050710`, flag byte `0x100aeac8` | `0x1005072b` |
| `0x100add98` | conversion run buffer of `0x10050710` (flushed when the run reaches 0x800 bytes = 0x400 wchars) | `0x100507eb` |
| `0x1009b380` | FName index of `FilterChar` | `0x10021890` |

## Exec trampolines -> method bodies

| native | exec | method | notes |
|---|---|---|---|
| 1880 MoveInsertionPoint | `0x10021af0` | `0x1001d250` | (byte moveType, bool bExtend) |
| 1881 SetInsertionPoint | `0x10021b90` | `0x1001d4a0` -> `0x1001f140` | (int pos, bool bExtend=0) |
| 1882 GetInsertionPoint | `0x10021c20` | inline `[this+0x1d4]` | |
| 1883 SetSelectedArea | `0x10021c60` | `0x1001d520` | (int start, int length) |
| 1884 GetSelectedArea | `0x10021cf0` | `0x1001d5c0` | (out int start, out int length) |
| 1885 EnableEditing | `0x10021db0` | `0x1001d600` | |
| 1886 IsEditingEnabled | `0x10021e20` | inline `[this+0x1d0] & 1` | |
| 1887 EnableSingleLineEditing | `0x10021e60` | `0x1001d620` | default arg 1 |
| 1888 IsSingleLineEditingEnabled | `0x10021ed0` | inline `([this+0x1d0] >> 1) & 1` | |
| 1889 EnableUppercaseOnly | `0x10021f10` | `0x1001d7d0` | default arg 1 |
| 1890 ClearTextChangedFlag | `0x10021f80` | `0x1001dd50` -> `0x1001ddc0(0)` | |
| 1891 SetTextChangedFlag | `0x10021fb0` | `0x1001ddc0` | default arg 1 |
| 1892 HasTextChanged | `0x10022020` | inline `[0x228] != [0x230]` | |
| 1895 SetMaxSize | `0x10022070` | `0x1001d980` | |
| 1896 SetMaxUndos | `0x100220e0` | `0x1001da60` | |
| 1900 InsertText | `0x10022150` | `0x10050710` then vtable `+0x124` = `0x1001e3c0` | (string, int bKeepUndo=0, int bExtend=0) |
| 1901 DeleteChar | `0x10022320` | vtable `+0x128` = `0x1001e560` | (int bBackspace=0, int bKeepUndo=0) |
| 1902 SetInsertionPointBlinkRate | `0x100223c0` | `0x1001d960` | (float on=0.75, float off=1.0) |
| 1905 SetInsertionPointTexture | `0x10022450` | `0x1001daf0` | (texture, colour default ff ff ff) |
| 1906 SetInsertionPointType | `0x100224f0` | `0x1001db80` | (byte type, float, float) |
| 1907 SetSelectedAreaTexture | `0x100225b0` | `0x1001dc10` | |
| 1908 SetSelectedAreaTextColor | `0x10022650` | `0x1001dc30` | |
| 1909 SetEditCursor | `0x100226d0` | `0x1001dc40` | 3 dwords |
| 1910 Undo | `0x10022940` | `0x1001e0a0` | |
| 1911 Redo | `0x10022970` | `0x1001e170` | |
| 1912 ClearUndo | `0x100229a0` | `0x1001ddf0` | |
| 1915 Copy | `0x100229d0` | `0x1001df20` -> `0x1001e5f0(0,1)` | |
| 1916 Cut | `0x10022a00` | `0x1001dfa0` -> `0x1001e5f0(1,1)` | |
| 1917 Paste | `0x10022a30` | `0x1001e020` -> `0x1001e6b0(1,0)` | |
| 1920 SetEditSounds | `0x100227a0` | `0x1001dc70` | 4 dwords |
| 1921 PlayEditSound | `0x10022880` | `0x1001dca0` -> `0x10050050` | OUT OF SCOPE (audio) |

Vtable `0x1005b50c` slots used: `+0x10` ProcessEvent (only reached when
FindFunction finds a script `FilterChar`), `+0x114` TextChanged notification
(`0x10004010`, default XWindow body), `+0x11c` SetText override `0x1001e260`,
`+0x120` `0x1001e310` (select-all-at-end variant), `+0x124` InsertText
`0x1001e3c0`, `+0x128` DeleteChar `0x1001e560`, `+0x12c` FilterChar
`0x10021830`.

## Recovered helper semantics

Notation: `len = num ? num-1 : 0` (character count), `text[i]` reads the
buffer or the shared empty string when `num == 0`.  Whitespace = code
9..13 or 0x20.

* `0x1001f140 setInsertionPoint(pos, bExtend)`: `ip = clamp(pos, 0, len)`;
  if `!bExtend` anchor `= ip`; `updateSelection()`; `updateCaret(1)`;
  `resetBlink()`.
* `0x1001f010 updateSelection()`: if `ip == anchor` and `!(flags244 & 4)`:
  selection `= (-1, -1)`, return.  Else `(start, end) = anchor <= ip ?
  (anchor, ip) : (ip, anchor)`.  If `flags244 & 4`: `start = wordStart(start)`
  (`0x1001f300`), `end = wordEnd(end)` (`0x1001f350`), `ip = anchor <= ip ?
  end : start`.
* `0x1001f300 wordStart(pos)`: scan back from `pos-1` while the char is not
  whitespace and the index `>= 0`; return the index after the stop.
* `0x1001f350 wordEnd(pos)`: scan forward from `pos` while `< len` and not
  whitespace; return the stop index.
* `0x1001eba0 posToLineCol(pos)`: `pos = clamp(pos, 0, len)`; for `line` from
  `count-1` down to 0: if `rec[line].start <= pos` return `(line, pos -
  start)`; otherwise `(0, 0)`.
* `0x1001f3b0 nextWord(pos)`: `(line, _) = posToLineCol(pos)`; if line out of
  range return 0; `lineEnd = rec.start + rec.visibleLen`; if `pos >= lineEnd`
  return `rec.start + rec.fullLen`; scan: skip non-space, then skip spaces,
  stop at the first non-space after a space; if the scan reached `lineEnd`
  return `rec.start + rec.fullLen - 1`, else the stop index.
* `0x1001f550 prevWord(pos)`: `(line, _) = posToLineCol(pos)`; if out of range
  return 0; if `pos == rec.start` return `max(pos-1, 0)`; scan back from
  `pos-1` down to `rec.start`: skip spaces, then non-spaces, stop at a space
  after a non-space; return the index after the stop (clamped `>= 0`).
* `0x1001f200 moveToLine(line, bExtend)`: `line = clamp(line, 0, count-1)`; if
  `line < count`: `pos = rec.start + columnFromX(line, stickyX(+0x270))`
  (`0x1001e7f0`, font metrics, see boundaries) else 0; `pos = clamp(pos, 0,
  len)`; `ip = pos`; if `!bExtend` anchor `= pos`; `updateSelection()`;
  `updateCaret(0)`; `resetBlink()`.
* `0x1001d250 MoveInsertionPoint(type, bExtend)`: `count = lineCount`; if
  `count > 0`: `(line, col) = posToLineCol(ip)`, `page = max(1,
  ftol(height(+0xe8) / (lineHeight(+0x178) + spacing(+0x174))))`; else
  `line = col = 0`, `page = 1`.  Jump table `0x1001d464`:
  0 up: `count>0 ? moveToLine(line-1)`; 1 down: `moveToLine(line+1)`;
  2 left: `setInsertionPoint(ip-1)`; 3 right: `setInsertionPoint(ip+1)`;
  4 word left: `setInsertionPoint(prevWord(ip))` (count>0); 5 word right:
  `setInsertionPoint(nextWord(ip))` (count>0); 6 line start:
  `setInsertionPoint(rec[line].start)`; 7 line end:
  `setInsertionPoint(rec[line].start + rec[line].fullLen - 1)`; 8 page up:
  `moveToLine(line - page)`; 9 page down: `moveToLine(line + page)`;
  10 text start: `setInsertionPoint(0)`; 11 text end:
  `setInsertionPoint(len)`; `> 11` no-op.  Cases 0,1,4-9 are no-ops when
  `count <= 0`.  The `bExtend` argument is passed through.
* `0x1001d520 SetSelectedArea(start, n)`: `flags244 &= ~4`;
  `setInsertionPoint(start, 0)`; `setInsertionPoint(start + n, 1)`.
* `0x1001d5c0 GetSelectedArea`: `start = max(selStart, 0)`, `size =
  max(selEnd - selStart, 0)` (computed before clamping start).
* `0x1001ddc0 SetTextChangedFlag(b)`: `saved = b ? -1 : undoPos`.
* `0x1001d980 SetMaxSize(n)`: if `n != maxSize`: `maxSize = n`; if `n > 0` and
  `len > n`: `selStart = n`, `selEnd = ip = len`, virtual
  `InsertText(NULL, 0, 0)`, `SetInsertionPoint(0, 0)`.
* `0x1001da60 SetMaxUndos(n)`: `n < 0 -> -1`; if changed store and
  `trimUndo()`.
* `0x10020290 trimUndo()`: if `maxUndos >= 0` and `num > maxUndos`: `excess =
  num - maxUndos`; for each of the first `excess` records: `FArray::Empty(2,0)`
  on A and B, then `B: num=0,max=0,Realloc(2)`, `Remove(0, B.num, 2)`,
  `~FArray(B)`; `A: num=0,max=0,Realloc(2)`, `0x10003990(A)` (Remove(0,
  num, 2) + GMalloc->Free(data) + zero).  Then `Remove(0, excess, 0x1c)`;
  `undoPos -= excess`, `saved -= excess`; `undoPos < 0 -> 0`; `saved < 0 ->
  -1`.
* `0x1001ddf0 ClearUndo()`: `saved = (undoPos != saved) ? -1 : 0`;
  `undoPos = 0`; destroy every record (`A: num=0,max=0,Realloc(2)`; `B:
  num=0,max=0,Realloc(2)` twice, `Remove(0, B.num, 2)`, `~FArray(B)`; `A:
  num=0,max=0,Realloc(2)`, `0x10003990(A)`); `num = max = 0`;
  `FArray::Realloc(0x1c)`.
* `0x1001ed90 assignString(FString* dst, wchar* src, n)`: `src NULL -> L""`;
  `n < 0 -> appStrlen(src)`; grow: if `n > dstLen`: `dst.num += n - dstLen`
  (or `n+1` when `dst.num == 0`), growth `max = num + (3num+adj)/8 + 0x20`,
  `Realloc(2)`; shrink: if `n < dstLen`: `n > 0 ? Remove(n, dstLen-n, 2)
  : (num=max=0, Realloc(2))`; finally if `n > 0` `appStrncpy(dst.data, src,
  n+1)`.  `appStrncpy` is Core `0x101233c0`: `wcsncpy(dst, src, n)` then
  `dst[n-1] = 0` — the forced terminator overwrites the last copied slot,
  so callers always pass `len + 1`.
* `0x10020450 pushUndo(pos, oldText, oldLen, newText, newLen)`: negative
  lengths use `appStrlen`; return if both `< 1`.  Coalescing: if exactly one
  of them is `>= 1`, `undoPos > 0`, `undoPos != saved`, the previous record's A
  is empty (`num <= 1`), `oldLen < 1` (pure insert) and `pos == prev.pos +
  prevBLen`: `FArray::Insert(&prev.B, prevBLen, newLen, 2)`; `newLen > 0 ?
  appStrncpy(prev.B.data + prevBLen, newText, newLen+1) : prev.B[prevBLen] =
  0`; no new record.  Then drop redo records `undoPos..num` (`A/B: num=0,
  max=0, Realloc(2)`, `~FString(B)`, `~FString(A)`; `Remove(undoPos, n,
  0x1c)`; if `saved > undoPos` `saved = -1`).  If not coalesced: append a
  zeroed record, `pos`, `assignString(A, oldText, oldLen)`,
  `assignString(B, newText, newLen)`, `undoPos++`.  Always `trimUndo()`.
* `0x1001fe20 replaceSelection(text, bRecordUndo, bExtend)`: `selLen =
  max(selEnd - selStart, 0)`; `insLen = text ? appStrlen(text) : 0`.  If
  `maxSize > 0`: if `len > maxSize`: `Remove(maxSize, len - maxSize, 2)`,
  `data[maxSize] = 0`, `ClearUndo()`, `SetTextChangedFlag(1)`,
  `AskParentForReconfigure()`, `SetInsertionPoint(0, 0)`, return.  Else if
  `selLen < insLen`: `over = len - maxSize - selLen + insLen`; if `over > 0`:
  `insLen -= over`; if `insLen < 0` return.  Return if `selLen <= 0 && insLen
  <= 0`.  If `selEnd > selStart` `ip = selStart`.  If `bRecordUndo`
  `pushUndo(ip, text+ip, selLen, text, insLen)`.  Grow (`selLen < insLen`,
  `d = insLen - selLen`): if `num != 0`: `num += d` (growth realloc),
  `appMemmove(data + (ip+d), data + ip, (oldNum - ip) * 2)`; else
  `FArray::Insert(ip, d + 1, 2)`.  Shrink (`selLen > insLen`, `d = selLen -
  insLen`): if `len - d > 0`: `Remove(ip, d, 2)` else `num = max = 0`,
  `Realloc(2)`.  Copy `insLen` chars at `ip`; if `num != 0` `data[len] = 0`.
  `textChangedBroadcast()` (`0x1001fab0`), `0x1002d8b0(ip, selLen, insLen)`,
  `AskParentForReconfigure()`, `anchor = ip`, `SetInsertionPoint(ip + insLen,
  bExtend)`.
* `0x1001fab0 textChangedBroadcast()`: for `w = this; w; w = w.parent(+0x138)`:
  if `w->vtable[+0x114](this, undoPos != saved)` returns nonzero stop.
* `0x1002d8b0 textChangedRange(ip, selLen, insLen)`: `d = insLen - selLen`.
  If `pendingLen(+0x184) > 0`: `flags17c |= 1`; else `pendingPos = ip`,
  `pendingLen = max(insLen, 1)` and for every record of the `+0x194` table:
  if `start > ip` `start += d`; re-read: if `start <= ip` `start = ip + 1`.
  Same for `+0x1a0/+0x1a4/+0x1a8` and the `+0x1b8/+0x1bc` table.
* `0x1001fbf0 filterText(text, FString* out)`: `out` reset to `L""` copy
  (Realloc events); for each char: skip `\n` when single-line; call virtual
  FilterChar(`&ch`); if it returns nonzero append the (possibly modified)
  char (`appStrlen`, growth, `appStrcpy`).  Return 1 when the input length is
  `<= 0` (empty/NULL input is accepted so SetText(L"") and the SetMaxSize
  truncation still reach replaceSelection), otherwise 1 iff `out.num > 1`
  (`0x1001fda4`-`0x1001fde0`).
* `0x10021830 FilterChar(&ch)`: if uppercase flag and `'a' <= ch <= 'z'`
  `ch -= 0x20`.  `fn = FindFunction(FName FilterChar, 0)`; if `fn`
  (script override) build `{FString(ch), int accept = 1}`, ProcessEvent, copy
  the first char back when accepted, return accept.  Else return 1.
* `0x1001e3c0 InsertText virtual(text, bKeepUndo, bExtend)`: `filterText`;
  on 0 free the temp and return 0; if `!bKeepUndo`: `ClearUndo()`,
  `SetTextChangedFlag(1)`; `replaceSelection(filtered, bKeepUndo, bExtend)`;
  free temp; return 1.
* `0x1001e560 DeleteChar virtual(bBackspace, bKeepUndo)`: if `!bKeepUndo`:
  `ClearUndo()`, `SetTextChangedFlag(1)`; `0x100201d0`: if `selEnd <=
  selStart`: backspace: `ip > 0 ? sel = (ip-1, ip) : skip`; delete: `ip < len
  ? sel = (ip, ip+1) : skip`; then `replaceSelection(NULL, bKeepUndo, 0)`.
* `0x1001e260 SetText override(text)`: `selStart = 0`, `selEnd = ip = len`,
  virtual `InsertText(text, 0, 0)`, `SetInsertionPoint(0, 0)`.
* `0x1001d620 EnableSingleLineEditing(b)`: if bit1 already equals `b`
  return; store `(flags & ~2) | ((b & 1) << 1)`; if now on: copy the text to
  a temp FString, virtual SetText(copy) (strips newlines through the filter),
  `EnableWordWrap(0)` (`0x10045fb0`: `+0x150` bit0, reconfigure on change),
  free the temp; if now off: `EnableWordWrap(1)`.
* `0x1001d7d0 EnableUppercaseOnly(b)`: same shape with bit2; when turned on
  re-sets the text through SetText (uppercases it); no word-wrap change.
* `0x1001e5f0 copy(bCut, bKeepUndo)`: if `selEnd > selStart`:
  `assignString(&clipboard, text + selStart, selEnd - selStart)`; if `bCut`
  virtual `DeleteChar(0, bKeepUndo)`.
* `0x1001e6b0 paste(bKeepUndo, bExtend)`: virtual `InsertText(clipboard.num ?
  clipboard.data : L"", bKeepUndo, bExtend)`.
* `0x1001e0a0 Undo`: if `undoPos > 0`: `undoPos--`; `rec = data[undoPos]`;
  `selStart = rec.pos`; `selEnd = rec.pos + lenB`; `ip = selStart`;
  `replaceSelection(A or L"", 0, 1)`.
* `0x1001e170 Redo`: if `undoPos <= num - 1`: `rec = data[undoPos]`;
  `selStart = ip = rec.pos`; `selEnd = rec.pos + lenA`; `undoPos++`;
  `replaceSelection(B or L"", 0, 1)`.
* `0x1001daf0 SetInsertionPointTexture(texture, colour)`: `+0x1ec =
  texture`, `+0x1f0 = colour`, `updateCaret(0)`.  The exec default colour
  is three 0xff bytes; the fourth byte of the packed dword is left
  undefined — the local reuses the incoming Stack argument slot — so the
  colour reaches the method verbatim as marshalled.
* `0x1001db80 SetInsertionPointType(type, w, h)`: the exec masks `type`
  with 0xff (`and eax,0xff`); `+0x1dc = type` (byte), `+0x258 = w`,
  `+0x25c = h` (raw f32 dwords), `updateCaret(0)`.
* `0x1001dc10 SetSelectedAreaTexture(texture, colour)`: `+0x1f4`,
  `+0x1f8`; no caret update.  Exec default colour three 0xc0 bytes,
  fourth undefined.
* `0x1001dc30 SetSelectedAreaTextColor(colour)`: `+0x1fc`; exec default
  three 0 bytes, fourth undefined.
* `0x1001dc40 SetEditCursor(cursor, shadow, colour)`: `+0x200`, `+0x204`,
  `+0x208`; exec default colour three 0xff bytes, fourth undefined.
* `0x1001dc70 SetEditSounds(t, d, e, m)`: `+0x20c`, `+0x210`, `+0x214`,
  `+0x218` in parameter order.
* `0x10050710 convertPipes(text)` (exec-level, before the InsertText
  virtual): static FString `0x100aead0` reset to `L""`; the text is copied in
  runs into `0x100add98`, translating `|n` to `\n`
  (a `|` not followed by `n` is kept); the run flushes when the
  wchar-aligned byte distance reaches 0x800 bytes — 0x400 wchars
  (`0x10050831`-`0x10050842`) — and each run is appended (`FArray::Add` /
  growth + `appStrcpy`).  Returns the static buffer (or `L""` when empty).
  The static buffer keeps its capacity across calls; the probe and the JS
  heap model reset it per case ("fresh process").

## Boundaries (not translated; intercepted as leaf events)

* `0x1001f680 updateCaret(bSticky)` measures the character under the caret
  through the pooled measure context (`0x1004ddc0` / `0x10027bb0` /
  `0x1004de50`) and writes the caret rectangle `+0x248..+0x26c` and, when
  `bSticky`, the sticky x `+0x270`.  Font glyph metrics: recorded as
  `{op:'UpdateCaret', sticky}`; the fields stay untouched.  UNVERIFIED render
  geometry.
* `0x1001ef40 resetBlink()` reads the clock (`0x1004fda0`), writes `+0x238`
  and `+0x244 |= 1`, and invalidates the caret rectangle (`0x1004e230`).
  Recorded as `{op:'ResetBlink'}`; `+0x238` / `+0x244` bit0 are not
  modelled.
* `0x1001e7f0 columnFromX(line, x)` converts the sticky pixel x to a column
  with the font measure (`0x10028050`).  Recorded as `{op:'ColumnFromX',
  line, x}` and answered by the injected `services.columnFromX`; the probe
  returns the configured value.  MoveInsertionPoint types 0, 1, 8, 9 depend
  on it.
* Vtable `+0x114` TextChanged notification and `0x1004e060`
  AskParentForReconfigure: events, configurable return.
* `FindFunction(FilterChar)`: the probe returns 0 (no script override) and
  records the lookup; a script `FilterChar` override is unsupported.
* x87: the page size `ftol(height / (lineHeight + spacing))` is an
  extended-precision quotient truncated to int; the JS uses a double quotient.
  They differ only when the exact quotient lies within ~2^-53 of an integer;
  the oracle cases pin the sampled inputs.
