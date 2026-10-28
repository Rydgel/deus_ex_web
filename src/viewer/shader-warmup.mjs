import * as THREE from 'three';
import { actorMeshWarmup } from './actor-mesh-draw.mjs';
import { spriteWarmup } from './sprite-scene.mjs';
import { decalWarmup } from './decal-scene.mjs';
import { detailWarmup } from './detail-scene.mjs';
import { coronaWarmup } from './corona-pass.mjs';
import { hudWarmup } from './hud.mjs';

/** Play's shader warm-up (docs/hitch-log.md "Shader programs"), host rendering only: the shader programs a level's draws
 * can need are built while the map loads, so no frame in play waits for the compiler. three.js builds a program the first
 * time a material is drawn with a program key it has not built, and checks its link status at once (a 50 to 120 ms stall
 * of the page's frame on the Linux host); a program it has built is shared by every material with that key.
 *
 * Two kinds of objects are compiled (renderer.compile):
 *
 *   - the level's own world (its BSP surfaces, movers, sky, fog surfaces) and the page's full-screen passes: their
 *     materials, as they are. Compiling a material binds nothing for later: its first draw derives its key again from
 *     its state then (three.js's setProgram), and finds the program built;
 *   - stand-ins for the materials made once play runs (actor meshes and their batches, the view model, sprites,
 *     decals, detail textures, coronas, mover fog items, HUD tiles), built by each factory's own construction with each
 *     state its draws can put on it (side, alpha test, opacity). Their programs are the ones those draws would build:
 *     the same onBeforeCompile and customProgramCacheKey, and the same key inputs (the stand-ins' map and geometry give
 *     the key what it reads from them: that a map exists, and which standard attributes the geometry has). They are
 *     never drawn, and they are kept until the next level's warm-up has built its programs, so the programs live on.
 *
 * Under the global clipping-plane shape the level's draws have: a level with mirrors gets the mirror passes' single
 * plane (disabled outside them) at its swap (mirrors.mjs clipShape); any other keeps the renderer's current one (none,
 * or that plane once a mirror level has been drawn).
 *
 * The driver compiles and links what the warm-up issued (the page's part is `mainMs`) while the load goes on; the
 * link checks that wait for it (each program's first use: WebGLProgram onFirstUse) run at `finish`, at the end of the
 * load, when the programs are built. With KHR_parallel_shader_compile, non-blocking completion polls measure when they
 * were (`ms`); without it (Firefox here) nothing is asked of a program before `finish`. ?shaderWarmup=0 turns it off. */
export const shaderWarmupOn = () => new URLSearchParams(location.search).get('shaderWarmup') !== '0';

export function createShaderWarmup(renderer) {
  let held = null;
  const camera = new THREE.PerspectiveCamera();
  const release = ({ standIns, texture, geometry }) => {
    standIns.traverse(object => object.material?.dispose());
    geometry.dispose(); texture.dispose();
  };
  return {
    /** Starts a level's warm-up: `world` (world.mjs), `gpu` its GPU mesh instance (null: the CPU path), `mirrors`
     * whether it has mirror planes, `detail` whether the detail-texture pass draws, `roots` the page's own passes'
     * scenes. Returns `finish()`, which resolves once every program is linked and checked, with {programs (built here),
     * mainMs, ms (until the polls saw them all linked; null without the extension), checkMs, parallel}, and
     * `dispose()` for a load that failed. */
    start({ world, gpu = null, displayGamma, mirrors = false, detail = false, roots = [] }) {
      const start = performance.now(), before = new Set(renderer.info.programs);
      // A map for the stand-ins (a compile reads only that one exists) and a geometry with the one standard attribute
      // their draws' geometries have (position; the corona tile's PlaneGeometry also has normal and is its own).
      const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      const standIns = new THREE.Group(), level = { standIns, texture, geometry };
      for (const object of [
        ...actorMeshWarmup({ gpu, displayGamma, batched: Boolean(gpu), mirrors, texture, geometry }),
        ...spriteWarmup({ displayGamma, texture }), ...decalWarmup({ displayGamma, texture, geometry }),
        ...(detail ? detailWarmup({ displayGamma, texture, geometry }) : []), ...coronaWarmup({ displayGamma, texture }),
        ...(world.fog?.root.parent ? world.fog.warmup(geometry) : []), ...hudWarmup({ texture, geometry }),
      ]) standIns.add(object);
      const saved = renderer.clippingPlanes;
      if (mirrors) renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(), 1)];
      try { for (const root of [world.root, standIns, ...roots]) renderer.compile(root, camera); }
      finally { renderer.clippingPlanes = saved; }
      const built = renderer.info.programs.filter(program => !before.has(program)), mainMs = performance.now() - start;
      // (a program three.js has deleted since, its last material disposed, has no GL program left to ask)
      const live = () => built.filter(program => program.program !== undefined);
      const parallel = renderer.extensions.has('KHR_parallel_shader_compile');
      // (a lost context never reports a completion status: its programs are built again after the restore, docs/context-loss.md)
      const gl = renderer.getContext();
      const linked = parallel ? (async () => {
        for (let waiting = built; waiting.length && !gl.isContextLost(); waiting = live().filter(program => !program.isReady()))
          await new Promise(resolve => setTimeout(resolve, 10));
        return performance.now() - start;
      })() : Promise.resolve(null);
      return {
        async finish() {
          const ms = await linked, mark = performance.now();
          for (const program of live()) program.getUniforms();
          const checkMs = performance.now() - mark;
          // The previous level's stand-ins release their programs (three.js deletes a program no material uses). Their
          // geometries were never drawn (a sprite's is the one THREE.Sprite shares, which stays).
          if (held && held !== level) release(held);
          held = level;
          return { programs: built.length, mainMs: Math.round(mainMs), ms: ms === null ? null : Math.round(ms),
            checkMs: Math.round(checkMs), parallel };
        },
        dispose() { if (held !== level) release(level); },
      };
    },
  };
}
