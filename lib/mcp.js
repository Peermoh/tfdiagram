// A small MCP server (Streamable HTTP, stateless) so people can connect TFDiagram to their own AI app
// (Claude, etc.). Their AI does the reasoning on their own plan; this site only parses Terraform.
import { handleApi } from './api.js';
import { friendlyType } from '../public/render.js';
import { fetchRepoFiles, buildExplainResponse } from './repoapi.js';

const SERVER = { name: 'tfdiagram', version: '1.0.0' };
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_RESOURCES = 150;
const MAX_LINKS = 250;

const inputProps = {
  folder: { type: 'string', description: 'Folder inside the repository to analyse; "*" for every folder. Omit to auto-pick.' },
  variables: { type: 'string', description: 'Optional variable values, one `name = value` per line (tfvars syntax), applied to the top-level module.' },
};
const TOOLS = [
  {
    name: 'analyze_terraform_repo',
    description: 'Parse the Terraform (AWS or Azure) in a public GitHub repository and return its architecture: resources by layer with file:line and CIDRs, how they connect, security group rules, rule-based findings, and a link to the interactive diagram. Follows local, registry and GitHub modules.',
    inputSchema: { type: 'object', properties: { repo_url: { type: 'string', description: 'https://github.com/owner/repo or .../tree/branch/folder' }, ...inputProps }, required: ['repo_url'] },
  },
  {
    name: 'analyze_terraform_code',
    description: 'Same as analyze_terraform_repo, for Terraform code pasted as text (one or more .tf files concatenated).',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Terraform source' }, variables: inputProps.variables }, required: ['code'] },
  },
  {
    name: 'analyze_repo',
    description: 'Understand ANY code repository (not only Terraform) from a public GitHub URL: returns an extracted overview (README, folder structure, languages, frameworks, components, how they import each other, Docker / CI / Kubernetes / Terraform files, entry points, key file excerpts) plus a Mermaid diagram of the detected structure. Use it to write a clear explanation of what the repository does and how it fits together, and to draw a better diagram if you can.',
    inputSchema: { type: 'object', properties: { repo_url: { type: 'string', description: 'https://github.com/owner/repo or .../tree/branch/folder' } }, required: ['repo_url'] },
  },
  {
    name: 'get_repo_file',
    description: 'Return one text file of a public GitHub repository (up to about 60 KB), for example a file named in analyze_repo\'s overview.',
    inputSchema: { type: 'object', properties: { repo_url: { type: 'string' }, path: { type: 'string', description: 'file path inside the repository (or inside the folder of the URL)' } }, required: ['repo_url', 'path'] },
  },
  {
    name: 'get_resource_code',
    description: 'Return the Terraform block of one resource, as listed by analyze_terraform_repo / analyze_terraform_code (use its id, e.g. aws_lb.alb or module.net.aws_vpc.this).',
    inputSchema: { type: 'object', properties: { resource_id: { type: 'string' }, repo_url: { type: 'string' }, code: { type: 'string' }, ...inputProps }, required: ['resource_id'] },
  },
];

async function load(args, env, origin) {
  const vars = typeof args.variables === 'string' ? args.variables : '';
  let req;
  if (args.repo_url) {
    const q = new URLSearchParams({ repo: args.repo_url });
    if (args.folder !== undefined) q.set('root', args.folder);
    if (vars) q.set('vars', vars.slice(0, 4000));
    req = new Request(`${origin}/api/diagram?${q}`);
  } else if (args.code) {
    req = new Request(`${origin}/api/diagram`, { method: 'POST', body: JSON.stringify({ code: String(args.code), vars }) });
  } else throw new Error('Give repo_url or code');
  const res = await handleApi(req, env);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `analysis failed (${res.status})`);
  return data;
}

const nodeLine = (n) => `- ${n.id} — ${friendlyType(n.type)}${n.label && n.label !== n.name ? ` "${n.label}"` : ''}${n.instances > 1 ? ` ×${n.instances}` : ''}${n.countInfo ? ` [${n.countInfo.mode} = ${n.countInfo.expr} → ${n.countInfo.n ?? '? (could not be worked out)'}]` : ''}${n.cidrs?.length ? ` [${n.cidrs.join(', ')}]` : ''}${n.summary ? ` (${n.summary})` : ''}${n.inactive ? ' (count = 0, not created)' : ''}${n.file ? ` — ${n.file}${n.line ? `:${n.line}` : ''}` : ''}`;

