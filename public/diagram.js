// Draws a filtered graph as an SVG: cards with icons, orthogonal arrows, modules as dashed containers.
// Layout comes from dagre (public/vendor/dagre.min.js, loaded as a global).
import { COLORS, reduceEdges } from './render.js';

const W = 214;
const H = 60;
const isContainer = (n) => n.kind === 'module' && n.expanded;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// 24x24 line icons, drawn in white on the category colour.
const P = {
  cloud: 'M6.5 18h11a4 4 0 0 0 .5-7.97 5.5 5.5 0 0 0-10.6-1.5A4.5 4.5 0 0 0 6.5 18z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  gateway: 'M4 8h14l-3-3M20 16H6l3 3',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  bucket: 'M4 7c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2zM5 7l2 12h10l2-12',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  balancer: 'M12 4v6M12 10H6v4M12 10h6v4M6 14v4M18 14v4M4 18h4M16 18h4',
  shield: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  message: 'M4 6h16v12H4zM4 7l8 6 8-6',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  doc: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5',
  list: 'M4 7h16M4 12h16M4 17h16',
};

// First match wins. Works for both aws_ and azurerm_ type names.
const ICON_RULES = [
  [/lambda|function_app|logic_app/, 'lambda'],
  [/subnet(?!_group)|subnet_group/, 'grid'],
  [/(^|_)(vpc|virtual_network|vnet|virtual_wan|virtual_hub)($|_(?!gateway|peering))/, 'cloud'],
  [/internet_gateway|nat_gateway|vpn|customer_gateway|local_network_gateway|virtual_network_gateway|transit|peering|route|eip|public_ip|network_interface/, 'gateway'],
  [/(^|_)(lb|alb|elb|load_balancer|application_gateway|front_door|frontdoor|traffic_manager)(_|$)/, 'balancer'],
  [/security_group|network_security|acl|firewall|waf|security_center|policy_assignment/, 'shield'],
  [/iam|role|identity|key_vault|kms|secret|cognito|ssm_parameter|acm/, 'lock'],
  [/s3|storage_account|bucket|blob|efs|ebs|managed_disk/, 'bucket'],
  [/db_|rds|dynamo|cosmos|sql|redis|elasticache|redshift|postgres|mysql|mariadb|docdb|neptune|kusto|opensearch|elasticsearch/, 'database'],
  [/sqs|sns|queue|eventhub|servicebus|eventgrid|kinesis|msk|topic/, 'message'],
  [/route53|dns|cloudfront|cdn|api_gateway|apigateway|api_management/, 'globe'],
  [/log|monitor|cloudwatch|diagnostic/, 'doc'],
  [/instance|virtual_machine|launch|autoscaling|scale_set|availability_set|image|batch/, 'server'],
  [/ecs|eks|kubernetes|container|ecr|app_service|web_app|service_plan|static_web_app/, 'cube'],
];

export function iconFor(type) {
  const t = String(type).replace(/^(aws_|azurerm_)/, '');
  for (const [re, icon] of ICON_RULES) if (re.test(t)) return icon;
  return 'cube';
}

const glyph = (icon) => (icon === 'lambda'
  ? '<text x="12" y="19" text-anchor="middle" font-size="20" font-weight="700" fill="#fff" stroke="none">λ</text>'
  : `<path d="${P[icon] ?? P.cube}"/>`);

