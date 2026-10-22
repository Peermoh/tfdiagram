// Shared by the browser (diagram filtering + Mermaid output) and the tests.

const FRIENDLY = {
  vpc: 'VPC', subnet: 'Subnet', network_acl: 'Network ACL', route_table: 'Route table', route: 'Route',
  nat_gateway: 'NAT gateway', internet_gateway: 'Internet gateway', egress_only_internet_gateway: 'Egress-only gateway',
  eip: 'Elastic IP', vpn_gateway: 'VPN gateway', customer_gateway: 'Customer gateway', flow_log: 'Flow log',
  db_subnet_group: 'DB subnet group', redshift_subnet_group: 'Redshift subnet group', elasticache_subnet_group: 'ElastiCache subnet group',
  default_vpc: 'Default VPC', default_network_acl: 'Default network ACL', default_route_table: 'Default route table', default_security_group: 'Default security group',
  vpc_dhcp_options: 'DHCP options', security_group: 'Security group', iam_role: 'IAM role', iam_policy: 'IAM policy', instance: 'EC2 instance',
  s3_bucket: 'S3 bucket', db_instance: 'RDS database', lambda_function: 'Lambda function', lb: 'Load balancer', alb: 'Load balancer',
  virtual_network: 'Virtual network', linux_virtual_machine: 'Linux VM', windows_virtual_machine: 'Windows VM', storage_account: 'Storage account',
  key_vault: 'Key vault', network_security_group: 'Network security group', public_ip: 'Public IP', network_interface: 'Network interface',
  resource_group: 'Resource group', mssql_server: 'SQL server', kubernetes_cluster: 'AKS cluster',
  // Azure
  route_table_azure: 'Route table', lb_backend_address_pool: 'LB backend pool', lb_probe: 'LB health probe', lb_rule: 'LB rule',
  lb_nat_rule: 'LB NAT rule', application_gateway: 'Application gateway', firewall: 'Firewall', firewall_policy: 'Firewall policy',
  bastion_host: 'Bastion host', private_endpoint: 'Private endpoint', private_dns_zone: 'Private DNS zone', dns_zone: 'DNS zone',
  virtual_network_gateway: 'VPN gateway', local_network_gateway: 'Local network gateway', virtual_network_peering: 'VNet peering',
  linux_virtual_machine_scale_set: 'Linux VM scale set', windows_virtual_machine_scale_set: 'Windows VM scale set',
  availability_set: 'Availability set', managed_disk: 'Managed disk', container_registry: 'Container registry', container_app: 'Container app',
  container_group: 'Container instance', service_plan: 'App Service plan', app_service_plan: 'App Service plan',
  linux_web_app: 'Linux web app', windows_web_app: 'Windows web app', linux_function_app: 'Function app', windows_function_app: 'Function app',
  mssql_database: 'SQL database', mssql_managed_instance: 'SQL managed instance', postgresql_flexible_server: 'PostgreSQL server',
  mysql_flexible_server: 'MySQL server', cosmosdb_account: 'Cosmos DB account', redis_cache: 'Redis cache',
  servicebus_namespace: 'Service Bus namespace', servicebus_queue: 'Service Bus queue', servicebus_topic: 'Service Bus topic',
  eventhub_namespace: 'Event Hubs namespace', eventhub: 'Event hub', eventgrid_topic: 'Event Grid topic',
  log_analytics_workspace: 'Log Analytics workspace', application_insights: 'Application Insights', monitor_action_group: 'Action group',
  api_management: 'API Management', cdn_profile: 'CDN profile', cdn_endpoint: 'CDN endpoint', traffic_manager_profile: 'Traffic Manager',
  user_assigned_identity: 'Managed identity', role_assignment: 'Role assignment', application_security_group: 'Application security group',
  nat_gateway: 'NAT gateway', virtual_network: 'Virtual network', key_vault_secret: 'Key vault secret', storage_container: 'Storage container',
};
const ACRONYMS = { ssm: 'SSM', ami: 'AMI', eks: 'EKS', ecs: 'ECS', ecr: 'ECR', kms: 'KMS', sqs: 'SQS', sns: 'SNS', acm: 'ACM', efs: 'EFS', ebs: 'EBS', waf: 'WAF', wafv2: 'WAFv2', dynamodb: 'DynamoDB', elasticache: 'ElastiCache', cloudfront: 'CloudFront', route53: 'Route 53', opensearch: 'OpenSearch', msk: 'MSK', emr: 'EMR', aks: 'AKS', api: 'API', cdn: 'CDN', vpc: 'VPC', acl: 'ACL', nat: 'NAT', vpn: 'VPN', db: 'DB', rds: 'RDS', ec2: 'EC2', iam: 'IAM', s3: 'S3', ip: 'IP', dns: 'DNS', sql: 'SQL', vm: 'VM', lb: 'LB', eip: 'EIP' };

