# Core object lookup and name resolution

Authority: installed GOTY Core.dll, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
Local disassembly: `.cache/research/Core.asm`; original assets remain ignored.

`UObject::StaticFindObject`, thunk `1010326a`, body `10151de0–10151fd0`:

1. Retain the original Outer argument. Convert only Outer `-1` to null for
   `ResolveName(&Outer,&Name,0,0)` (`10151dfe–10151e23`). Failure returns null.
2. Construct `FName(Name,0)` (find only). Name index zero returns null, even
   when an object happens to carry NAME_None (`10151e33–10151e46`).
3. Search bucket `(NameIndex XOR (Outer ? Outer.Index : 0)) & 0xfff`, in
   HashNext order. Match Name and resolved Outer first. Null Class accepts any
   match; ExactClass compares Object.Class identity; otherwise follow
   Class.SuperField at `+28` until the requested class or null
   (`10151e4c–10151eb5`).
4. If the bucket has no match and the **original** Outer was `-1`, iterate
   GObjObjects in ascending index order, skipping holes and objects outside
   Core.Object ancestry. Match Name and class using the same rules but without
   an Outer filter (`10151eb7–10151f88`). Thus the root/resolved bucket wins
   before the all-packages scan, even if its object index is higher.

`UObject::ResolveName`, thunk `10102c34`, body `10154ad0–10154d14`:

- Compare the first four UTF-16 characters, case-insensitively, with `ini:`
  (`101af144`) and `usr:` (`101af150`). Only a matching name shorter than
  1024 characters and containing a dot takes the config-alias path.
- Remove the prefix and split at the last dot into section and key. Invoke
  the config object's virtual `+10` with section, key, a 1024-character
  destination, and `System` (`101af18c`) or `User` (`101af19c`). Success
  replaces the name; failure returns false, or reaches the localized throw
  path when the fourth ResolveName argument is nonzero (`10154b19–10154c4c`).
- Repeatedly split at the first dot. With Create true, call CreatePackage on
  the current Outer and that component. Otherwise find Core.Package under
  the current Outer; if absent, find Core.Object there. Failure of both
  returns false. Success replaces Outer and advances Name past the dot
  (`10154c4e–10154cfa`). A name without dots returns true without changing
  Outer. This is not a filesystem path normalizer or quoted-object parser.

The translation uses the actual `ScriptObjectRegistry` and `createScriptNames`
table. Native Class/Super/Outer pointers are canonical identities, never matched
by their display names. Config lookup and package creation are explicit required
services only when their original branches are reached. The mutable Outer/Name
holders preserve progress if a later path component fails. The implementation
does not load packages, invent missing objects, or create names during lookup.

The live adapter accepts `classOf`/`superClass` storage accessors when a host
keeps a typed class wrapper around its canonical identity. An absent ancestry
binding is an error, not evidence that the class has no superclass.

`validate-script-construction.mjs` and `validate-script-spawn.mjs` now use this
lookup against the actual FName/hash registry in their original CameraPoint
cases. The occupied name is interned and its object inserted through the native
hash path before construction; a separate display-string array scan no longer
decides uniqueness. The focused lookup check covers hash order, class matching,
root-before-all-packages behavior, qualified/config names and partial resolution
failure without allocating unknown names.
