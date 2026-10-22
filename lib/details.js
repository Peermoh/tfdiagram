// Extracts what a security group / network security group allows and what a route table routes,
// from inline blocks and from the separate rule / route resources that point at them.
import { matchBrace, parseLocals } from './parse.js';
import { substitute } from './cidr.js';
import { friendlyType } from '../public/render.js';

export const DETAIL_TYPES = new Set([
  'aws_security_group', 'aws_default_security_group', 'azurerm_network_security_group',
  'aws_route_table', 'aws_default_route_table', 'azurerm_route_table',
]);
// Resources whose only job is to add a rule/route to another resource (hidden as plumbing).
export const ATTACH_TYPES = {
  aws_security_group_rule: { into: 'security_group_id', kind: 'rules' },
  aws_vpc_security_group_ingress_rule: { into: 'security_group_id', kind: 'rules', dir: 'in' },
  aws_vpc_security_group_egress_rule: { into: 'security_group_id', kind: 'rules', dir: 'out' },
  azurerm_network_security_rule: { into: 'network_security_group_name', kind: 'rules' },
  aws_route: { into: 'route_table_id', kind: 'routes' },
  azurerm_route: { into: 'route_table_name', kind: 'routes' },
  // sub-resources folded into their parent as "settings" rows
  aws_s3_bucket_versioning: { into: 'bucket', kind: 'settings' },
  aws_s3_bucket_server_side_encryption_configuration: { into: 'bucket', kind: 'settings' },
  aws_s3_bucket_public_access_block: { into: 'bucket', kind: 'settings' },
  aws_s3_bucket_policy: { into: 'bucket', kind: 'settings' },
  aws_s3_bucket_lifecycle_configuration: { into: 'bucket', kind: 'settings' },
  aws_s3_bucket_logging: { into: 'bucket', kind: 'settings' },
  aws_s3_bucket_acl: { into: 'bucket', kind: 'settings' },
  aws_s3_bucket_cors_configuration: { into: 'bucket', kind: 'settings' },
  aws_s3_bucket_website_configuration: { into: 'bucket', kind: 'settings' },
  aws_lb_listener: { into: 'load_balancer_arn', kind: 'settings' },
  azurerm_lb_rule: { into: 'loadbalancer_id', kind: 'settings' },
  azurerm_lb_probe: { into: 'loadbalancer_id', kind: 'settings' },
  azurerm_lb_backend_address_pool: { into: 'loadbalancer_id', kind: 'settings' },
  azurerm_lb_nat_rule: { into: 'loadbalancer_id', kind: 'settings' },
  aws_volume_attachment: { into: 'volume_id', kind: 'settings' },
  azurerm_virtual_machine_data_disk_attachment: { into: 'managed_disk_id', kind: 'settings' },
  azurerm_storage_container: { into: 'storage_account_name', kind: 'settings' },
  azurerm_storage_share: { into: 'storage_account_name', kind: 'settings' },
};

// Bodies of `name { ... }` blocks inside `body`, including dynamic "name" { content { ... } } ones.
export function nestedBlocks(body, name) {
  const out = [];
  const find = (re, pick) => {
    let m;
    while ((m = re.exec(body))) {
      const open = m.index + m[0].length - 1;
      const end = matchBrace(body, open);
      const inner = body.slice(open + 1, end - 1);
      const b = pick(inner);
      if (b !== null) out.push(b);
      re.lastIndex = end;
    }
  };
  find(new RegExp(`^[ \\t]*${name}\\s*\\{`, 'gm'), (inner) => ({ body: inner, dynamic: false }));
  find(new RegExp(`^[ \\t]*dynamic\\s+"${name}"\\s*\\{`, 'gm'), (inner) => {
    const c = nestedBlocks(inner, 'content')[0];
    return c ? { body: c.body, dynamic: true, forEach: parseLocals(inner).for_each } : null;
  });
  return out;
}

const short = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const strip = (s) => s.replace(/\$\{\s*(?:var|local)\.([\w-]+)[^}]*\}/g, '{$1}');

