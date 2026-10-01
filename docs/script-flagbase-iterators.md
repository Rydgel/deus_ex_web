# FlagBase iterators and DeleteAllFlags

`00_Intro` and the `99_Endgame` maps start a new game's flags:
`MissionIntro.InitStateMachine` / `MissionEndgame.InitStateMachine` call
`flags.DeleteAllFlags()` (native 1130), and `DeusExRootWindow.ResetFlags`
walks every flag with `CreateIterator` / `GetNextFlag` / `DestroyIterator`
(1126, 1128, 1129), deleting the previous flag at each step unless its name
contains `SKTemp_`. The bodies are in Extension.dll
(`93c35502…`), on top of the table described in
[native FlagBase research](script-native-flagbase-research.md).

| Native | Exec | Body | Behaviour |
| --- | --- | --- | --- |
| 1126 `CreateIterator(optional EFlagType)` | `0x10025e20` | `0x10024bb0` | default type 7 (`P_GET_BYTE_OPTX`); `GMalloc` 12 bytes `{type, current = NULL, bucket = -1}`; the address is the script's int |
| 1127 `GetNextFlagName(int, out name)` | `0x10025e90` | `0x10024c50` | as 1128 with no type pointer |
| 1128 `GetNextFlag(int, out name, out EFlagType)` | `0x10025f40` | `0x10024c50` | see below |
| 1129 `DestroyIterator(int)` | `0x10026050` | `0x10024d00` | `GMalloc->Free` when non-null |
| 1130 `DeleteAllFlags()` | `0x100260c0` | `0x10024900` | for buckets 0..63, delete the head (deleting destructor, vtable `+0xc`) until the bucket is empty |

`GetNextFlag` (`0x10024c50`, `this` the FlagBase, `(iterator, FName*, BYTE*)`):
starting from `current->next` (or nothing for a fresh iterator), it scans the
current chain, then each following bucket's chain up to bucket 63, for the
first flag whose type equals the iterator's (a type `< 0` or `>= 7` matches
every flag). It stores that flag and its bucket back into the iterator and
returns 1 with the flag's name and type. Exhausted, it stores `NULL` and bucket
64 and returns 0 with `None` and type 0; a null iterator gives the same
without touching anything. The out name and type arrive through GPropAddr
(a non-lvalue gets the exec's stack temporary).

The order is the table's. `FindName` (`0x10024e60`) hashes the FName text
with Core's ASCII-uppercase CRC (`hashScriptName`), uses `hash & 63` as the
bucket and walks the chain while `node.hash <= hash` (signed `jg`), and on an
equal hash and name while `node.type < type`; `AddFlag` (`0x10023b20`) links a
new flag at that point. Each chain is therefore ascending by signed hash, a
new flag after equal-hash flags of other names, and a flag deleted and added
again takes its sorted place again. A flag's deleting destructor
(`0x1001a6e0`) runs `ConditionalDestroy`, whose `XFlag::Destroy`
(`0x10023870`) unlinks it with `RemoveFlag`; ResetFlags never deletes the
iterator's current flag, only the previous one.

`createFlagBase` (`script-triggers.mjs`) keeps its value-only entries (only
bools exist in it) and derives the chain order from them: entries keep
insertion order and a stable sort by signed hash per bucket is each chain.
The iterator's address is replaced by a counter, which scripts only pass back.
A `GetNextFlag` after its current flag was deleted would read freed memory in
the original; the store throws instead.

## Validation

`scripts/native-flagbase-iterator-oracle.py` builds a 24-flag table with the
original `SetBool`/`AddFlag` (bucket collisions included) and runs the five
bodies, with `GMalloc`, `UObject::Destroy`, `~UObject` and `operator delete`
as leaves and `ConditionalDestroy` dispatching once to the original
`XFlag::Destroy`. `scripts/validate-flagbase-iterators.mjs` runs the same
sequence on `createFlagBase`: a full walk (and one call past the end), type 0
and type 1 walks, a delete and re-add, ResetFlags' deletion walk (the two
`SKTemp_` flags survive) and DeleteAllFlags. All equal.
