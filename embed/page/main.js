/**
 * The DXOnly menu scene: original meshes, textures, placements and rates
 * from assets/ (written by embed/build.mjs). What is original and what is
 * approximated is listed in embed/README.md.
 *
 * ?yaw=<Unreal units> offsets the logo's starting yaw, ?still stops its spin
 * and ?seed=<n> makes the electricity repeatable (the poster uses all three).
 */
import * as THREE from './vendor/three.module.js';

const canvas = document.getElementById('view');
const options = new URLSearchParams(location.search);
const URU = Math.PI * 2 / 65536; // Unreal rotation unit in radians

const json = file => fetch(`assets/${file}`).then(r => {
  if (!r.ok) throw new Error(`${file}: ${r.status}`);
  return r.json();
});
const [scene, logoMesh, textMesh] = await Promise.all([json('scene.json'), json('dxlogo.json'), json('dxtext.json')]);

/** FRand: Math.random, or mulberry32 when ?seed is given. */
const random = (() => {
  if (!options.has('seed')) return Math.random;
  let state = Number(options.get('seed')) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

// The original has no colour management: texels and light values are used as stored.
THREE.ColorManagement.enabled = false;
let renderer;
try {
  renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference: 'low-power'});
} catch (error) {
  document.getElementById('error').hidden = false;
  throw error;
}
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setClearColor(0x000000); // DXOnly's room is lined with BlackMaskTex.

const world = new THREE.Scene();
// Unreal is left-handed and Z-up; three.js is right-handed and Y-up.
// three = (y, z, -x) has determinant -1, so nothing is mirrored.
const unreal = new THREE.Group();
unreal.matrixAutoUpdate = false;
unreal.matrix.set(0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
world.add(unreal);
const toThree = ([x, y, z]) => new THREE.Vector3(y, z, -x);

const loader = new THREE.TextureLoader();
function texture({file}, wrap) {
  const t = loader.load(`assets/${file}`);
  t.flipY = false; // Unreal V runs down the image.
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.anisotropy = 4;
  return t;
}

function geometry(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uvs, 2));
  return g;
}

/** Location, yaw and DrawScale in Unreal space (these actors have no pitch or roll). */
function place(object, {location, rotation, drawScale}) {
  if (rotation[0] || rotation[2]) throw new Error('Only yaw is supported for scene actors');
  object.position.set(...location);
  object.rotation.z = rotation[1] * URU;
  object.scale.setScalar(drawScale);
  unreal.add(object);
  return object;
}

// Display gain over the original's light values: an approximation, set by eye.
const GAIN = 2;

const spark = scene.electricity;
// The map's lights, then the emitter's own (bEmitLight), switched by its flicker.
const lights = [...scene.lights, {location: spark.location, color: [0, 0, 0], worldRadius: spark.lightWorldRadius}];
const lightColors = lights.map(l => new THREE.Vector3(...l.color));
const sparkLight = lightColors.at(-1);

// DXLogo: every face is PF_Environment. The UVs are the recovered DrawGouraudPolygon
// reflection, (1 + R.xy) / 2 in Unreal world axes, per vertex like the original.
const logo = place(new THREE.Mesh(geometry(logoMesh), new THREE.ShaderMaterial({
  defines: {LIGHTS: lights.length},
  uniforms: {
    uEnvironment: {value: texture(scene.logo.texture, THREE.RepeatWrapping)},
    uLightPosition: {value: lights.map(l => new THREE.Vector3(...l.location))},
    uLightColor: {value: lightColors},
    uLightRadius: {value: lights.map(l => l.worldRadius)},
    uGain: {value: GAIN},
  },
  vertexShader: `
    uniform vec3 uLightPosition[LIGHTS];
    uniform vec3 uLightColor[LIGHTS];
    uniform float uLightRadius[LIGHTS];
    varying vec2 vEnvironment;
    varying vec3 vLight;
    vec3 toUnreal(vec3 v) { return vec3(-v.z, v.x, v.y); }
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vec3 p = toUnreal(world.xyz);
      vec3 n = normalize(toUnreal(mat3(modelMatrix) * normal));
      vec3 d = normalize(p - toUnreal(cameraPosition));
      vec3 r = d - 2.0 * dot(d, n) * n;
      vEnvironment = (1.0 + r.xy) * 0.5;
      vec3 light = vec3(0.0);
      for (int i = 0; i < LIGHTS; i++) {
        vec3 l = uLightPosition[i] - p;
        float distance = length(l);
        float falloff = clamp(1.0 - distance / uLightRadius[i], 0.0, 1.0);
        light += uLightColor[i] * falloff * max(dot(n, l / distance), 0.0);
      }
      vLight = light;
      gl_Position = projectionMatrix * viewMatrix * world;
    }`,
  fragmentShader: `
    uniform sampler2D uEnvironment;
    uniform float uGain;
    varying vec2 vEnvironment;
    varying vec3 vLight;
    void main() {
      gl_FragColor = vec4(texture2D(uEnvironment, vEnvironment).rgb * min(vLight * uGain, vec3(1.0)), 1.0);
    }`,
  side: THREE.DoubleSide,
})), scene.logo);

