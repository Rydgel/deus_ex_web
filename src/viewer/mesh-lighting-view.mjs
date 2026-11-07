import { getAxes } from '../runtime/camera.mjs';
import { traceRay, traceRayClear, traceRayFast } from '../runtime/ray.mjs';
import { actorsEpoch } from '../runtime/base-epoch.mjs';
import { movingLightInView, lazyLeafLists, viewPlanesOf, worldLightRadius } from '../runtime/dynamic-lighting.mjs';
import { coronaFrame } from '../runtime/coronas.mjs';
import { PF, accumulateFaceNormal, actorPolyFlags, createMeshLightManager, d3dDiffuse, faceKept, finishSetup, lightVertex,
  lightsActor, setupAmbient, setupForActor, unlitColor, vertexNormalPlane } from '../runtime/mesh-lighting.mjs';
import { handleOf, identityOfHandle } from '../runtime/script-object-handles.mjs';
import { meshLightMode } from '../runtime/script-vm-meshlight.mjs';
import { lightGlobals } from '../runtime/light-globals.mjs';
import { renderScanMode } from '../runtime/script-vm-render.mjs';
import { ActorNames } from '../runtime/actor-names.mjs';
import { switchReader } from '../runtime/switch-reader.mjs';
import { actorTailMode } from './actor-tail.mjs';

const actorNamesMode = switchReader('ACTOR_NAMES', 'DEUS_EX_ACTOR_NAMES', 'kept');
const PROBE_DIFFERENTIAL = typeof process !== 'undefined' && process.env?.LINE_PROBE_DIFFERENTIAL === '1';

const f = Math.fround;
// The slot of a light field no one has read yet.
const UNREAD = Symbol('unread');
const LIGHT_FIELDS = ['LightType', 'LightEffect', 'LightBrightness', 'LightHue', 'LightSaturation', 'LightRadius',
  'LightPeriod', 'LightPhase', 'bStatic', 'bNoDelete', 'bDynamicLight', 'bMovable', 'bSpecialLit', 'bDeleteMe', 'VolumeRadius'];
// The slot of each field in a LightValues (s0 ... s14, in LIGHT_FIELDS' order).
const SLOTS = LIGHT_FIELDS.map((name, index) => `s${index}`);

/** Play's per-frame mesh lighting (docs/mesh-lighting.md): one light manager
 * for the viewport, live light fields read from the shared script runtime,
 * moving lights filtered into BSP leaves (URender::LeafLights), and one
 * SetupForActor call per drawn actor per frame. `levelSource()` returns the
 * current Play level; `exportName(ref)` names a map export, since UModel.Lights
 * holds map export references. */
