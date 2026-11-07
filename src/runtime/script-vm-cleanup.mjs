/**
 * CleanupDestroyed's pointer scan in the Rust core (native/script-vm cleanup.rs, docs/firefox-60fps-plan.md "Tick hand-backs").
 *
 * ULevel::CleanupDestroyed walks every actor of the level once 128 destroyed actors are pending and clears each object pointer that
 * names a pending-kill object (script-cleanup.mjs cleanupLevelDestroyed). In play an actor whose visited fields are all image cells has
 * its pointers read from the image (script-cleanup.mjs cleanupImageSites): about 30 sites an actor, each a handle read, an identity
 * lookup and a per-pass verdict lookup, about 60,000 sites in the Dockyard's pass. Here the loop over one actor's sites is Rust's
 * (`vm_cleanup_scan`), over a copy of the class plan's offsets in the arena and a table of the pass's verdicts keyed by handle. The scan
 * stops at a handle with no verdict (NEED: this host decides it exactly as cleanupImageSites does at the first site that names the object
 * and enters it) and at a pending target's site (CLEAR: the site is cleared through the property reference as before).
 *
 * Every actor has host bindings (the object header's Class, Outer and Name, Actor.Level), and a site under a bound top-level field is
 * read through its binding, not from the image. The sites under the top-level fields an actor's bindings serve (the plan's sites by top
 * key, one `Map.get` per binding) are read here, through the reference, before the scan, and the scan passes them (its `skip` flags).
 * That visits the bound sites ahead of the image sites instead of among them: the clears are the same sites, and the verdicts the same
 * objects' (the order differs only in which invalid reference an error would name first). An actor in another arena, or with too little
 * room left in the verdict table, keeps the JavaScript loop.
 *
 * CLEANUP_SCAN (DEUS_EX_CLEANUP_SCAN, `?cleanupScan=`): 'rust' (default), 'js' (cleanupImageSites for every actor, and the registry-wide
 * filter in createLevelCollection.release) or 'verify' (the JavaScript loop first on the same actor without clearing, the sites it would
 * clear recorded; then the scan, whose clears must be the same sites; and the release log compared with the filter).
 */
import {identityOfHandle} from './script-object-handles.mjs';
import {cleanupImageSites, clearSite, readSite, siteVerdict} from './script-cleanup.mjs';
import {switchReader} from './switch-reader.mjs';

export const cleanupScanMode = switchReader('CLEANUP_SCAN', 'DEUS_EX_CLEANUP_SCAN', 'rust');

const DONE = 0, NEED = 1;
// 8,192 entries of 8 bytes [handle, verdict]; the table is kept under half full.
const ENTRIES = 8192, LIMIT = ENTRIES / 2, MASK = ENTRIES - 1, MAX_SITES = 256;

export class CleanupHost {
  constructor(vm) {
    this.vm = vm;
    this.x = null;
    this.io = 0;
    this.table = 0;
    this.skip = 0;
    this.owner = null;
    this.entered = 0;
    this.plans = new WeakMap();
    this.bound = new WeakMap();
    // what the scan did (a validator or a scenario reads them: the Rust paths ran when these are not zero)
    this.counts = {actors: 0, scans: 0, needs: 0, clears: 0, boundSites: 0, fallbacks: 0, verified: 0};
  }
  attach(x) {
    this.x = x;
    this.io = x.vm_cleanup_io_ptr();
  }
  get ready() { return this.x !== null && cleanupScanMode() !== 'js'; }

  /** The plan's offsets in the arena (once per plan). */
  planAddress(plan) {
    let at = this.plans.get(plan);
    if (at === undefined) {
      at = this.vm.arena.alloc(4 * Math.max(1, plan.offsets.length));
      new Uint32Array(this.vm.arena.memory.buffer, at, plan.offsets.length).set(plan.offsets);
      this.plans.set(plan, at);
    }
    return at;
  }
  /** The verdict table for the pass `verdicts` (a Map per cleanupDestroyed call) names: cleared when the pass changes. */
  tableFor(verdicts) {
    const arena = this.vm.arena;
    if (this.table === 0) {
      this.table = arena.alloc(8 * ENTRIES);
      this.skip = arena.alloc(MAX_SITES);
      arena.bytes.fill(0, this.skip, this.skip + MAX_SITES);
    }
    if (this.owner !== verdicts) {
      arena.bytes.fill(0, this.table, this.table + 8 * ENTRIES);
      this.owner = verdicts;
      this.entered = 0;
    }
    return this.table;
  }
  /** The plan's sites by their top-level field's key (once per plan). */
  topSites(plan) {
    let tops = this.bound.get(plan);
    if (tops === undefined) {
      tops = new Map();
      plan.sites.forEach((site, i) => { const list = tops.get(site.top); if (list) list.push(i); else tops.set(site.top, [i]); });
      this.bound.set(plan, tops);
    }
    return tops;
  }

