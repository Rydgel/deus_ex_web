// The launch trailer's cut: the shots in order, each a stretch of a clip of the take (trailer-capture.mjs), in frames of 1/30 s.
//   how    'window' (the page inside the drawn browser window; the push-in runs over the window shots after `pushAfter` frames of the
//          whole window), 'full' (the page fills the frame), 'still' (one picture held), 'card' (the last card)
//   clip, from, frames   the clip, its first frame used (1-based) and how many
//   audio  default: the sound of the shot's own steps. {join: true}: the sound goes on from the shot before, whatever the picture cuts to
//          (the start: only the title music sounds there). {start: true}: from the page's first sound. {fadeOut: s}
// The order is the task's: the browser, the start as the original has it (splash, flight past the logos, main menu, New Game), the
// Liberty Island dock, a conversation with its subtitles, a fight, the inventory, Load Game with a save loading, the card.
export const SHOTS = [
  // ---- a browser window: the splash while the files load, then the flight begins and the window's content fills the frame
  {name: 'splash', how: 'window', splash: true, frames: 36, pushAfter: 60, audio: {start: true}},
  {name: 'flight: Eidos, in the window', how: 'window', clip: 'flight', from: 80, frames: 99, audio: {join: true}},
  {name: 'flight: Eidos', how: 'full', clip: 'flight', from: 179, frames: 30, audio: {join: true}},
  {name: 'flight: Ion Storm', how: 'full', clip: 'flight', from: 372, frames: 58, audio: {join: true}},
  {name: 'flight: Deus Ex', how: 'full', clip: 'flight', from: 572, frames: 108, audio: {join: true}},
  // ---- Escape: the main menu; New Game; the original's Start New Game screen
  {name: 'main menu', how: 'full', clip: 'menu', from: 8, frames: 53},
  {name: 'new game', how: 'full', clip: 'newgame', from: 1, frames: 50},
  // ---- Liberty Island
  {name: 'dock', how: 'full', clip: 'dock', from: 30, frames: 200, audio: {fadeOut: 0.5}},      // (the InfoLink's voice is mid-sentence at the cut)
  {name: 'MeetPaul', how: 'full', clip: 'paul', from: 257, frames: 236},       // its third and fourth lines: JC's question, Paul's answer
  {name: 'the choice', how: 'full', clip: 'choice', from: 12, frames: 50},                 // to the click
  {name: 'fight', how: 'full', clip: 'fight', from: 8, frames: 196},
  {name: 'inventory', how: 'full', clip: 'inventory', from: 8, frames: 106},
  // ---- Load Game: a 2003 save of another player's
  {name: 'load game', how: 'full', clip: 'load', from: 14, frames: 175},
  {name: 'loading', how: 'still', file: 'load/f00189.png', frames: 14, audio: {join: true}},     // the game's LOADING frame, the clip's last, held
  // (from its 26th frame: the HUD's figure runs from red to green in the first second of a level, as it does on the dock)
  {name: 'the save, loaded', how: 'full', clip: 'loaded', from: 26, frames: 140},
  {name: 'card', how: 'card', frames: 120, under: {clip: 'loaded', frame: 165}, audio: {join: true, fadeOut: 2.2}},
];
