import { parseTerraform, parseLocals } from './parse.js';
import { allFiles } from './modules.js';
import { resolveCidrs } from './cidr.js';

export const PROVIDERS = {
  aws: {
    label: 'AWS',
    prefix: 'aws_',
    categories: [
      ['Networking', /^aws_((db|redshift|elasticache|dax|neptune|docdb|memorydb)_subnet_group|network_acl|default_(vpc|subnet|route_table|network_acl)|customer_gateway|egress_only_internet_gateway|flow_log|vpc|subnet|internet_gateway|nat_gateway|eip|route|route_table|vpc_endpoint|lb|alb|elb|lb_listener|lb_target_group|api_gateway|apigatewayv2|cloudfront|route53|network_interface|vpn|ec2_transit)/],
      ['Compute', /^aws_(instance|launch_template|launch_configuration|autoscaling|ecs|eks|lambda|batch|ecr|sfn)/],
      ['Data', /^aws_(s3|db|rds|dynamodb|elasticache|efs|ebs|redshift|sqs|sns|kinesis|opensearch|elasticsearch|msk)/],
      ['Security & IAM', /^aws_(iam|default_security_group|security_group|kms|secretsmanager|acm|wafv2|cognito|ssm)/],
    ],
    // Plumbing resources that make diagrams unreadable; hidden in simplified view.
    noise: /^aws_(network_acl_rule|vpn_gateway_route_propagation|vpn_gateway_attachment|vpc_dhcp_options_association|vpc_ipv4_cidr_block_association|iam_role_policy|iam_role_policy_attachment|iam_policy_attachment|iam_policy|iam_policy_document|security_group_rule|route_table_association|main_route_table_association|lambda_permission|s3_bucket_policy|s3_bucket_public_access_block|s3_bucket_versioning|s3_bucket_server_side_encryption_configuration|cloudwatch_log_group|vpc_security_group_.*_rule)$/,
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
    noise: /^azurerm_(.*_association|network_security_rule|role_assignment|role_definition|key_vault_access_policy|key_vault_secret|key_vault_key|monitor_diagnostic_setting|storage_container|storage_blob|virtual_machine_extension|resource_group)$/,
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
export function buildGraph(input, { simplify = true, provider = 'auto' } = {}) {
  const root = Array.isArray(input) ? { files: input, children: {} } : input;
  if (provider === 'auto') provider = detectProvider(allFiles(root));
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider "${provider}"`);

  const nodes = new Map(); // id -> node
  const locals = new Map(); // scope prefix -> { name: expression text }
  const vars = new Map(); // scope prefix -> { name: { expr, scope } }: variable defaults, overridden by the module call's arguments
  const bodies = new Map(); // id -> { body, prefix } (prefix = scope the body's references resolve in)
  const refRe = new RegExp(`\\b(data\\.)?(${cfg.prefix}[a-z0-9_]+)\\.([A-Za-z_][\\w-]*)|\\bmodule\\.([A-Za-z_][\\w-]*)`, 'g');

  function collect(tree, prefix, parent, args = null, argScope = '') {
    for (const f of tree.files) {
      for (const b of parseTerraform(f.content)) {
        if (b.kind === 'resource' && b.labels.length >= 2) {
          const [type, name] = b.labels;
          if (!type.startsWith(cfg.prefix)) continue;
          if (simplify && cfg.noise.test(type)) continue;
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
  collect(root, '', '');
  const lookup = (kind, name, scope) => (kind === 'var' ? vars.get(scope)?.[name] : locals.get(scope)?.[name] && { expr: locals.get(scope)[name], scope });
  for (const [id, n] of nodes) {
    if (n.kind !== 'resource') continue;
    const { body, prefix } = bodies.get(id);
    const attrs = parseLocals(body);
    const found = CIDR_KEYS.flatMap((k) => (attrs[k] ? resolveCidrs(attrs[k], prefix, lookup) : []));
    if (found.length) n.cidrs = [...new Set(found)];
  }

  const edges = new Set();
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
  for (const [from, { body: rawBody, prefix }] of bodies) {
    const body = expand(rawBody, prefix);
    let m;
    refRe.lastIndex = 0;
    while ((m = refRe.exec(body))) {
      const to = m[4] ? `${prefix}module.${m[4]}` : `${prefix}${m[1] ?? ''}${m[2]}.${m[3]}`;
      if (to !== from && nodes.has(to)) edges.add(`${from}\t${to}`);
    }
  }
  return {
    provider,
    nodes: [...nodes.values()],
    edges: [...edges].map((e) => { const [from, to] = e.split('\t'); return { from, to }; }),
  };
}

export { toMermaid, filterGraph, summarize } from '../public/render.js';