// ---- reading expression text ------------------------------------------------------------------
// Terraform expressions can't be evaluated here, so read what is plain and say "varies" for the rest.
const COMPUTED = /\b[a-z_]+\s*\(|\.value\b|\[\s*for\b|\{\s*for\b|\bcount\.index\b|\bindex\(/;
const unwrap = (t) => { let x = t.trim(); while (/^\(.*\)$/s.test(x) && balanced(x.slice(1, -1))) x = x.slice(1, -1).trim(); return x; };
function balanced(t) { let d = 0; for (const c of t) { if (c === '(') d++; else if (c === ')' && --d < 0) return false; } return d === 0; }

// Splits `cond ? a : b` at its top-level ? and : (ignoring strings and brackets).
function splitTernary(t) {
  let depth = 0; let str = false; let q = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === '?' && q < 0) q = i;
    else if (depth === 0 && c === ':' && q >= 0) return [t.slice(0, q), t.slice(q + 1, i), t.slice(i + 1)];
  }
  return null;
}

// Splits at top-level occurrences of sep (outside strings and brackets).
function splitTop(t, sep) {
  const parts = []; let depth = 0; let str = false; let from = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && t.startsWith(sep, i)) { parts.push(t.slice(from, i)); i += sep.length - 1; from = i + 1; }
  }
  parts.push(t.slice(from));
  return parts;
}

// true / false when a condition can be worked out from literals, otherwise null.
function evalCond(text) {
  const t = unwrap(text);
  const or = splitTop(t, '||');
  if (or.length > 1) { const r = or.map(evalCond); return r.includes(true) ? true : r.every((x) => x === false) ? false : null; }
  const and = splitTop(t, '&&');
  if (and.length > 1) { const r = and.map(evalCond); return r.includes(false) ? false : r.every((x) => x === true) ? true : null; }
  if (t.startsWith('!') && !t.startsWith('!=')) { const r = evalCond(t.slice(1)); return r === null ? null : !r; }
  for (const [op, same] of [['==', true], ['!=', false]]) {
    const sides = splitTop(t, op);
    if (sides.length === 2) {
      const [l, r] = sides.map((x) => unwrap(x));
      const lit = (x) => /^("[^"]*"|-?\d+(\.\d+)?|true|false|null)$/.test(x);
      return lit(l) && lit(r) ? (l === r) === same : null;
    }
  }
  return t === 'true' ? true : t === 'false' ? false : null;
}

// Resolves conditionals whose condition can be worked out; otherwise the whole expression stays (and reads as computed).
export function simplify(text) {
  let t = unwrap(text.replace(/\$\{\s*\(*\s*"((?:[^"\\]|\\.)*)"\s*\)*\s*\}/g, '$1')); // "${("x")}-" -> "x-"
  for (let i = 0; i < 4; i++) {
    const parts = splitTernary(t);
    if (!parts) break;
    const cond = evalCond(parts[0]);
    if (cond === null) return t;
    t = unwrap(cond ? parts[1] : parts[2]);
  }
  return unwrap(t);
}

export const isComputed = (text) => COMPUTED.test(text) || /\?/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, ''));

// An attribute's plain values as a list of strings; [] when unset (null) or only known at deploy time.
function listOf(expr, scope, lookup) {
  if (expr === undefined) return [];
  const text = simplify(substitute(expr, scope, lookup));
  if (text === 'null' || text === '' || isComputed(text)) return [];
  const quoted = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => strip(m[1]));
  if (quoted.length) return quoted;
  const bare = unwrap(text.replace(/^\[|\]$/g, ''));
  return bare && bare !== 'null' ? [short(bare)] : [];
}

// true when the attribute exists but its value can only be known at deploy time
const varies = (expr, scope, lookup) => expr !== undefined && isComputed(simplify(substitute(expr, scope, lookup)));

