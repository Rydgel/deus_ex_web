import * as THREE from 'three';
import { getAxes } from '../runtime/camera.mjs';
import { movingLightConstants } from '../runtime/dynamic-lighting.mjs';
import { coordsTransform, volumetricLight, fogMap, fogMapKernel } from '../runtime/volumetric-fog.mjs';
import { displayRampGlsl } from './light-atlas.mjs';
import { frameProjection, FRAME_PROJECTION_KEY } from './frame-projection.mjs';
import { lightmapBasis } from '../unreal/lighting.mjs';
import { arrayTable } from '../unreal/bsp-model.mjs';
import { toView } from '../unreal/geometry.mjs';
import { FOG_RENDER_ORDER, FOG_RENDER_ORDER_LAST, FOG_RENDER_ORDER_MASKED } from './render-layers.mjs';

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
/** 'tiles' (default): a page whose texture is on the GPU takes only the tiles the frame wrote (copyTextureToTexture from its
 * pixels); 'page' re-uploads every written page whole (?fogUpload=page). */
const fogUploadMode = () => globalThis.DEUS_EX_FOG_UPLOAD || (typeof process !== 'undefined' && process.env?.FOG_UPLOAD) || 'tiles';
/** 'copy' (default): a child frame's fog map is kept with `new Uint8Array(texels)` and the validation record of the most fogged map
 * (`note`) holds a byte copy that becomes an Array when it is read; 'from' (?fogCopy=from) keeps `Uint8Array.from` and the eager
 * `Array.from`. SpiderMonkey runs both `from` calls through the iterator protocol (a self-hosted `next` per byte): beside the Paris
 * club's mirrors the fog update fell from 2.25 to 1.71 ms a frame without them (docs/mirror-surfaces.md "Firefox spot survey"). */
