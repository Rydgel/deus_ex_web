/** DeusEx.dll's ParticleIterator natives (docs/particles.md). */
import { x87load, x87double, x87mul, x87add, x87neg, x87div, x87store, x87cmp } from './script-vm.mjs';

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
 * and the proxy is drawn there. Returns the proxy's sprite states in order. */
export function particleIteratorItems(runtime, iterator, camera, { processEvent, farMoveActor }) {
  processEvent(iterator, 'Init', [camera]);
  runtime.writeNamed(iterator, 'Observer', camera);
  const items = [], max = runtime.readNamed(iterator, 'MaxItems') | 0, proxy = runtime.readNamed(iterator, 'proxy');
  let state = null;
  for (let index = 0; index < max; index++) {
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
  runtime.writeNamed(iterator, 'Index', max);
  return items;
}
