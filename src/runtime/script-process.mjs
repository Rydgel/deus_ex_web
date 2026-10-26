/** The script state of the original's process that outlives a level (docs/class-graph-design.md "The process and the level", migration
 * steps 2-3). One per realm (the worker, or the page when the simulation runs inline). A ScriptRuntime is one level and attaches to a
 * process; a runtime built without one gets a process of its own, so a single-map session is the same either way.
 *
 * It holds:
 * - the package identities: ScriptObjects' process table, every export of a script or resource package except the objects a level
 *   attaches (script-objects.mjs exportScope);
 * - readiness, keyed by export (an identity's `key` is `${package}.${export path}`): linked bytecode, prepared functions and states,
 *   struct fields and layouts, context results. It depends on the package bytes only, so it is kept for the life of the page;
 * - the classes, each export's current generation (`classes`, `linkedClasses`), and the class loader with its load graph, GConfig and
 *   the resource registry.
 *
 * A level's runtime keeps its own Rust VM and object arena, its instances and its level identities (ScriptObjects' level table).
 * Identities in this process outlive the runtime that minted them: `owns` tells the handle table which handles a level's release
 * must keep (script-object-handles.mjs releaseHandleRange). */
export class ScriptProcess {
  constructor(assets) {
    this.assets = assets;
    // ScriptObjects' process table: lower-case export key -> identity.
    this.packageObjects = new Map();
    // Every identity this process holds, from its table, the class loader and the resource registry.
    this.identities = new WeakSet();
    // Readiness: ScriptObjects' linked bytecode (script -> bindings, script -> operand table).
    this.linkedScripts = new WeakMap();
    this.linkedOperands = new WeakMap();
    this.functions = new Map();
    this.states = new Map();
    this.structs = new Map();
    this.structLayouts = new Map();
    this.contextResults = new WeakMap();
    // The classes: class key -> pending linked class, and the linked ones in link order (SaveConfig's GObjObjects walk).
    this.classes = new Map();
    this.linkedClasses = new Set();
    // Engine.Actor's linked class, once linked.
    this.actorClass = null;
    this.classLoader = null;
    this.resources = null;
    // The level runtime attached now (attach): the level the class loader's per-level services report to; and how many levels attached
    // after the first.
    this.runtime = null;
    this.levels = 0;
  }
  /** Whether `identity` is one of this process's (it survives the level that minted it). */
  owns(identity) { return identity !== null && typeof identity === 'object' && this.identities.has(identity); }
  /** Record an identity the process holds. */
  hold(identity) { if (identity !== null && typeof identity === 'object') this.identities.add(identity); return identity; }
  /** `runtime` is the level now: the class loader mints its level identities in that runtime's table, the resource registry resolves
   * through it, and per-level load diagnostics go to it. */
  attach(runtime) {
    const previous = this.runtime;
    this.runtime = runtime;
    if (this.classLoader) {
      this.classLoader.attachLevel(runtime.objects);
      // The class defaults the arrival carried apply to the classes this level loads for the first time (the kept ones hold them already).
      this.classLoader.carriedDefaults = runtime.carriedDefaults;
    }
    if (this.resources) {
      this.resources.objects = runtime.objects;
      this.resources.indexProvider = runtime.originalObjectIndex;
      if (previous && previous !== runtime) this.resources.forgetLevel(identity => this.owns(identity));
    }
    if (previous && previous !== runtime) this.levels++;
  }
}
