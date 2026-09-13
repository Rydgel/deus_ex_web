# Original speech-event actor binding

Authority is the installed ConSys.dll SHA-256
`f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa`.
DConEventSpeech::BindActor is exported at `1000b070` and returns at
`1000b170` or `1000b17c`. Arguments are invokeActor, candidateActor and
Conversation; this body does not read the third argument.

For the speaker, it reads the event's FString at +44 (Num at +48), then the
candidate's BindName at +2ac (Num at +2b0), using the static empty string when
Num is zero. It calls imported appStricmp at IAT100130d0. Equality writes
candidate to event+40 and sets its local return bool. If names differ, it
compares actor identities: only invokeActor==candidate permits a second check
against candidate.BarkBindName at +2b8 (Num +2bc). That check rereads the event
name and uses the same appStricmp operation before the same speaker write.

It then repeats those gates for speakingToName at +54 (Num +58), writing
candidate to speakingTo at +50. A successful second match returns true;
otherwise it returns the speaker's match bool. Failed matches preserve the
existing actor references; this body does not clear them first. The separate
ClearBindActors body at `1000b180` clears speaker+40 then speakingTo+50.

The translation reads/writes canonical typed properties through explicit
services. String comparisons use the already recovered null-terminated,
ASCII-folded C-locale appStricmp boundary. It does not substitute BindName for
BarkBindName or treat an invoking actor as an unconditional speaker override.
The native probe executes the full binding/clearing bodies with the CRT string
comparison import supplied as an explicit service, checking matches, misses,
invoker-only bark aliases, retained references and both writes.

## Concrete event dispatch

The installed `DConEventEnd` vtable at `10013aac` stores `10002350` in its
BindActor slot +58. That complete inherited base body is `xor al,al; ret 0xc`:
it returns false without reading its receiver or three arguments. The shared
runtime therefore dispatches exact `ConSys.ConEventSpeech` to the recovered
speech body and exact `ConSys.ConEventEnd` to false. Animation and Trade use
their separately recovered [shared binding body](script-conversation-action-bind.md).
Other concrete event classes remain unsupported until their slot targets are verified.
