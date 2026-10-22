import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph, toMermaid } from '../lib/graph.js';
import { parseRepoUrl } from '../lib/github.js';

const files = [{ path: 'main.tf', content: readFileSync(new URL('../sample/main.tf', import.meta.url), 'utf8') }];
const has = (g, from, to) => g.edges.some((e) => e.from === from && e.to === to);

test('finds resources and modules, hides plumbing when simplified', () => {
  const g = buildGraph(files);
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes('aws_vpc.main') && ids.includes('module.db'));
  assert.ok(!ids.includes('aws_iam_role_policy_attachment.fn'));
  assert.ok(buildGraph(files, { simplify: false }).nodes.some((n) => n.id === 'aws_iam_role_policy_attachment.fn'));
});

test('extracts dependencies, ignoring comments and nested blocks', () => {
  const g = buildGraph(files);
  assert.ok(has(g, 'aws_subnet.public', 'aws_vpc.main'));
  assert.ok(has(g, 'aws_instance.web', 'aws_security_group.web'));
  assert.ok(has(g, 'aws_lambda_function.api', 'aws_s3_bucket.assets'));
  assert.ok(has(g, 'module.db', 'aws_security_group.web'));
  assert.ok(!g.edges.some((e) => e.to === 'aws_s3_bucket.nope'));
});

test('renders mermaid with groups and edges', () => {
  const m = toMermaid(buildGraph(files));
  assert.match(m, /^flowchart LR/);
  assert.match(m, /subgraph .*Networking/);
  assert.match(m, /n_aws_subnet_public --> n_aws_vpc_main/);
});

test('parses repo urls', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/a/b'), { owner: 'a', repo: 'b', ref: undefined, path: '' });
  assert.deepEqual(parseRepoUrl('github.com/a/b/tree/main/infra/prod'), { owner: 'a', repo: 'b', ref: 'main', path: 'infra/prod' });
  assert.throws(() => parseRepoUrl('https://example.com/a/b'));
});

test('azure: detects provider, groups, hides associations', () => {
  const az = [{ path: 'a.tf', content: readFileSync(new URL('../sample/azure.tf', import.meta.url), 'utf8') }];
  const g = buildGraph(az);
  assert.equal(g.provider, 'azure');
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes('azurerm_linux_virtual_machine.main'));
  assert.ok(!ids.includes('azurerm_subnet_network_security_group_association.a'));
  assert.ok(!ids.includes('azurerm_resource_group.main'));
  assert.ok(g.edges.some((e) => e.from === 'azurerm_linux_virtual_machine.main' && e.to === 'azurerm_network_interface.nic'));
  assert.ok(g.edges.some((e) => e.from === 'azurerm_network_interface.nic' && e.to === 'azurerm_subnet.app'));
  assert.equal(g.nodes.find((n) => n.id === 'azurerm_key_vault.main').category, 'Security & IAM');
  assert.equal(g.nodes.find((n) => n.id === 'azurerm_linux_web_app.api').category, 'Compute');
  assert.equal(g.nodes.find((n) => n.id === 'azurerm_mssql_database.app').category, 'Data');
  assert.match(toMermaid(g), /virtual_machine<br\/><b>vm-web/);
});

test('explicit provider ignores the other cloud', () => {
  assert.ok(buildGraph(files, { provider: 'azure' }).nodes.every((n) => n.kind === 'module'));
});

test('local module expansion', async () => {
  const { loadTree, resolveDir } = await import('../lib/modules.js');
  const dirs = {
    'examples/simple': [{ path: 'examples/simple/main.tf', content: `
      resource "aws_s3_bucket" "b" {}
      module "vpc" { source = "../../"
        bucket = aws_s3_bucket.b.id }
      module "disabled" { source = "../../" }
      module "reg" { source = "terraform-aws-modules/rds/aws" }
      resource "aws_instance" "web" { subnet_id = module.vpc.subnet_id }` }],
    '': [{ path: 'main.tf', content: `
      resource "aws_vpc" "this" {}
      resource "aws_subnet" "s" { vpc_id = aws_vpc.this.id }
      module "self" { source = "./" }` }],
  };
  const tree = await loadTree('examples/simple', async (d) => dirs[d] ?? []);
  const g = buildGraph(tree);
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes('module.vpc.aws_vpc.this') && ids.includes('module.disabled.aws_vpc.this'));
  assert.ok(has(g, 'module.vpc.aws_subnet.s', 'module.vpc.aws_vpc.this'));
  assert.ok(!has(g, 'module.vpc.aws_subnet.s', 'module.disabled.aws_vpc.this'));
  assert.ok(has(g, 'module.vpc', 'aws_s3_bucket.b'), 'module arguments reference parent resources');
  assert.ok(has(g, 'aws_instance.web', 'module.vpc'), 'parent references module outputs');
  assert.equal(g.nodes.find((n) => n.id === 'module.reg').expanded, false);
  assert.ok(!ids.some((i) => i.startsWith('module.vpc.module.self.module.self')), 'cycles stop');
  assert.match(toMermaid(g), /subgraph n_module_vpc\[/);
  assert.equal(resolveDir('examples/simple', '../../'), '');
  assert.equal(resolveDir('a', '../../x'), null);
});