export function createMeshLightingView(runtime, levelSource, { exportName, exportIndex = () => undefined, kernel = null,
  lineModel = () => null }) {
  const read = (object, name) => { try { return runtime.readNamed(object, name); } catch { return undefined; } };
  // Strobe's state and the light noise are the light manager's, shared
  // with the light maps and Galaxy (light-globals.mjs).
  const globals = lightGlobals(runtime), manager = createMeshLightManager({ strobe: globals.strobe });
  // SetupForActor's Model.LineCheck (End the light, Start the actor, zero
  // extent, no extra node flags; 0x10b09583-0x10b0961f): with the brush
  // tracker, `lineModel()` gives Level->Model with the movers' fragment
  // nodes as the tracker last left them (bsp-occlusion.mjs lineModel), as
  // the original's level model holds them; otherwise the static model.
  // While the tracker lives and its collision model is the level's world model (level-queries.mjs worldModel), the kernel traces
  // it: the tracker's nodes are one block of memory that lineModel() and the collision model both read, and the kernel's import
  // follows its generation (corona-scan.mjs, level-queries.mjs lineProbe). lineModel() builds its view where the JavaScript needs it.
  const clear = (from, to) => {
    const collision = frame.model.trackedCollision?.() ?? null;
    if (collision !== null) {
      const result = traceRayClear(collision, from, to);
      if (result !== undefined) {
        if (PROBE_DIFFERENTIAL && result !== (traceRayFast(lineModel(), from, to) === null))
          throw new Error(`mesh lighting trace differential mismatch: ${JSON.stringify({ from, to, result })}`);
        return result;
      }
    }
    const tracked = lineModel();
    return (tracked ? traceRayFast(tracked, from, to) : traceRay(frame.model, from, to)) === null;
  };
  let frame = null, frameCount = 0, lastTime = null, meshLightContext = null;
  // Level.Actors' name map (the last entry of each name) and membership set change only when actorsEpoch advances (base-epoch.mjs). Most
  // advances append a spawn or null a destroyed actor's slot: the maps are kept across them and rebuilt only for a change they do not
  // follow (actor-names.mjs; ACTOR_NAMES / ?actorNames=js rebuilds at every advance, as before, =verify compares).
  const membership = new ActorNames({ last: true, live: true, reference: 'append' });
  const levelMembership = level => { membership.at(level.actors, actorsEpoch(), actorNamesMode()); return membership; };
  // A light's fields are read at most once per frame, when first used: no
  // script runs during the render phase, so a later read in the same frame
  // returns the same value (the record is rebuilt every frame, so a live edit
  // is still seen next frame). Candidates the radius test rejects need only
  // the fields that test reads. The values sit in fixed slots of the record,
  // not in a Map made for each: a setup keeps the lights it chose after the
  // frame (actor-mesh-sim.mjs lastSetup), so a record outlives its frame
  // by as long as its actor stays out of view, and the Map and its tables
  // were most of what it kept (docs/live-heap.md "Cut: promoted garbage").
  class LightValues {
    constructor(actor) {
      this.actor = actor;
      this.s0 = this.s1 = this.s2 = this.s3 = this.s4 = this.s5 = this.s6 = this.s7 = this.s8 = this.s9 = this.s10 = this.s11 = this.s12 = this.s13 = this.s14 = UNREAD;
    }
  }
  LIGHT_FIELDS.forEach((name, index) => {
    const slot = SLOTS[index];
    Object.defineProperty(LightValues.prototype, name, { get() {
      const value = this[slot];
      return value === UNREAD ? this[slot] = read(this.actor, name) : value;
    } });
  });
  // A light record of the frame: its actor, the fields read so far, its location (float32) and its re-trace phase.
  // Flicker's key (light-globals.mjs flickerKeyOf) is looked up when read.
  class LightRecord {
    constructor(actor, values, location, index) { this.actor = actor; this.values = values; this.location = location; this.index = index; }
    get flickerKey() { return globals.flickerKeyOf(this.actor); }
  }
  // SetupForActor staggers visibility re-traces by (light.Index ^
  // FrameCount) & 15. Play uses the measured GObjObjects index or a
  // spawn's modeled slot; a pre-placed light without a capture falls back
  // to its map export index (the global index is a Stage 6 boundary).
  const lightIndex = actor => {
    let index = runtime.soundField?.(actor, 'ObjectIndex');
    if (!Number.isInteger(index)) {
      index = exportIndex(actor.name);
      manager.diagnostics.add('Mesh-light re-trace phases use map export indices where the original GObjObjects index is unmeasured.');
    }
    return Number.isInteger(index) ? index : 0;
  };
  const lightRecord = (actor, scanned = null) => {
    let record = frame.lights.get(actor);
    if (record) return record;
    const values = new LightValues(actor);
    // A light from game.movingLights() brings the fields it already read in
    // this frame (the same reads, with no script run in between).
    if (scanned) {
      const known = scanned.values;
      for (let i = 0; i < LIGHT_FIELDS.length; i++) if (Object.hasOwn(known, LIGHT_FIELDS[i])) values[SLOTS[i]] = known[LIGHT_FIELDS[i]];
    }
    record = new LightRecord(actor, values, (scanned ? scanned.location : read(actor, 'Location') ?? [0, 0, 0]).map(f), lightIndex(actor));
    frame.lights.set(actor, record);
    return record;
  };
  // The leaf's permeating static lights as handles, per frame (lightOf's
  // exports by name; MESH_LIGHT_MISSING where no live actor has the name).
  // A leaf's run depends on the model's leaves and light table (fixed for the level), the export names, and the actor each name
  // finds in Level.Actors (`frame.byName`, which changes only when actorsEpoch advances, the same bound levelMembership uses):
  // the runs are kept across frames while the model, the name map and the epoch are the ones they were made for (ACTOR_TAIL=js
  // makes them again in each frame, as before; `verify` makes them again at every use and compares).
  const kept = { model: null, byName: null, epoch: -1, runs: new Map() };
  const makeRun = iLeaf => {
    const leaves = frame.model.leaves, lights = frame.model.lights, refs = [], handles = [];
    const permeating = iLeaf >= 0 && iLeaf < leaves.length ? leaves.permeating(iLeaf) : -1;
    if (permeating >= 0)
      for (let i = permeating; i < lights.length && lights[i]; i++) {
        const name = exportName(lights[i]), light = name && frame.byName.get(name);
        refs.push(lights[i]); handles.push(light ? handleOf(light) : 0xffffffff);
      }
    return { refs, handles };
  };
  const permeatingRun = iLeaf => {
    let run = frame.runs.get(iLeaf);
    if (run) return run;
    const mode = actorTailMode();
    if (mode === 'js') run = makeRun(iLeaf);
    else {
      const epoch = actorsEpoch();
      if (kept.model !== frame.model || kept.byName !== frame.byName || kept.epoch !== epoch) {
        kept.model = frame.model; kept.byName = frame.byName; kept.epoch = epoch; kept.runs = new Map();
      }
      run = kept.runs.get(iLeaf);
      if (run === undefined) kept.runs.set(iLeaf, run = makeRun(iLeaf));
      else if (mode === 'verify') {
        const want = makeRun(iLeaf);
        if (want.refs.length !== run.refs.length || want.refs.some((ref, i) => ref !== run.refs[i]) || want.handles.some((handle, i) => handle !== run.handles[i]))
          throw new Error(`ACTOR_TAIL=verify: the kept permeating run of leaf ${iLeaf} differs from a fresh one`);
      }
    }
    frame.runs.set(iLeaf, run);
    return run;
  };
  // A leaf's moving-light list as handles: the list is the frame's (leafListsFor memoizes it), so its handles are made once, not for each
  // actor drawn in the leaf; the selection only reads them.
  const NO_HANDLES = [], leafHandleLists = new WeakMap();
  const leafHandlesOf = list => {
    if (list.length === 0) return NO_HANDLES;
    let handles = leafHandleLists.get(list);
    if (handles === undefined) leafHandleLists.set(list, handles = list.map(record => handleOf(record.actor)));
    return handles;
  };
  /** setupMesh's reads of `actor`, with its defaults. */
  const setupFields = actor => {
    const region = read(actor, 'Region') ?? {};
    return { zone: region['engine.actor.pointregion.zone'] ?? null, zoneNumber: region['engine.actor.pointregion.zonenumber'] ?? 0,
      iLeaf: region['engine.actor.pointregion.ileaf'] ?? -1, Style: read(actor, 'Style'), bNoSmooth: read(actor, 'bNoSmooth'),
      bMeshEnviroMap: read(actor, 'bMeshEnviroMap'), bMeshCurvy: read(actor, 'bMeshCurvy'), bUnlit: read(actor, 'bUnlit'),
      location: read(actor, 'Location') ?? [0, 0, 0], AmbientGlow: read(actor, 'AmbientGlow') ?? 0,
      ScaleGlow: read(actor, 'ScaleGlow') ?? 1, bSpecialLit: read(actor, 'bSpecialLit') };
  };
  /** setupForActor with the light choice in meshlight.rs; the same result. */
  const rustSetup = (rust, sink, scene) => {
    const result = setupAmbient(sink, scene);
    if (!lightsActor(sink, scene)) return result;
    const elapsed = (scene.viewport.currentTime - scene.viewport.lastUpdateTime) * 768;
    const step = Math.min(255, Math.max(0, Math.trunc(elapsed)));
    const run = permeatingRun(sink.iLeaf), leafHandles = leafHandlesOf(scene.leafLights);
    const choice = rust.select(meshLightContext, handleOf(sink.self), sink.location, sink.bSpecialLit, step, scene.viewport.frameCount,
      run.handles, leafHandles);
    if (choice.missing !== undefined) scene.lightOf(run.refs[choice.missing]);
    result.traced = choice.traced.map(handle => lightRecord(identityOfHandle(handle)));
    return finishSetup(manager, sink, scene, result,
      choice.added.map(([handle, fade]) => ({ light: lightRecord(identityOfHandle(handle)), fade })));
  };
  const u32 = value => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, value, true); return b.getUint32(0, true); };
  const describe = setup => JSON.stringify({ ambient: setup.ambient.map(u32), scaleGlow: u32(setup.scaleGlow), flags: setup.flags,
    traced: setup.traced.map(light => light.actor?.name), lights: setup.lights.map(info => [info.light.actor?.name,
      ...info.location.map(u32), u32(info.radius), u32(info.rradius), ...info.color.map(u32)]) });
  const verifySetup = (actor, js, rust) => {
    const a = describe(js), b = describe(rust);
    if (a !== b) throw new Error(`MESH_LIGHT=verify: ${actor.name} JavaScript ${a}, Rust ${b}`);
  };
  // SetupDynamics' ViewPlanes test over the gate's survivors and OccludeBsp's
  // Filter walk (dynamic-lighting.mjs): the frame's LeafLights, leaf -> records.
  const leafListsFor = (records, planeWords) => {
    const planes = planeWords ? viewPlanesOf(planeWords) : null;
    const candidates = planes ? records.filter(record => movingLightInView(record.location, record.values, planes)) : records;
    // Each leaf's list is built when a drawn actor asks for it (lazyLeafLists).
    const lists = lazyLeafLists(frame.model, candidates.map(record => ({ location: record.location,
      radius: worldLightRadius(record.values) })));
    const records_ = new Map();
    const get = leaf => {
      let list = records_.get(leaf);
      if (list === undefined && !records_.has(leaf)) {
        const order = lists.get(leaf);
        records_.set(leaf, list = order && order.map(k => candidates[k]));
      }
      return list;
    };
    const all = () => new Map([...lists].map(([leaf]) => [leaf, get(leaf)]));
    return { get, has: leaf => get(leaf) !== undefined, keys: () => lists.keys(), entries: () => all().entries(), get size() { return lists.size; },
      [Symbol.iterator]: () => all()[Symbol.iterator]() };
  };
  // Run `fn` with `ctx` (a child frame, childFrame) as the lighting frame.
  const withFrame = (ctx, fn) => {
    const saved = frame;
    frame = ctx;
    try { return fn(); } finally { frame = saved; }
  };
  const view = {
    manager,kernel,
    /** Validation only: {name, records} of the actor whose setups are kept. */
    watch: null,
    /** Validation only: an array that keeps every setupMesh call's actor, sink, frame and result (null: off). */
    setupLog: null,
    get frame() { return frame; },
    /** Validation access: this frame's light record of `actor`, made as
     * the JavaScript selection's lightOf makes it. The Rust selection fills
     * its slots from the image and makes records only for the lights it
     * returns. */
    lightRecordOf(actor) { return frame && actor ? lightRecord(actor) : undefined; },
    /** URender's per-frame setup for the main viewport: Frame->Coords, the
     * viewport clock and SetupDynamics' moving-light leaf lists. `lights`,
     * Play's game.movingLights() of this frame, stands for the candidate
     * scan: the same gate over the same level, in Level.Actors order.
     * `master` {words, planes} is the frame OccludeBsp reads (sim-session
     * visibility().master): its Coords and, for SetupDynamics' ViewPlanes
     * sphere test, its four planes; without it Coords come from the view
     * and no candidate is rejected by the planes. */
    beginFrame({ location, rotation, seconds, lights = null, master = null }) {
      const level = levelSource();
      if (!level?.model) { frame = null; return; }
      // Frame->Coords: camera X = right, Y = down, Z = forward, origin at the
      // view location (GMath.ViewCoords / ViewRotation / ViewLocation).
      let axes, origin;
      if (master) {
        const { coords } = coronaFrame(master.words);
        axes = [coords.x, coords.y, coords.z]; origin = coords.origin;
      } else {
        const [forward, right, up] = getAxes(rotation.map(value => value | 0));
        axes = [right.map(f), up.map(value => f(-value)), forward.map(f)];
        origin = location.map(f);
      }
      frameCount++;
      if (view.setupLog) view.setupLog.push({ frame: frameCount });
      const viewport = { currentTime: seconds, lastUpdateTime: lastTime ?? seconds, frameCount };
      lastTime = seconds;
      // Level->Actors(0) is the LevelInfo (SetupForActor asserts it).
      const { byName, live } = levelMembership(level), levelInfo = level.actors[0];
      // `prj`: the master frame's PrjXM..PrjYP (+0xec..+0xf8) as floats, the planes DrawMesh's outcodes read (umesh-draw.mjs).
      const prj = master?.prj ? Array.from(new Float32Array(Uint32Array.from(master.prj).buffer)) : null;
      frame = { level, model: level.model, axes, origin, mirror: 1, prj, viewport, lights: new Map(), leafLights: new Map(),
        levelInfo, byName, timeSeconds: read(levelInfo, 'TimeSeconds') ?? 0,
        levelBrightness: f(read(levelInfo, 'Brightness') ?? 1), ambients: new Map(), live,
        meshLight: runtime.scriptVm?.meshLight ?? null, runs: new Map() };
      // The Rust selection's light slots come from this frame's records.
      if (frame.meshLight) meshLightContext ??= frame.meshLight.context();
      frame.meshLight?.beginFrame(meshLightContext, { live,
        index: handle => lightIndex(identityOfHandle(handle)),
        alive: handle => { const light = identityOfHandle(handle); return Boolean(light) && !read(light, 'bDeleteMe') && live.has(light); },
        light: handle => lightRecord(identityOfHandle(handle)),
        trace: (from, to) => clear(from, to),
      });
      // SetupDynamics (0x10b22d90) takes the candidates in level-actor order
      // (the gate 0x10b230e8..0x10b2311c, then the frame's ViewPlanes test),
      // and OccludeBsp's Filter leaves each on the leaves it reaches
      // (dynamic-lighting.mjs movingLightLeafLists; the order and the
      // candidate test are verified against the original in
      // validate-leaf-lights.mjs, docs/coronas.md "Leaf lights").
      const records = [];
      if (lights) for (const light of lights) records.push(lightRecord(light.actor, light));
      else for (const actor of level.actors) {
        if (!actor || !read(actor, 'LightType') || read(actor, 'bDeleteMe')) continue;
        // Static-light records are created lazily by lightOf/current if
        // SetupForActor actually needs them.
        if ((read(actor, 'bStatic') || read(actor, 'bNoDelete')) && !read(actor, 'bDynamicLight')) continue;
        if (!read(actor, 'LightBrightness') || !read(actor, 'LightRadius')) continue;
        records.push(lightRecord(actor));
      }
      // SetupDynamics' gate's survivors, before any frame's ViewPlanes: each
      // child frame filters them again (childFrame).
      frame.candidates = records;
      frame.leafLights = leafListsFor(records, master?.planes ?? null);
    },
    /** The lighting frame of a child frame (mirror or sky) OccludeFrame made:
     * its own Frame->Coords and Frame->Mirror, and its own SetupDynamics'
     * ViewPlanes and Filter walk, so its sprites' LeafLights are the lists
     * that frame left (Render.dll OccludeFrame 0x10b19fc0: SetupDynamics at
     * 0x10b1a18e, OccludeBsp 0x10b1a19a, then each sprite's LeafLights =
     * LeafLights[its leaf] at 0x10b1a1ff-0x10b1a202 before the lists are
     * cleared for the next frame at 0x10b1a213-0x10b1a265). `coords` are the
     * frame's 12 words as floats (Origin, X, Y, Z), `mirror` its Mirror
     * (+0x20) and `planes` its four ViewPlanes' 16 words (+0x12c).
     * Everything else (the light records, the clock, the zones'
     * ambients) is the main frame's. Returns a frame setupMesh and
     * lightMesh take. */
    childFrame({ coords, mirror, planes = null }) {
      if (!frame) return null;
      const axes = [coords.slice(3, 6), coords.slice(6, 9), coords.slice(9, 12)];
      return Object.assign(Object.create(frame), { origin: coords.slice(0, 3), axes, mirror,
        leafLights: leafListsFor(frame.candidates, planes) });
    },
    /** ComputeFromActor's camera-space location (TransformPointBy of the
     * frame coords, 0x10b06035-0x10b06095) at the render pass's 24 bits:
     * `(d.x·A.x + d.y·A.y) + d.z·A.z` with d = P − Origin. */
    toCamera(point) {
      const { origin, axes } = frame;
      const dx = f(f(point[0]) - origin[0]), dy = f(f(point[1]) - origin[1]), dz = f(f(point[2]) - origin[2]);
      return axes.map(axis => f(f(f(dx * axis[0]) + f(dy * axis[1])) + f(dz * axis[2])));
    },
    /** SetupForActor for one DrawLodMesh pass of `actor`: the selected
     * lights, ambient and ScaleGlow, the actor poly flags and the unlit
     * colour. Mutates the light manager's caches exactly once per call. */
    setupMesh(actor, fields = null, ctx = null, options = null) {
      if (ctx) return withFrame(ctx, () => view.setupMesh(actor, fields, null, options));
      if (!frame) return null;
      // `fields`: the same reads from the mesh scene's Rust pass
      // (npc-mesh-preview.mjs MB), compared under RENDER_SCAN=verify.
      if (fields && renderScanMode() === 'verify') {
        const want = setupFields(actor), same = (a, b) => Array.isArray(a) ? a.every((v, i) => Object.is(v, b[i])) : Object.is(a, b);
        for (const key of Object.keys(want)) if (!same(want[key], fields[key]))
          throw new Error(`RENDER_SCAN=verify: ${actor.name} ${key} is ${fields[key]} in mesh_reads, ${want[key]} by readNamed`);
      }
      // A pawn's third-person weapon (docs/weapon-attachment.md): DrawMesh's Actor is the weapon, with the
      // pawn's Style copied in, and its LightSink the pawn. The poly flags and the unlit colour are the
      // weapon's; SetupForActor takes the light sink's location, leaf, zone, glow and flags, and its
      // per-actor cache is the sink's (`options.sink`, `options.style`).
      const v = fields ?? (options?.style === undefined ? setupFields(actor) : { ...setupFields(actor), Style: options.style });
      const s = options?.sink ? setupFields(options.sink) : v;
      const zoneActor = s.zone, zoneNumber = v.zoneNumber;
      const values = { Style: v.Style, bNoSmooth: v.bNoSmooth, bSelected: false,
        bMeshEnviroMap: v.bMeshEnviroMap, bMeshCurvy: v.bMeshCurvy,
        bUnlit: v.bUnlit, ZoneNumber: zoneNumber };
      const polyFlags = actorPolyFlags(values) | PF.Flat;
      // Zone and LevelInfo ambient fields do not change within a frame.
      const ambientOf = zone => {
        let ambient = frame.ambients.get(zone);
        if (!ambient) frame.ambients.set(zone, ambient = [read(zone, 'AmbientBrightness') ?? 0, read(zone, 'AmbientHue') ?? 0,
          read(zone, 'AmbientSaturation') ?? 0]);
        return ambient;
      };
      const location = s.location.map(f);
      const iLeaf = s.iLeaf;
      const lightSink = options?.sink ?? actor;
      const sink = {
        self: lightSink, index: lightSink, location, iLeaf,
        zone: zoneActor ? { ambient: ambientOf(zoneActor) } : null,
        AmbientGlow: s.AmbientGlow, ScaleGlow: s.ScaleGlow,
        bUnlit: Boolean(options?.sink ? s.bUnlit : values.bUnlit), bSpecialLit: Boolean(s.bSpecialLit),
      }, scene = {
        levelInfo: { ambient: ambientOf(frame.levelInfo), brightness: frame.levelBrightness, timeSeconds: frame.timeSeconds },
        noise: globals.noise,
        model: frame.model,
        lightOf: ref => {
          const name = exportName(ref), light = name && frame.byName.get(name);
          if (!light) throw new Error(`Mesh lighting: leaf light ${ref} has no live actor`);
          return lightRecord(light);
        },
        leafLights: frame.leafLights.get(iLeaf) ?? [],
        current: record => lightRecord(record.actor),
        lineCheck: light => clear(location, light.location),
        viewport: frame.viewport, rendMap: 5, noLighting: false,
        alive: light => !read(light.actor, 'bDeleteMe') && frame.live.has(light.actor),
        worldToCamera: point => view.toCamera(point),
      };
      // SetupForActor's light choice runs in the Rust core when the script VM
      // has it (meshlight.rs); MESH_LIGHT=verify runs both and compares.
      const mode = meshLightMode(), rust = mode !== 'js' ? frame.meshLight : null;
      const strobeBefore = view.watch?.name === actor.name ? [globals.strobe.time, globals.strobe.flag] : null;
      let setup;
      if (rust) {
        setup = rustSetup(rust, sink, scene);
        if (mode === 'verify') verifySetup(actor, setupForActor(manager, sink, scene), setup);
      } else setup = setupForActor(manager, sink, scene);
      const flags = polyFlags | setup.flags;
      // Validation only (scripts/validate-weapon-order.mjs): every call's actor, light sink, frame and result, in call order.
      if (view.setupLog) view.setupLog.push({ actor: actor.name, sink: lightSink.name, mirror: frame.mirror, origin: frame.origin.map(u32), setup: describe(setup) });
      // Validation only (decal-probe.mjs meshLightProbe): one watched
      // actor's light infos with the inputs their type functions read.
      if (strobeBefore) view.watch.records.push({ timeSeconds: frame.timeSeconds, strobeBefore, origin: [...frame.origin], mirror: frame.mirror,
        strobe: [globals.strobe.time, globals.strobe.flag], noiseA: globals.noise ? Array.from(globals.noise.A) : null,
        levelBrightness: frame.levelBrightness, lights: setup.lights.map(info => ({ name: info.light.actor?.name,
          flickerKey: info.light.flickerKey ?? 0, brightness: info.brightness, fade: info.tagFade, color: [...info.color],
          values: Object.fromEntries(['LightType', 'LightBrightness', 'LightHue', 'LightSaturation', 'LightPeriod', 'LightPhase',
            'LightRadius', 'LightEffect'].map(name => [name, info.light.values[name]])) })) });
      return { setup, flags, polyFlags, unlit: unlitColor(v.AmbientGlow, f(v.ScaleGlow)) };
    },
    /** One DrawLodMesh lighting pass. `points` are GetFrame's vertices:
     * world-space (the default, transformed here by the frame's Coords) or,
     * with `cameraSpace`, the output of GetFrame called with the frame's own
     * Coords (and morphed in that space), which the original lights as they
     * are. `faces` are the mesh faces in draw order: the packed words (four a
     * face, [v0, v1, v2, flags]: MeshFaces.words, which Play passes), or
     * {vertices, flags} objects (the reference form; the Wasm path then takes
     * `faceWords`). Returns per-face corner diffuse colours in [0,1], three
     * corners per face in face-vertex order, as D3D's FISTP bytes. `prepared`
     * is a setupMesh result already taken for this draw (SetupForActor runs
     * once). */
    lightMesh(actor, points, faces, faceWords = null, prepared = null, ctx = null, cameraSpace = false) {
      if (ctx) return withFrame(ctx, () => view.lightMesh(actor, points, faces, faceWords, prepared, null, cameraSpace));
      prepared ??= view.setupMesh(actor);
      if (!prepared) return null;
      const { setup, flags } = prepared;
      const isWords = faces instanceof Uint32Array, faceCount = isWords ? faces.length / 4 : faces.length;
      if(view.kernel&&ArrayBuffer.isView(points)){
        if(isWords)faceWords = faces;
        if(!(faceWords instanceof Uint32Array)||faceWords.length!==faceCount*4)
          throw new TypeError('Wasm mesh lighting requires packed face topology');
        const colors=view.kernel.light({points,faces:faceWords,origin:frame.origin,axes:frame.axes,mirror:frame.mirror,
          ambient:setup.ambient,scaleGlow:setup.scaleGlow,unlit:prepared.unlit,lights:setup.lights,flags,cameraSpace});
        return {colors,setup,flags,vertices:null};
      }
      if(ArrayBuffer.isView(points))points=Array.from({length:points.length/3},(_,i)=>Array.from(points.subarray(i*3,i*3+3)));
      const faceOf = isWords ? i => ({ vertices: [faces[i * 4], faces[i * 4 + 1], faces[i * 4 + 2]], flags: faces[i * 4 + 3] }) : i => faces[i];
      // DrawLodMesh: camera-space vertices, summed face normals over every
      // face, then per-vertex light for vertices of faces that are drawn.
      const camera = cameraSpace ? points.map(point => [...point]) : points.map(point => view.toCamera(point));
      const normals = camera.map(() => [0, 0, 0]);
      const drawn = new Uint8Array(faceCount), lit = new Uint8Array(camera.length);
      for (let i = 0; i < faceCount; i++) {
        const face = faceOf(i);
        const [a, b, c] = face.vertices;
        const unit = accumulateFaceNormal(camera[a], camera[b], camera[c], normals[a], normals[b], normals[c]);
        const p = camera[a];
        // PF_Invisible (0x1) faces still add to the normals but are not drawn;
        // the dot is times the frame's Mirror (0x10b0ffbb).
        if (faceKept(unit, p, frame.mirror, face.flags)) { drawn[i] = 1; lit[a] = lit[b] = lit[c] = 1; }
      }
      const planes = camera.map((point, i) => lit[i] ? vertexNormalPlane(point, normals[i]) : null);
      const light = camera.map((point, i) => lit[i] ? lightVertex(setup, point, planes[i], flags) : null);
      const vertexLight = light.slice();
      // The face helper (0x10b0bab0) overwrites PF_Unlit faces' vertex light
      // with the unlit colour in draw order; later faces see the new value.
      const unlit = prepared.unlit;
      const colors = new Float32Array(faceCount * 9);
      for (let i = 0; i < faceCount; i++) {
        const face = faceOf(i);
        const faceFlags = face.flags | flags;
        if (drawn[i] && faceFlags & PF.Unlit) for (const v of face.vertices) light[v] = unlit;
        face.vertices.forEach((v, corner) => {
          const at = i * 9 + corner * 3;
          if (faceFlags & PF.Modulated || !light[v]) { colors[at] = colors[at + 1] = colors[at + 2] = 1; return; }
          const packed = d3dDiffuse(light[v]);
          colors[at] = ((packed >>> 16) & 255) / 255; colors[at + 1] = ((packed >>> 8) & 255) / 255;
          colors[at + 2] = (packed & 255) / 255;
        });
      }
      // `vertices` keeps Light's inputs and outputs for the composition check
      // (scripts/validate-mesh-lighting-play.mjs).
      return { colors, setup, flags, vertices: { camera, planes, light: vertexLight } };
    },
  };
  return view;
}
