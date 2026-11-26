// Minimal static server for ./dist (local testing only). npm run serve [port]
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.bin': 'application/octet-stream', '.js': 'text/javascript' };
const port = +(process.argv[2] || 8080);
createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(dist, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''), rel.endsWith('/') ? 'index.html' : '');
  try {
    if (!file.startsWith(dist)) throw 0;
    const st = statSync(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, () => console.log(`http://localhost:${port}/`));
