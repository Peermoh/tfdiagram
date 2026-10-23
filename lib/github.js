import { loadTree, loadAllFolders } from './modules.js';
import { unzipTerraform, VARS } from '../public/unzip.js';
import { downloadZip } from './zipdl.js';

// Fetches .tf files from a public (or token-accessible) GitHub repo.

const MAX_FILES = 45; // Workers free plan: 50 subrequests per request (2 API calls + 1 per file)
const MAX_BYTES = 500_000;

export function parseRepoUrl(input) {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/.exec(input.trim());
  if (!m) throw new Error('Expected a URL like https://github.com/owner/repo[/tree/branch/path]');
  return { owner: m[1], repo: m[2], ref: m[3], path: (m[4] ?? '').replace(/\/$/, '') };
}

async function gh(url, token) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'tfdiagram',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const hint = res.status === 404 ? ' (not found, or private: provide a token)' : res.status === 403 ? ' (GitHub rate limit: paste a GitHub token below, or try again in an hour)' : '';
    throw new Error(`GitHub ${res.status}${hint}`);
  }
  return res;
}

const dirOfPath = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), 0));

// Folders (at or below `under`) that hold .tf files, and the one to draw by default: the shallowest, then the one with most files.
export function terraformFolders(blobs, under = '') {
  const counts = new Map();
  for (const t of blobs) {
    const d = dirOfPath(t.path);
    if (under && d !== under && !d.startsWith(`${under}/`)) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const depth = (d) => (d ? d.split('/').length : 0);
  const dirs = [...counts].map(([dir, count]) => ({ dir, count })).sort((a, b) => depth(a.dir) - depth(b.dir) || b.count - a.count || a.dir.localeCompare(b.dir));
  return { dirs, best: dirs[0]?.dir };
}

export async function fetchTerraformTree(url, token, rootOverride, remote) {
  const { owner, repo, ref, path } = parseRepoUrl(url);
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  // HEAD = the default branch; saves an API call, which matters for the 60/hour anonymous limit.
  const branch = ref ?? 'HEAD';
  const dirOf = dirOfPath;

  // First choice: the whole repository as one zip (no per-file requests, so nothing is cut off, and for public
  // repositories no API rate limit). If that fails, list the tree through the API and fetch files one by one.
  let bulk = null;
  let bulkVars = [];
  let blobs;
  let varBlobs;
  let listingTruncated = false;
  try {
    const { files: got } = await unzipTerraform(await downloadZip(owner, repo, branch, token), { maxFiles: 5000, maxFile: MAX_BYTES, maxTotal: 25_000_000 });
    const rel = got.map((f) => ({ path: f.path.split('/').slice(1).join('/'), content: f.content })).filter((f) => f.path);   // drop the "owner-repo-sha/" folder GitHub wraps it in
    const tf = rel.filter((f) => /\.tf$/i.test(f.path));
    bulkVars = rel.filter((f) => VARS.test(f.path));
    bulk = new Map();
    for (const f of tf) bulk.set(dirOf(f.path), [...(bulk.get(dirOf(f.path)) ?? []), f]);
    blobs = tf.map((f) => ({ path: f.path, size: f.content.length }));
  } catch { bulk = null; bulkVars = []; }
  if (!bulk) {
    const listing = await (await gh(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token)).json();
    blobs = listing.tree.filter((t) => t.type === 'blob' && t.path.endsWith('.tf') && t.size <= MAX_BYTES);
    varBlobs = listing.tree.filter((t) => t.type === 'blob' && VARS.test(t.path) && t.size <= MAX_BYTES);
    listingTruncated = Boolean(listing.truncated);
  }
  const { dirs, best } = terraformFolders(blobs, path);
  if (!dirs.length) throw new Error(`No .tf files found${path ? ` under "${path}"` : ' in that repository'}`);
  // the URL named a folder, or the user picked one from the list; otherwise use the top level, or the best folder if it has none
  const all = rootOverride === '*';
  const root = all ? '*' : rootOverride !== undefined && dirs.some((d) => d.dir === rootOverride) ? rootOverride : dirs.some((d) => d.dir === path) ? path : best;

  let fetched = 0;
  let capped = false;
  const cache = new Map();
  // Files directly inside `dir`; modules are separate directories, so each is read on demand.
  const readDir = (dir) => {
    if (bulk) { const list = bulk.get(dir) ?? []; fetched += list.length; return Promise.resolve(list); }
    if (!cache.has(dir)) {
      cache.set(dir, (async () => {
        const wanted = blobs.filter((t) => dirOf(t.path) === dir);
        const room = Math.max(MAX_FILES - fetched, 0);
        if (wanted.length > room) capped = true;
        const take = wanted.slice(0, room);
        fetched += take.length;
        return Promise.all(take.map(async (t) => {
          const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${t.path.split('/').map(encodeURIComponent).join('/')}`);
          if (!res.ok) throw new Error(`Failed to fetch ${t.path}: ${res.status}`);
          return { path: t.path, content: await res.text() };
        }));
      })());
    }
    return cache.get(dir);
  };
  // terraform.tfvars / *.auto.tfvars next to the drawn folder set the root module's variables
  const varDir = all ? '' : root;
  const varFiles = bulk ? bulkVars.filter((f) => dirOf(f.path) === varDir) : await Promise.all(varBlobs.filter((t) => dirOf(t.path) === varDir).slice(0, 3).map(async (t) => {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${t.path.split('/').map(encodeURIComponent).join('/')}`);
    return { path: t.path, content: res.ok ? await res.text() : '' };
  }));
  const tfvars = varFiles.map((f) => f.content).join('\n');
  const loaded = all ? await loadAllFolders(dirs, readDir, bulk ? 40 : 15, { remote }) : null;
  const tree = loaded ? loaded.tree : await loadTree(root, readDir, { remote });
  return { owner, repo, branch, root, all: loaded && { shown: loaded.shown, total: loaded.total }, dirs: dirs.slice(0, 200), tree, fileCount: fetched, tfvars, truncated: Boolean(listingTruncated || capped) };
}
