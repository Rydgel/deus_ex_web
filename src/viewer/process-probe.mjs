/** Measurement only (scripts/map-memory-census.mjs, docs/map-memory.md): what the simulation side's script process and asset store hold
 * after a map change. `process` is the level's ScriptProcess (sim-host.mjs scriptProcess), `assets` the store it reads (the worker's, or
 * the page's inline), `tables` the level interpreter's handle tables (RustScriptVm.handleTables). Sizes in MB. */
export async function processProbe(process, assets, tables = null) {
  const mb = bytes => bytes / 1048576;
  let packageBytes = 0, releasedBytes = 0, preparedBytes = 0;
  for (const value of assets?.ready.values() ?? []) packageBytes += value.bytes.byteLength;
  for (const value of assets?.released.values() ?? []) releasedBytes += value.bytes.byteLength;
  const graph = process?.classLoader?.graph ?? null, prepared = [];
  for (const [name, asset] of graph?.packageAssets ?? []) { preparedBytes += asset.bytes?.byteLength ?? 0; prepared.push(name); }
  const kernel = (await import('../runtime/script-vm-kernel.mjs')).scriptVmKernel?.blockStats?.() ?? null;
  // this realm's live Wasm memories with their creation sites, with ?hitchlog=1 (hitch-wasm.mjs: the watch is installed then)
  const wasm = (await import('./hitch-wasm.mjs')).wasmMemories();
  // the interpreters and event hosts the process-wide WeakRef walks still reach (script-vm-rust.mjs: a disposed level's leave them)
  const interpreters = (await import('../runtime/script-vm-rust.mjs')).interpreterCount(), eventHosts = (await import('../runtime/script-vm-events.mjs')).eventHostCount();
  // the handles allocated so far (never reused: script-object-handles.mjs) and those live; a level's interpreter tables cover its own
  // and those live when it started (script-vm-handle-slots.mjs)
  const {handleLimit, liveHandleCount} = await import('../runtime/script-object-handles.mjs');
  const handles = handleLimit(), liveHandles = liveHandleCount();
  return {
    classes: process?.classes.size ?? null, linkedClasses: process?.linkedClasses.size ?? null, identities: process?.packageObjects.size ?? null,
    levels: process?.levels ?? null, linkers: graph?.linkers.size ?? null,
    packages: assets?.ready.size ?? null, packageMB: mb(packageBytes), released: assets?.released.size ?? null, releasedMB: mb(releasedBytes),
    prepared: prepared.length, preparedMB: mb(preparedBytes), preparedNames: prepared.sort(),
    readyNames: [...(assets?.ready.keys() ?? [])].sort(),
    kernel: kernel && { blocks: kernel.blocks, usedMB: mb(kernel.usedBytes), freeMB: mb(kernel.freeBytes), memoryMB: mb(kernel.memoryBytes) },
    wasm, interpreters, eventHosts, handles, liveHandles, tables,
    // the DEUS_EX_* switches this realm holds (the page's reach the worker through init: sim-worker.mjs)
    switches: Object.fromEntries(Object.keys(globalThis).filter(key => key.startsWith('DEUS_EX_')).map(key => [key, globalThis[key]])),
    // the render-iterator loop's counters in this realm (script-vm-particles.mjs particleItemCounts): iterators and steps run in Rust, the
    // verify mode's comparisons
    particleItems: {...(await import('../runtime/script-vm-particles.mjs')).particleItemCounts},
  };
}
