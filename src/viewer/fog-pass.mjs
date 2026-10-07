import * as THREE from 'three';
import { getAxes } from '../runtime/camera.mjs';
import { movingLightConstants } from '../runtime/dynamic-lighting.mjs';
import { coordsTransform, volumetricLight, fogMap, fogMapKernel } from '../runtime/volumetric-fog.mjs';
import { displayRampGlsl } from './light-atlas.mjs';
import { lightmapBasis } from '../unreal/lighting.mjs';
import { toView } from '../unreal/geometry.mjs';

/** Volumetric fog in Play (docs/volumetric-fog.md "Play"): the fog map of
 * every drawn light-mapped surface in a bFogZone zone, recomputed each frame
 * from the frame's coords (SetupForSurf's fog loop, fog.rs through the
 * script-VM kernel), drawn as D3D's PF_Highlighted pass (ONE, INVSRCALPHA,
 * Z writes) over the surface. A level surface's fog map shares its light
 * map's texel grid, so its atlas mirrors the light atlas tiles and samples
 * the same light UVs.
 *
 * Movers (the brush tracker's surfaces): SetupForSurf runs once per draw
 * item, so each mover draw item in a bFogZone zone (its own iZone) gets its
 * own fog map and draws it over its own fragments. The lattice is the level
 * surfaces' one over the tracker surface's pBase and vectors, with the
 * light-map index taken from the mover's Brush (0x10b06e2c..0x10b06e4a).
 * Each item's map lives in its own small texture.
 *
 * Host choices, noted: every volumetric light of the map is linked to every
 * fog surface (LeafVolumetricLighting's and OccludeBsp's culls only drop
 * lights that add nothing); volumetric lights use their steady LightBrightness
 * (GlobalLighting's LightType animation is not applied to them); within a
 * frame the level surfaces' maps are computed in their collection order,
 * then the mover items' in draw-list order. The display ramp maps the
 * finished frame after the pass blends (display-ramp.mjs), unless
 * ?gamma=material. */
