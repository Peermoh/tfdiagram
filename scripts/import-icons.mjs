#!/usr/bin/env node
// Imports the OFFICIAL AWS Architecture Icons and Azure icons (downloaded by you from the vendors) into
// public/icons, and writes public/icons/manifest.json so the diagram uses them.
//
//   node scripts/import-icons.mjs --aws <unzipped AWS asset package> --azure <unzipped Azure icons> [--out public/icons]
//
// Matching is by file name (e.g. Arch_Amazon-EC2_64.svg, 10021-icon-service-Virtual-Machine.svg). Anything that
// doesn't match keeps the built-in drawn icon; the report lists what was and wasn't matched.
import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// terraform types (with provider prefix) -> phrases found in the vendor file names (any phrase may match)
const AWS = [
  [['aws_vpc', 'aws_default_vpc'], ['virtual private cloud', 'vpc']],
  [['aws_internet_gateway', 'aws_egress_only_internet_gateway'], ['internet gateway']],
  [['aws_nat_gateway'], ['nat gateway']],
  [['aws_vpn_gateway'], ['vpn gateway']],
  [['aws_customer_gateway'], ['customer gateway']],
  // no generic "subnet" icon exists (only Public/Private subnet group frames), so subnets keep the built-in icon
  [['aws_route_table', 'aws_default_route_table', 'aws_route'], ['route table', 'router']],
  [['aws_eip'], ['elastic ip address', 'elastic ip']],
  [['aws_network_acl', 'aws_default_network_acl'], ['network access control list', 'network acl']],
  [['aws_vpc_endpoint'], ['endpoints', 'endpoint']],
  [['aws_security_group', 'aws_default_security_group'], ['security group']],
  [['aws_instance', 'aws_launch_template'], ['ec2']],
  [['aws_autoscaling_group'], ['ec2 auto scaling', 'auto scaling']],
  [['aws_lambda_function'], ['lambda']],
  [['aws_ecs_cluster', 'aws_ecs_service'], ['elastic container service', 'ecs']],
  [['aws_eks_cluster'], ['elastic kubernetes service', 'eks']],
  [['aws_ecr_repository'], ['elastic container registry', 'ecr']],
  [['aws_s3_bucket'], ['simple storage service', 's3']],
  [['aws_db_instance', 'aws_rds_cluster'], ['rds']],
  [['aws_dynamodb_table'], ['dynamodb']],
  [['aws_elasticache_cluster', 'aws_elasticache_replication_group'], ['elasticache']],
  [['aws_redshift_cluster'], ['redshift']],
  [['aws_opensearch_domain', 'aws_elasticsearch_domain'], ['opensearch service']],
  [['aws_efs_file_system'], ['efs']],
  [['aws_ebs_volume'], ['elastic block store', 'ebs']],
  [['aws_iam_role', 'aws_iam_policy', 'aws_iam_user'], ['identity and access management', 'iam']],
  [['aws_kms_key'], ['key management service', 'kms']],
  [['aws_secretsmanager_secret'], ['secrets manager']],
  [['aws_acm_certificate'], ['certificate manager']],
  [['aws_wafv2_web_acl'], ['waf']],
  [['aws_sqs_queue'], ['simple queue service', 'sqs']],
  [['aws_sns_topic'], ['simple notification service', 'sns']],
  [['aws_kinesis_stream'], ['kinesis data streams', 'kinesis']],
  [['aws_lb', 'aws_alb', 'aws_lb_listener', 'aws_lb_target_group'], ['elastic load balancing']],
  [['aws_cloudfront_distribution'], ['cloudfront']],
  [['aws_route53_zone', 'aws_route53_record'], ['route 53']],
  [['aws_api_gateway_rest_api', 'aws_apigatewayv2_api'], ['api gateway']],
  [['aws_cloudwatch_log_group', 'aws_flow_log'], ['cloudwatch']],
];

