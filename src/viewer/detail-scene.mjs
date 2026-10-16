import * as THREE from 'three';
import { displayRampGlsl } from './light-atlas.mjs';
import { configureSampler, REENCODE_GLSL } from './original-sampling.mjs';
import { frameProjection, FRAME_PROJECTION_KEY } from './frame-projection.mjs';
import { frameProjectionGlsl } from './frame-projection-glsl.mjs';
import { unpackDetail, forEachFan } from '../runtime/detail-draw.mjs';
import { DETAIL_RENDER_ORDER } from './render-layers.mjs';

/** D3DDrv's detail-texture pass in Play, the page's side (docs/frame-projection.md "Detail textures", "Play"): the fans the
 * simulation side produced (detail-draw.mjs: D3DDrv's own vertices, X, Y, depth, RHW, colour and texture coordinates, for the
 * main frame and each mirror and sky child frame) drawn in the states DrawComplexSurface records for them:
 *
 *   blend       SRCBLEND = DESTCOLOR, DESTBLEND = SRCCOLOR (SetBlending(PF_Modulated, 0x40)): the frame takes 2 * src * dst
 *   depth       no write, test LESSEQUAL, ZBIAS 15 (a depth offset: see `ZBIAS`)
 *   stage 0     COLOROP = BLENDDIFFUSEALPHA: texel * a + 0x808080 * (1 - a) with a the vertex colour's alpha
 *   sampling    WRAP, bilinear with point mip selection, LOD bias -0.5 (docs/texture-sampling.md), no masking
 *
 * The vertices go through fpClipOf (frame-projection-glsl.mjs) as the base surfaces' do, with the view depth 1 / RHW: a clip
 * vertex carries RHW 1 / D, so the rasterizer's perspective division acts on the exact screen position, depth and RHW. A pass
 * draws only its own frame's fans (`mainPass`, `framePass`, as the sprite scene does); every other render of the scene
 * leaves them out. One mesh per frame and detail texture, in the simulation's record order inside it. */

/** ZBIAS 15 as the host's depth offset: the fans' depth is lowered by a constant in the vertex stage, the same on every host
 * (three.js polygonOffset counts the host's own depth steps and its slope term is host-defined). 5,000 steps of the depth
 * buffer's 2^-24: the offset at which Play's changed pixels best match the original's own frame with the pass poked in, over
 * the views measured (docs/frame-projection.md "Detail textures": the original under Wine behaves like a slope-scaled offset
 * of about 15 times the polygon's depth slope, which a constant approximates within a few hundred pixels a view). `factor` and
 * `units` are a polygonOffset, left off. */
export const ZBIAS = { factor: 0, units: 0, depth: 5000 * 2 ** -24 };
const DEPTH_STEP = 2 ** -24;
/** A fan's edge on a row of pixel centres, broken upwards (docs/frame-projection.md "Edges on pixel centres (2026-10-16)").
 * Render.dll clips the fans' polygons at the frame's top at D3D Y 0, row 0's pixel centres: D3D's top-left convention (the
 * DirectX SDK's rasterization rules, not measured on Windows) fills a centre on a top edge and leaves one on a bottom edge, and
 * the original under CrossOver fills row 0. The host fills a centre on a bottom edge and leaves one on a top edge (measured on
 * ANGLE over Metal, scripts/probe-fill-rule.mjs; its vertical edges agree with D3D's, left in, right out). A fan with two
 * vertices on one of the frame's rows of centres (within FILL_TIE_ROW of an integer Y: an edge or a chord on it; the clip at the
 * frame's bottom, Y 720 in a 720-row frame, lies on no row it has) is moved up by FILL_TIE_Y, so an edge on centres lies
 * strictly above them: the centres a top edge passes through are inside and those a bottom edge passes through outside,
 * whatever the host's own rule. 1/256 is twice the smallest shift the host's vertex snapping keeps (1/512; 1/1024 is lost). The
 * fragment stage reads such a fan's texture coordinates and alpha back where the unmoved fan has them (one derivative step).
 * Every other fan is drawn as before, so the shift's cost (a horizontal edge within 1/256 px below a row of centres takes that
 * row, and the derivative step's second-order error) falls only on the fans that need it. */
