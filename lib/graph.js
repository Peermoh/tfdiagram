import { parseTerraform } from './parse.js';
import { allFiles } from './modules.js';

export const PROVIDERS = {
  aws: {
    label: 'AWS',
    prefix: 'aws_',
    categories: [
      ['Networking', /^aws_(vpc|subnet|internet_gateway|nat_gateway|eip|route|route_table|vpc_endpoint|lb|alb|elb|lb_listener|lb_target_group|api_gateway|apigatewayv2|cloudfront|route53|network_interface|vpn|ec2_transit)/],
      ['Compute', /^aws_(instance|launch_template|launch_configuration|autoscaling|ecs|eks|lambda|batch|ecr|sfn)/],
      ['Data', /^aws_(s3|db|rds|dynamodb|elasticache|efs|ebs|redshift|sqs|sns|kinesis|opensearch|elasticsearch|msk)/],
      ['Security & IAM', /^aws_(iam|security_group|kms|secretsmanager|acm|wafv2|cognito|ssm)/],
    ],
    // Plumbing resources that make diagrams unreadable; hidden in simplified view.
    noise: /^aws_(iam_role_policy|iam_role_policy_attachment|iam_policy_attachment|iam_policy|iam_policy_document|security_group_rule|route_table_association|main_route_table_association|lambda_permission|s3_bucket_policy|s3_bucket_public_access_block|s3_bucket_versioning|s3_bucket_server_side_encryption_configuration|cloudwatch_log_group|vpc_security_group_.*_rule)$/,
  },
  azure: {
    label: 'Azure',
    prefix: 'azurerm_',
    categories: [
      ['Networking', /^azurerm_(virtual_network|subnet|public_ip|network_interface|lb|application_gateway|route_table|nat_gateway|firewall|dns_|private_dns|private_endpoint|virtual_wan|express_route|frontdoor|cdn|traffic_manager|bastion)/],
      ['Compute', /^azurerm_(linux_virtual_machine|windows_virtual_machine|virtual_machine|orchestrated_virtual_machine|.*scale_set|kubernetes_cluster|container_group|container_app|app_service|linux_web_app|windows_web_app|linux_function_app|windows_function_app|function_app|service_plan|batch_)/],
      ['Data', /^azurerm_(storage|mssql|sql_|postgresql|mysql|mariadb|cosmosdb|redis|servicebus|eventhub|data_factory|synapse|managed_disk)/],
      ['Security & IAM', /^azurerm_(network_security_group|key_vault|role_assignment|role_definition|user_assigned_identity|application_security_group|policy|monitor_diagnostic)/],
    ],
    noise: /^azurerm_(subnet_network_security_group_association|subnet_route_table_association|network_interface_security_group_association|network_security_rule|role_assignment|key_vault_access_policy|key_vault_secret|monitor_diagnostic_setting|storage_container|resource_group)$/,
  },
};

export function detectProvider(files) {
  const text = files.map((f) => f.content).join('\n');
  const count = (re) => (text.match(re) ?? []).length;
  return count(/\bazurerm_[a-z0-9_]+/g) > count(/\baws_[a-z0-9_]+/g) ? 'azure' : 'aws';
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
  const bodies = new Map(); // id -> { body, prefix } (prefix = scope the body's references resolve in)
  const refRe = new RegExp(`\\b(data\\.)?(${cfg.prefix}[a-z0-9_]+)\\.([A-Za-z_][\\w-]*)|\\bmodule\\.([A-Za-z_][\\w-]*)`, 'g');

  function collect(tree, prefix, parent) {
    for (const f of tree.files) {
      for (const b of parseTerraform(f.content)) {
        if (b.kind === 'resource' && b.labels.length >= 2) {
          const [type, name] = b.labels;
          if (!type.startsWith(cfg.prefix)) continue;
          if (simplify && cfg.noise.test(type)) continue;
          const id = `${prefix}${type}.${name}`;
          nodes.set(id, { id, kind: 'resource', type, name, category: categoryOf(type, provider), file: f.path, parent });
          bodies.set(id, { body: b.body, prefix });
        } else if (b.kind === 'module' && b.labels.length >= 1) {
          const name = b.labels[0];
          const id = `${prefix}module.${name}`;
          const source = /source\s*=\s*"([^"]+)"/.exec(b.body)?.[1];
          const child = tree.children?.[name];
          nodes.set(id, { id, kind: 'module', type: 'module', name, source, category: 'Modules', file: f.path, parent, expanded: Boolean(child) });
          bodies.set(id, { body: b.body, prefix }); // arguments are evaluated in the calling scope
          if (child) collect(child, `${id}.`, id);
        } else if (b.kind === 'data' && b.labels.length >= 2 && !simplify && b.labels[0].startsWith(cfg.prefix)) {
          const id = `${prefix}data.${b.labels[0]}.${b.labels[1]}`;
          nodes.set(id, { id, kind: 'data', type: b.labels[0], name: b.labels[1], category: 'Data sources', file: f.path, parent });
          bodies.set(id, { body: b.body, prefix });
        }
      }
    }
  }
  collect(root, '', '');

  const edges = new Set();
  for (const [from, { body, prefix }] of bodies) {
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

export { toMermaid, filterGraph } from '../public/render.js';
