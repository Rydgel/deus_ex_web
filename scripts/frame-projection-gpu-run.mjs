/** The GLSL vertex chain (src/viewer/frame-projection-glsl.mjs) run on the GPU in
 * headless Chromium (docs/frame-projection.md): shared by
 * validate-frame-projection-gpu.mjs and validate-decal-render.mjs.
 *
 * A unit is one frame's uniforms and the points it projects: `{label, origin,
 * axes, proj, rect, depth, prj?, points: [{mode, world, view}]}`. `mode` 0: a
 * world point (Unreal axes) through fpView and fpVertex; 1: a view-space point
 * given as binary32 words in `view`, through fpVertex; 2: a world point through
 * fpView and fpVertexDecal (ClipDecal's clamp; `prj` the frame's PrjXM..PrjYP).
 * Returns the vertex, the view point and the clip form of each point as words
 * (vertex, view) and floats (clip). */
import { chromium } from '@playwright/test';
import { frameProjectionGlsl } from '../src/viewer/frame-projection-glsl.mjs';
import { SPRITE_TILE_GLSL } from '../src/viewer/sprite-tile-glsl.mjs';

const vertexSource = '#version 300 es\nprecision highp float;\nvoid main(){vec2 p=vec2(float((gl_VertexID&1)<<2)-1.0,float((gl_VertexID&2)<<1)-1.0);gl_Position=vec4(p,0.0,1.0);}';

/** `noBarrier`: the mutation check. Without B() the compiler may fuse and
 * reassociate; the run then reports how many vertices differ instead of failing. */
export function fragmentSource({ noBarrier = false } = {}) {
  let source = `#version 300 es
precision highp float;precision highp int;precision highp sampler2D;
uniform sampler2D uPoints;uniform int uMode;
${frameProjectionGlsl()}
layout(location=0) out vec4 oVertex;layout(location=1) out vec4 oView;layout(location=2) out vec4 oClip;
void main(){
  vec4 q=texelFetch(uPoints,ivec2(gl_FragCoord.xy),0);
  vec3 v=(q.w>0.5&&q.w<1.5)?q.xyz:fpView(q.xyz);
  oView=vec4(v,0.0);
  if(q.w>1.5){oVertex=fpVertexDecal(v);oClip=fpClipDecal(v);}
  else{oVertex=fpVertex(v);oClip=fpClip(v);}}`;
  if (noBarrier) source = source.replace('float B(float x){return uintBitsToFloat(floatBitsToUint(x)^uFpZero);}', 'float B(float x){return x;}');
  return source;
}

export async function runGpuUnits(units, { angle, noBarrier = false } = {}) {
  const browser = await chromium.launch({ args: [`--use-angle=${angle}`] });
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
    const fragment = fragmentSource({ noBarrier });
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
      unit.points.forEach((p, i) => { const src = p.mode === 1 ? p.view : p.world; data.set(src.map(x => x), i * 4); data[i * 4 + 3] = p.mode ?? 0; });
      if (unit.points.some(p => p.mode === 1)) {
        // View-space inputs arrive as words: reinterpret.
        const words = new Uint32Array(data.buffer);
        unit.points.forEach((p, i) => { if (p.mode === 1) { words[i * 4] = p.view[0]; words[i * 4 + 1] = p.view[1]; words[i * 4 + 2] = p.view[2]; } });
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
      gl.uniform4fv(u('uFpPrj'), unit.prj ?? [0, 0, 0, 0]);
      gl.uniform4fv(u('uFpProj'), unit.proj); gl.uniform4fv(u('uFpRect'), unit.rect); gl.uniform4fv(u('uFpView'), [unit.rect[0], unit.rect[1], unit.rect[2], unit.rect[3]]); gl.uniform3fv(u('uFpDepth'), unit.depth);
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
  }, { vertexSource, fragmentSource: fragment, units });
    if (runtime.error) throw new Error(runtime.error);
    return runtime;
  } finally {
    await browser.close();
  }
}

