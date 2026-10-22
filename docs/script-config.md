# GConfig, LoadConfig and SaveConfig — 2026-09-25

The census stopped the Goals screen's close on `SaveConfig` (536).
`PersonaScreenGoals.DestroyWindow` copies its two toggles to the player, then
calls `player.SaveConfig()`. A faithful `SaveConfig` ends by reloading class
defaults from the config files. The config store and `LoadConfig` therefore
came with it. `LoadConfig` also runs whenever a class loads.

## Sources

| Piece | Retail body | Translation |
| --- | --- | --- |
| `FConfigCacheIni` (GConfig) | `DeusEx.exe`: the SDK's inline `FConfigCacheIni.h`, built unoptimized; `SetString` at `0x10918030` checked branch by branch | `src/runtime/config-cache.mjs` |
| `ReadToken` and six `ImportText`/`ExportTextItem` pairs | Core `0x10164cb0`; bool/int/float/byte/name/string, addresses in the module header | `src/runtime/config-text.mjs` |
| `UObject::LoadConfig` | Core `0x10150d60` (thunk `0x101023dd`) | `src/runtime/script-config.mjs` |
| `UObject::SaveConfig` | Core `0x10151540` (thunk `0x101031d4`); `execSaveConfig` `0x1013e6e0` | same, plus `ScriptRuntime.saveObjectConfig` |
| `UProperty::ExportText` | Core `0x10165440` | exports whenever `Data == Delta`, which is `SaveConfig`'s case |

`LoadConfig` callers in Core are:
- `UClass::Serialize` (`0x1012829a`), on the class default object after its tagged defaults;
- `UClass::Register` (native classes);
- `StaticAllocateObject` (`0x10157f39`), for `CLASS_PerObjectConfig` objects only;
- `ResetConfig`;
- `SaveConfig`'s reload.

## GConfig

The cache maps each file to its sections, and each section to a multimap of
key/value strings. Every key compare is case-insensitive.
- `Find` returns the newest pair under a key; iteration follows insertion.
- `Read` splits on CR/LF, recognises `[Section]` lines, splits `Key=Value` at
  the first `=`, and strips one pair of quotes from the value.
- `Find(Filename)` appends `.ini` unless one of the last five characters starts an
  extension, and maps `User.ini`/`System.ini` to `User.ini`/`DeusEx.ini`.
- `SetString`:
  - a missing key is added and marks the file dirty;
  - a value that differs only in case is left alone;
  - any other value is replaced, and `Dirty` becomes whether it also differs
    case-sensitively (checked in the launcher).
- `Flush` writes each dirty file as `[Section]\r\n` plus `Key=Value\r\n` lines
  and a blank line.

The browser cannot write the System directory. The written text is kept in
`ConfigCache.written`, and a later `Find` reads it instead of the installed
file. `onWrite(name, text)` hands each written file to the config store, which keeps it in the
browser across map loads and page loads ([configuration persistence](config-persistence.md)).

## LoadConfig(Propagate, Class, Filename)

1. `Class` defaults to the object's class. The call returns unless that class
   has `CLASS_Config` (`0x4`).
2. `Propagate` first recurses into the superclass.
3. **Per-object config.** It applies when the object's class has
   `CLASS_PerObjectConfig` (`0x400`, from `test ah,4` on `+0x484`) and
   `Index != -1`. The section is then the object's name, and the file its
   Outer's name. That case is an explicit boundary here.
4. **File.** Otherwise the file is the object's class `ClassConfigName`
   (`+0x4a0`).
5. **Section.** The section is `GetOwnerClass()` for `CPF_GlobalConfig`
   (`0x40000`), otherwise `Class`, as a `Package.Class` path.
6. **Properties.** Each property with `CPF_Config` (`0x4000`) in
   `TFieldIterator(Class)` order is imported:
   - own `Children` first, then each superclass;
   - the key is `Name`, or `Name[i]` for a fixed array;
   - a key that is found runs `ImportText(Value, Data, 0)`.

Dynamic arrays and maps re-fill from every value under the key once their
section exists. Both are explicit boundaries until reached.

## SaveConfig(Flags, Filename)

1. **Export.** Every property whose flags contain `Flags` (`CPF_Config`) is
   exported through `ExportText` into `SetString`. It uses the same
   section/file rules, with the object's own class for non-global properties.
2. **Flush.** `GConfig->Flush(0)` writes the dirty files.
3. **Reload.** It walks up to the topmost ancestor that still has
   `CLASS_Config`. For every loaded `UClass` under it, it runs `LoadConfig(1)`
   on the class default object. Instances keep their values.

The runtime reloads each linked class under that root. It then re-reads that
class's config properties from the native Defaults block into its VM
defaults.

## Property text

| Type | Import (port flags 0) | Export (port flags 0) |
| --- | --- | --- |
| bool | `ReadToken`; `1`/`True` set the bit and `0`/`False` clear it, case-insensitive; anything else fails | `True` / `False` |
| int | `appAtoi` only when the text starts with `-` or a digit; never fails | `%i` |
| float | `appAtof`, stored through `fst`; skips to `,` `)` CR LF; never fails | `%f` of the widened double |
| byte | enum: a `ReadToken` name matched in the enum, else a leading digit; plain: a leading digit or failure | enum name or `%i` |
| name | `ReadToken`; `FName(token, FNAME_Add)`, empty is `None` | the name |
| string | the whole remaining text | the text, unquoted |

`%f` is the system `msvcrt.dll`'s formatting. It produces 17 significant
digits, then rounds that digit string half up to six decimals. This matches
any correct CRT except at a 17-digit tie, and Windows versions may differ
there. Config values such as `3.000000` and `0.250000` are not near one.
Non-finite floats remain a boundary.

## Play integration

- **Bound on first load.** `ScriptClassLoader.prepareConfig()` reads
  `assets.configFiles` once, before the first class load, and binds the cache
  to the load graph. From then on, `UClass::Serialize`'s existing `loadConfig`
  slot imports the installed values into each class's Defaults block. A
  subclass copies its parent's config-loaded defaults before its own delta, as
  the original does.
- **Defaults now follow the installed `User.ini`.** For example
  `bHUDShowAllAugs=True` (compiled default False) and `bAlwaysRun=True`.
  `GivePlayerAugmentation` now calls `AddAugmentationDisplay` for each new
  augmentation, as the original does with this `User.ini`. That function is
  now prepared at player startup.
- **Native 536** runs `ScriptRuntime.saveObjectConfig`.

`scripts/validate-script-config.mjs` checks this in Play:
- class defaults take the `.ini` values;
- closing the Goals screen after a toggle writes `User.ini`;
- all 25 installed `[DeusEx.DeusExPlayer]` lines come back unchanged, with
  new keys after them;
- `bDisplayCompletedGoals` is saved and reloaded into the class default.

`test/script-config.test.mjs` covers the cache rules, `ReadToken`, each text
body, section selection, `Propagate`, and `SaveConfig`'s output.

Not covered:
- the viewer's separate `ClassDefaults` values used for map-actor and
  movement-port hosts, which still carry compiled defaults;
- `LoadLocalized`;
- per-object config;
- config dynamic arrays and maps;
- object and class imports.
