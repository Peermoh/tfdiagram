// Fetches .tf files from a public (or token-accessible) GitHub repo.

const MAX_FILES = 100;
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

export async function fetchTerraformFiles(url, token) {
  const { owner, repo, ref, path } = parseRepoUrl(url);
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const branch = ref ?? (await (await gh(base, token)).json()).default_branch;
  const tree = await (await gh(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token)).json();
  const wanted = tree.tree
    .filter((t) => t.type === 'blob' && t.path.endsWith('.tf') && (!path || t.path.startsWith(path + '/')) && t.size <= MAX_BYTES)
    .slice(0, MAX_FILES);
  if (!wanted.length) throw new Error('No .tf files found at that location');
  const files = await Promise.all(wanted.map(async (t) => {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${t.path.split('/').map(encodeURIComponent).join('/')}`);
    if (!res.ok) throw new Error(`Failed to fetch ${t.path}: ${res.status}`);
    return { path: t.path, content: await res.text() };
  }));
  return { owner, repo, branch, files, truncated: tree.truncated };
}
