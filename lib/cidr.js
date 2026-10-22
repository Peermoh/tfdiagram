// Finds the IP ranges a resource declares, following var.* / local.* values and evaluating cidrsubnet().

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
function substitute(text, scope, lookup, depth = 0) {
  if (depth > 4) return text;
  return text.replace(/\b(var|local)\.([A-Za-z_][\w-]*)/g, (whole, kind, name) => {
    const v = lookup(kind, name, scope);
    return v ? `(${substitute(v.expr, v.scope, lookup, depth + 1)})` : whole;
  });
}

export function resolveCidrs(expr, scope, lookup) {
  let text = substitute(expr, scope, lookup).replace(/\(\s*(\d+)\s*\)/g, '$1'); // (8) -> 8: substituted numbers arrive parenthesised
  const out = [];
  // cidrsubnet("10.0.0.0/16", 8, 1) -> 10.0.1.0/24; with an unknown index we can still say the size
  text = text.replace(/cidrsubnet\(\s*\(*\s*"((?:\d{1,3}\.){3}\d{1,3}\/\d{1,2})"\s*\)*\s*,\s*(\d+)\s*,\s*([^)]*?)\s*\)/g, (whole, base, bits, num) => {
    const r = /^\d+$/.test(num) ? cidrsubnet(base, Number(bits), Number(num)) : null;
    out.push(r ?? `/${Number(base.split('/')[1]) + Number(bits)} of ${base}`);
    return ' ';
  });
  out.push(...(text.match(V4) ?? []));
  return out;
}
