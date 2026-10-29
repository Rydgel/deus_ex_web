/** A HUD texture reference as plain data: the page decodes it from its own asset store (sim-session.mjs plainTexture, which
 * re-exports this).
 *
 * One object per reference, kept while the reference lives: the HUD names a handful of textures in a few hundred commands a
 * frame, and a fresh object for each was an allocation per command. The references are never changed once made (a dynamic
 * texture whose size changes is a new reference), and a cached object is compared with its reference's size to be sure. */
const plains = new WeakMap();

export function plainTexture(ref) {
  const cached = plains.get(ref);
  if (cached !== undefined && (!ref.dynamic || (cached.width === ref.width && cached.height === ref.height))) return cached;
  const plain = ref.dynamic ? {key: ref.key, dynamic: true, width: ref.width, height: ref.height}
    : {key: ref.key, package: ref.asset.name, index: ref.index};
  plains.set(ref, plain);
  return plain;
}