// A dynamic block over an empty list/map (a variable defaulting to []) produces nothing.
function emptyLoop(forEach, scope, lookup) {
  if (forEach === undefined) return false;
  const t = simplify(substitute(forEach, scope, lookup)).replace(/\s+/g, '');
  return /^(\[\]|\{\}|toset\(\[\]\)|tomap\(\{\}\)|tolist\(\[\]\))$/.test(t);
}

// "aws_internet_gateway.igw.id" -> "Internet gateway igw"
const REF = /\b(?:data\.)?((?:aws|azurerm)_[a-z0-9_]+)\.([A-Za-z_][\w-]*)/;
function refLabel(expr, scope, lookup) {
  const m = REF.exec(substitute(expr ?? '', scope, lookup));
  return m ? `${friendlyType(m[1])} ${m[2]}` : null;
}
// Every resource an expression refers to, in order: `try(aws_x.a[0].id, aws_vpc.this[0].id)` gives both.
export function refIds(expr, scope, lookup) {
  return [...substitute(expr ?? '', scope, lookup).matchAll(new RegExp(REF.source, 'g'))].map((m) => ({ type: m[1], name: m[2], id: `${scope}${m[1]}.${m[2]}` }));
}
export function refId(expr, scope, lookup) {
  const m = REF.exec(substitute(expr ?? '', scope, lookup));
  return m ? { type: m[1], name: m[2], id: `${scope}${m[1]}.${m[2]}` } : null;
}

const protoOf = (p) => (p === undefined ? '' : (p === '-1' || p === '*' || /^all$/i.test(p) ? 'all' : p.toLowerCase()));
const isPort = (p) => /^\d+$/.test(p ?? '');
function portsOf(from, to, proto) {
  if (proto === 'all') return 'all';
  if (from === undefined && to === undefined) return '';
  // ports that come from a loop variable or an unset variable can't be known statically
  if (!isPort(from) || (to !== undefined && !isPort(to))) return 'varies';
  if (from === to || to === undefined) return from;
  return from === '0' && to === '65535' ? 'all' : `${from}-${to}`;
}

// "var.default_routes" for a loop whose list isn't known
const listOfLoop = (forEach, scope, lookup) => short((forEach ?? '').replace(/\s+/g, ' ').trim() || 'a variable', 40);

// ---- security groups -------------------------------------------------------------------------
function awsRule(attrs, dir, scope, lookup, extra = {}) {
  const one = (k) => listOf(attrs[k], scope, lookup)[0];
  const proto = protoOf(one('protocol') ?? one('ip_protocol'));
  const peers = [
    ...listOf(attrs.cidr_blocks, scope, lookup), ...listOf(attrs.ipv6_cidr_blocks, scope, lookup),
    ...listOf(attrs.cidr_ipv4, scope, lookup), ...listOf(attrs.cidr_ipv6, scope, lookup),
    ...['security_groups', 'source_security_group_id', 'referenced_security_group_id'].flatMap((k) => (attrs[k] === undefined ? [] : [refLabel(attrs[k], scope, lookup) ?? listOf(attrs[k], scope, lookup).join(', ')])),
    ...(/true/.test(attrs.self ?? '') ? ['itself'] : []),
    ...((attrs.prefix_list_ids !== undefined && !varies(attrs.prefix_list_ids, scope, lookup)) || (attrs.prefix_list_id !== undefined && !varies(attrs.prefix_list_id, scope, lookup)) ? ['prefix list'] : []),
  ].filter(Boolean);
  const anyVaries = ['cidr_blocks', 'ipv6_cidr_blocks', 'security_groups', 'cidr_ipv4', 'prefix_list_ids', 'prefix_list_id'].some((k) => varies(attrs[k], scope, lookup));
  if (anyVaries && !peers.length) peers.push('varies');
  return { dir, action: 'Allow', proto: proto || (varies(attrs.protocol, scope, lookup) ? 'varies' : ''), ports: portsOf(one('from_port') ?? (varies(attrs.from_port, scope, lookup) ? 'varies' : undefined), one('to_port') ?? (varies(attrs.to_port, scope, lookup) ? 'varies' : undefined), proto), peers, note: one('description') ?? '', ...extra };
}

