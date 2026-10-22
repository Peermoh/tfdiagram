// Shared by the browser (diagram filtering + Mermaid output) and the tests.

const isContainer = (n) => n.kind === 'module' && n.expanded;

// opts: { scope: id of an expanded module to zoom into, collapse: fold expanded modules into one node,
//         layers: Set of categories (null = all), query: text filter, neighbors: also show one-hop
//         connections of the matches (dimmed) }
export function filterGraph(graph, { scope = '', collapse = false, layers = null, query = '', neighbors = false } = {}) {
  let nodes = graph.nodes.map((n) => ({ ...n }));
  let edges = graph.edges.map((e) => ({ ...e }));
  let byId = new Map(nodes.map((n) => [n.id, n]));

  if (scope) {
    const pre = `${scope}.`;
    nodes = nodes.filter((n) => n.id.startsWith(pre));
    nodes.forEach((n) => { if (n.parent === scope) n.parent = ''; });
    byId = new Map(nodes.map((n) => [n.id, n]));
  }

  if (collapse) {
    const top = (n) => {
      let t = null;
      for (let cur = byId.get(n.parent); cur; cur = byId.get(cur.parent)) t = cur;
      return t;
    };
    const rep = new Map(nodes.map((n) => [n.id, top(n)?.id ?? n.id]));
    const tops = new Set(nodes.filter((n) => isContainer(n) && rep.get(n.id) === n.id).map((n) => n.id));
    nodes = nodes.filter((n) => rep.get(n.id) === n.id);
    nodes.forEach((n) => { if (tops.has(n.id)) n.expanded = false; });
    const seen = new Set();
    edges = edges
      .map((e) => ({ from: rep.get(e.from), to: rep.get(e.to) }))
      .filter((e) => e.from && e.to && e.from !== e.to && !seen.has(e.from + '\t' + e.to) && seen.add(e.from + '\t' + e.to));
    byId = new Map(nodes.map((n) => [n.id, n]));
  }

  const q = query.trim().toLowerCase();
  if (layers || q) {
    const leaves = nodes.filter((n) => !isContainer(n));
    const core = new Set(leaves.filter((n) => (!layers || layers.has(n.category)) && (!q || `${n.type} ${n.name} ${n.id}`.toLowerCase().includes(q))).map((n) => n.id));
    const ghost = new Set();
    const ghostModules = new Set(); // modules linked to a match are shown as single dimmed boxes
    if (neighbors) {
      const leafIds = new Set(leaves.map((n) => n.id));
      for (const e of edges) {
        if (core.has(e.from) && !core.has(e.to) && leafIds.has(e.to)) ghost.add(e.to);
        if (core.has(e.to) && !core.has(e.from) && leafIds.has(e.from)) ghost.add(e.from);
        if (core.has(e.from) && byId.get(e.to) && isContainer(byId.get(e.to))) ghostModules.add(e.to);
        if (core.has(e.to) && byId.get(e.from) && isContainer(byId.get(e.from))) ghostModules.add(e.from);
      }
    }
    const keep = new Set([...core, ...ghost]);
    for (const id of [...keep]) {
      for (let cur = byId.get(byId.get(id).parent); cur; cur = byId.get(cur.parent)) keep.add(cur.id);
    }
    for (const id of ghostModules) {
      if (!keep.has(id)) { keep.add(id); ghost.add(id); byId.get(id).expanded = false; }
    }
    nodes = nodes.filter((n) => keep.has(n.id)).map((n) => (ghost.has(n.id) ? { ...n, ghost: true } : n));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  return { ...graph, nodes, edges };
}

// Drops an edge when another path already connects the same two nodes (vpc -> subnet -> route makes
// vpc -> route redundant). Keeps the diagram to the arrows that carry information.
export function reduceEdges(edges) {
  const out = new Map();
  for (const e of edges) { if (!out.has(e.from)) out.set(e.from, new Set()); out.get(e.from).add(e.to); }
  const reaches = (start, target, skipTo) => {
    const seen = new Set([start]);
    const stack = [...(out.get(start) ?? [])].filter((n) => n !== skipTo);
    while (stack.length) {
      const n = stack.pop();
      if (n === target) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(out.get(n) ?? []));
    }
    return false;
  };
  const kept = [];
  for (const e of edges) {
    if (reaches(e.from, e.to, e.to)) out.get(e.from).delete(e.to);
    else kept.push(e);
  }
  return kept;
}

