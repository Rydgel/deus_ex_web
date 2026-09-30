/** Pawn walking kernels in Rust (native/script-vm/src/walk.rs,
 * docs/rust-core.md R3-b stage B3), hosted for validation. Each function has
 * the interface of its JavaScript reference (velocity.mjs, steps.mjs), which
 * stays authoritative: Play does not call these yet. stepUp's pawn is the
 * caller's object; every view access walk.rs's PawnOps makes is one import
 * here, in the reference's order. */
import {compileScriptVm} from './script-vm-kernel.mjs';

let pending = null;
/** Load the hosted kernel once. */
export function loadWalkKernel() {
  return pending ??= load();
}

// WALK_KERNEL_WASM=path (Node only): a separately built module, for
// mutation runs that must not replace the shared script-vm.wasm.
const MODULE_PATH = typeof process !== 'undefined' ? process.env?.WALK_KERNEL_WASM : undefined;

async function load() {
  const module = MODULE_PATH
    ? await WebAssembly.compile(await (await import(/* @vite-ignore */ 'node:fs/promises')).readFile(MODULE_PATH))
    : await compileScriptVm();
  const memory = new WebAssembly.Memory({initial: 32});
  // stepUp's pawn, its move results by id (1-based) and hit actors by id.
  let pawn = null, hits = [null], actors = [null], actorIds = new Map();
  let x = null, io = null;
  const views = () => { io = new Float64Array(memory.buffer, x.walk_io_ptr(), 32); };
  const actorId = actor => {
    if (actor == null) return 0;
    let id = actorIds.get(actor);
    if (id === undefined) { id = actors.length; actors.push(actor); actorIds.set(actor, id); }
    return id;
  };
  const walkImports = {
    walk_max_step_height: () => pawn.maxStepHeight,
    walk_move() {
      views();
      const hit = pawn.move([io[0], io[1], io[2]]);
      views();
      hits.push(hit);
      io[0] = hit.time;
      io[1] = hit.normal[0]; io[2] = hit.normal[1]; io[3] = hit.normal[2];
      io[4] = actorId(hit.actor);
      io[5] = hits.length - 1;
    },
    walk_hit_wall: id => { pawn.hitWall(hits[id]); },
    walk_physics: () => pawn.physics,
    walk_is_player: () => pawn.isPlayer ? 1 : 0,
    walk_pushable: id => hits[id].actor?.pushableDecoration ? 1 : 0,
    walk_set_just_teleported: () => { pawn.justTeleported = true; },
    walk_mass: () => pawn.mass,
    walk_actor_mass: id => hits[id].actor.mass,
    walk_velocity() {
      const velocity = pawn.velocity;
      views();
      io[0] = velocity[0]; io[1] = velocity[1]; io[2] = velocity[2];
    },
    walk_set_velocity() { views(); pawn.velocity = [io[0], io[1], io[2]]; },
  };
  const imports = {memory};
  for (const {module: from, name, kind} of WebAssembly.Module.imports(module)) {
    if (from === 'env' && kind === 'function') imports[name] = walkImports[name] ?? (() => {
      throw new Error(`The walk kernel instance does not run scripts (${name})`);
    });
  }
  const instance = await WebAssembly.instantiate(module, {env: imports});
  x = instance.exports;
  views();
  const in3 = (at, v) => { io[at] = v[0]; io[at + 1] = v[1]; io[at + 2] = v[2]; };
  const out3 = at => [io[at], io[at + 1], io[at + 2]];
  return {
    hypot: (a, b) => x.walk_hypot(a, b),
    safeNormal(vector) { views(); in3(0, vector); x.walk_safe_normal(); return out3(0); },
    twoWallAdjust({desired, delta, normal, oldNormal, time}) {
      views(); in3(0, desired); in3(3, delta); in3(6, normal); in3(9, oldNormal); io[12] = time;
      x.walk_two_wall_adjust();
      return out3(0);
    },
    groundVelocity({velocity, acceleration, direction, dt, maxSpeed, accelRate, friction, walking = false}) {
      views();
      in3(0, velocity); in3(3, acceleration); in3(6, direction);
      io[9] = dt; io[10] = maxSpeed; io[11] = accelRate; io[12] = friction; io[13] = walking ? 1 : 0;
      if (!x.walk_ground_velocity()) throw new Error('Ground velocity requires an original actor timestep in (0, 0.4]');
      return {velocity: out3(0), acceleration: out3(3)};
    },
    stepUp(stepPawn, gravityDirection, desiredDirection, delta) {
      const outer = [pawn, hits, actors, actorIds], stack = x.__stack_pointer.value;
      pawn = stepPawn; hits = [null]; actors = [null]; actorIds = new Map();
      try {
        views(); in3(0, gravityDirection); in3(3, desiredDirection); in3(6, delta);
        const id = x.walk_step_up();
        if (id === 0) throw new Error('Original stepUp recursion budget exceeded');
        return hits[id];
      } catch (error) {
        // An import threw through the Rust frames: their shadow stack
        // frames are abandoned.
        x.__stack_pointer.value = stack;
        throw error;
      } finally {
        [pawn, hits, actors, actorIds] = outer;
      }
    },
  };
}
