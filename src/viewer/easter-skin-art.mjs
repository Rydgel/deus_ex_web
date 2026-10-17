/** The ?easter=1 skins (docs/easter-egg.md "Skins"): Claudia's and Rydgel's textures, generated at run time from stock Deus Ex skins
 * that the page has just decoded (recolouring, and composited marks drawn here), so no original pixel is stored anywhere: only this
 * code is in the repository. `createEasterSkins` returns the function actor-mesh-draw.mjs asks for each face group's skin
 * (easter-skins.mjs); it answers the stock skin untouched for every other actor and every texture it has no recipe for.
 *
 * Regions are given in normalized texture coordinates (u, v in 0..1 of the whole texture), which is how the mesh's UVs address
 * them (the byte coordinates over 256), found by drawing each slot's triangles over its texture (docs/easter-egg.md "UV layouts"). */

const clamp = (value, low = 0, high = 255) => (value < low ? low : value > high ? high : value);
const mix = (a, b, t) => a + (b - a) * t;

export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max / 255];
}
export function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** A mutable RGBA copy of a decoded texture's first mip. */
export function copyImage(data) {
  const mip = data.mips[0];
  return { width: mip.width, height: mip.height, pixels: Uint8Array.from(mip.data) };
}

/** The full mip chain (down to 1x1, as the stock skins have) of an edited first mip, by 2x2 box averages. */
export function mipChain(image) {
  const mips = [{ width: image.width, height: image.height, data: image.pixels }];
  for (let last = mips[0]; last.width > 1 || last.height > 1;) {
    const width = Math.max(1, last.width >> 1), height = Math.max(1, last.height >> 1), out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
      let sum = 0, n = 0;
      for (let dy = 0; dy < (last.height > 1 ? 2 : 1); dy++) for (let dx = 0; dx < (last.width > 1 ? 2 : 1); dx++) { sum += last.data[(((y << 1) + dy) * last.width + (x << 1) + dx) * 4 + c]; n++; }
      out[(y * width + x) * 4 + c] = Math.round(sum / n);
    }
    mips.push(last = { width, height, data: out });
  }
  return mips;
}

/** `fn(pixel, u, v)` over every texel, with `pixel` the [r, g, b, a] to edit in place. */
function paint(image, fn) {
  const { width, height, pixels } = image, px = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    px[0] = pixels[i]; px[1] = pixels[i + 1]; px[2] = pixels[i + 2]; px[3] = pixels[i + 3];
    fn(px, (x + 0.5) / width, (y + 0.5) / height);
    pixels[i] = clamp(Math.round(px[0])); pixels[i + 1] = clamp(Math.round(px[1])); pixels[i + 2] = clamp(Math.round(px[2])); pixels[i + 3] = clamp(Math.round(px[3]));
  }
}
/** Recolour: the texel's brightness and detail kept, its hue and saturation replaced (`value` scales the brightness). */
function tint(px, hue, sat, value = 1, lift = 0) {
  const [, , v] = rgbToHsv(px[0], px[1], px[2]);
  const [r, g, b] = hsvToRgb(hue, sat, clamp(v * value + lift, 0, 1));
  px[0] = r; px[1] = g; px[2] = b;
}
const inRect = (u, v, [u0, v0, u1, v1]) => u >= u0 && u <= u1 && v >= v0 && v <= v1;
/** A soft-edged ellipse weight at (u, v), 1 inside and falling to 0 over `feather`. */
function disc(u, v, cu, cv, ru, rv, feather = 0.25) {
  const d = Math.hypot((u - cu) / ru, (v - cv) / rv);
  return d <= 1 - feather ? 1 : d >= 1 ? 0 : (1 - d) / feather;
}
function blend(px, [r, g, b], t) { px[0] = mix(px[0], r, t); px[1] = mix(px[1], g, t); px[2] = mix(px[2], b, t); }

/** The recipes: the stock skin's key suffix (the texture the actor's own MultiSkins slot names, case-insensitive) -> `paint`, an edit of
 * a copy of it, or of `from`'s pixels (a stock skin in DeusExCharacters Skins, decoded the same way) where another stock head is the
 * better start. */
