// Draws a filtered graph as an SVG: cards with icons, orthogonal arrows, modules as dashed containers.
// Layout comes from dagre (public/vendor/dagre.min.js, loaded as a global).
import { COLORS, cidrText, friendlyType, plural, reduceEdges } from './render.js';

const W = 214;
const H = 60;
const H_CIDR = 80; // cards that show an IP range get a third line
const isContainer = (n) => n.kind === 'module' && n.expanded;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// 24x24 line icons, drawn in white on the category colour. Hand-drawn for this app (not vendor artwork).
const P = {
  cloud: 'M6.5 18h11a4 4 0 0 0 .5-7.97 5.5 5.5 0 0 0-10.6-1.5A4.5 4.5 0 0 0 6.5 18z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  gateway: 'M4 8h14l-3-3M20 16H6l3 3',
  arch: 'M5 21V10a7 7 0 0 1 14 0v11M9 21v-6h6v6',
  route: 'M12 3v18M6 6h10l2 2.5-2 2.5H6zM18 13H8l-2 2.5L8 18h10',
  pin: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zM12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  plug: 'M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  shield: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z',
  wall: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v5M15 10v5M9 15v4',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21c0-4.4 3.6-7 8-7s8 2.6 8 7',
  key: 'M8 15a4 4 0 1 1 3.9-4.9H21v3h-3v3h-3v-3h-3.1A4 4 0 0 1 8 15z',
  cert: 'M5 4h14v11H5zM9 8h6M9 11h4M14 15l1 6-3-2-3 2 1-6',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01',
  stack: 'M4 3h16v5H4zM4 10h16v5H4zM9 18l3 3 3-3',
  helm: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  containers: 'M3 9h18v9H3zM8 9v9M13 9v9M18 9v9M6 6h12',
  box: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  window: 'M3 5h18v14H3zM3 9h18M6 7h.01M9 7h.01',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  flow: 'M4 4h6v6H4zM14 14h6v6h-6zM10 7h4a3 3 0 0 1 3 3v4',
  folder: 'M3 6h6l2 2h10v11H3z',
  bucket: 'M4 7c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2zM5 7l2 12h10l2-12',
  disk: 'M4 5h16v14H4zM4 15h16M8 17.5h.01',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  chart: 'M4 20h16M7 17v-5M12 17V7M17 17v-8',
  search: 'M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM15 15l5 5',
  backup: 'M12 4v9M8 9l4 4 4-4M4 16v4h16v-4',
  balancer: 'M12 4v6M12 10H6v4M12 10h6v4M6 14v4M18 14v4M4 18h4M16 18h4',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  hub: 'M12 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 16.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 16.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 7.5v5M12 12.5l-6 4M12 12.5l6 4',
  api: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  message: 'M4 6h16v12H4zM4 7l8 6 8-6',
  bell: 'M6 17v-6a6 6 0 0 1 12 0v6l2 2H4zM10 21h4',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  doc: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5',
};

