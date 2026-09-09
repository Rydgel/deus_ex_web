import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { TextureStore } from '../src/unreal/textures.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createWorld } from '../src/viewer/world.mjs';
import { gameDirectory } from './game-directory.mjs';

try {
  const root = gameDirectory(), files = [];
  for (const dir of ['Maps', 'Textures', 'System']) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isFile()) files.push({ path: `${dir}/${entry.name}`, read: () => readFile(path.join(root, dir, entry.name)) });
    }
  }
  const assets = new AssetStore(files), asset = await assets.get(process.argv[2] ?? '00_Training');
  const map = decodeMap(asset.bytes), world = await createWorld(map, asset, assets);
  try {
    const textures = new TextureStore(assets), referencedTextures = [];
    for (const ref of new Set(map.model.surfaces.map(s => s.texture).filter(Boolean))) {
      try {
        const t = await textures.get(asset, ref);
        referencedTextures.push({ key: t.key, mips: t.mips.length, width: t.mips[0].width,
          height: t.mips[0].height, procedural: t.procedural ?? null });
      } catch (error) { referencedTextures.push({ ref, error: error.message }); }
    }
    console.log(JSON.stringify({ map: map.summary, render: { ...world.counts, textures: world.textures,
      lighting: world.lighting, errors: world.errors, notes: world.notes }, referencedTextures }, null, 2));
    if (!world.counts.triangles || world.errors.length || referencedTextures.some(t => t.error)) process.exitCode = 1;
  } finally { world.dispose(); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
