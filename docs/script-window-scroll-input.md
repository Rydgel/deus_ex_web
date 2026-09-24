# Scale mouse and repeat input

Contract recorded before translation from hash-pinned Extension.dll
93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c.

MouseButtonPressed (3fdc0), MouseMoved (40030), MouseButtonReleased (40150)
call their script event first; key parameters use a byte in script but the full
integer controls native left-button (1) matching. Press within the half-open
thumb rectangle starts dragging (flag+258 bit0), snapshots position+1f0 and
stores along-axis grab offset+25c. Range-mode clicks outside the thumb set repeat
direction+260 (2 before, 1 after), page once, play sound and seed countdown+264
from GetTickOffset+delay+1e8; nonpositive uses interval+1ec, then disables repeat
if still nonpositive. Value-mode clicks start dragging and jump via PixelToTick,
using notify=0. MouseMoved subtracts grab offset only in range mode, changes
position with notify=0, and plays movement sound only if the final position
changed. Release of button1 broadcasts notify=1 and plays click sound only when
a drag changed from its starting position; it then clears repeat and drag flags.
Other buttons preserve the script result. Left press/release return true.

PixelToTick (3eb10) uses count-span and end-start+1-thumb extent in range mode,
count-1 and end-start otherwise, clamps denominator to >=1 (including unordered),
and applies the original _ftol to retained ((pixel-start)*count/length)+0.5.
PlayScaleSound (3e9c0) calls Window.PlaySound with the float32 center of the thumb.

Tick (40250) has no base/script Tick call. Active repeat subtracts delta, stores
float32 but compares the retained x87 result with zero; only a negative/unordered
result proceeds. It reads local cursor position, checks half-open window bounds,
then pages if the cursor is beyond the thumb in the stored direction. The
horizontal forward test uses thumb **height** (+21c), as the native instructions
do. It plays click sound only if position changed. It adds one interval (not a
catch-up loop) and replaces a still-negative/unordered countdown with float32
0.05 (0x3d4ccccd). Zero is retained. Callbacks may mutate the fields read later.

GetCursorPos (4cbf0) obtains the root, copies root cursor +590/+594, then
subtracts this window's clip origin+d4/+d8 at float32 stores. No root preserves
the caller's outputs; a repeating detached Scale lacks defined cursor inputs
and remains an explicit host boundary.

Original full input-body reference cases will compare complete images, ordered
script/sound/cursor services and returns before host admission. Tick offset,
cursor retrieval and Window.PlaySound are explicit leaves. Drawing, root mouse
button routing and actual audio playback remain separate boundaries.

## Verified integration

38 new full original-body cases (79 combined movement/input comparisons) cover
both orientations, half-open thumb bounds, full-width key gates, dragging in
range/value modes, changed/unchanged release, repeat direction, cursor bounds,
zero/negative countdown, interval fallback and native cursor-coordinate reads.
Complete object images, ordered script/sound services and returns match. Two
repeat cases execute original GetCursorPos/GetRootCursorPos instead of the cursor
service. Window.PlaySound and tick-offset time remain explicit services.

All four Scale virtuals now dispatch in the live host. The Training fixture
presses inside the constructed thumb, drags through range/clip feedback and
releases, verifying synchronized row/tick and cleared drag/repeat flags. Both
bot integration routes and build pass. Draw, full root button routing and final
audio rendering remain separate boundaries; no visual equivalence is claimed.
