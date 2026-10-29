/** The host side of native/script-vm/src/computer.rs: XComputerWindow::Tick's blink and time arithmetic on the Rust x87 model, called from
 * script-window-computer-playback.mjs in place of its BigInt body once the script VM kernel is loaded. The BigInt body stays as the
 * reference; test/script-window-computer-tick.test.mjs runs both over random float32 values.
 *
 * A float is written as a JavaScript number into a Float32Array view of the kernel's IO block, which rounds as FLD m32 of the stored
 * word does, and a result is read back from it, as galaxy-update-kernel.mjs does. Nothing is allocated per call: the result is one
 * object the kernel owns and rewrites. The views are made again when the memory grows. */
const IO_WORDS = 16;
const I_A = 0, I_B = 1, I_C = 2, I_D = 3, I_E = 4, O_STORED = 8, O_FLAG = 9, O_OTHER = 10;

export function createComputerTickKernel(x, memory) {
  const at = x.computer_io_ptr();
  let buffer = null, u32 = null, f32 = null;
  const sync = () => {
    if (memory.buffer === buffer) return;
    buffer = memory.buffer;
    u32 = new Uint32Array(buffer, at, IO_WORDS);
    f32 = new Float32Array(buffer, at, IO_WORDS);
  };
  const result = {stored: 0, flag: false, other: 0};
  return Object.freeze({
    /** The blink step: `stored` is next - delta stored; `flag` says it is below zero (or unordered), when `other` is the sum with the
     * blink speed stored, which replaces it. */
    cursorStep(next, delta, blink) {
      sync();
      f32[I_A] = next; f32[I_B] = delta; f32[I_C] = blink;
      x.computer_cursor_step();
      result.stored = f32[O_STORED]; result.flag = u32[O_FLAG] !== 0; result.other = f32[O_OTHER];
      return result;
    },
    /** The time step: `stored` is delta * throttle + timeCurrent stored; `flag` says it passes timeLastEvent by more than the interval,
     * when `other` is its sum with the interval stored (timeNextEvent). */
    timeStep(delta, throttle, timeCurrent, timeLastEvent, interval) {
      sync();
      f32[I_A] = delta; f32[I_B] = throttle; f32[I_C] = timeCurrent; f32[I_D] = timeLastEvent; f32[I_E] = interval;
      x.computer_time_step();
      result.stored = f32[O_STORED]; result.flag = u32[O_FLAG] !== 0; result.other = f32[O_OTHER];
      return result;
    },
  });
}