// "network_acl" -> "Network ACL"; unknown types are spelled out ("db_subnet_group" -> "DB subnet group").
export function friendlyType(type) {
  const t = String(type).replace(/^(aws_|azurerm_)/, '');
  if (FRIENDLY[t]) return FRIENDLY[t];
  const words = t.split('_').map((w) => ACRONYMS[w] ?? w);
  return words[0][0].toUpperCase() + words[0].slice(1) + (words.length > 1 ? ' ' + words.slice(1).join(' ') : '');
}

// "10.0.0.0/16" or "10.0.1.0/24 +2" for the card's IP-range line.
export function cidrText(cidrs) {
  if (!cidrs?.length) return '';
  return cidrs.length > 1 ? `${cidrs[0]} +${cidrs.length - 1}` : cidrs[0];
}

export function plural(word) {
  if (/(s|x|ch|sh)$/i.test(word)) return word + 'es';
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

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
    const core = new Set(leaves.filter((n) => (!layers || layers.has(n.category)) && (!q || `${n.type} ${n.name} ${n.label ?? ''} ${(n.cidrs ?? []).join(' ')} ${n.id}`.toLowerCase().includes(q))).map((n) => n.id));
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
// Links that exist only through a hidden association (`weak`) never make another arrow redundant: a subnet is
// "in" its VPC even though its route table is too.
export function reduceEdges(edges) {
  const out = new Map();
  for (const e of edges) { if (e.weak || e.ordering) continue; if (!out.has(e.from)) out.set(e.from, new Set()); out.get(e.from).add(e.to); }
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
    if (!e.weak && !e.ordering && reaches(e.from, e.to, e.to)) out.get(e.from).delete(e.to);
    else kept.push(e);
  }
  return kept;
}

// Overview: one box per resource type per scope ("subnet x7"), so big stacks read like an architecture sketch.
export function summarize(graph) {
  const groupOf = new Map();
  const groups = new Map();
  const nodes = [];
  const nameOf = new Map(graph.nodes.map((n) => [n.id, n.label ?? n.name]));
  for (const n of graph.nodes) {
    if (isContainer(n) || n.kind === 'module') { groupOf.set(n.id, n.id); nodes.push(n); continue; }
    const id = `${n.parent}::${n.type}`;
    groupOf.set(n.id, id);
    if (!groups.has(id)) {
      groups.set(id, { id, kind: 'group', type: n.type, category: n.category, parent: n.parent, file: n.file, line: n.line, names: [], cidrs: [], ghost: true, inactive: true, count: 0, members: 0,
        // a lone resource keeps its own details; they are dropped as soon as a second one joins the group
        name: n.name, label: n.label, details: n.details, summary: n.summary });
      nodes.push(groups.get(id));
    }
    const g = groups.get(id);
    if (g.members === 1) { delete g.name; delete g.label; delete g.details; delete g.summary; }
    g.names.push(n.label ?? n.name);
    for (const c of n.cidrs ?? []) if (!g.cidrs.includes(c)) g.cidrs.push(c);
    g.members++;
    g.count += n.instances ?? 1;                    // a resource with count = 3 stands for 3 things
    g.ghost = g.ghost && Boolean(n.ghost);          // dimmed only if every member is
    g.inactive = g.inactive && Boolean(n.inactive);
  }
  // one arrow per pair of groups; remember which individual links it stands for (shown on hover, counted on the arrow)
  const merged = new Map();
  for (const e of graph.edges) {
    const from = groupOf.get(e.from);
    const to = groupOf.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\t${to}`;
    if (!merged.has(key)) merged.set(key, { from, to, pairs: [] });
    merged.get(key).pairs.push([nameOf.get(e.from) ?? e.from, nameOf.get(e.to) ?? e.to]);
  }
  const edges = [...merged.values()].map((e) => ({ ...e, count: e.pairs.length }));
  // a grouped arrow is weak only if every link in it is
  const strong = new Set(graph.edges.filter((e) => !e.weak).map((e) => `${groupOf.get(e.from)}\t${groupOf.get(e.to)}`));
  for (const e of edges) if (!strong.has(`${e.from}\t${e.to}`)) e.weak = true;
  // an arrow that only says "after" (depends_on) is drawn dashed
  const real = new Set(graph.edges.filter((e) => !e.ordering).map((e) => `${groupOf.get(e.from)}\t${groupOf.get(e.to)}`));
  for (const e of edges) if (!real.has(`${e.from}\t${e.to}`) && graph.edges.some((x) => x.ordering && groupOf.get(x.from) === e.from && groupOf.get(x.to) === e.to)) e.ordering = true;
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
      : `${esc(n.type.replace(/^(aws_|azurerm_)/, ''))}<br/><b>${esc(n.label ?? n.name)}</b>`;
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
