import { getAxes } from '../runtime/camera.mjs';
import { traceRay } from '../runtime/ray.mjs';
import { movingLightLeaves, worldLightRadius } from '../runtime/dynamic-lighting.mjs';
import { PF, accumulateFaceNormal, actorPolyFlags, createMeshLightManager, d3dDiffuse, lightVertex, setupForActor,
  unlitColor, vertexNormalPlane } from '../runtime/mesh-lighting.mjs';

const f = Math.fround;
const LIGHT_FIELDS = ['LightType', 'LightEffect', 'LightBrightness', 'LightHue', 'LightSaturation', 'LightRadius',
  'LightPeriod', 'LightPhase', 'bStatic', 'bNoDelete', 'bDynamicLight', 'bMovable', 'bSpecialLit', 'bDeleteMe'];

/** Play's per-frame mesh lighting (docs/mesh-lighting.md): one light manager
 * for the viewport, live light fields read from the shared script runtime,
 * moving lights filtered into BSP leaves (URender::LeafLights), and one
 * SetupForActor call per drawn actor per frame. `levelSource()` returns the
 * current Play level; `exportName(ref)` names a map export, since UModel.Lights
 * holds map export references. */
export function createMeshLightingView(runtime, levelSource, { exportName, exportIndex = () => undefined, kernel = null }) {
  const read = (object, name) => { try { return runtime.readNamed(object, name); } catch { return undefined; } };
  const manager = createMeshLightManager();
  let frame = null, frameCount = 0, lastTime = null;
  const lightRecord = actor => {
    let record = frame.lights.get(actor);
    if (record) return record;
    const values = Object.fromEntries(LIGHT_FIELDS.map(name => [name, read(actor, name)]));
    // SetupForActor staggers visibility re-traces by (light.Index ^
    // FrameCount) & 15. Play uses the measured GObjObjects index or a
    // spawn's modeled slot; a pre-placed light without a capture falls back
    // to its map export index (the global index is a Stage 6 boundary).
    let index = runtime.soundField?.(actor, 'ObjectIndex');
    if (!Number.isInteger(index)) {
      index = exportIndex(actor.name);
      manager.diagnostics.add('Mesh-light re-trace phases use map export indices where the original GObjObjects index is unmeasured.');
    }
    record = { actor, values, location: (read(actor, 'Location') ?? [0, 0, 0]).map(f),
      index: Number.isInteger(index) ? index : 0 };
    frame.lights.set(actor, record);
    return record;
  };
  const view = {
    manager,kernel,
    get frame() { return frame; },
    /** URender's per-frame setup for the main viewport: Frame->Coords, the
     * viewport clock and SetupDynamics' moving-light leaf lists. */
    beginFrame({ location, rotation, seconds }) {
      const level = levelSource();
      if (!level?.model) { frame = null; return; }
      const [forward, right, up] = getAxes(rotation.map(value => value | 0));
      // Frame->Coords: camera X = right, Y = down, Z = forward, origin at the
      // view location (GMath.ViewCoords / ViewRotation / ViewLocation).
      const axes = [right.map(f), up.map(value => f(-value)), forward.map(f)];
      const origin = location.map(f);
      frameCount++;
      const viewport = { currentTime: seconds, lastUpdateTime: lastTime ?? seconds, frameCount };
      lastTime = seconds;
      // Level->Actors(0) is the LevelInfo (SetupForActor asserts it).
      const byName = new Map(), levelInfo = level.actors[0];
      frame = { level, model: level.model, axes, origin, viewport, lights: new Map(), leafLights: new Map(),
        levelInfo, byName, timeSeconds: read(levelInfo, 'TimeSeconds') ?? 0,
        levelBrightness: f(read(levelInfo, 'Brightness') ?? 1) };
      for (const actor of level.actors) if (actor) byName.set(actor.name, actor);
      // SetupDynamics (0x10b22d90) prepends candidates in level-actor order;
      // Filter prepends each onto the leaves it reaches.
      for (const actor of level.actors) {
        if (!actor || !read(actor, 'LightType') || read(actor, 'bDeleteMe')) continue;
        // SetupDynamics 0x10b230e8..0x10b2311c rejects these before
        // constructing a dynamic light. Static-light records are created
        // lazily by lightOf/current if SetupForActor actually needs them.
        if ((read(actor, 'bStatic') || read(actor, 'bNoDelete')) && !read(actor, 'bDynamicLight')) continue;
        if (!read(actor, 'LightBrightness') || !read(actor, 'LightRadius')) continue;
        const record = lightRecord(actor);
        for (const leaf of movingLightLeaves(frame.model, record.location, worldLightRadius(record.values))) {
          const list = frame.leafLights.get(leaf) ?? [];
          list.unshift(record);
          frame.leafLights.set(leaf, list);
        }
      }
    },
    toCamera(point) {
      const { origin, axes } = frame;
      const dx = point[0] - origin[0], dy = point[1] - origin[1], dz = point[2] - origin[2];
      return axes.map(axis => f(dx * axis[0] + dy * axis[1] + dz * axis[2]));
    },
    /** SetupForActor for one DrawLodMesh pass of `actor`: the selected
     * lights, ambient and ScaleGlow, the actor poly flags and the unlit
     * colour. Mutates the light manager's caches exactly once per call. */
    setupMesh(actor) {
      if (!frame) return null;
      const zoneActor = (() => {
        const region = read(actor, 'Region');
        return region?.['engine.actor.pointregion.zone'] ?? null;
      })();
      const region = read(actor, 'Region') ?? {};
      const zoneNumber = region['engine.actor.pointregion.zonenumber'] ?? 0;
      const values = { Style: read(actor, 'Style'), bNoSmooth: read(actor, 'bNoSmooth'), bSelected: false,
        bMeshEnviroMap: read(actor, 'bMeshEnviroMap'), bMeshCurvy: read(actor, 'bMeshCurvy'),
        bUnlit: read(actor, 'bUnlit'), ZoneNumber: zoneNumber };
      const polyFlags = actorPolyFlags(values) | PF.Flat;
      const ambientOf = zone => [read(zone, 'AmbientBrightness') ?? 0, read(zone, 'AmbientHue') ?? 0,
        read(zone, 'AmbientSaturation') ?? 0];
      const location = (read(actor, 'Location') ?? [0, 0, 0]).map(f);
      const iLeaf = region['engine.actor.pointregion.ileaf'] ?? -1;
      const setup = setupForActor(manager, {
        self: actor, index: actor, location, iLeaf,
        zone: zoneActor ? { ambient: ambientOf(zoneActor) } : null,
        AmbientGlow: read(actor, 'AmbientGlow') ?? 0, ScaleGlow: read(actor, 'ScaleGlow') ?? 1,
        bUnlit: Boolean(values.bUnlit), bSpecialLit: Boolean(read(actor, 'bSpecialLit')),
      }, {
        levelInfo: { ambient: ambientOf(frame.levelInfo), brightness: frame.levelBrightness, timeSeconds: frame.timeSeconds },
        model: frame.model,
        lightOf: ref => {
          const name = exportName(ref), light = name && frame.byName.get(name);
          if (!light) throw new Error(`Mesh lighting: leaf light ${ref} has no live actor`);
          return lightRecord(light);
        },
        leafLights: frame.leafLights.get(iLeaf) ?? [],
        current: record => lightRecord(record.actor),
        lineCheck: light => traceRay(frame.model, location, light.location) === null,
        viewport: frame.viewport, rendMap: 5, noLighting: false,
        alive: light => !read(light.actor, 'bDeleteMe') && frame.level.actors.includes(light.actor),
        worldToCamera: point => view.toCamera(point),
      });
      const flags = polyFlags | setup.flags;
      return { setup, flags, unlit: unlitColor(read(actor, 'AmbientGlow') ?? 0, f(read(actor, 'ScaleGlow') ?? 1)) };
    },
    /** One DrawLodMesh lighting pass. `points` are GetFrame's world-space
     * vertices, `faces` the mesh faces in draw order ({vertices, flags}).
     * Returns per-face corner diffuse colours in [0,1], three corners per face
     * in face-vertex order, as D3D's FISTP bytes. `prepared` is a setupMesh
     * result already taken for this draw (SetupForActor runs once). */
    lightMesh(actor, points, faces, faceWords = null, prepared = view.setupMesh(actor)) {
      if (!prepared) return null;
      const { setup, flags } = prepared;
      if(view.kernel&&ArrayBuffer.isView(points)){
        if(!(faceWords instanceof Uint32Array)||faceWords.length!==faces.length*4)
          throw new TypeError('Wasm mesh lighting requires packed face topology');
        const colors=view.kernel.light({points,faces:faceWords,origin:frame.origin,axes:frame.axes,
          ambient:setup.ambient,scaleGlow:setup.scaleGlow,unlit:prepared.unlit,lights:setup.lights,flags});
        return {colors,setup,flags,vertices:null};
      }
      if(ArrayBuffer.isView(points))points=Array.from({length:points.length/3},(_,i)=>Array.from(points.subarray(i*3,i*3+3)));
      // DrawLodMesh: camera-space vertices, summed face normals over every
      // face, then per-vertex light for vertices of faces that are drawn.
      const camera = points.map(point => view.toCamera(point));
      const normals = camera.map(() => [0, 0, 0]);
      const drawn = new Uint8Array(faces.length), lit = new Uint8Array(camera.length);
      faces.forEach((face, i) => {
        const [a, b, c] = face.vertices;
        const unit = accumulateFaceNormal(camera[a], camera[b], camera[c], normals[a], normals[b], normals[c]);
        const p = camera[a];
        // PF_Invisible (0x1) faces still add to the normals but are not drawn.
        if (!(face.flags & 1) && (face.flags & PF.TwoSided || unit[0] * p[0] + unit[1] * p[1] + unit[2] * p[2] < 0)) {
          drawn[i] = 1; lit[a] = lit[b] = lit[c] = 1;
        }
      });
      const planes = camera.map((point, i) => lit[i] ? vertexNormalPlane(point, normals[i]) : null);
      const light = camera.map((point, i) => lit[i] ? lightVertex(setup, point, planes[i], flags) : null);
      const vertexLight = light.slice();
      // The face helper (0x10b0bab0) overwrites PF_Unlit faces' vertex light
      // with the unlit colour in draw order; later faces see the new value.
      const unlit = prepared.unlit;
      const colors = new Float32Array(faces.length * 9);
      faces.forEach((face, i) => {
        const faceFlags = face.flags | flags;
        if (drawn[i] && faceFlags & PF.Unlit) for (const v of face.vertices) light[v] = unlit;
        face.vertices.forEach((v, corner) => {
          const at = i * 9 + corner * 3;
          if (faceFlags & PF.Modulated || !light[v]) { colors[at] = colors[at + 1] = colors[at + 2] = 1; return; }
          const packed = d3dDiffuse(light[v]);
          colors[at] = ((packed >>> 16) & 255) / 255; colors[at + 1] = ((packed >>> 8) & 255) / 255;
          colors[at + 2] = (packed & 255) / 255;
        });
      });
      // `vertices` keeps Light's inputs and outputs for the composition check
      // (scripts/validate-mesh-lighting-play.mjs).
      return { colors, setup, flags, vertices: { camera, planes, light: vertexLight } };
    },
  };
  return view;
}