// D3D's PF_Translucent blend: ONE / INVSRCCOLOR.
const translucent = {transparent: true, depthWrite: false, blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcColorFactor};

// DXText: bUnlit, STY_Translucent. Unlit colour is AmbientGlow/256 + ScaleGlow/2 (Render 0x10b0f6d2).
for (const text of scene.texts) {
  const glow = Math.min(1, (text.ambientGlow ?? 0) / 256 + (text.scaleGlow ?? 1) * 0.5) * GAIN;
  place(new THREE.Mesh(geometry(textMesh), new THREE.MeshBasicMaterial({
    map: texture(text.texture, THREE.ClampToEdgeWrapping),
    color: new THREE.Color(glow, glow, glow), side: THREE.DoubleSide, ...translucent,
  })), text).renderOrder = 1;
}

// The player's view from PlayerStart: eye height above it, Pitch/Yaw as placed.
const camera = new THREE.PerspectiveCamera(60, 1, 1, 4000);
const eye = [scene.camera.location[0], scene.camera.location[1], scene.camera.location[2] + scene.camera.eyeHeight];
{
  const [pitch, yaw] = scene.camera.rotation, p = pitch * URU, y = yaw * URU;
  const forward = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)];
  camera.position.copy(toThree(eye));
  camera.up.copy(toThree([-Math.sin(p) * Math.cos(y), -Math.sin(p) * Math.sin(y), Math.cos(p)]));
  camera.lookAt(toThree(eye.map((v, i) => v + forward[i])));
}
// Unreal's FOV is horizontal, at the original 4:3. Keep that vertical extent,
// widening it for narrow screens so "DEUS EX" stays in frame.
const fov = scene.camera.fov * Math.PI / 180;
const verticalFov = 2 * Math.atan(Math.tan(fov / 2) * 3 / 4);
const minimumHorizontalFov = 56 * Math.PI / 180;
function resize() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  const needed = 2 * Math.atan(Math.tan(minimumHorizontalFov / 2) / camera.aspect);
  camera.fov = Math.max(verticalFov, needed) * 180 / Math.PI;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
resize();

// ElectricityEmitter: each tick CalcTrace aims the beam at a random rotation
// (randomAngle 65536 spans every pitch and yaw) and traces it to the room's
// walls (the actors here don't collide). Every flickerTime, bFlicker hides or
// shows the beam and its light with even odds. LaserIterator draws the beam
// as LaserBeam sticks, one per 15 units, placed by the bRandomBeam walk
// (docs/lasers.md). The sticks are drawn as camera-facing strips, and
// Nano_SFX, a Fire.dll procedural texture, is approximated from its palette.
const MAX_SEGMENTS = 128;
const beamPositions = new Float32Array(MAX_SEGMENTS * 12), beamSeeds = new Float32Array(MAX_SEGMENTS * 4);
const beamGeometry = new THREE.BufferGeometry();
beamGeometry.setAttribute('position', new THREE.BufferAttribute(beamPositions, 3).setUsage(THREE.DynamicDrawUsage));
beamGeometry.setAttribute('seed', new THREE.BufferAttribute(beamSeeds, 1).setUsage(THREE.DynamicDrawUsage));
beamGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(MAX_SEGMENTS * 8).map((_, i) => [0, 0, 1, 0, 0, 1, 1, 1][i % 8]), 2));
beamGeometry.setIndex(Array.from({length: MAX_SEGMENTS * 6}, (_, i) => Math.floor(i / 6) * 4 + [0, 1, 2, 2, 1, 3][i % 6]));
const paletteData = new Uint8Array(256 * 4);
for (let i = 0; i < 256; i++) paletteData.set([...spark.palette.slice(i * 3, i * 3 + 3), 255], i * 4);
const palette = new THREE.DataTexture(paletteData, 256, 1);
palette.colorSpace = THREE.NoColorSpace;
palette.magFilter = palette.minFilter = THREE.LinearFilter;
palette.needsUpdate = true;
const beam = new THREE.Mesh(beamGeometry, new THREE.ShaderMaterial({
  uniforms: {uPalette: {value: palette}},
  vertexShader: `
    attribute float seed;
    varying vec2 vUv;
    varying float vSeed;
    void main() {
      vUv = uv;
      vSeed = seed;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D uPalette;
    varying vec2 vUv;
    varying float vSeed;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
      float along = hash(vec2(floor(vUv.x * 6.0), vSeed));
      float heat = clamp(across * (0.7 + 0.5 * along), 0.0, 1.0);
      gl_FragColor = vec4(texture2D(uPalette, vec2(heat, 0.5)).rgb, 1.0);
    }`,
  side: THREE.DoubleSide, ...translucent,
}));
beam.frustumCulled = false;
beam.renderOrder = 2;
unreal.add(beam);

