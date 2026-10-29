/** A pawn's third-person weapon on the simulation side of Play's actor mesh layer
 * (docs/weapon-attachment.md). Render.dll draws the weapon inside the pawn's
 * DrawActorSprite, in every frame that draws the pawn: the weapon actor with its
 * ThirdPersonMesh, ThirdPersonScale and the pawn's Style, posed with the hand's
 * Coords that DrawLodMesh made from the pawn mesh's special vertices in that
 * frame (weapon-attachment.mjs), lit with the pawn as light sink and the frame's
 * Mirror set to 1.0. Here each such weapon is one actor-mesh binding of its own
 * (createMeshBinding's `attach`), updated right after its pawn's with a view whose
 * frames are the pawn's, whose Coords are the hand's and whose frame set is the
 * pawn's where the hand exists.
 *
 * Order of the SetupForActor calls (docs/weapon-attachment.md "Order of SetupForActor calls"):
 * in each frame the pawn's DrawMesh (0x10b25624) and then the weapon's (0x10b257da) call it, and the
 * two share the pawn's light-manager cache, so the pawn's lighting in frame k+1 starts from the cache
 * the weapon's frame k left. `interleave(view)` hands the pawns' bindings a hook (`view.afterLight`) that
 * places the weapon in each frame and takes its SetupForActor result right after the pawn's own lighting
 * of that frame; `update` then draws the weapon with the results (`takePrepared`). Without the hook
 * (`interleave` false, ?weaponOrder=late) the weapon's frames follow all of its pawn's.
 *
 * Not a Frame->Sprite member: DrawActorSprite stamps the pawn, never the weapon,
 * so a weapon binding is in none of the id sets the stamps read and answers
 * `drawnIn` false. */
import {fieldAccessors} from './actor-fields.mjs';
import {handCoords, weaponCoords, selectedCoords, specialOutcode} from '../runtime/weapon-attachment.mjs';

const lower = value => String(value).toLowerCase();

/** The child frames' LOD inputs for a weapon's own view: those the weapon was placed in, with the hand's coordinates there. A function of
 * its own: the closures here, in the loop body of `update`, made every pawn's iteration allocate a context object
 * (scripts/closure-context-scan.mjs). */
function weaponLodFrames(lodFrames, entry, ids) {
  return lodFrames.filter(entryFrame => entry.coords.has(entryFrame.index))
    .map(entryFrame => ({ index: entryFrame.index, ids, frame: { ...entryFrame.frame, coords: entry.coords.get(entryFrame.index) } }));
}