// First match wins, so specific services come before general ones. Types are matched without the
// provider prefix, so these cover aws_* and azurerm_* alike.
const ICON_RULES = [
  [/lambda|function_app/, 'lambda'],
  [/logic_app|step_function|sfn/, 'flow'],
  [/resource_group|resourcegroups/, 'folder'],
  [/app_service|web_app|static_web_app|service_plan|container_app|amplify|app_runner/, 'window'],
  [/bastion/, 'monitor'],
  [/waf|firewall/, 'wall'],
  [/security_group|network_security|security_center|policy/, 'shield'],
  [/(^|_)acl(_|$)/, 'filter'],
  [/acm|certificate/, 'cert'],
  [/iam|role|identity|cognito|user/, 'user'],
  [/kms|key_vault|secret|ssm_parameter|(^|_)key(_|$)/, 'key'],
  [/vpc_endpoint|private_endpoint|private_link|peering|network_interface/, 'plug'],
  [/internet_gateway|virtual_network_gateway|vpn|customer_gateway|local_network_gateway|transit|direct_connect|express_route/, 'arch'],
  [/nat_gateway/, 'gateway'],
  [/route_table|(^|_)route(_|$)/, 'route'],
  [/eip|public_ip|elastic_ip/, 'pin'],
  [/subnet/, 'grid'],
  [/(^|_)(vpc|virtual_network|vnet|virtual_wan|virtual_hub)($|_)/, 'cloud'],
  [/target_group|listener/, 'target'],
  [/(^|_)(lb|alb|elb|nlb|load_balancer)(_|$)|application_gateway/, 'balancer'],
  [/front_door|frontdoor|cloudfront|cdn|traffic_manager|global_accelerator/, 'hub'],
  [/api_gateway|apigateway|api_management|appsync/, 'api'],
  [/route53|dns/, 'globe'],
  [/sqs|queue|servicebus/, 'message'],
  [/sns|topic|eventgrid|action_group|notification/, 'bell'],
  [/kinesis|eventhub|msk|stream/, 'pulse'],
  [/redis|elasticache|memcached|memorydb/, 'bolt'],
  [/dynamo|cosmos|table|keyspaces/, 'table'],
  [/redshift|synapse|athena|glue|kusto|data_factory|emr|insights|metric|alarm|dashboard/, 'chart'],
  [/opensearch|elasticsearch|search_service|cloudsearch/, 'search'],
  [/db_|rds|sql|postgres|mysql|mariadb|docdb|neptune|aurora/, 'database'],
  [/s3|storage_account|bucket|blob|storage_container/, 'bucket'],
  [/efs|ebs|managed_disk|(^|_)disk|volume|file_system|netapp/, 'disk'],
  [/backup|recovery/, 'backup'],
  [/log|diagnostic|workspace/, 'doc'],
  [/autoscaling|scale_set|scaling|vmss/, 'stack'],
  [/eks|aks|kubernetes|k8s/, 'helm'],
  [/ecs|container_group|container_instance|fargate|batch/, 'containers'],
  [/ecr|container_registry/, 'box'],
  [/instance|virtual_machine|launch|availability_set|image|(^|_)vm(_|$)/, 'server'],
];

export function iconFor(type) {
  const t = String(type).replace(/^(aws_|azurerm_)/, '');
  for (const [re, icon] of ICON_RULES) if (re.test(t)) return icon;
  return 'cube';
}

// The short code printed under each icon (EC2, S3, NSG, AKS ...). Unknown services use initials of their name.
const ABBR = {
  vpc: 'VPC', subnet: 'SUBN', internet_gateway: 'IGW', egress_only_internet_gateway: 'EIGW', nat_gateway: 'NAT', route: 'RT',
  route_table: 'RT', default_route_table: 'RT', eip: 'EIP', network_acl: 'ACL', default_network_acl: 'ACL', security_group: 'SG',
  default_security_group: 'SG', instance: 'EC2', launch_template: 'LT', autoscaling_group: 'ASG', lb: 'LB', alb: 'ALB',
  lb_target_group: 'TG', lb_listener: 'LSN', s3_bucket: 'S3', db_instance: 'RDS', rds_cluster: 'RDS', dynamodb_table: 'DDB',
  elasticache_cluster: 'ECH', lambda_function: 'FN', iam_role: 'IAM', iam_policy: 'IAM', kms_key: 'KMS', secretsmanager_secret: 'SEC',
  sqs_queue: 'SQS', sns_topic: 'SNS', cloudwatch_log_group: 'LOGS', flow_log: 'FLOW', vpn_gateway: 'VPN', customer_gateway: 'CGW',
  ecs_cluster: 'ECS', ecs_service: 'ECS', eks_cluster: 'EKS', ecr_repository: 'ECR', cloudfront_distribution: 'CDN', route53_zone: 'R53',
  route53_record: 'R53', api_gateway_rest_api: 'API', wafv2_web_acl: 'WAF', acm_certificate: 'ACM', efs_file_system: 'EFS',
  ebs_volume: 'EBS', opensearch_domain: 'OS', kinesis_stream: 'KIN', redshift_cluster: 'RS', vpc_endpoint: 'VPCE', db_subnet_group: 'DBSG',
  virtual_network: 'VNET', network_security_group: 'NSG', public_ip: 'PIP', network_interface: 'NIC', application_gateway: 'AGW',
  firewall: 'FW', bastion_host: 'BAS', linux_virtual_machine: 'VM', windows_virtual_machine: 'VM', virtual_machine: 'VM',
  linux_virtual_machine_scale_set: 'VMSS', windows_virtual_machine_scale_set: 'VMSS', kubernetes_cluster: 'AKS',
  container_registry: 'ACR', container_app: 'ACA', service_plan: 'ASP', linux_web_app: 'APP', windows_web_app: 'APP',
  linux_function_app: 'FN', windows_function_app: 'FN', mssql_server: 'SQL', mssql_database: 'SQL', storage_account: 'STG',
  key_vault: 'KV', cosmosdb_account: 'COS', redis_cache: 'REDI', servicebus_namespace: 'SB', eventhub_namespace: 'EH',
  log_analytics_workspace: 'LAW', application_insights: 'AI', api_management: 'APIM', user_assigned_identity: 'MI',
  resource_group: 'RG', private_endpoint: 'PE', dns_zone: 'DNS', private_dns_zone: 'DNS', virtual_network_gateway: 'VPN',
  local_network_gateway: 'LNG', cdn_profile: 'CDN', traffic_manager_profile: 'TM', availability_set: 'AVS', managed_disk: 'DISK',
  monitor_action_group: 'ACT', application_security_group: 'ASG',
};
const SMALL = new Set(['of', 'the', 'and', 'for']);

