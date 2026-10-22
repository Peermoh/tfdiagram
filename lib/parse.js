// Minimal HCL block extractor: finds top-level resource/data/module/variable/output
// blocks and the text of their bodies. Not a full HCL parser; references are found
// by pattern matching in graph.js.

function stripComments(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '#' || (c === '/' && n === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Returns the index just past the closing brace matching the "{" at `start`.
function matchBrace(src, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return src.length;
}

const HEADER = /^[ \t]*(resource|data|module|variable|output|provider)\s+((?:"[^"]*"\s*)+|[A-Za-z_][\w-]*\s*)\{/gm;

export function parseTerraform(source) {
  const src = stripComments(source);
  const blocks = [];
  HEADER.lastIndex = 0;
  let m;
  while ((m = HEADER.exec(src))) {
    const labels = [...m[2].matchAll(/"([^"]*)"|([A-Za-z_][\w-]*)/g)].map((x) => x[1] ?? x[2]);
    const open = m.index + m[0].length - 1;
    const end = matchBrace(src, open);
    blocks.push({ kind: m[1], labels, body: src.slice(open + 1, end - 1) });
    HEADER.lastIndex = end;
  }
  return blocks;
}
