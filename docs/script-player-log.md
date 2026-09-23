# Original player log storage

`DeusExRootWindow.ClientMessage` calls `DeusExPlayer.AddLog(msg)` before
`hud.msgLog.AddLog`. The installed AddLog body calls native3010
CreateLogObject, runs DeusExLog.SetLogText, appends through LastLog.next (or
FirstLog when empty), assigns LastLog, and returns the new object. DeusExLog is
a native Object class with String text and DeusExLog next; SetLogText is a
single script assignment. These original script bodies own the list.

DeusEx.dll SHA256
`b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04`:

- execCreateLogObject 0x10014760–0x100147af consumes the no-argument terminator,
  creates NAME_None, obtains the player's **Outer** through UObject.GetOuter,
  and calls UDeusExLog.operator new(size=0x38, outer, name=None, flags=0).
- operator new 0x1000db10–0x1000db3a passes the native DeusExLog UClass
  0x1003a5d8, that Outer, name, flags, null template, GError, and null to
  StaticAllocateObject. It does not call StaticConstructObject.
- With a nonnull allocation, constructor 0x1000dc40–0x1000dc53 calls the
  original UObject constructor and stores vtable 0x10027ad0. It does not write
  text or next, whose values therefore remain the copied class defaults.
  A null allocation is returned as null without invoking the constructor.

The JS binding reuses the existing verified fresh allocation/registry/template
path, followed by the two recovered vtable stores. It binds native3010 only for
the live player. ClearLog's native751 CriticalDelete and the complete derived
FString destruction remain outside this slice; the map-reset adapter clears
player list references, with native final collection still an explicit gap.

`validate-player-log.mjs` runs the hash-verified unchanged native exec/operator
new/constructor with explicit FName, Outer and StaticAllocateObject leaves.
Both nonnull/null allocation branches match; the two vtable writes and untouched
text/next bytes are checked. The integration then executes original AddLog twice
and checks text, linked-list identities, package Outer, class/vtable, and reset
references. Native allocator failure behavior remains supplied by the existing
fresh-allocation host; the oracle's null branch does not imply browser OOM parity.