export function abbrFor(type) {
  const t = String(type).replace(/^(aws_|azurerm_)/, '');
  if (ABBR[t]) return ABBR[t];
  const words = friendlyType(type).split(/\s+/).filter((w) => !SMALL.has(w.toLowerCase()));
  return (words.length === 1 ? words[0].slice(0, 3) : words.map((w) => w[0]).join('').slice(0, 4)).toUpperCase();
}

// Official vendor icons, if installed (scripts/import-icons.mjs writes public/icons/manifest.json).
// { aws_vpc: 'aws/aws_vpc.svg', ... }; anything missing keeps the drawn icon above.
let OFFICIAL = {};
export function setOfficialIcons(manifest) { OFFICIAL = manifest ?? {}; }
export const hasOfficialIcons = () => Object.keys(OFFICIAL).length > 0;

const glyph = (icon) => (icon === 'lambda'
  ? '<text x="12" y="19" text-anchor="middle" font-size="20" font-weight="700" fill="#fff" stroke="none">λ</text>'
  : `<path d="${P[icon] ?? P.cube}"/>`);

// link: { owner, repo, branch } to make cards open their file on GitHub.
export function renderDiagram(graph, { direction = 'LR', link = null } = {}) {
  const dagre = globalThis.dagre;
  const g = new dagre.graphlib.Graph({ compound: true });
  const hasModules = graph.nodes.some(isContainer);
  // Cards in a module sit in a padded cell, so the module's box (exactly dagre's cluster bounds) has room
  // for its border and title and never overlaps a neighbouring module.
  const pad = hasModules ? 20 : 0;
  g.setGraph({ rankdir: direction, nodesep: hasModules ? 28 : 36, ranksep: hasModules ? 64 : 96, edgesep: 16, marginx: 30, marginy: 30 });
  const cell = (cw, ch, extra) => ({ width: cw + 2 * pad, height: ch + 2 * pad, cw, ch, ...extra });
  g.setDefaultEdgeLabel(() => ({}));

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const arrows = reduceEdges(graph.edges);
  const linked = new Set(arrows.flatMap((e) => [e.from, e.to]));
  const entry = new Map(); // expanded module -> the card edges attach to
  for (const n of graph.nodes) {
    if (isContainer(n)) {
      g.setNode(n.id, {});
      // The module's own card only exists to anchor arrows; skip it when nothing connects to the module
      // (unless the box would otherwise be empty).
      if (linked.has(n.id) || !graph.nodes.some((c) => c.parent === n.id)) {
        g.setNode(`${n.id}#hdr`, cell(W, 46, { ref: n, hdr: true }));
        g.setParent(`${n.id}#hdr`, n.id);
        entry.set(n.id, `${n.id}#hdr`);
      }
    } else {
      g.setNode(n.id, cell(W, n.cidrs?.length ? H_CIDR : H, { ref: n }));
    }
  }
  for (const n of graph.nodes) if (n.parent && byId.has(n.parent)) g.setParent(n.id, n.parent);

  // Arrows run from the provider to the thing that uses it (VPC -> subnet -> instance).
  const edges = arrows.map((e) => [entry.get(e.to) ?? e.to, entry.get(e.from) ?? e.from]);
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
    const x = b.x - b.width / 2;
    const y = b.y - b.height / 2;
    out.push(`<rect x="${x}" y="${y}" width="${b.width}" height="${b.height}" rx="12" fill="${COLORS.Modules}1a" stroke="${COLORS.Modules}" stroke-width="2" stroke-dasharray="7 5"/>`);
  }

  for (const e of g.edges()) {
    const pts = g.edge(e).points.map((p) => ({ ...p }));
    const a = g.node(e.v);
    const z = g.node(e.w);
    // attach to the sides that face the flow, then route with right angles
    if (lr) { pts[0] = { x: a.x + a.cw / 2, y: a.y }; pts[pts.length - 1] = { x: z.x - z.cw / 2, y: z.y }; }
    else { pts[0] = { x: a.x, y: a.y + a.ch / 2 }; pts[pts.length - 1] = { x: z.x, y: z.y - z.ch / 2 }; }
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
    out.push(`<text x="${b.x - b.width / 2 + 12}" y="${b.y - b.height / 2 + 15}" font-size="12" font-weight="600" fill="${COLORS.Modules}">module.${esc(n.name)}${n.source ? ` (${esc(clip(n.source, 40))})` : ''}</text>`);
  }

  for (const id of g.nodes()) {
    const b = g.node(id);
    const n = b.ref;
    if (!n) continue;
    const color = b.hdr ? COLORS.Modules : COLORS[n.category] ?? COLORS.Other;
    const x = b.x - b.cw / 2;
    const y = b.y - b.ch / 2;
    const h = b.ch;
    const grouped = n.kind === 'group' && n.count > 1;
    const kind = friendlyType(n.type);
    const title = b.hdr ? `module.${n.name}` : n.kind === 'module' ? `module.${n.name}` : grouped ? plural(kind) : kind;
    const label = n.label ?? n.name;
    const names = b.hdr || n.kind === 'module' ? (n.source ?? '') : n.kind === 'group' ? (n.names.length > 3 ? `${n.names.slice(0, 3).join(', ')} +${n.names.length - 3}` : n.names.join(', ')) : label;
    const ranges = n.cidrs?.length ? ` IP ranges: ${n.cidrs.join(', ')}.` : '';
    const full = ranges + ' ' + (grouped ? `${n.count} ${plural(kind).toLowerCase()}: ${n.names.join(', ')}. Click to see each one.` : n.kind === 'group' || n.kind === 'resource' ? `${kind} "${label}" (${n.type}${n.kind === 'resource' ? `.${n.name}` : ''})` : title);
    const icon = b.hdr || n.kind === 'module' ? 'cube' : iconFor(n.type);
    const code = b.hdr || n.kind === 'module' ? 'MOD' : abbrFor(n.type);
    const href = !grouped && link && n.file ? `https://github.com/${link.owner}/${link.repo}/blob/${link.branch}/${n.file.split('/').map(encodeURIComponent).join('/')}${n.line ? `#L${n.line}` : ''}` : null;
    const official = !b.hdr && n.kind !== 'module' && OFFICIAL[n.type];
    // official artwork is shown as supplied (unmodified); the layer colour stays on the card border
    const tile = official
      ? `<image href="icons/${esc(official)}" x="4" y="${h / 2 - 21}" width="42" height="42" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="1" y="1" width="46" height="${h - 2}" rx="8" fill="${color}"/><rect x="30" y="1" width="17" height="${h - 2}" fill="${color}"/>
<g transform="translate(11 ${h / 2 - 25})" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyph(icon)}</g>
<text x="24" y="${h / 2 + 21}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fff" letter-spacing=".3">${esc(code)}</text>`;
    const badge = grouped ? `<circle cx="${b.cw}" cy="0" r="12" fill="${color}" stroke="var(--card)" stroke-width="2.5"/><text x="${b.cw}" y="4.5" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${n.count}</text>` : '';
    const card = `<g transform="translate(${x} ${y})"${n.ghost ? ' opacity="0.5"' : ''}${grouped ? ` data-expand="${esc(n.type)}" style="cursor:pointer"` : ''}>
<title>${esc(full)}</title>
<rect width="${b.cw}" height="${h}" rx="9" fill="var(--card)" stroke="${color}" stroke-width="1.6"${n.ghost ? ' stroke-dasharray="5 4"' : ''}/>
${tile}
<text x="58" y="${h === H_CIDR ? 27 : h / 2 - 3}" font-size="13" font-weight="700" fill="var(--fg)">${esc(clip(title, 22))}</text>
<text x="58" y="${h === H_CIDR ? 44 : h / 2 + 14}" font-size="12" fill="var(--muted)">${esc(clip(names, 26))}</text>
${n.cidrs?.length ? `<text x="58" y="63" font-size="12" font-family="ui-monospace, monospace" fill="${color}" font-weight="600">${esc(clip(cidrText(n.cidrs), 26))}</text>` : ''}
${badge}
</g>`;
    out.push(href ? `<a href="${esc(href)}" target="_blank" rel="noopener" style="cursor:pointer">${card}</a>` : card);
  }
  out.push('</svg>');
  return out.join('\n');
}
