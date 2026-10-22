import { defineConfig } from 'vite';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './scripts/game-directory.mjs';

export default defineConfig({
  publicDir: false,
  // The dependency-optimizer cache, relative to each server's root: inside its own checkout. Worktrees that symlink
  // node_modules to the main checkout's would otherwise share node_modules/.vite, whose config hash includes the root:
  // a server from another checkout deletes and rebuilds it, and pages loading meanwhile get 504 Outdated Optimize Dep.
  cacheDir: '.vite-cache',
  server: { host: '127.0.0.1', port: 5173, strictPort: true,
    // .work/ (git-ignored scratch worktrees and logs) and .claude/worktrees/
    // hold whole repository copies: watching them keeps vite busy.
    watch: { ignored: ['**/Deus Ex*/**', '**/game/**', '**/reports/**', '**/.cache/**', '**/.work/**', '**/.claude/worktrees/**'] },
    fs: { deny: ['.env', '.env.*', '**/.git/**', '**/Deus Ex*/**', '**/game/**', '**/reports/**', '**/.cache/**', '**/.work/**', '**/.claude/worktrees/**'] } },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
  // The simulation worker (src/viewer/sim-worker.mjs) imports its runtime
  // modules dynamically once the page's switches are set.
  worker: { format: 'es' },
  plugins: [{
    name: 'local-deus-ex-data',
    async configureServer(server) {
      const files = new Map();
      // System/*.dll names only (never served): UPackage::BindPackage asks
      // whether a package has a native library (docs/script-font-load.md).
      const libraries = [];
      try {
        const root = gameDirectory();
        for (const directory of ['Maps', 'Textures', 'System', 'Sounds', 'Music', 'Help']) {
          for (const file of await readdir(path.join(root, directory), { withFileTypes: true })) {
            // (Help: the splash bitmaps only, docs/boot.md)
            if (file.isFile() && (directory === 'Help' ? /\.bmp$/i.test(file.name) : /\.(u|utx|dx|unr|uax|umx|ini)$/i.test(file.name))) {
              const name = `${directory}/${file.name}`;
              files.set(name, path.join(root, name));
            } else if (file.isFile() && directory === 'System' && /\.dll$/i.test(file.name)) {
              libraries.push(`${directory}/${file.name}`);
            }
          }
        }
      } catch { /* An absent local installation leaves the folder picker available. */ }
      // The installed game's own `Save` folder, READ-ONLY (docs/save-storage.md "The dev server"): the two levels the game uses (`Save<N>`, `QuickSave`,
      // `Current`, each with its files), listed at each request so a save the desktop game made shows on the next page load. No write endpoint exists:
      // whatever the page saves lands in the browser's storage or a folder the player picked, never in the installation. This middleware lives in
      // configureServer, so neither `vite build` nor `vite preview` has it.
      const saveRoot = () => path.join(gameDirectory(), 'Save');
      const saveDirectoryName = /^(Save-?\d+|QuickSave|Current)$/i;
      const saveFileName = /^[^\\/:*?"<>|\u0000]+$/;
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0] ?? '';
        if (pathname !== '/__game__/saves' && !pathname.startsWith('/__game__/save/')) return next();
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET' || req.headers['sec-fetch-site'] === 'cross-site') {
          res.statusCode = 403; return res.end('Local read-only access required');
        }
        try {
          if (pathname === '/__game__/saves') {
            const found = [];
            let directories = [];
            try { directories = await readdir(saveRoot(), { withFileTypes: true }); } catch { /* no Save folder yet */ }
            for (const directory of directories) {
              if (!directory.isDirectory() || !saveDirectoryName.test(directory.name)) continue;
              for (const file of await readdir(path.join(saveRoot(), directory.name), { withFileTypes: true })) {
                if (!file.isFile() || !saveFileName.test(file.name)) continue;
                const info = await stat(path.join(saveRoot(), directory.name, file.name));
                found.push({ dir: directory.name, name: file.name, size: info.size, modified: Math.floor(info.mtimeMs) });
              }
            }
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ files: found }));
          }
          const [dir, name, ...rest] = pathname.slice('/__game__/save/'.length).split('/').map(decodeURIComponent);
          if (rest.length || !saveDirectoryName.test(dir ?? '') || !saveFileName.test(name ?? '') || name === '.' || name === '..') {
            res.statusCode = 404; return res.end('Save file not found');
          }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(await readFile(path.join(saveRoot(), dir, name)));
        } catch (error) {
          res.statusCode = error?.code === 'ENOENT' ? 404 : 400; res.end('Cannot read that save file');
        }
      });
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
