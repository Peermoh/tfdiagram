// Terraform also comes as JSON: `*.tf.json` (the configuration itself) and `*.tfvars.json` (values). Both are converted to
// the HCL text the rest of the app already understands, so everything downstream stays the same.

export const isTfFile = (path) => /\.tf(\.json)?$/i.test(path);

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const IDENT = /^[A-Za-z_][\w-]*$/;
// object-valued arguments that are maps (attributes), not nested blocks
const MAP_KEYS = /^(tags|tags_all|labels|annotations|metadata|variables|environment_variables|parameters|settings|config|extra_tags|default_tags|triggers|inputs|default)$/i;

function value(v, pad = '') {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    const m = /^\$\{([^{}]*)\}$/.exec(v);              // "${var.x}" is just the expression var.x
    return m ? m[1] : JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    const items = v.map((x) => value(x, `${pad}  `));
    const flat = `[${items.join(', ')}]`;
    return flat.length <= 90 && !flat.includes('\n') ? flat : `[\n${items.map((x) => `${pad}  ${x},`).join('\n')}\n${pad}]`;
  }
  return `{\n${Object.entries(v).map(([k, x]) => `${pad}  ${IDENT.test(k) ? k : JSON.stringify(k)} = ${value(x, `${pad}  `)}`).join('\n')}\n${pad}}`;
}

// resource / data / provider bodies: arrays of objects and plain objects are nested blocks, except known map arguments
function body(obj, pad = '  ') {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (Array.isArray(v) && v.length && v.every(isObj) && !MAP_KEYS.test(k)) {
      for (const item of v) out.push(`${pad}${k} {\n${body(item, `${pad}  `)}\n${pad}}`);
    } else if (isObj(v) && !MAP_KEYS.test(k)) out.push(`${pad}${k} {\n${body(v, `${pad}  `)}\n${pad}}`);
    else out.push(`${pad}${k} = ${value(v, pad)}`);
  }
  return out.join('\n');
}
const attrs = (obj, pad = '  ') => Object.entries(obj ?? {}).map(([k, v]) => `${pad}${IDENT.test(k) ? k : JSON.stringify(k)} = ${value(v, pad)}`).join('\n');
const each = (v) => (Array.isArray(v) ? v : [v]);

export function tfJsonToHcl(doc) {
  const out = [];
  for (const [kind, v] of Object.entries(doc ?? {})) {
    if (!isObj(v) && !Array.isArray(v)) continue;
    if (kind === 'locals') for (const l of each(v)) out.push(`locals {\n${attrs(l)}\n}`);
    else if (kind === 'variable' || kind === 'output' || kind === 'module') {
      for (const group of each(v)) for (const [name, b] of Object.entries(group)) for (const one of each(b)) out.push(`${kind} ${JSON.stringify(name)} {\n${attrs(one)}\n}`);
    } else if (kind === 'resource' || kind === 'data') {
      for (const group of each(v)) for (const [type, names] of Object.entries(group)) for (const [name, b] of Object.entries(names)) for (const one of each(b)) out.push(`${kind} ${JSON.stringify(type)} ${JSON.stringify(name)} {\n${body(one)}\n}`);
    } else if (kind === 'provider') {
      for (const group of each(v)) for (const [name, b] of Object.entries(group)) for (const one of each(b)) out.push(`provider ${JSON.stringify(name)} {\n${body(one)}\n}`);
    }
  }
  return out.join('\n\n');
}

export const tfvarsJsonToHcl = (doc) => attrs(doc, '');

// Does this pasted text look like Terraform JSON? -> { kind: 'tf' | 'vars', text } (HCL), or null
export function fromPastedJson(text) {
  const t = String(text).trim();
  if (!t.startsWith('{')) return null;
  let doc;
  try { doc = JSON.parse(t); } catch { return null; }
  if (!isObj(doc)) return null;
  const isTf = Object.keys(doc).some((k) => /^(resource|data|module|variable|locals|output|provider)$/.test(k)) && Object.entries(doc).every(([k, v]) => !/^(resource|data|module|variable|output|provider)$/.test(k) || isObj(v) || Array.isArray(v));
  return isTf ? { kind: 'tf', text: tfJsonToHcl(doc) } : { kind: 'vars', text: tfvarsJsonToHcl(doc) };
}

// A project file as { path, content }: JSON variants are converted, anything else is returned unchanged. null = unreadable JSON.
export function normalizeFile(file) {
  if (!/\.json$/i.test(file.path)) return file;
  try {
    const doc = JSON.parse(file.content);
    const text = /\.tfvars\.json$/i.test(file.path) ? tfvarsJsonToHcl(doc) : tfJsonToHcl(doc);
    return { ...file, content: `# converted from ${file.path.split('/').pop()}\n${text}\n` };
  } catch { return null; }
}