const fogCopyMode = () => globalThis.DEUS_EX_FOG_COPY || (typeof process !== 'undefined' && process.env?.FOG_COPY) || 'copy';
export function createFogPass({ lightAtlas, levelBrightness, hsv, displayGamma, notes, kernel = null }) {
  const root = new THREE.Group(), surfaces = [], lights = [], pages = new Map(), moverPolygons = new Map();
  root.name = 'Volumetric fog'; root.matrixAutoUpdate = false;
  const stats = { surfaces: 0, moverPolygons: 0, lights: 0, drawn: 0, texels: 0, kernel: Boolean(kernel) };
  const size = lightAtlas.size;
  // Where a surface's fog map draws among the frame's items (render-layers.mjs: after its surface, a masked one's in the
  // non-occluding list's band); `last` (validation, setLast) puts every map after the other world items.
  let last = false;
  const orderOf = masked => last ? FOG_RENDER_ORDER_LAST : masked ? FOG_RENDER_ORDER_MASKED : FOG_RENDER_ORDER;
  const moverMasked = new Set();
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
    // The overlay shares its surface's vertices and depth test (LESSEQUAL over
    // the same plane), so it projects with the surface's chain: the camera's
    // matrices would differ from it by a depth unit and z-fight
    // (docs/frame-projection.md "Overlays").
    m.customProgramCacheKey = () => `deus-ex-fog-v1:${FRAME_PROJECTION_KEY}`;
    m.onBeforeCompile = shader => {
      frameProjection.patch(shader);
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
    const model = { points: arrayTable([facet.slice(0, 3)]), vectors: arrayTable([facet.slice(3, 6), facet.slice(6, 9), facet.slice(9, 12)]) };
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
  // Per frame (0 the root's), the level surfaces whose fog map has any light in it this update: SetupForSurf gave them a FogMap,
  // and D3DDrv's DrawComplexSurface drops the detail texture of a surface with one (frame-projection.md "Detail textures").
  let foggedSurfaces = new Map();
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
    if (!alpha || alpha <= (stats[key]?.alpha ?? 0)) return;
    const entry = { ...what, alpha, missFlag, grid: input.grid, width: input.width, height: input.height, coords, lights: lightInputs(coords) };
    if (fogCopyMode() === 'from') entry.texels = Array.from(texels);
    else {
      // The bytes now (the buffer is the kernel's); the Array (which the validators read, also across a clone or a spread) on the first read.
      const bytes = new Uint8Array(texels);
      Object.defineProperty(entry, 'texels', { enumerable: true, configurable: true, get() {
        const value = Array.from(bytes);
        Object.defineProperty(entry, 'texels', { value, enumerable: true, writable: true, configurable: true });
        return value;
      } });
    }
    stats[key] = entry;
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
  /** Whether a fog map has a nonzero byte (texels.some(Boolean), which in Firefox calls back for every byte: 1.26 ms of Battery
   * Park's frame): a loop over 32-bit words where the bytes are aligned. */
  function anyFog(texels) {
    const words = texels.byteOffset % 4 === 0 ? Math.floor(texels.length / 4) : 0;
    if (words) {
      const view = new Uint32Array(texels.buffer, texels.byteOffset, words);
      for (let i = 0; i < words; i++) if (view[i] !== 0) return true;
    }
    for (let i = words * 4; i < texels.length; i++) if (texels[i] !== 0) return true;
    return false;
  }
  let scratch = new Uint8Array(0);
  /** A rectangle of a page's texels as one tightly packed view (light-atlas.mjs rectangle). */
  function rectangle(pixels, x, y, width, height) {
    const row = width * 4;
    if (width === size) return pixels.subarray(y * size * 4, (y + height) * size * 4);
    if (scratch.length < row * height) scratch = new Uint8Array(row * height);
    for (let r = 0; r < height; r++) {
      const start = ((y + r) * size + x) * 4;
      scratch.set(pixels.subarray(start, start + row), r * row);
    }
    return scratch.subarray(0, row * height);
  }
  /** Unit 0 and the unpack state copyTextureToTexture would set for a page (the pages are DataTextures with flipY false, no
   * premultiplied alpha, alignment 4), through three's state cache; rectangles arrive tightly packed. */
  function beginUpload(renderer) {
    const gl = renderer.getContext(), state = renderer.state, texture = pages.values().next().value.texture;
    state.activeTexture(gl.TEXTURE0);
    state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);
    state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, texture.premultiplyAlpha);
    state.pixelStorei(gl.UNPACK_ALIGNMENT, texture.unpackAlignment);
    for (const name of ['UNPACK_ROW_LENGTH', 'UNPACK_IMAGE_HEIGHT', 'UNPACK_SKIP_PIXELS', 'UNPACK_SKIP_ROWS', 'UNPACK_SKIP_IMAGES'])
      state.pixelStorei(gl[name], 0);
    return { gl, state };
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
  const noteItem = (item, why) => { if (stats.moverItems.length < 48) stats.moverItems.push(`${item.mover}:${item.polygon} z${item.zone} ${why}`); };
  /** The mover draw items' maps of one frame (sim-session.mjs moverItems):
   * an item in a bFogZone zone, of a lit polygon, gets one. Each goes to a
   * mesh over the item's fragments tagged with `frame`. */
  function moverMaps(moverItems, fogZone, coords, frameLights, state, frame, each) {
    for (const item of moverItems ?? []) {
      const record = moverPolygons.get(`${item.mover}:${item.polygon}`);
      // Diagnostics: each item of the root frame, with the map's largest texel or why it has none (stats.moverItems).
      const why = !record ? 'no lit polygon record' : !item.facet ? 'no facet' : !fogZone?.(item.zone) ? `zone ${item.zone} not bFogZone` : null;
      if (why) { if (frame === 0) noteItem(item, why); continue; }
      const basis = moverBasis(record, item.facet);
      const input = fogInput(record, moverGrid(basis), coords, frameLights, state), missFlag = state.missFlag;
      const texels = kernel ? fogMapKernel(kernel, input) : fogMap(input);
      if (frame === 0) {
        const g = input.grid, far = g.base.map((v, k) => v + g.stepU[k] * record.width + g.stepV[k] * record.height), r = v => v.map(x => Math.round(x)).join(',');
        noteItem(item, `${texels ? `max texel ${Math.max(...texels)}` : 'no texels'} lattice ${r(g.base)}..${r(far)} ${record.width}x${record.height} facet ${r(item.facet.slice(0, 3))} n ${item.facet.slice(9, 12).map(x => x.toFixed(2)).join(',')}`);
      }
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
      mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
      root.add(mesh);
      slot = items[itemsUsed] = { mesh, uniform, texture: null, width: 0, height: 0 };
    }
    itemsUsed++;
    slot.masked = moverMasked.has(`${item.mover}:${item.polygon}`);
    slot.mesh.renderOrder = orderOf(slot.masked);
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
    // Each fan triangle faces the eye as the world's do (geometry.mjs
    // buildSurfaceGeometry): one whose Unreal winding runs along the facet's
    // normal is reversed, since toView flips handedness; the fragments arrive
    // in the polygon's own order, and a front-side material culled them all.
    const normal = item.facet.slice(9, 12);
    for (const points of item.fragments) {
      const at = k => [points[3 * k], points[3 * k + 1], points[3 * k + 2]];
      const vertex = k => {
        const p = at(k), uv = basis.uv(p);
        positions.push(...toView(p)); uvs.push((1 + uv[0]) / w, (1 + uv[1]) / h, 1); bounds.push(...box);
      };
      for (let k = 1; k + 1 < points.length / 3; k++) {
        const [a, b, c] = [at(0), at(k), at(k + 1)], e = b.map((v, i) => v - a[i]), f = c.map((v, i) => v - a[i]);
        const along = (e[1] * f[2] - e[2] * f[1]) * normal[0] + (e[2] * f[0] - e[0] * f[2]) * normal[1] + (e[0] * f[1] - e[1] * f[0]) * normal[2];
        if (along > 0) { vertex(0); vertex(k + 1); vertex(k); } else { vertex(0); vertex(k); vertex(k + 1); }
      }
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
    addSurface(record, tile, positions, lightUV, lightBounds, surfaceIndex = -1, masked = false) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('lightUV', new THREE.Float32BufferAttribute(lightUV, 3));
      geometry.setAttribute('lightBounds', new THREE.Float32BufferAttribute(lightBounds, 4));
      geometry.computeBoundingSphere();
      const fogPage = page(tile.page.index), mesh = new THREE.Mesh(geometry, material(fogPage.uniform));
      mesh.matrixAutoUpdate = false; mesh.visible = false; mesh.renderOrder = orderOf(masked);
      root.add(mesh);
      surfaces.push({ record, tile, mesh, fogPage, surfaceIndex, masked });
      stats.surfaces = surfaces.length;
    },
    /** A lit mover polygon (its light-map record from the Brush's model):
     * its draw items get fog maps over their fragments. */
    addMoverPolygon(record, mover, polygon, masked = false) {
      moverPolygons.set(`${mover}:${polygon}`, record);
      if (masked) moverMasked.add(`${mover}:${polygon}`);
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
    update(view, frustum, drawn = null, { moverItems = null, fogZone = null, frames = null, nodeSurface = null, renderer = null } = {}) {
      stats.drawn = 0; stats.texels = 0; stats.movers = 0; stats.moverCase = null; stats.frameMaps = 0; stats.frameCase = null; stats.moverItems = [];
      childMaps = new Map(); itemsUsed = 0; foggedSurfaces = new Map();
      for (const slot of items) slot.mesh.visible = false;
      if ((!surfaces.length && !moverPolygons.size) || !lights.length) return;
      const state = { missFlag: 0 }, copyTexels = fogCopyMode() === 'from' ? texels => Uint8Array.from(texels) : texels => new Uint8Array(texels);
      if (frames && nodeSurface) {
        for (const frame of drawOrder(frames)) {
          if (!frame.coords) continue;
          const c = frame.coords;
          const coords = { origin: c.slice(0, 3), x: c.slice(3, 6), y: c.slice(6, 9), z: c.slice(9, 12) };
          const frameLights = lightsFor(coords), here = new Set(Array.from(frame.nodes, node => nodeSurface[node]));
          const maps = [], what = { frame: frame.index, kind: frame.kind };
          levelMaps(here, null, coords, frameLights, state, (surface, texels, input, missFlag) => {
            maps.push({ surface, texels: copyTexels(texels) });
            stats.frameMaps++;
            note('frameCase', { ...what, surface: surface.surfaceIndex }, texels, input, missFlag, coords);
          });
          moverMaps(frame.moverItems, fogZone, coords, frameLights, state, frame.index, (item, texels, input, missFlag) => {
            stats.frameMaps++;
            note('frameCase', { ...what, mover: item.mover, polygon: item.polygon }, texels, input, missFlag, coords);
          });
          childMaps.set(frame.index, maps);
          foggedSurfaces.set(frame.index, new Set(maps.filter(map => anyFog(map.texels)).map(map => map.surface.surfaceIndex)));
        }
      }
      // The root frame, drawn last.
      const [x, y, z] = getAxes(view.rotation.map(v => v | 0));
      // ViewCoords (0,1,0), (0,0,-1), (1,0,0) under the view rotation.
      const coords = { origin: view.location.map(Math.fround), x: y, y: z.map(v => -v), z: x };
      const frameLights = lightsFor(coords), dirty = new Set(), written = [], rootFogged = new Set();
      foggedSurfaces.set(0, rootFogged);
      for (const surface of surfaces) surface.mainVisible = surface.mesh.visible = false;
      levelMaps(drawn, frustum, coords, frameLights, state, (surface, texels) => {
        const { record, tile, mesh, fogPage } = surface;
        if (anyFog(texels)) rootFogged.add(surface.surfaceIndex);
        writeTile(fogPage.pixels, size, tile.x, tile.y, record, texels);
        dirty.add(fogPage); written.push(surface);
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
      // The written tiles to the GPU. A page's texels change only here (writeTile), so once its texture is on the GPU and current
      // it follows its pixels through the padded tiles this frame wrote, each sent as a tightly packed view: Firefox copies the
      // whole source view per call whatever the unpack state selects (light-atlas.mjs flush), and the whole page re-uploaded was
      // size * size * 4 bytes for each written page (Battery Park: 8.3 MB a frame, 4.4 ms in Firefox; docs/volumetric-fog.md
      // "Uploads"). A page never uploaded, or one whose full upload three still owes (that upload reads these pixels), takes
      // the whole page; so does every page without a renderer (a caller outside the frame) or with ?fogUpload=page.
      const tiles = renderer && fogUploadMode() === 'tiles';
      let upload = null;
      for (const fogPage of dirty) {
        const texture = fogPage.texture;
        if (!tiles) { texture.needsUpdate = true; continue; }
        const properties = renderer.properties.get(texture);
        fogPage.current = Boolean(properties.__webglTexture) && properties.__version === texture.version && texture.version > 0;
        if (!fogPage.current && texture.version === (properties.__version ?? 0)) texture.needsUpdate = true;
      }
      if (tiles) for (const surface of written) {
        const fogPage = surface.fogPage;
        if (!fogPage.current) continue;
        upload ??= beginUpload(renderer);
        const { gl, state } = upload, properties = renderer.properties.get(fogPage.texture);
        state.bindTexture(gl.TEXTURE_2D, properties.__webglTexture, gl.TEXTURE0);
        const { record, tile } = surface, width = record.width + 2, height = record.height + 2;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, tile.x - 1, tile.y - 1, width, height, gl.RGBA, gl.UNSIGNED_BYTE,
          rectangle(fogPage.pixels, tile.x - 1, tile.y - 1, width, height));
      }
    },
    /** Debugging: each page's texture read back from the GPU against its pixels (the texels that differ), after a frame. */
    pagesMatch(renderer) {
      const gl = renderer.getContext(), out = [], buffer = new Uint8Array(size * size * 4);
      for (const [index, fogPage] of pages) {
        const texture = renderer.properties.get(fogPage.texture).__webglTexture;
        if (!texture) { out.push({ index, uploaded: false }); continue; }
        const fb = gl.createFramebuffer(), previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
        gl.bindFramebuffer(gl.FRAMEBUFFER, previous); gl.deleteFramebuffer(fb);
        let differ = 0;
        for (let i = 0; i < buffer.length; i += 4)
          if (buffer[i] !== fogPage.pixels[i] || buffer[i + 1] !== fogPage.pixels[i + 1] || buffer[i + 2] !== fogPage.pixels[i + 2] || buffer[i + 3] !== fogPage.pixels[i + 3]) differ++;
        out.push({ index, differ });
      }
      return out;
    },
    /** The surfaces of frame `index` (0 the root) with a fog map this update, a Set, or null when none was computed. */
    fogged(index) { return foggedSurfaces.get(index) ?? null; },
    /** A child frame's pass (`frame` a record of `update`'s frames), or the
     * end of one (null): its level-surface maps go into the atlas tiles they
     * share with the root frame's, only its own fog meshes and mover items
     * draw, and at the end the root frame's tiles and meshes come back. */
    framePass(frame, renderer) {
      if (!frame) {
        if (!passTiles) return;
        // The root frame's padded tile, through the surface's tile-sized scratch: copyTextureToTexture from the whole page
        // (mainSource) made Firefox copy the page's size * size * 4 bytes for every tile restored, after every child pass (the
        // Paris club's two facing mirrors: 165 MB and 36 ms a frame). ?fogUpload=page keeps the page source.
        const tight = fogUploadMode() === 'tiles';
        for (const surface of passTiles) {
          const { record, tile, fogPage } = surface;
          if (!tight) { copyTile(renderer, surface, mainSource(fogPage), tile.x - 1, tile.y - 1); continue; }
          surface.scratch.pixels.set(rectangle(fogPage.pixels, tile.x - 1, tile.y - 1, record.width + 2, record.height + 2));
          copyTile(renderer, surface, surface.scratch.texture, 0, 0);
        }
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
    /** Validation only: every fog map after the other world items (`last`), or where DrawComplexSurface draws it. */
    setLast(on) {
      last = Boolean(on);
      for (const { mesh, masked } of surfaces) mesh.renderOrder = orderOf(masked);
      for (const slot of items) slot.mesh.renderOrder = orderOf(slot.masked);
    },
    /** The shader warm-up's fog mesh (shader-warmup.mjs): a mover polygon's draw item, made once play runs (itemMesh). */
    warmup(geometry) { return [new THREE.Mesh(geometry, material({ value: null }))]; },
    dispose() {
      for (const { mesh } of surfaces) { mesh.geometry.dispose(); mesh.material.dispose(); }
      for (const { mesh, texture } of items) { mesh.geometry.dispose(); mesh.material.dispose(); texture?.dispose(); }
      for (const { texture } of pages.values()) texture.dispose();
    },
  };
}
