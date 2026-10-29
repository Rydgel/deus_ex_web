import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { objectAt } from '../src/unreal/objects.mjs';

try {
  const filename = process.argv[2] ?? path.join(gameDirectory(), 'Maps', '00_Training.dx');
  const output = path.resolve(process.argv[3] ?? path.join('reports', path.parse(filename).name));
  const bytes = await readFile(filename);
  const { pkg, model, actors, triangles, summary } = decodeMap(bytes);
  await mkdir(output, { recursive: true });

  const lines = [
    '# Original compiled Deus Ex world BSP; untextured diagnostic mesh.',
    '# Coordinates preserved: Unreal units, Z up. Excludes invisible surfaces.',
    '# Actor meshes and moving brushes are not included.',
    ...model.points.map(p => `v ${p.join(' ')}`),
  ];
  let currentSurface = -1;
  for (const t of triangles) {
    if (t.surface !== currentSurface) {
      currentSurface = t.surface;
      const texture = objectAt(pkg, model.surfaces.at(t.surface).texture)?.path ?? 'None';
      lines.push(`g surface_${t.surface}_${texture.replace(/[^a-zA-Z0-9_.-]/g, '_')}`);
    }
    lines.push(`f ${t.points.map(i => i + 1).join(' ')}`);
  }
  await writeFile(path.join(output, 'world.obj'), lines.join('\n') + '\n');
  await writeFile(path.join(output, 'summary.json'), JSON.stringify({
    source: path.basename(filename), sha256: createHash('sha256').update(bytes).digest('hex'), ...summary,
    limits: 'Static world geometry only; no textures, lighting, actor meshes, class defaults, collision, or script execution.',
  }, null, 2) + '\n');
  await writeFile(path.join(output, 'actors.json'), JSON.stringify(actors, null, 2) + '\n');

  // A geometry footprint is a diagnostic, not a claim to reproduce the game's appearance.
  const usedPoints = new Set(triangles.flatMap(t => t.points));
  const points = [...usedPoints].map(i => model.points.at(i));
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (const p of points) for (let axis = 0; axis < 2; axis++) {
    min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]);
  }
  if (!points.length) throw new Error('Map has no visible geometry to plot');
  const width = 1200, height = 900, pad = 60;
  const scale = Math.min((width - 2 * pad) / Math.max(1, max[0] - min[0]), (height - 2 * pad - 60) / Math.max(1, max[1] - min[1]));
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  const project = p => [(width / 2 + (p[0] - cx) * scale).toFixed(2), (height / 2 + 30 - (p[1] - cy) * scale).toFixed(2)];
  const edges = new Set();
  const paths = [];
  for (const node of model.nodes) {
    if (node.vertexCount < 3 || model.surfaces.at(node.surface).flags & 1) continue;
    for (let i = 0; i < node.vertexCount; i++) {
      const a = model.vertices.at(node.vertexPool + i).point;
      const b = model.vertices.at(node.vertexPool + (i + 1) % node.vertexCount).point;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (edges.has(key)) continue;
      edges.add(key);
      const from = project(model.points.at(a)), to = project(model.points.at(b));
      if (from.join(',') !== to.join(',')) paths.push(`M${from.join(',')}L${to.join(',')}`);
    }
  }
  const escape = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const start = summary.playerStarts.find(p => p.location);
  const marker = start ? `<circle cx="${project(start.location)[0]}" cy="${project(start.location)[1]}" r="7" fill="#ffc86b" stroke="#06131e" stroke-width="2"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Top-down footprint of decoded ${escape(path.basename(filename))} geometry">
<rect width="1200" height="900" fill="#09131e"/>
<g font-family="sans-serif" fill="#e5eef5"><text x="40" y="42" font-size="24">${escape(path.basename(filename))} · Compiled world geometry</text>
<text x="40" y="71" font-size="16" fill="#97acbd">${summary.triangles.toLocaleString('en-US')} triangles · top view (X/Y) · all heights overlaid${start ? ' · gold marker: player start' : ''}</text></g>
<path d="${paths.join('')}" fill="none" stroke="#66b5c9" stroke-width="0.7" opacity="0.42"/>
${marker}</svg>\n`;
  await writeFile(path.join(output, 'footprint.svg'), svg);
  console.log(JSON.stringify({ output, ...summary }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
