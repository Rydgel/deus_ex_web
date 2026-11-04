# Sound start latency (Stage 7, row 7.5.2)

Decision D6 of the [Stage 7 criteria](stage-7-exit-criteria.md): measure the original's latency under Wine first, then hold
Play to it. The time from a sound's PlaySound call to its first output sample must be at most the original's plus one browser
render quantum (128 frames, 2.9 ms at 44.1 kHz). Host measurement only: nothing here changes what Galaxy's translation computes.

## The chain

**Galaxy, in the original and in Play alike.** UGalaxyAudioSubsystem::PlaySound calls glxStartSample, which writes the voice under
the library lock ([effects](galaxy-music/effects.md) §2). The voice sounds from the next timer callback `0x106142a0`, every
Latency/2 = 20 ms ([audio output](audio-output-scope.md) §2.2). That callback renders bus B from head B, which the callback before
left at its play cursor plus D. D is 7,056 bytes (Latency 40) plus the DirectSound write cursor's lead, 1,764 bytes under Wine
(10 ms), so 8,820 bytes, 50 ms. So a start between callbacks k−1 and k begins 50 ms after the play cursor that callback k−1 read.
Play runs the same translated callback (oracle-checked, check 1 of row 4.3.7) every 882 frames of the worklet's consumption, with D
pinned to the measured 8,820.

**What the hosts add.**
* **The play cursor Galaxy reads.** Under Wine it is Wine's dsound mix position, which moves in whole periods: 1,764 bytes (10 ms)
  under Wine 11.20 on Linux, 2,048 bytes (11.6 ms) under the Mac's CrossOver. At a callback it leads the frame being taken by
  between 0 and one period, by the phase of Galaxy's 20 ms timer against Wine's mixer. In Play the cursor is the worklet's own
  consumption position, exact to the frame (row 4.3.7's decision 6 keeps Play's callback schedule as host timing).
* **When the host takes the bytes.** Wine's mixer takes a whole period at once. A browser renders a device callback's worth of
  128-frame quanta at once (about 10.7 ms here).
* **Play's transport.** The batch holding the start crosses a MessagePort from the simulation (the worker, or the page inline) to
  the audio thread. The original has no such step.
* **After the take**, each host's own buffering to the device: the browser's `AudioContext.outputLatency`, Wine's buffering to
  PulseAudio. These are reported, not bounded.

## What is measured

**The figure ("take")**, D6's "output" as the user chose to read it on 2026-11-04 (the alternative, the speaker, would need the
loopback below and would compare Wine's and the browsers' audio stacks more than Galaxy): from a start to the moment the host's audio path takes the voice's first frame out of Galaxy's buffer,
counting frames at the device's rate from the start of the block the host takes at once. In the original the first byte B always
begins a Wine period (Galaxy's heads move by the cursor's own steps), so the take time is the moment Wine's cursor moves past B. In
Play the first frame can sit anywhere in a rendered burst. The render call's own time would make a frame late in a burst look as
early as the burst's first frame, which the device plays one block later, so the burst's start plus the frame's offset in it is
used.

The other figures, for the diagnosis:
* `distance`: the buffer between the host's position at the start and the first frame;
* `hop`: Play's post-to-arrival time;
* `wall`: Play's render-call time.

## The original under Wine

**The tool.** `dx-live-win.exe galaxy latency <seconds> <interval_us> <out>` (read only, no debugger) reads three things every
250 µs and writes a line per change:
* Galaxy's heads (`0x10697cd0`);
* the 16 effect voices (`0x1068dca0 + 0xa0·slot`: Active `+0x0f`, StartTime `+0x08`, Mutex `+0x98`, SmpPtr `+0x46`);
* the first 0x100 bytes of the secondary buffer's object (`[0x10697cc8]`, Wine's dsound object).

`scripts/galaxy-output-capture.sh latency [out]` launches the game, opens 00_Training from the title map, and polls while the player
walks forward and back and jumps (footsteps and landings). Its options are `SECONDS_`, `INTERVAL_US` and `STEPS`.
`node scripts/audio-latency-original.mjs [--trace file]` reads the trace:
* **Wine's play cursor** is the buffer object's dword that equals A at every callback, `+0xb4` under Wine 11.20: 195 of the first
  200 callbacks, the other five read inside a callback.
* **Each real start** (StartTime or Active changing) is paired with the callback that first moves its SmpPtr. Starts that the same
  poll saw with that callback are skipped, since their order is unknown.
* **The placement** is confirmed when the first render is a whole callback's frames, as the next callback's.
* **Starts placed uniformly in time** over all callbacks give the distribution, since a game frame's PlaySound has no phase with
  Galaxy's timer.
* **The Mac's stored `galaxy poll` traces** (2026-10-16, CrossOver) are read as well. They have no Wine cursor: there the cursor
  between callbacks is the line between their A values.

