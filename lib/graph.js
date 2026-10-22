import { parseTerraform, parseLocals } from './parse.js';
import { allFiles } from './modules.js';
import { resolveCidrs } from './cidr.js';
import { ATTACH_TYPES, countOf, forEachSize, refIds, DETAIL_TYPES, attachedRows, inlineRows, settingsRows, settingsSummary, summarize as summarizeDetails } from './details.js';

export const PROVIDERS = {
  aws: {
    label: 'AWS',
    prefix: 'aws_',
    categories: [
      ['Networking', /^aws_((db|redshift|elasticache|dax|neptune|docdb|memorydb)_subnet_group|network_acl|default_(vpc|subnet|route_table|network_acl)|customer_gateway|egress_only_internet_gateway|flow_log|vpc|subnet|internet_gateway|nat_gateway|eip|route|route_table|vpc_endpoint|lb|alb|elb|lb_listener|lb_target_group|api_gateway|apigatewayv2|cloudfront|route53|network_interface|vpn|ec2_transit)/],
      ['Compute', /^aws_(instance|launch_template|launch_configuration|autoscaling|ecs|eks|lambda|batch|ecr|sfn)/],
      ['Data', /^aws_(backup|s3|db|rds|dynamodb|elasticache|efs|ebs|redshift|sqs|sns|kinesis|opensearch|elasticsearch|msk)/],
      ['Security & IAM', /^aws_(iam|default_security_group|security_group|kms|secretsmanager|acm|wafv2|cognito|ssm)/],
    ],
    // Plumbing resources that make diagrams unreadable; hidden in simplified view.
    noise: /^aws_(s3_bucket_[a-z_]+|volume_attachment|lb_target_group_attachment|lb_listener_rule|network_acl_rule|vpn_gateway_route_propagation|vpn_gateway_attachment|vpc_dhcp_options_association|vpc_ipv4_cidr_block_association|iam_role_policy|iam_role_policy_attachment|iam_policy_attachment|iam_policy|iam_policy_document|security_group_rule|route_table_association|main_route_table_association|lambda_permission|s3_bucket_policy|s3_bucket_public_access_block|s3_bucket_versioning|s3_bucket_server_side_encryption_configuration|cloudwatch_log_group|vpc_security_group_.*_rule)$/,
  },
  azure: {
    label: 'Azure',
    prefix: 'azurerm_',
    categories: [
      ['Networking', /^azurerm_(virtual_network|subnet|public_ip|network_interface|lb|application_gateway|route|nat_gateway|firewall|ip_group|dns_|private_dns|private_endpoint|private_link|virtual_wan|virtual_hub|express_route|frontdoor|cdn|traffic_manager|bastion|local_network_gateway|network_watcher|network_ddos|api_management|vpn)/],
      ['Compute', /^azurerm_(linux_virtual_machine|windows_virtual_machine|virtual_machine|orchestrated_virtual_machine|availability_set|image|.*scale_set|kubernetes_cluster|container_group|container_app|container_registry|app_service|linux_web_app|windows_web_app|static_web_app|linux_function_app|windows_function_app|function_app|logic_app|service_plan|batch_)/],
      ['Data', /^azurerm_(storage|mssql|sql_|postgresql|mysql|mariadb|cosmosdb|redis|servicebus|eventhub|eventgrid|search_service|kusto|data_factory|synapse|managed_disk|backup)/],
      ['Security & IAM', /^azurerm_(network_security_group|application_security_group|key_vault|role_|user_assigned_identity|policy|monitor_diagnostic|security_center|sentinel|disk_encryption_set)/],
    ],
    noise: /^azurerm_(.*_association|virtual_machine_data_disk_attachment|storage_share|lb_rule|lb_probe|lb_backend_address_pool|lb_nat_rule|network_security_rule|role_assignment|role_definition|key_vault_access_policy|key_vault_secret|key_vault_key|monitor_diagnostic_setting|storage_container|storage_blob|virtual_machine_extension|resource_group)$/,
  },
};

