import { loadTree } from './modules.js';

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
    const hint = res.status === 404 ? ' (not found, or private: provide a token)' : res.status === 403 ? ' (rate limited: provide a token)' : '';
    throw new Error(`GitHub ${res.status}${hint}`);
  }
  return res;
}

export async function fetchTerraformTree(url, token) {
  const { owner, repo, ref, path } = parseRepoUrl(url);
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const branch = ref ?? (await (await gh(base, token)).json()).default_branch;
  const listing = await (await gh(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token)).json();
  const blobs = listing.tree.filter((t) => t.type === 'blob' && t.path.endsWith('.tf') && t.size <= MAX_BYTES);
  const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), 0));
  if (!blobs.some((t) => dirOf(t.path) === path)) throw new Error('No .tf files found at that location');

  let fetched = 0;
  let capped = false;
  const cache = new Map();
  // Files directly inside `dir`; modules are separate directories, so each is read on demand.
  const readDir = (dir) => {
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
  const tree = await loadTree(path, readDir);
  return { owner, repo, branch, tree, fileCount: fetched, truncated: Boolean(listing.truncated || capped) };
}
