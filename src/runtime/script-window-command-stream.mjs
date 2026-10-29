/** The HUD frame's commands as the numbers they are (docs/live-heap.md "Cut: HUD step").
 *
 * A tile command is a texture, eight numbers, a colour and a style: as an object it is a dozen heap objects (each number a boxed
 * double), about 300 bytes, and the HUD draws a hundred to three hundred of them a frame, which the simulation worker allocated
 * and the page's clone allocated again. The window host writes them into one reused Float64Array instead (a texture and a colour
 * as indices into the frame's short tables), and `expandHudStream` makes the same objects, key for key, where they are drawn.
 * The commands of the other kinds (viewport, actor, clearZ) are rare and stay objects, kept in order among the tiles.
 *
 * Per command STRIDE doubles: [kind, a, colour, style, x, y, width, height, u, v, ul, vl], kind 0 a tile (a = its texture index),
 * kind 1 another command (a = its index in `others`). */
export const STREAM_STRIDE = 12;

export class HudCommandStream {
  constructor() {
    this.words = new Float64Array(STREAM_STRIDE * 256);
    this.count = 0;
    this.textures = [];
    this.colors = [];
    this.others = [];
    this.textureAt = new Map();
    this.colorAt = new Map();
  }
  reset() {
    this.count = 0;
    this.textures.length = 0;
    this.colors.length = 0;
    this.others.length = 0;
    this.textureAt.clear();
    this.colorAt.clear();
  }
  grow() {
    const next = new Float64Array(this.words.length * 2);
    next.set(this.words);
    this.words = next;
  }
  /** A tile command: `texture` and `color` are shared objects (script-window-plain-texture.mjs, the host's colour cache). */
  tile(texture, x, y, width, height, u, v, ul, vl, color, style) {
    if ((this.count + 1) * STREAM_STRIDE > this.words.length) this.grow();
    let textureIndex = this.textureAt.get(texture);
    if (textureIndex === undefined) { textureIndex = this.textures.length; this.textures.push(texture); this.textureAt.set(texture, textureIndex); }
    let colorIndex = this.colorAt.get(color);
    if (colorIndex === undefined) { colorIndex = this.colors.length; this.colors.push(color); this.colorAt.set(color, colorIndex); }
    const words = this.words, at = this.count++ * STREAM_STRIDE;
    words[at] = 0; words[at + 1] = textureIndex; words[at + 2] = colorIndex; words[at + 3] = style;
    words[at + 4] = x; words[at + 5] = y; words[at + 6] = width; words[at + 7] = height;
    words[at + 8] = u; words[at + 9] = v; words[at + 10] = ul; words[at + 11] = vl;
  }
  /** A command of another kind, in its place among the tiles. */
  other(command) {
    if ((this.count + 1) * STREAM_STRIDE > this.words.length) this.grow();
    const words = this.words, at = this.count++ * STREAM_STRIDE;
    words[at] = 1; words[at + 1] = this.others.length;
    this.others.push(command);
  }
  /** The frame's stream as plain data to post: exact-length copies, so the next frame can write over this one's buffer. */
  finish() {
    return {count: this.count, words: this.words.slice(0, this.count * STREAM_STRIDE),
      textures: this.textures.slice(), colors: this.colors.slice(), others: this.others.slice()};
  }
}

/** The command list a stream stands for: tile commands with the keys of sim-session.mjs plainHudCommands, in the same order. */
export function expandHudStream({count, words, textures, colors, others}) {
  const commands = new Array(count);
  for (let i = 0; i < count; i++) {
    const at = i * STREAM_STRIDE;
    commands[i] = words[at] === 0
      ? {texture: textures[words[at + 1]], x: words[at + 4], y: words[at + 5], width: words[at + 6], height: words[at + 7],
        u: words[at + 8], v: words[at + 9], ul: words[at + 10], vl: words[at + 11], color: colors[words[at + 2]], style: words[at + 3]}
      : others[words[at + 1]];
  }
  return commands;
}