export function createFogPass({ lightAtlas, levelBrightness, hsv, displayGamma, notes, kernel = null }) {
  const root = new THREE.Group(), surfaces = [], lights = [], pages = new Map(), moverPolygons = new Map();
  root.name = 'Volumetric fog'; root.matrixAutoUpdate = false;
  const stats = { surfaces: 0, moverPolygons: 0, lights: 0, drawn: 0, texels: 0, kernel: Boolean(kernel) };
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
  function material(uniform) {
    const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: true, depthFunc: THREE.LessEqualDepth });
    m.blending = THREE.CustomBlending; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
    m.customProgramCacheKey = () => 'deus-ex-fog-v1';
    m.onBeforeCompile = shader => {
      shader.uniforms.deusFog = uniform; shader.uniforms.deusDisplayGamma = displayGamma;
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
  /** A mover polygon's light-map basis over the tracker surface's `facet`
   * (pBase, vTextureU, vTextureV, vNormal) and the Brush's light-map index. */
  function moverBasis(record, facet) {
    const model = { points: [facet.slice(0, 3)], vectors: [facet.slice(3, 6), facet.slice(6, 9), facet.slice(9, 12)] };
    return lightmapBasis(model, { base: 0, textureU: 0, textureV: 1, normal: 2 }, record.lightMap);
  }
  /** Its lattice: lighting.mjs geometry's p00, p10 and p01. */
  function moverGrid(basis) {
    const p00 = basis.point(0, 0), p10 = basis.point(1, 0), p01 = basis.point(0, 1);
    return { start: p00.map(Math.fround), stepU: p10.map((v, i) => Math.fround(v - p00[i])), stepV: p01.map((v, i) => Math.fround(v - p00[i])) };
  }
  // The child frames' level-surface maps of the last update (frame index to
  // [{surface, texels}]), the tiles a child pass replaced, and the mover
  // items' meshes (each with the frame it belongs to).
  let childMaps = new Map(), passTiles = null, itemsUsed = 0;
  const items = [], sources = new Map(), region = new THREE.Box2(), at = new THREE.Vector2();
  /** DrawFrame's order: a frame's children (in their list order, which is
   * the order OccludeFrame visits them) before the frame; the root (0) last
   * and not listed. */
  function drawOrder(frames) {
    const out = [], visit = parent => {
      for (const frame of frames) if (frame.parent === parent) { visit(frame.index); out.push(frame); }
    };
    visit(0);
    return out;
  }
  /** Each volumetric light's constants under a frame's coords (ComputeFromActor). */
  function lightInputs(coords) {
    return lights.map(light => ({ location: coordsTransform(light.location, coords), color: light.color,
      brightness: Math.fround(light.brightness), volumeRadius: light.values.VolumeRadius ?? 0,
      volumeBrightness: light.values.VolumeBrightness ?? 64, volumeFog: light.values.VolumeFog ?? 0 }));
  }
  function lightsFor(coords) { return lightInputs(coords).map(volumetricLight); }
  function fogInput(record, grid, coords, frameLights, state) {
    return { grid: { base: grid.start, stepU: grid.stepU, stepV: grid.stepV }, width: record.width,
      height: record.height, coords, lights: frameLights, state };
  }
  /** Validation (validate-volumetric-fog-play.mjs): the most fogged map of
   * a kind this update, with the loop's inputs for the oracle. */
  function note(key, what, texels, input, missFlag, coords) {
    let alpha = 0;
    for (let t = 3; t < texels.length; t += 4) alpha += texels[t];
    if (alpha && alpha > (stats[key]?.alpha ?? 0))
      stats[key] = { ...what, alpha, missFlag, grid: input.grid, width: input.width, height: input.height, coords,
        lights: lightInputs(coords), texels: Array.from(texels) };
  }
  /** BGRA texels into an RGBA buffer of row length `stride` at (x, y), the
   * one-texel padding repeated. */
  function writeTile(pixels, stride, x, y, record, texels) {
    for (let row = -1; row <= record.height; row++) for (let col = -1; col <= record.width; col++) {
      const src = (Math.max(0, Math.min(record.height - 1, row)) * record.width + Math.max(0, Math.min(record.width - 1, col))) * 4;
      const dst = ((y + row) * stride + x + col) * 4;
      pixels[dst] = texels[src + 2]; pixels[dst + 1] = texels[src + 1];
      pixels[dst + 2] = texels[src]; pixels[dst + 3] = texels[src + 3];
    }
  }
  /** The root frame's texels of a page as an upload source (never uploaded itself). */
  function mainSource(fogPage) {
    if (!sources.has(fogPage)) {
      const texture = new THREE.DataTexture(fogPage.pixels, size, size, THREE.RGBAFormat);
      texture.flipY = false;
      sources.set(fogPage, texture);
    }
    return sources.get(fogPage);
  }
  /** A surface's padded tile from `source` at (sx, sy) into its page texture. */
  function copyTile(renderer, surface, source, sx, sy) {
    const { record, tile } = surface;
    region.min.set(sx, sy); region.max.set(sx + record.width + 2, sy + record.height + 2);
    at.set(tile.x - 1, tile.y - 1);
    renderer.copyTextureToTexture(source, surface.fogPage.texture, region, at);
  }
  /** The level surfaces' maps of one frame: `drawn` its surface indices
   * (and `frustum`, for the root frame without occlusion). */
  function levelMaps(drawn, frustum, coords, frameLights, state, each) {
    for (const surface of surfaces) {
      if ((drawn && !drawn.has(surface.surfaceIndex)) || (frustum && !frustum.intersectsObject(surface.mesh))) continue;
      const input = fogInput(surface.record, surface.record.fogGrid().grid, coords, frameLights, state), missFlag = state.missFlag;
      const texels = kernel ? fogMapKernel(kernel, input) : fogMap(input);
      if (texels) each(surface, texels, input, missFlag);
    }
  }
  /** The mover draw items' maps of one frame (sim-session.mjs moverItems):
   * an item in a bFogZone zone, of a lit polygon, gets one. Each goes to a
   * mesh over the item's fragments tagged with `frame`. */
  function moverMaps(moverItems, fogZone, coords, frameLights, state, frame, each) {
    for (const item of moverItems ?? []) {
      const record = moverPolygons.get(`${item.mover}:${item.polygon}`);
      if (!record || !item.facet || !fogZone?.(item.zone)) continue;
      const basis = moverBasis(record, item.facet);
      const input = fogInput(record, moverGrid(basis), coords, frameLights, state), missFlag = state.missFlag;
      const texels = kernel ? fogMapKernel(kernel, input) : fogMap(input);
      if (!texels) continue;
      itemMesh(item, record, basis, texels, frame);
      each(item, texels, input, missFlag, basis);
    }
  }
  /** The next pooled item mesh: the item's fragments (fans, view space),
   * its map in a padded texture of its own, and light UVs into it from the
   * basis (lightmapBasis.uv: texel centres at +0.5). */
  function itemMesh(item, record, basis, texels, frame) {
    let slot = items[itemsUsed];
    if (!slot) {
      const uniform = { value: null }, mesh = new THREE.Mesh(new THREE.BufferGeometry(), material(uniform));
      mesh.matrixAutoUpdate = false; mesh.renderOrder = 1; mesh.frustumCulled = false;
      root.add(mesh);
      slot = items[itemsUsed] = { mesh, uniform, texture: null, width: 0, height: 0 };
    }
    itemsUsed++;
    const w = record.width + 2, h = record.height + 2;
    if (slot.width !== w || slot.height !== h) {
      slot.texture?.dispose();
      slot.texture = new THREE.DataTexture(new Uint8Array(w * h * 4), w, h, THREE.RGBAFormat);
      slot.texture.minFilter = slot.texture.magFilter = THREE.LinearFilter;
      slot.texture.generateMipmaps = false; slot.texture.flipY = false; slot.texture.colorSpace = THREE.NoColorSpace;
      slot.uniform.value = slot.texture; slot.width = w; slot.height = h;
    }
    writeTile(slot.texture.image.data, w, 1, 1, record, texels);
    slot.texture.needsUpdate = true;
    const positions = [], uvs = [], bounds = [], box = [1.5 / w, 1.5 / h, (w - 1.5) / w, (h - 1.5) / h];
    for (const points of item.fragments) {
      const vertex = k => {
        const p = [points[3 * k], points[3 * k + 1], points[3 * k + 2]], uv = basis.uv(p);
        positions.push(...toView(p)); uvs.push((1 + uv[0]) / w, (1 + uv[1]) / h, 1); bounds.push(...box);
      };
      for (let k = 1; k + 1 < points.length / 3; k++) { vertex(0); vertex(k); vertex(k + 1); }
    }
    const geometry = slot.mesh.geometry;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('lightUV', new THREE.Float32BufferAttribute(uvs, 3));
    geometry.setAttribute('lightBounds', new THREE.Float32BufferAttribute(bounds, 4));
    slot.frame = frame; slot.mesh.visible = frame === 0;
  }
  return {
    root, stats,
    /** A light-mapped level surface in a fog zone: its light-map record, atlas
     * tile and the surface triangles' view positions, light UVs and bounds. */
    addSurface(record, tile, positions, lightUV, lightBounds, surfaceIndex = -1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('lightUV', new THREE.Float32BufferAttribute(lightUV, 3));
      geometry.setAttribute('lightBounds', new THREE.Float32BufferAttribute(lightBounds, 4));
      geometry.computeBoundingSphere();
      const fogPage = page(tile.page.index), mesh = new THREE.Mesh(geometry, material(fogPage.uniform));
      mesh.matrixAutoUpdate = false; mesh.visible = false; mesh.renderOrder = 1;
      root.add(mesh);
      surfaces.push({ record, tile, mesh, fogPage, surfaceIndex });
      stats.surfaces = surfaces.length;
    },
    /** A lit mover polygon (its light-map record from the Brush's model):
     * its draw items get fog maps over their fragments. */
    addMoverPolygon(record, mover, polygon) {
      moverPolygons.set(`${mover}:${polygon}`, record);
      stats.moverPolygons = moverPolygons.size;
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
     * map only for a surface DrawFrame draws. `moverItems` (sim-session.mjs
     * visibility, with the brush tracker) are the frame's mover draw items;
     * `fogZone(zone)` whether a zone's actor is bFogZone.
     *
     * `frames` (OccludeFrame's child frames, with ?childFrames on) and
     * `nodeSurface` give each child frame its own fog maps: SetupForSurf
     * takes the frame DrawFrame is drawing (0x10b06d3d stores it at
     * 0x10b38a7c) and its fog loop and ComputeFromActor read that frame's
     * Coords. DrawFrame draws a frame's children (Child, then each
     * Sibling, 0x10b1a336..0x10b1a348) before its own lists, so the maps
     * are computed in that order, the root frame last, with the early-out
     * flag carried through. `framePass(frame, renderer)` puts a child
     * frame's maps in place for its pass. */
    update(view, frustum, drawn = null, { moverItems = null, fogZone = null, frames = null, nodeSurface = null } = {}) {
      stats.drawn = 0; stats.texels = 0; stats.movers = 0; stats.moverCase = null; stats.frameMaps = 0; stats.frameCase = null;
      childMaps = new Map(); itemsUsed = 0;
      for (const slot of items) slot.mesh.visible = false;
      if ((!surfaces.length && !moverPolygons.size) || !lights.length) return;
      const state = { missFlag: 0 };
      if (frames && nodeSurface) {
        for (const frame of drawOrder(frames)) {
          if (!frame.coords) continue;
          const c = frame.coords;
          const coords = { origin: c.slice(0, 3), x: c.slice(3, 6), y: c.slice(6, 9), z: c.slice(9, 12) };
          const frameLights = lightsFor(coords), here = new Set(Array.from(frame.nodes, node => nodeSurface[node]));
          const maps = [], what = { frame: frame.index, kind: frame.kind };
          levelMaps(here, null, coords, frameLights, state, (surface, texels, input, missFlag) => {
            maps.push({ surface, texels: Uint8Array.from(texels) });
            stats.frameMaps++;
            note('frameCase', { ...what, surface: surface.surfaceIndex }, texels, input, missFlag, coords);
          });
          moverMaps(frame.moverItems, fogZone, coords, frameLights, state, frame.index, (item, texels, input, missFlag) => {
            stats.frameMaps++;
            note('frameCase', { ...what, mover: item.mover, polygon: item.polygon }, texels, input, missFlag, coords);
          });
          childMaps.set(frame.index, maps);
        }
      }
      // The root frame, drawn last.
      const [x, y, z] = getAxes(view.rotation.map(v => v | 0));
      // ViewCoords (0,1,0), (0,0,-1), (1,0,0) under the view rotation.
      const coords = { origin: view.location.map(Math.fround), x: y, y: z.map(v => -v), z: x };
      const frameLights = lightsFor(coords), dirty = new Set();
      for (const surface of surfaces) surface.mainVisible = surface.mesh.visible = false;
      levelMaps(drawn, frustum, coords, frameLights, state, (surface, texels) => {
        const { record, tile, mesh, fogPage } = surface;
        writeTile(fogPage.pixels, size, tile.x, tile.y, record, texels);
        dirty.add(fogPage);
        surface.mainVisible = mesh.visible = true; stats.drawn++; stats.texels += record.width * record.height;
      });
      moverMaps(moverItems, fogZone, coords, frameLights, state, 0, (item, texels, input, missFlag, basis) => {
        stats.movers++; stats.texels += input.width * input.height;
        // Validation (validate-volumetric-fog-play.mjs): the frame's most
        // fogged mover item, with the loop's inputs for the oracle and its
        // fragments' light-map coordinates (texel units) on the map.
        const uv = item.fragments.flatMap(points => Array.from({ length: points.length / 3 },
          (_, k) => basis.uv([points[3 * k], points[3 * k + 1], points[3 * k + 2]])));
        note('moverCase', { mover: item.mover, polygon: item.polygon, zone: item.zone, fragments: item.fragments.length,
          uvRange: [Math.min(...uv.map(p => p[0])), Math.min(...uv.map(p => p[1])), Math.max(...uv.map(p => p[0])), Math.max(...uv.map(p => p[1]))] },
          texels, input, missFlag, coords);
      });
      for (const fogPage of dirty) fogPage.texture.needsUpdate = true;
    },
    /** A child frame's pass (`frame` a record of `update`'s frames), or the
     * end of one (null): its level-surface maps go into the atlas tiles they
     * share with the root frame's, only its own fog meshes and mover items
     * draw, and at the end the root frame's tiles and meshes come back. */
    framePass(frame, renderer) {
      if (!frame) {
        if (!passTiles) return;
        for (const surface of passTiles) copyTile(renderer, surface, mainSource(surface.fogPage), surface.tile.x - 1, surface.tile.y - 1);
        for (const surface of surfaces) surface.mesh.visible = surface.mainVisible ?? false;
        for (let i = 0; i < itemsUsed; i++) items[i].mesh.visible = items[i].frame === 0;
        passTiles = null;
        return;
      }
      const maps = childMaps.get(frame.index);
      if (!maps) return;
      passTiles = [];
      for (const surface of surfaces) surface.mesh.visible = false;
      for (let i = 0; i < itemsUsed; i++) items[i].mesh.visible = items[i].frame === frame.index;
      for (const { surface, texels } of maps) {
        const { record } = surface;
        surface.scratch ??= (() => {
          const pixels = new Uint8Array((record.width + 2) * (record.height + 2) * 4);
          const texture = new THREE.DataTexture(pixels, record.width + 2, record.height + 2, THREE.RGBAFormat);
          texture.flipY = false;
          return { pixels, texture };
        })();
        writeTile(surface.scratch.pixels, record.width + 2, 1, 1, record, texels);
        copyTile(renderer, surface, surface.scratch.texture, 0, 0);
        surface.mesh.visible = true;
        passTiles.push(surface);
      }
    },
    dispose() {
      for (const { mesh } of surfaces) { mesh.geometry.dispose(); mesh.material.dispose(); }
      for (const { mesh, texture } of items) { mesh.geometry.dispose(); mesh.material.dispose(); texture?.dispose(); }
      for (const { texture } of pages.values()) texture.dispose();
    },
  };
}