function azureRule(attrs, scope, lookup) {
  const all = (...keys) => keys.flatMap((k) => listOf(attrs[k], scope, lookup));
  const dir = /^out/i.test(listOf(attrs.direction, scope, lookup)[0] ?? '') ? 'out' : 'in';
  const ports = all('destination_port_range', 'destination_port_ranges').map((p) => (p === '*' ? 'all' : p)).join(', ');
  const peers = (dir === 'in' ? all('source_address_prefix', 'source_address_prefixes') : all('destination_address_prefix', 'destination_address_prefixes')).map((p) => (p === '*' ? 'any' : p));
  return {
    dir, action: listOf(attrs.access, scope, lookup)[0] ?? 'Allow', proto: protoOf(listOf(attrs.protocol, scope, lookup)[0]),
    ports, peers, note: listOf(attrs.name, scope, lookup)[0] ?? '', priority: listOf(attrs.priority, scope, lookup)[0],
  };
}

function ruleRows(type, body, scope, lookup, forcedDir) {
  const attrs = parseLocals(body);
  if (type.startsWith('azurerm_')) return [azureRule(attrs, scope, lookup)];
  const dir = forcedDir ?? (/egress/i.test(listOf(attrs.type, scope, lookup)[0] ?? '') ? 'out' : 'in');
  return [awsRule(attrs, dir, scope, lookup)];
}

// ---- route tables ----------------------------------------------------------------------------
const AWS_TARGETS = ['gateway_id', 'nat_gateway_id', 'transit_gateway_id', 'vpc_endpoint_id', 'vpc_peering_connection_id', 'network_interface_id', 'egress_only_gateway_id', 'carrier_gateway_id', 'local_gateway_id', 'instance_id', 'core_network_arn'];
function routeRow(type, attrs, scope, lookup) {
  if (type.startsWith('azurerm_')) {
    const hop = listOf(attrs.next_hop_type, scope, lookup)[0] ?? '';
    const ip = listOf(attrs.next_hop_in_ip_address, scope, lookup)[0];
    return { dest: listOf(attrs.address_prefix, scope, lookup).join(', ') || (varies(attrs.address_prefix, scope, lookup) ? 'varies' : '?'), target: ip ? `${hop} ${ip}` : hop, note: listOf(attrs.name, scope, lookup)[0] ?? '' };
  }
  const key = AWS_TARGETS.find((k) => attrs[k] !== undefined);
  const dest = [attrs.destination_cidr_block, attrs.destination_ipv6_cidr_block, attrs.cidr_block, attrs.ipv6_cidr_block, attrs.destination_prefix_list_id]
    .filter((x) => x !== undefined).flatMap((x) => listOf(x, scope, lookup));
  return {
    dest: dest.join(', ') || (['destination_cidr_block', 'cidr_block'].some((k) => varies(attrs[k], scope, lookup)) ? 'varies' : '?'),
    target: key ? (refLabel(attrs[key], scope, lookup) ?? (listOf(attrs[key], scope, lookup).join(', ') || (varies(attrs[key], scope, lookup) ? 'varies' : ''))) : '',
    note: '',
  };
}

// ---- settings (every other resource) -----------------------------------------------------------
const pretty = (k) => { const t = k.replace(/_/g, ' '); return t[0].toUpperCase() + t.slice(1); };
// attributes that are noise in a settings table
const SKIP = new Set(['tags', 'tags_all', 'count', 'for_each', 'depends_on', 'provider', 'lifecycle', 'timeouts', 'provisioner', 'connection', 'id', 'region', 'description']);

