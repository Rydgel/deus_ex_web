import { modelFromObjects } from '../src/unreal/bsp-model.mjs';
/** Preserve authored plane bits across JSON, including negative zero. The
 * original DLL harness reconstructs the floats from these unsigned words. */
export function nativeModel(model) {
  const view = new DataView(new ArrayBuffer(4));
  const bits = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
  return { bounds: model.bounds, rootOutside: model.rootOutside, leafHulls: Array.from(model.leafHulls),
    nodes: model.nodes.map(node => ({ ...node, planeBits: node.plane.map(bits) })) };
}

/** The models of a scene read back from its JSON (`nativeModel`'s objects): each plane rebuilt from its authored bits, then made the typed
 * tables the simulation reads (src/unreal/bsp-model.mjs). `scene.model` and the models of `actors` (default `scene.actors`) are replaced. */
export function typedSceneModels(scene, actors = scene.actors) {
  const view = new DataView(new ArrayBuffer(4));
  const typed = model => {
    for (const node of model.nodes) if (node.planeBits) node.plane = node.planeBits.map(word => { view.setUint32(0, word, true); return view.getFloat32(0, true); });
    return modelFromObjects(model);
  };
  if (scene.model) scene.model = typed(scene.model);
  for (const actor of actors) if (actor.model) actor.model = typed(actor.model);
}
