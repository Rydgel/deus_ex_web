# Input binding ConsoleCommand queries

The selected original call site is DeusEx.u HUDMultiSkills.RefreshKey: it scans
indices 0 through 254 with Player.ConsoleCommand("KEYNAME " $ i), then calls
KEYBINDING with each nonempty name and chooses the first binding equal to
BuySkills (case-insensitive). The default installation has no BuySkills binding,
so its original KeyNotBoundString is the expected outcome; returning invented
empty strings for all commands would conceal real input configuration.

Evidence recovered before the translation:

- Engine.dll UInput::Exec, thunk 0x1030178f/body 0x10393e10. KEYNAME branch
  0x1039409d–0x103940ca uses ParseCommand, appAtoi and virtual GetKeyName(+0x6c),
  then logs that string to the supplied output device. The literal is at
  0x1047f3b4. KEYBINDING branch 0x103940e8–0x10394130 calls FindKeyName(+0x70)
  and logs Bindings[index] (FString stride 12, data at object+0x2ac after the
  Exec subobject adjustment). Its literal is at 0x1047f398. A recognized query
  returns true even when its value is empty. Other console commands are outside
  this adapter and must return an unhandled result, not a fabricated answer.
- UInput::GetKeyName 0x10394b20 reads UInput+0xea4's UEnum Names at +0x34.
  Indices below zero or >=255 return empty. A name longer than three characters
  returns a pointer after its first three UTF-16 units; otherwise empty. The
  original table has 255 entries, and its index 0xef is spelled UK_Unknown10F:
  this blind skip is retained, including FindKeyName failing to reconstruct it.
  The enum itself is Engine.Actor.EInputKey from Engine.u, loaded with the
  existing native UEnum::Serialize port. No browser key table is substituted.
- UInput::FindKeyName 0x10394c40 builds IK_%s (literal 0x1047f4b8), constructs a
  find-only FName, then scans the original enum names for identity equality.
  It consumes the whole remainder, so trailing whitespace is not silently
  removed from a KEYBINDING key name. Original FName comparison is insensitive
  to ASCII case.
- Core ParseCommand 0x10147a20 skips only spaces/tabs before and after the
  keyword, compares case-insensitively, and rejects an ASCII letter/digit
  immediately after the keyword. Core appAtoi 0x101235b0 delegates to the
  shipped CRT _wtoi. This selected host supports in-range decimal int32 input;
  numeric overflow and non-ASCII command/name folding remain explicit bounds.
- APlayerPawn::execConsoleCommand 0x103ba200 initializes an empty result, does
  nothing without Player(+0x5d4), otherwise executes through Player's Exec
  interface into a string output device and copies its text back.

The input object is the selected Extension.InputExt. Its bindings and
`Aliases` load through the recovered constructor order: LoadConfig(1) on the
class defaults, then on the object. Each LoadConfig runs an Engine.Input pass
followed by an InputExt pass, reading GConfig's User file. ResetKeyboard's
ResetConfig re-runs both loads in place. Registration and ResetConfig
evidence is in [script-player-login.md](script-player-login.md#resetkeyboard-and-the-native-input-object).
Across all 255 keys, the installed bindings equal the earlier User.ini-then-
DefUser.ini scalar reader. A caller-supplied `config` replaces only the
Engine.Input binding reads; that is the RefreshKey fixture below. Console
writes and runtime rebinds remain outside this slice.

The string output device at Engine 0x10374500 appends each logged text directly
to its FString, without adding a newline. The adapter returns that text.

`createInputConsole(runtime,assets,{config?})` prepares the original enum,
the read-only binding strings and the 40 `Aliases`. Its
`playerConsoleCommand(call, commands)` returns `{handled,value}` for the
Engine.PlayerPawn.ConsoleCommand native. The `Aliases` come from GConfig
through the translated `UStructProperty::ImportText`.

Play passes the console-command chain, so every command runs through
`UWindowsViewport::Exec`, and KEYNAME/KEYBINDING are its `UInput::Exec`
step ([script-console-command.md](script-console-command.md)). Without the
chain, only these two queries are answered and anything else stays
unhandled. `execute(command)` exposes the same query leaf independently of
the PlayerPawn wrapper.

`validate-input-console.mjs` checks original binary branch/literal fingerprints,
the package enum's selected names and peculiar 0xef entry, parsed installation
config, query bounds, config fallback/empty overrides, then runs original
HUDMultiSkills.RefreshKey with a deterministic End/A BuySkills fixture. The
first original enum index must win. This caller requires the separately
recovered VM opcode 0x53 IntToString (the HUD work's conversion addition).
No native config writes or input command execution are claimed.

## Deferred multiplayer startup research

The single-player Training scope explicitly defers
DeusExRootWindow.ConditionalBindMultiplayerKeys. No implementation of that
routine, Core.Object.GetEnum, or SET InputExt is included in this query adapter.
The following recovered native evidence is retained for that future work;
it does not establish a complete SET contract.

- Original DeusExRootWindow.InitWindow calls ConditionalBindMultiplayerKeys.
  The routine scans all 255 key indices and returns when any binding equals
  Talk, TeamTalk, BuySkills, KillerProfile or ShowScores. Otherwise it tests
  whether T, Y, B, K and Equals are empty and issues five SET InputExt commands
  assigning those aliases. IsKeyAssigned obtains its key name with
  mid(string(GetEnum(enum'EInputKey',key)),3).
- Core.Object.GetEnum export thunk 0x10102194 leads to body 0x1013e9a0.
  It evaluates the object and integer arguments in order and initializes the
  result to FName index zero at 0x1013ea12. Null objects return that None name.
  For a nonnull object, it walks Class(+0x24), then Super(+0x28), looking for
  Core.Enum's static class 0x1029d6d0. A wrong class also returns None. Negative
  indices and indices at or above UEnum.Names.Num(+0x38) return None; valid
  indices read the FName DWORD at Names.Data(+0x34)+index*4
  (0x1013eaa0–0x1013eaa6). This is generic enum access, not an input-specific
  name table.
- UObject.StaticExec thunk 0x101011a9 leads to body 0x10153110. Its SET branch
  at 0x101532da–0x10153386 parses the class and property tokens with ParseToken
  (maximum 256, escape handling enabled), resolves a UClass with
  StaticFindObject and the property with FindField, skips spaces before the
  remaining value, then invokes GlobalSetProperty with propagation enabled.
  The SET literal at 0x101aea50 was verified in the original Core.dll.
- GlobalSetProperty thunk 0x10102e64 leads to body 0x101523a0. With propagation
  enabled it visits live objects whose class chain includes the target class,
  calls the property's ImportText virtual(+0x84) with port flags 1 and the
  object's property address (0x10152463), then invokes object virtual+0x40
  (0x10152474; the exact callback behavior remains unresolved here). It also
  imports the value into Class.Defaults.Data(+0x4d4) at the property's offset
  (0x101524ca), then calls the defaults object's SaveConfig(0x4000,null) at
  0x10152505. Native SET therefore has persistence and instance/default
  propagation semantics beyond changing one query binding map.

The selected unquoted FString ImportText behavior, inherited InputExt property
schema, object callback effects, and config-save behavior still need recovery
and validation before this branch can be implemented. A future browser config
sink must state its persistence contract; it must not silently write the
original installation's INI files or claim a transient map alone reproduces
the native operation. This research uses the same original Core.dll fingerprint
as the query validator; no original binaries or extracted source are committed.
