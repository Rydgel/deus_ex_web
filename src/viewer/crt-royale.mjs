import * as THREE from 'three';
import { passes, masks } from './shaders/royale/preset.mjs';

let texturesPromise;
export function prepareRoyale() {
  return texturesPromise ??= Promise.all(masks.map(async mask => {
    const texture = await new THREE.TextureLoader().loadAsync(mask.url);
    texture.colorSpace = THREE.NoColorSpace; texture.flipY = false;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = mask.mipmap;
    texture.minFilter = mask.mipmap ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return [mask.name, texture];
  })).catch(error => { texturesPromise = null; throw error; });
}

const parameters = {
  crt_gamma: 2.5, lcd_gamma: 2.2, levels_contrast: 1,
  halation_weight: 0, diffusion_weight: 0.075, bloom_underestimate_levels: 0.8, bloom_excess: 0,
  beam_min_sigma: 0.02, beam_max_sigma: 0.3, beam_spot_power: 0.33,
  beam_min_shape: 2, beam_max_shape: 4, beam_shape_power: 0.25,
  beam_horiz_filter: 0, beam_horiz_sigma: 0.35, beam_horiz_linear_rgb_weight: 1,
  convergence_offset_x_r: 0, convergence_offset_y_r: 0,
  convergence_offset_x_g: 0, convergence_offset_y_g: 0,
  convergence_offset_x_b: 0, convergence_offset_y_b: 0,
  mask_type: 1, mask_sample_mode_desired: 0, mask_specify_num_triads: 0,
  mask_triad_size_desired: 3, mask_num_triads_desired: 480,
  aa_subpixel_r_offset_x_runtime: -1 / 3, aa_subpixel_r_offset_y_runtime: 0,
  aa_cubic_c: 0.5, aa_gauss_sigma: 0.5,
  geom_mode_runtime: 0, geom_radius: 2, geom_view_dist: 2,
  geom_tilt_angle_x: 0, geom_tilt_angle_y: 0,
  geom_aspect_ratio_x: 4 / 3, geom_aspect_ratio_y: 1, geom_overscan_x: 1, geom_overscan_y: 1,
  border_size: 1e-7, border_darkness: 2, border_compress: 2.5, interlace_bff: 0, interlace_1080i: 0,
};

