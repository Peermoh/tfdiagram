import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTerraformFiles } from './lib/github.js';
import { buildGraph, toMermaid } from './lib/graph.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1_000_000) { reject(new Error('Input too large')); req.destroy(); } });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/diagram') {
      const simplify = url.searchParams.get('simplify') !== '0';
      const provider = url.searchParams.get('provider') ?? 'auto';
      let files, meta = {};
      if (req.method === 'POST') {
        // Pasted Terraform: body is { code: "..." }
        const { code } = JSON.parse(await readBody(req));
        if (!code?.trim()) return json(res, 400, { error: 'Paste some Terraform code' });
        files = [{ path: 'pasted.tf', content: code }];
      } else {
        const repo = url.searchParams.get('repo');
        if (!repo) return json(res, 400, { error: 'Missing ?repo=' });
        // The token is used for this request only and is never stored or logged.
        const r = await fetchTerraformFiles(repo, req.headers['x-github-token']);
        files = r.files;
        meta = { owner: r.owner, repo: r.repo, branch: r.branch, truncated: r.truncated };
      }
      const graph = buildGraph(files, { simplify, provider });
      return json(res, 200, { ...meta, fileCount: files.length, graph, mermaid: toMermaid(graph) });
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
    if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
    const data = await readFile(join(PUBLIC, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    json(res, err.code === 'ENOENT' ? 404 : 500, { error: err.message });
  }
}).listen(process.env.PORT ?? 3000, () => console.log(`tfdiagram on http://localhost:${process.env.PORT ?? 3000}`));
