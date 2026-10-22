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
export async function loadTree(rootDir, readDir) {
  let instances = 0;
  async function load(dir, ancestors, depth) {
    const files = await readDir(dir);
    const tree = { dir, files, children: {} };
    if (depth >= MAX_DEPTH) return tree;
    for (const f of files) {
      for (const b of parseTerraform(f.content)) {
        if (b.kind !== 'module' || !b.labels[0]) continue;
        const src = /source\s*=\s*"([^"]+)"/.exec(b.body)?.[1];
        if (!isLocal(src)) continue;
        const target = resolveDir(dir, src);
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
    for (const f of t.files) seen.set(f.path, f);
    Object.values(t.children ?? {}).forEach(walk);
  })(tree);
  return [...seen.values()];
}
