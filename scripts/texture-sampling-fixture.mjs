/** The browser side of scripts/validate-texture-sampling.mjs: the original renderer's texture
 * sampling state (src/viewer/original-sampling.mjs, docs/texture-sampling.md) on synthetic
 * textures, with no original assets.
 *
 * A texture of 512 x 512 whose mip level k is the solid colour palette[k] is drawn on a
 * pixel-aligned quad whose size S gives 512 / S texels per pixel, so the level-of-detail is
 * lambda = log2(512 / S) + bias. The device picks a level (MIPFILTER POINT) after the bias
 * (-0.5), GL's rule for LINEAR_MIPMAP_NEAREST: d = ceil(lambda + 1/2) - 1 (lambda above 1/2).
 * Cases sit a quarter of a level away from the ties. The pixel at the quad's centre is one of
 * the palette's colours only when no two levels are blended; its index is the level drawn. */
import * as THREE from 'three';
import {LightAtlas, applyLightAtlas} from '../src/viewer/light-atlas.mjs';
import {batchWorldMeshes} from '../src/viewer/world-batches.mjs';
import {configureSampler, D3D_LOD_BIAS} from '../src/viewer/original-sampling.mjs';

const SIZE = 512, LEVELS = 10;
const palette = j => Array.from({length: LEVELS}, (_, k) => [(k * 23 + j * 97 + 10) % 256, (255 - k * 19 + j * 31) % 256, (k * 47 + j * 13) % 256]);

function mippedTexture(colors, colorSpace) {
  const mipmaps = colors.map((rgb, k) => {
    const size = SIZE >> k, data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) data.set([...rgb, 255], i * 4);
    return {data, width: size, height: size};
  });
  const texture = new THREE.DataTexture(mipmaps[0].data, SIZE, SIZE, THREE.RGBAFormat);
  texture.mipmaps = mipmaps; texture.generateMipmaps = false; texture.flipY = false;
  texture.colorSpace = colorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

