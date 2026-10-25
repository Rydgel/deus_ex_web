# Core FName table release and reuse

This contract is recovered from the hash-verified GOTY `Core.dll` in
`.cache/research/Core.asm`. It covers the mutable name-table path needed by
the Stage 3 garbage collector. The reflected name serializers and native
startup registration remain separate callers.

`FName::DeleteEntry` is the Core thunk at `0x10102680`; it jumps to body
`0x1014e0b0` and receives a name-table index. The original tables are:

| Original address | Table | Host representation |
| --- | --- | --- |
| `0x102961f0` | `GNames` data pointer | `names[]`, retaining null holes |
| `0x102961f4` | `GNames` count | `nameCount` |
| `0x102961f8` | `GNames` capacity | `nameCapacity` |
| `0x102961e0` | `GNameAvail` data pointer | `freeIndices[]`, used as a stack |
| `0x102961e4` | `GNameAvail` count | `freeIndices.length` |
| `0x102961e8` | `GNameAvail` capacity | `freeNameCapacity` |
| `0x102961fc` | 4096 hash bucket heads | `buckets[0x1000]` |

Each native `FNameEntry` begins with four fields used by this path:

| Offset | Meaning | Host field |
| ---: | --- | --- |
| `+0x00` | stable name index | `entry.index` |
| `+0x04` | entry flags | `entry.flags` |
| `+0x08` | next entry in a hash bucket | `entry.hashNext` |
| `+0x0c` | null-terminated UTF-16 text | `entry.text` |

The constructor's length/copy helpers are native wide-string operations:
`appStrlen` stops at the first UTF-16 NUL and `appStrcpy` copies that
terminated prefix. The adapter applies the same rule at every name boundary,
so an input containing a NUL after `Door` interns the spelling `Door` and
never retains the suffix.

`src/runtime/script-names.mjs` exposes `createScriptNames`, which keeps these
arrays live and returns `deleteEntry(index)`, `find(text)`, and the optional
`intern(text, findType)` path. The caller supplies `allocator.free(entry)` for
the native `GMalloc` virtual `+0x08` operation; the default entry allocator is
a plain host record because JavaScript owns the table storage.

## DeleteEntry order

The body first loads `GNames[index]`. A null entry is an assertion failure.
It also asserts when the entry has flag `0x04000000`; this is the native or
hardcoded-name protection used by the GC native gate. The host rejects that
case before mutation so a missing native-class gate cannot free a protected
entry silently.

The body hashes the text stored in the entry, masks the result with `0xfff`,
and walks that bucket's singly linked chain by `+0x08` until it finds the
same entry pointer. It patches the bucket head or predecessor link to the
entry's saved next pointer. The order after unlinking is fixed:

1. Call `GMalloc` virtual slot `+0x08` on the entry.
2. Store null in `GNames[index]`.
3. Append `index` to the end of `GNameAvail`.

The name count and the GNames array length do not shrink. Reuse therefore
takes the last free index first. If an index is not found in its computed
bucket, the original diagnostic path logs and then relies on the native chain
invariant; the host throws before mutating the table so the broken state is
visible.

The free-array growth calculation at `0x1014e1f1–0x1014e203` is

```text
newCapacity = newCount + floor(3 * newCount / 8) + 0x20
```

The exact reuse call is `FArray::Remove(lastIndex,1,4)`, whose generic body is
`0x101454f0`. After the removal it considers shrinking when
`3 * newCount < 2 * oldCapacity`; it then requires at least `0x4000` excess
bytes (`4 * (oldCapacity - newCount)`) and either more than `0x40` spare
elements or an empty result. When those conditions hold, the native capacity
becomes `newCount`; otherwise it remains unchanged. The JavaScript adapter
records this logical capacity while using the live array's normal storage.

## Hash contract

Core initializes the 256-entry CRC table at `0x10149840`. Each entry starts at
`index << 24` and performs eight left shifts, XORing `0x04c11db7` when the
high bit was set. The FName hash loop in `FName::FName` body `0x1014b950` and
`DeleteEntry` body `0x1014e0b0` then use that table in the following order for
each UTF-16 code unit:

1. Convert only ASCII `a`–`z` to uppercase.
2. Update with the low byte: `hash = (hash >>> 8) ^ table[(hash ^ low) & 0xff]`.
3. Update with the high byte using the same rule.
4. Mask the final state with `0xfff` for the bucket.

This is the observed name-table hash. It is distinct from the left-shifting
`appStrCrc` update in the same Core image, even though both use the initialized
table.

## Interning and index reuse

The `FName(const TCHAR*,EFindName)` body at `0x1014b950` computes the same
bucket, compares text with case-insensitive `appStricmp` (`0x1010239c`), and
returns an existing entry's index without mutation. An empty string writes
index zero. A find-only mode writes index zero when no entry exists.

