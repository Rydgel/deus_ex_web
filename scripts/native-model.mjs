/** Preserve authored plane bits across JSON, including negative zero. The
 * original DLL harness reconstructs the floats from these unsigned words. */
export function nativeModel(model) {
  const view = new DataView(new ArrayBuffer(4));
  const bits = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
  return { bounds: model.bounds, rootOutside: model.rootOutside, leafHulls: model.leafHulls,
    nodes: model.nodes.map(node => ({ ...node, planeBits: node.plane.map(bits) })) };
}