function findings(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.details?.kind !== 'rules') continue;
    for (const r of n.details.rows) {
      if (r.dir !== 'in' || /deny/i.test(r.action ?? '')) continue;
      const world = r.peers.some((p) => p === '0.0.0.0/0' || p === '::/0');
      if (!world) continue;
      const ports = r.ports || 'all';
      if (/^(80|443)$/.test(ports) && /tcp/i.test(r.proto || 'tcp')) continue;
      out.push(`${/^all$/i.test(ports) || /-1|all/i.test(r.proto ?? '') ? 'HIGH' : 'MEDIUM'}: ${n.id} allows inbound ${r.proto || 'all'} ${ports} from the whole internet${n.file ? ` (${n.file}${n.line ? `:${n.line}` : ''})` : ''}`);
    }
  }
  return out;
}

function report(data, origin, args) {
  const nodes = data.graph.nodes.filter((n) => !(n.kind === 'module' && n.expanded));
  const modules = data.graph.nodes.filter((n) => n.kind === 'module' && n.expanded);
  const L = [];
  const where = data.owner ? `${data.owner}/${data.repo}@${data.branch}${data.root ? `/${data.root}` : ''}` : 'pasted code';
  L.push(`# Terraform architecture: ${where}`);
  L.push(`Cloud: ${data.graph.provider === 'azure' ? 'Azure' : 'AWS'} · ${nodes.filter((n) => n.kind === 'resource').length} resources · ${modules.length} expanded modules · ${data.graph.edges.length} dependencies`);
  if (data.dirs?.length > 1) L.push(`Folders with Terraform (pass one as "folder", or "*" for all): ${data.dirs.slice(0, 25).map((d) => d.dir || '(top level)').join(', ')}`);
  L.push('', '## Checks', ...data.checks.map((c) => `- [${c.level}] ${c.text}`));
  const byLayer = new Map();
  for (const n of nodes) { if (!byLayer.has(n.category)) byLayer.set(n.category, []); byLayer.get(n.category).push(n); }
  L.push('', `## Resources (id — type — details — file:line)${nodes.length > MAX_RESOURCES ? ` (first ${MAX_RESOURCES} of ${nodes.length})` : ''}`);
  let shown = 0;
  for (const [cat, list] of byLayer) {
    L.push(`### ${cat}`);
    for (const n of list) { if (shown++ < MAX_RESOURCES) L.push(nodeLine(n)); }
  }
  const real = data.graph.edges.filter((e) => !e.ordering);
  L.push('', `## Connections (consumer uses provider)${real.length > MAX_LINKS ? ` (first ${MAX_LINKS} of ${real.length})` : ''}`);
  for (const e of real.slice(0, MAX_LINKS)) L.push(`- ${e.from} → ${e.to}${e.weak ? ' (indirect)' : ''}`);
  const ordering = data.graph.edges.filter((e) => e.ordering);
  if (ordering.length) L.push(`(${ordering.length} more links are only depends_on ordering)`);
  const rules = nodes.filter((n) => n.details?.kind === 'rules' && n.details.rows.length);
  if (rules.length) {
    L.push('', '## Security group / NSG rules');
    for (const n of rules.slice(0, 40)) {
      L.push(`### ${n.id}`);
      for (const r of n.details.rows.slice(0, 20)) L.push(`- ${r.dir === 'in' ? 'inbound' : 'outbound'} ${r.action ?? 'Allow'} ${r.proto || 'all'} ${r.ports || 'all'} ${r.dir === 'in' ? 'from' : 'to'} ${r.peers.join(', ') || '—'}${r.note ? ` (${r.note})` : ''}`);
    }
  }
  const f = findings(nodes);
  L.push('', '## Rule-based findings', ...(f.length ? f.map((x) => `- ${x}`) : ['- No inbound rule open to the whole internet other than 80/443 was found. (This is not a full security review.)']));
  L.push('', 'Notes: values come from defaults, terraform.tfvars and any "variables" given; resources whose count/for_each works out to 0 are omitted. Connections are references in the code, not proof of network reachability.');
  if (args.repo_url) L.push(`Interactive diagram: ${origin}/?repo=${encodeURIComponent(args.repo_url)}${args.folder ? `&root=${encodeURIComponent(args.folder)}` : ''}`);
  return L.join('\n');
}

