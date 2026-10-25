// The promo's shared grid. The soundtrack plays the Deus Ex main theme (Title_Music) through ARRANGEMENT, the song's orders in
// the promo's sections, and the picture cuts on the same bars. music.mjs sequences the song from the local installation and
// writes ad/build/score.json (bar start times in seconds, the end); main.js reads it, so a bar is wherever the song's 16-row
// bar falls, its speed and tempo changes included (the intro's second block is slower and ends on a ritardando).
export const ARRANGEMENT = [
  ['open', [0, 1]],         // the theme's intro: the cold open, 00_Intro running in Play
  ['reveal', [2]],          // the build: the browser window, the title over the logo map
  ['island', [3, 4, 5]],    // the main groove: gameplay
  ['method', [6, 7]],       // data, bytecode, native code; the Rust core; x87
  ['pairs', [8, 9]],        // the bridge: one camera, two engines
  ['progress', [11, 12]],   // the stages
  ['numbers', [15]],        // the melody's return: the numbers
  ['outro', [16]],          // the ending: the end card
];
export const FPS = 30, TAIL = 3.5;

/** Bars and sections from a score ({bars: [seconds], end}); bar(b) interpolates inside a bar. */
export function grid(score) {
  const edges = [...score.bars, score.end];
  const bar = b => {
    const i = Math.max(0, Math.min(edges.length - 2, Math.floor(b)));
    return edges[i] + (b - i) * (edges[i + 1] - edges[i]);
  };
  const sections = {};
  let b = 0;
  for (const [name, orders] of ARRANGEMENT) { sections[name] = [b, b + 4 * orders.length]; b += 4 * orders.length; }
  return {bar, sections, span: name => sections[name].map(bar), barLength: b0 => bar(b0 + 1) - bar(b0), bars: b, duration: score.end + TAIL};
}