export function detectProvider(files) {
  const text = files.map((f) => f.content).join('\n');
  const count = (re) => (text.match(re) ?? []).length;
  return count(/\bazurerm_[a-z0-9_]+/g) > count(/\baws_[a-z0-9_]+/g) ? 'azure' : 'aws';
}

// Attributes that hold an IP range, across AWS and Azure.
const CIDR_KEYS = ['cidr_block', 'destination_cidr_block', 'address_space', 'address_prefixes', 'address_prefix', 'ipv4_cidr_block'];

const GENERIC = /^(this|main|default|current|selected|it|one|example)$/i;

const clean = (raw) => {
  const text = raw.replace(/\$\{\s*(?:var|local)\.([\w-]+)[^}]*\}/g, '{$1}').replace(/\$\{[^}]*\}/g, '…').trim();
  return text && !/^[{}…\s-]*$/.test(text) ? text : null;
};

// A literal Name tag (AWS), with ${var.x} shown as {x}: `"${var.name}-public"` -> `{name}-public`.
function nameTag(body) {
  const raw = /\bName["']?\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
  return raw ? clean(raw) : null;
}

// The resource's own top-level `name = "..."` (Azure resources are named this way).
function nameAttr(body) {
  const raw = /^(?: {0,2}|\t)name\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(body)?.[1];
  return raw ? clean(raw) : null;
}

// What identifies a resource on the card: its Terraform name, or - for generic names like "this" -
// its Name tag / `name` attribute, or failing that where it is defined (main.tf:42).
export function labelFor(name, body, file, line) {
  if (!GENERIC.test(name)) return name;
  return nameTag(body) ?? nameAttr(body) ?? `${file.split('/').pop()}:${line}`;
}

export function categoryOf(type, provider = 'aws') {
  for (const [name, re] of PROVIDERS[provider].categories) if (re.test(type)) return name;
  return 'Other';
}

// `input` is a module tree ({ files, children }) or a plain array of { path, content } files.
// Expanded local modules become container nodes whose resources have ids like `module.net.aws_vpc.this`.
export function buildGraph(input, { simplify = true, provider = 'auto', showInactive = false, tfvars = '' } = {}) {
  const root = Array.isArray(input) ? { files: input, children: {} } : input;
  if (provider === 'auto') provider = detectProvider(allFiles(root));
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider "${provider}"`);

  const nodes = new Map(); // id -> node
  const locals = new Map(); // scope prefix -> { name: expression text }
  const plumbing = []; // hidden helper resources (associations, attachments): their links become arrows
  const attachments = []; // rule / route resources to fold into their security group or route table
  const outputs = new Map(); // module scope prefix -> { name: expression text }
  const vars = new Map(); // scope prefix -> { name: { expr, scope } }: variable defaults, overridden by the module call's arguments
  const bodies = new Map(); // id -> { body, prefix } (prefix = scope the body's references resolve in)
  const refRe = new RegExp(`\\b(data\\.)?(${cfg.prefix}[a-z0-9_]+)\\.([A-Za-z_][\\w-]*)|\\bmodule\\.([A-Za-z_][\\w-]*)(?:\\.([A-Za-z_][\\w-]*))?`, 'g');

  function collect(tree, prefix, parent, args = null, argScope = '') {
    for (const f of tree.files) {
      for (const b of parseTerraform(f.content)) {
        if (b.kind === 'resource' && b.labels.length >= 2) {
          const [type, name] = b.labels;
          if (!type.startsWith(cfg.prefix)) continue;
          if (ATTACH_TYPES[type]) attachments.push({ type, body: b.body, prefix });   // shown in the target's details even when hidden
          if (simplify && cfg.noise.test(type)) { plumbing.push({ body: b.body, prefix }); continue; }
          const id = `${prefix}${type}.${name}`;
          nodes.set(id, { id, kind: 'resource', type, name, label: labelFor(name, b.body, f.path, b.line), line: b.line, category: categoryOf(type, provider), file: f.path, parent });
          bodies.set(id, { body: b.body, prefix });
        } else if (b.kind === 'module' && b.labels.length >= 1) {
          const name = b.labels[0];
          const id = `${prefix}module.${name}`;
          const source = /source\s*=\s*"([^"]+)"/.exec(b.body)?.[1];
          const child = tree.children?.[name];
          nodes.set(id, { id, kind: 'module', type: 'module', name, source, category: 'Modules', file: f.path, parent, expanded: Boolean(child) });
          bodies.set(id, { body: b.body, prefix }); // arguments are evaluated in the calling scope
          if (child) collect(child, `${id}.`, id, parseLocals(b.body), prefix);
        } else if (b.kind === 'output' && b.labels[0]) {
          const value = parseLocals(b.body).value;
          if (value !== undefined) outputs.set(prefix, { ...outputs.get(prefix), [b.labels[0]]: value });
        } else if (b.kind === 'variable' && b.labels[0]) {
          const def = parseLocals(b.body).default;
          if (def !== undefined) vars.set(prefix, { ...vars.get(prefix), [b.labels[0]]: { expr: def, scope: prefix } });
        } else if (b.kind === 'locals') {
          locals.set(prefix, { ...locals.get(prefix), ...parseLocals(b.body) });
        } else if (b.kind === 'data' && b.labels.length >= 2 && !simplify && b.labels[0].startsWith(cfg.prefix)) {
          const id = `${prefix}data.${b.labels[0]}.${b.labels[1]}`;
          nodes.set(id, { id, kind: 'data', type: b.labels[0], name: b.labels[1], category: 'Data sources', file: f.path, parent });
          bodies.set(id, { body: b.body, prefix });
        }
      }
    }
    // a module call's arguments override the child's variable defaults (their text belongs to the caller's scope)
    if (args) for (const [name, expr] of Object.entries(args)) vars.set(prefix, { ...vars.get(prefix), [name]: { expr, scope: argScope } });
  }
  collect(root, '', '', tfvars.trim() ? parseLocals(tfvars) : undefined, '');
  const lookup = (kind, name, scope) => (kind === 'var' ? vars.get(scope)?.[name] : locals.get(scope)?.[name] && { expr: locals.get(scope)[name], scope });
  // `count = 0` (after following variables and conditions) means a resource is not created with the values we can see.
  const off = (body, scope) => { const a = parseLocals(body); return (a.count !== undefined && countOf(a.count, scope, lookup) === 0) || (a.for_each !== undefined && forEachSize(a.for_each, scope, lookup) === 0); };
  const inactive = [];
  const uncertain = []; // count / for_each that could not be worked out: drawn as if created
  for (const [id, n] of [...nodes]) {
    if (n.kind !== 'resource') continue;
    const { body, prefix } = bodies.get(id);
    const attrs0 = parseLocals(body);
    const k = attrs0.count !== undefined ? countOf(attrs0.count, prefix, lookup) : attrs0.for_each !== undefined ? forEachSize(attrs0.for_each, prefix, lookup) : undefined;
    if (k === undefined) continue;
    if (k === null) { uncertain.push(id); continue; }
    if (k === 0) { inactive.push(id); if (showInactive) n.inactive = true; else nodes.delete(id); }
    else if (k > 1) n.instances = k;
  }
  // a module whose resources are all switched off is just a plain module card
  for (let changed = true; changed;) {
    changed = false;
    for (const n of nodes.values()) {
      if (n.kind === 'module' && n.expanded && ![...nodes.values()].some((c) => c.parent === n.id)) { n.expanded = false; n.summary = 'nothing created here'; changed = true; }
    }
  }

  for (const [id, n] of nodes) {
    if (n.kind !== 'resource') continue;
    const { body, prefix } = bodies.get(id);
    const attrs = parseLocals(body);
    const found = CIDR_KEYS.flatMap((k) => (attrs[k] ? resolveCidrs(attrs[k], prefix, lookup) : []));
    if (found.length) n.cidrs = [...new Set(found)];
    if (DETAIL_TYPES.has(n.type)) n.details = inlineRows(n.type, body, prefix, lookup);
    else {
      const rows = settingsRows(n.type, body, prefix, lookup, (id) => nodes.has(id));
      if (rows.length) n.details = { kind: 'settings', rows };
    }
  }
  for (const a of attachments) {
    if (off(a.body, a.prefix)) continue;
    const { target, kind, rows } = attachedRows(a.type, a.body, a.prefix, lookup);
    const t = target && nodes.get(target.id);
    if (!t) continue;
    if (kind === 'settings') {
      if (DETAIL_TYPES.has(t.type)) continue;
      t.details ??= { kind: 'settings', rows: [] };
      if (t.details.kind === 'settings') t.details.rows.push(...rows);
      continue;
    }
    if (!DETAIL_TYPES.has(t.type)) continue;
    t.details ??= { kind, rows: [] };
    if (t.details.kind === kind) t.details.rows.push(...rows);
  }
  for (const n of nodes.values()) {
    if (n.details?.kind === 'settings') n.summary = settingsSummary(n.type, n.details.rows);
    else if (n.details) n.summary = summarizeDetails(n.details);
    if (n.inactive) n.summary = 'not created (count = 0)';
    if (!n.summary) delete n.summary;
  }

  const edges = new Set();
  const weak = new Set(); // links that only exist through a hidden association/attachment
  // A hidden association/attachment links the two things it names: route_table_association links a subnet and a
  // route table, vpc_dhcp_options_association a VPC and its DHCP options. Draw that link between the visible ones.
  const PROVIDER_KEY = /route_table|dhcp_options|security_group|network_security_group|policy|options|prefix_list|nat_gateway|gateway_id/;
  for (const { body, prefix } of plumbing) {
    if (off(body, prefix)) continue;
    const ends = [];
    for (const [key, expr] of Object.entries(parseLocals(body))) {
      const r = refIds(expr, prefix, lookup).find((x) => nodes.has(x.id)); // first visible resource it names
      if (r && !ends.some((e) => e.id === r.id)) ends.push({ id: r.id, provider: PROVIDER_KEY.test(key) });
    }
    if (ends.length < 2) continue;
    // arrows run provider -> consumer; stored as consumer -> provider. Without a hint, the first one named is the consumer.
    const providers = ends.filter((e) => e.provider);
    const consumers = ends.filter((e) => !e.provider);
    const [cs, ps] = providers.length && consumers.length ? [consumers, providers] : [[ends[0]], ends.slice(1)];
    for (const c of cs) for (const p of ps) if (c.id !== p.id) { edges.add(`${c.id}\t${p.id}`); weak.add(`${c.id}\t${p.id}`); }
  }
  const direct = new Set(); // links made by a resource referring to another directly (as opposed to through a hidden helper)
  // `local.x` stands for whatever x's expression references, so follow it (a few levels deep).
  const expand = (text, prefix, depth = 0, seen = new Set()) => {
    let out = text;
    if (depth > 4) return out;
    for (const [, name] of text.matchAll(/\blocal\.([A-Za-z_][\w-]*)/g)) {
      const expr = locals.get(prefix)?.[name];
      if (expr && !seen.has(name)) { seen.add(name); out += '\n' + expand(expr, prefix, depth + 1, seen); }
    }
    return out;
  };
  // ---- links across module boundaries ------------------------------------------------------------
  // module.s3.bucket_name is whatever resource the output `bucket_name` exposes inside module s3 (aws_s3_bucket.b),
  // and an argument like `s3_bucket_id = ...` flows to the resources inside the module that use var.s3_bucket_id.
  // Where that can't be followed, the link stays between the module boxes.
  const nodeRef = (m, prefix, depth) => {
    if (m[4]) {
      const modId = `${prefix}module.${m[4]}`;
      const mod = nodes.get(modId);
      if (!mod) return [];
      if (mod.expanded && m[5] && depth < 4) {
        const out = outputs.get(`${modId}.`)?.[m[5]];
        const inner = out === undefined ? [] : refsIn(expand(out, `${modId}.`), `${modId}.`, depth + 1);
        if (inner.length) return inner;
      }
      return [modId];
    }
    const id = `${prefix}${m[1] ?? ''}${m[2]}.${m[3]}`;
    return nodes.has(id) ? [id] : [];
  };
  const refsIn = (text, prefix, depth = 0) => {
    const found = new Set();
    for (const m of text.matchAll(refRe)) for (const id of nodeRef(m, prefix, depth)) found.add(id);
    return [...found];
  };
  // who uses var.X inside each module scope (for following arguments into the module)
  const usersOfVar = new Map();
  for (const [id, { body, prefix }] of bodies) {
    if (!nodes.has(id)) continue;
    for (const m of expand(body, prefix).matchAll(/\bvar\.([A-Za-z_][\w-]*)/g)) {
      const key = `${prefix}|${m[1]}`;
      if (!usersOfVar.has(key)) usersOfVar.set(key, new Set());
      usersOfVar.get(key).add(id);
    }
  }
  const link = (from, to) => { if (from !== to && nodes.has(from) && nodes.has(to)) { edges.add(`${from}\t${to}`); direct.add(`${from}\t${to}`); } };
  const ordering = new Set(); // links that only say "after": depends_on = [module.x]
  const NOT_AN_INPUT = new Set(['source', 'version', 'count', 'for_each', 'providers', 'depends_on', 'lifecycle']);

  for (const [from, { body: rawBody, prefix }] of bodies) {
    const node = nodes.get(from);
    if (!node) continue;
    if (node.kind === 'module' && node.expanded) {
      for (const [arg, expr] of Object.entries(parseLocals(rawBody))) {
        const providers = refsIn(expand(expr, prefix), prefix);
        const users = NOT_AN_INPUT.has(arg) ? [] : [...(usersOfVar.get(`${from}.|${arg}`) ?? [])];
        for (const p of providers) {
          if (arg === 'depends_on') { link(from, p); ordering.add(`${from}\t${p}`); continue; }
          if (users.length) users.forEach((u) => link(u, p));      // the resources that use the value, inside the module
          else link(from, p);                                      // not followed further: module box to the provider
        }
      }
      continue;
    }
    for (const p of refsIn(expand(rawBody, prefix), prefix)) link(from, p);
  }
  // a module-to-module arrow adds nothing when resources inside the two modules are already linked
  const resourceLinks = [...edges].map((e) => e.split('\t')).filter(([a, b]) => nodes.get(a)?.kind !== 'module' || !nodes.get(a).expanded || nodes.get(b)?.kind !== 'module' || !nodes.get(b).expanded);
  for (const key of [...edges]) {
    const [a, b] = key.split('\t');
    if (nodes.get(a)?.kind === 'module' && nodes.get(a).expanded && nodes.get(b)?.kind === 'module' && nodes.get(b).expanded
      && resourceLinks.some(([x, y]) => x.startsWith(`${a}.`) && y.startsWith(`${b}.`))) { edges.delete(key); ordering.delete(key); }
  }
  // variables that are used but have no value we can see (no default, not passed by a module call)
  const unresolved = new Set();
  for (const { body, prefix } of bodies.values()) for (const m of body.matchAll(/\bvar\.([A-Za-z_][\w-]*)/g)) if (!lookup('var', m[1], prefix)) unresolved.add(m[1]);
  return {
    provider,
    unresolvedVars: [...unresolved].sort(),
    inactive,
    uncertain,
    nodes: [...nodes.values()],
    edges: [...edges].map((e) => { const [from, to] = e.split('\t'); return weak.has(e) && !direct.has(e) ? { from, to, weak: true } : ordering.has(e) ? { from, to, ordering: true } : { from, to }; }),
  };
}

export { toMermaid, filterGraph, summarize } from '../public/render.js';
