# Initial inspection — 2026-09-09

**Historical record:** the extraction blocker described below was resolved when
the user supplied `Deus Ex GOTY Edition/`. See [extracted data findings](extracted-data.md)
for the current status and real-package validation.

## Supplied files

The workspace initially contained only `Deus Ex Game of the Year Edition [Gnarly
Repacks]`, with `Setup.exe`, `Data.bin`, an NFO, and a URL shortcut. No application
source tree or extracted game packages were present.

| File | Bytes | Identification |
| --- | ---: | --- |
| `Setup.exe` | 6,244,850 | Windows PE32; embedded Inno Setup 6.0.0 signature |
| `Data.bin` | 341,828,091 | FreeArc, starts with `41 72 43 01` |

SHA-256:

```text
Data.bin   7c2e29a32cf747bebbb6cf8feb39be9536022ee3f279a4492964d6d99d7b0984
Setup.exe  e08441bdfc1d9f61df07df58a811f00e64b6182b29aea0d9583e22c55c275b42
```

Neither the installer nor any game executable was run.

## Archive directory recovered

The listing contains **295 files and 7 directories**, totaling **759,404,937
uncompressed bytes**. The extractor's footer calls all 302 entries “files.”

| Kind | Count |
| --- | ---: |
| Maps (`.dx`) | 88 |
| Script / object packages (`.u`) | 38 |
| Textures (`.utx`) | 56 |
| Music (`.umx`) | 35 |
| Sound packages (`.uax`) | 2 |
| Native libraries (`.dll`) | 27 |

Named assets include `Maps/00_Training.dx`, `Maps/00_TrainingCombat.dx`,
`Maps/00_TrainingFinal.dx`, `Maps/01_NYC_UNATCOIsland.dx`, and `System/DeusEx.u`.
The complete generated listing is in `reports/archive-inventory.json`; the raw
tool output is `.cache/archive-list.txt`.

These are directory metadata observations. The asset payloads and their checksums
have not been verified. The installed engine build and package versions cannot
yet be inferred confidently from the installer name.

## Extraction attempt and reproducibility

The installed p7zip 17.05 could not open either input. We built the open-source
[DArc extractor](https://github.com/DavidLee18/DArc) at commit
`c4b9538f173e7a65ae70005772e1bd211c302b93` with Rust 1.95.0 on this Mac.
Its directory reader expects eight-byte timestamps. Original FreeArc's
[directory reader](https://github.com/mirror/freearc/blob/master/Unarc/ArcStructure.h)
uses four-byte timestamps. A local patch adds the explicit
`DARC_LEGACY_TIME32` switch, leaving DArc's normal behavior unchanged. The
patched reader successfully decodes this archive's directory.

Rebuild and list, from the project root (requires Git, Rust/rustup, and a compiler):

```sh
bash scripts/prepare-archive-tools.sh
DARC_LEGACY_TIME32=1 .cache/darc/rust/target/release/unarc l \
  'Deus Ex Game of the Year Edition [Gnarly Repacks]/Data.bin'
```

The attempted extraction was:

```sh
DARC_LEGACY_TIME32=1 .cache/darc/rust/target/release/unarc x -dpgame \
  'Deus Ex Game of the Year Edition [Gnarly Repacks]/Data.bin'
```

It failed with exit code 2:

```text
ERROR: data block at pos 31: compression method "lolz" is not supported yet
Extracted 0 files, 0 bytes.
```

An installed game directory is the shortest next step. Another extraction route
would need a compatible LOLZ decoder and potentially a Windows execution
environment; those have not been set up here.

DArc remains a local build tool under `.cache/`, separate from the game runtime.
Its source retains its upstream GPL-3.0 license. The patch is explicitly a local
modification, not an upstream release or a general compatibility guarantee.

## Engine research

[SurrealEngine](https://github.com/dpjudas/SurrealEngine) reimplements Unreal
Engine 1. Its [current status](https://github.com/dpjudas/SurrealEngine/blob/master/Docs/Status.md)
reports that Deus Ex 1112fm reaches the title screen and can play the beginning of
training, with unfinished native functions and conversations. Its documented
graphics requirements are native Direct3D/Vulkan, so a browser target would require
additional platform and rendering work. It does not provide a ready-made full
Deus Ex web port.

We will evaluate reuse after establishing an original-map rendering baseline.
For now, the project implements only package table inspection; no engine source
has been integrated.

## Validation so far

Synthetic tests cover compact-index boundaries and overflow, ANSI/Unicode strings,
table parsing, object references, dependencies, buffer subviews, truncation, and
CLI behavior. Real-package compatibility and rendering remain untested because
extraction did not produce any game assets.