**Linux, 60 s (2026-11-04, Wine 11.20; stored as `latency-training-60s.txt`).**
* D is 8,820, as on the Mac, and every callback advanced 3,528 bytes (two 10 ms periods).
* 33 real starts, 3 skipped. In 32 of the 33 the first render was a whole callback: the voice began at the earlier callback's B.
* **Take:** uniform starts median 43.3 ms, p95 52.7. The 33 real starts give median 44 ms, p95 52.5, which agrees.
* **The phase.** At each callback, Wine's cursor had last moved 3 to 9 ms before (mean 6.7 ms, drifting from 6.9 to 6.4 ms over
  the minute). So the cursor Galaxy read led the frame being taken by about 3.3 ms, and the voices began that much later than with an exact
  cursor. Take = 40 ms + the lead + the wait for Wine's next period. Were the phase spread evenly, the median would be about
  45 ms and the p95 about 55.5 ms. A minute catches one phase.

**Linux, 20 min (2026-11-04, Wine 11.20; `latency-training.txt`, the reference), with `SECONDS_=1200 STEPS=215`.**
* 60,000 callbacks, all 3,528 bytes apart; D 8,820. Wine's cursor at `+0xb4` at 200 of the first 200 callbacks.
* **The phase** swung between a minute's mean of 3.1 and 6.3 ms on a cycle of about ten minutes, twice in the trace, rather than
  sweeping the whole period. The trace therefore holds the original's own spread of phases.
* **109 real starts** (24 skipped for their order). In 100 the first render was a whole callback; the other nine had their second render
  shortened or a pitch change between the two.
* **Take, uniform starts:** median 45.62 ms, mean 45.58, p5 34.88, p95 56.12 (4.8 million starts).
* **Take, the 109 real starts:** median 45.99 ms, p95 53.29.

**The Mac (2026-10-16 polls, CrossOver).** D 8,820. The cursor moves in 2,048-byte steps, so R is 2,048, 4,096 or 6,144. Without
Wine's cursor the polls give only the distance with a linear cursor: median 40.8 to 40.9 ms. A latency capture there is needed for
the take.

## Play

The worklet (`galaxy-music-worklet.mjs`, "Start timing") records, for each batch holding an effect start:
* its arrival time;
* the frame consumed then;
* the frame where the next callback's render begins (head B before the callback);
* the render call that plays that frame, and the take time (the render burst's start plus the frame's offset in it).

The simulation's library proxy records each such batch's post time, and the page's `deusExViewer.audioLatency()` returns both
halves with the context's latencies. Worklets have no `performance` in Chromium or Firefox, so both sides use `Date.now()` (1 ms).

`node scripts/audio-latency.mjs [--browser chromium|firefox] [--seconds 60]` runs 00_Training with the same walk as the original's
capture, joins the halves by batch id and judges D6 against the stored trace.

## Results (Linux, 2026-11-04)

`audio-latency.mjs --seconds 120`, 00_Training, against the 20-minute trace. The worklet keeps the last 256 starts.

| | take median | take p95 | hop median | distance median | wall median | outputLatency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| The original, Wine 11.20 (uniform starts) | 45.62 ms | 56.12 ms | (none) | 40 ms | (the take) | not measured |
| Chromium 153, worker | 45.97 ms | 55.37 ms | 0 ms | 40.66 ms | 40 ms | 32 ms (baseLatency 10.7) |
| Firefox 155, inline | 44.97 ms | 55.69 ms | 5 ms | 39.84 ms | 40 ms | 42.3 ms |

**D6 passes in both:** the medians and p95s are within 0.4 ms of the original's, inside the allowance of 2.9 ms.

The two browsers reach the same take by different routes:
* **Chromium** applies a batch on arrival (`hop` 0 to 1 ms); the voice then waits for the next device callback.
* **Firefox** reads the worklet's messages once per render block (`hop` spread over 0 to 11 ms), then renders the block at once.

Neither `hop + distance` nor the render call's time sees both waits, which is why those figures differ between browsers and the take
does not. Play's cursor is exact, so its median sits at 40 ms plus the wait for the next block. The original's sits at 40 ms plus
the stepped cursor's lead plus the wait for Wine's next period. The two land within a millisecond of each other on this machine.

**The first measurements, kept for the record.**
* Against the 60-second trace (one phase, median 43.3 ms), both browsers missed by 0.3 ms at the median and 1 ms at the p95. That
  is why the reference is now 20 minutes.
* Judged by `hop + distance` (the first reading), Firefox failed by 3 ms and Chromium passed.

## Not done

* **The Mac**, the reference machine: neither the latency capture under CrossOver nor Play has run there. CrossOver's periods are
  2,048 bytes, so its figures differ from Linux's.
* **The hosts' output paths**: the browser's `outputLatency` (32 to 45 ms here), and Wine's buffering to PulseAudio, which is not
  measured. A loopback recording of both would be the route; it measures the hosts, not Galaxy.
* **Speech** is not measured: its start waits for the page's decode, and Galaxy's ring transport adds its own head start
  ([audio output](audio-output-scope.md) §3.2).
