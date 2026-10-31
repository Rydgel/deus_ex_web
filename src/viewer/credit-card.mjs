/** The start's credit card (docs/boot.md "The credit card"): "Made by rydgel and Claudia" under rydgel's avatar, on the original start while
 * DX.dx's flight crosses the black between the Ion Storm logo and the Deus Ex logo. **Not original**, and outside the simulation: a canvas
 * over the scene's, whose opacity follows the posted view's X. The flight is IntroCam's PHYS_Interpolating path, X falling from 2946 to -13;
 * measured 2026-10-31 (Chromium, 1280 x 960): the Ion Storm logo leaves the view near X 1150 (16.5 s after the map) and the Deus Ex logo
 * comes in near X 400 (18.3 s). The text has the original's credits look: CreditsScrollWindow's fontHeader FontConversationLargeBold in
 * colHeader (255, 255, 255) over its fontText FontConversationLarge in colText (200, 200, 200), class defaults read from DeusEx.u, drawn by
 * the recovered GC.DrawText (hud-text.mjs), scaled up by whole pixels. ?credit=0 hides it. */
import { createHudText } from './hud-text.mjs';

const LINES = [
  { font: 'DeusExUI.FontConversationLargeBold', text: 'Made by', color: [255, 255, 255] },
  { font: 'DeusExUI.FontConversationLarge', text: 'rydgel and Claudia', color: [200, 200, 200] },
];
// The layout in root units: the avatar's side and the gap under it, a line's height (both fonts' yExtent) and the gap between the
// lines, the width the lines are centred in.
const AVATAR = 96, GAP = 10, LINE = 23, LEADING = 2, WIDTH = 320;

/** The card's opacity at the view's X: in as the Ion Storm logo leaves (X 1250 to 1150), out as the Deus Ex logo comes in (X 400 to 150). */
export function creditOpacity(x) {
  if (x > 1250 || x <= 150) return 0;
  return x > 1150 ? (1250 - x) / 100 : x > 400 ? 1 : (x - 150) / 250;
}

/** One GC.DrawText tile into `pixels` (RGBA, `width` wide): the glyph page's texels times the text colour; a masked texel is not drawn. */
function blit(pixels, width, height, tile) {
  const { image } = tile;
  for (let j = 0; j < tile.height; j++) for (let i = 0; i < tile.width; i++) {
    const x = Math.round(tile.x + i), y = Math.round(tile.y + j), from = ((tile.v + j) * image.width + tile.u + i) * 4;
    if (x < 0 || y < 0 || x >= width || y >= height || !image.data[from + 3]) continue;
    const to = (y * width + x) * 4;
    for (let k = 0; k < 3; k++) pixels[to + k] = image.data[from + k] * tile.color[k] / 255;
    pixels[to + 3] = 255;
  }
}

export async function createCreditCard({ assets, scene }) {
  const text = await createHudText(assets, LINES.map(line => line.font));
  const height = 2 * LINE + LEADING, pixels = new Uint8ClampedArray(WIDTH * height * 4);
  LINES.forEach((line, row) => text.draw(tile => blit(pixels, WIDTH, height, tile),
    { ...line, x: 0, y: row * (LINE + LEADING), width: WIDTH, height: LINE, hAlign: 1 }));
  const lines = document.createElement('canvas');
  lines.width = WIDTH; lines.height = height; lines.getContext('2d').putImageData(new ImageData(pixels, WIDTH, height), 0, 0);
  const avatar = new Image();
  avatar.src = new URL('./credit-avatar.webp', import.meta.url).href;
  await avatar.decode();
  const canvas = document.createElement('canvas');
  canvas.className = 'credit-card';
  canvas.style.display = 'none';
  scene.after(canvas);
  let painted = '';
  /** The card over the scene's box at its buffer size, in whole multiples `m` of the fonts' pixels: one per 360 rows (2 at 720 to 1079, 3 at
   * 1080), about twice the root window's text (ResizeRoot's min(floor(w/640), floor(h/480))), so it reads at a glance. */
  function paint() {
    const w = scene.width, h = scene.height, m = Math.max(1, Math.floor(h / 360));
    canvas.width = w; canvas.height = h;
    Object.assign(canvas.style, { width: scene.style.width, height: scene.style.height, left: `${scene.offsetLeft}px`, top: `${scene.offsetTop}px` });
    const g = canvas.getContext('2d'), top = Math.floor((h / m - (AVATAR + GAP + height)) / 2) * m;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(avatar, Math.floor((w / m - AVATAR) / 2) * m, top, AVATAR * m, AVATAR * m);
    g.imageSmoothingEnabled = false;
    g.drawImage(lines, Math.floor((w / m - WIDTH) / 2) * m, top + (AVATAR + GAP) * m, WIDTH * m, height * m);
  }
  return {
    /** One drawn frame: `x` the view's X on DX.dx, or null (another map, or a window drawn over the view) to hide the card. */
    update(x) {
      const opacity = x === null ? 0 : creditOpacity(x);
      canvas.style.display = opacity > 0 ? '' : 'none';
      if (!opacity) return;
      const box = [scene.width, scene.height, scene.style.width, scene.style.height, scene.offsetLeft, scene.offsetTop].join();
      if (box !== painted) { painted = box; paint(); }
      canvas.style.opacity = String(opacity);
    },
  };
}
