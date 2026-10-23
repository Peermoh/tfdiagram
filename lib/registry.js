// Opens modules that are not in the project: Terraform registry modules and GitHub sources are
// downloaded as one zip each (public repositories, or private ones the user's token can read).
import { unzipTerraform } from '../public/unzip.js';
import { downloadZip } from './zipdl.js';
import { isTfFile, normalizeFile } from './json.js';

const MAX_REPOS = 8;            // downloads per diagram (Workers allow 50 subrequests per request)
const SKIP = /(^|\/)(examples?|tests?|\.github|docs?|wrappers?|fixtures)(\/|$)/i;

// "terraform-aws-modules/vpc/aws//modules/x", "github.com/o/r", "git::https://github.com/o/r.git//sub?ref=v1"
export function classifySource(src) {
  if (typeof src !== 'string') return null;
  const gh = /^(?:git::)?(?:https:\/\/|ssh:\/\/git@|git@)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/\/([^?]*))?(?:\?ref=([^&]+))?$/.exec(src.trim());
  if (gh) return { type: 'github', owner: gh[1], repo: gh[2], subdir: (gh[3] ?? '').replace(/^\/|\/$/g, ''), ref: gh[4] };
  const reg = /^([A-Za-z0-9][\w-]*)\/([A-Za-z0-9][\w-]*)\/([A-Za-z0-9]+)(?:\/\/(.+))?$/.exec(src.trim());
  if (reg) return { type: 'registry', ns: reg[1], name: reg[2], provider: reg[3], subdir: (reg[4] ?? '').replace(/^\/|\/$/g, '') };
  return null;
}

const parts = (v) => { const p = String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0); while (p.length < 3) p.push(0); return p; };
const cmp = (a, b) => { const x = parts(a); const y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// Highest version satisfying a Terraform constraint such as "~> 5.0, < 5.5". No constraint = highest.
export function pickVersion(versions, constraint) {
  const ok = versions.filter((v) => /^v?\d+(\.\d+){0,2}$/.test(v));
  const rules = String(constraint ?? '').split(',').map((r) => r.trim()).filter(Boolean).map((r) => {
    const m = /^(~>|>=|<=|!=|=|>|<)?\s*v?(\d+(?:\.\d+){0,2})$/.exec(r);
    return m ? { op: m[1] ?? '=', v: m[2] } : null;
  });
  if (rules.includes(null)) return ok.sort(cmp).pop();
  const pass = (v) => rules.every(({ op, v: w }) => {
    const c = cmp(v, w);
    if (op === '=') return c === 0;
    if (op === '!=') return c !== 0;
    if (op === '>') return c > 0;
    if (op === '>=') return c >= 0;
    if (op === '<') return c < 0;
    if (op === '<=') return c <= 0;
    const n = w.split('.').length;                       // ~> 5.1 means >= 5.1, < 6.0; ~> 5.1.2 means >= 5.1.2, < 5.2.0
    const hi = parts(w);
    const up = n === 1 ? [hi[0] + 1, 0, 0] : n === 2 ? [hi[0] + 1, 0, 0] : [hi[0], hi[1] + 1, 0];
    return c >= 0 && cmp(v, up.join('.')) < 0;
  });
  return ok.filter(pass).sort(cmp).pop();
}

const headers = (token) => ({ 'user-agent': 'tfdiagram', ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function registryTarget(c, constraint) {
  const base = `https://registry.terraform.io/v1/modules/${c.ns}/${c.name}/${c.provider}`;
  const list = await fetch(`${base}/versions`, { headers: { 'user-agent': 'tfdiagram' } });
  if (!list.ok) throw new Error(`registry ${list.status}`);
  const all = (await list.json()).modules?.[0]?.versions?.map((v) => v.version) ?? [];
  const version = pickVersion(all, constraint);
  if (!version) throw new Error('no matching version');
  const dl = await fetch(`${base}/${version}/download`, { headers: { 'user-agent': 'tfdiagram' }, redirect: 'manual' });
  const get = dl.headers.get('x-terraform-get');
  const gh = classifySource(get ?? '');
  if (!gh || gh.type !== 'github') throw new Error('not hosted on GitHub');
  return { ...gh, ref: gh.ref ?? `v${version}`, version, subdir: c.subdir || gh.subdir };
}

// A resolver for loadTree: (source, versionConstraint) -> { dir, dirs: Map(dir -> files) } or null. Failures are listed in .problems.
export function makeRemoteResolver(token) {
  const repos = new Map();           // owner/repo@ref -> Promise<{ prefix, dirs }>
  const problems = [];
  const opened = [];
  const fetchRepo = (t) => {
    const key = `${t.owner}/${t.repo}@${t.ref ?? 'HEAD'}`;
    if (!repos.has(key)) {
      repos.set(key, (async () => {
        if (repos.size > MAX_REPOS) throw new Error(`more than ${MAX_REPOS} downloads in one diagram`);
        const { files } = await unzipTerraform(await downloadZip(t.owner, t.repo, t.ref, token), { maxFiles: 3000, maxTotal: 12_000_000 });
        const prefix = `@${t.owner}~${t.repo}~${String(t.ref ?? 'HEAD').replace(/[^\w.-]/g, '_')}`;
        const dirs = new Map();
        for (const f0 of files.filter((x) => isTfFile(x.path)).map(normalizeFile).filter(Boolean)) {
          const f = f0;
          const rel = f.path.split('/').slice(1).join('/');
          if (!rel || SKIP.test(rel)) continue;
          const dir = rel.includes('/') ? `${prefix}/${rel.slice(0, rel.lastIndexOf('/'))}` : prefix;
          dirs.set(dir, [...(dirs.get(dir) ?? []), { path: `${prefix}/${rel}`, content: f.content }]);
        }
        return { prefix, dirs };
      })());
    }
    return repos.get(key);
  };
  const resolve = async (src, constraint) => {
    const c = classifySource(src);
    if (!c) return null;
    try {
      const t = c.type === 'registry' ? await registryTarget(c, constraint) : c;
      const { prefix, dirs } = await fetchRepo(t);
      const dir = t.subdir ? `${prefix}/${t.subdir}` : prefix;
      if (!dirs.has(dir)) throw new Error(`no .tf files in ${t.subdir || 'the repository'}`);
      opened.push(`${src}${t.version ? ` ${t.version}` : ''}`);
      return { dir, dirs };
    } catch (e) {
      problems.push(`${src}: ${e.message}`);
      return null;
    }
  };
  resolve.problems = problems;
  resolve.opened = opened;
  return resolve;
}
