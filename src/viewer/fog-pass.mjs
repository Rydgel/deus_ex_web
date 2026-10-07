import * as THREE from 'three';
import { getAxes } from '../runtime/camera.mjs';
import { movingLightConstants } from '../runtime/dynamic-lighting.mjs';
import { coordsTransform, volumetricLight, fogMap, fogMapKernel } from '../runtime/volumetric-fog.mjs';
import { displayRampGlsl } from './light-atlas.mjs';
import { lightmapBasis } from '../unreal/lighting.mjs';

/** Volumetric fog in Play (docs/volumetric-fog.md "Play"): the fog map of
 * every drawn light-mapped surface in a bFogZone zone, recomputed each frame
 * from the frame's coords (SetupForSurf's fog loop, fog.rs through the
 * script-VM kernel), drawn as D3D's PF_Highlighted pass (ONE, INVSRCALPHA,
 * Z writes) over the surface. The fog map shares the light map's texel grid,
 * so its atlas mirrors the light atlas tiles and samples the same light UVs.
 *
 * Host choices, noted: every volumetric light of the map is linked to every
 * fog surface (LeafVolumetricLighting's and OccludeBsp's culls only drop
 * lights that add nothing); volumetric lights use their steady LightBrightness
 * (GlobalLighting's LightType animation is not applied to them). A mover
 * polygon (the brush tracker's surface) is fogged when the frame draws one
 * of its fragments in a fog zone. Its lattice is the level surfaces' one
 * over the tracker surface's pBase and vectors, with the light-map index
 * taken from the mover's Brush (SetupForSurf, 0x10b06e2c..0x10b06e4a); the
 * whole polygon draws that one fog map. The display ramp maps the finished
 * frame after the pass blends (display-ramp.mjs), unless ?gamma=material. */
