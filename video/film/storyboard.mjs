// The film's shots, against the score's bars (0-based; a bar is 2.069 s at 116 BPM). Cuts fall on bar lines.
// how: 'blender' (the crab and props, rendered in Blender), 'data' (the same with screens of real project data drawn in
// JavaScript), 'game' (a frame of the game from this project's own engine, the crab rendered in Blender through the same
// camera and laid over it), 'graphics' (drawn in JavaScript). Footage is video/out/film/<id>/f0001.png ... (one frame per
// film frame of the shot, at 30 fps: frames = round(t1 * 30) - round(t0 * 30)); `clip` names a folder that holds a whole
// scene instead, numbered from the scene's first frame.
export const SHOTS = [
  // ---- boot, bars 0-8
  {id: 'glass', scene: 'boot', bar: 0, bars: 2, how: 'blender', clip: 'boot', title: 'The dark glass',
    action: 'Black. A cursor blinks on a monitor from the year 2000. In its dark glass, the reflection of a sleeping crab.'},
  {id: 'files', scene: 'boot', bar: 2, bars: 4, how: 'blender', clip: 'boot', title: 'The files',
    action: 'Over its back: the game\'s files list themselves, one on each bell. The crab wakes.'},
  {id: 'request', scene: 'boot', bar: 6, bars: 2, how: 'blender', clip: 'boot', title: 'The request',
    action: 'Its face in the screen\'s light. It reads: "run this in a browser. 100% faithful." On the cymbal it dives into the screen.'},
  // ---- study, bars 8-24
  {id: 'inside', scene: 'study', bar: 8, bars: 4, how: 'data', title: 'Inside',
    action: 'It lands inside the data: a wall of bytes from DeusEx.u, taller than it can see. It is very small.'},
  {id: 'reading', scene: 'study', bar: 12, bars: 4, how: 'data', title: 'Reading',
    action: 'A sheet of decoded bytecode, LightSwitch.Frob, appears line by line. It tilts its head and reads.'},
  {id: 'qa', scene: 'study', bar: 16, bars: 4, how: 'data', title: 'Question and answer',
    action: 'Machine code from Engine.dll on one side, its Rust translation on the other. On each answer of the piano, a check lights up: bit-exact.'},
  {id: 'adds-up', scene: 'study', bar: 20, bars: 4, how: 'data', title: 'It adds up',
    action: 'Validators turn green one after another, hundreds of them. It runs through them, faster, into the drum roll.'},
  // ---- light, bars 24-32
  {id: 'first-light', scene: 'light', bar: 24, bars: 4, how: 'game', title: 'First light',
    action: 'The world draws itself around the crab: lines first, then the game\'s own frame. Liberty Island, the dock, at night.'},
  {id: 'statue', scene: 'light', bar: 28, bars: 4, how: 'game', title: 'The statue',
    action: 'It walks to the end of the dock and looks up at the statue. Horns.'},
  // ---- the work, bars 32-56
  {id: 'unatco', scene: 'work-a', bar: 32, bars: 2, how: 'game', title: 'UNATCO', action: 'The theme. It scuttles down a corridor of UNATCO headquarters, past the troopers.'},
  {id: 'switch', scene: 'work-a', bar: 34, bars: 2, how: 'game', title: 'Training', action: 'The training hall, the first map that ever drew. It runs in, brakes too late on the polished floor, and slides.'},
  {id: 'street', scene: 'work-a', bar: 36, bars: 2, how: 'game', title: 'Hell\'s Kitchen', action: 'New York at night. It crosses the street between the people who live there.'},
  {id: 'market', scene: 'work-a', bar: 38, bars: 2, how: 'game', title: 'Hong Kong', action: 'The Wan Chai market, lanterns and crowds. It stops to look at everything.'},
  {id: 'nights', scene: 'work-b', bar: 40, bars: 4, how: 'blender', title: 'Nights', action: 'A desk lamp in the dark. Everyone else asleep. Logs scroll past; it keeps going.'},
  {id: 'frame-times', scene: 'work-b', bar: 44, bars: 2, how: 'graphics', title: 'Frame times', action: 'A line falls across the screen: 45 ms a frame, then 27, then 8. The crab rides it down.'},
  {id: 'build', scene: 'work-b', bar: 46, bars: 2, how: 'graphics', title: 'The build', action: 'Everything at once: the Rust core, the worker, the music player. The drum roll climbs.'},
  {id: 'it-runs', scene: 'work-c', bar: 48, bars: 4, how: 'game', title: 'It runs', action: 'The theme again, wider. The game alive: a station full of people walking, and the crab leading the way through it, hopping on the snare.'},
  {id: 'maps', scene: 'work-c', bar: 52, bars: 4, how: 'game', title: 'Map after map', action: 'Vandenberg. Area 51. The airfield. The dockyard. A bar each, the tom fill, and everything stops.'},
  // ---- denton, bars 56-64
  {id: 'dock', scene: 'denton', bar: 56, bars: 2, how: 'game', title: 'The dock', action: 'One hit, then silence. Night on Liberty Island. The crab alone, looking at the water. It hears something.'},
  {id: 'jc', scene: 'denton', bar: 58, bars: 4, how: 'game', title: 'JC Denton', action: 'He is standing there. The game\'s own theme, quietly, on a piano. It waves. He says: "Maybe you should try getting a job."'},
  {id: 'turn', scene: 'denton', bar: 62, bars: 2, how: 'game', title: 'The shades', action: 'It takes that in. Then sunglasses like his come down onto its face. The timpani rolls.'},
  // ---- finale and outro, bars 64-76
  {id: 'together', scene: 'finale', bar: 64, bars: 4, how: 'game', title: 'Together', action: 'The theme in its last form. Side by side down the dock, both in sunglasses, the camera backing away in front of them.'},
  {id: 'top-note', scene: 'finale', bar: 68, bars: 4, how: 'graphics', title: 'The top note', action: 'Pull back: the game is inside a browser window. Days, commits, maps. The theme climbs to its top note.'},
  {id: 'title', scene: 'outro', bar: 72, bars: 4, how: 'graphics', title: 'Deus Ex, in the browser', action: 'The last chord. The title. The motif once more, the credits, and the cursor blinks four times.'},
];

