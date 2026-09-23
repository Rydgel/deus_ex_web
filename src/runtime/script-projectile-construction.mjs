/**
 * Native construction evidence for the Engine.Projectile constructor family:
 * script-only subclasses such as `DeusEx.WoodFragment -> DeusEx.DeusExFragment
 * -> Engine.Fragment -> Engine.Projectile (native) -> Engine.Actor`.
 *
 * As with the Inventory/Weapon chains (script-inventory-construction.mjs),
 * Core UClass::Bind copies the first native ancestor's ClassConstructor down
 * the script-only subclasses — here AProjectile's. The addresses below are the
 * installed Engine.dll's (SHA-256 0c3a8b18…, image base 0x10300000):
 *
 * - Registration 0x1035fb90 constructs the UClass for PrivateStaticClass
 *   0x10578850 with instance size 0x340, super AActor::PrivateStaticClass
 *   0x1057cdf0, raw flags 0x04084004 and InternalConstructor 0x103014e7
 *   (push sequence 0x1035fb9b-0x1035fbd9, UClass ctor through IAT 0x10599de0).
 * - InternalConstructor 0x103014e7 -> 0x103442c0 (null-this guard) ->
 *   ??0AProjectile@@IAE@XZ 0x1030167c -> body 0x103442e0. The body calls
 *   ??0UObject@@QAE@XZ (IAT 0x10599b58), runs the inlined AActor member
 *   constructors — ??0FName@@QAE@XZ x4 at +0x68, ??0FPlane@@QAE@XZ x4 at
 *   +0x26c (stride 0x10), ??0FString@@QAE@W4ENoInit@@@Z x4 at +0x2ac/+0x2b8/
 *   +0x2c4/+0x2d0, none of which writes template-copied member bytes — and
 *   stores the final vtable 0x10428850 at 0x10344387. There is no
 *   intermediate AActor vtable store in this body.
 * - The AProjectile vtable equals AActor's (0x104268dc) in every slot except
 *   +0x0c (vector deleting destructor), so the SpawnActor-used slots
 *   (+0x10 ProcessEvent, +0x38 InitExecution, +0x74 Spawned) and
 *   performPhysics (+0x8c -> 0x10303242 -> AActor::performPhysics 0x103c9770)
 *   are the AActor ones.
 *
 * Evidence recorded in docs/script-weapon-fire.md. This admits the chain by
 * its native root, not by class name, and is not a generic Actor fallback.
 */

const freeze = value => Object.freeze(value);

export const ENGINE_PROJECTILE = freeze({
  sha256: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  imageBase: 0x10300000,
  package: 'Engine',
  className: 'Projectile',
  key: 'engine.projectile',
  registration: 0x1035fb90,
  rawRegistrationFlags: 0x04084004,
  staticClass: 0x10578850,
  superStaticClass: 0x1057cdf0,
  instanceSize: 0x340,
  internalConstructor: 0x103014e7,
  constructorBody: 0x103442e0,
  vtable: 0x10428850,
  actorVtable: 0x104268dc,
  initExecution: freeze({slot: 0x38, thunk: 0x10302194, body: 0x103deb40}),
  spawned: freeze({slot: 0x74, thunk: 0x10303373, body: 0x1030d730}),
  processEvent: freeze({slot: 0x10, thunk: 0x10302d74}),
  performPhysics: freeze({slot: 0x8c, thunk: 0x10303242, body: 0x103c9770}),
});

const NATIVE_FLAG = 0x04000000;
const classKey = cls => String(cls?.record?.key ?? '').toLowerCase();

/** The linked script-only chain from `cls` down to native Engine.Projectile
 * (whose base must be Engine.Actor -> Core.Object), or null for any other
 * class. A native class other than Engine.Projectile that sits above an
 * Engine.Projectile ancestor is a different constructor family and throws. */
export function projectileConstructorChain(cls) {
  const chain = [];
  for (let node = cls; node; node = node.base) {
    chain.push(node);
    if (((node.metadata?.entry?.flags ?? 0) & NATIVE_FLAG) === 0) continue;
    if (classKey(node) !== ENGINE_PROJECTILE.key) {
      for (let probe = node.base; probe; probe = probe.base)
        if (classKey(probe) === ENGINE_PROJECTILE.key)
          throw new Error(`UClass::Bind native constructor family is not implemented for ${classKey(node)}`);
      return null;
    }
    if (classKey(node.base) !== 'engine.actor' || classKey(node.base.base) !== 'core.object' || node.base.base.base != null)
      return null;
    return chain;
  }
  return null;
}

/** The inherited constructor selection UClass::Bind produces for an admitted
 * Projectile-family leaf, in the shape the SpawnActor hosts check. */
export function projectileSelection(cls, propertiesSize) {
  if (!projectileConstructorChain(cls)) return null;
  if (!Number.isInteger(propertiesSize) || propertiesSize < ENGINE_PROJECTILE.instanceSize)
    throw new Error(`Projectile-family class ${classKey(cls)} has no linked PropertiesSize`);
  return freeze({classKey: classKey(cls), inherited: true,
    constructor: ENGINE_PROJECTILE.internalConstructor, constructorBody: ENGINE_PROJECTILE.constructorBody,
    nativeVtable: ENGINE_PROJECTILE.vtable, propertiesSize});
}