export const RECIPES = {
  claudia: {
    // Female1Tex0 (slot 0 face and hair; slot 2 masked hair strands): the stock blond hair (hue ~45) goes near-black, a purple streak
    // sweeps across the fringe and crown.
    female1tex0: { paint(image) {
      paint(image, (px, u, v) => {
        const [h, s] = rgbToHsv(px[0], px[1], px[2]);
        if (h < 38 || h > 64 || s < 0.3 || px[3] === 0) return;
        const streak = (Math.abs((u - 0.44) * 0.8 - (v - 0.26) * 0.6 + 0.06) < 0.022 && v < 0.5 && u > 0.28) || (u > 0.27 && u < 0.34 && v > 0.4 && v < 0.56);
        if (streak) tint(px, 288, 0.85, 1.3, 0.12); else tint(px, 250, 0.22, 0.2);
      });
    } },
    // FramesTex1 (slot 3 once the actor's MultiSkins names it, a modulated texture: mid grey leaves the face as it is, black darkens it):
    // the stock wayfarer ring becomes a round dark-violet ring, drawn here.
    framestex1: { paint(image) {
      const centre = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
      const neutral = [image.pixels[centre], image.pixels[centre + 1], image.pixels[centre + 2]];
      paint(image, (px, u, v) => {
        const d = Math.hypot(u - 0.5, v - 0.5), ring = clamp(1 - Math.abs(d - 0.395) / 0.06, 0, 1);
        const arm = u < 0.12 && Math.abs(v - 0.2) < 0.045 ? 1 : 0;
        const t = Math.max(ring, arm);
        px[0] = mix(neutral[0], 22, t); px[1] = mix(neutral[1], 18, t); px[2] = mix(neutral[2], 34, t);
      });
    } },
    // PantsTex2 (slot 6): olive cargo trousers with thigh pockets, white sneakers on the feet's regions.
    pantstex2: { paint(image) {
      paint(image, (px, u, v) => {
        const shoe = (u < 0.2 && v > 0.4) || (u > 0.86 && v > 0.55 && v < 0.96);
        if (shoe) { const [, , value] = rgbToHsv(px[0], px[1], px[2]); const w = clamp(0.62 + value * 0.5, 0, 1) * 255; px[0] = w; px[1] = w; px[2] = w - 4; return; }
        tint(px, 78, 0.42, 0.95);
        for (const [pu, pv] of [[0.34, 0.56], [0.7, 0.56]]) {
          const edge = Math.abs(u - pu) < 0.1 && Math.abs(v - pv) < 0.09;
          const border = edge && (Math.abs(Math.abs(u - pu) - 0.1) < 0.011 || Math.abs(Math.abs(v - pv) - 0.09) < 0.011);
          if (border) { px[0] *= 0.55; px[1] *= 0.55; px[2] *= 0.55; } else if (edge) tint(px, 74, 0.45, 1.08);
        }
      });
    } },
    // Female1Tex1 (slot 7): an oversized purple hoodie: the knit recoloured, the hands left, hood gathering at the neck, drawstrings,
    // cuffs, a front pocket.
    female1tex1: { paint(image) {
      paint(image, (px, u, v) => {
        if (px[3] === 0 || inRect(u, v, [0.32, 0.78, 0.68, 1])) return;
        tint(px, 276, 0.55, 1.12);
        if (inRect(u, v, [0.7, 0, 0.98, 0.2])) tint(px, 272, 0.62, 0.62);
        if ((Math.abs(u - 0.8) < 0.0045 || Math.abs(u - 0.9) < 0.0045) && v > 0.1 && v < 0.5) blend(px, [226, 218, 236], 0.85);
        if (inRect(u, v, [0.74, 0.58, 0.96, 0.92])) { const edge = u < 0.752 || u > 0.948 || v < 0.592 || v > 0.908; if (edge) blend(px, [30, 12, 48], 0.55); else tint(px, 280, 0.6, 1.0); }
        if (inRect(u, v, [0.32, 0.7, 0.68, 0.78])) tint(px, 270, 0.6, 0.7);
      });
    } },
  },
  rydgel: {
    // The head and hands of NathanMadisonTex0 (a clean-shaven GM_Suit head, auburn hair) with the hair gone golden and worn loose (no
    // ponytail: slot 7 keeps the class's own mask), hanging in strands over the nape, a tattoo on the neck's side below it and a gold stud in the ear.
    businessman2tex0: { from: 'Skins.NathanMadisonTex0', paint(image) {
      const { width, height } = image, isHair = (px, u, v) => {
        if (px[3] === 0) return false;
        const [h, s] = rgbToHsv(px[0], px[1], px[2]);
        // hair: the dark saturated texels of the cap and fringe (v < 0.5) and of the back and side of the head (u > 0.52), never the face
        return (v < 0.5 || (u > 0.52 && v < 0.86)) && v > 0.28 && h >= 14 && h <= 42 && s >= 0.6;
      };
      // Loose hair: below the back of the head's hair edge the golden strands continue down over the nape, each column a little longer
      // or shorter than the next (the strands mirror the hair just above the edge, so the grain carries on).
      const original = Uint8Array.from(image.pixels), edge = new Int32Array(width).fill(-1);
      for (let x = 0; x < width; x++) {
        if ((x + 0.5) / width < 0.66) continue;
        for (let y = Math.floor(height * 0.86); y >= Math.floor(height * 0.5); y--) {
          const i = (y * width + x) * 4;
          if (isHair([original[i], original[i + 1], original[i + 2], original[i + 3]], (x + 0.5) / width, (y + 0.5) / height)) { edge[x] = y; break; }
        }
      }
      paint(image, (px, u, v) => {
        const x = Math.floor(u * width), y = Math.floor(v * height);
        if (isHair(px, u, v)) tint(px, 45, 0.58, 1.5, 0.24);
        else if (px[3] > 0 && edge[x] >= 0 && y > edge[x]) {
          const length = Math.round(height * (0.05 + 0.08 * (((x * 2654435761) >>> 11) % 97) / 97)), below = y - edge[x];
          if (below <= length) {
            const mirror = Math.max(0, edge[x] - below * 2), i = (mirror * width + x) * 4;
            const [r, g, b] = hsvToRgb(45, 0.58, clamp(rgbToHsv(original[i], original[i + 1], original[i + 2])[2] * 1.5 + 0.24 - 0.06 * below / Math.max(1, length), 0, 1));
            px[0] = r; px[1] = g; px[2] = b;
          }
        }
        // the neck tattoo: a small glyph of ink lines, at the neck's left side in the head layout
        const front = Math.abs(((u - 0.2) * 7 + Math.sin((v - 0.9) * 55) * 0.35) % 1) < 0.2 && inRect(u, v, [0.1, 0.9, 0.36, 0.995]);
        const side = Math.abs(((u + v) * 22) % 1 - 0.5) < 0.16 && inRect(u, v, [0.6, 0.9, 0.82, 0.985]);
        if (px[3] > 0 && (front || side)) blend(px, [20, 30, 54], 0.85);
        blend(px, [232, 190, 70], 0.95 * disc(u, v, 0.585, 0.745, 0.014, 0.02));
      });
    } },
    // Businessman2Tex1 (slot 3 jacket; slot 4 its masked skirt): the grey suit becomes an olive field jacket worn open over a plain dark
    // brown-black crew-neck tee. The stock front is a suit's: a deep V of black shirt with an orange tie, satin lapels with a notch, a
    // double-breasted overlap and two buttons. Here the V is cut down to a rounded tee opening (no tie, the neck's collar piece a
    // plain rib), the lapels, overlap and buttons are flattened into the jacket's own cloth, and a zip runs from the opening's foot
    // to the hem; a chest patch, a sleeve pocket, a ribbed hem and two chains stay.
    businessman2tex1: { paint(image) {
      const { width, height } = image, front = (u, v) => u >= 0.715 && u <= 0.945 && v <= 0.655;
      const centre = 0.8267, edges = [[0, 0.773], [0.15, 0.767], [0.29, 0.773], [0.39, 0.795], [0.45, 0.81], [0.51, 0.8267]];
      // The stock V's half width at v (the black shirt's left edge by v, mirrored about the centre), and the rounded opening that replaces it.
      const stock = v => { for (let k = 1; k < edges.length; k++) if (v <= edges[k][0]) { const [v0, u0] = edges[k - 1], [v1, u1] = edges[k]; return centre - (u0 + (u1 - u0) * (v - v0) / (v1 - v0)); } return 0; };
      const OPEN_END = 0.37, TAPER = 0.22, tee = v => (v <= TAPER ? stock(v) : v >= OPEN_END ? 0 : stock(TAPER) * Math.sqrt(1 - ((v - TAPER) / (OPEN_END - TAPER)) ** 2));
      const noise = (x, y) => { let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
      // The jacket front's cloth: the front panel's brightness blurred over a wide window (so the lapel lines and the overlap fade into
      // soft shading) from the pixels outside the stock V.
      const R = 9, value = new Float32Array(width * height), weight = new Float32Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width, v = (y + 0.5) / height, i = (y * width + x) * 4;
        if (!front(u, v) || image.pixels[i + 3] === 0 || Math.abs(u - centre) < stock(v) + 0.012) continue;
        value[y * width + x] = rgbToHsv(image.pixels[i], image.pixels[i + 1], image.pixels[i + 2])[2]; weight[y * width + x] = 1;
      }
      const cloth = (x, y) => {
        let sum = 0, n = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height || !weight[yy * width + xx]) continue;
          sum += value[yy * width + xx]; n++;
        }
        return n ? sum / n : 0.6;
      };
      const smooth = new Map();
      paint(image, (px, u, v) => {
        // the jacket's skirt (the masked slot 4) is cut at the ribbed hem: a bomber ends there, and the trousers' belt shows
        if (v > 0.745) px[3] = 0;
        if (px[3] === 0) return;
        const x = Math.floor(u * width), y = Math.floor(v * height), dx = Math.abs(u - centre), grain = noise(x, y);
        if (front(u, v)) {
          if (v < 0.37 && dx < tee(v)) {
            // the tee: dark brown-black jersey, a faint lift down the middle of the chest
            // (the top of the opening is the neckband: a finely ribbed edge, a little lighter than the body)
            const lift = 1 - Math.min(1, dx / 0.05) * 0.25, band = v < 0.04 ? 0.05 + 0.03 * (0.5 + 0.5 * Math.sin(u * 256 * 2.6)) : 0;
            const [r, g, b] = hsvToRgb(24, 0.5, clamp((0.105 + 0.014 * grain) * lift + band, 0, 1)); px[0] = r; px[1] = g; px[2] = b;
          } else {
            const key = y * width + x;
            if (!smooth.has(key)) smooth.set(key, cloth(x, y));
            // flattened cloth inside the front panel, the stock jacket's own tint outside it, feathered across the panel's side edges
            const [fr, fg, fb] = hsvToRgb(84, 0.4, clamp(smooth.get(key) * 0.66 + 0.02 * (grain - 0.5), 0, 1));
            tint(px, 84, 0.4, 0.66);
            const t = clamp((u - 0.715) / 0.03, 0, 1) * clamp((0.945 - u) / 0.03, 0, 1);
            px[0] = mix(px[0], fr, t); px[1] = mix(px[1], fg, t); px[2] = mix(px[2], fb, t);
            // the opening's edge: a seam, and the zip from the opening's foot to the hem
            const edge = Math.abs(dx - tee(v)) < 0.0035 && v < OPEN_END && v > 0.02;
            if (edge) { px[0] *= 0.62; px[1] *= 0.62; px[2] *= 0.62; }
            if (v >= OPEN_END - 0.004 && v <= 0.655 && dx < 0.0042) {
              const tooth = Math.floor(v / 0.011) % 2 === 0, [r, g, b] = dx < 0.0016 ? [38, 42, 26] : tooth ? [170, 168, 140] : [74, 80, 52];
              px[0] = r; px[1] = g; px[2] = b;
            }
            if (dx < 0.007 && v > OPEN_END + 0.012 && v < OPEN_END + 0.05) blend(px, [188, 184, 150], 0.9);
          }
        } else if (u > 0.3 && u < 0.545 && v < 0.05) {
          // the neck's collar piece: the tee's plain rib, not a shirt collar
          const rib = 0.5 + 0.5 * Math.sin(u * 256 * 2.4), [r, g, b] = hsvToRgb(24, 0.45, 0.13 + 0.05 * rib + 0.01 * grain); px[0] = r; px[1] = g; px[2] = b;
        } else {
          const [h, sat, val] = rgbToHsv(px[0], px[1], px[2]);
          if (h >= 18 && h <= 55 && sat > 0.5 && val > 0.25) tint(px, 24, 0.4, 0.26);
          else if (sat < 0.4 && val > 0.2) tint(px, 84, 0.4, 0.66);
          else tint(px, 24, 0.42, 1, 0.03);
        }
        // ribbed hem of the jacket and its skirt
        if (v > 0.655 && v < 0.74) { const rib = Math.sin(u * 256 * 1.6) * 0.5 + 0.5; tint(px, 84, 0.42, 0.55 + 0.25 * rib); }
        // sleeve pocket with a zip
        if (inRect(u, v, [0.43, 0.32, 0.53, 0.46])) { const edge = u < 0.438 || u > 0.522 || v < 0.328 || v > 0.452; if (edge) blend(px, [30, 38, 18], 0.6); else if (Math.abs(v - 0.345) < 0.007) blend(px, [196, 188, 150], 0.9); }
        // chest patch (a round badge) on the wearer's left chest
        const badge = disc(u, v, 0.885, 0.215, 0.027, 0.047, 0.2);
        if (badge) blend(px, disc(u, v, 0.885, 0.215, 0.019, 0.033, 0.3) >= 1 ? [44, 52, 30] : [196, 160, 52], badge);
        // two chains over the tee, in the opening of the jacket
        for (const [sag, w] of [[0.075, 0.006], [0.15, 0.006]]) {
          const d = Math.abs(v - (0.02 + sag * (1 - ((u - centre) / 0.055) ** 2)));
          if (Math.abs(u - centre) < 0.055 && d < w) blend(px, [226, 190, 96], 0.95);
        }
        blend(px, [236, 206, 120], 0.95 * disc(u, v, centre, 0.2, 0.012, 0.022));
      });
    } },
    // Businessman2Tex2 (slot 1): dark trousers, a mustard belt with a buckle at the waist.
    businessman2tex2: { paint(image) {
      paint(image, (px, u, v) => {
        if (px[3] === 0) return;
        tint(px, 225, 0.12, 0.36);
        if (v > 0.012 && v < 0.056) {
          const lum = rgbToHsv(px[0], px[1], px[2])[2], buckle = Math.abs(u - 0.87) < 0.022;
          const [r, g, b] = buckle ? [190, 190, 176] : hsvToRgb(44, 0.86, 0.5 + lum * 0.4);
          px[0] = r; px[1] = g; px[2] = b;
        }
      });
    } },
  },
};

/** The skin function for the page's actor mesh draw. */
export function createEasterSkins({ claudia, rydgel }) {
  const names = new Map([[claudia, 'claudia'], [rydgel, 'rydgel']]), made = new Map();
  const skin = async ({ actorName, assets, textures, data, flags }) => {
    const who = names.get(actorName);
    if (!who) return { data, flags };
    const recipe = RECIPES[who][String(data.key).split('.').pop().toLowerCase()];
    if (!recipe) return { data, flags };
    const key = `easter:${who}:${data.key}:${data.masked}`;
    if (!made.has(key)) {
      let source = data;
      if (recipe.from) {
        const asset = await assets.get('DeusExCharacters');
        source = await textures.get(asset, asset.exportsByPath.get(recipe.from.toLowerCase()), data.masked);
      }
      const image = copyImage(source);
      recipe.paint(image);
      made.set(key, { ...data, key, mips: mipChain(image) });
    }
    return { data: made.get(key), flags };
  };
  // The skins made so far by key (validation: scripts/validate-easter-egg-play.mjs reads their pixels).
  skin.generated = made;
  return skin;
}