export const FILL_TIE_Y = 1 / 256, FILL_TIE_ROW = 2 ** -10;
/** ?detailMips=generate builds a mip chain for the detail textures stored with one level (893 of the 896 in the shipped
 * packages), as the base textures get; the default draws them as the one level they are (docs/frame-projection.md). */
const generateMips = typeof location !== 'undefined' && new URLSearchParams(location.search).get('detailMips') === 'generate';

export function createDetailScene(assets, textures, { displayGamma, surfaceDetails }) {
  const root = new THREE.Group(), notes = new Set(), meshes = new Map(), loaded = new Map();
  // The depth the fans are lowered by (0..1 depth), shared by every material; and the polygon offset the materials carry.
  const bias = { value: ZBIAS.depth };
  root.matrixAutoUpdate = false; root.name = 'Detail textures';
  let used = [], drawn = 0, current = null;
  const tieRows = new Int32Array(64);   // the rows of pixel centres a fan's vertices lie on (update's scratch)

  /** The detail texture of a model surface as a loadable entry: `surfaceDetails[i]` is modelSurfaceDetails' entry. */
  function textureOf(surface) {
    const detail = surfaceDetails[surface];
    if (!detail?.ref) return null;
    const key = detail.ref.key;
    let entry = loaded.get(key);
    if (entry) return entry;
    entry = { key, material: null, texture: null, failed: null };
    loaded.set(key, entry);
    assets.get(detail.ref.package).then(asset => textures.get(asset, detail.ref.index, false)).then(data => {
      const first = data.mips[0], gpu = new THREE.DataTexture(first.data, first.width, first.height, THREE.RGBAFormat);
      gpu.flipY = false;
      gpu.wrapS = gpu.wrapT = THREE.RepeatWrapping;
      const last = data.mips.at(-1), complete = last.width === 1 && last.height === 1;
      if (complete && data.mips.length > 1) gpu.mipmaps = data.mips;
      gpu.generateMipmaps = !complete && generateMips;
      configureSampler(gpu, false);
      // A texture whose file stores one mip level is uploaded as one level (MIPFILTER selects level 0): no chain is generated.
      if (data.mips.length === 1 && !generateMips) gpu.minFilter = THREE.LinearFilter;
      gpu.needsUpdate = true;
      const material = new THREE.MeshBasicMaterial({ map: gpu, transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
        side: THREE.DoubleSide, fog: false });
      material.blending = THREE.CustomBlending;
      material.blendSrc = THREE.DstColorFactor; material.blendDst = THREE.SrcColorFactor;
      material.polygonOffset = ZBIAS.factor !== 0 || ZBIAS.units !== 0;
      material.polygonOffsetFactor = ZBIAS.factor; material.polygonOffsetUnits = ZBIAS.units;
      material.onBeforeCompile = shader => {
        shader.uniforms.deusDisplayGamma = displayGamma;
        Object.assign(shader.uniforms, frameProjection.uniforms);
        shader.uniforms.uDetailBias = bias;
        // D3DDrv's vertices (X, Y, depth, RHW) through the original's mapping to clip space; a pass without a frame draws nothing.
        shader.vertexShader = shader.vertexShader
          .replace('void main() {', `attribute vec4 deusD3d;\nattribute float deusAlpha;\nattribute float deusTie;\nvarying float vDeusAlpha;\nvarying float vDeusTie;\nuniform float uDetailBias;\n${frameProjectionGlsl()}\nvoid main() {`)
          // The fans are already the frame's own (OccludeBsp's output); the host's mirror-plane clip would test the D3D vertex.
          .replace('#include <clipping_planes_vertex>', '')
          .replace('#include <project_vertex>', `
vDeusAlpha = deusAlpha; vDeusTie = deusTie;
if ( uFpOn > 0.5 ) gl_Position = fpClipOf( vec4( deusD3d.x, deusD3d.y - deusTie, deusD3d.z - uDetailBias, deusD3d.w ), 1.0 / deusD3d.w );
else gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
`);
        // COLOROP BLENDDIFFUSEALPHA with the diffuse 0x808080 and the vertex alpha: texel * a + diffuse * (1 - a).
        shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', '').replace('#include <common>', '#include <common>\nuniform float deusDisplayGamma;\nvarying float vDeusAlpha;\nvarying float vDeusTie;')
          // A fan moved up by vDeusTie px (window y grows upwards) has at this pixel what the unmoved fan has vDeusTie px lower: its
          // texture coordinates and alpha are read one derivative step back up (0 for every other fan).
          .replace('#include <map_fragment>', `vec2 deusMapUv = vMapUv + vDeusTie * dFdy( vMapUv );
float deusFanAlpha = vDeusAlpha + vDeusTie * dFdy( vDeusAlpha );
${THREE.ShaderChunk.map_fragment.replace(/\bvMapUv\b/g, 'deusMapUv')}
diffuseColor = vec4( mix( vec3( 128.0 / 255.0 ), diffuseColor.rgb, clamp( deusFanAlpha, 0.0, 1.0 ) ), 1.0 );`)
          .replace('#include <colorspace_fragment>', `${REENCODE_GLSL}
            ${displayRampGlsl('deusDisplayGamma', true)}`);
      };
      material.customProgramCacheKey = () => `deus-detail:${FRAME_PROJECTION_KEY}`;
      Object.assign(entry, { texture: gpu, material });
    }).catch(error => { entry.failed = error.message; notes.add(`Detail texture ${key}: ${error.message}`); });
    return entry;
  }

  /** A mesh for (frame, texture), its geometry's attributes holding at least `vertices` vertices. */
  function meshFor(frame, entry, vertices) {
    const key = `${frame}:${entry.key}`;
    let item = meshes.get(key);
    if (!item) {
      const geometry = new THREE.BufferGeometry(), mesh = new THREE.Mesh(geometry, entry.material);
      mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = DETAIL_RENDER_ORDER;
      root.add(mesh);
      item = { mesh, geometry, capacity: 0, frame, material: entry.material };
      meshes.set(key, item);
    }
    if (item.mesh.material !== entry.material) item.mesh.material = entry.material;
    if (item.capacity < vertices) {
      let capacity = Math.max(96, item.capacity);
      while (capacity < vertices) capacity *= 2;
      item.geometry.dispose();
      const attribute = (size, name) => item.geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage));
      attribute(4, 'deusD3d'); attribute(1, 'deusAlpha'); attribute(1, 'deusTie'); attribute(2, 'uv');
      // three.js needs a position attribute to size the draw: the vertex shader ignores it.
      item.geometry.setAttribute('position', item.geometry.getAttribute('deusD3d'));
      item.capacity = capacity;
    }
    return item;
  }

  /** One frame's pack (detail-draw.mjs) or null: the geometry of every frame's fans. `skip(frame, surface)` leaves a surface's
   * fans out (a surface with a fog map takes no detail texture). `rows` = [first, last]: the frame's rows of pixel centres in
   * the vertices' Y (its rectangle); a tie on a row outside them is moot (null: every row counts). */
  function update(pack, skip = null, rows = null) {
    for (const item of used) item.mesh.visible = false;
    used = []; drawn = 0; current = null;
    if (!pack) return;
    const floats = new Float32Array(pack.buffer, pack.byteOffset, pack.length);
    for (const { index, words, offset } of unpackDetail(pack)) {
      // Pass 1: the triangles each texture takes; pass 2 fills them.
      const counts = new Map();
      forEachFan(words, (list, node, surface, layer, count) => {
        const entry = textureOf(surface);
        if (!entry?.material || skip?.(index, surface)) return;
        counts.set(entry, (counts.get(entry) ?? 0) + 3 * (count - 2));
      });
      const fill = new Map();
      for (const [entry, vertices] of counts) {
        const item = meshFor(index, entry, vertices);
        fill.set(entry, { item, at: 0, d3d: item.geometry.getAttribute('deusD3d').array, alpha: item.geometry.getAttribute('deusAlpha').array,
          tie: item.geometry.getAttribute('deusTie').array, uv: item.geometry.getAttribute('uv').array });
      }
      forEachFan(words, (list, node, surface, layer, count, w, at) => {
        const entry = textureOf(surface), out = entry && fill.get(entry);
        if (!out || skip?.(index, surface)) return;
        const base = offset + at;
        // FILL_TIE_Y for a fan with two vertices on one row of pixel centres, else 0.
        let tie = 0, onRows = 0;
        for (let v = 0; v < count && !tie; v++) {
          const y = floats[base + 7 * v + 1], row = Math.round(y);
          if (Math.abs(y - row) >= FILL_TIE_ROW || (rows && (row < rows[0] || row > rows[1]))) continue;
          for (let r = 0; r < onRows; r++) if (tieRows[r] === row) tie = FILL_TIE_Y;
          if (onRows < tieRows.length) tieRows[onRows++] = row;
        }
        const put = v => {
          const src = base + 7 * v, k = out.at++;
          out.d3d[4 * k] = floats[src]; out.d3d[4 * k + 1] = floats[src + 1]; out.d3d[4 * k + 2] = floats[src + 2]; out.d3d[4 * k + 3] = floats[src + 3];
          out.alpha[k] = (pack[src + 4] >>> 24) / 255; out.tie[k] = tie;
          out.uv[2 * k] = floats[src + 5]; out.uv[2 * k + 1] = floats[src + 6];
        };
        // The fan's triangles (v0, vi, vi+1).
        for (let v = 1; v + 1 < count; v++) { put(0); put(v); put(v + 1); }
        drawn += count - 2;
      });
      for (const { item, at, d3d, alpha, uv } of fill.values()) {
        for (const name of ['deusD3d', 'deusAlpha', 'deusTie', 'uv']) {
          const attribute = item.geometry.getAttribute(name);
          attribute.clearUpdateRanges(); attribute.addUpdateRange(0, attribute.itemSize * at); attribute.needsUpdate = true;
        }
        item.geometry.setDrawRange(0, at);
        used.push(item);
      }
    }
  }

  /** Shows the fans of one frame (0 the main frame's), or none (null). */
  function pass(frame) {
    for (const item of used) item.mesh.visible = frame !== null && item.frame === frame;
    current = frame;
  }

  return { root, update, notes, count: () => drawn,
    /** Measurement: the fans' depth offset, a polygon offset (slope factor, units) and a constant `depth` (0..1 depth). */
    setBias(factor, units, depth = 0) {
      Object.assign(ZBIAS, { factor, units, depth }); bias.value = depth;
      for (const entry of loaded.values()) if (entry.material) {
        entry.material.polygonOffset = factor !== 0 || units !== 0;
        entry.material.polygonOffsetFactor = factor; entry.material.polygonOffsetUnits = units;
      }
    },
    mainPass: on => pass(on ? 0 : null), framePass: record => pass(record ? record.index : null),
    /** The frame whose fans are shown (validation). */
    shown: () => current,
    /** Every mesh with its frame and triangle count (validation). */
    meshes: () => used.map(item => ({ frame: item.frame, triangles: item.geometry.drawRange.count / 3, visible: item.mesh.visible })),
    dispose() { for (const item of meshes.values()) item.geometry.dispose(); for (const entry of loaded.values()) { entry.material?.dispose(); entry.texture?.dispose(); } } };
}
