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

// Cards carry data-node (open details) or data-expand (grouped cards: show each resource); the page handles the clicks.
export function renderDiagram(graph, { direction = 'LR', animate = false } = {}) {
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
      g.setNode(n.id, cell(W, n.cidrs?.length || n.summary ? H_CIDR : H, { ref: n }));
    }
  }
  for (const n of graph.nodes) if (n.parent && byId.has(n.parent)) g.setParent(n.id, n.parent);

  // Arrows run from the provider to the thing that uses it (VPC -> subnet -> instance).
  const edges = arrows.map((e) => [entry.get(e.to) ?? e.to, entry.get(e.from) ?? e.from, e]);
  for (const [from, to, e] of edges) if (g.hasNode(from) && g.hasNode(to)) g.setEdge(from, to, { ref: e });
  dagre.layout(g);

  const lr = direction === 'LR';
  const svgW = Math.ceil(g.graph().width);
  const svgH = Math.ceil(g.graph().height);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" font-family="system-ui, sans-serif">`);
 out.push(`<style>.flow{stroke-dasharray:7 6;animation:tfflow 0.9s linear infinite}@keyframes tfflow{to{stroke-dashoffset:-13}}@media (prefers-reduced-motion:reduce){.flow{animation:none}}</style>`);
  out.push(`<defs><marker id="farr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${ARCH.flow}"/></marker></defs>`);
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
    // hovering an arrow says which individual links it stands for; several links get a count on the arrow
    const ref = g.edge(e).ref;
    const pairs = ref?.pairs ?? [];
    const tip = ref?.ordering ? 'Only an ordering: depends_on says this is created first.' : pairs.length ? `${pairs.slice(0, 10).map(([consumer, provider]) => `${provider} → ${consumer}`).join('\n')}${pairs.length > 10 ? `\n+${pairs.length - 10} more` : ''}` : '';
    const last = pts[pts.length - 1];
    const pill = ref?.count > 1
      ? `<g transform="translate(${lr ? last.x - 34 : last.x} ${lr ? last.y : last.y - 34})"><rect x="-13" y="-10" width="26" height="20" rx="10" fill="var(--card)" stroke="var(--edge)"/><text y="4" text-anchor="middle" font-size="11" font-weight="700" fill="var(--fg)">${ref.count}</text></g>` : '';
    out.push(`<g>${tip ? `<title>${esc(tip)}</title>` : ''}<path d="${d}" fill="none" stroke="transparent" stroke-width="12"/>${animate && !ref?.ordering
      ? `<path d="${d}" fill="none" stroke="${ARCH.flow}" stroke-width="2" stroke-linejoin="round" class="flow" marker-end="url(#farr)"/>`
      : `<path d="${d}" fill="none" stroke="var(--edge)" stroke-width="1.6" stroke-linejoin="round"${ref?.ordering ? ' stroke-dasharray="6 5"' : ''} marker-end="url(#arr)"/>`}${pill}</g>`);
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
    const total = n.kind === 'group' ? n.count : n.instances ?? 1;          // how many things the card stands for
    const grouped = n.kind === 'group' && n.members > 1;                  // several resources: click to see each
    const faint = n.ghost || n.inactive;
    const kind = friendlyType(n.type);
    const title = b.hdr ? `module.${n.name}` : n.kind === 'module' ? `module.${n.name}` : total > 1 ? plural(kind) : kind;
    const label = n.label ?? n.name;
    const names = b.hdr || n.kind === 'module' ? (n.source ?? '') : n.kind === 'group' ? (n.names.length > 3 ? `${n.names.slice(0, 3).join(', ')} +${n.names.length - 3}` : n.names.join(', ')) : label;
    const ranges = n.cidrs?.length ? ` IP ranges: ${n.cidrs.join(', ')}.` : '';
    const full = ranges + (n.summary ? ` ${n.summary}.` : '') + ' ' + (grouped ? `${n.count} ${plural(kind).toLowerCase()} (${n.names.join(', ')}). Click to see each kind.` : total > 1 ? `${total} ${plural(kind).toLowerCase()} (count/for_each = ${total}). ` : n.kind === 'group' || n.kind === 'resource' ? `${kind} "${label}" (${n.type}${n.kind === 'resource' ? `.${n.name}` : ''}). Click for details.` : title);
    const icon = b.hdr || n.kind === 'module' ? 'cube' : iconFor(n.type);
    const code = b.hdr || n.kind === 'module' ? 'MOD' : abbrFor(n.type);
    const official = !b.hdr && n.kind !== 'module' && OFFICIAL[n.type];
    // official artwork is shown as supplied (unmodified); the layer colour stays on the card border
    const tile = official
      ? `<image href="icons/${esc(official)}" x="4" y="${h / 2 - 21}" width="42" height="42" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="1" y="1" width="46" height="${h - 2}" rx="8" fill="${color}"/><rect x="30" y="1" width="17" height="${h - 2}" fill="${color}"/>
<g transform="translate(11 ${h / 2 - 25})" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyph(icon)}</g>
<text x="24" y="${h / 2 + 21}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fff" letter-spacing=".3">${esc(code)}</text>`;
    const extra = n.summary || cidrText(n.cidrs);
    const badge = total > 1 ? `<circle cx="${b.cw}" cy="0" r="12" fill="${color}" stroke="var(--card)" stroke-width="2.5"/><text x="${b.cw}" y="4.5" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${total}</text>` : '';
    const card = `<g transform="translate(${x} ${y})"${faint ? ' opacity="0.5"' : ''}${grouped ? ` data-expand="${esc(n.type)}"` : b.hdr ? '' : ` data-node="${esc(n.id)}"`} style="cursor:pointer">
<title>${esc(full)}</title>
<rect width="${b.cw}" height="${h}" rx="9" fill="var(--card)" stroke="${color}" stroke-width="1.6"${faint ? ' stroke-dasharray="5 4"' : ''}/>
${tile}
<text x="58" y="${h === H_CIDR ? 27 : h / 2 - 3}" font-size="13" font-weight="700" fill="var(--fg)">${esc(clip(title, 22))}</text>
<text x="58" y="${h === H_CIDR ? 44 : h / 2 + 14}" font-size="12" fill="var(--muted)">${esc(clip(names, 26))}</text>
${extra ? `<text x="58" y="63" font-size="11" font-family="ui-monospace, monospace" fill="${color}" font-weight="600">${esc(clip(extra, 23))}</text>` : ''}
${badge}
</g>`;
    out.push(card);
  }
  out.push('</svg>');
  return out.join('\n');
}

