// Finds the IP ranges a resource declares, following var.* / local.* values and evaluating cidrsubnet().

import { simplify } from './details.js';   // (a cycle with details.js is fine: both only call each other at run time)

const V4 = /\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/g;

const toInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const toIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

// Terraform's cidrsubnet(prefix, newbits, netnum) for IPv4; null if it doesn't fit.
export function cidrsubnet(cidr, newbits, netnum) {
  const [ip, len] = cidr.split('/');
  const bits = Number(len) + newbits;
  if (bits > 32 || netnum >= 2 ** newbits) return null;
  const base = Math.floor(toInt(ip) / 2 ** (32 - Number(len))) * 2 ** (32 - Number(len));
  return `${toIp(base + netnum * 2 ** (32 - bits))}/${bits}`;
}

// lookup(kind, name, scope) -> { expr, scope } | undefined, where kind is 'var' or 'local'.
export function substitute(text, scope, lookup, depth = 0) {
  if (depth > 4) return text;
  return text.replace(/\b(var|local)\.([A-Za-z_][\w-]*)/g, (whole, kind, name) => {
    const v = lookup(kind, name, scope);
    return v ? `(${substitute(v.expr, v.scope, lookup, depth + 1)})` : whole;
  });
}

// Integer arithmetic with + - * and parentheses; null for anything else.
export function arith(text) {
  const t = String(text).replace(/\s+/g, '');
  if (!/^[\d+\-*()]+$/.test(t)) return null;
  let i = 0;
  const factor = () => {
    if (t[i] === '(') { i++; const v = expr(); if (t[i++] !== ')') throw new Error('x'); return v; }
    if (t[i] === '-') { i++; return -factor(); }
    const m = /^\d+/.exec(t.slice(i));
    if (!m) throw new Error('x');
    i += m[0].length;
    return Number(m[0]);
  };
  const term = () => { let v = factor(); while (t[i] === '*') { i++; v *= factor(); } return v; };
  const expr = () => { let v = term(); while (t[i] === '+' || t[i] === '-') { const op = t[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; };
  try { const v = expr(); return i === t.length ? v : null; } catch { return null; }
}

// Top-level comma split (outside strings and brackets).
function splitItems(inner) {
  const parts = []; let depth = 0; let str = false; let from = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true; else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(inner.slice(from, i)); from = i + 1; }
  }
  parts.push(inner.slice(from));
  return parts.filter((x) => x.trim() !== '');
}

const unparen = (t) => { let x = t.trim(); while (x.startsWith('(') && x.endsWith(')')) x = x.slice(1, -1).trim(); return x; };