export function createFogPass({ lightAtlas, levelBrightness, hsv, displayGamma, notes, kernel = null }) {
  const root = new THREE.Group(), surfaces = [], lights = [], pages = new Map();
  root.name = 'Volumetric fog'; root.matrixAutoUpdate = false;
  const stats = { surfaces: 0, lights: 0, drawn: 0, texels: 0, kernel: Boolean(kernel) };
  const size = lightAtlas.size;
  function page(index) {
    if (!pages.has(index)) {
      const pixels = new Uint8Array(size * size * 4);
      const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false; texture.flipY = false; texture.colorSpace = THREE.NoColorSpace;
      pages.set(index, { pixels, texture, uniform: { value: texture } });
    }
    return pages.get(index);
  }
  function material(fogPage) {
    const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: true, depthFunc: THREE.LessEqualDepth });
    m.blending = THREE.CustomBlending; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
    m.customProgramCacheKey = () => 'deus-ex-fog-v1';
    m.onBeforeCompile = shader => {
      shader.uniforms.deusFog = fogPage.uniform; shader.uniforms.deusDisplayGamma = displayGamma;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        attribute vec3 lightUV; attribute vec4 lightBounds; varying vec2 vDeusFogUV; varying vec4 vDeusFogBounds;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vDeusFogUV = lightUV.xy; vDeusFogBounds = lightBounds;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
        uniform sampler2D deusFog; uniform float deusDisplayGamma; varying vec2 vDeusFogUV; varying vec4 vDeusFogBounds;`)
        .replace('#include <colorspace_fragment>', `
        // Seven-bit fog channels, doubled like the light map's.
        vec4 deusFogTexel = texture2D(deusFog, clamp(vDeusFogUV, vDeusFogBounds.xy, vDeusFogBounds.zw)) * 2.0;
        gl_FragColor = vec4(min(deusFogTexel.rgb, vec3(1.0)), min(deusFogTexel.a, 1.0));
        ${displayRampGlsl('deusDisplayGamma', false)}`);
    };
    return m;
  }
  /** A mover polygon's light-map grid: lighting.mjs geometry's p00, p10
   * and p01 over the tracker surface's `facet` (pBase, vTextureU,
   * vTextureV, vNormal) and the Brush's light-map index. */
  function moverGrid(record, facet) {
    const model = { points: [facet.slice(0, 3)], vectors: [facet.slice(3, 6), facet.slice(6, 9), facet.slice(9, 12)] };
    const basis = lightmapBasis(model, { base: 0, textureU: 0, textureV: 1, normal: 2 }, record.lightMap);
    const p00 = basis.point(0, 0), p10 = basis.point(1, 0), p01 = basis.point(0, 1);
    return { start: p00.map(Math.fround), stepU: p10.map((v, i) => Math.fround(v - p00[i])), stepV: p01.map((v, i) => Math.fround(v - p00[i])) };
  }
  return {
    root, stats,
    /** A light-mapped level surface in a fog zone: its light-map record, atlas
     * tile and the surface triangles' view positions, light UVs and bounds. */
    addSurface(record, tile, positions, lightUV, lightBounds, surfaceIndex = -1, mover = null) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('lightUV', new THREE.Float32BufferAttribute(lightUV, 3));
      geometry.setAttribute('lightBounds', new THREE.Float32BufferAttribute(lightBounds, 4));
      geometry.computeBoundingSphere();
      const fogPage = page(tile.page.index), mesh = new THREE.Mesh(geometry, material(fogPage));
      mesh.matrixAutoUpdate = false; mesh.visible = false; mesh.renderOrder = 1;
      // A mover polygon's pass follows its group (its brush-local positions).
      (mover?.parent ?? root).add(mesh);
      surfaces.push({ record, tile, mesh, fogPage, state: null, surfaceIndex, mover: mover ? mover.name : null });
      stats.surfaces = surfaces.length;
    },
    /** A light with VolumeRadius > 0 (class defaults merged). */
    addLight(values) {
      lights.push({ values, location: (values.Location ?? [0, 0, 0]).map(Math.fround),
        color: movingLightConstants(values, levelBrightness, hsv(values.LightHue ?? 0, values.LightSaturation ?? 0)).color,
        brightness: Math.fround((values.LightBrightness ?? 64) & 255) * Math.fround(1 / 255) });
      stats.lights = lights.length;
    },
    /** One frame: `view` {location, rotation} is the frame's eye and view
     * rotation (FSceneNode Coords = ViewCoords / ViewRotation), `frustum`
     * the drawn view's three.js frustum, `drawn` (optional) the main
     * frame's drawn surfaces from OccludeBsp: SetupForSurf computes a fog
     * map only for a surface DrawFrame draws. `movers`, `moverZones` and
     * `moverFacets` (sim-session.mjs visibility, with the brush tracker) are
     * the drawn mover polygons, their draw items' zones and their surfaces'
     * pBase and vectors; `fogZone(zone)` whether a zone's actor is bFogZone.
     * Without them movers get no fog. */
    update(view, frustum, drawn = null, { movers = null, moverZones = null, moverFacets = null, fogZone = null } = {}) {
      stats.drawn = 0; stats.texels = 0; stats.movers = 0; stats.moverCase = null;
      if (!surfaces.length || !lights.length) return;
      const [x, y, z] = getAxes(view.rotation.map(v => v | 0));
      // ViewCoords (0,1,0), (0,0,-1), (1,0,0) under the view rotation.
      const coords = { origin: view.location.map(Math.fround), x: y, y: z.map(v => -v), z: x };
      const frameLights = lights.map(light => volumetricLight({ location: coordsTransform(light.location, coords), color: light.color,
        brightness: Math.fround(light.brightness), volumeRadius: light.values.VolumeRadius ?? 0,
        volumeBrightness: light.values.VolumeBrightness ?? 64, volumeFog: light.values.VolumeFog ?? 0 }));
      const state = { missFlag: 0 }, dirty = new Set();
      for (const surface of surfaces) {
        const { record, tile, mesh, fogPage } = surface;
        let grid;
        if (surface.mover) {
          const ordinals = movers?.[surface.mover], zones = moverZones?.[surface.mover];
          const facet = moverFacets?.[surface.mover]?.[surface.surfaceIndex];
          if (!ordinals || !fogZone || !facet || !ordinals.some((o, i) => o === surface.surfaceIndex && fogZone(zones[i]))) {
            mesh.visible = false; continue;
          }
          grid = moverGrid(record, facet);
        } else {
          if ((drawn && !drawn.has(surface.surfaceIndex)) || (frustum && !frustum.intersectsObject(mesh))) { mesh.visible = false; continue; }
          ({ grid } = record.fogGrid());
        }
        const input = { grid: { base: grid.start, stepU: grid.stepU, stepV: grid.stepV }, width: record.width, height: record.height,
          coords, lights: frameLights, state };
        const missFlag = state.missFlag, texels = kernel ? fogMapKernel(kernel, input) : fogMap(input);
        if (!texels) { mesh.visible = false; continue; }
        if (surface.mover) {
          stats.movers++;
          // Validation (validate-volumetric-fog-play.mjs): the frame's most
          // fogged mover surface, with the loop's inputs for the oracle.
          let alpha = 0;
          for (let t = 3; t < texels.length; t += 4) alpha += texels[t];
          if (alpha && alpha > (stats.moverCase?.alpha ?? 0))
            stats.moverCase = { mover: surface.mover, polygon: surface.surfaceIndex, alpha, missFlag, grid: input.grid,
              width: record.width, height: record.height, coords, lights: lights.map(light => ({ location: coordsTransform(light.location, coords),
                color: light.color, brightness: Math.fround(light.brightness), volumeRadius: light.values.VolumeRadius ?? 0,
                volumeBrightness: light.values.VolumeBrightness ?? 64, volumeFog: light.values.VolumeFog ?? 0 })),
              texels: Array.from(texels) };
        }
        // BGRA texels into the RGBA page at the light tile, padding repeated.
        for (let row = -1; row <= record.height; row++) for (let col = -1; col <= record.width; col++) {
          const src = (Math.max(0, Math.min(record.height - 1, row)) * record.width + Math.max(0, Math.min(record.width - 1, col))) * 4;
          const dst = ((tile.y + row) * size + tile.x + col) * 4;
          fogPage.pixels[dst] = texels[src + 2]; fogPage.pixels[dst + 1] = texels[src + 1];
          fogPage.pixels[dst + 2] = texels[src]; fogPage.pixels[dst + 3] = texels[src + 3];
        }
        dirty.add(fogPage);
        mesh.visible = true; stats.drawn++; stats.texels += record.width * record.height;
      }
      for (const fogPage of dirty) fogPage.texture.needsUpdate = true;
    },
    dispose() {
      for (const { mesh } of surfaces) { mesh.geometry.dispose(); mesh.material.dispose(); }
      for (const { texture } of pages.values()) texture.dispose();
    },
  };
}
