/** DeusEx.dll's ParticleIterator natives (docs/particles.md). */
import { x87load, x87double, x87mul, x87add, x87neg, x87div, x87store, x87cmp } from './script-vm.mjs';
import { particlesMode, particleItemsMode, particleItemCounts, NOT_RUN } from './script-vm-particles.mjs';
import { inRenderPass } from './render-precision.mjs';

const f = Math.fround;
export const PARTICLE_COUNT = 64;

/** UParticleIterator::DeleteParticle (0x1001aaf0): an active particle in
 * range goes inactive and becomes nextFreeParticle. */
export function deleteParticle(state, i) {
  if (i < 0 || i >= PARTICLE_COUNT || !state.particles[i].active) return;
  state.particles[i].active = false;
  state.nextFreeParticle = i;
}

/** execUpdateParticles (native 3017, 0x1001ac50) after its float
 * parameter. For each active particle: LifeSpan counts down (to -1 once it
 * reaches 0) and a negative LifeSpan deletes it; X and Y velocity re-jitter
 * from appFrand, `float(initVel + 2) − frand·5`; Z takes gravity,
 * `dt·ZoneGravity·0.2 + Vz`, or the rise `(frand·0.2 + 0.9)·((OwnerLifeSpan
 * − LifeSpan)·RiseRate) + initVel.Z`; DrawScale is `(OwnerLifeSpan −
 * LifeSpan + 1)·OwnerDrawScale` clamped to [0.01, 3] or OwnerDrawScale;
 * ScaleGlow is LifeSpan/OwnerLifeSpan or 1; Location advances by dt·V (X on
 * the unrounded product). The proxy is hidden when no particle survived.
 * `frand` is the shared appFrand stream (the script FRand's); the chains
 * run on the x87 model with the original float stores. */
export function updateParticles(state, deltaTime, frand) {
  const dt = x87load(f(deltaTime)), ZERO = x87double(0);
  let noneActive = true;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = state.particles[i];
    if (!p.active) continue;
    if (p.lifeSpan > 0) {
      const left = x87add(x87load(p.lifeSpan), x87neg(dt));
      p.lifeSpan = x87cmp(left, ZERO) === 'gt' ? x87store(left) : -1;
    }
    if (p.lifeSpan < 0) { deleteParticle(state, i); continue; }
    noneActive = false;
    for (const axis of [0, 1]) {
      const base = x87load(x87store(x87add(x87load(p.initVel[axis]), x87double(2))));
      p.velocity[axis] = x87store(x87add(base, x87neg(x87mul(x87double(frand()), x87load(f(5))))));
    }
    if (state.gravity) {
      p.velocity[2] = x87store(x87add(x87mul(x87mul(dt, x87load(state.zoneGravity)), x87double(0.2)), x87load(p.velocity[2])));
    } else {
      const jitter = x87add(x87mul(x87double(frand()), x87double(0.2)), x87double(0.9));
      const age = x87mul(x87add(x87load(state.ownerLifeSpan), x87neg(x87load(p.lifeSpan))), x87load(state.riseRate));
      p.velocity[2] = x87store(x87add(x87mul(jitter, age), x87load(p.initVel[2])));
    }
    if (state.scales) {
      const scale = x87mul(x87add(x87add(x87load(state.ownerLifeSpan), x87neg(x87load(p.lifeSpan))), x87double(1)), x87load(state.ownerDrawScale));
      p.drawScale = x87cmp(scale, x87double(0.01)) === 'lt' ? f(0.01)
        : x87cmp(scale, x87double(3)) === 'lt' ? x87store(scale) : 3;
    } else p.drawScale = state.ownerDrawScale;
    p.scaleGlow = state.fades ? x87store(x87div(x87load(p.lifeSpan), x87load(state.ownerLifeSpan))) : 1;
    const step = axis => x87mul(dt, x87load(p.velocity[axis]));
    const dy = x87store(step(1)), dz = x87store(step(2));
    p.location[0] = x87store(x87add(step(0), x87load(p.location[0])));
    p.location[1] = x87store(x87add(x87load(dy), x87load(p.location[1])));
    p.location[2] = x87store(x87add(x87load(dz), x87load(p.location[2])));
  }
  state.proxyHidden = noneActive;
  return state;
}

