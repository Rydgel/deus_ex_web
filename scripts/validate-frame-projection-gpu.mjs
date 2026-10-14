/** The GLSL chain (src/viewer/frame-projection-glsl.mjs) on the GPU against the
 * unchanged original (docs/frame-projection.md). The oracle data of
 * validate-frame-projection.mjs is replayed through headless Chromium (ANGLE
 * on the GPU, --angle): for every frame (main and child) the model points of
 * its draw lists go through fpView and fpVertex in a float32 render target,
 * and the mesh cases' view-space points through fpVertex. Every output word
 * equals the vertices of D3DDrv's vertex buffer and the view point of
 * ClipBspSurf's FTransform, bit for bit; the clip-space form's perspective
 * division reproduces the window position and depth within the host
 * rasterizer's rounding.
 *
 *   node scripts/validate-frame-projection-gpu.mjs [--angle gl|metal|vulkan] [map ...] */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { available, bspOracle, meshOracle, rectOf } from './frame-projection-cases.mjs';
import { depthConstants, floatWord, wordFloat } from '../src/runtime/frame-projection.mjs';
import { frameProjectionGlsl } from '../src/viewer/frame-projection-glsl.mjs';

if (!available) {
  console.log('SKIP validate-frame-projection-gpu: no native probe environment');
  process.exit(0);
}
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const angle = option('angle', process.platform === 'darwin' ? 'metal' : 'gl');
const only = new Set(process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--angle'));
const word = v => v >>> 0;
const f = v => wordFloat(v);

/** One GPU unit: a frame's uniforms and the points it projects. */
function unit(fields, rect, flip, depth, label) {
  return { label, origin: [0, 1, 2].map(k => f(fields[k])), axes: [3, 6, 9].map(b => [0, 1, 2].map(k => f(fields[b + k]))),
    proj: [f(fields[21]), f(fields[24]), f(fields[14]), f(fields[15])], rect: [rect.width, rect.height, rect.x, rect.y],
    depth: [depth.zBias, depth.zScale, flip], points: [], expected: [] };
}
const depth = depthConstants(32);
const units = [];
for (const [mapName, options] of [['01_NYC_UNATCOIsland', { seed: 13, count: 12, aimed: false }],
  ['10_Paris_Club', { seed: 7, count: 14, aimed: true, views: [32768, 40960, 0, 16384, 49152].map(yaw => ({ location: [2063, 273, 30], rotation: [0, yaw, 0] })) }]]) {
  if (only.size && !only.has(mapName)) continue;
  const { model, cases, results } = await bspOracle(mapName, options);
  for (const [i, c] of cases.entries()) {
    const o = results[i], rect = rectOf(c);
    const frames = [{ fields: o.frameBits, draw: o.draw, label: 'main', flip: 1 }, ...(o.frames ?? []).map(ch =>
      ({ fields: ch.frameBits, draw: ch.draw, label: `child ${ch.index}`, flip: ch.mirrorBits >>> 0 === 0xbf800000 ? -1 : 1 }))];
    for (const frame of frames) {
      const u = unit(frame.fields, rect, frame.flip, depth, `${mapName} case ${i} ${frame.label}`);
      const seen = new Set();
      for (const list of frame.draw) for (const entry of list) for (const poly of entry.polys) for (const [k, t] of poly.points.entries()) {
        const pv = poly.pv[k];
        if (pv < 0 || seen.has(pv)) continue;
        seen.add(pv);
        // Unreal world coordinates in; the FTransform's view point and the vertex out.
        u.points.push({ world: model.points[pv], view: [t[0], t[1], t[2]], mode: 0 });
        u.expected.push(poly.d3d[k]);
      }
      units.push(u);
    }
  }
}
for (const [mapName, options] of [['01_NYC_UNATCOIsland', { seed: 5, count: 8 }], ['10_Paris_Club', { seed: 9, count: 8 }]]) {
  if (only.size && !only.has(mapName)) continue;
  const { cases, results } = await meshOracle(mapName, options);
  for (const [i, c] of cases.entries()) {
    const o = results[i], u = unit(o.frameBits, rectOf(c), 1, depth, `${mapName} mesh case ${i}`);
    for (const p of o.points) if (p.flags === 0) { u.points.push({ world: p.point.map(f), view: p.point.map(word), mode: 1 }); u.expected.push(p.d3d); }
    units.push(u);
  }
}

const vertexSource = '#version 300 es\nprecision highp float;\nvoid main(){vec2 p=vec2(float((gl_VertexID&1)<<2)-1.0,float((gl_VertexID&2)<<1)-1.0);gl_Position=vec4(p,0.0,1.0);}';
// --no-barrier: the mutation check. Without B() the compiler may fuse and
// reassociate; the run then reports how many vertices differ instead of failing.
const noBarrier = process.argv.includes('--no-barrier');
let fragmentSource = `#version 300 es
precision highp float;precision highp int;precision highp sampler2D;
uniform sampler2D uPoints;uniform int uMode;
${frameProjectionGlsl()}
layout(location=0) out vec4 oVertex;layout(location=1) out vec4 oView;layout(location=2) out vec4 oClip;
void main(){
  vec4 q=texelFetch(uPoints,ivec2(gl_FragCoord.xy),0);
  vec3 v=q.w>0.5?q.xyz:fpView(q.xyz);
  oView=vec4(v,0.0);oVertex=fpVertex(v);oClip=fpClip(v);}`;
if (noBarrier) fragmentSource = fragmentSource.replace('float B(float x){return uintBitsToFloat(floatBitsToUint(x)^uFpZero);}', 'float B(float x){return x;}');

const browser = await chromium.launch({ args: [`--use-angle=${angle}`] });
let checked = 0, mismatched = 0, clipChecked = 0, maxClipPixel = 0, maxClipDepth = 0;
try {
  const page = await browser.newPage();
  await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
  const runtime = await page.evaluate(({ vertexSource, fragmentSource, units }) => {
    const gl = document.getElementById('c').getContext('webgl2');
    if (!gl.getExtension('EXT_color_buffer_float')) return { error: 'EXT_color_buffer_float missing' };
    const compile = (type, source) => {
      const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const WIDTH = 256, results = [];
    const targets = [0, 1, 2].map(() => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      return t;
    });
    const input = gl.createTexture(), fb = gl.createFramebuffer();
    const u = (name) => gl.getUniformLocation(program, name);
    for (const unit of units) {
      const rows = Math.max(1, Math.ceil(unit.points.length / WIDTH));
      const data = new Float32Array(WIDTH * rows * 4);
      unit.points.forEach((p, i) => { const src = p.mode ? p.view : p.world; data.set(src.map(x => x), i * 4); data[i * 4 + 3] = p.mode ? 1 : 0; });
      if (unit.points.some(p => p.mode)) {
        // View-space inputs arrive as words: reinterpret.
        const words = new Uint32Array(data.buffer);
        unit.points.forEach((p, i) => { if (p.mode) { words[i * 4] = p.view[0]; words[i * 4 + 1] = p.view[1]; words[i * 4 + 2] = p.view[2]; } });
      }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, WIDTH, rows, 0, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.activeTexture(gl.TEXTURE1);
      targets.forEach((t, k) => {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, WIDTH, rows, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0);
      });
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      gl.viewport(0, 0, WIDTH, rows);
      gl.uniform1i(u('uPoints'), 0);
      gl.uniform1ui(u('uFpZero'), 0);
      gl.uniform1f(u('uFpOn'), 1);
      gl.uniform3fv(u('uFpOrigin'), unit.origin);
      gl.uniform3fv(u('uFpAxisX'), unit.axes[0]); gl.uniform3fv(u('uFpAxisY'), unit.axes[1]); gl.uniform3fv(u('uFpAxisZ'), unit.axes[2]);
      gl.uniform4fv(u('uFpProj'), unit.proj); gl.uniform4fv(u('uFpRect'), unit.rect); gl.uniform3fv(u('uFpDepth'), unit.depth);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER), error = gl.getError();
      if (status !== gl.FRAMEBUFFER_COMPLETE || error) throw new Error(`framebuffer ${status} error ${error}`);
      const out = [0, 1, 2].map(k => {
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + k);
        const pixels = new Float32Array(WIDTH * rows * 4);
        gl.readPixels(0, 0, WIDTH, rows, gl.RGBA, gl.FLOAT, pixels);
        return Array.from(new Uint32Array(pixels.buffer, 0, unit.points.length * 4));
      });
      results.push({ label: unit.label, vertex: out[0], view: out[1], clip: Array.from(new Float32Array(new Uint32Array(out[2]).buffer)) });
    }
    return { renderer: gl.getParameter(gl.RENDERER), results };
  }, { vertexSource, fragmentSource, units });
  assert.ok(!runtime.error, runtime.error);
  console.log(`GPU: ${runtime.renderer} (--angle ${angle})`);
  for (const [i, u] of units.entries()) {
    const r = runtime.results[i];
    for (const [k, expected] of u.expected.entries()) {
      const got = r.vertex.slice(4 * k, 4 * k + 4).map(word);
      if (noBarrier) { checked++; mismatched += got.join() !== expected.map(word).join(); continue; }
      assert.deepEqual(got, expected.map(word), `${u.label}: GPU vertex of point ${k} (${JSON.stringify(u.points[k].view)}) ${got.map(f)} vs ${expected.map(f)}`);
      assert.deepEqual(r.view.slice(4 * k, 4 * k + 3).map(word), u.points[k].view.map(word), `${u.label}: GPU view point ${k}`);
      checked++;
      // The clip-space form: perspective division back to the window.
      const [cx, cy, cz, cw] = r.clip.slice(4 * k, 4 * k + 4);
      if (cw >= 1) {
        const flip = u.depth[2], rect = u.rect;
        const nx = cx / cw * flip, ny = cy / cw, nz = cz / cw;
        const sx = (nx + 1) / 2 * rect[0] + rect[2] - 0.5, sy = (1 - ny) / 2 * rect[1] + rect[3] - 0.5, sz = (nz + 1) / 2;
        const dx = Math.abs(sx - f(expected[0])), dy = Math.abs(sy - f(expected[1])), dz = Math.abs(sz - f(expected[2]));
        maxClipPixel = Math.max(maxClipPixel, dx, dy); maxClipDepth = Math.max(maxClipDepth, dz); clipChecked++;
        assert.ok(dx < 2e-3 && dy < 2e-3 && dz < 3e-7, `${u.label}: clip form of point ${k}: ${dx} ${dy} ${dz}`);
      }
    }
  }
} finally {
  await browser.close();
}
if (noBarrier) { console.log(`without the barrier: ${mismatched} of ${checked} vertices differ`); process.exit(0); }
console.log(`${units.length} units, ${checked} GPU vertices equal the original's bit for bit; clip form: ${clipChecked} points, `
  + `largest window error ${maxClipPixel.toExponential(2)} px, depth ${maxClipDepth.toExponential(2)}`);
console.log('validate-frame-projection-gpu: ok');
