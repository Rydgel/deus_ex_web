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

export function createWorldVisibility(root, nodeCount) {
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
    const index = new THREE.BufferAttribute(new Uint32Array(3 * triangles), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    meshes.push({ mesh: object, geometry, nodes, index, count: 0, visible: object.visible });
  });
  const visible = new Uint8Array(nodeCount);
  let shown = null, selected = false;
  const stats = { meshes: meshes.length, triangles: 0, drawnTriangles: 0, nodes: 0, selects: 0, rebuilds: 0, uploads: 0, moverRebuilds: 0, moverUploads: 0 };
  for (const entry of meshes) stats.triangles += entry.nodes.length;
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
      if (!sameNodes(shown, nodes)) {
        stats.rebuilds++;
        visible.fill(0);
        for (const node of nodes) visible[node] = 1;
        stats.drawnTriangles = 0;
        for (const entry of meshes) {
          const out = entry.index.array, nodesOf = entry.nodes;
          let count = 0;
          for (let t = 0; t < nodesOf.length; t++)
            if (visible[nodesOf[t]]) { out[count++] = 3 * t; out[count++] = 3 * t + 1; out[count++] = 3 * t + 2; }
          entry.count = count;
          if (count) { entry.index.clearUpdateRanges(); entry.index.addUpdateRange(0, count); entry.index.needsUpdate = true; stats.uploads++; }
          stats.drawnTriangles += count / 3;
        }
        shown = nodes.slice();
        stats.nodes = nodes.length;
      }
      // A mesh with no visible triangle is hidden for the pass (an empty draw
      // still costs a call); all() restores its own visibility.
      for (const entry of meshes) {
        entry.visible = entry.mesh.visible;
        entry.mesh.visible = entry.visible && entry.count > 0;
        entry.geometry.setIndex(entry.index);
        entry.geometry.setDrawRange(0, entry.count);
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

function sameNodes(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
