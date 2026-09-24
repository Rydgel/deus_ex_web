# Clip show-area requests

Contract recorded before translation from original Extension.dll SHA-256
93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
XClipWindow::ChildRequestedShowArea (0x1000c360–0x1000c521).

GetChildUnits uses the supplied source child, writing unit sizes+198/+19c.
Nonpositive/unordered units return immediately. The requested x/y receive
float32 +0.005; width/height receive float32 -0.01 (original constants at
5b14c/5b148). Start cells use float32(coordinate/unit), subtract retained 0.5,
then FISTP nearest-even signed32. End cells use appCeil of float32((coordinate
+extent)/unit). The requested span is signed32(end-start).

For each axis, compare visible count with requested span. If the request fits,
move forward when relative start exceeds visible-span, backward when negative.
For an oversized request the inequalities reverse: align its end when relative
start is below visible-span, or align its start when positive. Otherwise retain
the position. Every subtraction/addition is signed32. Finally call the recovered
SetChildPosition(col,row), preserving its raw-coordinate/pixel-clamp distinction.
No script callback or source-equality test occurs in this override.

The original appCeil executes in the oracle with its existing explicit MSVCRT
ceil bridge. Reference cases cover both axes, fractional units, negative and
oversized rectangles, already-visible targets, and actual Clip -> ScrollArea
feedback before host admission. Visual clipping/drawing is a separate boundary.

Eight full original show-area cases pass (87 combined movement/input/show-area
comparisons), including complete memory and nested SetChildPosition callbacks.
The host now dispatches Clip's override. After live thumb dragging, the Training
fixture requests its content origin and verifies both clip row and scrollbar
return to zero. Both bot integration routes and production build pass. The
existing bundle-size warning remains; no full sweep or visual claim is made.
