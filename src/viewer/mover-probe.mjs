/** Validation only (docs/brush-tracker.md "Play"): the moving brush
 * tracker's movers on whichever side runs the simulation (sim-worker.mjs
 * `call`, or the page with ?sim=inline). `set` writes movers' Location
 * (and Rotation) directly, as a test placement; returns each tracked
 * mover's fragment count and the polygons the last main frame drew.
 * `renderTimes` adds every actor's LastRenderTime (name to seconds). */
export function moverProbe(game, session, { set = null, renderTimes = false, points = false } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, level = runtime.levelFor(game.player.collisionActor);
  for (const { name, location, offset, rotation } of set ?? []) {
    const actor = level.actors.find(a => a?.name === name);
    if (!actor) throw new Error(`moverProbe: no actor ${name}`);
    const at = offset ? [...runtime.readNamed(actor, 'Location')].map((v, i) => v + offset[i]) : location;
    // A mover through the collision model (its hash entry and the collider
    // offset the page draws it with), as MoveActor leaves it.
    const mover = game.collision.movers.find(m => m.name === name);
    if (at && mover) game.collision.setMoverPosition(mover, at);
    else if (at) runtime.writeNamed(actor, 'Location', at.map(Math.fround));
    if (rotation) runtime.writeNamed(actor, 'Rotation', rotation.map(v => v | 0));
  }
  const state = session.moverState({ points });
  if (renderTimes) state.renderTimes = Object.fromEntries(level.actors.filter(Boolean)
    .map(actor => [actor.name, runtime.readNamed(actor, 'LastRenderTime')]));
  return state;
}

/** Validation only (validate-decals-play.mjs --mover, docs/decals.md
 * "Movers"): a BulletHole on a tracked mover's fragment, spawned as
 * TraceHitSpawner spawns one (Owner the hit Mover, at the hit point plus the
 * normal, Rotation the normal's rotator). `place` picks the tracked mover
 * `name` (or, in Level.Actors order, the first whose largest fragment has
 * at least `minArea` square units), stands the player `distance` units out
 * along that fragment's normal and aims at its centre. `spawn` spawns the
 * BulletHole. Returns the decal's SurfList, Base and Owner, the tracker
 * surfaces holding FDecals, the fragment's plane now (the tracked model's
 * surface base point and normal) and the last frame's decal fragments in
 * world space, by texture. */
const decalState = { mover: null, surface: -1, decal: null };
export function moverDecalProbe(game, session, { place = false, name = null, minArea = 2000, distance = 160, spawn = false } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor, level = runtime.levelFor(player);
  const source = level.decalSource, read = (a, n) => runtime.readNamed(a, n);
  if (!source) return { tracker: false };
  const sub = (a, b) => a.map((v, i) => v - b[i]), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (place) {
    const model = source.model();
    let chosen = null;
    for (const { actor, surfaces } of source.movers()) {
      if (name ? actor.name !== name : read(actor, 'bHidden')) continue;
      const mine = new Set(surfaces);
      let best = null;
      for (let n = model.originalNodes; n < model.nodes.length; n++) {
        const node = model.nodes[n];
        if (node.vertexCount < 3 || !mine.has(node.surface)) continue;
        const points = Array.from({ length: node.vertexCount }, (_, k) => model.points[model.vertices[node.vertexPool + k].point]);
        const normal = model.vectors[model.surfaces[node.surface].normal];
        let area = 0;
        for (let k = 1; k + 1 < points.length; k++) area += dot(cross(sub(points[k], points[0]), sub(points[k + 1], points[0])), normal) / 2;
        const centre = [0, 1, 2].map(c => points.reduce((sum, p) => sum + p[c], 0) / points.length);
        if (!best || Math.abs(area) > best.area) best = { actor, surface: node.surface, node: n, centre, normal, area: Math.abs(area) };
      }
      if (best && (name || best.area >= minArea)) { chosen = best; break; }
    }
    if (!chosen) throw new Error(`moverDecalProbe: no tracked mover fragment${name ? ` on ${name}` : ''}`);
    Object.assign(decalState, { mover: chosen.actor, surface: chosen.surface, centre: chosen.centre, normal: chosen.normal, decal: null });
    const from = chosen.centre.map((v, i) => v + chosen.normal[i] * distance);
    runtime.farMoveActor(player, from, 0, 1);
    const eye = [...read(player, 'Location')]; eye[2] += read(player, 'BaseEyeHeight');
    const d = sub(chosen.centre, eye), units = r => Math.round(r * 32768 / Math.PI);
    runtime.writeNamed(player, 'ViewRotation', [(units(Math.atan2(d[2], Math.hypot(d[0], d[1]))) + 65536) % 65536,
      (units(Math.atan2(d[1], d[0])) + 65536) % 65536, 0]);
  }
  if (spawn) {
    const cls = [...runtime.linkedClasses].find(c => c.record.key === 'deusex.bullethole');
    if (!cls) throw new Error('moverDecalProbe: BulletHole is not linked in this level');
    const { centre, normal } = decalState, units = r => Math.round(r * 32768 / Math.PI);
    // TraceHitSpawner: Spawn(class'BulletHole', Other,, Location + Vector(Rotation), Rotation),
    // the spawner at the hit with Rotator(HitNormal).
    const rotation = [(units(Math.atan2(normal[2], Math.hypot(normal[0], normal[1]))) + 65536) % 65536,
      (units(Math.atan2(normal[1], normal[0])) + 65536) % 65536, 0];
    const location = centre.map((v, i) => Math.fround(v + normal[i]));
    decalState.decal = runtime.spawnActor({ cls: cls.record, level, name: 'None', owner: decalState.mover, instigator: null, location, rotation });
  }
  const model = source.model(), decal = decalState.decal;
  const surface = decalState.surface >= 0 ? model.surfaces[decalState.surface] : null;
  const top = source.firstSurface, held = [];
  for (let s = top; s < model.surfaces.length; s++) if (level.decals?.store.surfaceDecals(s).length) held.push(s);
  const fromView = ([x, y, z]) => [-z, x, y];
  return {
    tracker: true, mover: decalState.mover?.name ?? null, surface: decalState.surface,
    moverLocation: decalState.mover ? [...read(decalState.mover, 'Location')] : null,
    moverRotation: decalState.mover ? [...read(decalState.mover, 'Rotation')] : null,
    plane: surface ? { base: model.points[surface.base], normal: model.vectors[surface.normal] } : null,
    decal: decal ? { name: decal.name, live: level.actors.includes(decal), surfList: [...read(decal, 'SurfList')],
      base: read(decal, 'Base')?.name ?? null, owner: read(decal, 'Owner')?.name ?? null,
      lastRendered: read(decal, 'LastRenderedTime'), texture: read(decal, 'Texture')?.key ?? null } : null,
    held, time: read(level.actors[0], 'TimeSeconds'),
    fragments: (session.decalFragments() ?? []).map(g => {
      const points = [];
      for (let k = 0; k < g.positions.length; k += 3) points.push(fromView([g.positions[k], g.positions[k + 1], g.positions[k + 2]]));
      return { texture: g.texture, points };
    }),
  };
}
