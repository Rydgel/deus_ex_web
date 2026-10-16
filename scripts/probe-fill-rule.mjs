// The host rasterizer's rule for a pixel whose centre lies exactly on a polygon edge, in the browser and GPU backend Play's
// acceptance runs use (Playwright Chromium, ANGLE over Metal on the Mac, over GL on Linux): docs/frame-projection.md
// "Edges on pixel centres (2026-10-16)". A rectangle whose four edges lie on pixel centres (image coordinates, y down from the top) is drawn
// to the canvas's default framebuffer and to a render target, with both windings and a few clip-space w; the report says which
// of its edge rows and columns the host filled. The same rectangle is drawn again with every vertex moved by a small offset, to
// find the snapping step below which an offset is lost.
//
//   node scripts/probe-fill-rule.mjs [--angle metal|gl|swiftshader]
import {chromium} from 'playwright';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const angle = option('angle', process.platform === 'darwin' ? 'metal' : 'gl');
const browser = await chromium.launch({args: [`--use-angle=${angle}`]});
const page = await browser.newPage({viewport: {width: 1280, height: 720}});
await page.setContent('<canvas id="c" width="1280" height="720" style="display:block"></canvas>');
const result = await page.evaluate(() => {
  const W = 1280, H = 720, canvas = document.getElementById('c');
  const gl = canvas.getContext('webgl2', {antialias: false, preserveDrawingBuffer: true});
  const renderer = gl.getParameter(gl.RENDERER), subpixelBits = gl.getParameter(gl.SUBPIXEL_BITS);
  const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
in vec2 p; uniform float w;
void main() { gl_Position = vec4((p.x * 2.0 / ${W}.0 - 1.0) * w, (1.0 - p.y * 2.0 / ${H}.0) * w, 0.0, w); }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; out vec4 o; void main() { o = vec4(1.0); }`));
  gl.linkProgram(program); gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const at = gl.getAttribLocation(program, 'p'); gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  const wAt = gl.getUniformLocation(program, 'w');
  // render target
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
  const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const pixels = new Uint8Array(W * H * 4);
  // The rectangle x0..x1, y0..y1 in image coordinates (pixel centres at k + 0.5), as two triangles of the given winding.
  const draw = (target, x0, y0, x1, y1, ccw, w) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const tl = [x0, y0], tr = [x1, y0], bl = [x0, y1], br = [x1, y1];
    const tris = ccw ? [tl, bl, br, tl, br, tr] : [tl, tr, br, tl, br, bl];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tris.flat()), gl.STATIC_DRAW);
    gl.uniform1f(wAt, w); gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const lit = (x, y) => pixels[4 * ((H - 1 - y) * W + x)] > 0;   // readPixels rows run bottom-up
    // which image rows and columns hold any lit pixel
    let top = H, bottom = -1, left = W, right = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lit(x, y)) { top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x); }
    return {top, bottom, left, right};
  };
  const out = {renderer, subpixelBits, cases: [], offsets: []};
  // Edges on centres: x 100.5 .. 200.5, y 100.5 .. 200.5 (columns/rows 100 and 200 are the edge pixels).
  for (const [name, target] of [['canvas', null], ['render target', fbo]])
    for (const ccw of [true, false]) for (const w of [1, 37.25, 1000]) {
      const r = draw(target, 100.5, 100.5, 200.5, 200.5, ccw, w);
      out.cases.push({target: name, winding: ccw ? 'ccw' : 'cw', w, topEdgeRow: r.top === 100, bottomEdgeRow: r.bottom === 200, leftEdgeColumn: r.left === 100, rightEdgeColumn: r.right === 200, ...r});
    }
  // The same rectangle with all four edges moved up and left by d (image coordinates): from which d the top/left edges' centres are inside.
  for (const [name, target] of [['canvas', null], ['render target', fbo]])
    for (const d of [1 / 2048, 1 / 1024, 1 / 512, 1 / 256, 1 / 128, 1 / 64]) {
      const r = draw(target, 100.5 - d, 100.5 - d, 200.5 - d, 200.5 - d, true, 37.25);
      out.offsets.push({target: name, d, topEdgeRow: r.top === 100, bottomEdgeRow: r.bottom === 200, leftEdgeColumn: r.left === 100, rightEdgeColumn: r.right === 200});
    }
  return out;
});
await browser.close();
console.log(`renderer: ${result.renderer} (--use-angle=${angle}), SUBPIXEL_BITS ${result.subpixelBits}`);
console.log('edges on pixel centres (true: the edge pixels are filled):');
for (const c of result.cases) console.log(`  ${c.target.padEnd(13)} ${c.winding} w ${String(c.w).padEnd(5)} top ${c.topEdgeRow} bottom ${c.bottomEdgeRow} left ${c.leftEdgeColumn} right ${c.rightEdgeColumn}`);
console.log('every edge moved up and left by d pixels:');
for (const c of result.offsets) console.log(`  ${c.target.padEnd(13)} d 1/${1 / c.d} top ${c.topEdgeRow} bottom ${c.bottomEdgeRow} left ${c.leftEdgeColumn} right ${c.rightEdgeColumn}`);
