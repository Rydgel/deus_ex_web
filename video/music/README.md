# The video's score

An original piece (A minor, 116 BPM, 76 bars, about 2:43) rendered from code. `score.mjs` is the composition and its
orchestration, section by section, against the film's planned scenes. It quotes one thing: the four-bar opening phrase of
the Deus Ex main theme, once, in the scene with JC Denton, read at render time from the local game files
(`theme-quote.mjs`); the notes are not stored here.

```sh
node video/music/render.mjs --label "draft 3"
```

writes `video/out/music/`: `score.wav` (48 kHz, 24-bit, -14 LUFS), `score.mp3`, `preview.html` (a listening page with
the sections on a timeline), `score.json` (bars, sections and cue times for the picture), `drafts/<label>.mp3`. Nothing
is played while rendering. A first run takes about 80 s (the tuning pass), later ones about 25 s.

| File | What it does |
| --- | --- |
| `score.mjs` | Harmony, melodies, the arrangement; which instrument plays what |
| `synth.mjs` | The synthesized voices (pad, lead, bass, arpeggio, low drums, effects), reverb, delay, meters, limiter |
| `sampler.mjs` | Sampled parts: notes to MIDI, rendered to files by `sfizz_render` (SFZ) or `fluidsynth` (soundfont), cached |
| `retune.mjs` | Measures every sample of an orchestra patch and writes a tuned copy of the patch |
| `render.mjs` | Mix table (levels as loudness targets, sends), mastering, meters, output files |
| `theme-quote.mjs` | Reads the quoted phrase from `Music/Title_Music.umx` |
| `preview.mjs` | The listening page |

## What it needs

Arch packages: `fluidsynth soundfont-fluid sfizz-standalone` (and `ffmpeg`, `node`).

Sample libraries, unpacked under `video/samples/` (ignored by Git, about 1.9 GB unpacked):

| Library | Used for | File | Unpack to |
| --- | --- | --- | --- |
| Virtual Playing Orchestra 3.2, wave files | strings, horns, choir, harp, celesta, vibraphone, timpani, concert snare and bass drum, cymbals, gong, chimes | `Virtual-Playing-Orchestra3-2-wave-files.zip` (616 MB), https://archive.org/download/virtual-playing-orchestra-3-2-wave-files/ (linked from http://virtualplaying.com/virtual-playing-orchestra/) | `video/samples/vpo/` |
| Virtual Playing Orchestra 3.3, Standard scripts | the SFZ patches for the above | `Virtual-Playing-Orchestra3-3-standard-scripts.zip` (0.5 MB), https://virtualplaying.com/vp-downloads/ | `video/samples/vpo/` (same folder) |
| Salamander Grand Piano V3, 44.1 kHz 16-bit | piano | `SalamanderGrandPianoV3+20161209_44khz16bit.tar.xz` (394 MB), https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/ | `video/samples/salamander/` |

The electric piano and the drum kit come from the General MIDI soundfont (`/usr/share/soundfonts/FluidR3_GM.sf2`).

## Tuning

The orchestra's samples are not all in tune: measured on 2026-11-11, single samples of the choir sat up to 27 cents off,
violins up to 17, the timpani up to 40, the vibraphone 10 sharp throughout. `retune.mjs` renders each sample alone,
reads its settled pitch (the energy centre of its first harmonics, past the attack) and writes a corrected copy of the
patch to `video/out/music/patches/`; after it, test notes of every patch measure within about 6 cents. The library
itself is left as downloaded. The soundfont's own timpani and "Ahh" choir were measured 20 to 50 cents off and are not
used. The piano is left alone (its stretch tuning is deliberate).

## Credits a published video owes

- Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0 (attribution required).
- Virtual Playing Orchestra by Paul Battersby (no attribution asked for music made with it), built on Sonatina
  Symphonic Orchestra (CC Sampling Plus 1.0), Mattias Westlund's samples (CC BY-SA 3.0), No Budget Orchestra
  (CC BY-SA 4.0), VSCO 2 Community Edition (CC0), University of Iowa samples and others; its `Documentation/license.htm`
  has the terms.
- FluidR3 GM soundfont by Frank Wen (MIT).
- The quoted phrase is from the Deus Ex main theme by Alexander Brandon; the theme belongs to its composer and publisher.
