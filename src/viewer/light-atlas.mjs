import * as THREE from 'three';
import { frameProjection, FRAME_PROJECTION_KEY } from './frame-projection.mjs';
import { REENCODE_GLSL } from './original-sampling.mjs';

/** `?lightDebug=` (validation only, docs/visual-acceptance.md "The darkest pixels"): captures of what the world shader multiplies. `base` leaves the
 * base texel unmodulated, `light32` writes the light-map sample times 32 (white where a surface has no light map, and saturated above 8 bytes), `world`
 * writes white for every fragment this shader draws. Unset, the generated shader is the one it always was. */
const LIGHT_DEBUG = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('lightDebug') : null;
/** Padded lightmap tiles share texture pages; sample bounds prevent atlas bleeding. */
/** Whether the page's bytes may be written as 32-bit words (RGBA in memory order is a little-endian word). */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/** `update` copies a byte source a word per texel, unless ?movingCompose=js (MOVING_COMPOSE=js in Node) keeps the byte loop as the reference. */
const wordWrites = () => LITTLE_ENDIAN && ((typeof process !== 'undefined' && process.env?.MOVING_COMPOSE) || globalThis.DEUS_EX_MOVING_COMPOSE) !== 'js';
export class LightAtlas {
  constructor(size = 1024, { words = wordWrites() } = {}) {
    this.wordWrites = words; this.packedUploads = 0;
    this.size = size; this.pages = []; this.tiles = new WeakMap();
    this.arrayUniform = { value: null }; this.arrayUploaded = false; this.scratch = new Uint8Array(0); this.addPage();
  }
  addPage() {
    if (this.arrayUniform.value) throw new Error('Cannot grow a sealed lightmap texture array');
    const pixels = new Uint8Array(this.size * this.size * 4);
    const texture = new THREE.DataTexture(pixels, this.size, this.size, THREE.RGBAFormat);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false; texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    // The staging texture shares the pixels but never renders, so the
    // renderer copies its rectangles from memory, not by framebuffer.
    const staging = new THREE.DataTexture(pixels, this.size, this.size, THREE.RGBAFormat);
    const page = { index: this.pages.length, texture, staging, pixels, x: 0, y: 0, rowHeight: 0, uploaded: false, dirty: [],
      layers: this.arrayUniform };
    texture.onUpdate = () => { page.uploaded = true; };
    this.pages.push(page); return page;
  }
  /** Seal the finished world's pages as array layers. Page textures and
   * staging views keep the same bytes; once sealed, unbatched surfaces also
   * sample their page's layer (applyLightAtlas), so the page textures are
   * not uploaded and each light-map change is sent once. */
  sealArray() {
    if (this.arrayUniform.value) return this.arrayUniform;
    if (this.pages.some(page => page.uploaded)) throw new Error('Seal lightmap layers before the first draw');
    const stride = this.size * this.size * 4, pixels = new Uint8Array(stride * this.pages.length);
    for (const page of this.pages) {
      pixels.set(page.pixels, page.index * stride);
      page.pixels = pixels.subarray(page.index * stride, (page.index + 1) * stride);
      page.texture.image.data = page.staging.image.data = page.pixels;
    }
    const texture = new THREE.DataArrayTexture(pixels, this.size, this.size, this.pages.length);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false; texture.flipY = false; texture.colorSpace = THREE.NoColorSpace;
    texture.onUpdate = () => { this.arrayUploaded = true; };
    texture.needsUpdate = true; this.arrayUniform.value = texture;
    return this.arrayUniform;
  }
  dirtyPage(page) {
    page.texture.needsUpdate = true;
    const array = this.arrayUniform.value;
    if (array) {
      // A full upload includes every layer. Three can reallocate the GPU
      // array after context loss without resetting our upload flags; queued
      // layerUpdates would leave the other freshly allocated layers empty.
      array.needsUpdate = true;
    }
  }
  add(lightmap) {
    if (!lightmap) return { page: this.pages[0], enabled: false };
    if (this.tiles.has(lightmap)) return this.tiles.get(lightmap);
    const width = lightmap.width + 2, height = lightmap.height + 2;
    if (width > this.size || height > this.size) throw new Error('Lightmap does not fit atlas page');
    let page = this.pages.at(-1);
    if (page.x + width > this.size) { page.x = 0; page.y += page.rowHeight; page.rowHeight = 0; }
    if (page.y + height > this.size) page = this.addPage();
    const x = page.x + 1, y = page.y + 1;
    const tile = { page, enabled: true, x, y, lightmap, width: lightmap.width, height: lightmap.height,
      bounds: [(x + .5) / this.size, (y + .5) / this.size, (x + lightmap.width - .5) / this.size, (y + lightmap.height - .5) / this.size] };
    page.x += width; page.rowHeight = Math.max(page.rowHeight, height);
    this.tiles.set(lightmap, tile);
    return this.update(lightmap);
  }
  /** Upload changed light samples into the existing tile, retaining its UVs,
   * page and padding. The lighting engine owns when and how samples change.
   * A partial update of an uploaded page defers to flush() as one sub-image
   * copy per tile instead of re-uploading the page.
   * `bytes` (RGB, the light map's stride) may stand in for the samples when
   * every sample the region reads is exactly bytes/255: the conversion
   * below returns that byte for all 256 values (test/world-batches.test.mjs),
   * so the page receives the same bytes without the float round trip. */
  update(lightmap, { partial = false, region = null, bytes = null } = {}) {
    const tile = this.tiles.get(lightmap);
    if (!tile) throw new Error('Lightmap is not allocated in this atlas');
    if (lightmap.width !== tile.width || lightmap.height !== tile.height)
      throw new Error('Updating a lightmap cannot change its atlas dimensions');
    const {page, x, y} = tile, pixels = page.pixels, size = this.size, width = lightmap.width, height = lightmap.height;
    // A region (source texel rectangle) also refreshes the padding it borders.
    const [left, right] = region ? [region.minU ? region.minU : -1, region.maxU < width ? region.maxU - 1 : width] : [-1, width];
    const [top, bottom] = region ? [region.minV ? region.minV : -1, region.maxV < height ? region.maxV - 1 : height] : [-1, height];
    const samples = lightmap.pixels;
    if (bytes && this.wordWrites) {
      // The same bytes, a word a texel.
      const words = this.pageWords(page);
      for (let row = top; row <= bottom; row++) {
        const srcRow = (row < 0 ? 0 : row >= height ? height - 1 : row) * width;
        let dst = (y + row) * size + x + left;
        for (let col = left; col <= right; col++, dst++) {
          const src = (srcRow + (col < 0 ? 0 : col >= width ? width - 1 : col)) * 3;
          words[dst] = bytes[src] | bytes[src + 1] << 8 | bytes[src + 2] << 16 | 0xff000000;
        }
      }
    } else for (let row = top; row <= bottom; row++) {
      const srcRow = (row < 0 ? 0 : row >= height ? height - 1 : row) * width;
      let dst = ((y + row) * size + x + left) * 4;
      for (let col = left; col <= right; col++, dst += 4) {
        const src = (srcRow + (col < 0 ? 0 : col >= width ? width - 1 : col)) * 3;
        if (bytes) { pixels[dst] = bytes[src]; pixels[dst + 1] = bytes[src + 1]; pixels[dst + 2] = bytes[src + 2]; }
        else for (let c = 0; c < 3; c++) pixels[dst + c] = Math.round(Math.max(0, Math.min(1, samples[src + c])) * 255);
        pixels[dst + 3] = 255;
      }
    }
    if (partial && (page.uploaded || this.arrayUploaded)) page.dirty.push([x + left, y + top, right - left + 1, bottom - top + 1]);
    else this.dirtyPage(page);
    return tile;
  }
  /** The page's pixels as 32-bit words (made again when the page's pixels moved into the sealed array). */
  pageWords(page) {
    let words = page.pixels32;
    if (!words || words.buffer !== page.pixels.buffer || words.byteOffset !== page.pixels.byteOffset)
      words = page.pixels32 = new Uint32Array(page.pixels.buffer, page.pixels.byteOffset, page.pixels.length >> 2);
    return words;
  }
  /** The tile rectangle `update` writes for `region`, as source columns and rows of the light map (-1 and the map's width or height are
   * the padding); null when the light map has no tile of its size here. */
  rectOf(lightmap, region) {
    const tile = this.tiles.get(lightmap);
    if (!tile || lightmap.width !== tile.width || lightmap.height !== tile.height) return null;
    const { width, height } = lightmap;
    return { left: region.minU ? region.minU : -1, right: region.maxU < width ? region.maxU - 1 : width,
      top: region.minV ? region.minV : -1, bottom: region.maxV < height ? region.maxV - 1 : height };
  }
  /** `update` for texels converted elsewhere (moving-compose-kernel.mjs): `packed` holds from word `offset` the RGBA texels of `rect` (rectOf), rows
   * and columns in order, as 32-bit little-endian words; the page receives the same bytes `update` would write, and the same upload
   * bookkeeping follows. */
  writePacked(lightmap, rect, packed, offset = 0, source = null) {
    const tile = this.tiles.get(lightmap), { page, x, y } = tile, size = this.size, width = rect.right - rect.left + 1;
    const words = this.pageWords(page);
    for (let row = 0, rows = rect.bottom - rect.top + 1; row < rows; row++) {
      let dst = (y + rect.top + row) * size + x + rect.left, src = offset + row * width;
      for (let end = src + width; src < end; src++, dst++) words[dst] = packed[src];
    }
    // The deferred rectangle keeps the packed texels it was made from, as `source` (an object with a `generation` that changes when
    // those texels are overwritten) still has them at flush(): the upload then takes them as they are, where the page's rows would be
    // copied into a packed scratch first.
    if (page.uploaded || this.arrayUploaded) {
      const entry = [x + rect.left, y + rect.top, width, rect.bottom - rect.top + 1];
      if (source) entry.push(packed, offset, source, source.generation);
      page.dirty.push(entry);
    } else this.dirtyPage(page);
  }
  /** Send deferred tile rectangles; without a renderer the pages re-upload.
   * Array layers take one texSubImage3D per rectangle under one pixel-store
   * setup per flush (the same texels copyTextureToTexture sends, without its
   * per-call state round trips). Each call gets a view of exactly its
   * rectangle's bytes: Firefox copies the whole source view per call
   * whatever the unpack state selects, so a 4 MB page with skipped rows
   * cost Training 20-39 ms per frame once a mirror lifted the light-map
   * frustum test (docs/play-frame-cost.md). */
  flush(renderer) {
    let array = null;
    for (const page of this.pages) {
      if (!page.dirty.length) continue;
      let rects = page.dirty; page.dirty = [];
      if (!renderer) { this.dirtyPage(page); continue; }
      // Many rectangles: resend the page's whole layer instead.
      const whole = rects.length > 256;
      if (whole) rects = [[0, 0, this.size, this.size]];
      for (const [x, y, width, height] of rects) {
        if (!page.uploaded) continue;
        if (whole) { page.texture.needsUpdate = true; break; }
        const region = new THREE.Box2(new THREE.Vector2(x, y), new THREE.Vector2(x + width, y + height));
        renderer.copyTextureToTexture(page.staging, page.texture, region, new THREE.Vector2(x, y));
      }
      if (!this.arrayUploaded) continue;
      array ??= this.beginArrayUpload(renderer);
      if (!array) { this.dirtyPage(page); continue; }
      const { gl } = array;
      for (const rect of rects) {
        const [x, y, width, height] = rect;
        // (The packed texels of a deferred rectangle, while they are intact and their memory has not been detached: writePacked.)
        const direct = rect.length > 4 && rect[6].generation === rect[7] && rect[4].buffer.byteLength > 0;
        if (direct) this.packedUploads++;
        const packed = direct ? new Uint8Array(rect[4].buffer, rect[4].byteOffset + rect[5] * 4, width * height * 4) : this.rectangle(page.pixels, x, y, width, height);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, page.index, width, height, 1, gl.RGBA, gl.UNSIGNED_BYTE, packed);
      }
    }
  }
  /** A rectangle's texels as one tightly packed view: full-width rows are
   * already contiguous in the page, others are copied into the scratch. */
  rectangle(pixels, x, y, width, height) {
    const size = this.size, row = width * 4;
    if (width === size) return pixels.subarray(y * size * 4, (y + height) * size * 4);
    if (this.scratch.length < row * height) this.scratch = new Uint8Array(row * height);
    for (let r = 0; r < height; r++) {
      const start = ((y + r) * size + x) * 4;
      this.scratch.set(pixels.subarray(start, start + row), r * row);
    }
    return this.scratch.subarray(0, row * height);
  }
  /** Bind the uploaded array on unit 0 through three's state cache, with the
   * unpack state copyTextureToTexture would set. Null when three still owes
   * the array a full upload (that upload carries every dirty texel). */
  beginArrayUpload(renderer) {
    const texture = this.arrayUniform.value, properties = renderer.properties.get(texture);
    if (!properties.__webglTexture || properties.__version !== texture.version) return null;
    const gl = renderer.getContext(), state = renderer.state;
    state.activeTexture(gl.TEXTURE0);
    state.bindTexture(gl.TEXTURE_2D_ARRAY, properties.__webglTexture, gl.TEXTURE0);
    state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);
    state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, texture.premultiplyAlpha);
    state.pixelStorei(gl.UNPACK_ALIGNMENT, texture.unpackAlignment);
    // Rectangles arrive tightly packed (rectangle()).
    for (const name of ['UNPACK_ROW_LENGTH', 'UNPACK_IMAGE_HEIGHT', 'UNPACK_SKIP_PIXELS', 'UNPACK_SKIP_ROWS', 'UNPACK_SKIP_IMAGES'])
      state.pixelStorei(gl[name], 0);
    return { gl, state };
  }
  coordinates(tile, point) {
    if (!tile.enabled) return [0, 0, 0];
    const uv = tile.lightmap.uv(point);
    return [(tile.x + uv[0]) / this.size, (tile.y + uv[1]) / this.size, 1];
  }
  dispose() {
    for (const page of this.pages) { page.texture.dispose(); page.staging.dispose(); }
    this.arrayUniform.value?.dispose();
  }
}