  /** cleanupReferences' image path for one actor `receiver` (its `instance`): `plan` (cleanupPlan), `reference` (the field-reference maker), `services`, `verdicts`.
   * False where the JavaScript loop must run instead (nothing has been done then). */
  scanActor(receiver, instance, plan, reference, services, verdicts) {
    const arena = this.vm.arena, counts = this.counts, count = plan.sites.length, bindings = instance.bindings;
    if (instance.arena !== arena || count > MAX_SITES || this.owner === verdicts && this.entered + count > LIMIT) {
      counts.fallbacks++;
      return false;
    }
    const verify = cleanupScanMode() === 'verify';
    // the bound sites: the sites under a top-level field this actor's bindings serve, in site order
    let bound = null;
    if (bindings.size) {
      const tops = this.topSites(plan);
      for (const key of bindings.keys()) { const list = tops.get(key); if (list !== undefined) (bound ??= []).push(...list); }
      if (bound !== null && bound.length > 1) bound.sort((a, b) => a - b);
    }
    // verify: the JavaScript loop first, recording the sites it would clear
    let expected = null;
    if (verify) {
      expected = [];
      cleanupImageSites(plan.sites, plan.offsets, arena.view, instance.base, bindings.size ? bindings : null, reference, services, verdicts, expected);
    }
    const table = this.tableFor(verdicts), offsets = this.planAddress(plan), x = this.x, base = instance.base, got = [];
    counts.actors++;
    let from = 0;
    if (bound !== null) for (const site of bound) arena.bytes[this.skip + site] = 1;
    try {
      // the bound sites, read through their bindings, before the scan
      if (bound !== null) for (const site of bound) {
        counts.boundSites++;
        // (a top-level scalar field's value without the lvalue, runtime.fieldValue: the same binding read and codec copy)
        const at = plan.sites[site], simple = at.path.length === 1 && at.path[0].field.metadata.arrayDim === 1;
        const target = simple ? this.vm.runtime.fieldValue(receiver, at.path[0].field) : readSite(at, reference);
        if (target !== null && siteVerdict(target, plan.sites[site], services, verdicts)) {
          got.push(site);
          clearSite(plan.sites[site], reference);
        }
      }
      for (;;) {
        counts.scans++;
        const status = x.vm_cleanup_scan(base, offsets, count, from, table, MASK, bound !== null ? this.skip : 0);
        if (status === DONE) break;
        const view = arena.view, site = view.getUint32(this.io + 4, true), handle = view.getUint32(this.io + 8, true);
        if (status === NEED) {
          counts.needs++;
          this.decide(plan.sites[site], handle, services, verdicts);
          continue;
        }
        // CLEAR: a pending-kill target
        counts.clears++;
        got.push(site);
        clearSite(plan.sites[site], reference);
        from = site + 1;
      }
    } finally {
      if (bound !== null) for (const site of bound) arena.bytes[this.skip + site] = 0;
    }
    if (expected !== null) {
      counts.verified++;
      const sorted = list => [...list].sort((a, b) => a - b).join();
      if (sorted(expected) !== sorted(got))
        throw new Error(`CLEANUP_SCAN=verify: the JavaScript loop clears sites [${expected}] of ${instance.cls?.record?.key}, the Rust scan [${got}]`);
    }
    return true;
  }
  /** cleanupImageSites' first encounter of the object at `handle`: IsValid (an error for an unregistered one), IsPendingKill, kept in the
   * pass's Map; a released handle reads None and is skipped. The verdict is entered for the scan. */
  decide(site, handle, services, verdicts) {
    const target = identityOfHandle(handle);
    const pending = target !== null && siteVerdict(target, site, services, verdicts);
    this.x.vm_cleanup_insert(this.table, MASK, handle, pending ? 2 : 1);
    this.entered++;
  }
}
