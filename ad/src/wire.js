// Wireframe of the original Training BSP, from the project's own diagnostic
// export (scripts/export-map.mjs -> reports/00_Training/world.obj; Unreal
// units, Z up). Feature edges only, depth-faded, with a sweeping build-up plane.
import * as THREE from 'three';

// Same axis mapping as the viewer (src/unreal/geometry.mjs toView).
const toView = (x, y, z) => [y, z, -x];

const vertexShader = `
  uniform float uScan;
  varying float vDepth;
  varying float vScan;
  varying float vHeight;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    vScan = uScan - (-position.z);   // distance behind the sweep along Unreal X
    vHeight = position.y;
    gl_Position = projectionMatrix * mv;
  }`;
const fragmentShader = `
  uniform vec3 uGold;
  uniform vec3 uIce;
  uniform float uOpacity;
  uniform float uNear;
  uniform float uFar;
  varying float vDepth;
  varying float vScan;
  varying float vHeight;
  void main() {
    if (vScan < 0.0) discard;
    float fade = 1.0 - smoothstep(uNear, uFar, vDepth);
    float edge = exp(-vScan / 260.0);
    vec3 base = mix(uIce, uGold, clamp((vHeight + 150.0) / 500.0, 0.0, 1.0));
    vec3 color = base * (0.55 + 0.45 * fade) + vec3(1.0, 0.93, 0.8) * edge * 1.6;
    gl_FragColor = vec4(color, (0.10 + 0.9 * fade) * uOpacity + edge * 0.8);
  }`;

export async function createWire(url, width, height) {
  const text = await (await fetch(url)).text();
  const positions = [], unrealY = [], index = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.trim().split(/\s+/).map(Number);
      positions.push(...toView(x, y, z));
      unrealY.push(y);
    } else if (line.startsWith('f ')) {
      const ids = line.trim().split(/\s+/).slice(1).map(token => parseInt(token, 10) - 1);
      // Leave out the separate sky-zone box (SkyZoneInfo1 sits near Y=5795).
      if (ids.some(id => unrealY[id] > 3500)) continue;
      for (let i = 1; i + 1 < ids.length; i++) index.push(ids[0], ids[i], ids[i + 1]);
    }
  }
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  mesh.setIndex(index);
  const edges = new THREE.EdgesGeometry(mesh, 28);
  const uniforms = {
    uScan: {value: 1e6}, uOpacity: {value: 1}, uNear: {value: 800}, uFar: {value: 9000},
    uGold: {value: new THREE.Color('#e4bd7c')}, uIce: {value: new THREE.Color('#73accb')},
  };
  const material = new THREE.ShaderMaterial({uniforms, vertexShader, fragmentShader, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending});
  const scene = new THREE.Scene();
  scene.add(new THREE.LineSegments(edges, material));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, preserveDrawingBuffer: true});
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  const camera = new THREE.PerspectiveCamera(50, width / height, 10, 60000);
  return {
    canvas,
    edges: edges.attributes.position.count / 2,
    // eye/target in Unreal coordinates; scan = Unreal X of the build-up plane.
    render({eye, target, fov = 50, scan = 1e6, opacity = 1, near = 800, far = 9000}) {
      camera.position.set(...toView(...eye));
      camera.up.set(0, 1, 0);
      camera.lookAt(...toView(...target));
      camera.fov = fov;
      camera.updateProjectionMatrix();
      uniforms.uScan.value = scan;
      uniforms.uOpacity.value = opacity;
      uniforms.uNear.value = near;
      uniforms.uFar.value = far;
      renderer.clear();
      renderer.render(scene, camera);
      return canvas;
    },
  };
}
