# XListWindow row/column model and sort evidence

The family as a whole (construction, lifecycle, all natives 1720–1812, Draw,
input and the Play host wiring) is in [the ListWindow family](script-window-list-family.md).

Authority is the shipped Extension.dll SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`
(preferred image base `0x10000000`; the Unicorn oracle maps it at
`0x12000000`), Core.dll SHA-256
`8bf3039e14f849942ae70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`, and the
shipped MSVCRT.dll SHA-256
`e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210`. Every
behavior below was recovered from disassembly and re-verified by executing
the original method bodies under Unicorn in `scripts/native-listwindow-probe.py`;
each JavaScript translation is compared bit-exact against that oracle
(result, allocator/event stream, and dumped memory state) by the per-native
validators under `scripts/validate-window-list-*.mjs`.

## Bound natives

The shared `ListWindow`/`XListWindow` row and column model used by
inventory, augmentations, and conversation choices. Export indices and flags
are re-verified against `Extension.u` on every validator run.

| native | export | method body | exec trampoline |
| ---: | ---: | --- | --- |
| 1720 `IndexToRowId` | 1549 | `0x1002ecf0–0x1002ed0c` | `0x10033f50–0x10033f9c` |
| 1730 `AddRow` | 1567 | `0x1002ed80–0x1002ee13` | `0x10034170–0x100342c9` |
| 1733 `DeleteAllRows` | 1576 | `0x1002f020–0x1002f164` | `0x100344a0–0x100344af` |
| 1735 `GetField` | 1581 | `0x1002f250–0x1002f2e8` | `0x10034650–0x10034785` |
| 1740 `GetNumRows` | 1593 | inline `+0x174` read | `0x10034910–0x1003492a` |
| 1741 `GetNumSelectedRows` | 1595 | inline `+0x1a8` read | `0x10034950–0x1003496a` |
| 1747 `GetSelectedRow` | 1612 | `0x1002f740–0x1002f78e` | `0x10034c60–0x10034c75` |
| 1760 `SetNumColumns` | 1630 | `0x1002fa10–0x1002fc33` | `0x10034f80–0x10034fc6` |
| 1767 `SetColumnWidth` | 1642 | `0x1002fed0–0x1002ff8a` | `0x10035340–0x100353af` |
| 1775 `SetColumnType` | 1666 | `0x10030480–0x100306e6` | `0x10035790–0x10035932` |
| 1780 `SetSortColumn` | 1679 | `0x10030860–0x1003097e` | `0x10035ad0–0x10035b6c` |
| 1784 `Sort` | 1691 | `0x10030c10–0x10030c7e` | `0x10035d30–0x10035d3f` |
| 1792 `EnableAutoExpandColumns` | 1700 | `0x10030fa0–0x1003103a` | `0x10035ef0–0x10035f36` |
| 1794 `EnableMultiSelect` | 1704 | `0x10031040–0x10031127` | `0x10035fa0–0x10035fe6` |

Exact ranges and SHA-256 of every recorded span live in each module's frozen
`*_NATIVE` export; the validators hash-check them against the file.

## Memory layout

Window (`this`):

| offset | field |
| ---: | --- |
| `+0x03d` | dword copied into new column `+0x1d` (`colPacked`) |
| `+0x054` | default font copied into new column `+0x24` |
| `+0x130` | style source read by the measure-context acquire |
| `+0x134` | pooled measure-context object (`acquireContext` returns it) |
| `+0x138` | parent chain walked by the selection broadcast |
| `+0x14c` | delimiter FString; first wchar splits `AddRow` text |
| `+0x170` | rows TArray `{data,count,max}` of `RowNode*` |
| `+0x17c` | cols TArray `{data,+0x180 count,+0x184 max}` of 0x38-byte columns |
| `+0x188` | flags: bit0 sorting, bit1 autoExpand, bit2 multiSelect |
| `+0x18c`/`+0x190` | padX/padY floats |
| `+0x19c` | rowHeight float (recomputed) |
| `+0x1a8` | numSelected |
| `+0x1ac`/`+0x1b0` | cached selected node / second cache |

Row node (0x18 bytes): `+0x00` id (renumbered to the array index by insert
and sort), `+0x04` flags (bit0 selected), `+0x08` fields TArray of 0x18-byte
cells, `+0x14` clientData.

Field cell (0x18): `+0x00` text FString triplet, `+0x0c` float value,
`+0x10`/`+0x14` measured float width/height.

Column (0x38): `+0x00` index, `+0x04` header FString, `+0x10` sortPriority
(int, `<0` excludes the column), `+0x14` sortFlags (bit0 reverse compare,
bit1 case-sensitive), `+0x18` width f32, `+0x1c` flag byte, `+0x1d` packed
dword (copied from `this+0x3d`), `+0x24` font object, `+0x28` type byte,
`+0x2c` format FString.

## Allocator model

All storage flows through GMalloc (Extension IAT `0x12059060` ->
`FMalloc::Malloc/Realloc/Free`, thiscall). Recovered policies:

- `FArray::Realloc` (`0x10145440`) is unconditional:
  `data = GMalloc->Realloc(data, max*elemSize, "FArray")` on every call.
- Grow formula `n + 3n/8 + 0x20` elements (used by `SetNum`/`Add`/`AddZeroed`
  and the createNode fields grow).
- `FArray::Remove` (`0x101454f0`) shrinks iff
  `(num*3 < max*2 || (max-num)*elem >= 0x4000) && (slack > 0x40 || num == 0)`
  — the `0x40` slack is in elements.
- `FString` assign: `num = max = len` **then** Realloc; empty assign has
  `num = max = 0` and `Realloc(data, 0)` frees. `Realloc(0, 0)` returns 0.
- `~FString`/`~FArray`: `Realloc->0` plus a `Remove(0,0)` no-op and a
  conditional `Free`.
- Row destruction (DeleteAllRows, reverse order): per field
  `fieldDtor` (`Realloc(str.data,0)` + `Realloc(0,0)`), fields-array
  `Realloc->0`, node `Free`, rows-array `Realloc->0`, then selection
  broadcast if `numSelected>0` and `AskParentForReconfigure`.
- Column destruction (both paths — `0x100161c0` and the SetNumColumns
  shrink inline): reset header, reset format, `~FString` format,
  `~FString` header — four allocator events per column in exactly that
  order.
- `initColumn` `0x100314f0`: stamps index, two empty FString assigns
  (`Realloc(0,0)` each on a fresh column), sortPriority 0, low three
  sortFlag bits cleared, width `f32(2*padX + 20.0)`, flagByte 0, packed
  and font copied from the window, type 0.

## Text, numbers, measurement

- `parseNumber` `0x100317c0` (reached through the `type∈{1,2}` wrapper
  `0x100319a0`): base-aware — leading `0` octal, `0x` hex; sign only at
  position 0; `.`/`,` switch to fraction mode with the scale persisted
  through an f32 store per digit; `'` folds `seg*3600*sign` and `:`/`"`
  fold `seg*60*sign` into the total without resetting the sign; any
  digit `>= base` or other character terminates.