// ---- Architecture view: cloud -> VPC -> subnet boxes with big icons and animated traffic arrows ----
const NET = /(^|_)(vpc|virtual_network)$/;
const SUBNET = /(^|_)subnet$/;
const HIDDEN = /security_group|network_acl|route_table|dhcp|(^aws_route$)|_route$|_association|flow_log|iam_|_policy|role_assignment|user_assigned_identity|subnet_group|kms_|key_vault_|lb_listener|lb_target_group|lb_backend|lb_probe|lb_rule|lb_nat|alb_|lb_cookie|vpc_endpoint_|network_interface|(^aws_eip)|_attachment$|_ssm_|cloudwatch_log|monitor_|diagnostic/;
const LB_PLUMBING = /network_interface|lb_listener|lb_target_group|alb_|lb_backend|lb_probe|lb_rule|lb_nat|_attachment$/;
const EDGE_TYPES = /(^aws_(lb|alb|elb)$|azurerm_public_ip|cloudfront|api_gateway|apigateway|front_door|application_gateway|route53_zone|cdn_endpoint|(^azurerm_lb$)|lb$)/;
const DATA_TYPES = /db_instance|rds_|dynamodb|elasticache|redis|s3_bucket|efs_|ebs_|mssql|sql_|cosmos|storage_account|postgresql|mysql|docdb|redshift|opensearch|elasticsearch|kinesis|sqs_|sns_|servicebus|eventhub|managed_disk|storage_/;
const klass = (t) => (EDGE_TYPES.test(t) ? 0 : DATA_TYPES.test(t) ? 2 : 1);
const ARCH = { cloud: '#5b6b7f', vpc: '#8c4fff', public: '#7aa116', private: '#147eba', plain: '#6b7a8c', azure: '#0078d4', flow: '#e8710a' };
const nice = (n) => (n.label && !/\.tf:\d+$/.test(n.label) ? n.label : n.name);
const TW = 132;
const TH = 112;

