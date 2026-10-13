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

The body's tail (Extension `0x1005022a..0x10050277`) loads pawn+0xac (XLevel),
tests it, loads +0x40 (Engine), tests it, loads +0x4c (Audio), tests it, and
only then pushes `(0, 0, Sound, Location, Volume, 100.0f, Pitch)` and calls
`[Audio vtable + 0x74]` (`UAudioSubsystem::PlaySound`, Galaxy's body
`0x10608100`, [galaxy-audio](galaxy-audio.md)); the result is dropped. The
call is made directly: no `ClientHearSound`, no viewport or `bDeleteMe` test,
no `CheckHearSound` range or occlusion test, no actor. Id 0 has slot bits 0,
so Galaxy gives it a counter id (`--counter << 4`); the channel has no actor
(Update keeps its Location, tests no occlusion and never applies a Doppler
shift), Radius 100, and its voice takes its pan from the position `Pawn.Location
+ XAxis` has in the listener's coordinates, which is how the body's pan
rotation (`pan * 16384` added to the pawn's ViewRotation yaw) reaches the mix.

The host records the computed request (`W.deferWindowSound`,
`windowHost.soundRequests`: window, root, pawn, Sound, requested volume,
position, pan, and every audio argument, plus `played`, Galaxy's result) and
then makes that call: `W.audioOf(pawn)` follows the same three pointers (a null
link skips the call, as in the original) and `windowPlaySound` calls
`Audio.playSound(None, 0, Sound, Location, Volume, 100, Pitch)` on the
translated subsystem Play links as `XLevel->Engine->Audio`
(`script-doors.mjs`, the one `execPlaySound`/`ClientHearSound` and
`execStopSound` use). `W.soundPawnFields(pawn)` supplies original Location and
ViewRotation as three-element arrays. The existing internal
`W.native.playSound(window,sound,volume,pitch)` service calls
`windowPlaySound(W,...)`; this also preserves the native centered position
defaults used by InvokeVisibilityChange. The VM uses
`dispatchWindowSoundNative(W,call)` to preserve optional argument evaluation
order. Requests retain window, root, selected pawn, original Sound identity,
requested volume/position, pan, and every final audio-call parameter.

## Play (2026-10-14)

Before this the request only reached `soundRequests`, so every menu click, HUD
log sound and inventory sound was silent. Now it plays through Galaxy's voices
like any other sound (mixed by the worklet in worker mode,
[galaxy-audio](galaxy-audio.md) "Effects through Galaxy's mixer"):

* `scripts/validate-window-sound-play.mjs` (Training, headless): reading
  DataCube0 runs `AddNote -> LogNoteAdded`; the window request and Galaxy's
  PlaySound call carry equal arguments (no actor, id 0, the sound, the pawn's
  Location plus a unit vector, Volume `.75 * 100/99` as float32, radius 100,
  Pitch 1), a channel takes counter id -16 with no actor, the next Update
  starts a voice for it, and a level with no Audio skips the call. It fails
  without the `audioOf` wiring.
* `scripts/validate-window-sound-browser.mjs` (headless Chromium, worker
  mode): F2, Alt+N and Tab on Training play `Menu_Activate`, `Menu_Focus`,
  `Menu_Press` and `Menu_Focus`; Galaxy holds them as channels with counter
  ids -16, -32, -48, -64 (radius 100, slot 0), the pointer position pans them
  (pan -0.51, -0.35), and the voice operations and their samples reach the
  worklet's library. The sound never crosses the page.

Unverified: the audible loudness against the original (the volume and pan laws
are Galaxy's, translated and bit-exact to Update; the mixer is the host's
mapping, [galaxy-audio](galaxy-audio.md)), and the channel ids of window
sounds in the original's own runs (they come from the same counter, which
depends on every earlier slot-0 sound).

`node scripts/validate-window-sound.mjs` passed 13 unchanged original exec/body
cases on 2026-09-23 and, with the audio-chain cases below, 16 on 2026-10-14. The oracle intercepts only parameter evaluation and the
final audio virtual call; original parent walking, volume/panning arithmetic,
Core coordinate rotation and native argument/default sequencing run unchanged.
Cases cover the HUD log's .75 volume, all omitted defaults, explicit pitch and
position, both pan clamps, hidden ancestry, mono sound, zero root width,
rendering-origin offsets, argument-induced window resizing, absent
root/pawn/sound, and a null XLevel, Engine or Audio link (the original makes no
audio call; the harness's pawn+0xac/+0x40/+0x4c chain is cut at each link). Final audio arguments and evaluated defaults compare by
float32 bits. Captures remain under ignored `.cache/window-sound/`.
