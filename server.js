// Local dev server: same API handler as the Worker, plus static files from ./public.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, handleSearch } from './lib/api.js';
import { handleMcp } from './lib/mcp.js';
import { handleRepo, handleRepoFile } from './lib/repoapi.js';
import { hasGit, readRepoWithGit } from './lib/localgit.js';
import { parseAdoUrl, fetchAdoZip } from './lib/ado.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PORT = process.env.PORT ?? 3000;
const HOST = process.env.HOST ?? '127.0.0.1';     // this computer only, unless you deliberately set HOST

// The "private repository" endpoints use this computer's git credentials, so they answer to this computer only:
// a loopback connection, a localhost Host header (no DNS rebinding) and no foreign Origin. Off with TFDIAGRAM_LOCAL=0.
const isLocalRequest = (req) => process.env.TFDIAGRAM_LOCAL !== '0'
  && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
  && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '')
  && (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`);
const readBody = (req, max = 100_000) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const sendJson = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/search') {
      const out = await handleSearch(new Request(url, { method: 'GET', headers: req.headers }), process.env);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      return res.end(await out.text());
    }
    if (url.pathname === '/api/repo/file') {
      const out = await handleRepoFile(new Request(url, { method: 'GET', headers: req.headers }), process.env);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      return res.end(await out.text());
    }
    if (url.pathname === '/api/repo') {
      const body = req.method === 'POST' ? await readBody(req, 15_000_000) : undefined;
      const out = await handleRepo(new Request(url, { method: req.method, headers: req.headers, body }), process.env);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      return res.end(await out.text());
    }
    if (url.pathname === '/api/local') {                      // lets the page know it is running on this computer
      if (!isLocalRequest(req)) return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 200, { local: true, git: await hasGit() });
    }
    if (url.pathname === '/api/local/fetch' && req.method === 'POST') {
      if (!isLocalRequest(req)) return sendJson(res, 404, { error: 'Not found' });
      try {
        const { url: repoUrl, pat, all } = JSON.parse(await readBody(req));
        const ado = parseAdoUrl(repoUrl);
        // a token: Azure DevOps REST API. Otherwise git with whatever this computer is already signed in with.
        if (ado && typeof pat === 'string' && pat.trim()) {
          const { files, skipped, entries } = await fetchAdoZip(ado, pat.trim(), fetch, all);
          return sendJson(res, 200, { files, tree: entries, skipped, root: ado.path, via: 'Azure DevOps API with your token', name: `${ado.org}/${ado.project}/${ado.repo}` });
        }
        const { files, skipped, tree } = await readRepoWithGit(ado?.cloneUrl ?? repoUrl, { branch: ado?.branch, all: Boolean(all) });
        return sendJson(res, 200, { files, tree, skipped, root: ado?.path ?? '', via: "git, using this computer's own sign-in", name: ado ? `${ado.org}/${ado.project}/${ado.repo}` : String(repoUrl) });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/mcp') {
      const body = await new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
      const out = await handleMcp(new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? body : undefined }), process.env);
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
}).listen(PORT, HOST, () => console.log(`tfdiagram on http://localhost:${PORT}`));
