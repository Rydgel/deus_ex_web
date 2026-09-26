# Cold DumpLocation construction research

Play runs this native during every DeusExGameInfo.Login (milestone C,
[player login](script-player-login.md)). The original execution oracle and
`scripts/validate-player-dump.mjs` pass. `dumpFileDirectory` is a VM
`array<string>` value ([property copy](script-property-copy.md#dynamic-tarray-copy)).
No empty-directory, default-config or null-object substitute is installed.

`ADeusExPlayer::execCreateDumpLocationObject` is DeusEx.dll `0x10014c30`.
It advances FFrame.Code by one, constructs NAME_None, gets the player's
**package Outer** through `GetOuter`, requests 0xa8 bytes through
UDumpLocation's operator new (`0x100134c0`), and calls constructor
`0x10014fb0` only when allocation is non-null. Null allocation returns null.
The StaticAllocateObject class is `0x1003b600`, flags=0, template=null.

The original constructor:

- Calls UObject construction, then initializes the FString members of
  currentDumpLocation at +0x34/+0x58/+0x64/+0x70. Its bool, location ID,
  vector and rotator template bytes survive.
- Initializes dumpFileDirectory's header at +0x7c, both indices +0x88/+0x8c
  to -1, currentUser's header at +0x90, dumpFile +0x9c to 0,
  dumpLocationCount +0xa0 to 0, and player +0xa4 to null.
- Installs vtable `0x10027f94` at `0x10015052`.
- At `0x10015058..0x1001507d` calls GConfig.GetString with section
  `DeusEx.DumpLocation`, key `CurrentUser`, buffer capacity 64, file
  `User.ini`; copies the result to currentUser. The supplied original SDK
  FConfigCacheIni.h GetString (lines 158–173) clears the output's first
  character before missing-file/section/key tests, then truncates successful
  values through appStrncpy. The existing ConfigCache returns null on a
  missing key, representing that failed lookup and empty output.
- Allocates 0x1220 scratch bytes at `0x100150ee..0x10015105`, storing the
  pointer at +0x28. Their initial contents are unspecified.
- Calls `0x10015200`: formats `*.DMP`, invokes GFileManager's FindFiles
  slot +0x28 with files=1/directories=0 at `0x100152b3`, and copies the
  returned FString array into dumpFileDirectory. It does **not** open or
  parse any DMP file in this constructor.

Core appInit `0x10149840` calls appBaseDir at `0x1014996d`, then
GFileManager.SetDefaultDirectory (slot +0x2c) at `0x1014997b`. Thus the cold
relative enumeration is in the executable's System directory. The original
SDK FFileManagerWindows.h FindFiles (325–361) preserves Windows enumeration
order and returns leaf names. The unfinished host adapter retains the
supplied AssetStore file catalog and exposes its directory enumeration as
a service. A missing catalog raises instead of implying an empty directory.
Catalog order is a host input; equivalence to Windows filesystem ordering
has not been established. The cold Login branch does not inspect those names.

`HasLocationBeenSaved` is `0x10016150`: zero EAX, copy global byte
`0x1003bb05` into AL, return. Exec native 3039 at `0x10016e40` advances
FFrame.Code and writes that result. The installed image's initial byte is
zero. This is process state, not object state or a config-derived flag.
SaveLocation/LoadLocation and persistence are outside this cold constructor
slice.

`UDumpLocation::Destroy` (`0x10015120`, vtable `0x10027f94` slot `+0x24`) is
implemented, because a Player start's collection reaches it for the retired
player's DumpLocation ([Player start collection](script-loadmap-gc.md)).
First `CloseDumpFile` (`0x100159d0`) closes a non-zero `dumpFile` (`+0x9c`),
then zeroes it, sets `currentDumpLocationIndex` (`+0x8c`) to -1 and zeroes
`dumpLocationCount` (`+0xa0`). Each `dumpFileDirectory` (`+0x7c`) FString is
emptied and destroyed, and the array's count and capacity are zeroed.
`player` (`+0xa4`) is zeroed, GMalloc frees the scratch block held in
`currentDumpFileLocation` (`+0x28`) and that slot is zeroed. `UObject::Destroy`
runs last. An open dump file stays an explicit boundary, because Play never
opens one.

`scripts/native-player-dump-oracle.py` loads hash-verified original Core,
Engine, DeusEx and MSVCRT images. It executes the original exec/constructor,
FString copying and saved-byte reader. UObject allocation, FMalloc,
GConfig.GetString and FindFiles are explicit service leaves with asserted
original call tuples. Cases include missing user/empty directory, Alice/two
filenames, an 80-character user truncated to 63/one filename, null UObject
allocation, and saved flag bytes 0/1/255. All run successfully. This verifies
the body against supplied service inputs, not an entire filesystem/config
bootstrap.

Files:

- `scripts/native-player-dump-oracle.py`: passing original execution cases.
- `src/runtime/script-player-dump.mjs`: the constructor and service
  translation. Play installs it before Login through `preparePlayerDumpStore`.
- `scripts/validate-player-dump.mjs`: direct constructor comparisons and
  reflected allocation. It plants its DMP fixture beside the catalog's
  DeusEx.u, the System directory the native enumerates.
- `src/unreal/assets.mjs`: retains sourceFiles for native enumeration.
