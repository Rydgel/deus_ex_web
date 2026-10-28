import { inRenderPass, renderPassControl } from '../runtime/render-precision.mjs';
import { buildWindowSceneFrame } from '../runtime/script-window-scene-frame.mjs';
import { setX87Precision } from '../runtime/script-vm.mjs';
import { identityOfHandle } from '../runtime/script-object-handles.mjs';
/** Validation only (scripts/validate-decals-play.mjs): stand the player a few
 * metres from a ScriptedPawn looking at its feet (`place`), or read that
 * pawn's Shadow and the level's FDecal state, on whichever side runs the
 * simulation (sim-worker.mjs `call`, or the page with ?sim=inline). */
export function decalProbe(game, { place = false, pawn = null, state = false } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const read = (a, n) => runtime.readNamed(a, n), level = runtime.levelFor(player);
  // `state` (visual-acceptance.mjs --decal-state): every live decal but the
  // Shadows, with its FDecal entries as `dump-actor-win.exe <name>
  // FDecals:0:decals` reads them from the original: per SurfList surface the
  // entries' actors in TArray order, and this decal's own (index, Vertices
  // bits, Nodes, MoverRotation).
  if (state) {
    const store = level.decals?.store, hex = b => (b >>> 0).toString(16).padStart(8, '0');
    const isA = (a, key) => { for (let c = runtime.instance(a)?.cls; c; c = c.base) if (c.record?.key === key) return true; return false; };
    return level.actors.filter(a => a && isA(a, 'engine.decal') && !isA(a, 'deusex.shadow')).map(actor => ({
      name: actor.name, cls: runtime.instance(actor).cls.record.key, location: read(actor, 'Location'), rotation: read(actor, 'Rotation'),
      drawScale: read(actor, 'DrawScale'), texture: read(actor, 'Texture')?.key ?? null, lastRendered: read(actor, 'LastRenderedTime'),
      surfaces: [...read(actor, 'SurfList')].map(s => {
        const entries = store ? store.surfaceDecals(s) : [];
        return { surface: s, order: entries.map(e => identityOfHandle(e.actor)?.name ?? null), own: entries.flatMap((e, k) =>
          identityOfHandle(e.actor) === actor ? [{ index: k, vertices: e.verticesBits.flat().map(hex), nodes: e.nodes, mover: e.moverRotation }] : []) };
      }),
    }));
  }
  if (place) {
    const isA = (a, key) => { for (let c = runtime.instance(a)?.cls; c; c = c.base) if (c.record?.key === key) return true; return false; };
    const pawns = level.actors.filter(a => a && isA(a, 'deusex.scriptedpawn') && read(a, 'Shadow') && !read(a, 'bHidden'));
    const target = pawns.find(a => /JaimeReyes/.test(a.name)) ?? pawns[0];
    const loc = read(target, 'Location'), h = read(target, 'CollisionHeight');
    const from = [loc[0] - 300, loc[1] + 120, loc[2] + 30];
    runtime.farMoveActor(player, from, 0, 1);
    // Aim at the pawn's feet (Location - CollisionHeight) from the eye.
    const eye = read(player, 'Location')[2] + read(player, 'BaseEyeHeight'), feet = loc[2] - h;
    const yaw = Math.round(Math.atan2(loc[1] - from[1], loc[0] - from[0]) * 32768 / Math.PI);
    const pitch = Math.round(-Math.atan2(eye - feet, Math.hypot(loc[0] - from[0], loc[1] - from[1])) * 32768 / Math.PI);
    runtime.writeNamed(player, 'ViewRotation', [(pitch + 65536) & 0xffff, (yaw + 65536) & 0xffff, 0]);
    return { name: target.name, shadow: read(target, 'Shadow').name };
  }
  const target = level.actors.find(a => a?.name === pawn), shadow = read(target, 'Shadow');
  return { surfList: [...read(shadow, 'SurfList')], hasDecal: read(shadow, 'bHasDecal'), lastRendered: read(shadow, 'LastRenderedTime'),
    time: read(level.actors[0], 'TimeSeconds'), records: level.decals?.store.count ?? 0 };
}

/** Validation only (scripts/validate-particles-play.mjs): `{place: name}` moves
 * the player to a ParticleGenerator (160 units short of it, 40 above, looking
 * up by 1,200 units of pitch); `{sample: name}` reads the generator's
 * RenderInterface ParticleIterator, its frozen flag, its proxy's
 * LastRenderTime and the live particles' heights, on whichever side runs the
 * simulation (sim-worker.mjs `call`, or the page with ?sim=inline). */
