import { parseTerraform } from './parse.js';

const MAX_DEPTH = 4;
const MAX_INSTANCES = 30;

// Resolves a relative path against a repo-relative directory. Returns null if it escapes the repo.
export function resolveDir(dir, rel) {
  const parts = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}

const isLocal = (src) => typeof src === 'string' && /^\.{1,2}(\/|$)/.test(src);

// Builds { dir, files, children: { moduleName: tree } } by following local module sources.
// readDir(dir) -> [{ path, content }] for the .tf files directly in that directory.
export async function loadTree(rootDir, readDir, { remote } = {}) {
  let instances = 0;
  const remoteDirs = new Map();                      // downloaded module folders ("@owner~repo~ref/..."), kept apart from the project
  const read = (d) => (d.startsWith('@') ? Promise.resolve(remoteDirs.get(d) ?? []) : readDir(d));
  async function load(dir, ancestors, depth) {
    const files = await read(dir);
    const tree = { dir, files, children: {} };
    if (depth >= MAX_DEPTH) return tree;
    for (const f of files) {
      for (const b of parseTerraform(f.content)) {
        if (b.kind !== 'module' || !b.labels[0]) continue;
        const src = /source\s*=\s*"([^"]+)"/.exec(b.body)?.[1];
        let target;
        if (isLocal(src)) {
          target = resolveDir(dir, src);
          if (dir.startsWith('@') && target !== null && target.split('/')[0] !== dir.split('/')[0]) continue;   // stay inside a downloaded module
        } else if (remote && src && instances < MAX_INSTANCES) {
          const r = await remote(src, /\bversion\s*=\s*"([^"]+)"/.exec(b.body)?.[1]);
          if (!r) continue;
          for (const [d, list] of r.dirs) remoteDirs.set(d, list);
          target = r.dir;
        } else continue;
        if (target === null || ancestors.has(target) || instances >= MAX_INSTANCES) continue;
        instances++;
        tree.children[b.labels[0]] = await load(target, new Set([...ancestors, target]), depth + 1);
      }
    }
    return tree;
  }
  return load(rootDir, new Set([rootDir]), 0);
}

export function allFiles(tree) {
  const seen = new Map();
  (function walk(t) {
    for (const f of t.files) if (!f.virtual) seen.set(f.path, f);
    Object.values(t.children ?? {}).forEach(walk);
  })(tree);
  return [...seen.values()];
}

const MAX_FOLDERS = 15;

// "All folders": every folder holding .tf files becomes a module of a virtual root, so one diagram
// shows them side by side. The virtual file only exists to hold those module blocks.
export async function loadAllFolders(dirs, readDir, limit = MAX_FOLDERS, opts) {
  const picked = dirs.slice(0, limit);
  const used = new Set();
  const children = {};
  const blocks = [];
  for (const { dir } of picked) {
    let name = (dir || 'root').replace(/[^A-Za-z0-9_-]+/g, '_');
    while (used.has(name)) name += '_';
    used.add(name);
    children[name] = await loadTree(dir, readDir, opts);
    blocks.push(`module "${name}" {\n  source = "./${dir}"\n}`);
  }
  const files = [{ path: '(all folders).tf', content: blocks.join('\n'), virtual: true }];
  return { tree: { dir: '*', files, children }, shown: picked.length, total: dirs.length };
}
