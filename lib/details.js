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
    return c ? { body: c.body, dynamic: true } : null;
  });
  return out;
}

const short = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const strip = (s) => s.replace(/\$\{\s*(?:var|local)\.([\w-]+)[^}]*\}/g, '{$1}');

// An attribute's values as a list of readable strings, following var.*/local.* where possible.
function listOf(expr, scope, lookup) {
  if (expr === undefined) return [];
  const text = substitute(expr, scope, lookup);
  const quoted = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => strip(m[1]));
  if (quoted.length) return quoted;
  const bare = text.trim().replace(/^[([\s]+|[)\]\s]+$/g, '').trim();
  return bare ? [short(bare)] : [];
}

// "aws_internet_gateway.igw.id" -> "Internet gateway igw"
const REF = /\b(?:data\.)?((?:aws|azurerm)_[a-z0-9_]+)\.([A-Za-z_][\w-]*)/;
function refLabel(expr, scope, lookup) {
  const m = REF.exec(substitute(expr ?? '', scope, lookup));
  return m ? `${friendlyType(m[1])} ${m[2]}` : null;
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

// ---- security groups -------------------------------------------------------------------------
function awsRule(attrs, dir, scope, lookup, extra = {}) {
  const one = (k) => listOf(attrs[k], scope, lookup)[0];
  const proto = protoOf(one('protocol') ?? one('ip_protocol'));
  const peers = [
    ...listOf(attrs.cidr_blocks, scope, lookup), ...listOf(attrs.ipv6_cidr_blocks, scope, lookup),
    ...listOf(attrs.cidr_ipv4, scope, lookup), ...listOf(attrs.cidr_ipv6, scope, lookup),
    ...['security_groups', 'source_security_group_id', 'referenced_security_group_id'].flatMap((k) => (attrs[k] === undefined ? [] : [refLabel(attrs[k], scope, lookup) ?? listOf(attrs[k], scope, lookup).join(', ')])),
    ...(/true/.test(attrs.self ?? '') ? ['itself'] : []),
    ...(attrs.prefix_list_ids !== undefined || attrs.prefix_list_id !== undefined ? ['prefix list'] : []),
  ].filter(Boolean);
  return { dir, action: 'Allow', proto, ports: portsOf(one('from_port'), one('to_port'), proto), peers, note: one('description') ?? '', ...extra };
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
    return { dest: listOf(attrs.address_prefix, scope, lookup).join(', ') || '?', target: ip ? `${hop} ${ip}` : hop, note: listOf(attrs.name, scope, lookup)[0] ?? '' };
  }
  const key = AWS_TARGETS.find((k) => attrs[k] !== undefined);
  const dest = [attrs.destination_cidr_block, attrs.destination_ipv6_cidr_block, attrs.cidr_block, attrs.ipv6_cidr_block, attrs.destination_prefix_list_id]
    .filter((x) => x !== undefined).flatMap((x) => listOf(x, scope, lookup));
  return {
    dest: dest.join(', ') || '?',
    target: key ? (refLabel(attrs[key], scope, lookup) ?? listOf(attrs[key], scope, lookup).join(', ')) : '',
    note: '',
  };
}

// ---- public API ------------------------------------------------------------------------------
export function inlineRows(type, body, scope, lookup) {
  const rows = [];
  if (/security_group$/.test(type)) {
    const azure = type.startsWith('azurerm_');
    if (azure) for (const b of nestedBlocks(body, 'security_rule')) rows.push({ ...azureRule(parseLocals(b.body), scope, lookup), dynamic: b.dynamic });
    else {
      for (const b of nestedBlocks(body, 'ingress')) rows.push({ ...awsRule(parseLocals(b.body), 'in', scope, lookup), dynamic: b.dynamic });
      for (const b of nestedBlocks(body, 'egress')) rows.push({ ...awsRule(parseLocals(b.body), 'out', scope, lookup), dynamic: b.dynamic });
    }
    return { kind: 'rules', rows };
  }
  for (const b of nestedBlocks(body, 'route')) rows.push({ ...routeRow(type, parseLocals(b.body), scope, lookup), dynamic: b.dynamic });
  return { kind: 'routes', rows };
}

export function attachedRows(type, body, scope, lookup) {
  const spec = ATTACH_TYPES[type];
  const attrs = parseLocals(body);
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
    const parts = [['in', rows.filter((r) => r.dir === 'in')], ['out', rows.filter((r) => r.dir === 'out')]].filter(([, r]) => r.length);
    return parts.map(([d, r]) => `${d} ${portList(r)}`).join(' · ');
  }
  if (!rows.length) return 'no routes';
  return rows.length === 1 ? `${rows[0].dest} → ${rows[0].target || '?'}` : `${rows.length} routes`;
}
