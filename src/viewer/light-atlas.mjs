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
    const page = { index: this.pages.length, texture, pixels, x: 0, y: 0, rowHeight: 0 };
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
    for (let row = -1; row <= lightmap.height; row++) for (let col = -1; col <= lightmap.width; col++) {
      const src = (Math.max(0, Math.min(lightmap.height - 1, row)) * lightmap.width + Math.max(0, Math.min(lightmap.width - 1, col))) * 3;
      const dst = ((y + row) * this.size + x + col) * 4;
      for (let c = 0; c < 3; c++) page.pixels[dst + c] = Math.round(Math.max(0, Math.min(1, lightmap.pixels[src + c])) * 255);
      page.pixels[dst + 3] = 255;
    }
    page.x += width; page.rowHeight = Math.max(page.rowHeight, height); page.texture.needsUpdate = true;
    const tile = { page, enabled: true, x, y, lightmap,
      bounds: [(x + .5) / this.size, (y + .5) / this.size, (x + lightmap.width - .5) / this.size, (y + lightmap.height - .5) / this.size] };
    this.tiles.set(lightmap, tile); return tile;
  }
  coordinates(tile, point) {
    if (!tile.enabled) return [0, 0, 0];
    const uv = tile.lightmap.uv(point);
    return [(tile.x + uv[0]) / this.size, (tile.y + uv[1]) / this.size, 1];
  }
  dispose() { for (const page of this.pages) page.texture.dispose(); }
}

export function applyLightAtlas(material, page, enabled, gamma = { value: 1 }) {
  material.customProgramCacheKey = () => 'deus-ex-lightmap-v1';
  material.onBeforeCompile = shader => {
    shader.uniforms.deusLightAtlas = { value: page.texture };
    shader.uniforms.deusLightingEnabled = enabled;
    shader.uniforms.deusDisplayGamma = gamma;
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
      varying vec3 vDeusLightUV;
      varying vec4 vDeusLightBounds;`).replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
      // The original fixed-function renderer modulates display-encoded texture colours.
      if (deusLightingEnabled > 0.5 && vDeusLightUV.z > 0.5) {
        vec2 lm = clamp(vDeusLightUV.xy, vDeusLightBounds.xy, vDeusLightBounds.zw);
        gl_FragColor.rgb *= texture2D(deusLightAtlas, lm).rgb * 2.0;
      }
      gl_FragColor.rgb = pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(deusDisplayGamma));`);
  };
}
