import { defineConfig } from 'vite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './scripts/game-directory.mjs';

export default defineConfig({
  publicDir: false,
  server: { host: '127.0.0.1', port: 5173, strictPort: true,
    // .work/ (git-ignored scratch worktrees and logs) and .claude/worktrees/
    // hold whole repository copies: watching them keeps vite busy.
    watch: { ignored: ['**/Deus Ex*/**', '**/game/**', '**/reports/**', '**/.cache/**', '**/.work/**', '**/.claude/worktrees/**'] },
    fs: { deny: ['.env', '.env.*', '**/.git/**', '**/Deus Ex*/**', '**/game/**', '**/reports/**', '**/.cache/**', '**/.work/**', '**/.claude/worktrees/**'] } },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
  plugins: [{
    name: 'local-deus-ex-data',
    async configureServer(server) {
      const files = new Map();
      // System/*.dll names only (never served): UPackage::BindPackage asks
      // whether a package has a native library (docs/script-font-load.md).
      const libraries = [];
      try {
        const root = gameDirectory();
        for (const directory of ['Maps', 'Textures', 'System', 'Sounds', 'Music']) {
          for (const file of await readdir(path.join(root, directory), { withFileTypes: true })) {
            if (file.isFile() && /\.(u|utx|dx|unr|uax|umx|ini)$/i.test(file.name)) {
              const name = `${directory}/${file.name}`;
              files.set(name, path.join(root, name));
            } else if (file.isFile() && directory === 'System' && /\.dll$/i.test(file.name)) {
              libraries.push(`${directory}/${file.name}`);
            }
          }
        }
      } catch { /* An absent local installation leaves the folder picker available. */ }
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0] ?? '';
        if (!pathname.startsWith('/__game__/')) return next();
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET' || req.headers['sec-fetch-site'] === 'cross-site') {
          res.statusCode = 403; return res.end('Local read-only access required');
        }
        try {
          if (pathname === '/__game__/manifest') {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ files: [...files.keys()], libraries }));
          }
          const file = files.get(decodeURIComponent(pathname.slice('/__game__/file/'.length)));
          if (!pathname.startsWith('/__game__/file/') || !file) {
            res.statusCode = 404; return res.end('Package not found');
          }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(await readFile(file));
        } catch {
          res.statusCode = 400; res.end('Cannot read local package');
        }
      });
    },
  }],
});
