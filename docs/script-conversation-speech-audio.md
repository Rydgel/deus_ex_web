# Original conversation speech-audio lookup

Authority is installed ConSys.dll SHA-256
`f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa`.
The unchanged `DConversation::GetSpeechAudio` body at `0x10010210` is executed
by `scripts/native-conversation-speech-audio-oracle.py`. Its name/filename
contract and source field offsets are recorded in
[speech timing](script-conversation-sound-length.md).

The ordinary reference has Outer.Name `DeusExConText`, audioPackageName
`Mission00` and soundID123. The body copies the name, measures13 TCHARs,
compares the last4 with `Text`, and truncates that suffix. Its two static
FString.Printf calls receive a hidden output-array pointer as the first stack
argument; ECX is not part of that cdecl input contract. Results are
`ConAudioMission00_123` and `..\\System\\DeusExConAudioMission00.u`.
The body reads filename Num/Data, then object-name Num/Data, then passes
USound class, Outer0, object name, filename, flags2 and sandbox0 to
StaticLoadObject. The audioPackageName field is read separately for each format.

The normal return releases filename storage before object-name storage:

1. Write filename Num0 then Max0; call original Core FArray.Realloc
   `0x10145440` with elementSize2. It calls the allocator with bytes0 and
   tag`0x101ab50c`, then stores the returned Data pointer.
2. Call original FArray.Remove `0x101454f0` with `(0,currentNum,2)`.
   The reference's Num0 case returns without writes.
3. Call original FArray destructor `0x10107200`. It frees non-null Data,
   then writes Data0, Max0 and Num0 in that order.
4. Write object-name Num0 then Max0; call the same Realloc and Remove bodies.
   The caller then directly frees a remaining non-null Data pointer, without
   zeroing this second array header.

The native probe supplies an explicit allocator that retains its old pointer
for zero-size reallocation, making both subsequent Free calls observable.
That allocator choice is a service fixture, not a claim about every native
allocator. Formatting, CRT strings and StaticLoadObject are explicit leaves;
Core array bodies and the enclosing ConSys method run unchanged. SoundID-1
returns null before any field/string/loading service.

`conversationSpeechAudio` translates this normal path with explicit typed
read/write, string-copy/comparison, formatted-array, StaticLoadObject and array
storage services. It preserves the two owning temporary arrays and their
cleanup order. Native assertion recovery, exception unwinding, malformed
buffers, and complete first-load Sound construction remain unsupported.

`scripts/validate-conversation-speech-audio.mjs` compares generated arguments,
normal return and the complete captured array-write/release trace. It also
checks the service-free `-1` return. This establishes the normal lookup and
temporary ownership boundary; it does not establish live UI or audio playback.

Shared native2055 now calls this translation; native2056 also uses it when
`conversationLifecycle.audio.speechLookup` supplies its explicit services.
The existing whole-GetSpeechAudio callback remains an explicit 2056 fixture
boundary when this service graph is absent. The focused comparator also calls
the prepared original Conversation.GetSpeechAudio declaration through shared
2055, reading typed Conversation fields and comparing the same cleanup trace.

The combined `scripts/validate-conversation-audio-integration.mjs` case uses
actual DL_Start Conversation57 and `ConAudioMission00_79`. Shared2056 calls
the recovered lookup, the simple-name/filename StaticLoadObject route,
existing package/linker/export lookup, FSoundData.LoadSpecial and retained
archive byte loading before returning the native reference duration
`7.176000118255615`. It verifies both temporary-string releases, the original
reader cursor, retained archive identity, negative lazy-load position and
final byte-storage detachment/release. USound uses its canonical native
resource descriptor; it has no script-class export in Engine.u. The initialized
package, file-search, allocator and formatting services are fixture boundaries.
This does not establish first-load Core construction, PostLoad/GC or live UI.
