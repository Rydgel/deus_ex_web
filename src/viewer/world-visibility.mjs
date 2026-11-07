/** The main frame's BSP visibility applied to the world's meshes
 * (docs/bsp-occlusion.md "Play"). OccludeBsp (the simulation side,
 * bsp-occlusion.mjs) gives the nodes whose clipped polygons the frame's draw
 * lists keep; the original draws exactly those polygons (DrawFrame draws every
 * FSavedPoly of every list). Each world mesh triangle carries its BSP node
 * (`userData.nodes`), so a mesh draws the main frame through an index of its
 * visible triangles, in their own order, and everything else (mirror and
 * sky passes, whose child frames' own occlusion is not ported yet) through
 * its whole geometry. With the moving brush tracker (brush-tracker.mjs) a
 * mover's polygons are BSP fragments: its meshes draw the main frame
 * through the triangles of the polygons the draw lists hold (`movers`: name
 * to polygon ordinals; each mover triangle carries its polygon in
 * `userData.faces`); a polygon with any fragment drawn draws whole (the
 * depth test hides the rest). Without the tracker they draw whole. */
import * as THREE from 'three';
import { switchReader } from '../runtime/switch-reader.mjs';

/** 'regions' (default), 'single' or 'verify': INDEX_REGIONS / DEUS_EX_INDEX_REGIONS / `?indexRegions=` (docs/firefox-60fps-plan.md
 * "Unshipped bundle (2026-11-07)"). Each world mesh keeps one index buffer with a region per node set it has drawn lately (up to
 * REGIONS: the main frame's, the root sky frame's, a mirror frame's), and a pass whose set is one a region holds draws that region
 * (`drawRange.start`) without rebuilding or uploading anything. 'single' is the buffer of one region, rebuilt whenever the set differs
 * from the one before (the main pass and the sky pass alternate, so that was two rebuilds and their index uploads every frame);
 * 'verify' keeps the regions and compares every mesh's drawn range with a rebuild of the set it was asked for. */
export const indexRegionsMode = switchReader('INDEX_REGIONS', 'DEUS_EX_INDEX_REGIONS', 'regions');
/** Node sets a mesh keeps an index region for. */
export const REGIONS = 3;