/** `tracked`: a mover's material, whose vertices carry the brush tracker's
 * points (`deusTracked`, Unreal's axes; docs/frame-projection.md "Movers"). */
export function applyLightAtlas(material, page, enabled, gamma = { value: 1 }, mirror = null, modulated = false, array = null, tracked = false) {
  const stride = array ? array.value.image.depth + 1 : 0;
  // An unbatched surface samples its page's array layer when the atlas has
  // been sealed by the time its program is built (the same texels, linear
  // filtered within one layer), otherwise the page texture.
  const layer = () => !array && page?.layers?.value ? page.layers : null;
  material.customProgramCacheKey = () => `deus-ex-lightmap-v5:${LIGHT_DEBUG ? `${LIGHT_DEBUG}:` : ''}${FRAME_PROJECTION_KEY}:${mirror ? (mirror.opaque ? 'opaque' : 'composite') : ''}:${Boolean(modulated)}:${stride}:${layer() ? 'layer' : ''}${tracked ? ':tracked' : ''}`;
  material.onBeforeCompile = shader => {
    const pageLayers = layer();
    shader.uniforms.deusLightAtlas = array ?? pageLayers ?? { value: page.texture };
    if (pageLayers) shader.uniforms.deusLightPage = { value: page.index };
    shader.uniforms.deusLightingEnabled = enabled;
    shader.uniforms.deusDisplayGamma = gamma;
    if (mirror) {
      shader.uniforms.deusMirror = mirror.texture;
      shader.uniforms.deusMirrorSize = mirror.size;
      shader.uniforms.deusMirrorActive = mirror.active;
    }
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      attribute vec3 lightUV;
      attribute vec4 lightBounds;
      varying vec3 vDeusLightUV;
      varying vec4 vDeusLightBounds;`).replace('#include <begin_vertex>', `#include <begin_vertex>
      vDeusLightUV = lightUV;
      vDeusLightBounds = lightBounds;`);
    const lightSample = array ? 'texture(deusLightAtlas, vec3(lm, float(deusLightLayer - 1)))'
      : pageLayers ? 'texture(deusLightAtlas, vec3(lm, deusLightPage))' : 'texture2D(deusLightAtlas, lm)';
    const lightStatement = LIGHT_DEBUG === 'base' || LIGHT_DEBUG === 'world' ? '' : LIGHT_DEBUG === 'light32'
      ? `gl_FragColor.rgb = min(vec3(1.0), ${lightSample}.rgb * 32.0);` : `gl_FragColor.rgb *= ${lightSample}.rgb * 2.0;`;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      uniform ${array || pageLayers ? 'highp sampler2DArray' : 'sampler2D'} deusLightAtlas;
      ${pageLayers ? 'uniform float deusLightPage;' : ''}
      uniform float deusLightingEnabled;
      uniform float deusDisplayGamma;
      ${mirror ? 'uniform sampler2D deusMirror; uniform vec2 deusMirrorSize; uniform float deusMirrorActive;' : ''}
      varying vec3 vDeusLightUV;
      varying vec4 vDeusLightBounds;`).replace('#include <colorspace_fragment>', `
      // The textures hold the original's 8-bit display-space values and are
      // filtered as such (original-sampling.mjs: no sRGB decode), so the colour
      // is already what the framebuffer and the mirror targets hold.
      ${REENCODE_GLSL}
      // The original fixed-function renderer modulates display-encoded texture colours.
      ${array ? `highp int deusLightLayer = int(floor(vDeusLightUV.z + 0.5)) % ${stride};` : ''}
      if (deusLightingEnabled > 0.5 && ${array ? 'deusLightLayer > 0' : 'vDeusLightUV.z > 0.5'}) {
        vec2 lm = clamp(vDeusLightUV.xy, vDeusLightBounds.xy, vDeusLightBounds.zw);
        ${lightStatement}
      }${LIGHT_DEBUG === 'light32' ? ' else { gl_FragColor.rgb = vec3(1.0); }' : ''}
      ${mirror ? `if (deusMirrorActive > 0.5) {
        vec2 mirrorUV = gl_FragCoord.xy / deusMirrorSize;
        vec3 reflection = texture2D(deusMirror, vec2(1.0 - mirrorUV.x, mirrorUV.y)).rgb;
        ${mirror.opaque ? `gl_FragColor.rgb = reflection;` : `vec3 floorColor = clamp(gl_FragColor.rgb, 0.0, 1.0);
        gl_FragColor.rgb = floorColor + reflection * (1.0 - floorColor);`}
      }` : ''}
      ${LIGHT_DEBUG === 'world' ? 'gl_FragColor.rgb = vec3(1.0);' : ''}${displayRampGlsl('deusDisplayGamma', modulated)}`);
    // The original's vertex projection (docs/frame-projection.md).
    frameProjection.patch(shader, { tracked });
  };
}

