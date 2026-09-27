# ComputerWindow playback contract (batch 5)

Source: installed Extension.dll SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.
The following contract was recovered from the exported bodies before the
native host implementation. Local disassembly is kept outside Git in
`.cache/research/computer-batch5*.asm`.

* VisibilityChanged `1000ee70`: dispatch the script visibility event; showing
  sets flags `+190 & 4` unless ComputerStart has already been invoked (`8`).
* Tick `1000f7b0`: ignore-tick (`+214 & 8`) returns first; first-tick (`+190 &
  10`) clears that bit and returns. Unless ignore-game-pause (`+214 & 20`),
  read Player.Level.Pauser: entry into pause sets bits `14` and returns;
  leaving pause clears those bits. Pending ComputerStart clears bit 4 and
  sets bit 8 before bubbling the event through parents until handled.
  Game pause returns. Cursor countdown runs next. Unless processing is paused
  (`+214 & 4`), timeCurrent advances by delta*throttle; if its unrounded x87
  difference from timeLastEvent exceeds eventTimeInterval, timeNextEvent
  becomes the unrounded current plus interval. Then process queued events,
  decrement/clamp fadeOutTimer, and bubble completion to all parents. Finally
  decrement/clamp every display record's fade timer if fadeSpeed is positive.
* ProcessQueuedBuffer `1000fe20`: consume only events with time strictly less
  than timeCurrent. Type 0 displays a character; 1 changes fontColor; 2 changes
  textSound; 3 changes textX/textY; 4 newline; 5 graphic; 6 clear display; 7
  sound; 8 is a no-op; 9/10 input; 11 starts fade. Advance queuedBufferStart
  for each consumed event. Remove exactly 4096 leading records only when the
  start index equals 4096 at function exit (not on every queue exhaustion).
* Character position `10010710`: suppress leading spaces with word wrap;
  scan forward through type-0 unpositioned nonspace events to decide whether a
  whole word fits. Restore the scan index. A wrap resets X, increments Y,
  scrolls if Y equals row count, sets last-line-wrapped, and suppresses a
  wrapping space. Native's non-word-wrapped edge test is X+1 == cols.
  Explicitly positioned events bypass the automatic position path and retain
  the caller's zero-initialized output coordinates.
* Scroll `1000eaf0`: traverse display records backwards; decrement type-0 Y
  (`+14`) or type-5 Y (`+10`), removing negative rows.
* Draw `1000ed60`: script DrawWindow, GC style 3, six optional background
  icons at (0/256/512,0/256), then DrawDisplayBuffer `1000fae0`.
  Set both fonts to textFont. Type-0 records draw one UTF-16 character within
  the fixed cell, with their packed color at unaligned `+a`. Fade-out takes
  priority over per-character fade-in; RGB components use x87 division and
  multiplication followed by `_ftol`, preserving alpha. Type-5 records draw
  icons. The masked cursor draws only when its input window is not effectively
  visible, cursorVisible and showCursor are set, and cursorTexture exists.
* CleanUp `1000d6d0` / FreeQueuedBuffer `1000d780`: set ignore-tick, clear
  waiting-for-key, free input-event allocations, empty queue and display.

Native Init's class globals identify **Window** (`100ae5b8`) and EditWindow
(`1009ae18`), not a TextWindow subclass. Its Player `+a8` is Actor.Level and
the string at `+4e0` is LevelInfo.Pauser, correcting the earlier preview's
viewport-name interpretation. SetInsertionPointBlinkRate `1001d960` writes
its arguments to EditWindow `+23c/+240` (initial delay/period).

Input queue execution (9/10), graphic positioning when consuming type 5, and
ComputerWindow key handling remain explicit boundaries outside the reached
HUDInfoLinkDisplay contract. Existing graphic display records can be drawn.
This does not claim terminal interaction is complete.

Validation: `scripts/validate-window-computer-playback.mjs` runs 28 original
DLL cases under the RSS watchdog. JavaScript receives the exact initial heap
image and compares every byte after execution plus ordered script/GC calls.
Cases cover first/ignored ticks, pause entry/exit, start-event bubbling,
extended-precision clock comparison, strict event timing, leading spaces,
word wrapping, scrolling, explicit positions, color/newline/clear/fade events,
fade-in/fade-out RGB conversion, six backgrounds, cursor placement and cleanup.
The original GC bodies are already validated independently; this comparison
checks their invocation boundary without replacing the ComputerWindow body.
Init/configuration methods retain their existing original DLL suite.