export function createWeaponAttachments({runtime, bind, lighting, onCreate, onRelease, nextIndex, errors, enabled = true, mirrors = true, interleave = true, layout = null}) {
  const entries = new Map(), owners = new Map(), pawnClass = new WeakMap(), live = new Set(), noIds = new Set();
  let disposed = false, epoch = 0;
  // Host timing (scripts/weapon-cost.mjs): the wall time of the weapon layer's calls (update, and the hook the
  // pawns' lighting makes) and the weapon records update made.
  const stats = { ms: 0, updates: 0, records: 0 };
  /** Whether the actor's class derives from Pawn (Render.dll's test at 0x10b25675..0x10b25694). */
  const isPawn = actor => {
    let known = pawnClass.get(actor);
    if (known === undefined) {
      known = false;
      try { for (let cls = runtime.instance(actor).cls; cls; cls = cls.base) if (lower(cls.record.name) === 'pawn') { known = true; break; } }
      catch { known = false; }
      pawnClass.set(actor, known);
    }
    return known;
  };
  const entryFor = binding => {
    let entry = entries.get(binding);
    if (!entry) {
      entry = { binding, pawn: binding.actor, fields: fieldAccessors(runtime, binding.actor, ['Weapon', 'SelectedItem', 'Style']), weapon: null, item: false, wf: null,
        mesh: null, weaponBinding: null, pending: null, failedMesh: null, coords: new Map(), flip: new Map(), shown: false, mirrored: new WeakMap(),
        // The frames of the update in progress and the objects they reuse, in two buffers: the update builds into the one the
        // last drawn update did not use (`cur`), which `last` (validation) keeps for as long as the weapon is not drawn again.
        // The hook's per-frame results (`steps`, valid for the `epoch` they carry).
        bufs: [{ frames: [], ok: [], pool: [] }, { frames: [], ok: [], pool: [] }], cur: 0, wview: null, ids: null, lightFrames: [],
        steps: new Map(), stepFrame: { index: null, ctx: null, prj: null, specials: null },
        lastRecord: null, lastView: null, lastLocation: null };
      entries.set(binding, entry);
    }
    return entry;
  };
  const clear = entry => { if (entry.coords.size) entry.coords.clear(); if (entry.flip.size) entry.flip.clear(); };
  const retire = entry => {
    const binding = entry.weaponBinding;
    if (binding) { binding.dispose(); owners.delete(binding); onRelease(binding.id); }
    entry.weaponBinding = null; entry.shown = false; entry.ids = null; clear(entry); entry.steps.clear();
  };
  const hide = (entry, records) => {
    if (entry.weaponBinding && entry.shown) records.push(entry.weaponBinding.hide());
    entry.shown = false; clear(entry);
  };
  /** The lighting frame DrawMesh gets for the weapon: the same frame with its Mirror forced to 1.0
   * (0x10b2571a, restored at 0x10b25a68). The main viewport's frame has Mirror 1 already. */
  const mirrorOne = (entry, ctx) => {
    if (!ctx) return null;
    let one = entry.mirrored.get(ctx);
    if (!one) entry.mirrored.set(ctx, one = Object.assign(Object.create(ctx), { mirror: 1 }));
    return one;
  };
  const identity = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

  /** DrawLodMesh 0x10b0f1b4..0x10b0f44f for one frame: the hand's coordinates from the pawn mesh's special
   * vertices in that frame's camera space (the frame's PrjXM..PrjYP give the outcodes), or null. */
  function hand(binding, specials, prj) {
    if (!specials?.length) return null;
    const face = binding.payload.arrays.get(0x174);
    if (!face || face.num < 1) return null;
    const words = new DataView(face.data.buffer, face.data.byteOffset, face.data.byteLength);
    const indices = [words.getUint16(0, true), words.getUint16(2, true), words.getUint16(4, true)];
    if (indices.some(i => i >= specials.length)) return null;
    const codes = specials.map(vertex => prj ? specialOutcode(vertex, prj) : 0);
    // `[ebp-0x40]` starts at 0x3c and is ANDed with every special vertex's outcode (0x10b0f1c3).
    if (codes.reduce((all, code) => all & code, 0x3c)) return null;
    return handCoords(indices.map(i => specials[i]), indices.map(i => codes[i]));
  }

  /** The weapon's Coords in one frame (`frame`: {index, ctx, prj}): the hand from the pawn's special vertices as that
   * frame's GetFrame call made them, with the frame's own projection planes (a mirror's child frame has its window's).
   * Sets `frame.specials`; null when the frame has no hand. */
  function place(entry, binding, frame, view, location, item) {
    frame.specials = binding.specialCamera(frame.ctx, frame.index);
    const placed = hand(binding, frame.specials, frame.prj ?? view.prj ?? null);
    if (!placed) return null;
    return item ? selectedCoords(placed, location) : weaponCoords(placed, location);
  }

  const setupOf = entry => ({ sink: entry.pawn, style: entry.fields.Style() });
  /** The SetupForActor result the hook took for frame `frameIndex` of this update, once (createMeshBinding's relight). */
  function takePrepared(entry, frameIndex) {
    const step = entry.steps.get(frameIndex);
    if (!step || step.epoch !== epoch || !step.prepared) return null;
    const prepared = step.prepared;
    step.prepared = null;
    return prepared;
  }

  function create(entry) {
    const { pawn, weapon, mesh } = entry;
    const attach = {
      mesh: () => mesh,
      // DrawActorSprite 0x10b256b1..0x10b25706: the pawn's Style, ThirdPersonMesh as Mesh, ThirdPersonScale as
      // DrawScale, Rotation zero (0x10b25702).
      overrides: { Mesh: () => mesh, DrawScale: () => entry.wf.ThirdPersonScale(), Style: () => entry.fields.Style(), Rotation: () => [0, 0, 0],
        bHidden: () => false },
      coords: frameIndex => entry.coords.get(frameIndex) ?? entry.coords.get(null) ?? identity,
      lightFrame: ctx => mirrorOne(entry, ctx),
      setup: () => setupOf(entry),
      takePrepared: frameIndex => takePrepared(entry, frameIndex),
    };
    entry.pending = bind(weapon, { attach, layout, visible: () => true, childVisible: () => true, reads: false, originalObjectIndex: nextIndex() })
      .then(binding => {
        if (disposed || entries.get(entry.binding) !== entry || entry.weapon !== weapon || entry.mesh !== mesh) {
          // A GPU slot the simulation side's layout gave this binding exists on the page's only once the page has seen it created: let it
          // see the release too, or the two layouts' slots part ways.
          if (!disposed && binding.creation.path === 'gpu') { onCreate(binding.creation); binding.dispose(); onRelease(binding.id); }
          else binding.dispose();
          return;
        }
        entry.weaponBinding = binding; owners.set(binding, entry); binding.attachedTo = entry.binding;
        entry.ids = new Set([binding.id]);
        binding.creation.visible = false;
        onCreate(binding.creation);
      })
      .catch(error => { entry.failedMesh = mesh; errors.push({ actor: `${pawn.name ?? '?'} weapon`, message: error.message }); })
      .finally(() => { entry.pending = null; });
  }

  /** The state DrawActorSprite writes into the weapon whenever it draws it (0x10b25702, 0x10b25819..0x10b25a6e), not
   * restored: Rotation zero; bSteadyToggle flipped for a steady flash, once per frame that drew it; bFirstFrame
   * cleared; OldFlashCount = FlashCount. The muzzle flash itself (MuzzleFlashMesh) is set by no class of the
   * game's data and is not drawn. */
  function writeState(entry, drawnFrames) {
    const weapon = entry.weapon, read = name => runtime.readNamed(weapon, name), write = (name, value) => { if (read(name) !== value) runtime.writeNamed(weapon, name, value); };
    const rotation = read('Rotation');
    if (rotation.some(value => value !== 0)) runtime.writeNamed(weapon, 'Rotation', [0, 0, 0]);
    // A SelectedItem's block (0x10b25cdc..0x10b261a3) writes the Rotation alone: no flash state.
    if (entry.item) return;
    if (read('bSteadyFlash3rd') && drawnFrames % 2) runtime.writeNamed(weapon, 'bSteadyToggle', !read('bSteadyToggle'));
    write('bFirstFrame', false);
    write('OldFlashCount', read('FlashCount'));
  }

  /** Validation access (states): what the last drawn update did, and the Coords DrawMesh would have got (word for word
   * the original's). */
  function lastOf(entry) {
    const { lastRecord: record, lastView: view } = entry;
    if (!record) return null;
    const ok = entry.bufs[entry.cur].ok, main = ok.find(frame => frame.index === null);
    return { visible: record.visible, childOnly: record.childOnly, points: Boolean(record.cameraPoints), colors: Boolean(record.colors), lighting: Boolean(record.lighting),
      frames: ok.map(frame => frame.index), coords: main ? Array.from(main.coords) : null,
      specials: main?.specials ?? null, prj: view.prj ?? null, location: Array.from(entry.lastLocation),
      // the mirror frames' hands (validation): each frame's projection planes, special vertices and Coords
      children: ok.filter(frame => frame.index !== null).map(frame => ({ index: frame.index, prj: frame.prj ? Array.from(frame.prj) : null,
        specials: frame.specials, coords: Array.from(frame.coords) })) };
  }

  /** Validation: the corner colours (float32 words) the last drawn update gave each frame. */
  function colorsOf(entry) {
    const words = array => array ? Array.from(new Uint32Array(array.buffer, array.byteOffset, array.length)) : null;
    if (!entry.weaponBinding || !entry.lastRecord) return null;
    const state = entry.weaponBinding.gpuState(), children = {};
    for (const [index, light] of state.frameLights) children[index] = words(light.colors);
    return { main: words(entry.lastRecord.colors), children };
  }

  /** The hook the pawn's lighting calls right after it lit its binding in a frame (createMeshBinding's lightIn): the
   * weapon's part of that frame, in the original's order. Places the weapon (the hand from the pawn's special vertices
   * in this frame) and takes its SetupForActor result, which the cache the pawn just left gives it. */
  function step(binding, frameIndex, ctx, lf, view) {
    const entry = entries.get(binding);
    if (!entry || !entry.weaponBinding || disposed || !enabled || (frameIndex !== null && !mirrors)) return;
    const started = performance.now();
    try {
      if (!(lighting && view.lit && lighting.frame)) return;
      const held = entry.fields.Weapon(), weapon = held ?? entry.fields.SelectedItem();
      // The weapon the update will draw: anything else (a new weapon, a new mesh) is the update's to start.
      if (!weapon || weapon !== entry.weapon || entry.wf.ThirdPersonMesh() !== entry.mesh) return;
      const frame = entry.stepFrame;
      frame.index = frameIndex; frame.ctx = ctx; frame.prj = lf ? lf.prj ?? null : view.prj ?? null; frame.specials = null;
      const coords = place(entry, binding, frame, view, entry.wf.Location(), !held);
      let record = entry.steps.get(frameIndex);
      if (!record) entry.steps.set(frameIndex, record = { epoch: -1, specials: null, coords: null, prepared: null });
      // DrawMesh is called for the weapon only where DrawLodMesh left a hand.
      record.epoch = epoch; record.specials = frame.specials; record.coords = coords;
      record.prepared = coords ? lighting.setupMesh(weapon, null, mirrorOne(entry, ctx), setupOf(entry)) : null;
    } finally { stats.ms += performance.now() - started; }
  }

  /** One frame of the update: the object reused for it. */
  const frameOf = (buf, index, ctx, lf, prj) => {
    const frame = buf.pool[buf.frames.length] ??= {};
    frame.index = index; frame.ctx = ctx; frame.lf = lf; frame.prj = prj; frame.specials = null; frame.coords = null;
    return frame;
  };

  const api = {
    /** The view the pawns' bindings update with: `view` and, with the weapons' SetupForActor calls in the original's
     * order, the hook that makes them (`afterLight`). Each pawn update starts a new round of the hook's results. */
    interleave(view) {
      if (disposed || !enabled || !interleave) return view;
      epoch++;
      return { ...view, afterLight: (binding, frameIndex, ctx, lf) => step(binding, frameIndex, ctx, lf, view) };
    },
    /** The weapons of `bindings` (the pawns updated this frame, with `view` as they were), appended to `records`.
     * `hideOthers`: the pawns no frame drew hide their weapon too (the main frame's update; a ViewportWindow's pass
     * leaves the others to its decisions). */
    update(bindings, view, records, hideOthers = true) {
      if (disposed || !enabled) return;
      const lit = Boolean(lighting && view.lit && lighting.frame);
      live.clear();
      for (const binding of bindings) {
        if (!isPawn(binding.actor)) continue;
        const entry = entryFor(binding);
        live.add(entry);
        const draw = binding.lastDraw();
        // DrawActorSprite draws the pawn's Weapon, and only when it has none its SelectedItem (a held tool: 0x10b25cdc), each with its ThirdPersonMesh.
        const shown = lit && (draw.main || draw.childOnly);
        const held = shown ? entry.fields.Weapon() : null, selected = shown && !held ? entry.fields.SelectedItem() : null, weapon = held ?? selected;
        entry.why = !lit ? 'no lighting' : !shown ? 'pawn not drawn' : !weapon ? 'no Weapon' : null;
        if (!weapon) { hide(entry, records); continue; }
        if (entry.weapon !== weapon) {
          retire(entry);
          entry.weapon = weapon; entry.mesh = null; entry.failedMesh = null;
          entry.wf = fieldAccessors(runtime, weapon, ['ThirdPersonMesh', 'ThirdPersonScale', 'Location']);
        }
        entry.item = !held;
        const mesh = entry.wf.ThirdPersonMesh();
        if (!mesh) { entry.why = 'no ThirdPersonMesh'; hide(entry, records); continue; }
        if (entry.mesh !== mesh) { retire(entry); entry.mesh = mesh; entry.failedMesh = null; }
        // Shown once its resources decode, as a new actor slot is.
        if (!entry.weaponBinding) { entry.why = entry.failedMesh === mesh ? 'creation failed' : 'creating'; if (!entry.pending && entry.failedMesh !== mesh) create(entry); continue; }
        // The frames that drew the pawn, in DrawFrame's order: the child frames first, the main frame last.
        const buf = entry.bufs[entry.cur ^ 1], frames = buf.frames, ok = buf.ok;
        frames.length = 0; ok.length = 0;
        // Child frames (a mirror's) draw it too in the original, with the frame's Mirror forced to 1.0 and each frame's own projection
        // planes for the special vertices' outcodes (docs/weapon-attachment.md "Mirrors"); `mirrors` false (?weaponMirrors=0) leaves them out.
        if (mirrors && view.lightFrames) for (const lf of view.lightFrames) if (lf.ids.has(binding.id)) frames.push(frameOf(buf, lf.index, lf.ctx, lf, lf.prj ?? null));
        if (draw.main) frames.push(frameOf(buf, null, view.lightRoot ?? null, null, view.prj ?? null));
        const location = entry.wf.Location();
        for (const frame of frames) {
          // A frame the pawn's lighting already stepped (the hook) has its hand; the others are placed now.
          const stepped = entry.steps.get(frame.index);
          if (stepped && stepped.epoch === epoch) { frame.specials = stepped.specials; frame.coords = stepped.coords; }
          else frame.coords = place(entry, binding, frame, view, location, entry.item);
          if (frame.coords) ok.push(frame);
        }
        entry.why = ok.length ? null : `no hand in ${frames.length} frames`;
        if (!ok.length) { hide(entry, records); continue; }
        clear(entry);
        let childFrames = 0;
        for (const frame of ok) {
          entry.coords.set(frame.index, frame.coords);
          entry.flip.set(frame.index, Boolean(frame.ctx && frame.ctx.mirror < 0));
          if (frame.index !== null) childFrames++;
        }
        writeState(entry, ok.length);
        const ids = entry.ids, wview = entry.wview ??= { lit: false, camera: null, prj: null, lightRoot: null, main: noIds, children: noIds, lightFrames: entry.lightFrames,
          lodFrame: undefined, lodFrames: undefined };
        wview.lit = view.lit; wview.camera = view.camera; wview.prj = view.prj; wview.lightRoot = view.lightRoot;
        wview.main = entry.coords.has(null) ? ids : noIds; wview.children = childFrames ? ids : noIds;
        const lightFrames = wview.lightFrames;
        lightFrames.length = 0;
        for (const frame of ok) if (frame.lf) {
          const item = frame.lfView ??= { index: 0, kind: null, ids: null, ctx: null };
          item.index = frame.index; item.kind = frame.lf.kind; item.ids = ids; item.ctx = frame.ctx;
          lightFrames.push(item);
        }
        wview.lodFrame = view.lodFrame ? { ...view.lodFrame, coords: entry.coords.get(null) ?? ok.at(-1).coords } : undefined;
        wview.lodFrames = view.lodFrames ? weaponLodFrames(view.lodFrames, entry, ids) : undefined;
        const record = entry.weaponBinding.update(wview);
        entry.cur ^= 1; entry.lastRecord = record; entry.lastView = view; entry.lastLocation = location;
        records.push(record);
        entry.shown = true;
      }
      if (hideOthers) for (const entry of entries.values()) if (!live.has(entry)) hide(entry, records);
    },
    /** A pawn binding retired. */
    drop(binding) {
      const entry = entries.get(binding);
      if (!entry) return;
      retire(entry); entries.delete(binding);
    },
    /** Validation access: each pawn's weapon state and why it is not drawn; with `colors`, the corner colours (float32 words) of the
     * frames the last drawn update lit on the CPU path (the main frame's and each child frame's). */
    states: (colors = false) => [...entries.values()].filter(entry => entry.weapon || entry.why).map(entry => ({ pawn: entry.pawn.name, weapon: entry.weapon?.name ?? null,
      item: entry.item, binding: entry.weaponBinding?.id ?? null, why: entry.why ?? null, last: lastOf(entry), frames: [...entry.coords.keys()],
      ...(colors ? { colors: colorsOf(entry) } : {}) })),
    /** The weapon bindings that exist. */
    bindings: () => [...owners.keys()],
    /** Whether frame `frameIndex` is a mirror's (Mirror -1): the weapon's faces are kept by the camera-space test with
     * Mirror 1.0 (0x10b2571a), which the page's flipped projection of that frame reverses (decision.flipSide). */
    mirrored(binding, frameIndex) {
      const entry = owners.get(binding);
      return Boolean(entry && frameIndex !== undefined && frameIndex !== null && entry.flip.get(frameIndex));
    },
    /** Whether the weapon binding was drawn in frame `frameIndex` (undefined or null: the main frame), by the frame
     * whose Frame->Sprite holds `ids`: its pawn is in it and had a hand there. */
    inFrame(binding, ids, frameIndex) {
      const entry = owners.get(binding);
      if (!entry) return false;
      return ids.has(entry.binding.id) && entry.coords.has(frameIndex ?? null);
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) retire(entry);
      entries.clear();
    },
    /** Host timing: what the weapon layer cost since the last reset (ms), the update calls and the weapon records they made. */
    stats(reset = false) {
      const result = { ...stats };
      if (reset) { stats.ms = 0; stats.updates = 0; stats.records = 0; }
      return result;
    },
  };
  const update = api.update;
  api.update = (bindings, view, records, hideOthers) => {
    if (disposed || !enabled) return;
    const started = performance.now(), before = records.length;
    try { update(bindings, view, records, hideOthers); }
    finally { stats.ms += performance.now() - started; stats.updates++; stats.records += records.length - before; }
  };
  return api;
}