/** The display gamma ramp (D3DDrv 0x2e3e) applies to the finished framebuffer,
 * after blending: SetGammaRamp on the primary surface, so the HUD and every
 * blended pass are composed before it. By default Play draws raw colours and
 * applies the ramp once to the finished 8-bit frame (display-ramp.mjs), and
 * this returns no code. `?gamma=material` keeps the earlier per-fragment ramp:
 * exact for opaque output and for PF_Modulated, whose SetBlending state
 * (0x1000837a: DESTCOLOR, SRCCOLOR) stores 2*src*dst, so emitting
 * pow(2*src, g)/2 blends to pow(2*src*dst, g) (the masked-out character
 * glasses rely on this, with GrayMaskTex (128) blending to the unchanged
 * background; for g > 1, src > 2^(1/g)/2 clamps), but not for the additive
 * passes (fog, coronas, translucent surfaces) or the HUD. */
let rampPerFragment = false;
export function setDisplayRampPerFragment(enabled) { rampPerFragment = Boolean(enabled); }
export function displayRampGlsl(gamma, modulated) {
  if (!rampPerFragment) return '';
  return modulated
    ? `gl_FragColor.rgb = 0.5 * pow(max(2.0 * gl_FragColor.rgb, vec3(0.0)), vec3(${gamma}));`
    : `gl_FragColor.rgb = pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(${gamma}));`;
}
