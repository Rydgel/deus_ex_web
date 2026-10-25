# Promo video

A two-minute motion-graphics promo for the Deus Ex browser runtime, rendered from code: footage of Play recorded under a
virtual clock, the original/Play frame pairs of the Stage 4 acceptance work, animated evidence from this repository, and a
synthesized re-thinking of the game's main theme. Re-cut on 2026-10-25 (the first cut, 2026-09-27, predates Stages 3 to 6).

Output: `ad/out/deus-ex-browser-runtime.mp4` (1920×1080, 30 fps, H.264 + AAC). Captures, renders and generated audio stay
out of Git (`ad/.gitignore`); they contain original game content.

## Pipeline

```sh
node ad/scripts/facts.mjs                 # numbers and snippets -> ad/build/facts.json
node ad/scripts/capture-play.mjs intro    # 00_Intro in Play, then the logo map it travels to
node ad/scripts/capture-play.mjs island   # the dock, DL_StartGame, MeetPaul
node ad/scripts/capture-play.mjs fight    # the assault rifle against the NSF
node ad/scripts/capture-play.mjs gunther  # the cell button, the door, GuntherRescued
node ad/scripts/capture-play.mjs swim     # the bay off the dock (swm3's placement; not in the cut: black underwater at night)
node ad/scripts/capture-play.mjs training # Training: crowbar and crate, keypad, DataCube
node ad/scripts/prepare-assets.mjs        # graded pairs -> ad/build/assets/pairs, clip manifest -> ad/build/clips.json
node ad/scripts/music.mjs                 # soundtrack -> ad/build/music.wav, the theme's bars -> ad/build/score.json
node ad/scripts/render.mjs                # -> ad/out/deus-ex-browser-runtime.mp4
node ad/scripts/render.mjs --stills 12.5,45.6   # review frames -> ad/build/preview
```

Run one capture at a time next to other heavy work (16 GB machine). The renderer is `ad/src/` (canvas 2D + a Three.js
wireframe of Training's original BSP from `reports/00_Training/world.obj`); `ad/src/timeline.js` maps the theme's orders to
the promo's sections, and the picture cuts on the bars `music.mjs` writes to `ad/build/score.json` (run it before
rendering). `render.mjs` serves the repo read-only on 127.0.0.1, steps `window.__video.renderFrame(t)` in headless Chromium
(Metal ANGLE) and pipes frames to ffmpeg.

## Footage of Play

`play-lib.mjs` opens the page with `?sim=inline` (the simulation frame and the draw both run in the page's
requestAnimationFrame) and `?music=0` (Galaxy's headless mirror library, so no original music is recorded), and replaces
`requestAnimationFrame`/`performance.now` with a virtual clock: each 30 fps output frame is exactly two 1/60 s simulation
steps whatever the render speed (60 frames advance `LevelInfo.TimeSeconds` by exactly 2.000 s). The scenes are driven through
the player's own inputs (the belt keys, the fire and frob buttons, held movement keys); placements, view writes and `summon`
are harness steps through the viewer's probes, as in the Stage 5 census and `record-clip.mjs`. The game's HUD stays; the
viewer's web UI is hidden.

`00_Intro` is paced by its speech, so its shots are mapped from the captured frames, not from a real-time scout (the level
times differ). `record-clip.mjs` (real time, with sound, worker mode) remains for clips outside the promo.

The first cut's original-game capture tools (`original-game.mjs`, `capture-original.mjs`, `capture-intro.mjs`,
`shot-plan.mjs`, `tools/dxinput.c`) stay: the project's own capture scripts use them. This cut takes its original frames
from the acceptance captures instead.

## The frame pairs

`.work/acceptance/<map>/<name>-{original,play}.png` are the Stage 4 acceptance frames: the original under CrossOver or Wine
and Play from the same camera at the same held level time (docs/stage-4-exit-criteria.md, e.g. rows 4.1.1 and 4.2.1 to
4.2.4; the gate passed 70 of 70). Both hold the raw framebuffer; `prepare-assets.mjs` applies the original D3D gamma ramp
(Brightness 0.6 → exponent 1/1.5, docs/lighting.md) to both sides. The promo shows 8 of the 130 pairs (24 maps).

## Where the claims come from

Every number on screen is computed by `facts.mjs` or quoted from project docs:

- git history (commits, days, the per-day calendar) and code counts (`src/` JavaScript lines, tracked `*.rs` lines and
  crates, `scripts/validate-*`, `scripts/validate-native-*`, `docs/*.md`);
- `System/DeusEx.u`'s header; `DeusExMover.Frob` decoded with `src/unreal/bytecode.mjs`;
- `APawn::AICanHear` (Engine.dll `0x103c7680`) disassembled with `tools/disasm-body.py`, and its Rust port
  (`native/script-vm/src/aievent.rs` `can_hear`); "98 of 98 scenarios" is `validate-event-manager.mjs`'s 18 hand-written and
  80 seeded cases against the original body under Unicorn (docs/ai-event-manager.md "Verification");
- the Stage 3, 4 and 5 gates as README.md and docs/stage-*-exit-criteria.md record them;
- Stage 6's scoreboard read from `scripts/stage6-criteria.mjs` (rows passing, the missions whose chain passes, the endings, the
  conversation census rows; 1,627 conversations is the inventory's total, docs/stage-6-inventory.md);
- the acceptance captures counted from `.work/acceptance`;
- milestone dates checked against the first commit of each.

## Soundtrack

The Deus Ex main theme (`Title_Music`, by Alexander Brandon and Michiel van den Bos) re-thought as instrumental synth metal,
not a copy of it. `theme-score.mjs` reads the song from the local installation at build time (nothing of it is stored in this
repository; the module's audio is never played) and sequences the orders the promo uses (`ARRANGEMENT` in
`ad/src/timeline.js`) with the song's own speed and tempo changes. From it `music.mjs` takes:

- the harmony: each bar's root and chord, read from all of the song's parts;
- quoted lines: the "Deus Ex" lead melody (the groove's last bars, the breakdown, the bridge, the return), the build's
  descending line, and in the groove the theme's bass line, arpeggio and fourths stab, the bridge's sixteenth pulse and the
  later synth line, with the module's echo copies left out.

Everything else is the promo's own and synthesized from scratch, in the manner of synth metal (chiptune and analog synths played
as a metal band, no vocals): the riffs (gallop, straight sixteenths, half-time, tremolo) on overdriven, double-tracked saw
"guitars", the metal kit with double kick and tom fills, the square-wave arpeggios, the twin lead a diatonic third apart, the
dark analog intro with a slow chip arpeggio and the lead's motif foreshadowed, the power-chord hits on the section cuts and the
closing callback; about −13 LUFS. The sample tunings the quotes rely on were measured, not assumed: each sample's pitch class
at C-5 from a harmonic-product spectrum, confirmed by the consonance of the parts sounding together (the song sounds in A
minor; several samples are tuned off their written notes).

`music.mjs` also writes `ad/build/score.json`, the song's bar start times, which the picture cuts on (the intro's second
block is slower and ends on a ritardando, so bars are not all the same length). `MUSIC_DEBUG=1` prints per-section bus
levels and `MUSIC_STEMS=1` writes each bus to `ad/build/stems`. Sound effects are placed on the picture's cues.

The theme belongs to its composers and publisher: a published promo with this soundtrack, like the game footage in it,
needs their permission.
