# UFont glyph-metrics model and the text-measurement natives

Authority is the shipped Extension.dll SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`
(preferred image base `0x10000000`; the Unicorn oracle maps it at
`0x12000000`), Core.dll SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`, and
Engine.dll SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`.
Every behavior below was recovered from disassembly of the real method
bodies and re-verified by executing them under Unicorn in
`scripts/native-gc-textmetrics-oracle.py` over real shipped `UFont` data;
the JavaScript translations are compared bit-exact (result f32 bit patterns,
event stream, and canonical GC state) by `scripts/validate-gc-get-text-extent.mjs`
and `scripts/validate-gc-get-font-height.mjs`.

## Bound natives

| native | export | method body | exec trampoline |
| ---: | ---: | --- | --- |
| 1280 `GC.GetTextExtent` | 2098 | `0x10027bb0–0x10027d57` | `0x1002c020–0x1002c1e2` |
| 1281 `GC.GetFontHeight` | 2103 | `0x10027d60–0x10027e44` | `0x1002c210–0x1002c25c` |

UnrealScript metadata re-verified against Extension.u on every run:
`GetTextExtent(destWidth:float, xExtent:float, yExtent:float, textStr:string)`,
flags `0x401`, serial size 40;
`GetFontHeight(bIncludeSpace:bool, ReturnValue:float)`, flags `0x401`,
serial size 31. Method/exec body SHA-256 values live in the frozen
`GC_GET_TEXT_EXTENT_NATIVE` / `GC_GET_FONT_HEIGHT_NATIVE` exports and are
hash-checked against the DLL.

## Serialized UFont layout

Recovered from every shipped `Font` export (33 across Engine.u,
DeusExUI.u, Extension.u — all match exactly):

```
+0  u8    format byte (observed 0 in Engine/Extension, 2 in DeusExUI)
+1  u8    page count
+2  ..    per page, in order: 4-byte page header, then
          charsPerPage x 16-byte glyph records
-4  i32   charsPerPage (final four bytes of the export)