test('filterGraph: layers, neighbors, query, scope, collapse', async () => {
  const { loadTree } = await import('../lib/modules.js');
  const { filterGraph } = await import('../public/render.js');
  const tree = await loadTree('', async (d) => d === '' ? [{ path: 'm.tf', content: `
    module "net" { source = "./net" }
    resource "aws_instance" "web" { subnet_id = module.net.s }
    resource "aws_s3_bucket" "b" {}` }] : [{ path: 'net/n.tf', content: `
    resource "aws_vpc" "v" {}
    resource "aws_subnet" "s" { vpc_id = aws_vpc.v.id }` }]);
  const g = buildGraph(tree);

  const nets = filterGraph(g, { layers: new Set(['Networking']) });
  assert.deepEqual(nets.nodes.map((n) => n.id).sort(), ['module.net', 'module.net.aws_subnet.s', 'module.net.aws_vpc.v']);
  assert.ok(!nets.nodes.some((n) => n.ghost));

  const compute = filterGraph(g, { layers: new Set(['Compute']), neighbors: true });
  assert.ok(compute.nodes.find((n) => n.id === 'aws_instance.web') && !compute.nodes.find((n) => n.id === 'aws_instance.web').ghost);
  assert.ok(compute.nodes.find((n) => n.id === 'module.net'));  // collapsed-or-container neighbour of the instance
  assert.ok(!compute.nodes.some((n) => n.id === 'aws_s3_bucket.b'));

  const q = filterGraph(g, { query: 'subnet', neighbors: true });
  assert.ok(q.nodes.find((n) => n.id === 'module.net.aws_vpc.v').ghost);
  assert.ok(toMermaid(q).includes('classDef ghost'));

  const scoped = filterGraph(g, { scope: 'module.net' });
  assert.ok(scoped.nodes.every((n) => n.parent === '') && scoped.nodes.length === 2);

  const col = filterGraph(g, { collapse: true });
  assert.deepEqual(col.nodes.map((n) => n.id).sort(), ['aws_instance.web', 'aws_s3_bucket.b', 'module.net']);
  assert.ok(col.edges.some((e) => e.from === 'aws_instance.web' && e.to === 'module.net'));
  assert.equal(col.nodes.find((n) => n.id === 'module.net').expanded, false);
});

test('aws categories: subnet groups, ACLs and defaults are not "Other"', async () => {
  const { categoryOf } = await import('../lib/graph.js');
  for (const t of ['aws_db_subnet_group', 'aws_network_acl', 'aws_default_route_table', 'aws_customer_gateway', 'aws_flow_log']) assert.equal(categoryOf(t), 'Networking', t);
  assert.equal(categoryOf('aws_default_security_group'), 'Security & IAM');
  assert.equal(categoryOf('aws_db_instance'), 'Data');
  const g = buildGraph([{ path: 'a.tf', content: 'resource "aws_network_acl" "n" {}\nresource "aws_network_acl_rule" "r" { network_acl_id = aws_network_acl.n.id }' }]);
  assert.deepEqual(g.nodes.map((n) => n.id), ['aws_network_acl.n']);
});

test('azure categories', async () => {
  const { categoryOf } = await import('../lib/graph.js');
  const want = { azurerm_route_table: 'Networking', azurerm_virtual_network_gateway: 'Networking', azurerm_api_management: 'Networking', azurerm_container_registry: 'Compute', azurerm_availability_set: 'Compute', azurerm_eventgrid_topic: 'Data', azurerm_user_assigned_identity: 'Security & IAM', azurerm_role_definition: 'Security & IAM' };
  for (const [t, c] of Object.entries(want)) assert.equal(categoryOf(t, 'azure'), c, t);
  const g = buildGraph([{ path: 'a.tf', content: 'resource "azurerm_subnet" "s" {}\nresource "azurerm_subnet_route_table_association" "a" { subnet_id = azurerm_subnet.s.id }' }], { provider: 'azure' });
  assert.deepEqual(g.nodes.map((n) => n.id), ['azurerm_subnet.s']);
});