For an add mode, the body pops the last `GNameAvail` index and removes that
last FArray element with `FArray::Remove(index,1,4)`, including the conditional
capacity policy above. If no reusable index is available, it appends at the
old GNames count, increments the count, and grows the array with the same
capacity formula. It then calls
`AllocateNameEntry` (`0x10101d52` → body `0x1014e430`) with the text, index,
flags, and old bucket head. The allocator size is `2 * strlen(text) + 0x0e`
bytes, and the helper stores the four native fields above. The new entry is
installed as the bucket head and GNames slot. Numeric find mode `2` ORs
`0x04000000` into a newly allocated entry's flags; when a case-insensitive
match already exists, the constructor returns that entry immediately and does
not change its flags, even when the request used mode `2`. The normal add mode
leaves new-entry flags clear.

The existing-name comparison calls `appStricmp` thunk `0x1010239c`, whose body
`0x10123560` forwards to MSVCRT `_wcsicmp` through IAT `0x102ab4c8`. The
original process uses the C locale for this path, so the adapter's verified
folding is ASCII `a`–`z` to `A`–`Z`, applied to UTF-16 code units. Locale
dependent non-ASCII equivalence has not been established and is explicitly
outside this host adapter.

The adapter returns `{index,name,entry,created}` from `intern`, which lets the
object-construction boundary retain both the resolved FName index and its
canonical spelling. The GC should call `deleteEntry` only after its native
flag gate has excluded `0x04000000` entries.

`FName::StaticInit` (`0x1014bbc0`) hardcodes `None` as entry 0 with flags
`0x04000400` (`0x1014bc26..0x1014bc3d`) and the following hardcoded entries
with `0x04000000`. Play's live name table (`prepareLiveActorSpawnWorld`)
seeds its `None` entry with those flags. Every Player start's LoadMap
collection runs PurgeGarbage's name pass over the table, so the unique names
of the released objects are deleted and their indices reused
([Player start collection](script-loadmap-gc.md)). The table's GMalloc free is
a host no-op, because the entry record is released with its GNames slot.

## Spelling across levels

GNames belongs to the process, so a name's text is the spelling of whichever
caller entered it first since the last collection that deleted it. Play builds
a new FName table (above) for every level, so the spelling across levels is
modeled separately, by `NameSpelling` (`src/unreal/name-spelling.mjs`), which
the `AssetStore` owns and which therefore lives as long as the page's session
or a chain run. It found its rule on mission 10's chain: the original's flag
store has `DL_EverettContact_Played` and `DL_EverettMaze_Played` (the flag
dumps of `.work/chains/m10`, g10 to g12, Linux host), although the Chateau map
spells the DataLinkTriggers' tags `DL_everettcontact` and `DL_everettmaze` and
its name table holds `DL_everettcontact_played`. DeusExConText spells
`DL_EverettContact`, `DL_EverettMaze` and `DL_EverettContact_Played`.

The rule, from Core.dll and the original's engine logs:

1. A linker enters its package's names when it is created. `GetPackageLinker`
   (`0x10154530`) allocates the `ULinkerLoad` with
   `new(GetTransientPackage(), NAME_None, 0)` (`0x1015486d..0x101548a6`), so
   a linker carries no root flag. Its constructor (body `0x10160000`) builds
   the load-context mask at `+0xa0` from `GIsEditor` (`0x101e5544`, `0x40000`),
   `GIsClient` (`0x101e5548`, `0x10000`) and `GIsServer` (`0x101e554c`,
   `0x20000`), which is `0x30000` in the game. The name loop at
   `0x101604f9..0x101605db` then reads each `FNameEntry` and, when
   `flags & mask` is nonzero, makes `FName(text, FNAME_Add)` (`0x10160553`).
   Otherwise it stores `NAME_None`. A map's editor-only names (`0x40010`:
   `CsgOper`, `PolyFlags`, `bAdmin`, ...) are never entered.
2. Only the collector deletes a name. Core has one call of
   `FName::DeleteEntry`, at `0x1015844c` in PurgeGarbage's name pass
   (`0x10158409..0x10158455`). The pass deletes an entry that has `0x2` set
   and lacks `0x04000000`. Unloading a linker deletes no name. The engine log's
   `Unloading: Package 10_Paris_Metro`, written by `DeleteSaveGameFiles`'s
   `ResetLoaders` before the next `LoadMap`, leaves the Metro's names in the
   table.
3. LoadMap loads the new map before its collection
   ([LoadMap](script-loadmap-gc.md): the load, then the collection at
   `0x1038d0ee..0x1038d1e1`). The new map's names therefore enter while
   everything the previous level entered is still in GNames: its map, the
   DeusExConText its start loaded, and the names its scripts made.
4. The collection keeps what is reached. `UObject::Serialize` (`0x10150210`)
   marks an object's `_Linker` (`+0x10`) for an archive that is neither
   loading nor saving (`0x1015028c..0x1015029e`). `ULinker::Serialize`
   (`0x1011df90`) marks its whole `NameMap` (`+0x6c`, `0x1011e00c`), its
   `LinkerRoot` and the export and import names. The new level's objects came
   from the new map's linker, so every name of the map survives with the
   spelling that step 3 gave it. DeusExConText's linker is not reached, and
   the collection unloads it.
5. The level's start loads DeusExConText again, through ConBindEvents'
   `StaticLoadObject` ([the wrapper](script-conversation-wrapper.md)). Its
   names find the surviving entries.