const AZURE = [
  [['azurerm_virtual_network'], ['virtual network']],
  [['azurerm_subnet'], ['subnet']],
  [['azurerm_network_security_group'], ['network security group']],
  [['azurerm_application_security_group'], ['application security group']],
  [['azurerm_public_ip'], ['public ip address']],
  [['azurerm_network_interface'], ['network interface']],
  [['azurerm_lb'], ['load balancer']],
  [['azurerm_application_gateway'], ['application gateway']],
  [['azurerm_firewall'], ['firewall']],
  [['azurerm_bastion_host'], ['bastion']],
  [['azurerm_route_table'], ['route table']],
  [['azurerm_nat_gateway'], ['nat']],
  [['azurerm_private_endpoint'], ['private endpoint']],
  [['azurerm_dns_zone', 'azurerm_private_dns_zone'], ['dns zone']],
  [['azurerm_virtual_network_gateway'], ['virtual network gateway']],
  [['azurerm_local_network_gateway'], ['local network gateway']],
  [['azurerm_linux_virtual_machine', 'azurerm_windows_virtual_machine', 'azurerm_virtual_machine'], ['virtual machine']],
  [['azurerm_linux_virtual_machine_scale_set', 'azurerm_windows_virtual_machine_scale_set'], ['vm scale set', 'virtual machine scale set']],
  [['azurerm_availability_set'], ['availability set']],
  [['azurerm_managed_disk'], ['disk']],
  [['azurerm_kubernetes_cluster'], ['kubernetes service']],
  [['azurerm_container_registry'], ['container registrie', 'container registry']],
  [['azurerm_container_app'], ['container app']],
  [['azurerm_container_group'], ['container instance']],
  [['azurerm_service_plan'], ['app service plan']],
  [['azurerm_linux_web_app', 'azurerm_windows_web_app'], ['app service']],
  [['azurerm_linux_function_app', 'azurerm_windows_function_app'], ['function app']],
  [['azurerm_mssql_server'], ['sql server']],
  [['azurerm_mssql_database'], ['sql database']],
  [['azurerm_storage_account'], ['storage account']],
  [['azurerm_key_vault'], ['key vault']],
  [['azurerm_cosmosdb_account'], ['cosmos db']],
  [['azurerm_redis_cache'], ['cache redis', 'redis']],
  [['azurerm_servicebus_namespace', 'azurerm_servicebus_queue', 'azurerm_servicebus_topic'], ['service bus']],
  [['azurerm_eventhub_namespace', 'azurerm_eventhub'], ['event hub']],
  [['azurerm_log_analytics_workspace'], ['log analytics workspace']],
  [['azurerm_application_insights'], ['application insights']],
  [['azurerm_api_management'], ['api management service']],
  [['azurerm_user_assigned_identity'], ['managed identitie', 'managed identity']],
  [['azurerm_resource_group'], ['resource group']],
  [['azurerm_traffic_manager_profile'], ['traffic manager profile']],
  [['azurerm_cdn_profile'], ['cdn profile']],
];

const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

// "Arch_Amazon-Simple-Storage-Service_64.svg" -> ['amazon','simple','storage','service']
export function tokens(file) {
  return basename(file).replace(/\.svg$/i, '')
    .replace(/^\d+-icon-service-/i, '').replace(/^(arch|res)[_-]/i, '')
    .replace(/_(\d+)$/, '')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
}

const sizeOf = (file) => Number(/_(\d+)\.svg$/i.exec(file)?.[1] ?? /[\\/](\d+)[\\/]/.exec(file)?.[1] ?? 0);

// Picks, for each terraform type, the best-named file. Returns { type: file }.
export function matchIcons(files, table) {
  const usable = files
    // skip macOS zip junk (__MACOSX/, ._files), category/group icons and dark-background variants
    .filter((f) => /\.svg$/i.test(f) && !/__MACOSX|[\\/]\._|category|dark|(^|[^a-z])bg-dark/i.test(f))
    .map((f) => ({ file: f, toks: tokens(f), size: sizeOf(f), res: /^res[_-]/i.test(basename(f)) }));
  const out = {};
  for (const [types, phrases] of table) {
    let best = null;
    for (const c of usable) {
      for (const phrase of phrases) {
        const p = phrase.split(' ').map(stem);
        if (!p.every((w) => c.toks.includes(w))) continue;
        // more matching words is better, extra words in the file name are a small penalty,
        // service icons (Arch_) beat resource icons, bigger beats smaller
        const score = p.length * 10 - (c.toks.length - p.length) + (c.res ? 0 : 0.5) + c.size / 1000;
        if (!best || score > best.score) best = { file: c.file, score };
      }
    }
    if (best) for (const t of types) out[t] = best.file;
  }
  return out;
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const safeSvg = (text) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text) && text.length < 200_000;

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const out = resolve(arg('--out') ?? join(dirname(fileURLToPath(import.meta.url)), '../public/icons'));
  const jobs = [['aws', arg('--aws'), AWS], ['azure', arg('--azure'), AZURE]].filter(([, dir]) => dir);
  if (!jobs.length) {
    console.error('Usage: node scripts/import-icons.mjs --aws <dir> --azure <dir> [--out public/icons]');
    process.exit(1);
  }
  const manifest = {};
  for (const [provider, dir, table] of jobs) {
    if (!existsSync(dir)) { console.error(`Not found: ${dir}`); process.exit(1); }
    rmSync(join(out, provider), { recursive: true, force: true });
    mkdirSync(join(out, provider), { recursive: true });
    const matches = matchIcons(walk(dir), table);
    let ok = 0;
    for (const [type, file] of Object.entries(matches)) {
      if (!safeSvg(readFileSync(file, 'utf8'))) { console.warn(`skipped (not a plain SVG): ${file}`); continue; }
      copyFileSync(file, join(out, provider, `${type}.svg`));
      manifest[type] = `${provider}/${type}.svg`;
      ok++;
    }
    const all = table.flatMap(([types]) => types);
    console.log(`${provider}: ${ok}/${all.length} resource types matched`);
    const missing = all.filter((t) => !matches[t]);
    if (missing.length) console.log(`  no icon found for: ${missing.join(', ')} (these keep the built-in icon)`);
  }
  // keep entries for providers that were not re-imported this time
  const manifestPath = join(out, 'manifest.json');
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const keep = Object.fromEntries(Object.entries(previous).filter(([t]) => !jobs.some(([p]) => t.startsWith(p === 'aws' ? 'aws_' : 'azurerm_'))));
  writeFileSync(manifestPath, JSON.stringify({ ...keep, ...manifest }, null, 1) + '\n');
  console.log(`wrote ${manifestPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