function shader(source, stage) {
  let depth = 0, continuedMacro = false;
  // Desktop GLSL permits local const initializers that depend on uniforms;
  // GLSL ES does not. Retain actual global constants and parameter qualifiers.
  source = source.replace(/^#define const\s*$/gm, '')
    .split('\n').map(line => {
      const macro = continuedMacro || /^\s*#define\b/.test(line);
      continuedMacro = macro && line.endsWith('\\');
      return macro ? line.replace(/\bconst\b/g, '') : line;
    }).join('\n')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|[{}]|\bconst\b/g, token => {
    if (token === '{') depth++;
    if (token === '}') depth--;
    return token === 'const' && depth > 0 ? '' : token;
  });
  return `precision highp float; precision highp int;\n#define ${stage}\n#define PARAMETER_UNIFORM\n` + source
    .replace(/^#version.*$/gm, '')
    .replace(/^#pragma.*$/gm, '')
    .replace(/#define COMPAT_PRECISION mediump/g, '#define COMPAT_PRECISION highp')
    .replace(/(?:COMPAT_PRECISION )?float bloom_approx_scale_x = ([^;]+);/g, '#define bloom_approx_scale_x ($1)')
    .replace(/, texel_off\)/g, ', float(texel_off))')
    .replace(/int FrameCount/g, 'float FrameCount')
    .replace(/input_tiles_per_texture_r, samples,/g, 'input_tiles_per_texture_r, float(samples),')
    .replace(/\bi \* uv_offset_step_y/g, 'float(i) * uv_offset_step_y')
    .replace(/\bj \* uv_offset_step_x/g, 'float(j) * uv_offset_step_x')
    // This host supplies progressive frames. The upstream default detects
    // a 480-line raster as interlaced, which is not our input.
    .replace(/\binterlace_detect = true;/g, 'interlace_detect = false;');
}

export function createRoyale(geometry, textures) {
  // Match the preset's sRGB framebuffers (linear mask passes 5 and 6).
  // WebGL2 stores sRGB and decodes samples in hardware, so interpolation
  // stays linear. The last shader applies the selected LCD gamma.
  const targets = passes.slice(0, -1).map((pass, i) => new THREE.WebGLRenderTarget(1, 1, {
    colorSpace: i === 5 || i === 6 ? THREE.NoColorSpace : THREE.SRGBColorSpace,
    depthBuffer: false, stencilBuffer: false,
    minFilter: passes[i + 1].linear ? THREE.LinearFilter : THREE.NearestFilter,
    magFilter: passes[i + 1].linear ? THREE.LinearFilter : THREE.NearestFilter,
  }));
  const quad = geometry.clone();
  quad.setAttribute('VertexCoord', quad.getAttribute('position'));
  quad.setAttribute('TexCoord', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const materials = passes.map(pass => {
    const values = { ...parameters, ...Object.fromEntries(textures), MVPMatrix: new THREE.Matrix4(),
      FrameDirection: 1, FrameCount: 0, Texture: null, InputSize: new THREE.Vector2(),
      TextureSize: new THREE.Vector2(), OutputSize: new THREE.Vector2() };
    // Includes aliases and PassPrevN sizes declared by each upstream pass.
    for (const match of pass.source.matchAll(/\buniform\s+(?:COMPAT_PRECISION\s+)?(vec2|sampler2D)\s+(\w+)\s*;/g)) {
      if (!(match[2] in values)) values[match[2]] = match[1] === 'vec2' ? new THREE.Vector2(1, 1) : null;
    }
    // Several exported declarations are renamed by preprocessor macros.
    // Supply uniforms under the names the WebGL program actually exposes.
    for (const [, alias, binding] of pass.source.matchAll(/^#define (\w+) (PassPrev\d+\w+)/gm)) {
      if (alias in values) values[binding] = values[alias] instanceof THREE.Vector2 ? new THREE.Vector2(1, 1) : null;
    }
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
      uniforms: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }])),
      vertexShader: shader(pass.source, 'VERTEX'),
      fragmentShader: shader(pass.source, 'FRAGMENT'),
    });
  });
  const scene = new THREE.Scene(), camera = new THREE.Camera(), mesh = new THREE.Mesh(quad, materials[0]);
  mesh.frustumCulled = false; scene.add(mesh); scene.matrixAutoUpdate = false;
  let frame = 0;
  return {
    apply(renderer, texture, width, height, outputWidth, outputHeight) {
      const records = [], aliases = new Map();
      let input = { texture, width, height };
      for (let i = 0; i < passes.length; i++) {
        const pass = passes[i], uniforms = materials[i].uniforms;
        const dimension = (axis, source, viewport) => Math.max(1, Math.round(axis.scale * (axis.type === 'absolute' ? 1 : axis.type === 'viewport' ? viewport : source)));
        const w = dimension(pass.x, input.width, outputWidth), h = dimension(pass.y, input.height, outputHeight);
        const target = targets[i] ?? null;
        if (target) target.setSize(w, h);
        uniforms.Texture.value = input.texture;
        uniforms.TextureSize.value.set(input.width, input.height); uniforms.InputSize.value.set(input.width, input.height);
        uniforms.OutputSize.value.set(w, h); uniforms.FrameCount.value = frame;
        uniforms.geom_aspect_ratio_x.value = outputWidth / outputHeight;
        const bind = (prefix, record, alias) => {
          for (const [suffix, value] of alias ? [['texture', record.texture], ['texture_size', [record.width, record.height]], ['video_size', [record.width, record.height]]]
            : [['Texture', record.texture], ['TextureSize', [record.width, record.height]], ['InputSize', [record.width, record.height]]]) {
            const uniform = uniforms[prefix + suffix];
            if (uniform) { if (Array.isArray(value)) uniform.value.set(...value); else uniform.value = value; }
          }
        };
        for (const [alias, record] of aliases) bind(alias, record, true);
        for (let previous = 0; previous < i; previous++) bind(`PassPrev${i - previous}`, records[previous], false);
        mesh.material = materials[i]; renderer.setRenderTarget(target); renderer.render(scene, camera);
        input = { texture: target?.texture, width: w, height: h }; records.push(input);
        if (pass.alias) aliases.set(pass.alias, input);
      }
      frame++;
    },
    dispose() { targets.forEach(target => target.dispose()); materials.forEach(material => material.dispose()); quad.dispose(); },
  };
}
