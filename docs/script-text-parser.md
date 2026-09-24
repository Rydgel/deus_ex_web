# DeusExTextParser and information devices

DataCubes, books and newspapers (`InformationDevices`) show DeusExText texts
through the native `DeusExTextParser`. Training's `DataCube0` holds the
`paddoor` code, so reading it is on the Training route.

## Authority

* `DeusExText.dll`, SHA-256
  `5f64ff6be5e44a276906e72325a25e1a27406314267076c2b5ad061b4a339aa1`, base
  `0x10000000`. It exports every parser method by name
  (`DDeusExTextParser::OpenText`, `ParseTextBlock`, `ParseTag`, `ParseToken`, ...).
  `tools/native-registry.py DeusExText` resolves the twelve registrations,
  2210–2221 (exec bodies `0x10003030`–`0x10003c40`).
* `DeusExText.u`: the `DeusExTextParser` declaration (`native noexport`) and
  492 `ExtString` objects. `XExtString::Serialize` (Extension `0x10044140`) is
  `UObject::Serialize` followed by the `Text` FString at `+0x2c`.
* `DeusEx.u` `InformationDevices` (Frob, Tick, CreateInfoWindow, ProcessTag,
  DestroyWindow), `DeusExPlayer` (ParseRightClick, DoFrob, AddNote, GetNote),
  `DeusExHUD.ShowInfoWindow` and `HUDInformationDisplay`.
* Core `execNew` (`0x1013d9f0`), `execCriticalDelete` (`0x1013db50`), the UObject
  deleting destructor (`0x1015dd00`), and the shipped `MSVCRT.dll` (SHA-256
  `e390b052…d210`) `_wtoi`/`atol` (`0x7801c812`/`0x78005d30`).

## Parser (`src/runtime/script-text-parser.mjs`)