- `formatNumber` uses the column format only for type 1; every other
  numeric type formats through `"%f"`. The `%02h:%02m` default stored for
  type 2 is not consumed by this path. Float formatting goes through Core
  `appSprintf` → MSVCRT; the probe leaf handles `%f/%e/%g` with
  correctly-rounded half-up digits verified against the real `_fcvt`
  (including exact ties `0.5→1`, `2.5→3`, `0.125→0.13`).
- `measureField` `0x10031e60` clears a context bit, installs the column
  font pair on the context, calls the measurement leaf, restores the
  context font state, and zeroes field width/height when context or font
  is absent. `updateColWidth` `0x10031f80` stores
  `field.width + 2*padX` into the column only when strictly greater.
- Glyph lookup (`0x100267e0` → `0x10026880` → `0x10026950`) is a
  two-level table: font `+0x28` chars-per-row, `+0x2c` row table, `+0x30`
  row count; row record `+0x04` glyph run, `+0x08` valid glyphs; glyph
  `+0x0c` advance. A miss returns the zeroed image pair `0x100aeba0` and
  writes zero out-params — never null.
- `rowHeight` `0x10031fd0` = max over columns-with-fonts of the space
  glyph's metric, then `+ 2*padY` (strictly-greater update only).

## Column natives

- `SetNumColumns` `0x1002fa10`: grows via `FArray::SetNum` (elem 0x38,
  zero-fill, then `initColumn`); shrinks via the column destructor order
  above; then `resizeRowFields` `0x100320b0` on every row (grow:
  `AddZeroed` per missing field; shrink: `fieldDtor` + `Remove`), then
  `rowHeight` recompute and `AskParentForReconfigure`. `numCols` is the
  cols TArray count itself.
- `SetColumnWidth` `0x1002fed0`: validates the index, x87 `fcomp` —
  writes whenever the values differ (equal or unordered skips), then the
  auto-expand driver with arg 1 when flag bit1 is set, and reconfigures.
- `SetColumnType` `0x10030480`: stores the type byte; null format pointer
  selects `%f` (type 1), `%02h:%02m` (type 2) or the empty wstring;
  assigns the format FString; acquires the measure context — when the
  acquire returns 0 the entire per-row reparse is skipped — reparses and
  remeasures each row's field in that column, releases the context, runs
  the auto-expand driver when enabled, and reconfigures.
- `EnableAutoExpandColumns` `0x10030fa0`: compares `(flags>>>1)&1` against
  the full argument dword, toggles bit1, and when the new state is set
  calls the auto-expand driver `0x1002fc40` with arg 1. The driver with
  arg 0 first resets every column width to `f32(2*padX)`; both modes then
  run `updateColWidth` over every row×column and reconfigure.
- `EnableMultiSelect` `0x10031040`: same full-dword compare on bit2; on
  disable walks rows backward and deselects selected rows only while
  `numSelected > 1` through the out-flag helper `0x10032dc0`, so one
  selection survives; the `selected` cache stays stale. Any actual change
  triggers the selection broadcast.