export function renderArchitecture(graph, { animate = true, direction = 'LR' } = {}) {
  const lr = direction !== 'TB';
  const dagre = globalThis.dagre;
  const azure = graph.nodes.some((n) => n.type?.startsWith('azurerm_'));
  const tiles = graph.nodes.filter((n) => !(n.kind === 'module' && n.expanded));
  const byId = new Map(tiles.map((n) => [n.id, n]));
  const out = new Map();                                    // consumer -> providers it references
  for (const e of graph.edges) { if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e.to); }
  const nets = tiles.filter((n) => n.kind === 'resource' && NET.test(n.type.replace(/^(aws_|azurerm_)/, '')));
  const subs = tiles.filter((n) => n.kind === 'resource' && SUBNET.test(n.type.replace(/^(aws_|azurerm_)/, '')));
  const netIds = new Set(nets.map((n) => n.id));
  const subIds = new Set(subs.map((n) => n.id));
  const hidden = (n) => n.kind !== 'module' && (HIDDEN.test(n.type) || netIds.has(n.id) || subIds.has(n.id));

  // where a resource sits: follow its references (through hidden plumbing) to a subnet, else a VPC
  const home = (id, seen = new Set()) => {
    if (seen.has(id)) return null;
    seen.add(id);
    let vpc = null;
    for (const to of out.get(id) ?? []) {
      if (subIds.has(to)) return to;
      if (netIds.has(to)) vpc = vpc ?? to;
      else if (byId.has(to) && hidden(byId.get(to))) { const h = home(to, seen); if (h && subIds.has(h)) return h; vpc = vpc ?? h; }
    }
    return vpc;
  };
  const subHome = new Map(subs.map((s) => [s.id, [...(out.get(s.id) ?? [])].find((t) => netIds.has(t)) ?? null]));

  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({ rankdir: lr ? 'LR' : 'TB', nodesep: 84, ranksep: 70, edgesep: 16, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  const cloud = { label: azure ? 'Azure' : 'AWS Cloud', color: azure ? ARCH.azure : ARCH.cloud, kind: 'cloud' };
  g.setNode('#cloud', { cloud });
  for (const v of nets) { g.setNode(v.id, { box: { label: nice(v), sub: cidrText(v.cidrs), color: ARCH.vpc, kind: 'vpc', n: v } }); g.setParent(v.id, '#cloud'); }
  for (const s of subs) {
    const t = `${s.label ?? ''} ${s.name}`.toLowerCase();
    const kind = /public/.test(t) ? 'public' : /private|database|intra|internal/.test(t) ? 'private' : 'plain';
    g.setNode(s.id, { box: { label: nice(s), sub: cidrText(s.cidrs), color: ARCH[kind], kind, n: s } });
    const v = subHome.get(s.id);
    g.setParent(s.id, v && g.hasNode(v) ? v : '#cloud');
  }

  // visible resources, one tile per type per box (x2 when several)
  const tileOf = new Map();                                   // node id -> tile id
  const tileNodes = new Map();
  for (const n of tiles) {
    if (hidden(n)) continue;
    const box = home(n.id);
    const key = `${box ?? '#cloud'}|${n.type}|${n.kind}`;
    if (!tileNodes.has(key)) tileNodes.set(key, { id: key, box: box ?? '#cloud', type: n.type, kind: n.kind, names: [], ids: [], total: 0, ref: n });
    const t = tileNodes.get(key);
    t.names.push(n.label ?? n.name);
    t.ids.push(n.id);
    t.total += n.kind === 'group' ? n.count : n.instances ?? 1;
    tileOf.set(n.id, key);
  }
  const hiddenCount = tiles.filter((n) => hidden(n) && !netIds.has(n.id) && !subIds.has(n.id)).length;
  for (const t of tileNodes.values()) {
    g.setNode(t.id, { width: TW + 36, height: TH + 44, tile: t });          // padded cell: the boxes around it get room for their border and title
    g.setParent(t.id, g.hasNode(t.box) ? t.box : '#cloud');
  }

  for (const id of g.nodes()) {                                // a box with nothing in it still needs a size
    const d = g.node(id);
    if (d.box && !g.children(id).length) { d.width = 220; d.height = 40; }
  }

  // traffic: entry points -> compute -> data. Chains through load-balancer plumbing count as direct links.
  const flows = new Map();
  const add = (a, b, ordering) => {
    const ta = tileOf.get(a); const tb = tileOf.get(b);
    if (!ta || !tb || ta === tb) return;
    const [ka, kb] = [klass(tileNodes.get(ta).type), klass(tileNodes.get(tb).type)];
    // provider -> consumer unless the classes say otherwise (clients reach data, never the other way)
    const [from, to] = ka === kb ? [ta, tb] : ka < kb ? [ta, tb] : [tb, ta];
    const k = `${from}>${to}`;
    if (!flows.has(k) && !flows.has(`${to}>${from}`)) flows.set(k, { from, to, ordering });
    else if (flows.get(k) && !ordering) flows.get(k).ordering = false;
  };
  const plumb = new Map();                                    // lb plumbing node -> visible neighbours
  for (const e of graph.edges) {
    const a = byId.get(e.from); const b = byId.get(e.to);
    if (!a || !b) continue;
    if (e.ordering) continue;
    const pa = a.kind !== 'module' && LB_PLUMBING.test(a.type); const pb = b.kind !== 'module' && LB_PLUMBING.test(b.type);
    if (pa || pb) {
      const h = pa ? a.id : b.id; const v = pa ? b : a;
      if (!plumb.has(h)) plumb.set(h, new Set());
      if (!hidden(v) || LB_PLUMBING.test(v.type)) { if (!LB_PLUMBING.test(v.type)) plumb.get(h).add(v.id); }
      continue;
    }
    if (hidden(a) || hidden(b)) continue;
    add(b.id, a.id, false);                                   // provider -> consumer
  }
  // plumbing nodes that touch one another (listener -> target group -> attachment) form a chain: join their ends
  const comp = new Map();
  const find = (x) => (comp.get(x) === x || !comp.has(x) ? x : find(comp.get(x)));
  for (const h of plumb.keys()) comp.set(h, h);
  for (const e of graph.edges) {
    if (plumb.has(e.from) && plumb.has(e.to)) comp.set(find(e.from), find(e.to));
  }
  const groups = new Map();
  for (const [h, set] of plumb) { const r = find(h); groups.set(r, [...(groups.get(r) ?? []), ...set]); }
  for (const members of groups.values()) {
    const u = [...new Set(members)];
    for (const a of u) for (const b of u) if (a < b && klass(byId.get(a).type) !== klass(byId.get(b).type)) add(a, b, false);
  }

  // Which security-group rules let this traffic in? Looks at the receiving resources' groups: an inbound rule
  // naming one of the sender's groups, or open to a CIDR. Groups whose rules can't be read say nothing.
  const sgsOf = (ids) => ids.flatMap((id) => (out.get(id) ?? []).filter((to) => /security_group$/.test(byId.get(to)?.type ?? '')).map((to) => byId.get(to)));
  const peerNames = (sg) => [`${friendlyType(sg.type)} ${sg.label ?? sg.name}`, `${friendlyType(sg.type)} ${sg.name}`];
  const ruleInfo = (from, to) => {
    const target = tileNodes.get(to);
    const rec = sgsOf(target.ids).filter((sg) => sg.details?.kind === 'rules');
    if (!rec.length) return null;
    const sender = from === '#net' ? [] : sgsOf(tileNodes.get(from).ids);
    const senderNames = new Set(sender.flatMap(peerNames));
    const hits = [];
    for (const sg of rec) {
      for (const r of sg.details.rows) {
        if (r.dir !== 'in' || /deny/i.test(r.action ?? '')) continue;
        const named = r.peers.filter((x) => senderNames.has(x));
        const open = r.peers.filter((x) => x === '0.0.0.0/0' || x === '::/0');
        const cidr = r.peers.filter((x) => /^[\d.:a-f]+\/\d+$/i.test(x) && !open.includes(x));
        const ports = `${r.proto && r.proto !== 'all' ? r.proto.toUpperCase() + ' ' : ''}${r.ports || 'all'}`;
        if (named.length) hits.push({ kind: 'sg', ports, text: `${ports} from ${named.join(', ')} (inbound rule on ${sg.label ?? sg.name})` });
        else if (open.length) hits.push({ kind: 'open', ports, text: `${ports} from anywhere ${open.join(', ')} (inbound rule on ${sg.label ?? sg.name})` });
        else if (cidr.length && from !== '#net') hits.push({ kind: 'cidr', ports, text: `${ports} from ${cidr.join(', ')} (inbound rule on ${sg.label ?? sg.name}; allowed if the sender is in that range)` });
      }
    }
    if (from === '#net' && !hits.some((h) => h.kind === 'open')) hits.length = 0;
    const top = hits.find((h) => h.kind === 'sg') ?? hits.find((h) => h.kind === 'open') ?? hits[0];
    if (!top) return { kind: 'none', ports: 'no rule', text: `No inbound rule on ${rec.map((x) => x.label ?? x.name).join(', ')} names ${from === '#net' ? 'the internet' : 'the sender\'s security group'}. It may be allowed another way (CIDR from another group, network ACL, or rules we can't read), so check the code.` };
    return { kind: top.kind, ports: [...new Set(hits.map((h) => h.ports))].join(', '), text: hits.map((h) => h.text).join('\n') };
  };

  // a rule that names another resource's security group is a real traffic path: draw it even when the code has no other link
  for (const ta of tileNodes.values()) {
    for (const tb of tileNodes.values()) {
      if (ta === tb || flows.has(`${ta.id}>${tb.id}`) || flows.has(`${tb.id}>${ta.id}`)) continue;
      if (ruleInfo(ta.id, tb.id)?.kind === 'sg') flows.set(`${ta.id}>${tb.id}`, { from: ta.id, to: tb.id });
    }
  }

  // an "Internet" tile feeding whatever faces the outside
  const entries = [...tileNodes.values()].filter((t) => klass(t.type) === 0);
  const igw = [...tileNodes.values()].filter((t) => /internet_gateway/.test(t.type));
  const front = entries.length ? entries : igw;
  if (front.length) {
    g.setNode('#net', { width: 96, height: 96, net: true });
    for (const t of front) flows.set(`#net>${t.id}`, { from: '#net', to: t.id });
  }
  for (const f of flows.values()) if (g.hasNode(f.from) && g.hasNode(f.to)) g.setEdge(f.from, f.to, { ordering: f.ordering });
  dagre.layout(g);

  const depth = (id) => { let d = 0; for (let p = g.parent(id); p; p = g.parent(p)) d++; return d; };
  const boxes = g.nodes().filter((id) => g.children(id).length || g.node(id)?.box || g.node(id)?.cloud);
  const grow = (id) => 10 + 12 * Math.max(0, ...g.children(id).filter((c) => g.children(c).length).map((c) => 1 + (g.children(c).some((d) => g.children(d).length) ? 1 : 0)));
  const rect = (id) => { const b = g.node(id); const gr = grow(id);  return { x: b.x - b.width / 2 - gr, y: b.y - b.height / 2 - gr - 24, w: b.width + 2 * gr, h: b.height + 2 * gr + 24 }; };
  let minX = 0; let minY = 0; let maxX = g.graph().width; let maxY = g.graph().height;
  for (const id of boxes) { const r = rect(id); minX = Math.min(minX, r.x - 12); minY = Math.min(minY, r.y - 12); maxX = Math.max(maxX, r.x + r.w + 12); maxY = Math.max(maxY, r.y + r.h + 12); }
  const note = hiddenCount ? `${hiddenCount} supporting resources (security groups, routes, IAM, listeners…) are folded away. Use the Cards view to see them.` : '';
  maxX = Math.max(maxX, minX + 24 + note.length * 5.9);       // the caption must fit inside the picture too
  const w = Math.ceil(maxX - minX); const h = Math.ceil(maxY - minY) + 22;
  const svg = [];
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" class="arch${animate ? '' : ' still'}" viewBox="${minX} ${minY} ${w} ${h}" width="${w}" height="${h}" font-family="system-ui, sans-serif">`);
  svg.push(`<style>.flow{stroke-dasharray:7 6;animation:tfflow 0.9s linear infinite}.still .flow{animation:none}@keyframes tfflow{to{stroke-dashoffset:-13}}@media (prefers-reduced-motion:reduce){.flow{animation:none}}</style>`);
  svg.push(`<defs><marker id="farr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${ARCH.flow}"/></marker></defs>`);
  const hint = { cloud: P.cloud, vpc: P.cloud, public: P.globe, private: P.shield, plain: P.grid };
  for (const id of boxes.sort((a, b) => depth(a) - depth(b))) {
    const d = g.node(id);
    const info = d.cloud ?? d.box;
    if (!info) continue;
    const r = rect(id);
    const title = info.kind === 'cloud' ? info.label : info.kind === 'vpc' ? `VPC · ${info.label}` : `${info.kind === 'public' ? 'Public subnet' : info.kind === 'private' ? 'Private subnet' : 'Subnet'} · ${info.label}${info.n?.instances > 1 ? ` ×${info.n.instances}` : ''}`;
    svg.push(`<g><title>${esc(title)}${info.sub ? ' ' + esc(info.sub) : ''}</title><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" fill="${info.color}${info.kind === 'cloud' ? '08' : '1c'}" stroke="${info.color}" stroke-width="${info.kind === 'cloud' ? 1.6 : 1.4}"/>
<rect x="${r.x}" y="${r.y}" width="26" height="26" rx="${info.kind === 'cloud' ? 4 : 3}" fill="${info.color}"/><g transform="translate(${r.x + 3} ${r.y + 3})" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${hint[info.kind] ?? P.cloud}"/></g>
<text x="${r.x + 34}" y="${r.y + 17}" font-size="12.5" font-weight="600" fill="${info.color}">${esc(clip(title, Math.max(14, Math.floor(r.w / 7.2))))}${info.sub ? `<tspan font-weight="400" font-family="ui-monospace, monospace" font-size="11" dx="8" fill="var(--muted)">${esc(info.sub)}</tspan>` : ''}</text></g>`);
  }

  for (const e of g.edges()) {
    const pts = g.edge(e).points.map((p) => ({ ...p }));
    const a = g.node(e.v); const z = g.node(e.w);
    // leave and enter at the icons (middle of the icon row when left to right, its bottom / top when top to bottom), with one bend halfway
    const cy = (n) => (n.net ? n.y - 8 : n.y - TH / 2 + 32);
    let d; let x1; let y1; let x2; let y2; let m;
    if (lr) {
      x1 = a.x + 34; y1 = cy(a); x2 = z.x - 38; y2 = cy(z); m = (x1 + x2) / 2;
      d = y1 === y2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} L${m} ${y1} L${m} ${y2} L${x2} ${y2}`;
    } else {
      const top = (n) => (n.net ? n.y - 48 : n.y - TH / 2);
      x1 = a.x; y1 = a.net ? a.y + 50 : top(a) + TH; x2 = z.x; y2 = top(z) - 4; m = (y1 + y2) / 2;
      d = x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} L${x1} ${m} L${x2} ${m} L${x2} ${y2}`;
    }
    const info = ruleInfo(e.v, e.w);
    let pill = '';
    if (info) {
      const col = { sg: '#16a34a', open: '#d97706', cidr: '#16a34a', none: '#dc2626' }[info.kind];
      const label = clip(info.ports, 18);
      const bw = label.length * 6.4 + 16;
      const [px, py] = lr ? (y1 === y2 ? [(x1 + x2) / 2, y1] : [(m + x2) / 2, y2]) : (x1 === x2 ? [x1, (y1 + y2) / 2] : [x2, (m + y2) / 2]);
      pill = `<g transform="translate(${px} ${py})"><title>${esc(info.text)}</title><rect x="${-bw / 2}" y="-10" width="${bw}" height="20" rx="10" fill="var(--card)" stroke="${col}" stroke-width="1.6"/><text y="4" text-anchor="middle" font-size="11" font-weight="700" fill="${col}">${info.kind === 'none' ? '✗ ' : ''}${esc(label)}</text></g>`;
    }
    svg.push(`<g><path d="${d}" fill="none" stroke="${ARCH.flow}" stroke-width="2.2" stroke-linejoin="round" class="flow" marker-end="url(#farr)"/>${pill}</g>`);
  }

  for (const id of g.nodes()) {
    const d = g.node(id);
    if (d.net) {
      svg.push(`<g transform="translate(${d.x - 48} ${d.y - 48})"><circle cx="48" cy="40" r="30" fill="${ARCH.cloud}"/><g transform="translate(24 16) scale(2)" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"><path d="${P.globe}"/></g><text x="48" y="92" text-anchor="middle" font-size="13" font-weight="700" fill="var(--fg)">Internet</text></g>`);
      continue;
    }
    const t = d.tile;
    if (!t) continue;
    const n = t.ref;
    const kind = friendlyType(t.type);
    const color = COLORS[n.category] ?? COLORS.Other;
    const official = n.kind !== 'module' && OFFICIAL[t.type];
    const icon = official
      ? `<image href="icons/${esc(official)}" x="${TW / 2 - 28}" y="4" width="56" height="56" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="${TW / 2 - 28}" y="4" width="56" height="56" rx="10" fill="${color}"/><g transform="translate(${TW / 2 - 18} 14) scale(1.5)" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${glyph(n.kind === 'module' ? 'cube' : iconFor(t.type))}</g>`;
    const label = t.total > 1 ? plural(kind) : kind;
    const names = t.names.length > 2 ? `${t.names.slice(0, 2).join(', ')} +${t.names.length - 2}` : t.names.join(', ');
    svg.push(`<g transform="translate(${d.x - TW / 2} ${d.y - TH / 2})" data-node="${esc(n.id)}" style="cursor:pointer"><title>${esc(`${label}: ${t.names.join(', ')}${t.total > 1 ? ` (×${t.total})` : ''}. Click for details.`)}</title>
${icon}
${t.total > 1 ? `<g><rect x="${TW / 2 + 12}" y="0" width="30" height="18" rx="9" fill="${ARCH.cloud}" stroke="var(--card)" stroke-width="2"/><text x="${TW / 2 + 27}" y="13" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">×${t.total}</text></g>` : ''}
<text x="${TW / 2}" y="78" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--fg)">${esc(clip(label, 20))}</text>
<text x="${TW / 2}" y="94" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(clip(names, 22))}</text></g>`);
  }
  if (note) svg.push(`<text x="${minX + 12}" y="${maxY + 14}" font-size="11" fill="var(--muted)">${note}</text>`);
  svg.push('</svg>');
  return svg.join('\n');
}

// ---- Stack view: a stack.json (capability lists per tier) drawn as tier boxes with service icons ----
const ST = { TW: 138, TH: 134, G: 14, PAD: 16, HEAD: 32, CAT: 24 };
const STACK_COLORS = { routing: '#147eba', tier: '#8c4fff', nonvpc: '#6b7a8c', platform: '#0f9d8a', account: '#5b6b7f' };
const initials = (s) => String(s).replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export function renderStack(model, { animate = true } = {}) {
  const { TW, TH, G, PAD, HEAD, CAT } = ST;
  const tiles = [];                                              // every service tile, with its position
  // a box = a titled group of categories; items are laid out `perRow` per row
  const mkBox = (title, color, categories, perRow) => ({ title, color, cats: categories.map((c) => ({ title: c.title, items: c.items.map((it) => { const t = { ...it, w: TW, h: TH }; tiles.push(t); return t; }) })), perRow });
  const size = (b) => {
    const per = Math.max(1, b.perRow);
    const cols = Math.min(per, Math.max(1, ...b.cats.map((c) => c.items.length)));
    let h = HEAD;
    for (const c of b.cats) { const rows = Math.max(1, Math.ceil(c.items.length / per)); h += CAT + rows * TH + (rows - 1) * G + G; }
    return { w: cols * TW + (cols - 1) * G + 2 * PAD, h: h + PAD - G };
  };
  const place = (b, x, y) => {
    const s = size(b); Object.assign(b, { x, y, w: s.w, h: s.h });
    let cy = y + HEAD;
    for (const c of b.cats) {
      c.y = cy; cy += CAT;
      c.items.forEach((t, i) => { t.x = x + PAD + (i % b.perRow) * (TW + G); t.y = cy + Math.floor(i / b.perRow) * (TH + G); });
      cy += Math.max(1, Math.ceil(c.items.length / b.perRow)) * TH + (Math.max(1, Math.ceil(c.items.length / b.perRow)) - 1) * G + G;
    }
  };
  const groups = model.groups;
  const routing = groups.find((g) => g.key === 'cloud_routing');
  const account = groups.find((g) => g.key === 'cloud_account');
  const others = groups.filter((g) => g !== routing && g !== account);
  const boxes = [];
  const acctTiers = account?.tiers ?? [];
  const vpcTiers = acctTiers.filter((t) => /^tier/i.test(t.key));
  const looseTiers = acctTiers.filter((t) => !/^tier/i.test(t.key));
  const X0 = 150;
  const routingBoxes = routing ? routing.tiers.map((t) => mkBox(routing.title, STACK_COLORS.routing, t.categories.flatMap((c) => c.items.map((it) => ({ title: c.title, items: [it] }))), 1)) : [];
  const tierBoxes = vpcTiers.map((t) => mkBox(`${t.title} (in the VPC)`, STACK_COLORS.tier, t.categories, 4));
  const looseBoxes = looseTiers.map((t) => mkBox(`${t.title} services`, STACK_COLORS.nonvpc, t.categories, 6));
  const otherBoxes = others.flatMap((g) => g.tiers.map((t) => mkBox(g.title + (t.title ? ` · ${t.title}` : ''), STACK_COLORS.platform, t.categories, 6)));
  // columns: routing | tier 1 | tier 2.. ; loose and other boxes underneath, as wide as the columns above them
  const top = 70;
  let x = X0;
  for (const b of routingBoxes) { place(b, x, top); }
  if (routingBoxes.length) x += Math.max(...routingBoxes.map((b) => b.w)) + 40;
  const acctX = x - 14;
  const tierXs = [];
  for (const b of tierBoxes) { place(b, x, top + 40); tierXs.push(x); x += b.w + 28; }
  // the second VPC tier (database) lines up with the compute row so the flow arrow is straight
  const findTile = (re) => tiles.find((t) => t.type && re.test(t.type));
  const compute = findTile(/aws_instance|aws_autoscaling_group/);
  if (tierBoxes[1]) {
    const db = tierBoxes[1].cats.flatMap((c) => c.items)[0];
    if (compute && db) place(tierBoxes[1], tierBoxes[1].x, tierBoxes[1].y + (compute.y - db.y));
  }
  const lbTile = findTile(/aws_lb$/); const dnsTile = findTile(/route53/);
  if (routingBoxes.length && lbTile && dnsTile) for (const b of routingBoxes) place(b, b.x, b.y + (lbTile.y - dnsTile.y));   // DNS in line with the load balancer: a straight arrow
  let bottom = Math.max(top + 40, ...tierBoxes.map((b) => b.y + b.h), ...routingBoxes.map((b) => b.y + b.h));
  const innerRight = Math.max(x - 28, X0 + 400);
  let cy = bottom + 28;
  for (const b of looseBoxes) { b.perRow = Math.max(1, Math.floor((innerRight - (tierXs[0] ?? X0) - 2 * PAD + G) / (TW + G))); place(b, tierXs[0] ?? X0, cy); cy += b.h + 24; }
  const acctBottom = cy - 8;
  const acctRight = innerRight + 14;
  // platform boxes sit under the account, full width
  let py = acctBottom + 40;
  for (const b of otherBoxes) { b.perRow = Math.max(1, Math.floor((acctRight - X0 - 2 * PAD + G) / (TW + G))); place(b, X0, py); py += b.h + 24; }
  const W = Math.ceil(Math.max(acctRight, ...otherBoxes.map((b) => b.x + b.w)) + 30);
  const H = Math.ceil(py + 10);

  const meta = model.meta;
  const svg = [];
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" class="arch stack${animate ? '' : ' still'}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif">`);
  svg.push(`<style>.flow{stroke-dasharray:7 6;animation:tfflow 0.9s linear infinite}.still .flow{animation:none}@keyframes tfflow{to{stroke-dashoffset:-13}}@media (prefers-reduced-motion:reduce){.flow{animation:none}}</style>`);
  svg.push(`<defs><marker id="sarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${ARCH.flow}"/></marker></defs>`);
  // outer cloud + account frames
  const head = [meta.csp, meta.region].filter(Boolean).join(' · ') || 'Cloud';
  svg.push(`<rect x="${X0 - 12}" y="8" width="${W - X0 - 8}" height="${H - 18}" rx="8" fill="${ARCH.cloud}08" stroke="${ARCH.cloud}" stroke-width="1.5"/>`);
  svg.push(`<text x="${X0 + 6}" y="34" font-size="14" font-weight="700" fill="${ARCH.cloud}">${esc(head)}${meta.pattern ? `  ·  pattern ${esc(meta.pattern)}${meta.version ? ` ${esc(meta.version)}` : ''}` : ''}</text>`);
  if (account) svg.push(`<rect x="${acctX}" y="${top - 8}" width="${acctRight - acctX}" height="${acctBottom - top + 12}" rx="10" fill="none" stroke="${STACK_COLORS.account}" stroke-width="1.4" stroke-dasharray="6 5"/><text x="${acctX + 10}" y="${top + 8}" font-size="12.5" font-weight="700" fill="${STACK_COLORS.account}">${esc(account.title)}</text>`);
  const catLabels = [];
  const all = [...routingBoxes, ...tierBoxes, ...looseBoxes, ...otherBoxes];
  for (const b of all) {
    svg.push(`<g><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${b.color}14" stroke="${b.color}" stroke-width="1.4"/><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${HEAD - 6}" rx="8" fill="${b.color}"/><rect x="${b.x}" y="${b.y + 14}" width="${b.w}" height="12" fill="${b.color}"/><text x="${b.x + 12}" y="${b.y + 19}" font-size="13" font-weight="700" fill="#fff">${esc(clip(b.title, Math.floor(b.w / 7.4)))}</text>`);
    for (const c of b.cats) catLabels.push(`<text x="${b.x + PAD}" y="${c.y + 15}" font-size="11" font-weight="700" letter-spacing=".06em" fill="${b.color}" stroke="var(--card)" stroke-width="4" paint-order="stroke" stroke-linejoin="round">${esc(c.title.toUpperCase())}</text>`);
    svg.push('</g>');
  }

  // typical flow (inferred): Internet -> DNS -> load balancer -> compute -> database, compute -> block storage
  const edgesOut = [];
  const by = (re) => tiles.filter((t) => t.type && re.test(t.type));
  const dns = by(/route53/)[0]; const lb = by(/aws_lb$/)[0]; const asg = by(/autoscaling/)[0]; const ec2 = by(/aws_instance/)[0];
  const ebs = by(/ebs_volume/)[0]; const efs = by(/efs_file/)[0]; const db = by(/db_instance|dynamodb/)[0];
  const link = (a, b) => { if (a && b && a !== b) edgesOut.push([a, b]); };
  if (dns) { svg.push(`<g transform="translate(14 ${dns.y + 4})"><circle cx="40" cy="30" r="26" fill="${ARCH.cloud}"/><g transform="translate(18 8) scale(1.8)" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"><path d="${P.globe}"/></g><text x="40" y="76" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--fg)">Internet</text></g>`); edgesOut.push([{ x: 14, y: dns.y, w: 80, h: TH, net: true }, dns]); }
  link(dns, lb); link(lb, asg ?? ec2); link(asg, ec2); link(ec2 ?? asg, ebs); link(ec2 ?? asg, efs); link(ec2 ?? asg, db);
  const iconC = (t) => ({ cx: t.x + TW / 2, cy: t.y + 34 });
  for (const [a, b] of edgesOut) {
    const A = a.net ? { cx: a.x + 40, cy: a.y + 34 } : iconC(a); const B = iconC(b);
    let d;
    if (Math.abs(A.cy - B.cy) < 8) { const x1 = A.cx + (a.net ? 30 : 36); const x2 = B.cx - 40; d = `M${x1} ${A.cy} L${x2} ${B.cy}`; }
    else if (Math.abs(A.cx - B.cx) < 8) { const y1 = (a.net ? a.y + a.h : a.y + TH - 6); const y2 = b.y + 2; d = `M${A.cx} ${y1} L${B.cx} ${y2}`; }
    else if (Math.abs(B.cx - A.cx) > TW * 0.9 && Math.abs(B.cy - A.cy) < TH) { const x1 = A.cx + 36; const x2 = B.cx - 40; const m = (x1 + x2) / 2; d = `M${x1} ${A.cy} L${m} ${A.cy} L${m} ${B.cy} L${x2} ${B.cy}`; }
    else { const y1 = a.y + TH - 6; const y2 = b.y + 2; const m = (y1 + y2) / 2; d = `M${A.cx} ${y1} L${A.cx} ${m} L${B.cx} ${m} L${B.cx} ${y2}`; }
    svg.push(`<path d="${d}" fill="none" stroke="${ARCH.flow}" stroke-width="2.2" stroke-linejoin="round" class="flow" marker-end="url(#sarr)"><title>Typical flow, inferred from the services in this stack (stack.json does not say how they connect)</title></path>`);
  }

  svg.push(...catLabels);
  const wrap = (str, n) => { const w = String(str).split(' '); const lines = ['']; for (const x of w) { if ((lines[lines.length - 1] + ' ' + x).trim().length > n && lines[lines.length - 1]) lines.push(x); else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + x).trim(); } return lines.length > 2 ? [lines[0], clip(lines.slice(1).join(' '), n)] : lines; };
  for (const t of tiles) {
    const official = t.type && OFFICIAL[t.type];
    const color = t.vendor === 'aws' ? (COLORS.Compute) : '#64748b';
    const icon = official
      ? `<image href="icons/${esc(official)}" x="${TW / 2 - 28}" y="6" width="56" height="56" preserveAspectRatio="xMidYMid meet"/>`
      : t.type
        ? `<rect x="${TW / 2 - 28}" y="6" width="56" height="56" rx="10" fill="${COLORS[({ aws_dx_connection: 'Networking', aws_ssm_parameter: 'Security & IAM', aws_cloudtrail: 'Security & IAM' })[t.type]] ?? color}"/><g transform="translate(${TW / 2 - 18} 16) scale(1.5)" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${glyph(iconFor(t.type))}</g>`
        : `<rect x="${TW / 2 - 28}" y="6" width="56" height="56" rx="10" fill="${color}"/><text x="${TW / 2}" y="43" text-anchor="middle" font-size="20" font-weight="700" fill="#fff">${esc(initials(t.label))}</text>`;
    svg.push(`<g transform="translate(${t.x} ${t.y})"><title>${esc(`${t.label}${t.capability ? ` · ${t.capability}` : ''} (${t.raw})`)}</title>${icon}${wrap(t.label, 19).map((ln, i) => `<text x="${TW / 2}" y="${80 + i * 14}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--fg)">${esc(ln)}</text>`).join('')}<text x="${TW / 2}" y="${wrap(t.label, 19).length > 1 ? 110 : 96}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(clip(t.capability ?? '', 26))}</text>${t.vendor !== 'aws' ? `<text x="${TW / 2}" y="${wrap(t.label, 19).length > 1 ? 124 : 110}" text-anchor="middle" font-size="10" fill="var(--muted)">non-AWS tool</text>` : ''}</g>`);
  }
  svg.push('</svg>');
  return svg.join('\n');
}

