/**
 * Static X (Twitter) player-card page: the DXOnly menu logo scene in WebGL.
 *
 * Reads the installed game through the project's package readers and writes
 * embed/out/ (ignored by Git: it holds original assets). See embed/README.md.
 *
 *   node embed/build.mjs [--url https://host/path/] [--poster]
 *
 * --url     absolute base URL the site will be served from; the card's
 *           twitter:player and twitter:image must be absolute HTTPS URLs.
 *           Implies --poster.
 * --poster  render out/card.png (the card's still image) with Playwright.
 */
import {cp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';
import {gameDirectory} from '../scripts/game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ClassDefaults} from '../src/unreal/classes.mjs';
import {nameAt, objectAt, readObject} from '../src/unreal/objects.mjs';
import {TextureStore} from '../src/unreal/textures.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {constructMesh, serializeMesh, reallocateMeshArray} from '../src/runtime/script-mesh-load.mjs';
import {decodeLodMeshPayload, meshPayloadView, readLodMeshFrame} from '../src/runtime/lodmesh-payload.mjs';
import {meshVertexNormalsInto} from '../src/runtime/mesh-environment.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, 'out');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] ?? ''; };
const baseUrl = option('--url')?.replace(/\/?$/, '/') ?? null;
if (baseUrl !== null && !/^https:\/\/[^/]+\//.test(baseUrl)) throw new Error('--url must be an absolute https:// URL');

process.chdir(root);
const game = gameDirectory();
const files = [];
for (const dir of ['System', 'Textures', 'Maps']) {
  for (const name of await readdir(path.join(game, dir))) {
    if (/\.(u|utx|dx)$/i.test(name)) files.push({path: `${dir}/${name}`, read: () => readFile(path.join(game, dir, name))});
  }
}
const assets = new AssetStore(files), textures = new TextureStore(assets), classes = new ClassDefaults(assets);

/** Classic UMesh (the logo meshes are MLOD=0 imports): the shared native
 * serializer with the same detached services decodeLodMeshPayload uses. */
function decodeClassicMesh(asset, exportIndex) {
  const {pkg, bytes} = asset;
  const {entry, reader: r} = readObject(pkg, bytes, exportIndex);
  if (entry.className !== 'Mesh') throw new Error(`Expected a classic Mesh, found ${entry.className}`);
  const prefix = r.offset, object = {values: new Map()};
  for (let offset = 0x28; offset < 0x130; offset += 4) object.values.set(offset, 0);
  r.seek(0);
  const archive = {ar04: pkg.version, ar0c: 1, ar10: 0,
    tell: () => entry.serialOffset + r.offset, seek: position => r.seek(position - entry.serialOffset),
    readRaw: size => r.take(size), readU32: () => r.u32(), readCompact: () => r.compact(), countBytes() {},
    readName() { const index = r.compact(); return {index, name: index, text: nameAt(pkg, index)}; },
    readObject() { const index = r.compact(); objectAt(pkg, index); return {index, object: index}; }};
  const services = {
    read: (o, offset) => o.values.get(offset),
    write: (o, offset, value, type) => o.values.set(offset,
      type === 'u8' ? ((o.values.get(offset) ?? 0) & 0xffffff00) | (value & 255) : value),
    objectConstructor() {}, objectSerialize: () => r.seek(prefix), arrayRealloc: reallocateMeshArray,
    attach: (ar, loader) => { loader.archive = ar; loader.savedPosition = ar.tell(); },
    getLazyLoad: () => 0, referenceToken: ref => ref >>> 0,
  };
  constructMesh(object, services);
  serializeMesh(object, archive, services);
  if (r.offset !== r.bytes.length) throw new Error(`${entry.path}: ${r.bytes.length - r.offset} unconsumed bytes`);
  return meshPayloadView(object, services, {entry, archive, classic: true});
}

/** Frame 0 in mesh units (raw int16 × Mesh.Scale), unwelded per triangle
 * corner because classic meshes store UVs on the triangle. FMeshTri is
 * iVertex[3] u16, Tex[3] (u8 U, u8 V), PolyFlags u32, TextureIndex u32. */
function exportMesh(mesh) {
  if (mesh.origin.some(Boolean) || mesh.rotation.some(Boolean)) throw new Error('Mesh Origin/RotOrigin are not handled');
  const raw = readLodMeshFrame(mesh, 0), count = mesh.frameVertexCount;
  const points = new Float32Array(count * 3);
  for (let i = 0; i < raw.length; i++) points[i] = raw[i] * mesh.scale[i % 3];
  const tris = mesh.arrays.get(0x78), view = new DataView(tris.data.buffer, tris.data.byteOffset, tris.data.byteLength);
  const indices = [], uvs = [], polyFlags = new Set();
  for (let t = 0; t < tris.num; t++) {
    const at = t * 20;
    for (let k = 0; k < 3; k++) {
      indices.push(view.getUint16(at + k * 2, true));
      uvs.push(view.getUint8(at + 6 + k * 2) / 256, view.getUint8(at + 7 + k * 2) / 256);
    }
    polyFlags.add(view.getUint32(at + 12, true));
  }
  if (polyFlags.size !== 1) throw new Error('Mixed mesh PolyFlags are not handled');
  // Render.dll's summed, FastInvSqrt-normalized face cross products.
  const normals = meshVertexNormalsInto(points, indices, new Float32Array(points.length));
  // The original cross-product order gives inward normals for this winding;
  // reflection ignores the sign, the page's N·L lighting needs outward.
  const centre = [0, 1, 2].map(axis => points.filter((_, i) => i % 3 === axis).reduce((a, b) => a + b) / count);
  let outward = 0;
  for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) outward += normals[i * 3 + a] * (points[i * 3 + a] - centre[a]);
  const sign = outward < 0 ? -1 : 1;
  const round = v => Math.round(v * 1e4) / 1e4;
  return {
    polyFlags: [...polyFlags][0],
    positions: indices.flatMap(i => [...points.subarray(i * 3, i * 3 + 3)].map(round)),
    normals: indices.flatMap(i => [...normals.subarray(i * 3, i * 3 + 3)].map(v => round(v * sign))),
    uvs: uvs.map(round),
  };
}

function png(width, height, rgba) {
  const table = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function writeTexture(asset, ref, file) {
  const texture = await textures.get(asset, ref), mip = texture.mips[0];
  await writeFile(path.join(out, 'assets', file), png(mip.width, mip.height, mip.data));
  return {file, key: texture.key, width: mip.width, height: mip.height};
}

/** Engine FGetHSV (UnLight): the colour an actor light contributes. */
function lightColor(hue, saturation, brightness) {
  let v = brightness * 1.4 / 255;
  v = Math.min(1, Math.max(0, v * 0.7 / (0.01 + Math.sqrt(v))));
  const h = hue < 86 ? [(85 - hue) / 85, hue / 85, 0] : hue < 171 ? [0, (170 - hue) / 85, (hue - 85) / 85]
    : [(hue - 170) / 85, 0, (255 - hue) / 84];
  return h.map(c => (c + saturation / 255 * (1 - c)) * v);
}

await rm(out, {recursive: true, force: true});
await mkdir(path.join(out, 'assets'), {recursive: true});
await mkdir(path.join(out, 'vendor'), {recursive: true});

const map = await assets.get('DXOnly');
const {actors, model} = decodeMap(map.bytes);
const actor = name => {
  const found = actors.find(a => a.name === name);
  if (!found) throw new Error(`DXOnly has no ${name}`);
  return found;
};
const values = a => classes.forActor(map, a);
/** Object default of an actor: map value first, then the class chain. */
async function objectProperty(a, name) {
  if (a.values[name]) return {asset: map, ref: a.values[name]};
  return classes.objectDefault(map, map.pkg.exports[a.index - 1].classIndex, name);
}

const deco = await assets.get('DeusExDeco');
const meshIndex = name => deco.pkg.exports.findIndex(e => e.path === name && e.className === 'Mesh') + 1;
const logoView = decodeClassicMesh(deco, meshIndex('DXLogo')), textView = decodeClassicMesh(deco, meshIndex('DXText'));
const logoMesh = exportMesh(logoView), textMesh = exportMesh(textView);
await writeFile(path.join(out, 'assets', 'dxlogo.json'), JSON.stringify(logoMesh));
await writeFile(path.join(out, 'assets', 'dxtext.json'), JSON.stringify(textMesh));

const logoActor = actor('DXLogo2'), logo = await values(logoActor);
// PF_Environment selection (Render 10b10634): Actor.Texture first.
const logoTexture = await objectProperty(logoActor, 'Texture');
const texts = [];
for (const name of ['DXText0', 'DXText1']) {
  const a = actor(name), v = await values(a);
  // UMesh::GetTexture: the actor's Skin, else the mesh's own texture 0.
  const texture = await objectProperty(a, 'Skin') ?? {asset: deco, ref: textView.objectReferences[0].index};
  texts.push({name, location: v.Location, rotation: v.Rotation, drawScale: v.DrawScale, style: v.Style,
    unlit: !!v.bUnlit, ambientGlow: v.AmbientGlow, scaleGlow: v.ScaleGlow,
    texture: await writeTexture(texture.asset, texture.ref, `${name}.png`)});
}
const lights = [];
for (const a of actors.filter(a => a.className === 'Light')) {
  const v = await values(a);
  lights.push({name: a.name, location: v.Location, hue: v.LightHue ?? 0, saturation: v.LightSaturation,
    brightness: v.LightBrightness, radius: v.LightRadius, worldRadius: 25 * (v.LightRadius + 1),
    color: lightColor(v.LightHue ?? 0, v.LightSaturation, v.LightBrightness)});
}
const emitterActor = actor('ElectricityEmitter0'), emitter = await values(emitterActor);
const beam = await objectProperty(emitterActor, 'beamTexture');
const beamTexture = await textures.get(beam.asset, beam.ref);
// LaserProxy draws each beam segment as DeusExItems.LaserBeam, a thin box along its
// length axis (Y before the mesh's RotOrigin yaw turns it to X).
const items = await assets.get('DeusExItems');
const beamMesh = decodeLodMeshPayload(items.pkg, items.bytes,
  items.pkg.exports.findIndex(e => e.path === 'LaserBeam' && e.className === 'LodMesh') + 1);
const beamFrame = readLodMeshFrame(beamMesh, 0);
const beamExtent = [0, 1, 2].map(axis => {
  const values = beamFrame.filter((_, i) => i % 3 === axis).map(v => v * beamMesh.scale[axis]);
  return Math.max(...values) - Math.min(...values);
});
const start = actor('PlayerStart0').values;
const deusEx = await assets.get('DeusEx');
const player = await classes.get(deusEx, deusEx.exportsByPath.get('jcdentonmale'));
// DefaultFOV is a config value; the shipped DefUser.ini holds the default.
const fov = Number((await readFile(path.join(game, 'System', 'DefUser.ini'), 'latin1')).match(/^DefaultFOV=([\d.]+)/m)?.[1]);
if (!fov) throw new Error('DefUser.ini has no DefaultFOV');
const bounds = [0, 1, 2].map(axis => [Math.min(...model.points.map(p => p[axis])), Math.max(...model.points.map(p => p[axis]))]);

const scene = {
  source: 'DXOnly.dx (DeusExLevelInfo MissionLocation "Splash"), DeusEx.u, DeusExDeco.u',
  camera: {location: start.Location, rotation: start.Rotation, eyeHeight: player.BaseEyeHeight, fov},
  room: {bounds, texture: 'DeusExItems.Skins.BlackMaskTex'},
  logo: {location: logoActor.values.Location, rotation: logoActor.values.Rotation, drawScale: logo.DrawScale,
    physics: logo.Physics, rotationRate: logo.RotationRate, polyFlags: logoMesh.polyFlags,
    texture: await writeTexture(logoTexture.asset, logoTexture.ref, 'DXLogoTex1.png')},
  texts, lights,
  electricity: {location: emitter.Location, rotation: emitter.Rotation ?? [0, 0, 0], randomAngle: emitter.randomAngle,
    flickerTime: emitter.flickerTime, bFlicker: emitter.bFlicker, bRandomBeam: emitter.bRandomBeam, texture: beamTexture.key,
    segment: {length: beamExtent[1], thickness: beamExtent[0]},
    lightColor: lightColor(emitter.LightHue, emitter.LightSaturation, emitter.LightBrightness),
    lightWorldRadius: 25 * (emitter.LightRadius + 1),
    // Nano_SFX is a Fire.dll procedural texture; the page draws its palette, not the simulation.
    palette: beamTexture.fire?.palette ? [...beamTexture.fire.palette].filter((_, i) => i % 4 !== 3) : null},
};
await writeFile(path.join(out, 'assets', 'scene.json'), JSON.stringify(scene, null, 1));

const three = path.join(root, 'node_modules', 'three', 'build');
await cp(path.join(three, 'three.module.js'), path.join(out, 'vendor', 'three.module.js'));
await cp(path.join(three, 'three.core.js'), path.join(out, 'vendor', 'three.core.js'));
await cp(path.join(here, 'page', 'main.js'), path.join(out, 'main.js'));
await cp(path.join(here, 'page', 'style.css'), path.join(out, 'style.css'));

// The card frames the page itself: a root URL answers without the redirects
// hosts apply to "*.html" paths (Cloudflare Pages sends /play.html to /play).
const template = await readFile(path.join(here, 'page', 'index.html'), 'utf8');
const absolute = file => (baseUrl ?? '') + file;
await writeFile(path.join(out, 'index.html'), template
  .replaceAll('%PLAYER_URL%', absolute(''))
  .replaceAll('%IMAGE_URL%', absolute('card.png'))
  .replaceAll('%PAGE_URL%', absolute('')));
// Allows X to frame the page; other sites still can't. Read by Cloudflare Pages and Netlify.
await writeFile(path.join(out, '_headers'), '/*\n  Content-Security-Policy: frame-ancestors \'self\' https://x.com https://*.x.com https://twitter.com https://*.twitter.com\n');

// A deploy build always needs the card image: X drops a card whose image is missing.
if (args.includes('--poster') || baseUrl) {
  const {renderPoster} = await import('./poster.mjs');
  await renderPoster(path.join(out, 'card.png'));
}
console.log(`embed/out written (${logoMesh.positions.length / 9} logo triangles, ${lights.length} lights).`);
if (!baseUrl) console.log('No --url given: card meta tags hold relative URLs, which X ignores. Rebuild with --url before deploying.');