// The script-visible sParticle members (DeusEx.ParticleIterator).
const MEMBER = name => `deusex.particleiterator.sparticle.${name}`;

function readIteratorState(runtime, iterator) {
  const read = name => runtime.readNamed(iterator, name);
  return {
    particles: read('Particles').map(p => ({ active: Boolean(p[MEMBER('bactive')]), initVel: [...p[MEMBER('initvel')]].map(f),
      velocity: [...p[MEMBER('velocity')]].map(f), location: [...p[MEMBER('location')]].map(f), drawScale: f(p[MEMBER('drawscale')]),
      scaleGlow: f(p[MEMBER('scaleglow')]), lifeSpan: f(p[MEMBER('lifespan')]) })),
    nextFreeParticle: read('nextFreeParticle') | 0, gravity: Boolean(read('bOwnerUsesGravity')), scales: Boolean(read('bOwnerScales')),
    fades: Boolean(read('bOwnerFades')), zoneGravity: f(read('OwnerZoneGravity')), riseRate: f(read('OwnerRiseRate')),
    ownerLifeSpan: f(read('OwnerLifeSpan')), ownerDrawScale: f(read('OwnerDrawScale')),
  };
}

function writeParticles(runtime, iterator, state) {
  runtime.writeNamed(iterator, 'Particles', state.particles.map(p => ({ [MEMBER('bactive')]: p.active, [MEMBER('initvel')]: p.initVel,
    [MEMBER('velocity')]: p.velocity, [MEMBER('location')]: p.location, [MEMBER('drawscale')]: p.drawScale,
    [MEMBER('scaleglow')]: p.scaleGlow, [MEMBER('lifespan')]: p.lifeSpan })));
  runtime.writeNamed(iterator, 'nextFreeParticle', state.nextFreeParticle);
}

/** Native 3017 on a live iterator: the shared appFrand stream and the
 * proxy's bHidden (Actor +0x28 bit 1) as the original writes them. */
export function execUpdateParticles(runtime, iterator, deltaTime, frand) {
  // The update in Rust over the iterator's own cells (particles.rs), or
  // null where it must run here (script-vm-particles.mjs).
  const host = runtime.scriptVm?.particles;
  if (host) {
    const verify = particlesMode() === 'verify', draws = [];
    const before = verify ? readIteratorState(runtime, iterator) : null;
    const hidden = host.update(iterator, deltaTime, verify ? () => { const v = frand(); draws.push(v); return v; } : frand);
    if (hidden !== null) {
      if (verify) {
        const want = updateParticles(before, deltaTime, () => draws.shift()), got = readIteratorState(runtime, iterator);
        const same = (a, b) => Array.isArray(a) ? a.every((v, i) => same(v, b[i]))
          : a && typeof a === 'object' ? Object.keys(a).every(key => same(a[key], b[key])) : Object.is(a, b);
        if (draws.length || want.proxyHidden !== hidden || !same(want.particles, got.particles) ||
          want.nextFreeParticle !== got.nextFreeParticle)
          throw new Error(`PARTICLES=verify: ${iterator.name} UpdateParticles differs in Rust`);
      }
      const proxy = runtime.readNamed(iterator, 'proxy');
      if (proxy) runtime.writeNamed(proxy, 'bHidden', hidden);
      return;
    }
  }
  const state = updateParticles(readIteratorState(runtime, iterator), deltaTime, frand);
  writeParticles(runtime, iterator, state);
  const proxy = runtime.readNamed(iterator, 'proxy');
  if (proxy) runtime.writeNamed(proxy, 'bHidden', state.proxyHidden);
}

/** URender::SetupDynamics' RenderInterface rule (0x10b22f42-0x10b22fd2):
 * an actor with a RenderIteratorClass and no valid interface gets one from
 * StaticConstructObject (Outer = the actor, the class defaults). `construct`
 * builds the object; returns the interface or null. */
export function ensureRenderInterface(runtime, actor, construct) {
  const cls = runtime.readNamed(actor, 'RenderIteratorClass');
  let iterator = runtime.readNamed(actor, 'RenderInterface');
  if (!cls) return null;
  if (!iterator) { iterator = construct(cls, actor); runtime.writeNamed(actor, 'RenderInterface', iterator); }
  return iterator;
}