total = 2 + pageCount * (4 + charsPerPage*16) + 4
```

Glyph record = `FFontCharacter`, 16 bytes:

| offset | field | consumer |
| ---: | --- | --- |
| `+0x00` | i32 `startU` | texture atlas U (draw path only) |
| `+0x04` | i32 `startV` | texture atlas V (draw path only) |
| `+0x08` | i32 `uSize` | **advance width** — `fild`ed into the X run |
| `+0x0c` | i32 `vSize` | **height** — line-height max and GetFontHeight |

The 4-byte page header is opaque to measurement: it carries the page's
texture/palette references the draw path resolves. Both metrics natives
never read it.

## Runtime UFont layout

The UObject header occupies `+0x00..+0x27`; the Font fields the natives
touch:

| offset | field |
| ---: | --- |
| `+0x28` | i32 `charsPerPage` — signed `idiv` divisor in the char mapper |
| `+0x2c` | ptr page table (`TArray<FPage>` data) |
| `+0x30` | i32 page count (`TArray.Num`) |
| `+0x34` | i32 page table Max (written by the loader, unread by metrics) |

Each `FPage` is 16 bytes:

| offset | field |
| ---: | --- |
| `+0x00` | ptr texture (surfaced only through the lookup's `texOut` arg, which both natives pass as null) |
| `+0x04` | ptr glyph run (`FFontCharacter[numChars]`) |
| `+0x08` | i32 `numChars` — equals `charsPerPage` in every shipped font |
| `+0x0c` | i32 `maxChars` (`TArray.Max`) |

## Char-to-record mapping

Extension `0x10026950` (mapper) under `0x10026880` (lookup):

```
ch  &= 0xffff
page = ch / charsPerPage      (signed idiv)
rem  = ch % charsPerPage
miss iff page >= pageCount or rem >= page.numChars   (signed jge)
miss -> static zero record at Extension .bss 0x100aeba0
hit  -> page.chars + rem*16; *texOut = page.texture iff texOut != 0
```

A zero `charsPerPage` would trap inside `idiv` (#DE) under the native's SEH
frame — unreachable for any shipped font; the JS model rejects it as an
unverifiable boundary rather than guessing a result.

## GC state consumed

From `script-gc-state-model.mjs`: `normalFont +0x7c`, `boldFont +0x80`,
`textVSpacing +0x90` (f32), `textFlags +0x98`. `textFlags` bit1 (`0x2`,
specialText) gates `|`-token parsing. **Bit0 (`0x1`, wordWrap) is never
tested in this native's path** — `GetTextExtent` word-wraps regardless;
verified by the `wordwrap-flag-off` oracle case.

## GetTextExtent (0x10027bb0)

SEH-framed loop over lines. Per line it calls the scanner wrapper
`0x10029d80`, which copies the 20-byte iterator state by value and calls
the real scanner `0x10029ae0`
`(start, state[5 dwords], end, destWidth:f32, &cursor, &state, &len, &width)`
— `ret 0x30`. The wrapper returns `progress ? lineStart : 0`; the method
uses that pointer both as the continue flag and as the rescan cursor.

- `destWidth <= 0` or NaN becomes `500000.0f` (constant at `0x10059884`).
- The first character of a line always fits, even past `destWidth`.
- Width accumulates `uSize` per glyph as an f32 store; overflow then wraps
  at the last word boundary (space class `{0x09,0x0b,0x0c,0x0d,0x20}`),
  continues through an overflowing space to the next word, or hard-cuts
  mid-word — the `wordStart <= wordEnd` compare distinguishes the paths.
- Newline (`0x0a`) ends the line and sets a continuation byte so the next
  scan can yield a trailing empty line.
- Per line, height = max glyph `vSize` over the line's renderable chars;
  if below `1.0f` (constant `0x1005aa18`) and a font exists, it falls back
  to that font's space-glyph `vSize` — an unconditional store, not a max.
- `totalY += lineH + textVSpacing` in one f32 store (single rounding,
  `(lineH + vSpacing) + totalY` order); `xExtent`/`yExtent` are `fstp`ed
  unconditionally.

### Special-text iterator (0x100294d0)

When `textFlags & 2`, `|` introduces a token; `!` after `|` inverts it.
Consumed tokens do not contribute glyph width:

| token | effect |
| --- | --- |
| `\|b` / `\|!b` | bold on/off — selects boldFont vs normalFont mid-string |
| `\|cRRGGBB` / `\|!c` | text color — 3 hex byte pairs via `0x100292f0`; scale constant `0x1005e3e8` is a *distinct* 1/255 (`0x3f70101010101027`), not the GC color scale |
| `\|p0`-`\|p7` / `\|!p` | palette select — one-time init at `0x100a2df4` writes the 8-entry table |
| `\|&` | ampersand marker (mnemonic flag byte) |
| `\|\|` | literal `|` |
| unknown / trailing `\|` | consumed per the recovered tail rules |

A stale `lastChar` global (`0x100aeb94`) is part of the observed semantics.
Hex digits are compared as full UTF-16 code units — a unit like `0x141`
must not parse as `'A'`.

## GetFontHeight (0x10027d60)

```
h = max(0, normalFont ? space.vSize : 0)      // kept only if positive
h = max(h, boldFont ? space.vSize : 0)
if (bIncludeSpace) h += textVSpacing          // single f32 store
return h as f32 (fstp through the exec's out store)
```

Space glyph = char `0x20` through the same mapper; a miss contributes 0.

## Verified fonts

Real exports decoded and executed by the oracle: `Engine.SmallFont`
(1×256, space 6×8), `Engine.MedFont`, `Engine.LargeFont` (4×64, space
23×39), `DeusExUI.FontConversation`. Synthetic images cover zero-space,
tall-space and two-page edge layouts.

Validation: `scripts/validate-gc-get-text-extent.mjs` — 45 cases bit-exact
(empty, real fonts, ±vSpacing, wrap exact/word/space/midword/tight,
newline variants incl. trailing-line, bold/color/palette/amp escapes,
missing glyph, multipage, destWidth zero/negative/NaN, method-vs-exec);
`scripts/validate-gc-get-font-height.mjs` — 12 cases bit-exact. Mutation
gates per native (each must diverge, and does): glyph width/height field
offsets, char→page map, `|b` polarity, newline stop char, overflow
strictness, wrap resume offset, line-height fallback threshold
(GetTextExtent); space-height field, bold compare, bIncludeSpace
polarity, font-slot read (GetFontHeight).

## Unresolved / unverified boundaries

- `charsPerPage == 0` (#DE under SEH) and malformed page tables are
  rejected as unverifiable — never observed in shipped data.
- Page-header bytes and `startU`/`startV`/`page.texture` are carried
  verbatim but uninterpreted — the draw/blit natives that consume them
  are out of scope (render device required).
- `page.numChars < charsPerPage` never occurs in shipped fonts; the
  compare is implemented from the disassembly but exercised only via the
  miss path.
- The `|c` color scale constant `0x1005e3e8` differs in the low mantissa
  bits from the GC color scale `0x1005e3c0`; both are asserted from DLL
  bytes, not unified.

### Page texture reference resolved for the live HUD

The browser HUD now resolves the page headers for FontTiny,
FontMenuHeaders_DS and FontFixedWidthSmall_DS through the original serialized
UObject reference. Engine.dll UFont::Serialize (0x10385400), its page array
(0x10385680), and FFontPage serializer (0x10385940) establish texture reference
then glyph array. The three fonts' headers each contain two compact indices
(texture and glyph count); their glyph metrics remain checked by the existing
model. [The HUD bridge](script-play-hud.md) uses those pages with the recovered
GC.DrawText glyph path. This does not implement general UFont load finalization.
