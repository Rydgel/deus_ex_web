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

## ConditionalBindMultiplayerKeys and SET InputExt (2026-09-26)

DeusExRootWindow.InitWindow runs the original ConditionalBindMultiplayerKeys
(the host no-op is gone). It scans the 255 KEYNAME/KEYBINDING pairs, returns if
any binding is Talk, TeamTalk, BuySkills, KillerProfile or ShowScores, tests
that T, Y, B, K and Equals are free through IsKeyAssigned (Core.Object.GetEnum
body 0x1013e9a0), and issues five `SET InputExt <key> <alias>` commands. With
the installed User.ini all five keys are free, so Training starts with them
bound, as the original does.

- `UObject::StaticExec` 0x10153110, SET branch 0x101532da-0x10153386:
  ParseToken(256, escapes) for the class, StaticFindObject(UClass,
  ANY_PACKAGE), ParseToken for the property, FindField 0x101011db, spaces (only
  0x20) skipped, then GlobalSetProperty(value, class, property, offset, 1). A
  missing class or property logs "Unrecognized class %s" / "Unrecognized
  property %s" (NAME_ExecWarning) into the command's output and returns 1.
  Only InputExt is implemented; SET of any other class is an explicit
  UnsupportedConsoleCommandError (script-console-command.mjs staticExec).
- `GlobalSetProperty` 0x101523a0: every live object whose class chain reaches
  the class (the viewport's one InputExt) imports the text (UStrProperty: the
  whole remaining text) and runs PostEditChange (Modify, a game no-op); then
  the class defaults import it and `SaveConfig(0x4000, null)` runs on them.
- `SaveConfig` on the InputExt defaults writes every config property to
  `[Extension.InputExt]` of User.ini (the object's own class path) in
  TFieldIterator order. StaticInitInput 0x103930c0 creates Aliases and then one
  string per named key ascending, and UStruct::AddCppProperty 0x10125fd0
  prepends, so the keys come first in descending order and Aliases[0..39]
  last. Each Alias exports through UStructProperty::ExportTextItem 0x10169710:
  every member (Data == Delta), `Command` first, the string quoted without
  escaping (UStrProperty 0x101678a0), the name bare:
  `(Command="Button bFire | Fire",Alias=Fire)`. Flush(0) keeps the text in the
  config cache's `written` map (docs/script-config.md: no persistence across
  page loads yet), and the reload re-reads the InputExt defaults.
- SET of `Aliases` (a fixed-array struct import) remains a boundary.

`scripts/validate-console-command.mjs` checks the five bindings in the live
input and its defaults, the written section, the Alias round trip, the two
warning lines and the unsupported-class boundary.
