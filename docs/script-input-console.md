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

Configuration is read from the supplied installation files using the existing
case-insensitive scalar INI reader: User.ini, then DefUser.ini for absent keys.
AssetStore retains .ini file handles separately from package handles. The
input adapter reads Engine.Input bindings once at preparation; console writes,
runtime rebinds, array config and a complete native config cache remain outside
this read-only slice.

The string output device at Engine 0x10374500 appends each logged text directly
to its FString, without adding a newline. The adapter returns that text.

`createInputConsole(runtime,assets,{config?})` prepares the original enum and
read-only binding strings. Its `playerConsoleCommand(call)` returns
`{handled,value}` for the Engine.PlayerPawn.ConsoleCommand native; the host
continues normal native dispatch when `handled` is false. `execute(command)`
exposes the same query leaf independently of the PlayerPawn wrapper.

`validate-input-console.mjs` checks original binary branch/literal fingerprints,
the package enum's selected names and peculiar 0xef entry, parsed installation
config, query bounds, config fallback/empty overrides, then runs original
HUDMultiSkills.RefreshKey with a deterministic End/A BuySkills fixture. The
first original enum index must win. This caller requires the separately
recovered VM opcode 0x53 IntToString (the HUD work's conversion addition).
No native config writes or input command execution are claimed.
