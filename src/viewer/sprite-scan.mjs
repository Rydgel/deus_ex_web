/** The simulation side of Play's sprites (docs/particles.md "Sprites",
 * docs/sim-worker.md): URender::SetupDynamics' actor scan in array order
 * (docs/render-visibility.md admission), with RenderIterator actors expanded
 * through the iterator protocol, which runs script (Init), moves the proxies
 * (FarMoveActor) and draws from the shared random stream. Each DT_Sprite item
 * becomes a plain record for the page's sprite scene (sprite-scene.mjs),
 * read where DrawActorSprite (0x10b25080) would read it: the actor's
 * handle, Texture, Style, Location, DrawScale and ScaleGlow.
 *
 * A LaserIterator's items are DT_Mesh LaserProxy snapshots (docs/lasers.md);
 * scan() returns them, in order, for the actor mesh scene to draw.
 *
 * Every record and mesh item carries `order`, its place in SetupDynamics'
 * sequence: the actor's Level.Actors index times 65536 plus the item's
 * number within its iterator, so the dynamics (docs/bsp-occlusion.md
 * "Play") can merge them with the actor mesh layer's bindings; scan() also
 * returns the iterating actors, which draw only through their items.
 *
 * OccludeFrame runs SetupDynamics again for every child frame (0x10b1a188
 * calls it before each child's OccludeBsp), and each run builds every
 * iterator's items again: Init(Viewport->Actor) (the same actor in every
 * frame, which neither script's Init reads), First, then CurrentItem until
 * IsDone (0x10b22fee..0x10b2307c). `rescan` is that run over the iterating
 * actors the root frame's scan found: the iterators' state is reset by Init
 * and the shared random stream is drawn from again, so a laser's items can
 * differ from one frame to the next.
 *
 * Not translated yet, noted: DT_SpriteAnimOnce's frame choice, iterator
 * classes other than ParticleIterator and LaserIterator, the bHighDetail
 * rule and fog. */
import { ensureRenderInterface, particleIteratorItems } from '../runtime/script-particles.mjs';
import { laserIteratorItems } from '../runtime/script-laser.mjs';
import { handleOf } from '../runtime/script-object-handles.mjs';
import { RENDER_ITERATOR, RENDER_SHIFT, RENDER_SPRITE } from '../runtime/script-vm-render.mjs';

/** `pin`: validation only (visual-acceptance.mjs --rng-pin), called at the start of every SetupDynamics run (scan, rescan): the shared stream is set
 * to the state the original's frame was pinned to (docs/visual-acceptance.md "Effect frames"). */