test('overview groups by type, flow reverses arrows, colours categories', async () => {
  const { summarize } = await import('../public/render.js');
  const g = buildGraph([{ path: 'a.tf', content: `
    resource "aws_vpc" "main" {}
    resource "aws_subnet" "a" { vpc_id = aws_vpc.main.id }
    resource "aws_subnet" "b" { vpc_id = aws_vpc.main.id }
    resource "aws_instance" "web" { subnet_id = aws_subnet.a.id }` }]);
  const o = summarize(g);
  assert.equal(o.nodes.length, 3);
  const sub = o.nodes.find((n) => n.type === 'aws_subnet');
  assert.equal(sub.count, 2);
  assert.equal(o.edges.length, 2); // two subnet->vpc edges collapse into one
  const m = toMermaid(o, { flow: true, colors: true });
  assert.match(m, /subnet ×2<br\/><b>a, b/);
  assert.match(m, /n_::aws_vpc|n___aws_vpc --> n___aws_subnet/);
  assert.match(m, /classDef c\d fill:#1d4ed8/);
  assert.match(m, /style n_g_+Networking fill:#1d4ed822/);
});

test('follows local.* indirection to real references', () => {
  const g = buildGraph([{ path: 'a.tf', content: `
    locals {
      role_arn = var.create ? aws_iam_role.fn[0].arn : ""
      dest     = {
        bucket = aws_s3_bucket.logs.arn
      }
      chained  = local.role_arn
    }
    resource "aws_iam_role" "fn" {}
    resource "aws_s3_bucket" "logs" {}
    resource "aws_flow_log" "f" {
      iam_role_arn    = local.chained
      log_destination = local.dest.bucket
    }` }]);
  assert.ok(has(g, 'aws_flow_log.f', 'aws_iam_role.fn'));
  assert.ok(has(g, 'aws_flow_log.f', 'aws_s3_bucket.logs'));
});

test('reduceEdges drops arrows already implied by a longer path', async () => {
  const { reduceEdges } = await import('../public/render.js');
  const e = (from, to) => ({ from, to });
  // route depends on subnet and on vpc; subnet depends on vpc
  const kept = reduceEdges([e('route', 'subnet'), e('route', 'vpc'), e('subnet', 'vpc')]);
  assert.deepEqual(kept.map((x) => `${x.from}>${x.to}`).sort(), ['route>subnet', 'subnet>vpc']);
  // a cycle must not lose both directions
  assert.equal(reduceEdges([e('a', 'b'), e('b', 'a')]).length, 2);
});

test('icons: every common service gets its own glyph and short code', async () => {
  const { iconFor, abbrFor } = await import('../public/diagram.js');
  const want = {
    aws_vpc: ['cloud', 'VPC'], aws_subnet: ['grid', 'SUBN'], aws_internet_gateway: ['arch', 'IGW'], aws_nat_gateway: ['gateway', 'NAT'],
    aws_route_table: ['route', 'RT'], aws_eip: ['pin', 'EIP'], aws_network_acl: ['filter', 'ACL'], aws_security_group: ['shield', 'SG'],
    aws_instance: ['server', 'EC2'], aws_autoscaling_group: ['stack', 'ASG'], aws_lambda_function: ['lambda', 'FN'],
    aws_s3_bucket: ['bucket', 'S3'], aws_db_instance: ['database', 'RDS'], aws_dynamodb_table: ['table', 'DDB'],
    aws_elasticache_cluster: ['bolt', 'ECH'], aws_iam_role: ['user', 'IAM'], aws_kms_key: ['key', 'KMS'], aws_sqs_queue: ['message', 'SQS'],
    aws_sns_topic: ['bell', 'SNS'], aws_lb: ['balancer', 'LB'], aws_lb_target_group: ['target', 'TG'], aws_eks_cluster: ['helm', 'EKS'],
    aws_ecs_cluster: ['containers', 'ECS'], aws_ecr_repository: ['box', 'ECR'], aws_cloudfront_distribution: ['hub', 'CDN'],
    aws_route53_zone: ['globe', 'R53'], aws_wafv2_web_acl: ['wall', 'WAF'], aws_acm_certificate: ['cert', 'ACM'], aws_flow_log: ['doc', 'FLOW'],
    aws_db_subnet_group: ['grid', 'DBSG'], aws_vpc_endpoint: ['plug', 'VPCE'], aws_kinesis_stream: ['pulse', 'KIN'],
    azurerm_virtual_network: ['cloud', 'VNET'], azurerm_linux_virtual_machine: ['server', 'VM'], azurerm_storage_account: ['bucket', 'STG'],
    azurerm_key_vault: ['key', 'KV'], azurerm_network_security_group: ['shield', 'NSG'], azurerm_public_ip: ['pin', 'PIP'],
    azurerm_network_interface: ['plug', 'NIC'], azurerm_kubernetes_cluster: ['helm', 'AKS'], azurerm_container_registry: ['box', 'ACR'],
    azurerm_linux_web_app: ['window', 'APP'], azurerm_linux_function_app: ['lambda', 'FN'], azurerm_mssql_database: ['database', 'SQL'],
    azurerm_cosmosdb_account: ['table', 'COS'], azurerm_redis_cache: ['bolt', 'REDI'], azurerm_servicebus_queue: ['message', 'SBQ'],
    azurerm_resource_group: ['folder', 'RG'], azurerm_bastion_host: ['monitor', 'BAS'], azurerm_firewall: ['wall', 'FW'],
    azurerm_user_assigned_identity: ['user', 'MI'], azurerm_log_analytics_workspace: ['doc', 'LAW'], azurerm_application_insights: ['chart', 'AI'],
    azurerm_api_management: ['api', 'APIM'], azurerm_private_dns_zone: ['globe', 'DNS'], azurerm_virtual_network_gateway: ['arch', 'VPN'],
    azurerm_eventhub_namespace: ['pulse', 'EH'], azurerm_lb: ['balancer', 'LB'], azurerm_application_gateway: ['balancer', 'AGW'],
  };
  for (const [t, [icon, code]] of Object.entries(want)) {
    assert.equal(iconFor(t), icon, `${t} icon`);
    assert.equal(abbrFor(t), code, `${t} code`);
  }
  assert.equal(abbrFor('aws_some_new_thing'), 'SNT');   // initials of "Some new thing"
  assert.equal(iconFor('aws_totally_unknown'), 'cube');
});

test('labels: generic names fall back to the Name tag, then file:line', async () => {
  const { parseTerraform } = await import('../lib/parse.js');
  const src = `# header comment
/* block
   comment */
resource "aws_vpc" "this" {
  tags = { "Name" = "\${var.name}-vpc" }
}

resource "aws_s3_bucket" "this" {}
resource "aws_subnet" "public" {
  tags = { Name = "pub" }
}`;
  assert.deepEqual(parseTerraform(src).map((b) => b.line), [4, 8, 9]);
  const g = buildGraph([{ path: 'infra/main.tf', content: src }]);
  const label = (id) => g.nodes.find((n) => n.id === id).label;
  assert.equal(label('aws_vpc.this'), '{name}-vpc');
  assert.equal(label('aws_s3_bucket.this'), 'main.tf:8');
  assert.equal(label('aws_subnet.public'), 'public');
});

test('friendly type names and plurals', async () => {
  const { friendlyType, plural } = await import('../public/render.js');
  assert.equal(friendlyType('aws_network_acl'), 'Network ACL');
  assert.equal(friendlyType('aws_db_subnet_group'), 'DB subnet group');
  assert.equal(friendlyType('azurerm_linux_virtual_machine'), 'Linux VM');
  assert.equal(friendlyType('aws_ec2_thing_gateway'), 'EC2 thing gateway');
  for (const [t, name] of Object.entries({ aws_kms_key: 'KMS key', aws_sqs_queue: 'SQS queue', aws_dynamodb_table: 'DynamoDB table', aws_eks_cluster: 'EKS cluster', aws_cloudfront_distribution: 'CloudFront distribution', aws_wafv2_web_acl: 'WAFv2 web ACL', aws_route53_zone: 'Route 53 zone', aws_opensearch_domain: 'OpenSearch domain' })) assert.equal(friendlyType(t), name);
  assert.equal(plural('Subnet'), 'Subnets');
  assert.equal(plural('Route table'), 'Route tables');
  assert.equal(plural('Network ACL'), 'Network ACLs');
  assert.equal(plural('Security group'), 'Security groups');
  assert.equal(plural('Policy'), 'Policies');
  assert.equal(plural('Access'), 'Accesses');
});

test('azure: icons, friendly names and Azure resource names', async () => {
  const { iconFor } = await import('../public/diagram.js');
  const { friendlyType } = await import('../public/render.js');
  assert.equal(friendlyType('azurerm_mssql_database'), 'SQL database');
  assert.equal(friendlyType('azurerm_linux_web_app'), 'Linux web app');
  assert.equal(friendlyType('azurerm_log_analytics_workspace'), 'Log Analytics workspace');
  assert.equal(friendlyType('azurerm_some_new_thing'), 'Some new thing');

  const az = [{ path: 'azure.tf', content: readFileSync(new URL('../sample/azure.tf', import.meta.url), 'utf8') }];
  const g = buildGraph(az);
  const label = (id) => g.nodes.find((n) => n.id === id).label;
  assert.equal(label('azurerm_virtual_network.main'), 'vnet-{prefix}');   // generic TF name -> the Azure name
  assert.equal(label('azurerm_lb.main'), 'lb-web');
  assert.equal(label('azurerm_subnet.app'), 'app');                       // meaningful TF name is kept
  assert.equal(label('azurerm_mssql_database.app'), 'app');
  assert.equal(label('azurerm_network_interface.nic'), 'nic');
  assert.equal(label('azurerm_service_plan.main'), 'asp-{prefix}');
});

test('cidr: literals, variable defaults, module arguments, cidrsubnet, azure', async () => {
  const { cidrsubnet } = await import('../lib/cidr.js');
  const { cidrText } = await import('../public/render.js');
  assert.equal(cidrsubnet('10.0.0.0/16', 8, 1), '10.0.1.0/24');
  assert.equal(cidrsubnet('10.0.0.0/16', 8, 255), '10.0.255.0/24');
  assert.equal(cidrsubnet('192.168.4.0/22', 2, 3), '192.168.7.0/24');
  assert.equal(cidrsubnet('10.0.0.0/16', 8, 256), null);
  assert.equal(cidrText(['10.0.1.0/24', 'a', 'b']), '10.0.1.0/24 +2');

  const { loadTree } = await import('../lib/modules.js');
  const dirs = {
    '': [{ path: 'main.tf', content: `
      module "net" {
        source          = "./net"
        cidr            = "10.1.0.0/16"
        private_subnets = ["10.1.1.0/24", "10.1.2.0/24"]
      }
      resource "aws_vpc" "main" { cidr_block = "10.9.0.0/16" }` }],
    net: [{ path: 'net/n.tf', content: `
      variable "cidr" { default = "10.0.0.0/8" }
      variable "private_subnets" { default = [] }
      locals { newbits = 8 }
      resource "aws_vpc" "this" { cidr_block = var.cidr }
      resource "aws_subnet" "private" { cidr_block = element(var.private_subnets, count.index) }
      resource "aws_subnet" "calc" { cidr_block = cidrsubnet(var.cidr, local.newbits, 4) }
      resource "aws_subnet" "dyn" { cidr_block = cidrsubnet(var.cidr, 8, count.index) }` }],
  };
  const g = buildGraph(await loadTree('', async (d) => dirs[d] ?? []));
  const c = (id) => g.nodes.find((n) => n.id === id).cidrs;
  assert.deepEqual(c('aws_vpc.main'), ['10.9.0.0/16']);
  assert.deepEqual(c('module.net.aws_vpc.this'), ['10.1.0.0/16']);          // module argument beats the default
  assert.deepEqual(c('module.net.aws_subnet.private'), ['10.1.1.0/24', '10.1.2.0/24']);
  assert.deepEqual(c('module.net.aws_subnet.calc'), ['10.1.4.0/24']);
  assert.deepEqual(c('module.net.aws_subnet.dyn'), ['/24 of 10.1.0.0/16']);   // index unknown: still shows the size

  const az = buildGraph([{ path: 'a.tf', content: `
    resource "azurerm_virtual_network" "main" { address_space = ["10.2.0.0/16"] }
    resource "azurerm_subnet" "app" { address_prefixes = ["10.2.1.0/24"] }` }], { provider: 'azure' });
  assert.deepEqual(az.nodes.map((n) => n.cidrs), [['10.2.0.0/16'], ['10.2.1.0/24']]);
});

test('details: security group rules (inline, dynamic, separate resources) and route tables', () => {
  const g = buildGraph([{ path: 'n.tf', content: `
    resource "aws_security_group" "web" {
      name = "web"
      ingress {
        from_port   = 443
        to_port     = 443
        protocol    = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
        description = "https"
      }
      ingress {
        from_port       = 80
        to_port         = 80
        protocol        = "tcp"
        security_groups = [aws_security_group.lb.id]
      }
      dynamic "ingress" {
        for_each = var.ports
        content {
          from_port   = ingress.value
          to_port     = ingress.value
          protocol    = "tcp"
          cidr_blocks = ["10.0.0.0/8"]
        }
      }
      egress {
        from_port   = 0
        to_port     = 0
        protocol    = "-1"
        cidr_blocks = ["0.0.0.0/0"]
      }
    }
    resource "aws_security_group" "lb" {}
    resource "aws_security_group_rule" "ssh" {
      type              = "ingress"
      security_group_id = aws_security_group.web.id
      from_port         = 22
      to_port           = 22
      protocol          = "tcp"
      cidr_blocks       = ["10.1.0.0/16"]
    }
    resource "aws_vpc_security_group_egress_rule" "dns" {
      security_group_id = aws_security_group.lb.id
      ip_protocol       = "udp"
      from_port         = 53
      to_port           = 53
      cidr_ipv4         = "10.2.0.0/16"
    }
    resource "aws_internet_gateway" "igw" {}
    resource "aws_route_table" "public" {
      route {
        cidr_block = "0.0.0.0/0"
        gateway_id = aws_internet_gateway.igw.id
      }
    }
    resource "aws_route_table" "private" {}
    resource "aws_route" "nat" {
      route_table_id         = aws_route_table.private.id
      destination_cidr_block = "0.0.0.0/0"
      nat_gateway_id         = aws_nat_gateway.n.id
    }
    resource "aws_nat_gateway" "n" {}` }]);
  const node = (id) => g.nodes.find((n) => n.id === id);

  const web = node('aws_security_group.web').details;
  assert.equal(web.kind, 'rules');
  const ins = web.rows.filter((r) => r.dir === 'in');
  assert.deepEqual(ins.map((r) => [r.proto, r.ports, r.peers.join(',')]), [['tcp', '443', '0.0.0.0/0'], ['tcp', '80', 'Security group lb'], ['tcp', 'varies', '10.0.0.0/8'], ['tcp', '22', '10.1.0.0/16']]);
  assert.equal(ins[0].note, 'https');
  assert.equal(ins[2].dynamic, true);
  assert.deepEqual(web.rows.filter((r) => r.dir === 'out').map((r) => [r.proto, r.ports]), [['all', 'all']]);
  assert.equal(node('aws_security_group.web').summary, 'in 443, 80, varies +1 · out all');
  assert.deepEqual(node('aws_security_group.lb').details.rows.map((r) => [r.dir, r.proto, r.ports, r.peers[0]]), [['out', 'udp', '53', '10.2.0.0/16']]);
  assert.ok(!g.nodes.some((n) => n.type === 'aws_security_group_rule'), 'rule resources stay hidden');

  assert.deepEqual(node('aws_route_table.public').details.rows, [{ dest: '0.0.0.0/0', target: 'Internet gateway igw', note: '', dynamic: false }]);
  assert.deepEqual(node('aws_route_table.private').details.rows.map((r) => [r.dest, r.target]), [['0.0.0.0/0', 'NAT gateway n']]);
  assert.equal(node('aws_route_table.public').summary, '0.0.0.0/0 → Internet gateway igw');
});

test('details: azure NSG rules and route tables', () => {
  const g = buildGraph([{ path: 'a.tf', content: `
    resource "azurerm_network_security_group" "nsg" {
      security_rule {
        name                       = "https"
        priority                   = 100
        direction                  = "Inbound"
        access                     = "Allow"
        protocol                   = "Tcp"
        source_port_range          = "*"
        destination_port_range     = "443"
        source_address_prefix      = "Internet"
        destination_address_prefix = "*"
      }
    }
    resource "azurerm_network_security_rule" "deny" {
      name                        = "deny-ssh"
      priority                    = 200
      direction                   = "Inbound"
      access                      = "Deny"
      protocol                    = "*"
      destination_port_range      = "22"
      source_address_prefix       = "*"
      network_security_group_name = azurerm_network_security_group.nsg.name
    }
    resource "azurerm_route_table" "rt" {
      route {
        name           = "to-fw"
        address_prefix = "0.0.0.0/0"
        next_hop_type  = "VirtualAppliance"
        next_hop_in_ip_address = "10.0.1.4"
      }
    }` }], { provider: 'azure' });
  const nsg = g.nodes.find((n) => n.id === 'azurerm_network_security_group.nsg');
  assert.deepEqual(nsg.details.rows.map((r) => [r.dir, r.action, r.proto, r.ports, r.peers[0], r.priority]), [['in', 'Allow', 'tcp', '443', 'Internet', '100'], ['in', 'Deny', 'all', '22', 'any', '200']]);
  assert.equal(nsg.summary, 'in 443, ✗22');
  const rt = g.nodes.find((n) => n.id === 'azurerm_route_table.rt');
  assert.deepEqual(rt.details.rows.map((r) => [r.dest, r.target]), [['0.0.0.0/0', 'VirtualAppliance 10.0.1.4']]);
});

test('overview keeps a lone resource\'s details, drops them for real groups', async () => {
  const { summarize } = await import('../public/render.js');
  const g = buildGraph([{ path: 'a.tf', content: `
    resource "aws_security_group" "only" { ingress {
      from_port = 22
      to_port = 22
      protocol = "tcp"
      cidr_blocks = ["10.0.0.0/8"]
    } }
    resource "aws_route_table" "a" {}
    resource "aws_route_table" "b" {}` }]);
  const o = summarize(g);
  const sg = o.nodes.find((n) => n.type === 'aws_security_group');
  assert.equal(sg.count, 1);
  assert.equal(sg.summary, 'in 22');
  assert.equal(sg.details.rows.length, 1);
  assert.equal(sg.label, 'only');
  const rt = o.nodes.find((n) => n.type === 'aws_route_table');
  assert.equal(rt.count, 2);
  assert.equal(rt.details, undefined);
  assert.equal(rt.summary, undefined);
});

test('details: settings for every resource, S3 / LB / EBS / storage sub-resources folded in', () => {
  const g = buildGraph([{ path: 'x.tf', content: `
    resource "aws_s3_bucket" "logs" {
      bucket = "my-logs"
      tags   = { Env = "prod" }
    }
    resource "aws_s3_bucket_versioning" "logs" {
      bucket = aws_s3_bucket.logs.id
      versioning_configuration {
        status = "Enabled"
      }
    }
    resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
      bucket = aws_s3_bucket.logs.id
      rule {
        apply_server_side_encryption_by_default {
          sse_algorithm = "aws:kms"
        }
      }
    }
    resource "aws_s3_bucket_public_access_block" "logs" {
      bucket                  = aws_s3_bucket.logs.id
      block_public_acls       = true
      block_public_policy     = true
      ignore_public_acls      = true
      restrict_public_buckets = true
    }
    resource "aws_lb" "app" {
      load_balancer_type = "application"
      internal           = false
    }
    resource "aws_lb_target_group" "web" {
      port     = 8080
      protocol = "HTTP"
      health_check {
        path = "/health"
      }
    }
    resource "aws_lb_listener" "https" {
      load_balancer_arn = aws_lb.app.arn
      port              = 443
      protocol          = "HTTPS"
      default_action {
        type             = "forward"
        target_group_arn = aws_lb_target_group.web.arn
      }
    }
    resource "aws_ebs_volume" "data" {
      availability_zone = "eu-west-1a"
      size              = 100
      type              = "gp3"
      encrypted         = true
    }
    resource "aws_instance" "web" {
      instance_type = "t3.micro"
      root_block_device {
        volume_size = 30
        volume_type = "gp3"
      }
    }
    resource "aws_volume_attachment" "data" {
      device_name = "/dev/sdh"
      volume_id   = aws_ebs_volume.data.id
      instance_id = aws_instance.web.id
    }` }]);
  const node = (id) => g.nodes.find((n) => n.id === id);
  const rows = (id) => Object.fromEntries(node(id).details.rows.map((r) => [r.k, r.value]));

  const s3 = rows('aws_s3_bucket.logs');
  assert.equal(s3.bucket, 'my-logs');
  assert.equal(s3.versioning, 'Enabled');
  assert.equal(s3.encryption, 'aws:kms');
  assert.equal(s3.public_access, 'all blocked');
  assert.ok(!('tags' in s3));
  assert.equal(node('aws_s3_bucket.logs').summary, 'versioned · encrypted · private');
  assert.ok(!g.nodes.some((n) => n.type.startsWith('aws_s3_bucket_')), 'bucket sub-resources stay hidden');

  assert.equal(rows('aws_lb.app').listener, 'HTTPS 443 → forward to LB target group web');
  assert.equal(node('aws_lb.app').summary, 'application public :443');
  assert.match(rows('aws_lb_target_group.web').health_check, /path \/health/);

  assert.equal(node('aws_ebs_volume.data').summary, '100 GB gp3 encrypted');
  assert.equal(rows('aws_ebs_volume.data').attached, 'EC2 instance web as /dev/sdh');
  assert.equal(node('aws_instance.web').summary, 't3.micro');
  assert.match(rows('aws_instance.web').root_block_device, /size 30, type gp3/);
  assert.ok(!g.nodes.some((n) => n.type === 'aws_volume_attachment'));

  const az = buildGraph([{ path: 'a.tf', content: `
    resource "azurerm_storage_account" "sa" {
      name                     = "st1"
      account_tier             = "Standard"
      account_replication_type = "LRS"
    }
    resource "azurerm_storage_container" "c" {
      name                  = "assets"
      storage_account_name  = azurerm_storage_account.sa.name
      container_access_type = "private"
    }
    resource "azurerm_lb" "lb" {
      sku = "Standard"
    }
    resource "azurerm_lb_rule" "http" {
      loadbalancer_id = azurerm_lb.lb.id
      name            = "http"
      protocol        = "Tcp"
      frontend_port   = 80
      backend_port    = 8080
    }` }], { provider: 'azure' });
  const a = (id) => az.nodes.find((n) => n.id === id);
  assert.equal(a('azurerm_storage_account.sa').summary, 'Standard LRS');
  assert.ok(a('azurerm_storage_account.sa').details.rows.some((r) => r.k === 'container' && r.value === 'assets (private)'));
  assert.equal(a('azurerm_lb.lb').summary, 'Standard · 1 rules');
  assert.ok(!az.nodes.some((n) => n.type === 'azurerm_lb_rule' || n.type === 'azurerm_storage_container'));
});

test('hidden association resources still link the things they connect', () => {
  const g = buildGraph([{ path: 'n.tf', content: `
    resource "aws_vpc" "main" {}
    resource "aws_vpc_dhcp_options" "opts" {}
    resource "aws_vpc_dhcp_options_association" "a" {
      vpc_id          = aws_vpc.main.id
      dhcp_options_id = aws_vpc_dhcp_options.opts.id
    }
    resource "aws_subnet" "s" { vpc_id = aws_vpc.main.id }
    resource "aws_route_table" "rt" { vpc_id = aws_vpc.main.id }
    resource "aws_route_table_association" "assoc" {
      route_table_id = aws_route_table.rt.id
      subnet_id      = aws_subnet.s.id
    }
    resource "aws_lambda_function" "fn" {}
    resource "aws_s3_bucket" "b" {}
    resource "aws_lambda_permission" "allow" {
      function_name = aws_lambda_function.fn.function_name
      source_arn    = aws_s3_bucket.b.arn
    }` }]);
  const has2 = (from, to) => g.edges.some((e) => e.from === from && e.to === to);
  assert.ok(!g.nodes.some((n) => /association|attachment/.test(n.type)), 'plumbing is still hidden');
  assert.ok(has2('aws_vpc.main', 'aws_vpc_dhcp_options.opts'));       // options flow into the VPC
  assert.ok(has2('aws_subnet.s', 'aws_route_table.rt'));              // route table flows into the subnet
  assert.ok(has2('aws_lambda_function.fn', 'aws_s3_bucket.b'));       // first named is the consumer when there is no hint
});

test('details read plain values and say "varies" instead of printing code', () => {
  const g = buildGraph([{ path: 'm.tf', content: `
    variable "create"  { default = true }
    variable "use_prefix" { default = true }
    variable "name"    { default = "flow-role" }
    variable "ingress_rules" { default = [] }
    variable "routes"  { default = [] }
    resource "aws_iam_role" "r" {
      count       = var.create ? 1 : 0
      name        = var.use_prefix ? null : var.name
      name_prefix = var.use_prefix ? "\${var.name}-" : null
      path        = null
      permissions_boundary = var.create ? merge(var.a, var.b) : null
      max_session_duration = var.create ? 3600 : 7200
    }
    resource "aws_default_security_group" "d" {
      dynamic "ingress" {
        for_each = var.ingress_rules
        content {
          self        = lookup(ingress.value, "self", null)
          cidr_blocks = compact(split(",", lookup(ingress.value, "cidr_blocks", "")))
        }
      }
    }
    resource "aws_security_group" "loop" {
      dynamic "ingress" {
        for_each = var.unknown_rules
        content {
          from_port   = ingress.value.port
          to_port     = ingress.value.port
          protocol    = "tcp"
          cidr_blocks = ingress.value.cidrs
        }
      }
    }
    resource "aws_default_route_table" "t" {
      dynamic "route" {
        for_each = var.routes
        content {
          cidr_block = route.value.cidr_block
        }
      }
    }` }]);
  const node = (id) => g.nodes.find((n) => n.id === id);
  const rows = Object.fromEntries(node('aws_iam_role.r').details.rows.map((r) => [r.k, r.value]));
  assert.equal(rows.name, undefined);                       // resolves to null: not shown
  assert.equal(rows.name_prefix, 'flow-role-');             // condition + interpolated default resolved
  assert.equal(rows.path, undefined);
  assert.equal(rows.max_session_duration, '3600');
  assert.equal(rows.permissions_boundary, "(computed)");             // function call: not code
  assert.deepEqual(node('aws_default_security_group.d').details.rows, []);     // loop over [] -> no rules
  assert.equal(node('aws_default_security_group.d').summary, 'no rules');
  assert.deepEqual(node('aws_default_route_table.t').details.rows, []);
  assert.equal(node('aws_default_route_table.t').summary, 'no routes');
  const loop = node('aws_security_group.loop').details.rows;
  assert.deepEqual(loop.map((r) => [r.proto, r.ports, r.peers[0], r.dynamic]), [['tcp', 'varies', 'varies', true]]);
  assert.match(loop[0].note, /one per item of var\.unknown_rules/);
});

test('conditionals: simple boolean logic is evaluated, anything else stays computed', async () => {
  const { simplify, isComputed } = await import('../lib/details.js');
  assert.equal(simplify('(false) && (x) ? true : null'), 'null');
  assert.equal(simplify('true ? "a" : "b"'), '"a"');
  assert.equal(simplify('!false ? 1 : 2'), '1');
  assert.equal(simplify('("x" == "x") ? 5 : 6'), '5');
  assert.equal(simplify('("x" != "x") ? 5 : 6'), '6');
  assert.equal(simplify('(1 == 2) || true ? 7 : 8'), '7');
  assert.equal(simplify('"${("x")}-"'), '"x-"');
  assert.ok(isComputed(simplify('var.unknown ? 1 : 2')));            // unknown condition: not a guess
  assert.ok(isComputed('merge(a, b)') && isComputed('route.value.cidr') && !isComputed('"plain"'));
});
