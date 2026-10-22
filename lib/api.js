// Runtime-agnostic API handler (Web Request/Response), shared by the Cloudflare Worker and the local Node server.
import { fetchTerraformTree } from './github.js';
import { buildGraph, toMermaid } from './graph.js';

const MAX_BODY = 1_000_000;

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
      if (text.length > MAX_BODY) return json(413, { error: 'Input too large' });
      const { code } = JSON.parse(text);
      if (!code?.trim()) return json(400, { error: 'Paste some Terraform code' });
      tree = { files: [{ path: 'pasted.tf', content: code }], children: {} };
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
    return json(200, { ...meta, fileCount, graph, mermaid: toMermaid(graph) });
  } catch (err) {
    return json(err instanceof SyntaxError ? 400 : 500, { error: err.message });
  }
}