// ---- Repo map: components, services and how they depend on each other (any code repository) ----
const RM = {
  W: 196, H: 68, pad: 14,
  colors: { users: '#64748b', frontend: '#2563eb', backend: '#16a34a', library: '#8b5cf6', support: '#94a3b8', data: '#d97706', infra: '#0ea5e9' },
  titles: { users: 'Users', frontend: 'Frontend', backend: 'Backend', library: 'Libraries and shared code', support: 'Support: tests, scripts, docs', data: 'Data and external services', infra: 'Delivery and infrastructure' },
  icons: { users: 'user', frontend: 'window', backend: 'server', library: 'cube', data: 'database', tests: 'folder', docs: 'doc', tooling: 'filter', config: 'folder', infra: 'containers', mobile: 'monitor', other: 'cube', external: 'cloud' },
  ext: { Database: 'database', Cache: 'bolt', 'Message queue': 'message', 'Cloud services': 'cloud', 'Auth provider': 'key', Payments: 'cert', 'AI API': 'hub', Monitoring: 'pulse', 'Email / SMS': 'message', Search: 'search', 'Object storage': 'bucket', Proxy: 'balancer' },
};

export function renderRepoMap(diagram, { animate = true } = {}) {
  const dagre = globalThis.dagre;
  const { W, H, pad, colors } = RM;
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 90, edgesep: 14, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  const groups = Object.keys(colors).filter((k) => diagram.nodes.some((n) => n.group === k));
  for (const k of groups) g.setNode(`#${k}`, {});
  for (const n of diagram.nodes) { g.setNode(n.id, { width: W + 2 * pad, height: H + 2 * pad + 6, cw: W, ch: H, ref: n }); g.setParent(n.id, `#${n.group}`); }
  for (const e of diagram.edges) if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to, { ref: e });
  dagre.layout(g);
  const lw = Math.ceil(g.graph().width); const lh = Math.ceil(g.graph().height);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" class="arch repomap${animate ? '' : ' still'}" viewBox="0 0 ${lw} ${lh}" width="${lw}" height="${lh}" font-family="system-ui, sans-serif">`);
  out.push('<style>.flow{stroke-dasharray:7 6;animation:tfflow 0.9s linear infinite}.still .flow{animation:none}@keyframes tfflow{to{stroke-dashoffset:-13}}@media (prefers-reduced-motion:reduce){.flow{animation:none}}</style>');
  out.push('<defs><marker id="rarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--edge)"/></marker></defs>');
  for (const k of groups) {
    const b = g.node(`#${k}`); const x = b.x - b.width / 2; const y = b.y - b.height / 2;
    out.push(`<g><rect x="${x}" y="${y}" width="${b.width}" height="${b.height}" rx="12" fill="${colors[k]}12" stroke="${colors[k]}" stroke-width="1.4"/><text x="${x + 12}" y="${y + 17}" font-size="11.5" font-weight="700" letter-spacing=".04em" fill="${colors[k]}">${esc(RM.titles[k].toUpperCase())}</text></g>`);
  }
  for (const e of g.edges()) {
    const pts = g.edge(e).points.map((p) => ({ ...p })); const a = g.node(e.v); const z = g.node(e.w); const ref = g.edge(e).ref;
    pts[0] = { x: a.x + a.cw / 2, y: a.y }; pts[pts.length - 1] = { x: z.x - z.cw / 2 - 2, y: z.y };
    if (a.x > z.x) { pts[0] = { x: a.x - a.cw / 2, y: a.y }; pts[pts.length - 1] = { x: z.x + z.cw / 2 + 2, y: z.y }; }
    let d = `M${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) { const p = pts[i - 1]; const q = pts[i]; const m = (p.x + q.x) / 2; d += ` L${m} ${p.y} L${m} ${q.y} L${q.x} ${q.y}`; }
    const mid = pts[Math.floor(pts.length / 2)];
    const tip = `${ref.label || 'depends on'}${ref.inferred ? ' (inferred, not read from the code)' : ''}`;
    const pill = ref.label && ref.label !== 'imports' ? `<g transform="translate(${mid.x} ${mid.y})"><rect x="${-(ref.label.length * 3.1 + 7)}" y="-9" width="${ref.label.length * 6.2 + 14}" height="18" rx="9" fill="var(--card)" stroke="var(--edge)"/><text y="4" text-anchor="middle" font-size="10.5" fill="var(--muted)">${esc(clip(ref.label, 22))}</text></g>` : '';
    out.push(`<g><title>${esc(tip)}</title><path d="${d}" fill="none" stroke="var(--edge)" stroke-width="1.6" stroke-linejoin="round"${ref.inferred ? ' stroke-dasharray="6 5"' : ''} marker-end="url(#rarr)"/>${pill}</g>`);
  }
  for (const id of g.nodes()) {
    const b = g.node(id); const n = b.ref; if (!n) continue;
    const color = colors[n.group] ?? '#64748b';
    const x = b.x - b.cw / 2; const y = b.y - b.ch / 2;
    const icon = n.kind === 'external' ? RM.ext[n.category] ?? RM.icons.external : RM.icons[n.kind] ?? RM.icons.library;
    out.push(`<g transform="translate(${x} ${y})"><title>${esc(`${n.label}${n.sub ? ` · ${n.sub}` : ''}${n.path ? ` (${n.path})` : ''}${n.entry ? `. Entry: ${n.entry}` : ''}`)}</title>
<rect width="${b.cw}" height="${b.ch}" rx="10" fill="var(--card)" stroke="${color}" stroke-width="1.6"/>
<rect x="1" y="1" width="46" height="${b.ch - 2}" rx="9" fill="${color}"/><rect x="30" y="1" width="17" height="${b.ch - 2}" fill="${color}"/>
<g transform="translate(11 ${b.ch / 2 - 13})" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyph(icon)}</g>
<text x="58" y="${b.ch / 2 - 4}" font-size="13" font-weight="700" fill="var(--fg)">${esc(clip(n.label, 21))}</text>
<text x="58" y="${b.ch / 2 + 13}" font-size="11.5" fill="var(--muted)">${esc(clip(n.sub ?? '', 27))}</text>
${n.techs?.length ? `<text x="58" y="${b.ch - 6}" font-size="10" fill="${color}" font-weight="600">${esc(clip(n.techs.join(' · '), 28))}</text>` : ''}</g>`);
  }
  out.push('</svg>');
  return out.join('\n');
}
