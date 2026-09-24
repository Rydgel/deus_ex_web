# Differential exec-body verification

Every Extension native shares one calling contract: the registered exec body
`execX(FFrame& Stack, RESULT_DECL)` evaluates its parameters through `GNatives`,
consumes `EX_EndFunctionParms` and changes the receiver or the result. One
harness can therefore verify a whole native family. Each native no longer
needs its own oracle, validator and translation module.

* `scripts/native-exec-diff-oracle.py` runs any registered Extension.dll exec
  body in Unicorn from the hash-checked DLL. The receiver image comes from the
  case bytes, the fake FFrame reads zero tokens, and each `GNatives` evaluation
  writes the case's next parameter at that parameter's own width. A skipped
  optional parameter writes nothing, like `EX_Nothing`. Direct calls and jumps
  inside Extension.dll run as part of the body. `AskParentForReconfigure`
  (`0x1004e060`) and `MakeAcceleratorTableDirty` (`0x1004c1d0`) are recorded
  as events. The run stops when it leaves the image, makes a virtual call or
  writes a global. Such a run is not a leaf, and it is reported but not
  compared.
* `scripts/native-exec-diff-lib.mjs` reads parameter classes and optional/out
  flags from the original UnrealScript signature, and exec addresses from the
  `GRegisterNative` table (`tools/native-registry.py`).
* `scripts/validate-window-native-diff.mjs` runs the JavaScript
  `dispatchWindowHostNative` case from the same receiver bytes, arguments and
  FString fields. The receiver image, the result slot, the events and the
  consumed code bytes must all match. Cases include edge values for each
  parameter class, a skipped case for each optional parameter and several
  receiver byte patterns.

Run it with `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node
scripts/validate-window-native-diff.mjs`. Adding a native means adding its
dispatcher case and listing its index. A planted wrong bit or a wrong
float default makes the validator fail.

## Current result (2026-09-23)

346 cases are identical across 24 natives. They include six window-host cases
that were dispatched in Play without an original comparison: 1487, 1510, 1511,
1572, 1573, and 1564 through the existing text module. The newly dispatched
natives are 1424, 1474, 1495, 1500, 1512–1518, 1521, 1522, 1564, 1595–1597,
1843 and 1844.

A census of all 453 registered Extension exec bodies, run with random receiver
bytes, found:

- 162 leaves, 57 of them unsupported natives that shipped bytecode calls;
- 119 that dereference receiver pointers;
- 97 that write outside the frame;
- 47 that make virtual calls.

The pointer-following, global-writing and virtual-calling groups need
structured receiver memory or recorded services, not a new oracle per native.

### Update (2026-09-23, DataCube reading)

The TextWindow leaves SetWordWrap (1555, `0x10045fb0`), SetMinLines (1559),
SetMaxLines (1560), ResetLines (1561), SetMinWidth (1562) and ResetMinWidth
(1563) were added: 406 cases are identical across 30 natives. SetMinWidth
keeps the x87 compare branches: a negative or NaN width becomes +0, and an
equal or unordered old value skips the store. AppendText (1551),
CarriageReturn (1482) and SetText's `ConvertScriptString` write outside the
receiver (the static pipe-conversion buffer or a returned FString), so they are
not leaf cases. They are translated from their bodies and checked by
`scripts/validate-window-text.mjs` and `scripts/validate-datacube-read.mjs`.

The DeusExText.dll parser family uses its own harness, because its methods call
Core and MSVCRT: [text parser](script-text-parser.md).

## Findings the harness exposed

* `RootWindow.SetRawBackground` (1516) stores R, G and B as 0xff for an
  omitted color (exec `0x1003cc0d`). Its alpha byte is left from the reused
  `FFrame&` argument slot, which is the high byte of the caller's FFrame
  address. The oracle keeps frames in a low stack page (`0x0012e000`), as the
  game thread stack lies below 16 MB, so the alpha is 0. That placement is a
  modelling assumption, not a measurement.
* `XWindow::SetAcceleratorText` (`0x1004f310`) consumes the unit after a `|`
  that is not followed by `&`, so `||&k` yields no key. The previous
  translation, also used by `TextWindow.SetText` (1550), found the key `k`. A
  final `|` makes the original read past the terminator into unrelated heap
  bytes, so that case is now an explicit error. No shipped localized string
  ends in `|`.