// link: { owner, repo, branch } to make cards open their file on GitHub.
export function renderDiagram(graph, { direction = 'LR', link = null } = {}) {
  const dagre = globalThis.dagre;
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({ rankdir: direction, nodesep: 36, ranksep: 96, edgesep: 16, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const entry = new Map(); // expanded module -> the card edges attach to
  for (const n of graph.nodes) {
    if (isContainer(n)) {
      g.setNode(n.id, {});
      g.setNode(`${n.id}#hdr`, { width: W, height: 46, ref: n, hdr: true });
      g.setParent(`${n.id}#hdr`, n.id);
      entry.set(n.id, `${n.id}#hdr`);
    } else {
      g.setNode(n.id, { width: W, height: H, ref: n });
    }
  }
  for (const n of graph.nodes) if (n.parent && byId.has(n.parent)) g.setParent(n.id, n.parent);

  // Arrows run from the provider to the thing that uses it (VPC -> subnet -> instance).
  const edges = reduceEdges(graph.edges).map((e) => [entry.get(e.to) ?? e.to, entry.get(e.from) ?? e.from]);
  for (const [from, to] of edges) if (g.hasNode(from) && g.hasNode(to)) g.setEdge(from, to);
  dagre.layout(g);

  const lr = direction === 'LR';
  const svgW = Math.ceil(g.graph().width);
  const svgH = Math.ceil(g.graph().height);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" font-family="system-ui, sans-serif">`);
  out.push('<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--edge)"/></marker></defs>');

  // modules first, so cards and arrows draw on top
  for (const n of graph.nodes.filter(isContainer)) {
    const b = g.node(n.id);
    const x = b.x - b.width / 2 - 16;
    const y = b.y - b.height / 2 - 16;
    out.push(`<rect x="${x}" y="${y}" width="${b.width + 32}" height="${b.height + 32}" rx="12" fill="${COLORS.Modules}1a" stroke="${COLORS.Modules}" stroke-width="2" stroke-dasharray="7 5"/>`);
  }

  for (const e of g.edges()) {
    const pts = g.edge(e).points.map((p) => ({ ...p }));
    const a = g.node(e.v);
    const z = g.node(e.w);
    // attach to the sides that face the flow, then route with right angles
    if (lr) { pts[0] = { x: a.x + a.width / 2, y: a.y }; pts[pts.length - 1] = { x: z.x - z.width / 2, y: z.y }; }
    else { pts[0] = { x: a.x, y: a.y + a.height / 2 }; pts[pts.length - 1] = { x: z.x, y: z.y - z.height / 2 }; }
    let d = `M${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1];
      const q = pts[i];
      if (lr) { const m = (p.x + q.x) / 2; d += ` L${m} ${p.y} L${m} ${q.y} L${q.x} ${q.y}`; }
      else { const m = (p.y + q.y) / 2; d += ` L${p.x} ${m} L${q.x} ${m} L${q.x} ${q.y}`; }
    }
    out.push(`<path d="${d}" fill="none" stroke="var(--edge)" stroke-width="1.6" stroke-linejoin="round" marker-end="url(#arr)"/>`);
  }

  for (const n of graph.nodes.filter(isContainer)) {
    const b = g.node(n.id);
    out.push(`<text x="${b.x - b.width / 2 - 6}" y="${b.y - b.height / 2 - 24}" font-size="12" font-weight="600" fill="${COLORS.Modules}">module.${esc(n.name)}${n.source ? ` (${esc(clip(n.source, 40))})` : ''}</text>`);
  }

  for (const id of g.nodes()) {
    const b = g.node(id);
    const n = b.ref;
    if (!n) continue;
    const color = b.hdr ? COLORS.Modules : COLORS[n.category] ?? COLORS.Other;
    const x = b.x - b.width / 2;
    const y = b.y - b.height / 2;
    const h = b.height;
    const title = b.hdr ? `module.${n.name}` : n.kind === 'group' ? `${n.type.replace(/^(aws_|azurerm_)/, '')}${n.count > 1 ? ` ×${n.count}` : ''}` : n.kind === 'module' ? `module.${n.name}` : n.type.replace(/^(aws_|azurerm_)/, '');
    const names = b.hdr ? (n.source ?? '') : n.kind === 'group' ? (n.names.length > 3 ? `${n.names.slice(0, 3).join(', ')} +${n.names.length - 3}` : n.names.join(', ')) : n.kind === 'module' ? (n.source ?? '') : n.name;
    const full = n.kind === 'group' ? `${title}: ${n.names.join(', ')}` : `${title} ${names}`;
    const icon = b.hdr || n.kind === 'module' ? 'cube' : iconFor(n.type);
    const href = link && n.file ? `https://github.com/${link.owner}/${link.repo}/blob/${link.branch}/${n.file.split('/').map(encodeURIComponent).join('/')}` : null;
    const card = `<g transform="translate(${x} ${y})"${n.ghost ? ' opacity="0.5"' : ''}>
<title>${esc(full)}</title>
<rect width="${b.width}" height="${h}" rx="9" fill="var(--card)" stroke="${color}" stroke-width="1.6"${n.ghost ? ' stroke-dasharray="5 4"' : ''}/>
<rect x="1" y="1" width="46" height="${h - 2}" rx="8" fill="${color}"/><rect x="30" y="1" width="17" height="${h - 2}" fill="${color}"/>
<g transform="translate(11 ${h / 2 - 12})" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyph(icon)}</g>
<text x="58" y="${h / 2 - 3}" font-size="13" font-weight="700" fill="var(--fg)">${esc(clip(title, 22))}</text>
<text x="58" y="${h / 2 + 14}" font-size="12" fill="var(--muted)">${esc(clip(names, 26))}</text>
</g>`;
    out.push(href ? `<a href="${esc(href)}" target="_blank" rel="noopener" style="cursor:pointer">${card}</a>` : card);
  }
  out.push('</svg>');
  return out.join('\n');
}
