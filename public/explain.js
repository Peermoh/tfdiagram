// Pure helpers for the "Explain a repository" page (shared by the browser, the MCP server and the tests).

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const GROUPS = [
  ['users', 'Users', '#64748b'], ['frontend', 'Frontend', '#2563eb'], ['backend', 'Backend', '#16a34a'], ['library', 'Libraries and shared code', '#8b5cf6'],
  ['support', 'Support: tests, scripts, tooling', '#94a3b8'], ['content', 'Content and documentation', '#0d9488'], ['data', 'Data and external services', '#d97706'], ['infra', 'Delivery and infrastructure', '#0ea5e9'],
];

// ---- Mermaid text for a diagram model { nodes: [{id,label,group,sub}], edges: [{from,to,label,inferred}] }
export function repoMermaid(diagram) {
  const id = new Map(diagram.nodes.map((n, i) => [n.id, `n${i}`]));
  const lab = (s) => String(s).replace(/["[\]{}()<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = ['flowchart LR'];
  for (const [key, title] of GROUPS) {
    const list = diagram.nodes.filter((n) => n.group === key);
    if (!list.length) continue;
    out.push(`  subgraph ${key}["${lab(title)}"]`);
    for (const n of list) out.push(`    ${id.get(n.id)}["${lab(n.label)}${n.sub ? `<br/><small>${lab(n.sub)}</small>` : ''}"]`);
    out.push('  end');
  }
  for (const e of diagram.edges) if (id.has(e.from) && id.has(e.to)) out.push(`  ${id.get(e.from)} ${e.inferred ? '-.->' : '-->'}${e.label ? `|${lab(e.label)}|` : ''} ${id.get(e.to)}`);
  return out.join('\n');
}

// ---- the prompt for "Explain with AI": explanation first, then a diagram as JSON that the page draws itself
export function buildAiPrompt(context) {
  const system = 'You explain software repositories to someone new to them. Be concrete and honest: only claim what the material supports and say when something is a guess.';
  const user = `Below is an automatically extracted overview of a code repository (README, folder structure, manifests, detected components and imports, infrastructure files, and key files).

${context}

---
Write the answer in two parts.

PART 1, the explanation, in Markdown, with these sections:
## What it is
## How it is organised   (the main parts and what each does)
## How the pieces work together   (the main flows: a request, a job, or a build; name the actual files)
## How to run it   (only from commands in the material)
## Things worth knowing   (data stores, integrations, deployment, risks or oddities)
Keep it clear and under about 700 words. Use file and folder names from the material.

PART 2, the architecture diagram, as JSON inside <diagram> and </diagram> tags, nothing else inside the tags:
{"nodes":[{"id":"short_id","label":"Name","group":"users|frontend|backend|library|support|content|data|infra","sub":"one short line"}],
 "edges":[{"from":"id","to":"id","label":"short verb or protocol","inferred":false}]}
Rules: at most 22 nodes; every edge must use ids that exist; groups must be exactly one of the listed words; set "inferred": true for connections you are guessing rather than reading from the material; arrows point from the caller or dependent to what it uses; keep labels under 24 characters.`;
  return { system, user };
}

// ---- validate a diagram returned by the model
export function validateDiagram(d) {
  if (!d || !Array.isArray(d.nodes) || !d.nodes.length) return null;
  const groups = new Set(GROUPS.map((g) => g[0]));
  const nodes = []; const seen = new Set();
  for (const n of d.nodes.slice(0, 40)) {
    const id = String(n?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label: String(n.label ?? id).slice(0, 40), group: groups.has(n.group) ? n.group : 'library', sub: String(n.sub ?? '').slice(0, 48), kind: n.group === 'content' ? 'docs' : n.group === 'data' ? 'external' : n.group === 'users' ? 'users' : n.group === 'frontend' ? 'frontend' : n.group === 'backend' ? 'backend' : n.group === 'infra' ? 'infra' : 'library' });
  }
  const edges = (Array.isArray(d.edges) ? d.edges : []).filter((e) => seen.has(String(e?.from)) && seen.has(String(e?.to)) && e.from !== e.to).slice(0, 80)
    .map((e) => ({ from: String(e.from), to: String(e.to), label: String(e.label ?? '').slice(0, 28), inferred: Boolean(e.inferred) }));
  return nodes.length ? { nodes, edges } : null;
}

// split the model's reply into { markdown, diagram }
export function parseAiReply(text) {
  const m = /<diagram>([\s\S]*?)(?:<\/diagram>|$)/i.exec(text);
  let diagram = null;
  if (m) {
    const raw = m[1].replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    try { diagram = validateDiagram(JSON.parse(raw)); } catch { diagram = null; }
  }
  const markdown = text.replace(/<diagram>[\s\S]*?(?:<\/diagram>|$)/i, '').replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, diagram };
}

// ---- a very small, safe Markdown renderer (headings, lists, code, bold, inline code, links to nowhere)
export function mdToHtml(md) {
  const lines = String(md).replace(/\r/g, '').split('\n');
  const out = []; let list = null; let code = null;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, '$1<i>$2</i>');
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const l of lines) {
    if (/^\s*```/.test(l)) { if (code === null) { close(); code = []; } else { out.push(`<pre class="code">${esc(code.join('\n'))}</pre>`); code = null; } continue; }
    if (code !== null) { code.push(l); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { close(); const n = Math.min(4, h[1].length + 1); out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(l); const oli = /^\s*\d+[.)]\s+(.*)$/.exec(l);
    if (li || oli) { const kind = li ? 'ul' : 'ol'; if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline((li ?? oli)[1])}</li>`); continue; }
    if (!l.trim()) { close(); continue; }
    close(); out.push(`<p>${inline(l)}</p>`);
  }
  if (code !== null) out.push(`<pre class="code">${esc(code.join('\n'))}</pre>`);
  close();
  return out.join('\n');
}
