// Runtime-agnostic API handler (Web Request/Response), shared by the Cloudflare Worker and the local Node server.
import { fetchTerraformTree } from './github.js';
import { buildGraph } from './graph.js';
import { loadTree } from './modules.js';

const MAX_BODY = 1_000_000;
const MAX_FILES_BODY = 9_000_000; // an uploaded zip's .tf files, sent as JSON

const dirOf = (path) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

// The folder to draw by default: the shallowest one holding .tf files (most files wins a tie).
export function pickRoot(dirs) {
  const depth = (d) => (d ? d.split('/').length : 0);
  return [...dirs].sort((a, b) => depth(a.dir) - depth(b.dir) || b.count - a.count || a.dir.localeCompare(b.dir))[0]?.dir ?? '';
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function handleApi(request, env = {}) {
  const url = new URL(request.url);
  try {
    const simplify = url.searchParams.get('simplify') !== '0';
    const provider = url.searchParams.get('provider') ?? 'auto';
    let tree;
    let fileCount = 1;
    let meta = {};
    if (request.method === 'POST') {
      // Pasted Terraform: body is { code: "..." }
      const text = await request.text();
      if (text.length > MAX_FILES_BODY) return json(413, { error: 'Input too large' });
      const body = JSON.parse(text);
      if (Array.isArray(body.files)) {
        // Uploaded zip: the browser unpacked it and sent the .tf files; follow local modules like a GitHub repo.
        const files = body.files.filter((f) => typeof f?.path === 'string' && typeof f?.content === 'string' && /\.tf$/i.test(f.path)).slice(0, 3000);
        if (!files.length) return json(400, { error: 'No .tf files found in that zip' });
        const byDir = new Map();
        for (const f of files) byDir.set(dirOf(f.path), [...(byDir.get(dirOf(f.path)) ?? []), f]);
        const dirs = [...byDir].map(([dir, list]) => ({ dir, count: list.length }));
        const root = typeof body.root === 'string' && byDir.has(body.root) ? body.root : pickRoot(dirs);
        tree = await loadTree(root, async (d) => byDir.get(d) ?? []);
        fileCount = files.length;
        meta = { root, dirs };
      } else {
        if (text.length > MAX_BODY) return json(413, { error: 'Input too large' });
        const { code } = body;
        if (!code?.trim()) return json(400, { error: 'Paste some Terraform code' });
        tree = { files: [{ path: 'pasted.tf', content: code }], children: {} };
      }
    } else {
      const repo = url.searchParams.get('repo');
      if (!repo) return json(400, { error: 'Missing ?repo=' });
      // A user's token is used for this request only and is never stored or logged.
      // GITHUB_TOKEN (optional secret) raises the shared rate limit for everyone else.
      const token = request.headers.get('x-github-token') || env.GITHUB_TOKEN;
      const r = await fetchTerraformTree(repo, token);
      tree = r.tree;
      fileCount = r.fileCount;
      meta = { owner: r.owner, repo: r.repo, branch: r.branch, truncated: r.truncated };
    }
    const graph = buildGraph(tree, { simplify, provider });
    return json(200, { ...meta, fileCount, graph });
  } catch (err) {
    return json(err instanceof SyntaxError ? 400 : 500, { error: err.message });
  }
}