// A value as short readable text: references become "Subnet pub", lists are joined, code becomes "(computed)".
// Returns null for unset values (null / empty), so the row can be skipped.
function describe(expr, scope, lookup) {
  const raw = expr.trim();
  if (/^<<-?\w+/.test(raw)) return '(inline document)';
  const text = simplify(substitute(raw, scope, lookup));
  if (text === 'null' || text === '' || text === '""' || text === '[]' || text === '{}') return null;
  const refs = [...new Set([...text.matchAll(new RegExp(REF.source, 'g'))].map((m) => `${friendlyType(m[1])} ${m[2]}`))];
  const bare = /^(var|local)\.([\w-]+)$/.exec(text);
  if (bare) return `from ${bare[1] === 'var' ? 'variable' : 'local'} ${bare[2]}`; // not set anywhere we can see
  if (refs.length && !/\b(merge|concat|flatten)\(/.test(text)) return refs.slice(0, 4).join(', ') + (refs.length > 4 ? ` +${refs.length - 4}` : '');
  if (isComputed(text)) return '(computed)';
  const quoted = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => strip(m[1]));
  if (quoted.length) return short(quoted.slice(0, 4).join(', '), 70);
  return short(text.replace(/\s+/g, ' ').replace(/^[([\s]+|[)\]\s]+$/g, '').trim(), 70);
}

// which attributes matter most per type (shown first); the rest follow in file order
const KEY_ORDER = {
  aws_instance: ['instance_type', 'ami', 'subnet_id', 'vpc_security_group_ids', 'iam_instance_profile'],
  aws_ebs_volume: ['size', 'type', 'encrypted', 'iops', 'throughput', 'availability_zone', 'kms_key_id', 'snapshot_id'],
  aws_lb: ['load_balancer_type', 'internal', 'subnets', 'security_groups', 'ip_address_type'],
  aws_alb: ['load_balancer_type', 'internal', 'subnets', 'security_groups'],
  aws_lb_target_group: ['port', 'protocol', 'target_type', 'vpc_id'],
  aws_s3_bucket: ['bucket', 'bucket_prefix', 'force_destroy'],
  aws_db_instance: ['engine', 'engine_version', 'instance_class', 'allocated_storage', 'multi_az', 'storage_encrypted', 'publicly_accessible'],
  aws_lambda_function: ['runtime', 'handler', 'memory_size', 'timeout', 'role'],
  aws_eks_cluster: ['version', 'role_arn'],
  azurerm_storage_account: ['account_tier', 'account_replication_type', 'account_kind', 'access_tier', 'min_tls_version'],
  azurerm_managed_disk: ['disk_size_gb', 'storage_account_type', 'create_option'],
  azurerm_lb: ['sku', 'sku_tier'],
  azurerm_linux_virtual_machine: ['size', 'admin_username', 'network_interface_ids'],
  azurerm_windows_virtual_machine: ['size', 'admin_username', 'network_interface_ids'],
  azurerm_kubernetes_cluster: ['kubernetes_version', 'dns_prefix', 'sku_tier'],
  azurerm_mssql_database: ['sku_name', 'max_size_gb', 'server_id'],
  azurerm_service_plan: ['os_type', 'sku_name'],
  azurerm_redis_cache: ['sku_name', 'family', 'capacity'],
  azurerm_key_vault: ['sku_name', 'tenant_id'],
};

// useful nested blocks: [block, label prefix, keys]
const NESTED = {
  aws_instance: [['root_block_device', 'Root volume', ['volume_size', 'volume_type', 'encrypted']], ['ebs_block_device', 'Extra volume', ['device_name', 'volume_size', 'volume_type']]],
  aws_lb_target_group: [['health_check', 'Health check', ['protocol', 'port', 'path']]],
  azurerm_linux_virtual_machine: [['os_disk', 'OS disk', ['storage_account_type', 'disk_size_gb']], ['source_image_reference', 'Image', ['publisher', 'offer', 'sku']]],
  azurerm_windows_virtual_machine: [['os_disk', 'OS disk', ['storage_account_type', 'disk_size_gb']], ['source_image_reference', 'Image', ['publisher', 'offer', 'sku']]],
  azurerm_kubernetes_cluster: [['default_node_pool', 'Node pool', ['vm_size', 'node_count', 'min_count', 'max_count']]],
  azurerm_lb: [['frontend_ip_configuration', 'Frontend', ['name', 'public_ip_address_id', 'subnet_id']]],
  aws_s3_bucket: [['versioning', 'Versioning', ['enabled']]],
};