export async function runTextureSamplingFixture() {
  const WIDTH = 1024, HEIGHT = 400;
  const renderer = new THREE.WebGLRenderer({antialias: false});
  renderer.setSize(WIDTH, HEIGHT); renderer.autoClear = false;
  const target = new THREE.WebGLRenderTarget(WIDTH, HEIGHT);
  const camera = new THREE.OrthographicCamera(0, WIDTH, HEIGHT, 0, -10, 10);
  const centres = [160, 512, 864];
  const read = () => { const pixels = new Uint8Array(WIDTH * HEIGHT * 4); renderer.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, pixels); return pixels; };
  const draw = scene => { renderer.setRenderTarget(target); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, camera); return read(); };
  const pixel = (pixels, x, y = HEIGHT / 2) => Array.from(pixels.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3));
  const nearest = (rgb, colors) => {
    let best = -1, distance = Infinity;
    colors.forEach((c, k) => { const d = Math.abs(c[0] - rgb[0]) + Math.abs(c[1] - rgb[1]) + Math.abs(c[2] - rgb[2]); if (d < distance) { distance = d; best = k; } });
    return {level: best, distance};
  };

  // One scene of three quads (three textures) of size S: plain MeshBasicMaterials, or the world's
  // light-atlas materials unbatched or batched (the batch's shader samples through deusMap0..2).
  const make = (kind, S) => {
    const scene = new THREE.Scene(), root = new THREE.Group(), atlas = new LightAtlas(16), textures = [];
    scene.add(root);
    const lightmap = {width: 4, height: 4, pixels: new Float32Array(48).fill(.5), uv: () => [.5, .5]};
    const tile = atlas.add(lightmap);
    centres.forEach((cx, j) => {
      // The world's textures are sRGB; the light-atlas hook re-encodes, so the colours round trip.
      const texture = mippedTexture(palette(j), kind === 'plain' ? THREE.NoColorSpace : THREE.SRGBColorSpace);
      configureSampler(texture, false); textures.push(texture);
      const geometry = new THREE.PlaneGeometry(S, S).toNonIndexed();
      geometry.translate(cx, HEIGHT / 2, 0);
      const count = geometry.attributes.position.count, uv = [], bounds = [], layers = [];
      // lightUV.z 0: unlit, so the light map does not modulate (an unlit surface).
      for (let i = 0; i < count; i++) { uv.push(0, 0, 0); bounds.push(...tile.bounds); layers.push(tile.page.index); }
      geometry.setAttribute('lightUV', new THREE.Float32BufferAttribute(uv, 3));
      geometry.setAttribute('lightBounds', new THREE.Float32BufferAttribute(bounds, 4));
      geometry.setAttribute('lightLayer', new THREE.Float32BufferAttribute(layers, 1));
      const material = new THREE.MeshBasicMaterial({map: texture});
      material.userData = {flags: 0, key: `sampling${j}`};
      if (kind !== 'plain') applyLightAtlas(material, tile.page, {value: 1}, {value: 1});
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = {actor: null, faces: [0, 1]};
      root.add(mesh);
    });
    const stats = kind === 'batched' ? batchWorldMeshes(root, atlas, {value: 1}, {value: 1}) : null;
    return {scene, stats, dispose() { root.traverse(object => object.geometry?.dispose()); textures.forEach(t => t.dispose()); atlas.dispose(); }};
  };

  const rows = [];
  for (const kind of ['plain', 'world', 'batched']) {
    for (let k = 0; k <= 6; k++) for (const fraction of [0.25, 0.75]) {
      const lambda = k + fraction, rho = 2 ** (lambda - D3D_LOD_BIAS), S = SIZE / rho;
      const expected = fraction < 0.5 ? k : k + 1;
      const scene = make(kind, S), pixels = draw(scene.scene);
      const levels = centres.map((cx, j) => nearest(pixel(pixels, cx), palette(j)));
      // Without a bias the same S would pick level round(lambda - bias) ... it is the unbiased rho that the old trilinear drew.
      rows.push({kind, lambda, size: +S.toFixed(3), expected, levels: levels.map(l => l.level), distances: levels.map(l => l.distance), batches: scene.stats?.batches ?? 0});
      scene.dispose();
    }
  }
  // PF_NoSmooth: POINT magnification (and minification). A 2 x 2 texture on a 64-pixel quad: the pixel on each
  // side of the centre line is exactly one texel's colour; with LINEAR magnification it would be a blend.
  const noSmooth = [];
  for (const smooth of [true, false]) {
    const colors = [[200, 30, 30], [30, 200, 30], [30, 30, 200], [200, 200, 30]];
    const data = new Uint8Array(16); colors.forEach((c, i) => data.set([...c, 255], i * 4));
    const texture = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
    texture.mipmaps = [{data, width: 2, height: 2}, {data: new Uint8Array([100, 100, 100, 255]), width: 1, height: 1}];
    texture.generateMipmaps = false; texture.flipY = false; texture.colorSpace = THREE.NoColorSpace; texture.needsUpdate = true;
    configureSampler(texture, !smooth);
    const scene = new THREE.Scene(), geometry = new THREE.PlaneGeometry(64, 64);
    geometry.translate(512, HEIGHT / 2, 0);
    scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({map: texture})));
    const pixels = draw(scene);
    noSmooth.push({noSmooth: !smooth, left: pixel(pixels, 511), right: pixel(pixels, 512), magFilter: texture.magFilter, minFilter: texture.minFilter});
    texture.dispose();
  }
  return {rows, noSmooth, bias: D3D_LOD_BIAS, filters: {linear: THREE.LinearFilter, nearest: THREE.NearestFilter, linearMipmapNearest: THREE.LinearMipmapNearestFilter, nearestMipmapNearest: THREE.NearestMipmapNearestFilter},
    errors: renderer.getContext().getError()};
}
