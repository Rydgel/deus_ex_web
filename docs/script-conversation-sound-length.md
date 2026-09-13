# Original conversation sound length

ConSys.dll SHA-256
`f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa`
exports DConversation.GetSpeechLength at10010430 and GetSoundLength at10010460.
The native2056 wrapper10010980 evaluates one integer (initialized0), consumes
the end-arguments byte, calls GetSpeechLength, and stores its x87 result as
float32. GetSpeechLength returns constant0 from10013df4 for soundID==-1.
Otherwise it calls GetSpeechAudio10010210, returning0 for a null result or
forwarding the sound to GetSoundLength. GetSpeechAudio's normal lookup and
temporary FString ownership have a separate
[contract and comparison](script-conversation-speech-audio.md).

GetSoundLength starts with a zero local return value. A null sound returns0
without loading or logging. A non-null sound calls the imported FSoundData.LoadSpecial
through IAT1001315c on sound+28, then reads array.Data at sound+34. It does
not read USound.durationCache or call FSoundData.GetPeriod.

If Data is non-null, imported strncmp at10013184 compares its first4 bytes with
the byte string RIFF at1001dc04. Equality reads unsigned data+28 (WAV data
chunk size at fixed byte40), converts it as a positive64-bit integer, and
divides by signed data+1c (fixed byte28). This branch does not validate WAVE,
scan chunks, or verify PCM. Invalid native memory reads remain unsupported.

On a non-RIFF buffer, it reads the first little-endian DWORD. MPEG recognition
requires byte0==ff and `(header & e000)==e000`. The initial bitrate-table column
is0. With version bits1800, layer bits600/400/200 select columns0/1/2.
With version bits1000 or0, layer600 selects3 and layer400 or200 selects4.
Other bit combinations retain column0. The row is `(header >>>20)&15`.
The 16-by-5 DWORD table begins at1001d9d0; its first and last rows contain
ffffffff, not zero. The numerator is signed32(array.Num <<3), from sound+38.
The denominator is signed32(table[row*5+column]*1000), matching three LEA
multiplies by5 followed by SHL3. x87 performs signed integer division. The
native does not reject the sentinel bitrate, so it can return a negative
duration; no invented zero/positive clamp is allowed.

A null Data pointer or an unrecognized non-RIFF header calls the imported
warning logger (IAT10013108, output device global IAT1001310c) and returns0.
There is no warning on a null sound. Loading occurs before Data/count reads,
so the reader must observe the post-load array.

The host translation rounds the final native2056 value to float32. Its explicit
load, field-reader and warning services retain these boundaries. This native
conversation timing routine is separate from the generic WAV period reader;
neither is a substitute for the other.

Shared `ScriptRuntime` native2056 dispatch now uses these bodies. Sound ID `-1`
returns0 without requiring audio services. Other IDs require explicit
`conversationLifecycle.audio.getSpeechAudio`, with typed `read`,
`loadSpecial`, and `log` services when reached. The Play host does not yet bind
GetSpeechAudio's loader/ownership graph.

`scripts/validate-conversation-sound-length.mjs` compares the unchanged native
GetSoundLength/GetSpeechLength, LoadSpecial and generic lazy Load bodies with
the translation using already-loaded sound storage. Cases cover original
Switch4ClickOn, the five MPEG table columns and a sentinel row, null sound/data,
invalid headers, and the speech-ID lookup branches. The full 80-entry bitrate
table is compared directly. A separate caller trampoline stores the returned
x87 value as float32; neither timing body is patched. The CRT comparison,
logger and GetSpeechAudio are explicit leaf services. A prepared original
Conversation.GetSpeechLength declaration also reaches shared2056 dispatch and
matches the native switch result; missing lookup services fail explicitly.

The actual Training `DL_Start` path is now a reference case: Conversation57
(export1926) has audioPackageName `Mission00`, event32934 refers to ConSpeech
export32839, whose soundID is79. `DeusExConAudioMission00` Sound export81,
`ConAudioMission00_79`, starts at4109855 with serialSize43065. Its native lazy
payload is43056 MP3 bytes. Original GetSpeechLength returns float32
`7.176000118255615`; the translation matches. The validator follows those
authored references and supplies the same compressed bytes directly to timing.

## `GetSpeechAudio` source trace

The disassembly of `0x10010210` identifies the next loading dependency; it is
not implemented by this timing module. Sound ID `-1` returns null. Otherwise
the body reads Conversation.Outer at `+0x18`, resolves its Name (`+0x20`)
through GNames, copies it to a local TCHAR buffer and removes a trailing
case-insensitive `Text` when present. Two imported FString formatting calls
produce `ConAudio%s_%d` from the current audioPackageName and ID, and
`..\\System\\%sAudio%s.u` from the trimmed Outer name and a fresh read of
audioPackageName. The FString field is at Conversation `+0x64`, with Num at
`+0x68`; Num0 selects the zero-filled empty TCHAR at `0x1001e1cc`.

At `0x10010322` it calls imported StaticLoadObject with USound class, Outer0,
the generated object name, the generated filename, flags2 and sandbox0.
It then destroys both temporary FString arrays before returning the saved
sound pointer. The two cleanup sequences include Num/Max zeroing,
element-size2 reallocation and removal; the first invokes imported array
destruction, while the second ends with an explicit allocator virtual `+0x08`
when Data remains non-null. The normal temporary ownership path is now compared
in the separate speech-audio validator. Filename lookup can select an existing
package/linker; complete first-load construction still requires its own graph.
Returning a prepared audio object solely by its generated name would not
establish this loader/ownership behavior.