Object layout (size `0xc0`): `text` `+0x28` (the parser's own GMalloc copy),
`textPos` `+0x2c`, `tagEndPos` `+0x30`, `lastText` `+0x34`, `lastTag` `+0x40`
(dword, constructor value 30 = `TT_None`), `lastName` `+0x44`, `lastColor`
`+0x48`, `defaultColor` `+0x4c`, `bParagraphStarted` `+0x50` bit 0, the player
names `+0x54`/`+0x60`, email fields `+0x6c`–`+0x9c`, file fields `+0xa8`/`+0xb4`.

* **OpenText** closes any text, loads `"<package>.<name>"` with
  `StaticLoadObject(XExtString, NULL, path, NULL, LOAD_NoWarn|LOAD_Quiet)`,
  copies its text up to the first NUL, runs `ResetLoaders(obj, 0, 1)` and deletes
  the loaded object. It clears the paragraph flag and returns whether a copy
  exists. `execOpenText` defaults the package to `"DeusExText"` and replaces an
  empty package with it.
* **ProcessText** is `lastText = ParseTextBlock(); return !IsEOF()`. IsEOF means
  `text == NULL || textPos == NULL`.
* **ParseTextBlock** sets `lastTag = TT_None`. Characters are kept only after the
  first paragraph has started, with CR and LF becoming spaces (`lastTag = 0`). At
  a `<` it stops if text was gathered; otherwise it appends ParseTag's result. The
  first `<P>` only starts the paragraph and parsing continues. At the terminator
  the next call clears `textPos`, which ends the read.
* **ParseTag** scans to the first `>` (or the terminator), writes NUL there
  (`tagEndPos`), steps past it, and prefix-matches the body against the tag table
  at `0x1000a070` in enum order (`TEXT`, `FILE`, ... `PLAYERNAME`,
  `PLAYERFIRSTNAME`, `NP`, `JC`, `JL`, `JR`, `DC`, `C`, `/C`, `P`, `B`, ... `/<`,
  `/>`). `/>` can never match because the scan stops at the first `>`.
* **ParseToken**: FILE and EMAIL fill their fields from `=`-separated,
  `,`-split, space-trimmed subtokens; DC, C and /C parse a colour into
  `lastColor`; G and F set `lastName`; NOTE, GOAL (after its name) and COMMENT
  run FindEndTag and discard the result; PLAYERNAME/PLAYERFIRSTNAME return the
  stored names; `/<` returns `<`.
* **FindEndTag** collects text and nested tags until `lastTag` equals the end
  tag. Nested tags run through ParseTag with all their side effects, so after
  `<NOTE>…</NOTE>` the reported tag is 4 (`/NOTE`). After a nested tag that is not
  the end tag the original steps over one more character. When that character is
  the `<` of the end tag, the end tag is missed.
* **Colours**: each channel is `_wtoi(subtoken) & 0xff`. `_wtoi` converts through
  `WideCharToMultiByte(CP_ACP)` into a 20-byte buffer and runs the C-locale
  `atol` with 32-bit wraparound. Only ASCII input that fits the buffer is
  reproduced; anything else is a `RangeError`.
* **GetColor** returns `lastColor` for tags 15–16, `defaultColor` for 17, and
  black otherwise. **GetName** returns `lastName` for NOTE, G, F and L; any other
  tag reaches Core's `check(Name)` assertion in `FName(NULL)` and is an explicit
  error. **GotoLabel** is a stub returning false.
* SetPlayerName stores the name and takes the first name as the text before
  its first space.

Reads the original makes past its text allocation (a `<` or a nested tag at the
very end of a text) raise `TextParserBufferError`. The original reads
unrelated heap bytes there. No shipped text reaches them.

### Alpha bytes: a modelled heap address

The colour structs are assembled in reused stack slots. The alpha of
`lastColor` is the high byte of the tag pointer into the text copy; the constructor's
`lastColor`/`defaultColor` and GetColor's black carry the high byte of the parser
object address. These are heap addresses, not reproducible values. Play models
both addresses as 0 (`TEXT_PARSER_ADDRESS_MODEL`). The recovered XGC and XWindow
`SetTextColor` build their draw plane from R, G and B only (W is 0), so the alpha
does not reach drawing; it survives only in TextWindow's packed colour field.

### Verification

`scripts/native-text-parser-oracle.py` runs the original parser methods over the
original Core.dll and MSVCRT.dll in Unicorn (Engine/Core at their bases,
Extension rebased to `0x12000000`). Host services are GMalloc (the text copy ends
at a page boundary before an unmapped page, so past-end reads fault), the FName
table, StaticLoadObject/ResetLoaders/delete (recorded) and an ASCII-only
WideCharToMultiByte. `scripts/validate-text-parser-diff.mjs` compares the complete
parser state after every step: the mutated buffer, both positions,
`lastText`/`lastTag`/`lastName`, both colours with their alpha bytes, the
paragraph flag, names, email and file fields, plus the StaticLoadObject paths and
flags. It covers all 492 shipped texts read the way InformationDevices reads them,
and 27 targeted cases (past-end reads, nested and end-tag skips, NOTE/GOAL, G/F/L
names and the GetName assertion, colour wraparound and the `_wtoi` buffer limit,
FILE/EMAIL trimming, brackets, player names, lowercase tags, text before the first
paragraph, empty and missing texts, reopening). On 2026-09-23: 519 cases, 2,611
steps identical, 4 past-end faults and 2 original stops reproduced. Planted
mutations (black alpha 0, no extra step in FindEndTag) fail it.

## Construction and deletion

* `new(None) class'DeusExTextParser'` goes through Core `execNew`: a None Outer
  becomes `GetTransientPackage()`, and flags outside `0x704005` are logged and
  masked. It then calls `StaticConstructObject(Class, Outer, Name, Flags, NULL)`.
  The parser's constructor (`0x10001100`, InternalConstructor `0x10004220`) runs
  after allocation. Play registers a `Transient` package object in its host
  registry at startup (not a measured index).
* `new(Self)` of a script-only `Object` subclass (NanoKeyInfo, DeusExNote)
  inherits UObject's constructor through `UClass::Bind`; the nearest `RF_Native`
  ancestor must be Core.Object. Its Destroy virtual is `UObject::Destroy`.
* `CriticalDelete` (native 751) evaluates the object and calls its scalar deleting
  destructor. For the parser (`0x10004820`), `~DDeusExTextParser` runs
  ConditionalDestroy (the parser's Destroy frees the text copy), finalizes the
  FStrings, then `~UObject`. For a UObject-vtable object it is `~UObject` plus
  `operator delete`. The int result is never written. Other vtables are an explicit
  error.

## Information devices in Play

`game.use()` runs `ParseRightClick → DoFrob → InformationDevices.Frob`.
`CreateInfoWindow` builds the parser and opens the text. It then shows the HUD's
`HUDInformationDisplay`, adds one `TextWindow` per paragraph through ProcessTag,
adds the DataVault note (GetNote prevents duplicates; AddNote logs `NoteAdded`
and requests `LogNoteAdded`) and CriticalDeletes the parser. Frob hides the
crosshair and frob display. `InformationDevices.Tick` calls `DestroyWindow` once
`FrobTarget` changes, as does a second frob. That clears the paragraph windows
through `DestroyAllChildren` and the native window destruction path
([window destruction](script-window-destroy.md)).

The same path needed two general fixes. The VM's switch had to follow Core
`execSwitch`/`execCase` (see [scene events](scene-events.md)); stacked case labels
had silently skipped ProcessTag's text and colour tags. The TextWindow natives
AppendText (1551), SetWordWrap (1555), the line and width setters (1559–1563) and
CarriageReturn (1482) were added, and the SetText and AppendText execs now apply
`ConvertScriptString` as the originals do.

`scripts/validate-datacube-read.mjs` reads DataCube0 through the public path. It
checks the seven paragraph windows (the code `0012`), the first window's colour,
the display size and the glyphs drawn inside it, the note text and tag, the log line and sound request, the parser's transient
Outer and release, `PlayPickupAnim`, closing by walking away and by a second
frob, the re-read without a duplicate note, and BookOpen0 and DataCube2.

## Remaining boundaries

* The display draws through the native HUD: `DeusExHUD.ConfigurationChanged`
  sizes it from its preferred size (356×107 for DataCube0), and each paragraph
  TextWindow draws its glyphs. This needed a host fix: `XGC::GetTextExtent`
  returns X/Y extents, which the TextWindow and TextLogWindow layout read as zero
  or NaN, so every paragraph had width 0. The browser shows the text; it has not
  been compared pixel for pixel with the original. Bold (`<B>`) changes no font,
  as ProcessTag ignores it.
* `imageClass` DataVault images and `GotoLabel` are not reached in Training.
* The transient XExtString that OpenText loads and deletes is not modelled as a
  registry allocation; Play's host registry is not the measured GObjObjects.
* The parser's reflected native fields keep their InitProperties values; script
  reads of them are not bound. The four shipped users (InformationDevices,
  ComputerUIWindow, QuotesWindow, CreditsScrollWindow) call only the natives;
  InformationDevices' only GetName call is commented out in its source.
