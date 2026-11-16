# The crab film

A short film (2:43, 30 fps) about making this project: Claude's orange crab mascot in 3D, the score written for it, and
the game itself as drawn by this project's own engine. Everything is made by scripts; renders go to `video/out/` and the
downloaded sample libraries to `video/samples/`, both ignored by Git.

| Folder | What is in it |
| --- | --- |
| `music/` | The score: composition, synthesizer, sampled instruments, mix (its own README has the sources and credits) |
| `film/storyboard.mjs` | The 24 shots against the score's bars, and how each is made |
| `film/animatic.mjs` | The whole film at its real length on the music: rendered footage where it exists, a card per shot where it does not; the spoken line mixed in (the music ducked under it) and shown as a subtitle; `film.srt`, the captions for the sound, as a text track |
| `film/voice.mjs` | The one spoken line, JC Denton's "Maybe you should try getting a job.", read from the game's own conversation audio (`DeusExConAudioMission10.u`) into `video/out/film/voice/` |
| `film/screens.mjs` | What the film's monitors show, drawn in JavaScript (headless Chromium) as PNG sequences for Blender |
| `film/plates.mjs` | Frames of the game from the engine, from chosen cameras, with console commands and placed actors |
| `blender/crab.py` | The mascot: a script-built, posable puppet (with a pair of dark glasses it can put on) |
| `blender/stage.py`, `props.py` | Shared render setup, lights, cameras; the CRT monitor and keyboard |
| `blender/lookdev.py` | The mascot's sheet of stills and screen test |
| `blender/scene_boot.py` | Scene 1 (the terminal, bars 1 to 8) |
| `film/game-shots.mjs`, `plate-shot.mjs`, `engine.mjs` | The game shots: camera, actors and crab performance per shot; their plates captured frame by frame on a stepped clock |
| `film/graphics.mjs` | The shots drawn in JavaScript: the frame-time curve, the build montage, the browser pull-back, the title |
| `blender/game_shot.py`, `performances.py` | The crab's performance rendered through the engine's camera and laid over the plate, under a light rig for the place (`light`, `gain`) |
| `blender/sprite.py` | The crab alone on a transparent background, for the graphics shots |
| `film/panels.mjs` | The sheets of real data in the study scenes and the late-night log (DeusEx.u's bytes, LightSwitch.Frob's bytecode, AICanHear's machine code and Rust port, the validators' names, `git log`), drawn as PNGs with alpha |
| `blender/scene_study.py`, `props_study.py` | Scenes 2 to 5, the study (inside, reading, qa, adds-up, bars 8 to 24): glowing sheets on a dark glossy floor, the crab among them |
| `blender/scene_nights.py` | The late-night shot (bars 40 to 44): desk lamp, the old monitor scrolling the log, the crab at work |

```sh
node video/music/render.mjs --label "draft 3"          # the score, and score.json with the bar and cue times everything else reads
node video/film/screens.mjs boot                       # the terminal's screen
blender --background --factory-startup --python video/blender/scene_boot.py     # scene 1 -> video/out/film/boot/
node video/film/voice.mjs                              # JC's line -> video/out/film/voice/get-a-job.wav (needs the game's files)
node video/film/animatic.mjs                           # -> video/out/film/animatic.mp4 and film.srt
```

The film itself is the same cut at the final size: every Blender script and `graphics.mjs` take `--size 1920x1080` (the
engine's plates are captured at that size already), then

```sh
node video/film/animatic.mjs --size 1920x1080 --out film-1080p.mp4      # -> video/out/film/film-1080p.mp4
```

On the RTX 4070 a 1080p frame takes about 2 s for a game shot and 3 to 3.5 s for a Blender scene, some 2 h 45 min for
the 4897 frames; two renders side by side are no faster than one after the other.

The study and the nights (sheets first; `--frames a-b --step n` renders a few frames to look at, `--out DIR` keeps them out of the shot's folder):

```sh
node video/film/panels.mjs all                                                           # -> video/out/film/panels/<bytes|bytecode|qa|validators|nights>/
blender --background --factory-startup --python video/blender/scene_study.py -- --shot inside     # inside | reading | qa | adds-up -> video/out/film/<shot>/
blender --background --factory-startup --python video/blender/scene_nights.py                     # -> video/out/film/nights/
```

A game shot (each is an entry of `film/game-shots.mjs`), for example JC Denton on the Liberty Island dock:

```sh
node video/film/plate-shot.mjs jc-a                                                    # the engine's frames -> video/out/film/plates/jc-a/
blender --background --factory-startup --python video/blender/game_shot.py -- --shot jc-a     # the crab in them -> video/out/film/jc/
node video/film/plates.mjs scout --map 12_Vandenberg_Cmd --size 960x540 --scout        # looking for a place: four views from a map's start
```

The capture serves the repository with Vite in-process and opens the debug page in headless, muted Chromium, as the
project's acceptance harness does; it changes nothing in the game. Sequences run on a stepped clock (two 1/60 s engine
frames to a film frame), so they are the same each time. A summoned `JCDouble` has `Orders` Wandering and walks off: the
level is frozen (`bPlayersOnly`) and his place and animation frame are written for every film frame. In a `live` shot the
level runs and its people walk; `settle` lets it run some seconds before the first frame, because a person in a level
just loaded still stands in its mesh's rest pose, arms out (seen at UNATCO's desk). The crab is laid over the engine's frame, so by itself it would cover
whatever it overlaps. People are handled: a live shot is captured twice on the same stepped clock, the second time with
every person hidden (`plates/<id>/clean/`), and `plate.json` lists where each person stood in each frame. Where the two
frames differ, inside the screen boxes of the people nearer the camera than the crab, is a matte (`plates/<id>/front/`),
and through it the plate goes back over the crab: it passes behind a walker as it should. Walls, pillars and props are not
handled: against those each shot is still staged with the crab nearest the camera.

Words: the film has one spoken line (`VOICE` in the storyboard) and no narration. The line is burnt into the picture as a
subtitle; the music's cues and the line are also written as captions (`CAPTIONS`) to `film.srt` and carried in the MP4 as
a text track a player can switch on.

The engine's world is in Unreal units, left-handed; Blender's is metres, right-handed: `(x, -y, z) * 0.01905`. The engine's
camera (75 degrees horizontal at any aspect; pitch and yaw in 65536ths of a turn) is a Blender camera with rotation
`(90 + pitch, 0, -90 - yaw)` degrees and sensor fit HORIZONTAL; the composite over the dock's planks confirms it.

Needs: `blender` (5.2, Cycles on the GPU), `ffmpeg`, `node` with the repository's Playwright, the "PxPlus IBM VGA8" font,
and what `music/README.md` lists.