- Selection broadcast `0x100331a0`: walks the `+0x138` parent chain calling
  virtual slot `0x10c` with `(sender=this, count=numSelected,
  node=selected-cache)`; stops at the first nonzero return or chain end
  and propagates the last return value.

## Sorting

- `SetSortColumn` `0x10030860`: validates the column (`0x10033240`,
  `0 <= col < numCols`); resets **every** column's sortPriority to 0 and
  clears sortFlags bits 0–1; then sets the target column's sortPriority
  to 1, sortFlags bit0 = `bReverse&1`, bit1 = `bCaseSensitive&1` (other
  bits preserved). When the window sorting flag is set it calls the sort
  driver immediately. Because the reset writes 0 (not -1), every other
  column remains an eligible tie-break key.
- `Sort` `0x10030c10` is a thin call to the driver `0x100329b0`:
  `buildSortList` `0x10032560` → real `qsort` when `count > 1` → renumber
  `0x10031660` (`row[i].id = i`). No reconfigure is emitted.
- `buildSortList` collects columns with `sortPriority >= 0` into the image
  scratch list `0x100a6f28` (count at `0x100a7348`, capacity `0x100`),
  insertion-sorted by **descending** priority, stable in column order for
  equal priorities.
- The sort runs Core `appQsort` `0x1010194c` → the shipped MSVCRT `qsort`
  `0x7802543d` — the original CRT algorithm executes byte-for-byte in the
  oracle. Its scheme: swap midpoint to front (no median compare); partition
  with `loguy` advancing while `comp(loguy, pivot) <= 0` and `higuy`
  retreating while `comp(higuy, pivot) >= 0`, swapping until the scans
  cross; plant the pivot at `higuy`; push the larger half on the 30-entry
  stack, loop on the smaller; runs of `<= 8` elements go through shortsort
  `0x780255e2`, a selection sort moving each pass's max to the shrinking
  back edge. The JavaScript `appQsort` port reproduces this exactly,
  including the permutation of comparator-equal rows (proven by the
  `allEqual` case, where all 12 rows compare equal and the output is pure
  qsort swap artifact).
- Comparator `0x10032a50` → `0x100326d0`: walks the sort list; text columns
  (type ∉ {1,2}) compare `num ? data : EMPTY_WSTRING` through Core
  `appStricmp` (bit1 clear → MSVCRT `_wcsicmp`, C-locale ASCII tolower) or
  `appStrcmp` (bit1 set → `wcscmp`), with bit0 swapping operand order for
  descending; numeric columns (type 1/2) compare the stored f32 field
  values honoring bit0 (unordered/NaN reads as equal through the
  `fnstsw` masks); a nonzero result returns immediately; ties fall back to
  the signed row id (`idA<idB → -1`, `idA>idB → +1`).
- Sorted insertion (`AddRow` on a sorting window) uses `bsearch`
  `0x10032600` — which rebuilds the sort list itself — and inserts after
  equal entries, then memmoves and renumbers from the insert position.

## Verification architecture

`native-listwindow-probe.py` maps the hash-verified DLLs, installs a probe
FMalloc at the GMalloc global (Malloc/Realloc/Free are thiscall leaves with
callee-popped args), and intercepts only leaf boundaries: FMalloc vtable,
`AskParentForReconfigure`, acquire/release measure context, `measureString`,
the selection-changed virtual, and `appSprintf` (real Core body for
non-float formats; Python-formatted floats for `%f/%e/%g` since the real
`_woutput` path aborts without full CRT init). Everything else — TArray
helpers, FString code, glyph walk, `appStrcmp`/`appStricmp`, `appMemmove`,
`qsort` — executes the original bytes. kernel32 calls issued by real MSVCRT
code are bridged (TLS, locale defaults, heap) so `_wcsicmp`/`_vsnwprintf`
run unchanged.

Validators hash-check the DLL and every recorded body/exec span against
the file bytes (not the relocated image), replay each case through the JS
translation on `ListWindowHeap`, and deep-compare result/events/state.
Canonical pointer labels (`h*`, `a*`) make allocator identity comparable
across runtimes while erasing raw addresses. Each validator also applies a
mutation table and requires the mutated build to diverge — proving the
check can see the behavior it pins.

## Unresolved / unsupported

- `appSprintf` float conversion is a verified-format leaf, not the real
  `_woutput` path; `_fcvt`-equivalence is probed, not proven for every
  double.
- `%02h:%02m` formats emit through the real body natively; the JS leaf
  treats unknown `%` conversions as boundary (no invented output).
- The `selected`/`selected2` caches are faithfully kept stale where the
  native leaves them stale; no fixup is added.
- Comparator reads of rows whose field array is shorter than the sort
  column index read raw TArray slack (stale/zeroed memory), like the
  native; the JS heap mirrors the same bytes.
- Sorting of rows whose stored ids collide is still exact — the ported
  qsort reproduces the original permutation — but this state is only
  reachable through hand-built heaps, not through the bound natives.
- The remaining ListWindow natives, Draw and input are covered by the
  family harness ([ListWindow family](script-window-list-family.md)).
