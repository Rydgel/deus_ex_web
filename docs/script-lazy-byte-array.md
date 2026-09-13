# Original lazy byte-array loading

Authority is installed Engine.dll SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`.
Thunk10301168 enters the generic lazy byte-array Load at1030cbb0. FSoundData
calls it from Load1036f088 and GetPeriod1036f7cc. Its embedded TArray begins
at+0c; retained archive and signed saved position are at+04/+08.

The complete normal body does the following:

1. Read signed position+08. If zero or negative, return without reading archive.
2. Read archive+04 and call its Tell virtual+28; save the result.
3. Reread archive and position, then Seek+34 to that position.
4. Reread archive and call the generic byte-array serializer103038b9 (body
   1030cca0) with archive and the embedded array.
5. Reread position and archive. Negate the current position with x86 signed
   32-bit wrap, store it to+08, and Seek that saved archive to the original Tell.

The sign records whether the lazy bytes have been loaded; the archive remains
attached. There is no automatic finally/rollback on a failed serializer.
The negative store occurs only after successful array serialization and before
restoring the reader position. Reentrant changes to the retained archive or
position are not hidden by caching the initial fields.

FSoundData.Load1036f040 saves `position > 0` before always calling that generic
body. If the saved predicate is false it returns without touching owner byte
count or duration. If true it calls GetPeriod, writes owner+4c, considers
USound.Audio10580d5c and GIsEditor (IAT10599c94), optionally converts WAV samples,
then copies array.Num to owner+48 and may call Audio virtual+68. These positive
Load branches still require their own concrete wave/audio services.

The positive-load branch with `USound.Audio == null` has a smaller complete
contract. GetPeriod10303bc5 returns first; the caller rounds that x87 result
to float32 at1036f0ef, rereads data.owner+18 and writes owner.durationCache+4c
at1036f104. The null global at1036f197 skips the audio-query virtual+80 and
sets neither conversion flag; the branch at1036f22c skips WAV conversion.
At1036f4c3 it reads the live array.Num, then rereads data.owner and writes
owner.serializedByteCount+48. It tests the Audio global again at1036f4de;
when still null, it skips the GIsEditor read and audio virtual+68. The
translation supports this path and the nonpositive early return. A reached
nonnull Audio value remains an explicit unsupported service boundary, after
any native writes that precede it.

The serializer helper10371140 calls FSoundData virtual Load at103711fe when
GLazyLoad is zero, then immediately seeks at1037120c. It performs no owner
byte-count store after the virtual call. Such a store in the enclosing adapter
would be wrong for an already loaded or unattached FSoundData.

The translation exposes canonical typed read/write plus Tell/Seek/array
serialization services. It establishes lazy-array order and signed position
mutation, not a complete package reader or audio backend.

## Generic byte-array serialization

Engine1030cca0 first reads array.Max and array.Num, then calls archive
CountBytes virtual+14 with `(Num, Max)`. It passes the address of the live
array.Num field to compact-index serialization through IAT10599b18; it does
not copy Num into a temporary before CountBytes. It next reads archive+0c.
On loading, it rereads array.Num, stores that value to array.Max, and calls
FArray.Realloc through IAT10599a20 with element size1. Finally it rereads
array.Num and array.Data and calls archive.Serialize virtual+04 with
`(Data, Num)`, returning the archive. These rereads matter if an archive or
allocation callback changes the array. The recovered normal path has no
additional owner byte-count write.

`scripts/validate-lazy-byte-array.mjs` executes the entire original generic
Load body with explicit archive/array services and compares its call/write
trace with the translation. It also executes full FSoundData.Load with a
negative position and the enclosing Sound serializer helper with a controlled
virtual Load. These prove the nonpositive no-write path and absence of an
extra owner byte-count store in the enclosing helper.

The focused Sound archive integration uses the original Switch4ClickOn
payload and composes the separately recovered constructor, helper10371140,
ULinkerLoad Attach, generic byte loading/serialization, Audio-null Sound.Load,
GetPeriod, and FSoundData destruction/Detach. One canonical archive identity
is retained throughout. The fixture supplies synchronous file bytes and
explicit allocator/compact-index/CountBytes services; it does not claim Core
package construction, base UObject serialization, or a live audio subsystem.
For the selected complete array removal, native FArray.Remove takes its
Num0/Max0 shrink path; storage release is an explicit allocator service.

## `FSoundData.LoadSpecial`

The installed Engine export thunk `0x10303616` selects body `0x1036f700`.
Its normal path calls generic lazy-array Load (`0x10301168`, call at
`0x1036f72f`) on the unchanged receiver, then removes the exception frame and
returns at `0x1036f77d`. It performs no duration-cache or owner-byte-count
writes and does not query the audio subsystem. The exception reporting path
remains unsupported. `loadSoundDataSpecial` exposes that normal path using
the same archive services as `loadLazyByteArray`; conversation sound timing
uses this entry point.
