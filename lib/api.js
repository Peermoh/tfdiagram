// Runtime-agnostic API handler (Web Request/Response), shared by the Cloudflare Worker and the local Node server.
import { fetchTerraformTree } from './github.js';
import { buildGraph } from './graph.js';
import { loadTree, loadAllFolders, allFiles } from './modules.js';
import { makeRemoteResolver } from './registry.js';
import { VARS, ANYVARS } from '../public/unzip.js';
import { validateProject } from './validate.js';
import { parseSearchParams, searchRepos } from './search.js';

const MAX_BODY = 1_000_000;
const MAX_FILES_BODY = 9_000_000; // an uploaded zip's .tf files, sent as JSON

const dirOf = (path) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

// The folder to draw by default: the shallowest one holding .tf files (most files wins a tie).
export function pickRoot(dirs) {
  const depth = (d) => (d ? d.split('/').length : 0);
  return [...dirs].sort((a, b) => depth(a.dir) - depth(b.dir) || b.count - a.count || a.dir.localeCompare(b.dir))[0]?.dir ?? '';
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function handleSearch(request, env = {}) {
  try {
    const url = new URL(request.url);
    // a user's token is used for this request only; GITHUB_TOKEN (optional secret) raises the shared limit
    const token = request.headers.get('x-github-token') || env.GITHUB_TOKEN;
    return json(200, await searchRepos(parseSearchParams(url.searchParams), token));
  } catch (err) {
    return json(err.message.startsWith('That search') ? 400 : 502, { error: err.message });
  }
}

export async function handleApi(request, env = {}) {
  const url = new URL(request.url);
  try {
    const simplify = url.searchParams.get('simplify') !== '0';
    const provider = url.searchParams.get('provider') ?? 'auto';
    const showInactive = url.searchParams.get('inactive') === '1';
    // a user's token is used for this request only; GITHUB_TOKEN (optional secret) raises the shared limit
    const token = request.headers.get('x-github-token') || env.GITHUB_TOKEN;
    const remote = makeRemoteResolver(token);
    let tree;
    let fileCount = 1;
    let check = { source: 'paste', root: '', files: null, ignored: {} };
    let meta = {};
    let allInfo = null;
    let tfvars = '';
    let tfvarsFiles = [];
    let varChoice = '';
    let pasted = '';
    let userVars = (url.searchParams.get('vars') ?? '').slice(0, 4000);
    if (request.method === 'POST') {
      // Pasted Terraform: body is { code: "..." }
      const text = await request.text();
      if (text.length > MAX_FILES_BODY) return json(413, { error: 'Input too large' });
      const body = JSON.parse(text);
      if (typeof body.vars === 'string') userVars = body.vars.slice(0, 4000);
      if (Array.isArray(body.files)) {
        // Uploaded zip: the browser unpacked it and sent the .tf files; follow local modules like a GitHub repo.
        const incoming = body.files.filter((f) => typeof f?.path === 'string' && typeof f?.content === 'string' && (/\.tf$/i.test(f.path) || ANYVARS.test(f.path)));
        const files = incoming.filter((f) => /\.tf$/i.test(f.path)).slice(0, 3000);
        const varFiles = incoming.filter((f) => !/\.tf$/i.test(f.path));
        if (!files.length) return json(400, { error: 'No .tf files found in that zip' });
        const byDir = new Map();
        for (const f of files) byDir.set(dirOf(f.path), [...(byDir.get(dirOf(f.path)) ?? []), f]);
        const dirs = [...byDir].map(([dir, list]) => ({ dir, count: list.length }));
        const all = body.root === '*';
        const root = all ? '*' : typeof body.root === 'string' && byDir.has(body.root) ? body.root : pickRoot(dirs);
        const read = async (d) => byDir.get(d) ?? [];
        // terraform.tfvars / *.auto.tfvars next to the drawn folder, then the file picked in the dropdown (it wins)
        const vdir = root === '*' ? '' : root;
        const picked = typeof body.varfile === 'string' ? varFiles.find((f) => f.path === body.varfile) : null;
        tfvars = [...varFiles.filter((f) => dirOf(f.path) === vdir && VARS.test(f.path) && f !== picked), ...(picked ? [picked] : [])].map((f) => f.content).join('\n');
        varChoice = picked?.path ?? '';
        tfvarsFiles = varFiles.map((f) => f.path).slice(0, 100);
        if (all) { const l = await loadAllFolders([...dirs].sort((a, b) => a.dir.split('/').length - b.dir.split('/').length), read, 15, { remote }); tree = l.tree; allInfo = { shown: l.shown, total: l.total }; }
        else tree = await loadTree(root, read, { remote });
        fileCount = files.length;
        meta = { root, dirs };
        check = { source: 'zip', root, files, dirs, ignored: body.ignored ?? {} };
      } else {
        if (text.length > MAX_BODY) return json(413, { error: 'Input too large' });
        const { code } = body;
        if (!code?.trim()) return json(400, { error: 'Paste some Terraform code' });
        const pastedFiles = [{ path: 'pasted.tf', content: code }];
        pasted = code;
        tree = await loadTree('', async (d) => (d === '' ? pastedFiles : []), { remote });
      }
    } else {
      const repo = url.searchParams.get('repo');
      if (!repo) return json(400, { error: 'Missing ?repo=' });
      // A user's token is used for this request only and is never stored or logged.
      // GITHUB_TOKEN (optional secret) raises the shared rate limit for everyone else.
      const r = await fetchTerraformTree(repo, token, url.searchParams.get('root') ?? undefined, remote, url.searchParams.get('varfile') ?? '');
      tree = r.tree;
      fileCount = r.fileCount;
      allInfo = r.all;
      tfvars = r.tfvars ?? '';
      tfvarsFiles = r.tfvarsFiles ?? [];
      varChoice = r.varChoice ?? '';
      meta = { owner: r.owner, repo: r.repo, branch: r.branch, truncated: r.truncated, root: r.root, dirs: r.dirs };
      check = { source: 'github', root: r.root ?? '', files: allFiles(tree), ignored: { truncated: r.truncated } };
    }
    // values the user typed win over terraform.tfvars, which wins over defaults
    tfvars = [tfvars, userVars].filter((t) => t.trim()).join('\n');
    const graph = buildGraph(tree, { simplify, provider, showInactive, tfvars });
    const checks = allInfo
      ? [{ level: 'ok', text: `Drawing ${allInfo.shown} folder${allInfo.shown === 1 ? '' : 's'} at once, each as a module box (variables use their defaults).` }, ...(allInfo.total > allInfo.shown ? [{ level: 'info', text: `${allInfo.total - allInfo.shown} more folders were left out (limit ${allInfo.shown}). Pick one to see it alone.` }] : [])]
      : validateProject({ ...check, files: check.files ?? allFiles(tree), tree, graph, remote });
    if (tfvars.trim() && !allInfo) checks.unshift({ level: 'ok', text: userVars.trim() ? 'Applied your variable values (and any tfvars files) to the root module.' : varChoice ? `Applied values from ${varChoice} (plus any terraform.tfvars / *.auto.tfvars) to the root module.` : 'Applied values from terraform.tfvars / *.auto.tfvars to the root module.' });
    // a .tfvars file pasted on its own only holds values: say so instead of just "nothing to draw"
    if (pasted && !graph.nodes.length && !/^\s*(resource|module|data)\s+"/m.test(pasted) && /^\s*[A-Za-z_][\w-]*\s*=/m.test(pasted)) {
      checks.unshift({ level: 'error', text: 'This looks like a .tfvars file: it only sets values, so there is nothing to draw from it alone. Paste the .tf code that declares the resources (and its variables), or use GitHub URL / Upload zip with the whole project and pick this file under More options > Variable file. To try values on code you already have, paste them into "Variable values" instead.' });
    }
    // the code itself, so the page can show a resource's block or a whole file (capped to keep responses small)
    let budget = 1_500_000;
    const sources = [];
    for (const f of check.files ?? allFiles(tree)) { if (budget < f.content.length) continue; budget -= f.content.length; sources.push({ path: f.path, content: f.content }); }
    return json(200, { ...meta, fileCount, graph, checks, sources, tfvarsApplied: Boolean(tfvars.trim()), tfvarsFiles, varChoice });
  } catch (err) {
    return json(err instanceof SyntaxError ? 400 : 500, { error: err.message });
  }
}
