# Native FlagBase ownership research (not implemented)

The existing `createFlagBase` Map is a value projection; it does not provide
native UObject ownership or hash nodes. This research establishes the missing
contract; it does not claim that live native FlagBase teardown is implemented.

Evidence: installed Extension.dll SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`,
`.cache/reference/Extension-annotated.asm`, and
`scripts/native-flagbase-oracle.py`. The oracle runs the original bodies with
only UObject constructor/Destroy/allocation and enum FName construction as
external leaves. It runs Core's original CRC initialization loop
`0x1014986b..0x101498aa`, rather than supplying a replacement CRC table.

## Allocation and construction

`XFlagBase::SetBool` (`0x10023c60`) calls CheckName then GetFlag(name,type=0).
An existing bool updates only bit zero of its word at `+0x40`. A missing bool
with bAdd allocates an actual registered Extension.FlagBool UObject:

- Native class `0x1009ccd8`, object size `0x44`.
- Outer = the FlagBase UObject; Name = None; object flags = 0; template = null.
- Operator new at `0x1001a4b0` calls Core.StaticAllocateObject.
- The executed constructor is XFlag at `0x10023750`, passed the FlagBase,
  requested FName, type zero, expiration zero. It calls UObject's constructor,
  installs XFlag vtable `0x1005bf2c`, calculates hash, initializes links and
  calls AddFlag. SetBool then installs FlagBool vtable `0x1005bf88` and writes
  the value's low bit. Do not substitute StaticConstructObject's ordinary
  default internal constructor for this argument-taking constructor.
- SetExpiration (`0x100238f0`) writes `+0x3c`; SetBool replaces -1 with the
  base's current defaultExpiration (`+0x128`).

Native XFlag fields: `+0x28` FName index, `+0x2c` hash, `+0x30` FlagBase pointer,
`+0x34` next pointer, `+0x38` byte type, `+0x3c` signed expiration. FlagBool adds
`+0x40` value word. Base has 64 bucket heads at `+0x28..+0x124` and signed
expiration at `+0x128`; its size is `0x12c`.

XFlagBase's constructor (`0x100239a0`) calls UObject's constructor, installs
vtable `0x1005c20c`, and writes defaultExpiration zero. It does not explicitly
zero bucket heads; their initialization belongs to allocation/default copying.

## Hash and ownership

XFlag constructor and FindName (`0x10024e60`) use the same ASCII-uppercase,
UTF-16-code-unit CRC already recovered as `hashScriptName`; bucket = hash & 63.
FindName compares full hash as a **signed** integer (JG), then exact FName
index and unsigned byte type, returning both matching object and a writable
bucket/predecessor-next link. The chain is not an insertion-order Map.

AddFlag (`0x10023b20`) does nothing for null or already-owned nodes. Otherwise
it removes a prior owner, finds the insertion link, deletes a distinct existing
same-name/type node via virtual slot +0xc with argument 1, retries, inserts at
the returned link and stores the owner pointer.

RemoveFlag (`0x10023a80`) checks matching ownership, calls FindFlag
(`0x10024f50`) to locate the exact node in its hash bucket, splices the next
pointer, then sets node.next and node.base to null. It does not destroy the
node, unregister it or change UObject.Outer.

XFlagBase::Destroy (`0x100239f0`) calls UObject::Destroy **first**, then visits
buckets 0 through 63 and repeatedly RemoveFlag(head) until empty. It does not
ConditionalDestroy or delete child flags. Those nodes remain registered with
their original Outer; subsequent UObject collection is a separate operation.
XFlag::Destroy (`0x10023870`) likewise calls UObject::Destroy first, then
RemoveFlag if its base pointer remains non-null.

CheckName (`0x10024d80`) scans `[A-Za-z0-9_]` and logs through GError on the first
other character. It does not sanitize the FName. Its diagnostic/error-device
semantics remain to be wired before supporting arbitrary invalid names.

The missing-flag/bAdd=false SetBool branch reaches SetExpiration with a null
receiver at `0x10023d20`. This conflicts with the current Map projection's
claimed safe false-return branch. That branch needs an explicit original
fault/reference case before changing its compatibility contract.

## Executed reference cases

The oracle passes on the installed DLLs. It creates 22 flags (Alpha, Beta,
Flag0..Flag19), including bucket collisions and both signs of full CRC hashes;
all 22 calls return 1. It updates Alpha with integer value 2 (stored low bit
becomes zero) and expiration 9, removes and re-adds Beta, and destroys the base.
Snapshots preserve all 64 bucket heads and every node's fields after each step.
Destruction emits only the base UObject.Destroy leaf; all node base/next fields
become null while name/hash/type/expiration/value remain intact.

No module implementation or runtime hookup has been added. A future bounded
implementation needs a linked/registered native Extension.FlagBool class,
StaticAllocateObject service, the constructors and hash/link operations above,
UObject.Destroy callback, and a real deleting-destructor callback for duplicate
AddFlag. The existing external entries/calls diagnostics can remain projections,
but must not become the authoritative native ownership store.