export function createWorldVisibility(root, nodeCount) {
  const mode = indexRegionsMode(), regionCount = mode === 'single' ? 1 : REGIONS;
  const meshes = [], movers = [];
  root.traverse(object => {
    const nodes = object.userData?.nodes;
    if (object.isMesh && typeof object.userData.actor === 'string' && !object.userData.backdrop && object.userData.faces?.length) {
      const geometry = object.geometry, triangles = object.userData.faces.length;
      if (geometry.index || geometry.getAttribute('position').count !== 3 * triangles) return;
      const index = new THREE.BufferAttribute(new Uint32Array(3 * triangles), 1);
      index.setUsage(THREE.DynamicDrawUsage);
      movers.push({ mesh: object, geometry, name: object.userData.actor, faces: object.userData.faces, index, count: 0,
        visible: object.visible, selected: false });
      return;
    }
    if (!object.isMesh || object.userData.actor || !nodes?.length) return;
    const geometry = object.geometry, triangles = nodes.length;
    if (geometry.index || geometry.getAttribute('position').count !== 3 * triangles)
      throw new Error('World visibility needs non-indexed meshes with one node per triangle');
    const index = new THREE.BufferAttribute(new Uint32Array(regionCount * 3 * triangles), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    meshes.push({ mesh: object, geometry, nodes, index, count: 0, start: 0, counts: new Int32Array(regionCount), visible: object.visible });
  });
  const visible = new Uint8Array(nodeCount);
  // The node sets the regions hold (`nodes`: a copy, `drawn`: the triangles they draw, `used`: the select that last drew them).
  const sets = [];
  let selected = false, clock = 0;
  const stats = { meshes: meshes.length, triangles: 0, drawnTriangles: 0, nodes: 0, selects: 0, rebuilds: 0, uploads: 0, moverRebuilds: 0, moverUploads: 0,
    mode, regions: regionCount, regionHits: 0, verified: 0 };
  for (const entry of meshes) stats.triangles += entry.nodes.length;
  /** INDEX_REGIONS=verify: each mesh's drawn range (the region's indices from `start`, `count` of them) against the indices a rebuild of
   * `nodes` writes, value by value. */
  function verifyRegion(nodes) {
    const seen = new Uint8Array(nodeCount);
    for (const node of nodes) seen[node] = 1;
    for (const entry of meshes) {
      const nodesOf = entry.nodes, have = entry.index.array;
      let count = 0;
      for (let t = 0; t < nodesOf.length; t++) {
        if (!seen[nodesOf[t]]) continue;
        for (let k = 0; k < 3; k++, count++)
          if (count >= entry.count || have[entry.start + count] !== 3 * t + k)
            throw new Error(`INDEX_REGIONS=verify: ${entry.mesh.name || entry.mesh.id} index ${count} is ${have[entry.start + count]}, a rebuild writes ${3 * t + k} (count ${entry.count})`);
      }
      if (count !== entry.count) throw new Error(`INDEX_REGIONS=verify: ${entry.mesh.name || entry.mesh.id} draws ${entry.count} indices, a rebuild writes ${count}`);
      stats.verified++;
    }
  }
  return {
    stats,
    /** The main frame's visible nodes (Uint32Array, any order) and the
     * movers' drawn polygons (`moverPolys`, or null: whole movers); null
     * nodes keep whole meshes. */
    select(nodes, moverPolys = null) {
      if (!nodes) { this.all(); return; }
      stats.selects++;
      for (const entry of movers) {
        const polys = moverPolys?.[entry.name];
        entry.selected = Boolean(moverPolys);
        if (!entry.selected) continue;
        let count = 0;
        // A mover with no drawn polygon (most of them, most frames: 130 empty sets a frame at Battery Park) has no triangle to find.
        if ((polys?.length ?? polys?.size ?? 0) > 0) {
          const drawn = new Set(polys), out = entry.index.array;
          for (let t = 0; t < entry.faces.length; t++)
            if (drawn.has(entry.faces[t])) { out[count++] = 3 * t; out[count++] = 3 * t + 1; out[count++] = 3 * t + 2; }
        }
        entry.count = count;
        stats.moverRebuilds++;
        if (count) { entry.index.clearUpdateRanges(); entry.index.addUpdateRange(0, count); entry.index.needsUpdate = true; stats.moverUploads++; }
        entry.visible = entry.mesh.visible;
        entry.mesh.visible = entry.visible && count > 0;
        entry.geometry.setIndex(entry.index);
        entry.geometry.setDrawRange(0, count);
      }
      let region = -1;
      for (let r = 0; r < sets.length; r++) if (sameNodes(sets[r].nodes, nodes)) { region = r; break; }
      if (region >= 0) stats.regionHits++;
      else {
        // A set no region holds takes a free region, else the one drawn longest ago.
        if (sets.length < regionCount) region = sets.length;
        else { region = 0; for (let r = 1; r < sets.length; r++) if (sets[r].used < sets[region].used) region = r; }
        stats.rebuilds++;
        visible.fill(0);
        for (const node of nodes) visible[node] = 1;
        let drawn = 0;
        for (const entry of meshes) {
          const nodesOf = entry.nodes, out = entry.index.array, base = region * 3 * nodesOf.length;
          let count = 0;
          for (let t = 0; t < nodesOf.length; t++)
            if (visible[nodesOf[t]]) { out[base + count++] = 3 * t; out[base + count++] = 3 * t + 1; out[base + count++] = 3 * t + 2; }
          entry.counts[region] = count;
          if (count) { markRange(entry.index, base, count); stats.uploads++; }
          drawn += count / 3;
        }
        sets[region] = { nodes: nodes.slice(), drawn, used: 0 };
      }
      sets[region].used = ++clock;
      stats.drawnTriangles = sets[region].drawn;
      stats.nodes = nodes.length;
      for (const entry of meshes) { entry.count = entry.counts[region]; entry.start = region * 3 * entry.nodes.length; }
      if (mode === 'verify') verifyRegion(nodes);
      // A mesh with no visible triangle is hidden for the pass (an empty draw
      // still costs a call); all() restores its own visibility.
      for (const entry of meshes) {
        entry.visible = entry.mesh.visible;
        entry.mesh.visible = entry.visible && entry.count > 0;
        entry.geometry.setIndex(entry.index);
        entry.geometry.setDrawRange(entry.start, entry.count);
      }
      selected = true;
    },
    /** Whole meshes again (mirror and sky passes, Inspect). */
    all() {
      for (const entry of movers) {
        if (!entry.selected) continue;
        entry.mesh.visible = entry.visible;
        entry.geometry.setIndex(null); entry.geometry.setDrawRange(0, Infinity);
        entry.selected = false;
      }
      if (!selected) return;
      for (const entry of meshes) {
        entry.mesh.visible = entry.visible;
        entry.geometry.setIndex(null); entry.geometry.setDrawRange(0, Infinity);
      }
      selected = false;
    },
  };
}

/** A region's rebuilt indices `[start, start + count)` to be uploaded at the next draw. A range three.js has not uploaded yet for another
 * region (or this one) stays pending: clearing it would leave that region's GPU copy stale for the pass that hits it later; the one range
 * of this `start` is replaced, so a mesh that is never drawn (culled) holds at most one per region. */
function markRange(index, start, count) {
  index.needsUpdate = true;
  for (const range of index.updateRanges) if (range.start === start) { range.count = count; return; }
  index.addUpdateRange(start, count);
}

function sameNodes(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
