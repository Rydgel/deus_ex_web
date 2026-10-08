# MSVCRT text conversions behind appSprintf and appAtof

Scripts and natives reach two MSVCRT conversions through Core:

* `appSprintf(dest, fmt, ...)` (`10123490`) is
  `_vsnwprintf(dest, 0x400, fmt, args)` through IAT `102ab508`. It backs
  `ScaleWindow.GetValueString` (the options sliders' value text) and, through
  `FString::Printf`, `FloatToString` (`%f`, `execFloatToString` `10131ca0`).
* `appAtof(str)` (`101235c0`) is `atof(appToAnsi(str))` through IAT
  `102ab518`; `execStringToFloat` (`101326b0`) stores the result with
  `FSTP m32`. Every config value the menus read (`get ini:… Brightness`) is
  parsed this way.

The game ships its own `System/MSVCRT.dll` (SHA-256 `e390b052…843d210`), so
both are MSVCRT's behaviour, not the host's.

## Model

`src/runtime/script-text-format.mjs`:

* `msvcrtSprintf(format, ...doubles)` supports `%[flags][width][.precision]f`
  (flags `- + space 0`), `%%` and literal text. `%f` takes the exact decimal
  expansion of the double, keeps 17 significant digits (the 18th digit rounds
  the 17th half up, later digits become zeros) and then rounds half up at the
  precision. Any other conversion, NaN, an infinity, or a result of 0x400
  units or more is an explicit error: no shipped script format reaches it and
  MSVCRT's `1.#INF` / `1.#QNAN` spellings are not measured.
* `msvcrtAtof(text)` takes the longest decimal prefix after whitespace
  (`[+-]digits[.digits][e[+-]digits]`) and is JavaScript's correctly rounded
  `Number`; no digits give 0. `stringToFloat` is `Math.fround` of that.

The formats the shipped scripts use are `%1.0f`, `%1.1f` (`MenuChoice_*`
`SetValueFormat`) and the ScaleWindow constructor default `%1.2f` (all in
`DeusEx.u`; the dump tool is `scripts/dump-script-function.mjs`).

## Measurement

`tools/msvcrt-text-probe.c` loads a privately named copy of the game's
MSVCRT.dll under Wine (so Wine's builtin cannot stand in), calls
`_vsnwprintf` with a pointer to the packed double (it takes a `va_list`) and
`atof`, and prints the results. `scripts/validate-msvcrt-text-hardware.mjs`
builds it with `i686-w64-mingw32-gcc`, feeds 14 formats × ~20,000 values
(ties such as 0.5/2.5/0.25, float32 grids, random float32 across 2^-27…2^32,
random doubles, negatives) and ~11,500 atof strings, and requires the model to
match every row: **290,416 printf rows and 11,551 atof rows identical**.

Findings the measurement settled:

* Exact ties round **up in magnitude** (`%1.0f` of 2.5 is `3`, `%1.1f` of
  0.25 is `0.3`); there is no banker's rounding.
* `-0.0` prints **unsigned** (`0.000000`); MSVCRT tests `value < 0`. A small
  negative that rounds to zero keeps its sign (`-0.0` for -0.01 at `%1.1f`).
  The earlier `scriptFloatToString` treated -0 as unmeasured; it now uses this
  model.
* A correctly rounded `Number()` already equals `atof` for every tested
  string, including 17-digit and denormal inputs.

**x87 control word.** The probe runs at the process default, which prints as
`#cw=027f` under Wine here (53-bit precision; MinGW's own default is `037f`).
The validator also re-runs the whole case set with the word loaded by `FLDCW` as
`027f`, `037f` (the game thread's assumed 64-bit word) and `007f` (24-bit,
`URender::PreRender`'s render-pass word): **every row is identical under all
three**, so neither `atof` nor `_vsnwprintf` results depend on the precision
control (`%f` formatting and decimal parsing are done with integer and
extended-precision steps whose double result does not change).

Run on Linux with
`node scripts/validate-msvcrt-text-hardware.mjs`
(Wine defaults to `/usr/bin/wine` and the prefix to `~/.wine-deusex` when `X87_PROBE_WINE` / `WINEPREFIX` are unset; it skips loudly without Wine or mingw). `scripts/msvcrt-text-probe-lib.mjs` is the
shared driver.