// How many items a list expression has, when that is knowable: ["a","b"], slice(x, 0, 3), range(3).
export function listLength(expr) {
  const t = unparen(simplify(expr));                              // a conditional such as `x == null ? [] : [...]` is resolved first
  const loop = /^[[{]\s*for\s+\w+\s*(?:,\s*\w+)?\s+in\s+([\s\S]*)[\]}]$/.exec(t);   // [for ...] and { for ... => ... } have as many items as what they loop over
  if (loop) { const parts = splitTopColon(loop[1]); return parts && !/\bif\b/.test(parts[1]) ? listLength(parts[0]) : null; }   // [for k, v in LIST : ...] has as many items as LIST
  if (t.startsWith('[') && t.endsWith(']')) { const inner = t.slice(1, -1).trim(); return inner === '' ? 0 : splitItems(inner).length; }
  if (t === '{}') return 0;                                       // an empty map
  const wrap = /^(?:tolist|toset|tomap)\(([\s\S]*)\)$/.exec(t);
  if (wrap) return listLength(wrap[1]);
  const flat = /^flatten\(([\s\S]*)\)$/.exec(t);                    // flatten of nothing is nothing
  if (flat) return listLength(flat[1]) === 0 ? 0 : null;
  const tr = /^try\(([\s\S]*)\)$/.exec(t);                          // try(a, b): empty either way -> empty
  if (tr) {
    const [a, b] = splitItems(tr[1]);
    const [la, lb] = [a === undefined ? null : listLength(a), b === undefined ? null : listLength(b)];
    return la === 0 && lb === 0 ? 0 : la !== null && la > 0 ? la : null;
  }
  const cat = /^concat\(([\s\S]*)\)$/.exec(t);                      // concat(a, b): the lists end to end
  if (cat) {
    const lens = splitItems(cat[1]).map((a) => listLength(a));
    return lens.length && lens.every((n) => n !== null) ? lens.reduce((a, n) => a + n, 0) : null;
  }
  let m = /^slice\(([\s\S]*),\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(t);
  if (m) return Number(m[3]) - Number(m[2]);
  m = /^range\(\s*(\d+)\s*\)$/.exec(t);
  if (m) return Number(m[1]);
  return null;
}

// cidrsubnet() calls with known numbers become ranges; with an unknown index they say the size ("/24 of 10.0.0.0/16").
function core(text) {
  const out = [];
  const rest = text.replace(/cidrsubnet\(\s*\(*\s*"((?:\d{1,3}\.){3}\d{1,3}\/\d{1,2})"\s*\)*\s*,\s*([^,]*?)\s*,\s*([^)]*?)\s*\)/g, (whole, base, bitsExpr, numExpr) => {
    const bits = arith(bitsExpr);
    const num = arith(numExpr);
    const r = bits !== null && num !== null ? cidrsubnet(base, bits, num) : null;
    out.push(r ?? (bits !== null ? `/${Number(base.split('/')[1]) + bits} of ${base}` : base));
    return ' ';
  });
  out.push(...(rest.match(V4) ?? []));
  return out;
}

// [for k, v in LIST : cidrsubnet(base, bits, k + 48)] -> ["10.0.48.0/24", ...] when LIST's length is known.
export function expandFor(text) {
  let out = text;
  for (let guard = 0; guard < 20; guard++) {
    const start = out.search(/\[\s*for\b/);
    if (start < 0) break;
    let depth = 0; let str = false; let end = -1;
    for (let i = start; i < out.length; i++) {
      const c = out[i];
      if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
      if (c === '"') str = true; else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c) && --depth === 0) { end = i; break; }
    }
    if (end < 0) break;
    const inner = out.slice(start + 1, end);
    const head = /^\s*for\s+([A-Za-z_]\w*)\s*(?:,\s*([A-Za-z_]\w*))?\s+in\s+/.exec(inner);
    let replacement = null;
    if (head) {
      const rest = inner.slice(head[0].length);
      const parts = splitTopColon(rest);
      const n = parts ? listLength(parts[0]) : null;
      const [index, value] = head[2] ? [head[1], head[2]] : [null, head[1]];
      const body = parts?.[1] ?? '';
      const usesValue = new RegExp(`\\b${value}\\b`).test(body);
      if (parts && n !== null && n <= 64 && !/\bif\b/.test(body) && !usesValue) {
        const found = [];
        for (let i = 0; i < n; i++) found.push(...core((index ? body.replace(new RegExp(`\\b${index}\\b`, 'g'), String(i)) : body).replace(/\(\s*(\d+)\s*\)/g, '$1')));
        if (found.length && !found.some((f) => f.startsWith('/'))) replacement = `[${found.map((f) => JSON.stringify(f)).join(', ')}]`;
      }
    }
    // an expression we can't expand is left alone (marked so the loop moves on)
    out = out.slice(0, start) + (replacement ?? `[«${out.slice(start + 1, end)}]`) + out.slice(end + 1);
  }
  return out.replace(/\[«/g, '[');
}

function splitTopColon(t) {
  let depth = 0; let str = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true; else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    else if (c === ':' && depth === 0) return [t.slice(0, i), t.slice(i + 1)];
  }
  return null;
}

export function resolveCidrs(expr, scope, lookup) {
  const text = expandFor(substitute(expr, scope, lookup).replace(/\(\s*(\d+)\s*\)/g, '$1')); // (8) -> 8: substituted numbers arrive parenthesised
  return core(text);
}
