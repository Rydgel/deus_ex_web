// Capture shim for volumetric-fog-capture.mjs: world.mjs's `./fog-pass.mjs`
// import is redirected here by a resolve hook, so the real fog pass gets a
// kernel whose `fog` methods record what Play sends to the Rust loop
// (fogMapKernel's lights, tables, grid, flag and size) before forwarding.
import {createFogPass as createRealFogPass} from '../src/viewer/fog-pass.mjs';

export const fogCapture = {sink: null};

export function createFogPass(options) {
  const real = options.kernel?.fog;
  if (!real) return createRealFogPass(options);
  let lights = null, tables = null, grid = null, missIn = 0;
  const fog = {
    sqrt: table => real.sqrt(table),
    lights: words => { lights = Uint32Array.from(words); real.lights(words); },
    tables: bytes => { tables = Uint8Array.from(bytes); real.tables(bytes); },
    grid: words => { grid = Uint32Array.from(words); real.grid(words); },
    setMiss: value => { missIn = value >>> 0; real.setMiss(value); },
    miss: () => real.miss(),
    setExact: on => real.setExact(on),
    map: (width, height, count) => {
      fogCapture.sink?.({width, height, count, lights, tables, grid, missIn});
      return real.map(width, height, count);
    },
  };
  return createRealFogPass({...options, kernel: {fog}});
}