export function settingsRows(type, body, scope, lookup) {
  const attrs = parseLocals(body);
  const order = KEY_ORDER[type] ?? [];
  const keys = [...order.filter((k) => attrs[k] !== undefined), ...Object.keys(attrs).filter((k) => !order.includes(k))]
    .filter((k) => !SKIP.has(k) && attrs[k].trim() !== '');
  const rows = keys.map((k) => ({ k, key: pretty(k), value: describe(attrs[k], scope, lookup) })).filter((r) => r.value !== null).slice(0, 14);
  for (const [block, label, want] of NESTED[type] ?? []) {
    for (const b of nestedBlocks(body, block)) {
      const a = parseLocals(b.body);
      const bits = want.filter((w) => a[w] !== undefined).map((w) => `${w.replace(/^(volume_|disk_|vm_)/, '').replace(/_/g, ' ')} ${describe(a[w], scope, lookup)}`);
      if (bits.length) rows.push({ k: block, key: label, value: bits.join(', ') });
    }
  }
  return rows;
}

// ---- sub-resources folded into the parent as rows -----------------------------------------------
function foldRows(type, body, attrs, scope, lookup) {
  const one = (k) => (attrs[k] === undefined ? undefined : describe(attrs[k], scope, lookup));
  const inner = (...path) => path.reduce((bodies, name) => bodies.flatMap((b) => nestedBlocks(b, name).map((x) => x.body)), [body]);
  const attr = (b, k) => { const v = parseLocals(b)[k]; return v === undefined ? undefined : describe(v, scope, lookup); };
  switch (type) {
    case 'aws_s3_bucket_versioning': return [{ k: 'versioning', key: 'Versioning', value: attr(inner('versioning_configuration')[0] ?? '', 'status') ?? 'configured' }];
    case 'aws_s3_bucket_server_side_encryption_configuration': {
      const d = inner('rule', 'apply_server_side_encryption_by_default')[0] ?? '';
      const key = attr(d, 'kms_master_key_id');
      return [{ k: 'encryption', key: 'Encryption', value: `${attr(d, 'sse_algorithm') ?? 'enabled'}${key ? ` (${key})` : ''}` }];
    }
    case 'aws_s3_bucket_public_access_block': {
      const names = ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets'];
      const open = names.filter((n) => !/true/.test(attrs[n] ?? 'false'));
      return [{ k: 'public_access', key: 'Public access', value: open.length ? `not blocked: ${open.map((n) => n.replace(/_/g, ' ')).join(', ')}` : 'all blocked' }];
    }
    case 'aws_s3_bucket_policy': return [{ k: 'policy', key: 'Bucket policy', value: one('policy') ?? 'attached' }];
    case 'aws_s3_bucket_lifecycle_configuration': { const n = nestedBlocks(body, 'rule').length; return [{ k: 'lifecycle', key: 'Lifecycle', value: `${n} rule${n === 1 ? '' : 's'}` }]; }
    case 'aws_s3_bucket_logging': return [{ k: 'logging', key: 'Access logging', value: `to ${one('target_bucket') ?? 'a log bucket'}` }];
    case 'aws_s3_bucket_acl': return [{ k: 'acl', key: 'ACL', value: one('acl') ?? 'set' }];
    case 'aws_s3_bucket_cors_configuration': return [{ k: 'cors', key: 'CORS', value: 'configured' }];
    case 'aws_s3_bucket_website_configuration': return [{ k: 'website', key: 'Static website', value: 'enabled' }];
    case 'aws_lb_listener': {
      const a = inner('default_action')[0] ?? '';
      const kind = attr(a, 'type');
      const target = attr(a, 'target_group_arn');
      const redirect = inner('default_action', 'redirect')[0];
      const go = kind === 'redirect' ? `redirect to ${redirect ? `${attr(redirect, 'protocol') ?? ''} ${attr(redirect, 'port') ?? ''}`.trim() : 'another port'}`
        : kind === 'fixed-response' ? 'fixed response' : target ? `forward to ${target}` : kind ?? '';
      return [{ k: 'listener', key: 'Listener', value: `${[one('protocol') ?? 'HTTP', one('port')].filter(Boolean).join(' ')} → ${go}`.trim() }];
    }
    case 'azurerm_lb_rule': return [{ k: 'lb_rule', key: 'Rule', value: `${one('name') ?? ''}: ${one('protocol') ?? ''} ${one('frontend_port') ?? ''} → ${one('backend_port') ?? ''}`.trim() }];
    case 'azurerm_lb_probe': return [{ k: 'probe', key: 'Health probe', value: `${one('name') ?? ''}: ${one('protocol') ?? ''} :${one('port') ?? ''}${one('request_path') ?? ''}`.trim() }];
    case 'azurerm_lb_backend_address_pool': return [{ k: 'pool', key: 'Backend pool', value: one('name') ?? 'pool' }];
    case 'azurerm_lb_nat_rule': return [{ k: 'nat_rule', key: 'NAT rule', value: `${one('name') ?? ''}: ${one('frontend_port') ?? ''} → ${one('backend_port') ?? ''}`.trim() }];
    case 'aws_volume_attachment': return [{ k: 'attached', key: 'Attached to', value: `${one('instance_id') ?? '?'}${one('device_name') ? ` as ${one('device_name')}` : ''}` }];
    case 'azurerm_virtual_machine_data_disk_attachment': return [{ k: 'attached', key: 'Attached to', value: `${one('virtual_machine_id') ?? '?'}${one('lun') ? ` (LUN ${one('lun')})` : ''}` }];
    case 'azurerm_storage_container': return [{ k: 'container', key: 'Container', value: `${one('name') ?? ''} (${one('container_access_type') ?? 'private'})` }];
    case 'azurerm_storage_share': return [{ k: 'share', key: 'File share', value: one('name') ?? '' }];
    default: return [];
  }
}