export function createSpriteScan(runtime, { player, constructIterator, frand, pin = null }) {
  const notes = new Set();
  const read = (actor, name) => runtime.readNamed(actor, name);
  const newOut = () => ({ sprites: [], meshItems: [], iterators: new Set(), iteratorIndex: new Map() });
  /** SetupDynamics' visit of one actor for a frame (`out`, newOut's): the
   * sprite records, the iterator items that draw as meshes, the iterating
   * actors and where each stands in Level.Actors. A record made from an
   * iterator's item carries `viaIterator`. */
  function makeVisit(out, firstPerson) {
    const { sprites, meshItems, iterators, iteratorIndex } = out;
    const viewer = player();
    let order = 0, viaIterator = false;
    const record = (actor, { location, drawScale, scaleGlow }) => {
      const reference = read(actor, 'Texture');
      if (!reference) return;
      sprites.push({ handle: handleOf(actor), order,
        texture: { key: reference.key ?? null, package: reference.asset?.name, index: reference.index },
        style: read(actor, 'Style') & 255, location: [...location], drawScale, scaleGlow, ...(viaIterator ? { viaIterator: true } : {}) });
    };
    return (actor, index) => {
      if (!actor || actor === viewer) return;
      order = index * 65536;
      let hidden;
      try { hidden = read(actor, 'bHidden'); } catch { return; }
      if (hidden) return;
      if (firstPerson && read(viewer, 'ViewTarget') === actor) return;
      if (read(actor, 'bOnlyOwnerSee')) {
        let owned = false;
        for (let owner = actor; owner; owner = read(owner, 'Owner')) if (owner === viewer) { owned = true; break; }
        if (!owned || !firstPerson) return;
      }
      if (read(actor, 'bOwnerNoSee') && firstPerson && read(actor, 'Owner') === viewer) return;
      if (read(actor, 'RenderIteratorClass')) {
        const iterator = ensureRenderInterface(runtime, actor, constructIterator);
        if (!iterator) return;
        iterators.add(actor); iteratorIndex.set(actor, index);
        const kind = runtime.instance(iterator).cls.record.key;
        if (kind === 'deusex.laseriterator') {
          viaIterator = true;
          try {
            for (const item of laserIteratorItems(runtime, iterator, actor, viewer, {
              processEvent: (receiver, name, args) => runtime.processNativeEvent(receiver, name, args), frand })) {
              const drawType = read(item.actor, 'DrawType') & 255;
              if (drawType === 2) meshItems.push({ ...item, order });
              else if (drawType === 1 || drawType === 7) record(item.actor, item);
              order++;
            }
          } finally { viaIterator = false; }
          return;
        }
        if (kind !== 'deusex.particleiterator') {
          notes.add(`RenderIterator ${kind} is not translated.`);
          return;
        }
        viaIterator = true;
        try {
          for (const item of particleIteratorItems(runtime, iterator, viewer, {
            processEvent: (receiver, name, args) => runtime.processNativeEvent(receiver, name, args),
            farMoveActor: (target, destination) => runtime.farMoveActor(target, destination, 0, 0) })) {
            if ([1, 7].includes(read(item.actor, 'DrawType') & 255)) record(item.actor, item);
            order++;
          }
        } finally { viaIterator = false; }
        return;
      }
      const drawType = read(actor, 'DrawType') & 255;
      if (drawType !== 1 && drawType !== 7) return;
      if (drawType === 7) notes.add('DT_SpriteAnimOnce sprites draw their first frame; the LifeSpan frame choice is not translated.');
      record(actor, { location: read(actor, 'Location').map(Math.fround), drawScale: Math.fround(read(actor, 'DrawScale')),
        scaleGlow: Math.fround(read(actor, 'ScaleGlow')) });
    };
  }
  /** One frame: the level actor array in order, after the tick. Returns the
   * sprite records and the iterator items that draw as meshes, with the
   * iterating actors (and their Level.Actors indices). */
  function scan({ firstPerson = true } = {}) {
    pin?.();
    const out = newOut(), viewer = player(), level = runtime.levelFor(viewer);
    const visit = makeVisit(out, firstPerson);
    // The render scan (script-vm-render.mjs) leaves the actors visit()
    // would draw or iterate, plus those it hands back, and stops after an
    // iterator: an iterator may run script, so the scan resumes after it with
    // the viewer's ViewTarget read again. Without it, every actor in order.
    const actors = level.actors, render = runtime.scriptVm?.render ?? null;
    for (let start = 0; ;) {
      const entries = render?.scan(actors, { start, kinds: RENDER_SPRITE | RENDER_ITERATOR, viewer,
        viewTarget: firstPerson ? read(viewer, 'ViewTarget') : null, firstPerson }) ?? null;
      if (!entries) { for (let i = start; i < actors.length; i++) visit(actors[i], i); break; }
      for (const entry of entries) visit(actors[entry >>> RENDER_SHIFT], entry >>> RENDER_SHIFT);
      const last = entries[entries.length - 1];
      if (!entries.length || !(last & RENDER_ITERATOR)) break;
      start = (last >>> RENDER_SHIFT) + 1;
    }
    return out;
  }
  /** A child frame's SetupDynamics: the iterating actors of `scan` (its
   * `iteratorIndex`) in Level.Actors order, their protocol run again.
   * Returns the frame's items (sprite records and mesh items, as `scan`
   * does for the iterating actors alone). */
  function rescan(iteratorIndex, { firstPerson = true } = {}) {
    pin?.();
    const out = newOut(), visit = makeVisit(out, firstPerson);
    for (const [actor, index] of iteratorIndex) visit(actor, index);
    return out;
  }
  return { scan, rescan, notes };
}