export function particleProbe(game, { place = null, sample = null } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor, read = (a, n) => runtime.readNamed(a, n);
  const level = runtime.levelFor(player);
  if (place) {
    const generator = level.actors.find(a => a?.name === place), loc = read(generator, 'Location');
    runtime.farMoveActor(player, [loc[0] - 160, loc[1], loc[2] + 40], 0, 1);
    runtime.writeNamed(player, 'ViewRotation', [65536 - 1200, 0, 0]);
    return { generator: generator.name, location: loc };
  }
  const generator = level.actors.find(a => a?.name === sample), iterator = read(generator, 'RenderInterface'), proxy = read(generator, 'proxy');
  const particles = iterator ? read(iterator, 'Particles').filter(p => p['deusex.particleiterator.sparticle.bactive'])
    .map(p => ({ z: p['deusex.particleiterator.sparticle.location'][2], life: p['deusex.particleiterator.sparticle.lifespan'] })) : [];
  return { iterator: iterator ? runtime.instance(iterator).cls.record.key : null, frozen: read(generator, 'bFrozen'),
    time: read(level.actors[0], 'TimeSeconds'), proxyLast: read(proxy, 'LastRenderTime'), particles };
}

/** Validation only (validate-volumetric-fog-play.mjs, validate-coronas-play
 * and other checks of a view): move the player to `location` (optional) and
 * set its ViewRotation to `rotation`, or aim the view from the eye at the
 * level actor named `lookAt`, or write properties of an actor (`set`), on the
 * simulation side (sim-worker.mjs
 * `call`, or the page with ?sim=inline). */
export function placeProbe(game, { location = null, rotation = null, lookAt = null, set = null }) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  // `set` {actor, fields}: write script properties of a level actor (or of
  // '$player'; validate-coronas-play: make a static corona light a moving-light
  // candidate; census-frame-projection: the FOV).
  if (set) {
    const target = set.actor === '$player' ? player : runtime.levelFor(player).actors.find(a => a?.name === set.actor);
    if (!target) throw new Error(`placeProbe: no actor ${set.actor}`);
    for (const [name, value] of Object.entries(set.fields)) runtime.writeNamed(target, name, value);
  }
  if (location) runtime.farMoveActor(player, location, 0, 1);
  if (lookAt) {
    const target = runtime.levelFor(player).actors.find(a => a?.name === lookAt), at = runtime.readNamed(target, 'Location');
    const eye = game.view().location, d = at.map((v, i) => v - eye[i]);
    const units = r => Math.round(r * 32768 / Math.PI);
    rotation = [(units(Math.atan2(d[2], Math.hypot(d[0], d[1]))) + 65536) % 65536, (units(Math.atan2(d[1], d[0])) + 65536) % 65536, 0];
  }
  if (rotation) runtime.writeNamed(player, 'ViewRotation', rotation);
  return { location: runtime.readNamed(player, 'Location'), rotation };
}

/** Validation only (validate-lasers-play.mjs): the level's LaserEmitters,
 * their iterators' active beams and proxies, and the actor mesh layer's
 * iterator item slots (actor-mesh-sim.mjs itemSlots: binding ids, null when
 * free), read on the simulation side. */
export function laserProbe(game, actorSim) {
  const runtime = game.doors.scriptRuntime.runtime, level = runtime.levelFor(game.player.collisionActor);
  const read = (a, n) => runtime.readNamed(a, n);
  const emitters = level.actors.filter(a => { try { return a && runtime.instance(a).cls.record.key === 'deusex.laseremitter'; } catch { return false; } });
  return {
    emitters: emitters.map(e => {
      const it = read(e, 'RenderInterface');
      const beams = it ? read(it, 'Beams').filter(b => b['deusex.laseriterator.sbeam.bactive']) : [];
      return { iterator: it ? runtime.instance(it).cls.record.key : null, on: read(e, 'bIsOn'), frozen: read(e, 'bFrozen'),
        maxItems: it ? read(it, 'MaxItems') : 0, beams: beams.map(b => ({ length: b['deusex.laseriterator.sbeam.length'],
          segments: b['deusex.laseriterator.sbeam.numsegments'] })), proxy: read(e, 'proxy').name,
        proxyLast: read(read(e, 'proxy'), 'LastRenderTime') };
    }),
    slots: actorSim?.itemSlots?.() ?? null,
    time: read(level.actors[0], 'TimeSeconds'),
  };
}