/** One frame of the render-iterator protocol for a ParticleIterator
 * (SetupDynamics 0x10b22fee-0x10b2307c with Engine's URenderIterator and
 * DeusEx's CurrentItem 0x1001ab20): Init(Camera) runs the script Init and
 * stores Observer; Index runs from 0 while below MaxItems; for an active
 * particle CurrentItem copies DrawScale and ScaleGlow onto the proxy and
 * FarMoveActors it to the particle (a failed move deletes the particle),
 * and the proxy is drawn there. Returns the proxy's sprite states in order.
 *
 * The loop runs in Rust over the iterator's cells (particles.rs `particle_items`)
 * for an iterator and a proxy the object image holds, stopping at a move the Rust
 * core declines (a zone change, which runs script events): the JavaScript takes
 * that step and the Rust loop goes on after it. PARTICLE_ITEMS=js keeps the
 * reference loop (`referenceItems`); =verify repeats every Rust run with it. */
export function particleIteratorItems(runtime, iterator, camera, { processEvent, farMoveActor }) {
  // SetupDynamics runs Init(Camera) inside the render pass (render-precision.mjs).
  inRenderPass(runtime, () => processEvent(iterator, 'Init', [camera]));
  runtime.writeNamed(iterator, 'Observer', camera);
  const max = runtime.readNamed(iterator, 'MaxItems') | 0, proxy = runtime.readNamed(iterator, 'proxy');
  const items = (proxy && max > 0 ? nativeItems(runtime, iterator, proxy, max, farMoveActor) : null)
    ?? referenceItems(runtime, iterator, proxy, 0, max, farMoveActor);
  runtime.writeNamed(iterator, 'Index', max);
  return items;
}

/** The loop of `particleIteratorItems` from Index `from` below `to` as the JavaScript has always run it: Index is written for
 * each, then (with a proxy) an active particle's DrawScale and ScaleGlow onto the proxy, its FarMoveActor, a failed move's
 * DeleteParticle, and the item of a successful one. The iterator's particles are read once, at the first Index with a proxy. */
function referenceItems(runtime, iterator, proxy, from, to, farMoveActor) {
  const items = [];
  let state = null;
  for (let index = from; index < to; index++) {
    runtime.writeNamed(iterator, 'Index', index);
    if (!proxy) continue;
    state ??= readIteratorState(runtime, iterator);
    const p = state.particles[index];
    if (!p?.active) continue;
    runtime.writeNamed(proxy, 'DrawScale', p.drawScale);
    runtime.writeNamed(proxy, 'ScaleGlow', p.scaleGlow);
    if (!farMoveActor(proxy, p.location)) { deleteParticle(state, index); writeParticles(runtime, iterator, state); continue; }
    items.push({ actor: proxy, location: runtime.readNamed(proxy, 'Location').map(f), drawScale: p.drawScale, scaleGlow: p.scaleGlow });
  }
  return items;
}

// What a run of the loop writes: the iterator's particles, nextFreeParticle and Index, and the proxy's fields.
const PROXY_FIELDS = ['DrawScale', 'ScaleGlow', 'Location', 'OldLocation', 'bJustTeleported', 'Region'];
const takeState = (runtime, iterator, proxy) => ({ state: readIteratorState(runtime, iterator), index: runtime.readNamed(iterator, 'Index'),
  proxy: PROXY_FIELDS.map(name => runtime.readNamed(proxy, name)) });
function putState(runtime, iterator, proxy, saved) {
  writeParticles(runtime, iterator, saved.state);
  runtime.writeNamed(iterator, 'Index', saved.index);
  PROXY_FIELDS.forEach((name, i) => runtime.writeNamed(proxy, name, saved.proxy[i]));
}
// Values by Object.is, arrays element by element; an object (a struct, a host object) by its members one level down, each member by the
// same rule: a Region's zone is an actor, compared by identity, never walked.
const sameValue = (a, b) => Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i])) : Object.is(a, b);
const sameStruct = (a, b) => a && typeof a === 'object' && !Array.isArray(a)
  ? Boolean(b) && typeof b === 'object' && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => sameValue(a[key], b[key]))
  : sameValue(a, b);
const sameState = (a, b) => Object.keys(a).every(key => key === 'particles'
  ? a.particles.length === b.particles.length && a.particles.every((p, i) => sameStruct(p, b.particles[i])) : sameValue(a[key], b[key]));

