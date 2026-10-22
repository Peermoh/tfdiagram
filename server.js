// Local dev server: same API handler as the Worker, plus static files from ./public.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, handleSearch } from './lib/api.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const PORT = process.env.PORT ?? 3000;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/search') {
      const out = await handleSearch(new Request(url, { method: 'GET', headers: req.headers }), process.env);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      return res.end(await out.text());
    }
    if (url.pathname === '/api/diagram') {
      const body = req.method === 'POST' ? await new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
      }) : undefined;
      const out = await handleApi(new Request(url, { method: req.method, headers: req.headers, body }), process.env);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      return res.end(await out.text());
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
    if (rel.includes('..')) { res.writeHead(400); return res.end(); }
    const data = await readFile(join(PUBLIC, rel)); // read first: a missing file must not leave headers half-sent
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    if (res.headersSent) return res.end();
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}).listen(PORT, () => console.log(`tfdiagram on http://localhost:${PORT}`));
