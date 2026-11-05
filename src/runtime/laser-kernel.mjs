/** The host side of native/script-vm/src/laser.rs: ULaserIterator::CurrentItem on the Rust x87 model at precision control 24
 * (docs/lasers.md), called from script-laser.mjs laserIteratorItems in place of laserCurrentItem once the script VM kernel is
 * loaded. laserCurrentItem stays the reference: LASER=js (Node) or ?laser=js keeps it, LASER=verify runs both on the same state and
 * appFrand values and throws on a difference, and scripts/validate-native-laser.mjs compares both with the DLL's body.
 *
 * The state crosses through the kernel's LASER_IO words before each item and back after it, as typed-array views (a float through
 * a Float32Array rounds as FST does); the beams, which no item changes, are written once per state object. */
const BEAMS = 8, BEAM_WORDS = 9, L_INDEX = 72, L_MAXITEMS = 73, L_PREVLOC = 74, L_PREVRAND = 77, L_SAVEDLOC = 80, L_SAVEDROT = 83,
  L_NEXTITEM = 86, L_RANDOMBEAM = 87, L_OWNER = 88, L_MOVES = 91, L_WORDS = L_MOVES + 1 + 16;
const DONE = 0, MOVE_LOCATION = 1;

/** 'rust' (default), 'js' or 'verify'. */
export const laserMode = () => (typeof process !== 'undefined' && process.env?.LASER) || globalThis.DEUS_EX_LASER || 'rust';

// The appFrand stream of the item in flight.
let frand = null;
/** The kernel instance's imports for laser.rs: appFrand, and FPATAN as vectorToRotator24 takes it (Math.atan2). */
export const laserImports = { js_laser_frand: () => frand(), js_atan2: Math.atan2 };

export function createLaserKernel(x, memory) {
  const at = x.laser_io_ptr();
  let buffer = null, u32 = null, i32 = null, f32 = null, written = null;
  const sync = () => {
    if (memory.buffer === buffer) return;
    buffer = memory.buffer; written = null;
    u32 = new Uint32Array(buffer, at, L_WORDS); i32 = new Int32Array(buffer, at, L_WORDS); f32 = new Float32Array(buffer, at, L_WORDS);
  };
  const put3 = (array, i, v) => { array[i] = v[0]; array[i + 1] = v[1]; array[i + 2] = v[2]; };
  const get3 = (array, i) => [array[i], array[i + 1], array[i + 2]];
  return Object.freeze({
    /** laserCurrentItem(state, ownerLocation, appFrand) in Rust: the same moves, and the same changes to `state`. */
    currentItem(state, ownerLocation, appFrand) {
      if (!state.hasProxy) return null;
      sync();
      if (written !== state.beams) {
        for (let b = 0; b < BEAMS; b++) {
          const beam = state.beams[b], o = b * BEAM_WORDS;
          u32[o] = beam.active ? 1 : 0; put3(f32, o + 1, beam.location); put3(i32, o + 4, beam.rotation);
          f32[o + 7] = beam.length; i32[o + 8] = beam.numSegments;
        }
        written = state.beams;
      }
      i32[L_INDEX] = state.index; i32[L_MAXITEMS] = state.maxItems;
      put3(f32, L_PREVLOC, state.prevLoc); put3(f32, L_PREVRAND, state.prevRand); put3(f32, L_SAVEDLOC, state.savedLoc);
      put3(i32, L_SAVEDROT, state.savedRot); i32[L_NEXTITEM] = state.nextItem; u32[L_RANDOMBEAM] = state.randomBeam ? 1 : 0;
      put3(f32, L_OWNER, ownerLocation);
      frand = appFrand;
      let status;
      try { status = x.laser_current_item(); } finally { frand = null; }
      // (vectorToRotator24's throw; the draws before it are taken, as there)
      if (status !== DONE) throw new Error('Original nonfinite vector rotation is not implemented');
      state.prevLoc = get3(f32, L_PREVLOC); state.prevRand = get3(f32, L_PREVRAND); state.savedLoc = get3(f32, L_SAVEDLOC);
      state.savedRot = get3(i32, L_SAVEDROT); state.nextItem = i32[L_NEXTITEM];
      const moves = new Array(u32[L_MOVES]);
      for (let m = 0; m < moves.length; m++) {
        const o = L_MOVES + 1 + 4 * m;
        moves[m] = u32[o] === MOVE_LOCATION ? { location: get3(f32, o + 1) } : { rotation: get3(i32, o + 1) };
      }
      return moves;
    },
  });
}