function blockOf(text, line) {
  const lines = text.split('\n');
  let depth = 0; let seen = false;
  for (let i = line - 1; i < lines.length; i++) {
    const t = lines[i].replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/(#|\/\/).*$/, '');
    for (const c of t) { if (c === '{') { depth++; seen = true; } else if (c === '}') depth--; }
    if (seen && depth <= 0) return [line, i + 1];
  }
  return [line, Math.min(lines.length, line + 40)];
}

async function callTool(name, args, env, origin) {
  if (name === 'analyze_terraform_repo' || name === 'analyze_terraform_code') return report(await load(args, env, origin), origin, args);
  if (name === 'analyze_repo') {
    const r = await fetchRepoFiles(String(args.repo_url ?? ''), env.GITHUB_TOKEN);
    const out = buildExplainResponse({ name: r.name, files: r.files, tree: r.tree, truncated: r.truncated });
    const m = out.model;
    return [`# Overview of ${r.name} (${r.branch})${r.truncated ? ' — a large repository, only part of its text was read' : ''}`,
      '', '## Summary (assembled from the files, no AI)', ...m.explanation.map((p) => `- ${p}`),
      '', '## Diagram of the detected structure (Mermaid; dashed arrows are inferred, not read from the code)', '```mermaid', out.mermaid, '```',
      '', out.context.slice(0, 26000),
      '', 'Use this to explain what the repository does, how it is organised, how the pieces work together and how to run it. Say which statements are guesses.'].join('\n');
  }
  if (name === 'get_repo_file') {
    const r = await fetchRepoFiles(String(args.repo_url ?? ''), env.GITHUB_TOKEN);
    const want = String(args.path ?? '').replace(/^\/+/, '');
    const f = r.files.find((x) => x.path === want) ?? r.files.find((x) => x.path.toLowerCase() === want.toLowerCase());
    if (!f) throw new Error(`No file "${want}". Paths look like src/index.js (relative to ${r.name}).`);
    return `${f.path}\n\n${f.content.slice(0, 60000)}${f.content.length > 60000 ? '\n… (truncated)' : ''}`;
  }
  if (name === 'get_resource_code') {
    const data = await load(args, env, origin);
    const n = data.graph.nodes.find((x) => x.id === args.resource_id);
    if (!n) throw new Error(`No resource "${args.resource_id}". Ids look like aws_lb.alb or module.net.aws_vpc.this.`);
    const text = data.sources?.find((f) => f.path === n.file)?.content;
    if (!text || !n.line) throw new Error(`The code for ${n.id} is not available (${n.file ?? 'unknown file'}).`);
    const [a, b] = blockOf(text, n.line);
    return `${n.file}:${a}-${b}\n\n${text.split('\n').slice(a - 1, b).join('\n')}`;
  }
  throw new Error(`Unknown tool ${name}`);
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-session-id, authorization', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...CORS, ...(body === null ? {} : { 'content-type': 'application/json' }), 'cache-control': 'no-store' } });

async function rpc(msg, env, origin) {
  const { id, method, params } = msg ?? {};
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (id === undefined) return null;                                           // a notification: no reply
  if (method === 'initialize') {
    const v = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
    return { jsonrpc: '2.0', id, result: { protocolVersion: v, capabilities: { tools: {} }, serverInfo: SERVER, instructions: 'Parses Terraform (AWS/Azure) into an architecture description. Start with analyze_terraform_repo or analyze_terraform_code, then use get_resource_code for details.' } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    if (!TOOLS.some((t) => t.name === params?.name)) return err(-32602, `Unknown tool ${params?.name}`);
    try {
      const text = await callTool(params.name, params.arguments ?? {}, env, origin);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } };
    }
  }
  return err(-32601, `Method not found: ${method}`);
}

export async function handleMcp(request, env = {}) {
  if (request.method === 'OPTIONS') return reply(null, 204);
  if (request.method !== 'POST') return reply({ error: 'This MCP endpoint accepts POST (Streamable HTTP, stateless).' }, 405);
  const origin = new URL(request.url).origin;
  let body;
  try { body = JSON.parse(await request.text()); } catch { return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => rpc(m, env, origin)))).filter(Boolean);
    return out.length ? reply(out) : reply(null, 202);
  }
  const out = await rpc(body, env, origin);
  return out ? reply(out) : reply(null, 202);
}