// Speech: [bar, seconds after it]: the recording (film/voice.mjs writes it), who speaks, the words (burnt in as a subtitle).
export const VOICE = [
  {at: [60, 2.45], file: 'voice/get-a-job.wav', who: 'JC Denton', text: 'Maybe you should try getting a job.', gain: -4},
];
// Captions for viewers who cannot hear the film: [bar, seconds after it, seconds shown], what is heard. A closed-caption
// track and video/out/film/film.srt; speech is added from VOICE.
export const CAPTIONS = [
  [[0, 0, 4], '[A low drone. A cursor blips.]'],
  [[2, 0, 5], '[Soft bells, one note at a time]'],
  [[8, 0, 5], '[An arpeggio and a harp fade in. Data ticks.]'],
  [[16, 0, 5], '[Piano: a rising question, a falling answer]'],
  [[23, 0, 2], '[Drum roll]'],
  [[24, 0, 5], '[A hit. Slow drums; horns rise over strings and voices]'],
  [[32, 0, 5], '[The theme: synth lead and piano over a full beat]'],
  [[40, 0, 5], '[Strings answer]'],
  [[46, 0, 4], '[The drums build]'],
  [[48, 0, 5], '[The theme again, higher, with strings]'],
  [[56, 0, 2], '[One hit. Then silence.]'],
  [[57, 0, 2], '[Electric piano: four rising notes]'],
  [[58, 0, 4.5], '[Piano, quietly: the Deus Ex theme]'],
  [[62, 0.5, 3.5], '[A timpani roll, growing]'],
  [[64, 0, 5], '[The theme, everyone together: strings, horns, voices]'],
  [[72, 0, 4], '[The last chord rings]'],
  [[74, 1, 4], '[Four soft blips]'],
];
