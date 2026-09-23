# Window.PlaySound native 1473

Original GOTY Extension.dll SHA256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`:
exec body 0x10053820, registration 0x10053920, five-argument body 0x10050050.
Exec evaluates Sound, volume (default -1), pitch (default 1), posX (float32
of Window.Width * double .5), posY (Height * double .5), then consumes the
terminator. Defaults are established immediately before each argument, so
earlier argument effects can affect the later dimension reads.

The native substitutes Window+0x114 when volume equals -1 (or is unordered),
then resolves root and pawn, in that order; absent root/pawn/sound returns.
When every ancestor including this window has visibility bit1 and root+0x5c0
bit1 is set, it converts posX into root coordinates using the stored rendering
origins: float32(posX + window+0xd4 - root+0xd4). Pan is the float32 store of
`clamp(2*x/max(root.width,1)-1,-1,1)` with the original x87 compare branches.
Otherwise pan is zero. posY is evaluated and passed but is not used by this
body's panning call (its transformed Y output pointer is null).

The body stores volume * (100/(100-1)) as float32. It copies the pawn's
ViewRotation (+0x3dc), adds `_ftol(pan*16384)` to yaw with int32 wrap, forces
pitch to zero, and transforms GMath.UnitCoords by Core FCoords::operator/=.
The sound location is Pawn.Location (+0x114) plus the resulting XAxis times 1,
with the original float32 stores. It follows pawn+0xac -> +0x40 -> +0x4c
and, if all pointers exist, calls audio vtable+0x74 with
`(nullActor, id0, sound, location, adjustedVolume, radius100, pitch)`.

The host records that exact computed request through
`W.deferWindowSound(request)` as an explicit deferred audio
boundary; it does not create audible playback or claim an audio subsystem is
bound. `W.soundPawnFields(pawn)` supplies original Location and ViewRotation
as three-element arrays. Audio-device availability is deferred to the host.
The existing internal `W.native.playSound(window,sound,volume,pitch)` service
should call `windowPlaySound(W,...)`; this also preserves the native centered
position defaults used by InvokeVisibilityChange. The VM uses
`dispatchWindowSoundNative(W,call)` to preserve optional argument evaluation
order. Requests retain window, root, selected pawn, original Sound identity,
requested volume/position, pan, and every final audio-call parameter.

`node scripts/validate-window-sound.mjs` passed 13 unchanged original exec/body
cases on 2026-09-23. The oracle intercepts only parameter evaluation and the
final audio virtual call; original parent walking, volume/panning arithmetic,
Core coordinate rotation and native argument/default sequencing run unchanged.
Cases cover the HUD log's .75 volume, all omitted defaults, explicit pitch and
position, both pan clamps, hidden ancestry, mono sound, zero root width,
rendering-origin offsets, argument-induced window resizing, and absent
root/pawn/sound. Final audio arguments and evaluated defaults compare by
float32 bits. Captures remain under ignored `.cache/window-sound/`.
