import * as THREE from 'three';

/** Padded lightmap tiles share texture pages; sample bounds prevent atlas bleeding. */
export class LightAtlas {
  constructor(size = 1024) { this.size = size; this.pages = []; this.tiles = new WeakMap(); this.addPage(); }
  addPage() {
    const pixels = new Uint8Array(this.size * this.size * 4);
    const texture = new THREE.DataTexture(pixels, this.size, this.size, THREE.RGBAFormat);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false; texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    // The staging texture shares the pixels but never renders, so the
    // renderer copies its rectangles from memory, not by framebuffer.
    const staging = new THREE.DataTexture(pixels, this.size, this.size, THREE.RGBAFormat);
    const page = { index: this.pages.length, texture, staging, pixels, x: 0, y: 0, rowHeight: 0, uploaded: false, dirty: [] };
    texture.onUpdate = () => { page.uploaded = true; };
    this.pages.push(page); return page;
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
   * copy per tile instead of re-uploading the page. */
  update(lightmap, { partial = false, region = null } = {}) {
    const tile = this.tiles.get(lightmap);
    if (!tile) throw new Error('Lightmap is not allocated in this atlas');
    if (lightmap.width !== tile.width || lightmap.height !== tile.height)
      throw new Error('Updating a lightmap cannot change its atlas dimensions');
    const {page, x, y} = tile;
    // A region (source texel rectangle) also refreshes the padding it borders.
    const [left, right] = region ? [region.minU ? region.minU : -1, region.maxU < lightmap.width ? region.maxU - 1 : lightmap.width] : [-1, lightmap.width];
    const [top, bottom] = region ? [region.minV ? region.minV : -1, region.maxV < lightmap.height ? region.maxV - 1 : lightmap.height] : [-1, lightmap.height];
    for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) {
      const src = (Math.max(0, Math.min(lightmap.height - 1, row)) * lightmap.width + Math.max(0, Math.min(lightmap.width - 1, col))) * 3;
      const dst = ((y + row) * this.size + x + col) * 4;
      for (let c = 0; c < 3; c++) page.pixels[dst + c] = Math.round(Math.max(0, Math.min(1, lightmap.pixels[src + c])) * 255);
      page.pixels[dst + 3] = 255;
    }
    if (partial && page.uploaded) page.dirty.push([x + left, y + top, right - left + 1, bottom - top + 1]);
    else page.texture.needsUpdate = true;
    return tile;
  }
  /** Send deferred tile rectangles; without a renderer the pages re-upload. */
  flush(renderer) {
    for (const page of this.pages) {
      if (!page.dirty.length) continue;
      const rects = page.dirty; page.dirty = [];
      if (!renderer || rects.length > 256) { page.texture.needsUpdate = true; continue; }
      for (const [x, y, width, height] of rects) {
        const region = new THREE.Box2(new THREE.Vector2(x, y), new THREE.Vector2(x + width, y + height));
        renderer.copyTextureToTexture(page.staging, page.texture, region, new THREE.Vector2(x, y));
      }
    }
  }
  coordinates(tile, point) {
    if (!tile.enabled) return [0, 0, 0];
    const uv = tile.lightmap.uv(point);
    return [(tile.x + uv[0]) / this.size, (tile.y + uv[1]) / this.size, 1];
  }
  dispose() { for (const page of this.pages) page.texture.dispose(); }
}

export function applyLightAtlas(material, page, enabled, gamma = { value: 1 }, mirror = null) {
  material.customProgramCacheKey = () => `deus-ex-lightmap-v2:${Boolean(mirror)}`;
  material.onBeforeCompile = shader => {
    shader.uniforms.deusLightAtlas = { value: page.texture };
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
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D deusLightAtlas;
      uniform float deusLightingEnabled;
      uniform float deusDisplayGamma;
      ${mirror ? 'uniform sampler2D deusMirror; uniform vec2 deusMirrorSize; uniform float deusMirrorActive;' : ''}
      varying vec3 vDeusLightUV;
      varying vec4 vDeusLightBounds;`).replace('#include <colorspace_fragment>', `
      // Offscreen mirror targets need the same encoded colours as the main
      // framebuffer; Three normally leaves render-target colours linear.
      gl_FragColor = sRGBTransferOETF(gl_FragColor);
      // The original fixed-function renderer modulates display-encoded texture colours.
      if (deusLightingEnabled > 0.5 && vDeusLightUV.z > 0.5) {
        vec2 lm = clamp(vDeusLightUV.xy, vDeusLightBounds.xy, vDeusLightBounds.zw);
        gl_FragColor.rgb *= texture2D(deusLightAtlas, lm).rgb * 2.0;
      }
      ${mirror ? `if (deusMirrorActive > 0.5) {
        vec3 reflection = texture2D(deusMirror, gl_FragCoord.xy / deusMirrorSize).rgb;
        vec3 floorColor = clamp(gl_FragColor.rgb, 0.0, 1.0);
        gl_FragColor.rgb = floorColor + reflection * (1.0 - floorColor);
      }` : ''}
      gl_FragColor.rgb = pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(deusDisplayGamma));`);
  };
}
