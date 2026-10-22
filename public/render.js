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

const safe = (id) => 'n_' + id.replace(/[^A-Za-z0-9]/g, '_');
const esc = (s) => String(s).replace(/"/g, '#quot;');

export function toMermaid(graph, { direction = 'LR' } = {}) {
  const lines = [`flowchart ${direction}`];
  const children = new Map(); // parent id -> nodes
  for (const n of graph.nodes) {
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(n);
  }
  const leaf = (n, pad) => {
    const label = n.kind === 'module'
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
      lines.push(`${pad}subgraph ${safe('g_' + parentId + cat)}["${esc(cat)}"]`);
      items.forEach((n) => leaf(n, pad + '  '));
      lines.push(`${pad}end`);
    }
  };
  emit('', '  ', true);
  for (const e of graph.edges) lines.push(`  ${safe(e.from)} --> ${safe(e.to)}`);
  const ghosts = graph.nodes.filter((n) => n.ghost).map((n) => safe(n.id));
  if (ghosts.length) {
    lines.push('  classDef ghost stroke-dasharray:4 3,opacity:0.55');
    lines.push(`  class ${ghosts.join(',')} ghost`);
  }
  return lines.join('\n');
}
