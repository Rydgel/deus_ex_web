/** Live ConversationList binding services for the recovered ConBindEvents path.
 *
 * ScriptedPawn.PostPostBeginPlay runs native ConBindEvents (2102). The wrapper
 * (script-conversation-wrapper.mjs) resolves the mission ConversationList
 * through StaticLoadObject and calls the native BindConversations body
 * (script-native-conversation-list.mjs), which allocates ConListItem objects in
 * the ConversationList's Outer — the DeusExConText package — through the shared
 * StaticAllocateObject path.
 *
 * This module binds the Play host's real services to that contract:
 * `load` adapts the wrapper request onto the recovered prepared-linker
 * StaticLoadObject path; `nativeOuter` returns the registered Core.Package
 * record for the ConversationList's serialized Outer; `construction` and
 * `release` reuse the world spawn world's registry/name services plus the
 * recovered UObject final-destructor gates.
 * Evidence: docs/script-native-conversation-list.md,
 * docs/script-object-release.md, scripts/validate-conversation-binding.mjs. */
export async function prepareConversationBinding(runtime, level) {
  if (typeof runtime?.prepareConversations !== 'function' ||
      typeof runtime?.loadPreparedDynamicObject !== 'function')
    throw new TypeError('Conversation binding requires the linked ScriptRuntime');
  const construction = runtime.actorLifecycle?.construction;
  if (!construction?.registry || typeof construction.findObject !== 'function' ||
      typeof construction.internName !== 'function')
    throw new Error('Conversation binding requires the live world construction services');

  // Same actor-array walk as the recovered ConBindEvents body: the first
  // actor whose Class/Super chain reaches DeusExLevelInfo's static class.
  const isLevelInfo = actor => {
    for (let cls = runtime.instance(actor).cls; cls; cls = cls.base)
      if (cls.record.key === 'deusex.deusexlevelinfo') return true;
    return false;
  };
  const levelInfo = (level?.actors ?? []).find(actor => actor && isLevelInfo(actor)) ?? null;
  if (levelInfo === null)
    throw new Error('Conversation binding requires a linked DeusExLevelInfo actor');

  const read = (object, key) => runtime.namedReference(object, key).get();
  const mission = read(levelInfo, 'missionNumber');
  if (!Number.isInteger(mission) || mission < 0)
    throw new Error(`Conversation binding requires a nonnegative DeusExLevelInfo.missionNumber, got ${mission}`);
  // ConBindEvents resolves the package from DeusExLevelInfo.ConversationPackage:
  // 'DeusExConversations' maps to the 'DeusExCon' prefix + 'Text'.
  const rawPackage = read(levelInfo, 'ConversationPackage');
  const packageName = String(rawPackage ?? 'DeusExConversations').toLowerCase() === 'deusexconversations'
    ? 'DeusExCon' : String(rawPackage ?? 'DeusExCon');
  const list = await runtime.prepareConversations(mission, `${packageName}Text`);
  const classRef = runtime.instance(list).cls.record;
  if (classRef.key !== 'consys.conversationlist')
    throw new Error('ConversationList class ancestry differs from the original contract');
  const listPath = `${packageName}Text.ConList_Mission${String(mission).padStart(2, '0')}`;
  await runtime.prepareDynamicLoadObject(listPath);

  // UObject::GetOuter(list) is the serialized package-identity record. The
  // native allocation path requires a registered GObjObjects entry carrying the
  // same canonical identity, its package name index and Core.Package class.
  const canonicalOuter = read(list, 'Outer');
  const registry = construction.registry;
  const resolved = construction.internName(String(canonicalOuter.name ?? canonicalOuter.path));
  const nativeOuter = {
    identity: canonicalOuter, index: -1, hashNext: null, stateFrame: null,
    linker: null, linkerIndex: -1, outer: null,
    name: resolved.name, nameIndex: resolved.index,
    objectClass: runtime.resources.nativeClass('Core.Package'),
  };
  registry.add(nativeOuter);

  runtime.conversationLifecycle = {
    load: request => runtime.loadPreparedDynamicObject({
      classRef, outer: request.outer, name: request.path,
      filename: request.filename, flags: request.flags, sandbox: request.sandbox,
    }),
    nativeOuter: value => {
      if (value !== canonicalOuter)
        throw new Error('ConversationList Outer is not the bound DeusExConText package identity');
      return nativeOuter;
    },
    construction: {
      validate: args => args.cls === runtime.conversationItemClass &&
        args.outer === nativeOuter && args.template === null,
      registry, findObject: construction.findObject, internName: construction.internName,
      // ConListItem's only members are the reflected con/next pointers, which
      // the recovered native constructor writes after InitProperties.
      initNativeProperties: () => {},
    },
    release: {
      // Live-game values of the two final-destructor Core globals
      // (docs/script-object-release.md): the object table is initialized and
      // the blocking global is clear during ordinary play.
      gates: { [0x102a2644]: 1, [0x101e5550]: 0 },
      registry, isValid: object => registry.objects[object.index] === object,
      freeStateFrame: () => { throw new Error('ConListItem release reached an unexpected state frame'); },
      freeObject: object => { object.released = true; },
    },
  };
  return { list, nativeOuter };
}
