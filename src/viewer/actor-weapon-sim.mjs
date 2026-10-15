/** A pawn's third-person weapon on the simulation side of Play's actor mesh layer
 * (docs/weapon-attachment.md). Render.dll draws the weapon inside the pawn's
 * DrawActorSprite, in every frame that draws the pawn: the weapon actor with its
 * ThirdPersonMesh, ThirdPersonScale and the pawn's Style, posed with the hand's
 * Coords that DrawLodMesh made from the pawn mesh's special vertices in that
 * frame (weapon-attachment.mjs), lit with the pawn as light sink and the frame's
 * Mirror set to 1.0. Here each such weapon is one actor-mesh binding of its own
 * (createMeshBinding's `attach`, on the CPU path), updated right after its pawn's
 * with a view whose frames are the pawn's, whose Coords are the hand's and whose
 * frame set is the pawn's where the hand exists.
 *
 * Not a Frame->Sprite member: DrawActorSprite stamps the pawn, never the weapon,
 * so a weapon binding is in none of the id sets the stamps read and answers
 * `drawnIn` false. */
import {fieldAccessors} from './actor-fields.mjs';
import {handCoords, weaponCoords, selectedCoords, specialOutcode} from '../runtime/weapon-attachment.mjs';

const lower = value => String(value).toLowerCase();

export function createWeaponAttachments({runtime, bind, lighting, onCreate, onRelease, nextIndex, errors, enabled = true, mirrors = true}) {
  const entries = new Map(), owners = new Map(), pawnClass = new WeakMap();
  let disposed = false;
  // Host timing (scripts/weapon-cost.mjs): the wall time of update() calls and the weapon records they made.
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
        mesh: null, weaponBinding: null, pending: null, failedMesh: null, coords: new Map(), flip: new Map(), shown: false, mirrored: new WeakMap() };
      entries.set(binding, entry);
    }
    return entry;
  };
  const retire = entry => {
    const binding = entry.weaponBinding;
    if (binding) { binding.dispose(); owners.delete(binding); onRelease(binding.id); }
    entry.weaponBinding = null; entry.shown = false; entry.coords = new Map();
  };
  const hide = (entry, records) => {
    if (entry.weaponBinding && entry.shown) records.push(entry.weaponBinding.hide());
    entry.shown = false; entry.coords = new Map();
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
      setup: () => ({ sink: pawn, style: entry.fields.Style() }),
    };
    entry.pending = bind(weapon, { attach, layout: null, visible: () => true, childVisible: () => true, reads: false, originalObjectIndex: nextIndex() })
      .then(binding => {
        if (disposed || entries.get(entry.binding) !== entry || entry.weapon !== weapon || entry.mesh !== mesh) { binding.dispose(); return; }
        entry.weaponBinding = binding; owners.set(binding, entry); binding.attachedTo = entry.binding;
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

  const api = {
    /** The weapons of `bindings` (the pawns updated this frame, with `view` as they were), appended to `records`.
     * `hideOthers`: the pawns no frame drew hide their weapon too (the main frame's update; a ViewportWindow's pass
     * leaves the others to its decisions). */
    update(bindings, view, records, hideOthers = true) {
      if (disposed || !enabled) return;
      const lit = Boolean(lighting && view.lit && lighting.frame);
      const live = new Set();
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
        const frames = [];
        // Child frames (a mirror's) draw it too in the original, with the frame's Mirror forced to 1.0 and each frame's own projection
        // planes for the special vertices' outcodes (docs/weapon-attachment.md "Mirrors"); `mirrors` false (?weaponMirrors=0) leaves them out.
        if (mirrors) for (const lf of view.lightFrames ?? []) if (lf.ids.has(binding.id)) frames.push({ index: lf.index, ctx: lf.ctx, lf, prj: lf.prj ?? null });
        if (draw.main) frames.push({ index: null, ctx: view.lightRoot ?? null, lf: null, prj: view.prj ?? null });
        const location = entry.wf.Location(), ok = [];
        for (const frame of frames) {
          frame.specials = binding.specialCamera(frame.ctx, frame.index);
          // each frame's own projection planes: a mirror's child frame has its window's, not the main frame's
          const placed = hand(binding, frame.specials, frame.prj ?? view.prj ?? null);
          if (!placed) continue;
          frame.coords = entry.item ? selectedCoords(placed, location) : weaponCoords(placed, location);
          ok.push(frame);
        }
        entry.why = ok.length ? null : `no hand in ${frames.length} frames`;
        if (!ok.length) { hide(entry, records); continue; }
        entry.coords = new Map(ok.map(frame => [frame.index, frame.coords]));
        entry.flip = new Map(ok.map(frame => [frame.index, Boolean(frame.ctx && frame.ctx.mirror < 0)]));
        writeState(entry, ok.length);
        const ids = new Set([entry.weaponBinding.id]);
        const wview = { lit: view.lit, camera: view.camera, prj: view.prj, lightRoot: view.lightRoot,
          main: entry.coords.has(null) ? ids : new Set(), children: ok.some(frame => frame.index !== null) ? ids : new Set(),
          lightFrames: ok.filter(frame => frame.lf).map(frame => ({ index: frame.index, kind: frame.lf.kind, ids, ctx: frame.ctx })) };
        if (view.lodFrame) wview.lodFrame = { ...view.lodFrame, coords: entry.coords.get(null) ?? ok.at(-1).coords };
        if (view.lodFrames) wview.lodFrames = view.lodFrames.filter(entryFrame => entry.coords.has(entryFrame.index))
          .map(entryFrame => ({ index: entryFrame.index, ids, frame: { ...entryFrame.frame, coords: entry.coords.get(entryFrame.index) } }));
        const record = entry.weaponBinding.update(wview);
        // Validation access (states): what the frame drew, and the Coords DrawMesh would have got (word for word the original's).
        entry.last = { visible: record.visible, childOnly: record.childOnly, points: Boolean(record.cameraPoints), colors: Boolean(record.colors),
          frames: ok.map(frame => frame.index), coords: entry.coords.get(null) ? Array.from(entry.coords.get(null)) : null,
          specials: ok.find(frame => frame.index === null)?.specials ?? null, prj: view.prj ?? null, location: Array.from(location),
          // the mirror frames' hands (validation): each frame's projection planes, special vertices and Coords
          children: ok.filter(frame => frame.index !== null).map(frame => ({ index: frame.index, prj: frame.prj ? Array.from(frame.prj) : null,
            specials: frame.specials, coords: Array.from(frame.coords) })) };
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
    /** Validation access: each pawn's weapon state and why it is not drawn. */
    states: () => [...entries.values()].filter(entry => entry.weapon || entry.why).map(entry => ({ pawn: entry.pawn.name, weapon: entry.weapon?.name ?? null,
      item: entry.item, binding: entry.weaponBinding?.id ?? null, why: entry.why ?? null, last: entry.last ?? null, frames: [...entry.coords.keys()] })),
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
    /** Host timing: what update() cost since the last reset (ms), the calls and the weapon records they made. */
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
