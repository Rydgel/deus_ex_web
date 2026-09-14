# XWindow sensitivity and tree accessors

This note records nine Extension native entry points from the installed GOTY
`Extension.dll`.  The authority is the unchanged DLL with SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`; addresses
below use the original preferred image base `0x10000000`.  The focused oracle
rebases that image to `0x12000000` while retaining the original instructions; no
public-engine substitute is used.

## Registration mechanism

Extension's static constructor registers each native with:

    push <data cell>        ; data cell holds the exec body pointer
    push <native index>
    call dword ptr [0x10059068]   ; Core.dll ?GRegisterNative@@...

`0x10059068` is the import slot for Core's `GRegisterNative`.  Core's body at
`0x1013f480` lazily fills the `GNatives` array (`0x101f41b8`) with the default
stub, then dereferences the data cell and stores that function pointer at
`GNatives[nativeIndex]`.  The packed pointer array at `0x10098f58` that looks
index-aligned for `1409..1460` and then drifts is not an index table and is not
used here.  `GNatives` is BSS in the static image and is only populated by
runtime registration; the oracle therefore installs the expression-evaluator
entries it exercises as explicit harness services.

## Thunk and body table

| index | native | exec body | exec SHA-256 | optional arg default | normal body |
| ---: | --- | ---: | --- | --- | ---: |
| 1416 | `Window.SetSensitivity` | `0x10051ab0..0x10051af6` | `52d4f59a9aaddc20366653576e19ccf06c525095f179c7c83ea81e6b7e6b9dbd` | false (`0x10051ab8`) | `0x1004c890..0x1004c947` |
| 1417 | `Window.EnableWindow` | `0x10051b20..0x10051b66` | `de1b827bda3a5864bf8c4c833f02816483b44f87b90eca58879ad4fc8b3d44f4` | true (`0x10051b28`) | `0x1004c890..0x1004c947` |
| 1418 | `Window.DisableWindow` | `0x10051b90..0x10051ba1` | `05403e3f1818f3202b892783020ecbb2bd36f2373e122042ebe7ec1c43867a7d` | none; pushes literal `0` | `0x1004c890..0x1004c947` |
| 1419 | `Window.IsSensitive` | `0x10051bd0..0x10051c4c` | `1cbfd1ec386e73ec84c967450fe884febab2218bf782eb685cf189d2464caac3` | true (`0x10051bd8`) | inline in the exec body |
| 1455 | `Window.GetTopChild` | `0x10052d40..0x10052d8c` | `8e2670a7bef50147bb95bc03782a081864f384d446b5223157c1e2f3e1db7bfb` | true (`0x10052d48`) | `0x1004c6b0..0x1004c70a` |
| 1456 | `Window.GetBottomChild` | `0x10052db0..0x10052dfc` | `917a1d2bb57cab0165a432fa644bc13f0c239839e97f4b55bddaccffca9d3836` | true (`0x10052db8`) | `0x1004c740..0x1004c79a` |
| 1457 | `Window.GetHigherSibling` | `0x10052e20..0x10052e6c` | `86accde319ceedff9802f463b27e1e68967b52ff74f7581949fa6e7c51d95918` | true (`0x10052e28`) | `0x1004c680..0x1004c6a6` |
| 1458 | `Window.GetLowerSibling` | `0x10052e90..0x10052edc` | `d65f2ae3d3e367f3c641dbf9b2b44fa7782d5cc3803c8c1d62e8faa77682e627` | true (`0x10052e98`) | `0x1004c650..0x1004c676` |
| 1488 | `Window.GetClientObject` | `0x10052650..0x1005266a` | `a853decf7b955c318b4f9338bba9ba75179df8234135c6d409fcc293c56eb040` | none | inline in the exec body |

Normal-body SHA-256 values:

| body | range | SHA-256 |
| --- | ---: | --- |
| `XWindow::SetSensitivity` | `0x1004c890..0x1004c947` | `808e503c7a65765e4c28e9dd16af779a5855b2ebf400f04eda32bafd0057f506` |
| `XWindow::GetLowerSibling` | `0x1004c650..0x1004c676` | `506a2fa0b9b47ea365d9636fe128fdca3f4f13c329eff2693f948c5f8091ce2e` |
| `XWindow::GetHigherSibling` | `0x1004c680..0x1004c6a6` | `e7ffb2848ac6b9f622a85798f46fde2df2172b8f9cec86487d4a64b68863c7dd` |
| `XWindow::GetTopChild` | `0x1004c6b0..0x1004c70a` | `fcf8308961945b5a24fa95b2de95ecee8f862df6b7979b550617aa40b2cce76a` |
| `XWindow::GetBottomChild` | `0x1004c740..0x1004c79a` | `d6932038936b41b66b678639fc6c5d391ce5a720a5c67a251a4e2b676e0922c3` |

`enableWindow`'s `optional-arg default` is the immediate stored at
`0x10051b28` and `setSensitivity`'s at `0x10051ab8`; `disableWindow` does not
parse an argument and increments the frame code cursor once
(`0x10051b96`).  The tree accessors store their default at `0x10052d48`,
`0x10052db8`, `0x10052e28`, and `0x10052e98`.

## XWindow offsets

| field | offset | width | evidence |
| --- | ---: | --- | --- |
| flags | `+0x30` | dword | bit `0` VISIBLE, bit `1` SENSITIVE (`test byte [reg+0x30]` reads) |
| client object | `+0x118` | pointer | `mov eax,[ecx+0x118]` at `0x1005265b` |
| parent | `+0x138` | pointer | walk link in `0x1004c8d6` and `0x10051c19` |
| bottom child | `+0x13c` | pointer | `mov eax,[ecx+0x13c]` at `0x1004c75b` |
| top child | `+0x140` | pointer | `mov eax,[ecx+0x140]` at `0x1004c6cb` |
| lower sibling | `+0x144` | pointer | `mov eax,[ecx+0x144]` at `0x1004c650` |
| higher sibling | `+0x148` | pointer | `mov eax,[ecx+0x148]` at `0x1004c680` |

The bottom/top names are the native first/last child links already recorded in
[script-window-layout.md](script-window-layout.md) (`firstChild +0x13c`,
`lastChild +0x140`): `GetBottomChild` reads `+0x13c` and `GetTopChild` reads
`+0x140`.  The flags dword's visible bit is the same one used by
[script-window-visibility.md](script-window-visibility.md); the tree accessors
filter on that bit and not on sensitivity, despite the batch name.

## Recovered semantics

### XWindow::SetSensitivity (`0x1004c890`, natives 1416/1417/1418)

1. Read the dword at `+0x30`.  Compare `(flags >> 1) & 1` with the **raw**
   argument; an equal value returns immediately with no other read, write, or
   call (`0x1004c8c0..0x1004c8c7`).  The comparison is before `arg & 1`.
2. On a change, compute the effective sensitivity before the write: start at
   `this` and climb `+0x138` while the current window's byte `+0x30` has bit 1
   set.  `sete bl` at `0x1004c8e5` makes the result **true when the walk ran off
   the chain** (null link) and false when it stopped on a window with bit 1
   clear.
3. Reread `+0x30` and write
   `flags = (flags & ~2) | ((argument & 1) << 1)` (`0x1004c8e8..0x1004c8f4`).
   All upper flag bits are preserved.
4. Repeat the effective walk.  If the effective value is unchanged (for
   example an insensitive ancestor kept the subtree insensitive in both
   directions), return with no further calls.
5. On an effective change the tail callees run in this exact order:
   - `CheckFocusWindow(this)` at `0x10050b80`;
   - `CheckGrabbedWindow(this)` at `0x10050c90`;
   - `MakeAcceleratorTableDirty(this)` at `0x1004c1d0`;
   - `notifySensitivityChanged(this,effectiveSensitivity)` at `0x10050ef0`.

There is no `+0xb8` reconfigure-dirty update in this body; that step belongs to
`SetChildVisibility`.

The last callee `0x10050ef0` is recovered but intentionally not expanded: it
calls the window virtual slot `+0x98` (`XWindow` vtable `0x10059930` + `0x98`,
body `0x10003630`) with the effective value, and the virtual body dispatches the
event FName held at global `0x1009b3c4` with third argument zero.  The static
initializer at `0x10022ba3` loads the UTF-16 literal `0x10098184`
(`"SensitivityChanged"`) into that global.  The callee then recurses into the
`+0x13c` child chain via `+0x148` while the child's bit 1 is set.  The
translation exposes this as one synchronous host leaf carrying the native
address, virtual slot `0x98`, event name, and effective value; the recursive
body, event dispatch, focus/grab handling, and accelerator invalidation remain
outside this task.

### Optional-argument exec shape

All nine exec bodies use the same inline optional-parameter parse: read the next
bytecode token, dispatch it through `GNatives[token]` with the destination slot
pre-loaded with the default, then advance the code cursor once more.  Setters
and tree accessors have one optional boolean parameter; `IsSensitive` has one
optional recursive flag; `DisableWindow` and `GetClientObject` have none.
`SetSensitivity()` with no argument therefore disables the window, while
`EnableWindow()` enables it.

### XWindow::IsSensitive (`0x10051bd0`, native 1419, inline)

With `bRecurse = false`, read the dword at `+0x30` and return
`(flags >> 1) & 1`.  With `bRecurse = true`, start at `this` and climb `+0x138`
while the byte `+0x30` has bit 1 set; the result is true only when the walk runs
off the chain.  The reflected getter at `0x1000324b` returns the same local bit,
and the reflected recursive body at `0x10003230` performs the same `+0x138`
walk; those bodies corroborate the polarity but are not the bound path.

### Tree accessors (native 1455-1458)

`GetLowerSibling`/`GetHigherSibling(this,flag)` read `+0x144`/`+0x148`.  With
`flag` false the raw link is returned unfiltered; with `flag` true the walk
returns the first link whose bit 0 is **set**, or null when the chain ends.

`GetTopChild(this,flag)` reads `+0x140` and `GetBottomChild(this,flag)` reads
`+0x13c`.  If `flag` is false, the link is null, or the child's bit 0 is set,
the child is returned immediately.  Only when the flag is set, the child
exists, and the child's bit 0 is clear does the accessor delegate to
`GetLowerSibling(child,flag)` (`0x1004c6f2`) or
`GetHigherSibling(child,flag)` (`0x1004c782`).  The delegated walker starts at
the child's sibling link, so a hidden first child is skipped rather than
returned.

### XWindow::GetClientObject (`0x10052650`, native 1488, inline)

Return the pointer at `+0x118` and advance the frame code cursor once.  No
argument is parsed and no other field is read.

## Translation boundary and validation

`src/runtime/script-window-sensitivity.mjs` exposes `setSensitivityNative`,
`enableWindowNative`, `disableWindowNative`, `isWindowSensitiveNative`,
`getTopChildNative`, `getBottomChildNative`, `getHigherSiblingNative`,
`getLowerSiblingNative`, and `getClientObjectNative`.  Window fields use
`read(object,offset,kind,details)` and
`write(object,offset,kind,value,details)` with `kind` `u8`, `u32`, or `ptr`.
The four tail callees are synchronous host leaves; malformed/cyclic chains and
suspended services are rejected rather than assigned guessed behavior.

`scripts/native-window-sensitivity-oracle.py` executes the unchanged exec and
normal bodies against the rebased image, intercepts only
`CheckFocusWindow`, `CheckGrabbedWindow`, `MakeAcceleratorTableDirty`, and
`notifySensitivityChanged`, and treats the `GNatives` expression entries as
harness services.  `scripts/validate-window-sensitivity.mjs` checks the DLL
hash and every pinned body, then compares 29 oracle cases bit-exact: raw access
sequence with values, leaf order and arguments, final flags/parent state, the
returned pointer or boolean, and the harness-observable code advance.

What each claim rests on:

- Optional defaults: `setSensitivityNoArgument` clears bit 1 and notifies with
  `0`; `enableWindowNoArgument` sets bit 1 and notifies with `1`;
  `disableWindowNoArgument` clears bit 1 through the literal push.
- Raw guard and no side effects: `setSensitivityNoOp` records a single dword
  read and no events.
- Effective-sensitivity polarity and suppressed tail calls:
  `setSensitivityBlockedByInsensitiveParent` changes only the local bit and
  emits no events because an insensitive ancestor keeps the effective value
  false; `setSensitivityEffectiveViaSensitiveParent` reaches the end of the
  chain, flips the effective value to true, and emits the ordered leaves.
- Visible-bit filtering with hidden chains: `lowerSiblingFilteredHiddenChain`,
  `higherSiblingFilteredHiddenChain`, `lowerSiblingRawUnfiltered`,
  `higherSiblingRawUnfiltered`, `lowerSiblingFirstVisible`,
  `lowerSiblingHiddenToNull`, `higherSiblingHiddenToNull`.
- Child delegation: `topChildVisibleFirst`, `topChildHiddenDelegatesLower`,
  `topChildRawUnfiltered`, `topChildHiddenNoLower`, `topChildNull`,
  `bottomChildVisibleFirst`, `bottomChildHiddenDelegatesHigher`,
  `bottomChildRawUnfiltered`, `bottomChildNull`.
- `IsSensitive` polarity: `isSensitiveNoArgumentRecursiveRootSensitive`,
  `isSensitiveNoArgumentSelfInsensitive`, `isSensitiveExplicitFalseLocal`,
  `isSensitiveRecursiveAncestorInsensitive`, `isSensitiveRecursiveAllSensitive`.
- Client object: `getClientObject` returns the `+0x118` word.

Tail-callee order is proven by the leaf event sequence of the cases that
trigger it; the internals of those callees are not executed by this validator.

## Unverified scope

- `CheckFocusWindow`, `CheckGrabbedWindow`, `MakeAcceleratorTableDirty`, and
  the `0x10050ef0` recursive `SensitivityChanged` notification are explicit
  host leaves.  Their native bodies, the virtual slot `+0x98` event dispatch,
  and the recursive child walk are read from the instruction encodings and are
  not test-distinguishable in this oracle because the probe returns at the
  leaf entries.
- The `"SensitivityChanged"` event spelling comes from the static literal at
  `0x10098184` stored into global `0x1009b3c4`; the oracle never reads the
  runtime FName, so this naming is instruction/static-data evidence only.
- Core's `GNatives` is BSS and filled only by runtime registration, so the
  oracle installs the `EX_EndFunctionParms` and boolean evaluator entries as
  harness services.  The lazy initializer at `0x1012fb60` installs
  `0x1012faf0` for `EX_EndFunctionParms` at runtime; that handler adjusts the
  code cursor and does not write the destination slot, which is why the
  pre-stored default remains observable.  The evaluator bodies themselves are
  outside this task.
- The dispatch entries use a new `windowLifecycle.sensitivity` service group.
  No existing integration or live UI path supplies those four leaves yet, so
  the entries are component-validated but not exercised by a live InfoLink or
  other scripted flow.
- Arguments outside boolean/`0`/`1` are rejected at the script boundary.  The
  native compares the raw argument before masking, so a raw `3` differs from a
  stored `1` yet writes the same bit; no oracle case distinguishes that path
  because every supplied boolean expression evaluates to `0`/`1`.
- Cyclic `+0x138`, child, or sibling chains are rejected by the translation;
  the native bodies would loop, so no oracle case covers them.
- The harness code-advance values (one token for `DisableWindow` and
  `GetClientObject`, two for the optional-parse bodies) are observed on the
  unchanged exec bodies with non-advancing evaluator stubs; they are recorded
  by the oracle and asserted by the validator but are not part of the JS
  boundary contract.