/** Validation only (validate-mesh-light-types-play.mjs): `{watch: name}`
 * keeps the mesh light setups of the actor named (mesh-lighting-view.mjs
 * `watch`) from the next frame on; `{take: true}` returns and clears them,
 * with the actor's Location; run on the simulation side. */
export function meshLightProbe(meshLighting, game, { watch = null, take = false } = {}) {
  if (!meshLighting) return null;
  if (watch) { meshLighting.watch = { name: watch, records: [] }; return { watching: watch }; }
  if (!take || !meshLighting.watch) return null;
  const runtime = game.doors.scriptRuntime.runtime, level = runtime.levelFor(game.player.collisionActor);
  const actor = level.actors.find(a => a?.name === meshLighting.watch.name);
  const records = meshLighting.watch.records;
  meshLighting.watch.records = [];
  return { records, location: actor ? runtime.readNamed(actor, 'Location') : null };
}

/** Validation only (validate-render-pass-script-play.mjs), on the simulation
 * side. `{locate: name}` returns a level actor's Location; `{take: name}` picks up the named inventory actor through the public
 * Use path (the view must already select it: placeProbe lookAt) and
 * activates its belt slot; `{}` reads the weapon the last frame's
 * RenderOverlays placed (Location, Rotation, its owner's Location) with the
 * original CalcDrawOffset evaluated again by the script VM inside the
 * render pass (24 bits) and on the game thread (64), and the HUD scene
 * frame the last paint wrote with ComputeRenderSize's projection at both
 * precisions. */
export async function renderPassProbe(game, { take = null, locate = null, time = 0 } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor, read = (a, n) => runtime.readNamed(a, n);
  if (locate) return read(runtime.levelFor(player).actors.find(a => a?.name === locate), 'Location');
  if (take) {
    const item = runtime.levelFor(player).actors.find(a => a?.name === take);
    const used = game.use();
    const belt = game.hud.read(game.hud.hud, 'belt');
    const position = game.hud.read(belt, 'objects').findIndex(slot => game.hud.read(slot, 'item') === item);
    const equipped = position >= 0 ? await game.activateBelt(position) : { ok: false };
    return { used: used?.message ?? null, position, equipped: equipped.ok };
  }
  const weapon = read(player, 'Weapon');
  if (time) {
    // Measurement only: Weapon.CalcDrawOffset (the script math of
    // RenderOverlays' placement) with the render pass's precision on and
    // off, alternating, in microseconds per call (batches of 100).
    const call = () => runtime.callFunction(runtime.lookup(weapon, 'CalcDrawOffset'), weapon);
    const on = [], off = [], now = () => performance.now();
    for (let i = 0; i < time * 2; i++) {
      renderPassControl.enabled = !(i & 1);
      const t = now(); for (let k = 0; k < 100; k++) inRenderPass(runtime, call); (i & 1 ? off : on).push((now() - t) * 10);
    }
    renderPassControl.enabled = true;
    const med = a => a.sort((x, y) => x - y)[a.length >> 1];
    return { precision24Us: med(on), precision64Us: med(off) };
  }
  const offset = () => runtime.callFunction(runtime.lookup(weapon, 'CalcDrawOffset'), weapon).map(Math.fround);
  const frame = game.hud?.host?.lastSceneFrame ?? null;
  const projection = bits => { const previous = setX87Precision(bits); try { return buildWindowSceneFrame(frame.input).projectionZ; }
    finally { setX87Precision(previous); } };
  return {
    weapon: weapon?.name ?? null,
    location: weapon ? read(weapon, 'Location') : null, rotation: weapon ? read(weapon, 'Rotation') : null,
    owner: read(player, 'Location'), viewRotation: read(player, 'ViewRotation'),
    offset24: weapon ? inRenderPass(runtime, offset) : null, offset64: weapon ? offset() : null,
    sceneFrame: frame ? { width: frame.input.width, height: frame.input.height, fov: frame.input.fov, projectionZ: frame.value.projectionZ,
      projection24: projection(24), projection64: projection(64) } : null,
  };
}
