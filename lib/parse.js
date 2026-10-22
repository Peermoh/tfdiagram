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
    // comments are blanked rather than removed so offsets (and therefore line numbers) stay valid
    if (c === '#' || (c === '/' && n === '/')) {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  ';
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

const HEADER = /^[ \t]*(?:(resource|data|module|variable|output|provider)\s+((?:"[^"]*"\s*)+|[A-Za-z_][\w-]*\s*)|(locals)\s*)\{/gm;

export function parseTerraform(source) {
  const src = stripComments(source);
  const blocks = [];
  HEADER.lastIndex = 0;
  let m;
  while ((m = HEADER.exec(src))) {
    const labels = m[2] ? [...m[2].matchAll(/"([^"]*)"|([A-Za-z_][\w-]*)/g)].map((x) => x[1] ?? x[2]) : [];
    const open = m.index + m[0].length - 1;
    const end = matchBrace(src, open);
    blocks.push({ kind: m[1] ?? m[3], labels, line: src.slice(0, m.index).split('\n').length, body: src.slice(open + 1, end - 1) });
    HEADER.lastIndex = end;
  }
  return blocks;
}

// Splits the body of a `locals` block into { name: expressionText } (top-level attributes only).
export function parseLocals(body) {
  const out = {};
  let name = null;
  let depth = 0;
  for (const line of body.split('\n')) {
    const m = depth === 0 && /^\s*([A-Za-z_][\w-]*)\s*=(.*)$/.exec(line);
    if (m) { name = m[1]; out[name] = m[2]; } else if (name) out[name] += '\n' + line;
    depth += (line.match(/[{[(]/g) ?? []).length - (line.match(/[}\])]/g) ?? []).length;
    if (depth < 0) depth = 0;
  }
  return out;
}
