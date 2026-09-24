# SDK reference material — 2026-09-24

The user supplied two public developer packages. They live in `Reference/`,
which Git ignores, next to the installed game. Only facts derived from them and
checked against the retail DLLs enter the repository. No header text is copied,
nothing is compiled into a binary, and the installers are extracted with `7z`,
never run.

| Archive (in `Reference/archives/`) | SHA-256 | Extracted to |
| --- | --- | --- |
| `DeusExSDK1112f.exe` (WinZip self-extractor) | `a54e1663…0b51a3eb28` | `Reference/DeusExSDK1112f/` |
| `ut432pubsrc.zip` | `bb4b1284…d44cc7395` | `Reference/UT432PubSrc/` |

The Deus Ex SDK license
(`ReleaseSDK1112f/System/SDKlicense.int`) forbids modifying, recompiling,
reverse engineering, selling, renting or leasing the SDK software "to anyone
else". It also limits distribution of levels made with it. The material
therefore stays local and is used as reading reference only.

## Contents

- **Deus Ex SDK 1112f.**
  - `Headers/DxHeaders.zip`, extracted in place: C++ headers for Core, Engine,
    Extension, DeusEx, DeusExText and ConSys (about 124k lines), plus driver
    and editor headers. There is no `.cpp` for the game DLLs.
  - `Headers/DXLibs.zip`: import libraries for the game DLLs.
  - `DeusExConversations/*.con`: ConEdit sources for Intro and Missions 0–2.
  - `DeusExText/`: mission text sources.
  - The 1112f UnrealEd, UCC and Core binaries.
- **UT v432 public source.** Epic's Core/Engine headers for Unreal Tournament,
  plus source for its render devices (`D3DDrv`, `OpenGLDrv`), `Audio`, `XDrv`,
  `Setup`, `UCC` and a sample native package. This is Unreal Tournament's
  code, not Deus Ex's. Use it for render-device and audio interfaces
  (Stage 4), never as behavior evidence for the game.

## Layouts and vftables: `scripts/sdk-layouts.mjs`

The script copies the five game-package `Inc` directories to
`.cache/sdk-layouts-work`. It makes two MSVC 6 compatibility edits that clang
needs; they are listed in the script header. clang then emits the Microsoft
x86 record layouts and vftables (`-target i686-pc-windows-msvc`, IR
discarded). The result is written to `.cache/sdk-layouts.json`: 364 records
with absolute member offsets and bit ranges, 183 vftables, and base chains.

```bash
node scripts/sdk-layouts.mjs
```

```bash
node scripts/sdk-layouts.mjs --at XRootWindow 0x5c8
```

```bash
node scripts/sdk-layouts.mjs --overrides XWindow
```

```bash
node scripts/sdk-layouts.mjs --retail XCheckboxWindow
```

Run without options, the script checks the SDK (1112f) against the GOTY
retail DLLs (1112fm):

- All 66 `XWindow`/`XRootWindow` offsets recovered earlier from `Extension.dll`
  (`script-window-tree-natives.mjs` `O`/`ROOT`) start an SDK member, and the
  names agree (`+0x138 parent`, `+0x5c8 focusWindow`, `+0x588 parentPawn`).
  63 are direct members. The other three are `clipRect.clipWidth/Height` and
  the inherited `XModalWindow.preferredFocus`.
- All 6 recovered `XWindow` virtual offsets name the same slot, from `+0x64`
  `CursorRequested` to `+0xf0` `ToggleChanged`.
- The retail Core, Engine, Extension, DeusEx and ConSys export 120 vftables
  (`??_7Class@@6B@`) whose base table is also exported. 4,566/4,566 of their
  slots follow the SDK override pattern: an inherited slot holds the base's
  function, and an overridden slot holds another one. Two SDK overrides,
  `XClipWindow` and `XRadioBoxWindow` `+0x88 ChildRequestedReconfiguration`,
  share `XTabGroupWindow`'s `xor eax,eax; ret 4` at `0x100421d0`. The linker
  folded the identical bodies.

For this build, the SDK window layouts and vftable slot assignments are
therefore checked facts, not header assumptions. Engine records still need
their own retail check. The GOTY `DeusEx.dll` `UnloadTexture` (`0x10014c90`)
reads `UTexture.Mips` data at `+0xa4` and its count at `+0xa8`. The SDK header
has them at `+0xa8`/`+0xac`, so the retail `UTexture` differs by 4 bytes
before `Mips`. Function bodies still come from the
retail DLL, and an unexported class's vftable needs its own retail read.

## Uses

- **Naming offsets.** `--at Class offset` turns a raw native offset into the
  member it belongs to, including nested structs and inherited members.
- **Family admission.** `--overrides XWindow` lists, for every window class,
  the virtuals it defines itself. Admitting a family means translating those
  and nothing else. For the census frontier
  ([exit criteria](stage-3-exit-criteria.md)):
  - The Goals screen's `CheckboxWindow` adds only `Init` `0x1000a710`,
    `CleanUp` `0x1000a7d0`, `ParentRequestedPreferredSize` `0x1000acb0` and
    `Draw` `0x1000aad0` to the recovered Toggle, Button and Text chain.
  - The Inventory screen's missing override is
    `XTextWindow::ParentRequestedGranularity` `0x10046880`.
  All five are now translated and checked against the original bodies
  ([checkbox](script-window-checkbox.md)).
- **Virtual calls in exec bodies.** A `call [reg+N]` in a native body is slot
  `N/4` of the receiver's class, and `--retail` gives the function. The
  exec-diff harness can use this to run the virtual-calling natives against
  the right bodies or recorded services.