// ---- one-line summaries for the card ---------------------------------------------------------
const val = (rows, k) => rows.find((r) => r.k === k)?.value;
const SUMMARY = {
  aws_instance: (r) => val(r, 'instance_type'),
  aws_db_instance: (r) => [val(r, 'engine'), val(r, 'instance_class')].filter(Boolean).join(' '),
  aws_lambda_function: (r) => [val(r, 'runtime'), val(r, 'memory_size') && `${val(r, 'memory_size')} MB`].filter(Boolean).join(' · '),
  aws_eks_cluster: (r) => val(r, 'version') && `k8s ${val(r, 'version')}`,
  aws_ebs_volume: (r) => [val(r, 'size') && `${val(r, 'size')} GB`, val(r, 'type'), /true/.test(val(r, 'encrypted') ?? '') && 'encrypted'].filter(Boolean).join(' '),
  aws_lb: (r) => [val(r, 'load_balancer_type') ?? 'application', /true/.test(val(r, 'internal') ?? '') ? 'internal' : 'public', ...r.filter((x) => x.k === 'listener').map((x) => `:${/\d+/.exec(x.value)?.[0] ?? ''}`)].join(' '),
  aws_s3_bucket: (r) => [/enabled/i.test(val(r, 'versioning') ?? '') && 'versioned', val(r, 'encryption') && 'encrypted', val(r, 'public_access') === 'all blocked' && 'private'].filter(Boolean).join(' · '),
  azurerm_storage_account: (r) => [val(r, 'account_tier'), val(r, 'account_replication_type')].filter(Boolean).join(' '),
  azurerm_managed_disk: (r) => [val(r, 'disk_size_gb') && `${val(r, 'disk_size_gb')} GB`, val(r, 'storage_account_type')].filter(Boolean).join(' '),
  azurerm_linux_virtual_machine: (r) => val(r, 'size'),
  azurerm_windows_virtual_machine: (r) => val(r, 'size'),
  azurerm_kubernetes_cluster: (r) => val(r, 'kubernetes_version') && `k8s ${val(r, 'kubernetes_version')}`,
  azurerm_mssql_database: (r) => val(r, 'sku_name'),
  azurerm_service_plan: (r) => val(r, 'sku_name'),
  azurerm_redis_cache: (r) => [val(r, 'sku_name'), val(r, 'family') && val(r, 'capacity') && `${val(r, 'family')}${val(r, 'capacity')}`].filter(Boolean).join(' '),
  azurerm_lb: (r) => [val(r, 'sku') ?? 'Basic', ...(r.some((x) => x.k === 'lb_rule') ? [`${r.filter((x) => x.k === 'lb_rule').length} rules`] : [])].join(' · '),
};
export function settingsSummary(type, rows) {
  try { return (SUMMARY[type]?.(rows) ?? '').trim(); } catch { return ''; }
}