/** The sprite tile chain (src/viewer/sprite-tile-glsl.mjs) on the GPU: each unit is one sprite
 * in one frame, `{a: [Z, ScreenX, ScreenY, Persp], b: [USize, VSize, DrawScale, Scale], c:
 * [Info.USize, Info.VSize], fxy: [FX, FY], frameRect: [X, Y, XB, YB], depth: [_33, _43]}`.
 * Returns per unit `{kept, rect, src, vertices: [{xyzw: [X, Y, depth, RHW], uv: [u, v]}]}` as
 * binary32 words (the rectangle after the clip and the source rectangle after the scale
 * too). `noBarrier`: the mutation check, as runGpuUnits. */
export async function runGpuSprites(units, { angle, noBarrier = false } = {}) {
  let fragment = `#version 300 es
precision highp float;precision highp int;precision highp sampler2D;
uniform sampler2D uData;
${frameProjectionGlsl()}
${SPRITE_TILE_GLSL}
layout(location=0) out vec4 oVertex;layout(location=1) out vec4 oUv;layout(location=2) out vec4 oRect;layout(location=3) out vec4 oSrc;
void main(){
  int sprite=int(gl_FragCoord.y),corner=int(gl_FragCoord.x);
  vec4 a=texelFetch(uData,ivec2(0,sprite),0),b=texelFetch(uData,ivec2(1,sprite),0),c=texelFetch(uData,ivec2(2,sprite),0),
    frameRect=texelFetch(uData,ivec2(3,sprite),0),d=texelFetch(uData,ivec2(4,sprite),0);
  vec4 rect,src;
  bool kept=fpSpriteTile(a,b,c,c.zw,rect,src);
  vec2 uv=vec2(0.0);
  vec4 vertex=kept?fpSpriteVertex(rect,src,a,b,c,frameRect,d.xy,corner,uv):vec4(0.0);
  oVertex=vertex;oUv=vec4(uv,kept?1.0:0.0,0.0);oRect=rect;oSrc=src;}`;
  if (noBarrier) fragment = fragment.replace('float B(float x){return uintBitsToFloat(floatBitsToUint(x)^uFpZero);}', 'float B(float x){return x;}');
  const browser = await chromium.launch({ args: [`--use-angle=${angle}`] });
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
      const n = units.length, data = new Float32Array(5 * n * 4);
      units.forEach((u, i) => {
        data.set(u.a, 20 * i); data.set(u.b, 20 * i + 4); data.set([...u.c, ...u.fxy], 20 * i + 8);
        data.set(u.frameRect, 20 * i + 12); data.set(u.depth, 20 * i + 16);
      });
      const input = gl.createTexture(), fb = gl.createFramebuffer();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 5, n, 0, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.activeTexture(gl.TEXTURE1);
      const targets = [0, 1, 2, 3].map(k => {
        const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, n, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0);
        return t;
      });
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input);
      gl.drawBuffers([0, 1, 2, 3].map(k => gl.COLOR_ATTACHMENT0 + k));
      gl.viewport(0, 0, 4, n);
      gl.uniform1i(gl.getUniformLocation(program, 'uData'), 0);
      gl.uniform1ui(gl.getUniformLocation(program, 'uFpZero'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER), error = gl.getError();
      if (status !== gl.FRAMEBUFFER_COMPLETE || error) throw new Error(`framebuffer ${status} error ${error}`);
      const out = [0, 1, 2, 3].map(k => {
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + k);
        const pixels = new Float32Array(4 * n * 4);
        gl.readPixels(0, 0, 4, n, gl.RGBA, gl.FLOAT, pixels);
        return new Uint32Array(pixels.buffer);
      });
      const results = [];
      for (let i = 0; i < n; i++) {
        const kept = out[1][16 * i + 2] === 0x3f800000;
        results.push({ kept, rect: Array.from(out[2].subarray(16 * i, 16 * i + 4)), src: Array.from(out[3].subarray(16 * i, 16 * i + 4)),
          vertices: [0, 1, 2, 3].map(c => ({ xyzw: Array.from(out[0].subarray(16 * i + 4 * c, 16 * i + 4 * c + 4)),
            uv: Array.from(out[1].subarray(16 * i + 4 * c, 16 * i + 4 * c + 2)) })) });
      }
      return { renderer: gl.getParameter(gl.RENDERER), results };
    }, { vertexSource, fragmentSource: fragment, units });
    if (runtime.error) throw new Error(runtime.error);
    return runtime;
  } finally {
    await browser.close();
  }
}