const room = scene.room.bounds;
let flickerClock = 0, sparkVisible = true;
/** A random unit vector: rejection sampling in the unit cube, then UnsafeNormal. */
function randomNormal() {
  for (;;) {
    const v = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1], size = Math.hypot(...v);
    if (size > 1e-4 && size <= 1) return v.map(c => c / size);
  }
}
function writeStick(index, centre, facing) {
  const size = Math.hypot(...facing);
  const axis = size > 1e-6 ? facing.map(c => c / size) : [1, 0, 0];
  const view = centre.map((c, i) => c - eye[i]), distance = Math.hypot(...view);
  let side = [axis[1] * view[2] - axis[2] * view[1], axis[2] * view[0] - axis[0] * view[2], axis[0] * view[1] - axis[1] * view[0]];
  const sideSize = Math.hypot(...side) || 1;
  // The 0.64-unit stick is under a pixel wide here; keep it at about 1.4 px.
  const pixel = 2 * distance * Math.tan(camera.fov * Math.PI / 360) / canvas.clientHeight;
  const half = Math.max(spark.segment.thickness, 1.4 * pixel) / 2, length = spark.segment.length / 2;
  side = side.map(c => c / sideSize * half);
  for (let corner = 0; corner < 4; corner++) {
    const along = corner & 1 ? length : -length, across = corner & 2 ? 1 : -1;
    for (let i = 0; i < 3; i++) beamPositions[index * 12 + corner * 3 + i] = centre[i] + axis[i] * along + side[i] * across;
  }
  beamSeeds.fill(random() * 100, index * 4, index * 4 + 4);
}
function updateSpark(dt) {
  if (spark.bFlicker) {
    flickerClock += dt;
    if (flickerClock >= spark.flickerTime) {
      flickerClock = 0;
      sparkVisible = random() >= 0.5;
    }
  }
  beam.visible = sparkVisible;
  sparkLight.set(...(sparkVisible ? spark.lightColor : [0, 0, 0]));
  if (!sparkVisible) return;
  const turn = () => Math.trunc((0.5 - random()) * spark.randomAngle);
  const p = (spark.rotation[0] + turn()) * URU, y = (spark.rotation[1] + turn()) * URU;
  const direction = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)];
  let length = Infinity;
  for (let i = 0; i < 3; i++) {
    if (direction[i]) length = Math.min(length, ((direction[i] > 0 ? room[i][1] : room[i][0]) - spark.location[i]) / direction[i]);
  }
  // AddBeam stores the beam 8 units forward, with len/15 + 1 segments; the
  // iterator draws one more at the end.
  const start = spark.location.map((v, i) => v + direction[i] * 8);
  const segments = Math.min(MAX_SEGMENTS - 1, Math.trunc(length / 15) + 1);
  let previousRandom = [0, 0, 0], previous = start;
  for (let index = 0; index <= segments; index++) {
    const alpha = index / segments, normal = randomNormal();
    const position = start.map((v, i) => v + direction[i] * length * alpha + normal[i] + previousRandom[i]);
    const next = position.map((v, i) => 2 * v - previous[i]);
    writeStick(index, position, previous.map((v, i) => v - next[i]));
    previous = next;
    previousRandom = normal;
  }
  beamGeometry.setDrawRange(0, (segments + 1) * 6);
  beamGeometry.attributes.position.needsUpdate = true;
  beamGeometry.attributes.seed.needsUpdate = true;
}

// PHYS_Rotating with bFixedRotationDir: Rotation += RotationRate each second.
// Dragging takes over the yaw; on release the spin eases back to that rate.
logo.rotation.z += Number(options.get('yaw') ?? 0) * URU;
const rate = options.has('still') ? 0 : scene.logo.rotationRate[1] * URU;
let spin = rate, dragging = false, lastX = 0, lastTime = 0;
canvas.addEventListener('pointerdown', event => {
  dragging = true; lastX = event.clientX; lastTime = event.timeStamp;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', event => {
  if (!dragging) return;
  const dx = event.clientX - lastX, dt = Math.max(1, event.timeStamp - lastTime) / 1000;
  const turn = -dx / canvas.clientWidth * Math.PI * 1.5; // positive yaw turns the front to the left
  logo.rotation.z += turn;
  spin = THREE.MathUtils.lerp(spin, turn / dt, 0.5);
  lastX = event.clientX; lastTime = event.timeStamp;
});
const release = event => {
  if (!dragging) return;
  dragging = false;
  if (event.timeStamp - lastTime > 120) spin = 0; // held still before letting go
  canvas.releasePointerCapture?.(event.pointerId);
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

let sparkFrozen = false, previousTime = null;
renderer.setAnimationLoop(time => {
  const dt = previousTime === null ? 0 : Math.min((time - previousTime) / 1000, 0.1);
  previousTime = time;
  if (!dragging) {
    spin += (rate - spin) * (1 - Math.exp(-dt * 1.5));
    logo.rotation.z += spin * dt;
  }
  if (!sparkFrozen) {
    updateSpark(dt);
    sparkFrozen = options.has('still');
  }
  renderer.render(world, camera);
});