// ---- public API ------------------------------------------------------------------------------
export function inlineRows(type, body, scope, lookup) {
  const rows = [];
  if (/security_group$/.test(type)) {
    const azure = type.startsWith('azurerm_');
    const live = (blocks) => blocks.filter((b) => !(b.dynamic && emptyLoop(b.forEach, scope, lookup)));
    const loopNote = (b) => (b.dynamic ? { dynamic: true, note: `one per item of ${listOfLoop(b.forEach, scope, lookup)}` } : {});
    if (azure) for (const b of live(nestedBlocks(body, 'security_rule'))) rows.push({ ...azureRule(parseLocals(b.body), scope, lookup), ...loopNote(b) });
    else {
      for (const b of live(nestedBlocks(body, 'ingress'))) rows.push({ ...awsRule(parseLocals(b.body), 'in', scope, lookup), ...loopNote(b) });
      for (const b of live(nestedBlocks(body, 'egress'))) rows.push({ ...awsRule(parseLocals(b.body), 'out', scope, lookup), ...loopNote(b) });
    }
    return { kind: 'rules', rows };
  }
  for (const b of nestedBlocks(body, 'route')) {
    if (b.dynamic && emptyLoop(b.forEach, scope, lookup)) continue;
    rows.push({ ...routeRow(type, parseLocals(b.body), scope, lookup), dynamic: b.dynamic, ...(b.dynamic ? { note: `one per item of ${listOfLoop(b.forEach, scope, lookup)}` } : {}) });
  }
  return { kind: 'routes', rows };
}

export function attachedRows(type, body, scope, lookup) {
  const spec = ATTACH_TYPES[type];
  const attrs = parseLocals(body);
  if (spec.kind === 'settings') return { target: refId(attrs[spec.into], scope, lookup), kind: 'settings', rows: foldRows(type, body, attrs, scope, lookup) };
  const row = spec.kind === 'rules' ? ruleRows(type, body, scope, lookup, spec.dir)[0] : routeRow(type, attrs, scope, lookup);
  return { target: refId(attrs[spec.into], scope, lookup), kind: spec.kind, row };
}

const portList = (rows) => {
  const p = [...new Set(rows.map((r) => (r.action && !/^allow$/i.test(r.action) ? `✗${r.ports || 'all'}` : r.ports || 'all')))];
  return p.length > 3 ? `${p.slice(0, 3).join(', ')} +${p.length - 3}` : p.join(', ');
};

// One line for the card: "in 80, 443 · out all" / "2 routes" / "0.0.0.0/0 → Internet gateway igw".
export function summarize(details) {
  if (!details) return '';
  const { kind, rows } = details;
  if (kind === 'rules') {
    if (!rows.length) return 'no rules';
    if (rows.every((r) => r.dynamic && r.ports === 'varies')) return 'rules set by variable';
    const parts = [['in', rows.filter((r) => r.dir === 'in')], ['out', rows.filter((r) => r.dir === 'out')]].filter(([, r]) => r.length);
    return parts.map(([d, r]) => `${d} ${portList(r)}`).join(' · ');
  }
  if (!rows.length) return 'no routes';
  if (rows.every((r) => r.dynamic && r.dest === 'varies')) return 'routes set by variable';
  return rows.length === 1 ? `${rows[0].dest} → ${rows[0].target || '?'}` : `${rows.length} routes`;
}
