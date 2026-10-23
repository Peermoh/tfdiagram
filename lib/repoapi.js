// /api/repo: explain ANY code repository (not only Terraform). A public GitHub URL is downloaded as one zip;
// uploaded zips and repos read on this computer arrive as { files, tree }.
import { parseRepoUrl } from './github.js';
import { downloadZip } from './zipdl.js';
import { unzipTerraform, textPath } from '../public/unzip.js';
import { analyzeRepo, repoContext } from './repomap.js';
import { repoMermaid } from '../public/explain.js';

const MAX_BODY = 14_000_000;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// GitHub URL -> { owner, repo, branch, files, tree, truncated }, paths relative to the repo (or to the folder in the URL)
export async function fetchRepoFiles(repoUrl, token) {
  const { owner, repo, ref, path } = parseRepoUrl(repoUrl);
  let buf;
  try { buf = await downloadZip(owner, repo, ref, token); } catch (e) {
    throw new Error(/too large/.test(e.message)
      ? 'That repository is larger than 40 MB, which is more than I can download here. Point at a subfolder (…/tree/main/<folder>), or run TFDiagram on your computer.'
      : `Could not download ${owner}/${repo}: ${e.message}${/40[34]/.test(e.message) ? ' (private or missing: give a GitHub token under More options, or upload a zip)' : ''}`);
  }
  const unz = await unzipTerraform(buf, { accept: textPath, maxFiles: 3500, maxFile: 300_000, maxTotal: 12_000_000 });
  const strip = (p) => p.split('/').slice(1).join('/');
  const under = path ? `${path}/` : '';
  const keep = (p) => p && (!under || p.startsWith(under));
  const rel = (p) => (under ? p.slice(under.length) : p);
  const files = unz.files.map((f) => ({ ...f, path: strip(f.path) })).filter((f) => keep(f.path)).map((f) => ({ path: rel(f.path), content: f.content }));
  const tree = unz.entries.map((e) => ({ ...e, path: strip(e.path) })).filter((e) => keep(e.path)).map((e) => ({ path: rel(e.path), size: e.size }));
  if (!tree.length) throw new Error(path ? `Nothing found under "${path}" in ${owner}/${repo}.` : `${owner}/${repo} looks empty.`);
  return { owner, repo, branch: ref ?? 'default branch', files, tree, truncated: Boolean(unz.truncated), name: `${owner}/${repo}${path ? `/${path}` : ''}` };
}

export function buildExplainResponse({ name, files, tree, truncated = false, extra = {} }) {
  const model = analyzeRepo({ name, tree, files });
  return { ...extra, name, model, mermaid: repoMermaid(model.diagram), context: repoContext(model, files), truncated, fileCount: tree.length };
}

export async function handleRepo(request, env = {}) {
  try {
    const url = new URL(request.url);
    const token = request.headers.get('x-github-token') || env.GITHUB_TOKEN;
    if (request.method === 'POST') {
      const text = await request.text();
      if (text.length > MAX_BODY) return json(413, { error: 'That project is too large to send (limit about 14 MB of text).' });
      const body = JSON.parse(text);
      const files = (body.files ?? []).filter((f) => typeof f?.path === 'string' && typeof f?.content === 'string').slice(0, 4000);
      const tree = (Array.isArray(body.tree) && body.tree.length ? body.tree : files.map((f) => ({ path: f.path, size: f.content.length }))).filter((t) => typeof t?.path === 'string').slice(0, 30000).map((t) => ({ path: t.path, size: Number(t.size) || 0 }));
      if (!tree.length) return json(400, { error: 'No files were given.' });
      return json(200, buildExplainResponse({ name: String(body.name ?? '').slice(0, 120), files, tree, truncated: Boolean(body.truncated) }));
    }
    const repo = url.searchParams.get('repo');
    if (!repo) return json(400, { error: 'Missing ?repo=' });
    const r = await fetchRepoFiles(repo, token);
    return json(200, buildExplainResponse({ name: r.name, files: r.files, tree: r.tree, truncated: r.truncated, extra: { owner: r.owner, repo: r.repo, branch: r.branch } }));
  } catch (err) {
    return json(err instanceof SyntaxError ? 400 : 500, { error: err.message });
  }
}
