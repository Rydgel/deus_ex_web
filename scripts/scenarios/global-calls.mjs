// bench-sim --scenario: every EX_GlobalFunction (0x38, `Global.Tick(...)`) the Rust VM resolves (script-vm-rust.mjs callRecord), by
// function name, the record it resolved (the state skipped) and the record a virtual lookup would have resolved (the state first).
// Run it with RUST_CALLS=0 so that every call begin resolves (the call cache otherwise resolves once per class and state):
//   RUST_CALLS=0 node scripts/bench-sim.mjs --map 01_NYC_UNATCOIsland --warm 60 --ticks 300 --render-feedback \
//     --scenario scripts/scenarios/global-calls.mjs
// Evidence for docs/firefox-60fps-plan.md "Global function calls run in Rust". Measurement only; it changes no state.
export default ({runtime}) => {
  const vm = runtime.scriptVm, rows = new Map();
  const original = vm.callRecord.bind(vm);
  vm.callRecord = (n, receiver, caller) => {
    const record = original(n, receiver, caller);
    if (n.op === 0x38) {
      const virtual = runtime.lookup(receiver, n.name, false);
      const key = `Global.${n.name} -> ${record?.key} (a virtual lookup would find ${virtual?.key}${virtual === record ? ', the same' : ''})`;
      rows.set(key, (rows.get(key) ?? 0) + 1);
    }
    return record;
  };
  process.on('exit', () => {
    console.log('global calls resolved:');
    for (const [key, count] of [...rows].sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(7)}  ${key}`);
  });
  return () => {};
};
