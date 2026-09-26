# Original player log storage

`DeusExRootWindow.ClientMessage` calls `DeusExPlayer.AddLog(msg)` before
`hud.msgLog.AddLog`. The installed AddLog body calls native3010
CreateLogObject, runs DeusExLog.SetLogText, appends through LastLog.next (or
FirstLog when empty), assigns LastLog, and returns the new object. DeusExLog is
a native Object class with String text and DeusExLog next; SetLogText is a
single script assignment. These original script bodies own the list.

Enabling the original ClientMessage path also prepares Core.Object.Sprintf's
installed bytecode (Object.uc:340–390). Localized pickup/key messages use its
four optional coerce-string arguments, percent substitutions and `%%` branch;
the host does not format those messages itself. The item-pickup validator
exercises those original callers with the native HUD enabled.

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
the live player. DeusExLog's Destroy (vtable `0x10027ad0` slot `+0x24`) is
the `UObject::Destroy` thunk `0x1001aec0`. ClearLog's native751 CriticalDelete
and the complete derived FString destruction remain outside this slice. On
Player start, `ADeusExPlayer::Destroy` nulls `FirstLog`/`LastLog` on the
retired player, and LoadMap's collection releases the detached logs
([Player start collection](script-loadmap-gc.md)).

`validate-player-log.mjs` runs the hash-verified unchanged native exec/operator
new/constructor with explicit FName, Outer and StaticAllocateObject leaves.
Both nonnull/null allocation branches match; the two vtable writes and untouched
text/next bytes are checked. The integration then executes original AddLog twice
and checks text, linked-list identities, package Outer and class/vtable. Native allocator failure behavior remains supplied by the existing
fresh-allocation host; the oracle's null branch does not imply browser OOM parity.
