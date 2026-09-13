# Core `UObject::ResolveName` ordinary package path

This is the source-first contract for the ordinary name path used by the
conversation `StaticLoadObject` call.  The authority is the installed GOTY
`Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
The recovered instructions are in `.cache/research/Core.asm`; the original
binary remains outside Git.

## Native entry and ordinary path

The exported thunk `0x10102c34` jumps to the body at `0x10154ad0`.  Its cdecl
arguments are mutable `UObject** Outer`, mutable `const TCHAR** Name`,
`Create`, and `Throw`.  For the focused call

```text
Outer = NULL
Name  = "DeusExConText.ConList_Mission00"
Create = 1
Throw  = 1
```

the body executes this order:

1. Read `*Name`.  The two `appStrnicmp` calls at `0x10154b19–0x10154b3d`
   compare its first four UTF-16 units, case-insensitively, with the original
   data strings `ini:` (`0x101af144`) and `usr:` (`0x101af150`).  The ordinary
   path compares unequal to both.  The bounded host translation accepts only
   ASCII UTF-16 units for this path; it does not use browser locale folding for
   untraced code units.  The null-name assertion at
   `0x10154af4–0x10154b16` is outside the valid fixture.
2. Because the ordinary name compares unequal to both prefixes, execution
   jumps directly to the package loop at `0x10154c4e`; the `appStrlen` call at
   `0x10154b55–0x10154b63` is only reached by a matching config prefix.  The
   package loop calls `appStrchr(Name,'.')` at `0x10154c54–0x10154c63`; a
   missing dot takes the success return at `0x10154cff–0x10154d14` without
   changing either holder.
3. Copy the complete name through `appStrcpy` (`0x10102432`) into the local
   1024-TCHAR buffer at `EBP-0x218`.  A second `appStrchr` finds the first dot
   in that copy and `movw 0` at `0x10154c87` terminates the first component.
4. Since `Create` is nonzero, call the `CreatePackage` thunk
   `0x10101ccb` (body `0x101549f0`) with the current `*Outer` and the
   temporary component.  For the first component this is
   `CreatePackage(NULL, "DeusExConText")`.
5. On return, publish the package result to `*Outer` first, then call
   `appStrchr` on the original `*Name`, advance the returned pointer by one
   UTF-16 unit, and write that pointer to `*Name`
   (`0x10154ce5–0x10154cf8`).  The loop checks the new tail.
   `ConList_Mission00` has no dot, so the body returns `1` and leaves the
   final name holder pointing at that tail.

The body does not normalize separators, parse quotes, or test whether a
package result is non-null before publishing it.  A null result is still
written to `*Outer`; a later component then follows the native loop.  The
bounded translation rejects quote delimiters (`'` and `\"`) before entering
this helper trace, so quoted-class/config syntax cannot be mistaken for a
validated ordinary path.  An unbound adapter result is a host error, while an
explicit null is a native null result.

## Nested existing-package branch

`CreatePackage` at `0x101549f0` first calls
`ResolveName(&localOuter,&localName,1,0)` (`0x10154a14–0x10154a24`) and then
calls `StaticFindObject(Core.Package, localOuter, localName, 0)`
(`0x10154a32–0x10154a45`).  The focused first component has no dot, so this
recursive resolver returns `1` without holder changes.  The package lookup
then reaches the original `StaticFindObject` body
`0x10151de0–0x10151fd0`:

1. It resolves the simple name with `ResolveName(..., Create=0, Throw=0)`.
2. It constructs `FName("DeusExConText", EFindName=0)` through thunk
   `0x10102e96`.
3. It computes `(NameIndex XOR (Outer ? Outer.Index : 0)) & 0xfff`, reads the
   corresponding `GObjHash` head at `0x1029e644`, and compares the candidate's
   name (`+0x20`), outer (`+0x18`), and class ancestry (`+0x24`, then
   `Class.SuperField` at `+0x28` when needed).  The focused fixture's existing
   package is the hash-head candidate with a canonical Core.Package class
   identity, so no all-package scan is reached.
4. The existing object returns through `CreatePackage` and is published by
   the outer `ResolveName` body.  The FName allocation and UPackage
   construction branches at `0x10154a47–0x10154a6e` are not reached.

The direct oracle records the recursive resolver, string helper calls, the
`CreatePackage` call, the nested `StaticFindObject` call, and the FName lookup.
It executes the ResolveName and CreatePackage bodies from the original image;
the string helpers and FName constructor are explicit synchronous services so
their startup/name-table graphs do not get guessed.  The package object and
hash head are fixture-backed canonical identities, and the lookup body itself
still executes.

## Unsupported branches

The `ini:`/`usr:` config alias branch is intentionally unbound.  Native code
strips the four-unit prefix, splits at the last dot, calls a config object's
virtual `+0x10` with a 1024-TCHAR output buffer and `System` or `User`, then
feeds the returned static string back through the ordinary loop.  This task
does not claim config/localization behavior or the localized throw path.
Names of length `>= 1024` are rejected before the bounded host can call the
native scratch-copy boundary; non-ASCII UTF-16 units, missing dots, null names,
malformed UTF-16 and memory faults beyond the focused valid fixture retain
their native boundary and are not converted into guessed success.  Quote
delimiters are rejected explicitly, while quoted-class/config parsing and
first-load package construction remain separate contracts.

## Original evidence and focused case

The target export is the mission-zero conversation list: the installed
`DeusExConText.u` contains `ConList_Mission00` as a `ConversationList` export,
and the live Training capture records that export as an already-created object
under the `DeusExConText` linker (`docs/stage3-live-capture.md`).  That makes
`DeusExConText.ConList_Mission00` the relevant ordinary path for the Stage 3
conversation wrapper.  This ResolveName contract only resolves its package
and tail; StaticLoadObject's linker/export identity and object return remain
the separate `script-static-load-object` contract.

Run the focused comparison with:

```sh
.cache/native-probe-env/bin/python scripts/native-resolve-name-oracle.py \
  "Deus Ex GOTY Edition"
node scripts/validate-resolve-name.mjs
```

The validator compares the original body trace with the bounded synchronous
translation for the ordinary existing-package case.  It is a contract
comparison against recovered instructions plus fixture state, not a claim that
the browser has complete package loading or config support.
