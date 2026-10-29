/** `{...metadata, ...overrides}` for a property's metadata: a copy with other values (the element metadata of an array property, one
 * dimension). A PropertyMetadata (unreal/script-metadata.mjs) keeps its derived keys on its prototype, which a spread does not take; the
 * copy has the same prototype, so it answers every key the original does. A plain metadata object (a fixture) copies as the spread did. */
export function cloneMetadata(metadata, overrides) {
  return Object.assign(Object.create(Object.getPrototypeOf(metadata)), metadata, overrides);
}