// Overview: one box per resource type per scope ("subnet x7"), so big stacks read like an architecture sketch.
export function summarize(graph) {
  const groupOf = new Map();
  const groups = new Map();
  const nodes = [];
  for (const n of graph.nodes) {
    if (isContainer(n) || n.kind === 'module') { groupOf.set(n.id, n.id); nodes.push(n); continue; }
    const id = `${n.parent}::${n.type}`;
    groupOf.set(n.id, id);
    if (!groups.has(id)) {
      groups.set(id, { id, kind: 'group', type: n.type, category: n.category, parent: n.parent, file: n.file, names: [], ghost: true, count: 0 });
      nodes.push(groups.get(id));
    }
    const g = groups.get(id);
    g.names.push(n.name);
    g.count++;
    g.ghost = g.ghost && Boolean(n.ghost); // dimmed only if every member is
  }
  const seen = new Set();
  const edges = graph.edges
    .map((e) => ({ from: groupOf.get(e.from), to: groupOf.get(e.to) }))
    .filter((e) => e.from && e.to && e.from !== e.to && !seen.has(e.from + '\t' + e.to) && seen.add(e.from + '\t' + e.to));
  return { ...graph, nodes, edges };
}

export const COLORS = {
  Networking: '#1d4ed8', Compute: '#15803d', Data: '#b45309', 'Security & IAM': '#b91c1c',
  Modules: '#6d28d9', 'Data sources': '#0f766e', Other: '#475569',
};

const safe = (id) => 'n_' + id.replace(/[^A-Za-z0-9]/g, '_');
const esc = (s) => String(s).replace(/"/g, '#quot;');

// flow: draw arrows from the provider to its consumer (VPC -> subnet -> instance) instead of "depends on".
export function toMermaid(graph, { direction = 'LR', flow = false, colors = false } = {}) {
  const lines = [`flowchart ${direction}`];
  const children = new Map(); // parent id -> nodes
  for (const n of graph.nodes) {
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(n);
  }
  const catIds = new Map(); // category -> subgraph ids, for colouring
  const leaf = (n, pad) => {
    const short = (t) => t.replace(/^(aws_|azurerm_)/, '');
    const names = n.names ? (n.names.length > 3 ? `${n.names.slice(0, 3).join(', ')} +${n.names.length - 3}` : n.names.join(', ')) : '';
    const label = n.kind === 'group'
      ? `${esc(short(n.type))}${n.count > 1 ? ` ×${n.count}` : ''}<br/><b>${esc(names)}</b>`
      : n.kind === 'module'
      ? `module<br/><b>${esc(n.name)}</b>${n.source ? `<br/>${esc(n.source)}` : ''}`
      : `${esc(n.type.replace(/^(aws_|azurerm_)/, ''))}<br/><b>${esc(n.name)}</b>`;
    lines.push(`${pad}${safe(n.id)}["${label}"]`);
  };
  // Expanded modules are subgraphs (edges to the module attach to the subgraph itself).
  const emit = (parentId, pad, byCategory) => {
    const groups = new Map();
    for (const n of children.get(parentId) ?? []) {
      if (isContainer(n)) {
        lines.push(`${pad}subgraph ${safe(n.id)}["module.${esc(n.name)}${n.source ? ` (${esc(n.source)})` : ''}"]`);
        emit(n.id, pad + '  ', false);
        lines.push(`${pad}end`);
      } else if (byCategory) {
        if (!groups.has(n.category)) groups.set(n.category, []);
        groups.get(n.category).push(n);
      } else {
        leaf(n, pad);
      }
    }
    for (const [cat, items] of groups) {
      const gid = safe('g_' + parentId + cat);
      if (!catIds.has(cat)) catIds.set(cat, []);
      catIds.get(cat).push(gid);
      lines.push(`${pad}subgraph ${gid}["${esc(cat)}"]`);
      items.forEach((n) => leaf(n, pad + '  '));
      lines.push(`${pad}end`);
    }
  };
  emit('', '  ', true);
  for (const e of graph.edges) lines.push(flow ? `  ${safe(e.to)} --> ${safe(e.from)}` : `  ${safe(e.from)} --> ${safe(e.to)}`);
  if (colors) {
    const cats = [...new Set(graph.nodes.map((n) => n.category))];
    cats.forEach((cat, i) => {
      const c = COLORS[cat] ?? COLORS.Other;
      lines.push(`  classDef c${i} fill:${c},stroke:${c},color:#fff`);
      const ids = graph.nodes.filter((n) => n.category === cat && !isContainer(n)).map((n) => safe(n.id));
      if (ids.length) lines.push(`  class ${ids.join(',')} c${i}`);
      for (const gid of catIds.get(cat) ?? []) lines.push(`  style ${gid} fill:${c}22,stroke:${c},stroke-width:2px`);
    });
    for (const n of graph.nodes.filter(isContainer)) lines.push(`  style ${safe(n.id)} fill:#6d28d922,stroke:#6d28d9,stroke-width:2px,stroke-dasharray:6 4`);
  }
  const ghosts = graph.nodes.filter((n) => n.ghost).map((n) => safe(n.id));
  if (ghosts.length) {
    lines.push('  classDef ghost stroke-dasharray:4 3,opacity:0.55');
    lines.push(`  class ${ghosts.join(',')} ghost`);
  }
  return lines.join('\n');
}
