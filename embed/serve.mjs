/** Serves embed/out/ locally: node embed/serve.mjs [port] (default 5180). */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png'};

/** Resolves with the listening server; port 0 picks a free one. */
export function serve(port) {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.join(root, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
    try {
      const body = await readFile(file);
      response.writeHead(200, {'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store'});
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await serve(Number(process.argv[2] ?? 5180));
  console.log(`http://127.0.0.1:${server.address().port}/`);
}