/** The loop in Rust for `max` > 0 and a proxy: the items, or null where the reference loop must run (the mode, an iterator or
 * proxy the image does not hold, no world BSP in the core). */
function nativeItems(runtime, iterator, proxy, max, farMoveActor) {
  const host = runtime.scriptVm?.particles, mode = particleItemsMode();
  if (!host || mode === 'js') return null;
  const instance = host.itemsInstance(iterator);
  if (!instance) { particleItemCounts.jsIterators++; return null; }
  let context = runtime.farMoveContext(proxy);
  if (!context || !context.world) { particleItemCounts.jsIterators++; return null; }
  particleItemCounts.iterators++;
  const items = [];
  for (let start = 0; start < max;) {
    const next = mode === 'verify' ? verifiedRun(runtime, host, instance, iterator, proxy, context, start, max, items)
      : host.items(instance, proxy, context.model, context.world, start, max, items);
    if (next === NOT_RUN) {
      // The proxy is not in the image: the reference loop takes the rest.
      particleItemCounts.jsIterators++;
      items.push(...referenceItems(runtime, iterator, proxy, start, max, farMoveActor));
      break;
    }
    particleItemCounts.steps += Math.min(next, max) - start;
    if (next >= max) break;
    // The move at Index `next` runs script events (or is one the core leaves): the step as the reference takes it.
    particleItemCounts.handedBack++;
    runtime.writeNamed(iterator, 'Index', next);
    const p = host.particle(instance, next);
    if (p.active) {
      runtime.writeNamed(proxy, 'DrawScale', p.drawScale);
      runtime.writeNamed(proxy, 'ScaleGlow', p.scaleGlow);
      if (!farMoveActor(proxy, p.location)) { host.deleteParticle(instance, next); particleItemCounts.failed++; }
      else items.push({ actor: proxy, location: runtime.readNamed(proxy, 'Location').map(f), drawScale: p.drawScale, scaleGlow: p.scaleGlow });
    }
    start = next + 1;
    // A script event may have changed the tracker's model or the zone model: what the core needs is asked again.
    context = runtime.farMoveContext(proxy);
    if (!context || !context.world) {
      if (start < max) items.push(...referenceItems(runtime, iterator, proxy, start, max, farMoveActor));
      break;
    }
  }
  return items;
}

/** PARTICLE_ITEMS=verify: one Rust run from `start`, then the same steps by the JavaScript loop from the state before it, with
 * the recovered relocation body as FarMoveActor, and every written field compared: the particles and nextFreeParticle, Index,
 * the proxy's DrawScale, ScaleGlow, Location, OldLocation, bJustTeleported and Region, and the items. Leaves the reference's
 * state (equal to the Rust run's). Returns the Rust run's next Index. */
function verifiedRun(runtime, host, instance, iterator, proxy, context, start, max, into) {
  const before = takeState(runtime, iterator, proxy), got = [];
  const next = host.items(instance, proxy, context.model, context.world, start, max, got);
  if (next === NOT_RUN) return next;
  const rust = takeState(runtime, iterator, proxy);
  putState(runtime, iterator, proxy, before);
  const want = referenceItems(runtime, iterator, proxy, start, next, (target, destination) => runtime.relocateSpawnedActor(target, destination, 0, 0));
  const reference = takeState(runtime, iterator, proxy);
  // Index: the last step the run took (the declined one included), or untouched.
  const index = next < max ? next : max > start ? max - 1 : before.index;
  const differs = what => { throw new Error(`PARTICLE_ITEMS=verify: ${iterator.name} Index ${start}..${next}: ${what} differs in Rust`); };
  if (!sameState(rust.state, reference.state)) differs('the particles');
  if (rust.index !== index) differs(`Index (${rust.index}, expected ${index})`);
  PROXY_FIELDS.forEach((name, i) => { if (!sameStruct(rust.proxy[i], reference.proxy[i])) differs(name); });
  if (got.length !== want.length || !got.every((item, i) => item.actor === want[i].actor && sameValue(item.location, want[i].location) &&
    Object.is(item.drawScale, want[i].drawScale) && Object.is(item.scaleGlow, want[i].scaleGlow))) differs('the items');
  particleItemCounts.verified++;
  particleItemCounts.verifiedSteps += next - start;
  into.push(...got);
  return next;
}
