// Azure DevOps repository URLs, and (with a personal access token) downloading a repo as a zip through its REST API.
import { unzipTerraform, textPath } from '../public/unzip.js';

// https://dev.azure.com/{org}/{project}/_git/{repo}[?path=/dir&version=GBbranch]
// https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
// https://{user}@dev.azure.com/{org}/{project}/_git/{repo}   (the "clone" form)
export function parseAdoUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  let org; let project; let repo;
  if (u.hostname === 'dev.azure.com') {
    const i = parts.indexOf('_git');
    if (i !== 2 || !parts[3]) return null;
    [org, project, repo] = [parts[0], parts[1], parts[3]];
  } else if (u.hostname.endsWith('.visualstudio.com')) {
    org = u.hostname.replace(/\.visualstudio\.com$/, '');
    const rest = parts[0]?.toLowerCase() === 'defaultcollection' ? parts.slice(1) : parts;
    const i = rest.indexOf('_git');
    if (i !== 1 || !rest[2]) return null;
    [project, repo] = [rest[0], rest[2]];
  } else return null;
  const version = u.searchParams.get('version') ?? '';
  const branch = /^GB(.+)$/.exec(version)?.[1] ?? /^GT(.+)$/.exec(version)?.[1] ?? '';   // branch or tag; a commit (GC) is not supported
  const path = (u.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
  // a file link (…?path=/dev/stack.json) means: draw its folder
  const dir = /\.[A-Za-z0-9]+$/.test(path) ? path.split('/').slice(0, -1).join('/') : path;
  return { org, project, repo, branch, path: dir, cloneUrl: `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}` };
}

// zip of the whole repo (or one branch) through the REST API, authenticated with a PAT (Code: Read)
export async function fetchAdoZip(ado, pat, fetchFn = fetch, all = false) {
  const q = new URLSearchParams({ 'api-version': '7.1', path: '/', recursionLevel: 'Full', download: 'true', $format: 'zip' });
  if (ado.branch) { q.set('versionDescriptor.version', ado.branch); q.set('versionDescriptor.versionType', 'branch'); }
  const url = `https://dev.azure.com/${encodeURIComponent(ado.org)}/${encodeURIComponent(ado.project)}/_apis/git/repositories/${encodeURIComponent(ado.repo)}/items?${q}`;
  const res = await fetchFn(url, { headers: { authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, 'user-agent': 'tfdiagram' } });
  if (res.status === 401 || res.status === 403) throw new Error(`Azure DevOps refused the token (${res.status}). It needs the "Code: Read" scope for ${ado.org}, and must not be expired.`);
  if (res.status === 404) throw new Error(`Azure DevOps cannot find ${ado.project}/${ado.repo}${ado.branch ? ` on ${ado.branch}` : ''}. Check the link, and that the token belongs to the ${ado.org} organisation.`);
  if (!res.ok) throw new Error(`Azure DevOps answered ${res.status}`);
  const buf = await res.arrayBuffer();
  return all ? unzipTerraform(buf, { accept: textPath, maxFiles: 5000, maxFile: 300_000, maxTotal: 14_000_000 }) : unzipTerraform(buf, { maxFiles: 5000, maxFile: 500_000, maxTotal: 25_000_000 });
}