The original's mission 10 log measures this order at every travel of the
chain. At the Metro to Chateau leg it reads `Unloading: Package 10_Paris_Metro`,
`LoadMap: 10_Paris_Chateau`, `Loading: Package 10_Paris_Chateau`,
`Collecting garbage`, `Unloading: Package DeusExConText`, `Garbage: objects:
50843->36394`, `Loading: Package DeusExConText` and then `Login: Player`
(`.work/travel/chain-m10/final.log` on the Linux host, lines 363 to 396). The
Mac's `.work/travel/chain-mc03-hq-line/final.log` shows the same order for HQ
to Island.

On mission 10 the Chateau's `DL_everettcontact` and `DL_everettcontact_played`
therefore become the Metro's DeusExConText entries. The Conversation's
`conName` is `DL_EverettContact`. `StringToName(conName $ "_Played")` finds
`DL_EverettContact_Played`, and `DL_EverettMaze_Played` is a new name made
from `DL_EverettMaze`. Mission 0's chain is the case without a previous
level. DX, mission -2, loads no ConversationList, so Training's
`dl_bodyexit` is entered before DeusExConText's `DL_bodyexit`, and the flag is
`dl_bodyexit_Played`, as measured. Mission 12's chain is a third case. Its
log loads `12_Vandenberg_cmd` and then travels to `12_vandenberg_computer`,
which spells `Heliosborn` and `DL_Heliosborn`. The original's flag dumps
(m12-6 and m12-7) hold `HeliosBorn` and `DL_HeliosBorn_Played`, which are
DeusExConText's spellings.

Play applies the rule at these places:

| Original | Play |
| --- | --- |
| the startup's linkers | `AssetStore`'s first package load: `addBoot` for DeusEx, Core, Engine, Extension, ConSys; never collected |
| LoadMap: the map's names enter, then the collection | `createGame` (`src/viewer/game.mjs`): `beginLevel(map)` keeps only the startup packages' names and the map's |
| ConBindEvents' StaticLoadObject | `ScriptRuntime.prepareConversations`: `enterPackage(DeusExConText)` before any of its objects is read |
| `FName(text, FNAME_Add)` of a runtime string | `intern`: StringToName (native 1024, mode 1) and `UNameProperty::ImportText` of a travel text (`travel-import.mjs`: the arrival's flag names) |
| a Name read through a linker's name map | `spell` (a lookup): `objects.mjs` `readObject`'s Name values |

The cache's first parse of a map no longer begins a level, so a map read early
(a destination looked up during a level) changes no spelling. The startup loads
15 more packages than the five Play enters (docs/original-startup-log.md).
None of them is the first to enter a name that DeusExConText or one of the 88
maps spells differently, so they decide no spelling Play reads.

Checks: `test/name-spelling.test.mjs` (synthetic packages: a new process, a
travel, the collection, the load-context gate) and
`scripts/validate-name-spelling.mjs` (the shipped packages through the
`AssetStore` and `readObject`). The validator plays the chain's six Paris maps
in one store, then the same Chateau in a new one, then mission 0 and mission
12's travel. It also checks the startup packages' spellings. End to end,
`chain-play.mjs --mission 10` (Linux host, 2026-10-25) now writes
`DL_EverettContact_Played` and `DL_EverettMaze_Played`. Its 13 snapshots hold
the original's flag names with the same spelling in every case. The one
difference is that `DL_metrosewer_Played` is missing at g3, which is timing,
not spelling.

Not modeled, and so unverified where they would matter:

* A name that an object surviving a collection holds (the root set's objects:
  native classes' defaults, the engine, client and console objects). Play
  collects every runtime name at each LoadMap.
* The other packages a level loads: the map's texture, sound and music
  packages, the conversation audio (`DeusExConAudio*`), `InfoPortraits` and
  `DXFonts`. Their names never enter Play's table.
* The startup's `Entry` and `DX` maps, which every original process loads
  before its first level. A Play session that opens a level directly skips
  them. They spell `Light1` where 17 maps spell `light1`.
* A Player start's collection (LoadMap of the loaded map). Play keeps its
  table through it.
* A level restored from a `.dxs` file carries the spellings of the process
  that saved it. A chain that starts from a slot inherits them, but mission 10
  does not depend on that: the Catacombs and the Metro hold no `DL_Everett*`
  name. `beginLevel` enters the `.dxs` file's names
  (`restore-asset.mjs` parses it outside the store). `readObject` reads that
  package's Name values with the file's own spelling, not through `spell`.
  The two differ only for a name that the previous level entered first with
  another spelling. Exit slots pinned by an earlier Play carry its old
  spellings in their FlagBase until they are pinned again.

## Validation and boundaries

`test/script-names.test.mjs` exercises the recovered hash bucket, unlink and
allocator order, null slot, NUL-terminated text, LIFO free-index reuse,
existing-name mode-2 flag stability, and case-insensitive lookup with a compact
fixture. The module does not implement startup hardcoded-name registration,
reflected serializers, locale changes, or arbitrary malformed native entries;
those callers must provide the original table records and allocator service.
