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

test('settings: boolean expressions are evaluated, hidden helper resources are not named', () => {
  const g = buildGraph([{ path: 's.tf', content: `
    variable "a" { default = false }
    variable "b" { default = false }
    resource "aws_vpc" "this" {}
    resource "aws_vpc_ipv4_cidr_block_association" "this" { vpc_id = aws_vpc.this.id }
    resource "aws_subnet" "db" {
      vpc_id                          = try(aws_vpc_ipv4_cidr_block_association.this[0].vpc_id, aws_vpc.this[0].id, "")
      enable_resource_name_dns_a_record_on_launch = !var.a && var.b
      ipv6_native                     = var.a && var.b
      availability_zone               = data.aws_availability_zones.available.names[0]
      cidr_block                      = element(concat(var.cidrs, [""]), count.index)
    }` }]);
  const rows = Object.fromEntries(g.nodes.find((n) => n.id === 'aws_subnet.db').details.rows.map((r) => [r.k, r.value]));
  assert.equal(rows.vpc_id, 'VPC this');                       // not "VPC ipv4 cidr block association this, VPC this"
  assert.equal(rows.enable_resource_name_dns_a_record_on_launch, 'false');
  assert.equal(rows.ipv6_native, 'false');
  assert.equal(rows.availability_zone, 'Availability zones available');
  assert.equal(rows.cidr_block, '(computed)');
});

test('cidr: ranges from a module call\'s for-expressions, slice() lengths and element(var.list, ...)', async () => {
  const { arith, listLength, expandFor } = await import('../lib/cidr.js');
  const { loadTree } = await import('../lib/modules.js');
  assert.equal(arith('0 + 48'), 48);
  assert.equal(arith('(1+2)*4-3'), 9);
  assert.equal(arith('k + 1'), null);
  assert.equal(listLength('["a","b",["c","d"]]'), 3);
  assert.equal(listLength('slice(data.x.names, 0, 3)'), 3);
  assert.equal(listLength('range(4)'), 4);
  assert.equal(listLength('var.unknown'), null);
  assert.equal(expandFor('[for k, v in ["a","b"] : cidrsubnet("10.0.0.0/16", 8, k + 10)]'), '["10.0.10.0/24", "10.0.11.0/24"]');
  assert.equal(expandFor('[for k, v in var.x : cidrsubnet("10.0.0.0/16", 8, k)]'), '[for k, v in var.x : cidrsubnet("10.0.0.0/16", 8, k)]');   // unknown length: untouched

  const dirs = {
    ex: [{ path: 'ex/main.tf', content: `
      locals {
        vpc_cidr = "10.0.0.0/16"
        azs      = slice(data.aws_availability_zones.available.names, 0, 3)
      }
      module "vpc" {
        source          = "../"
        private_subnets = [for k, v in local.azs : cidrsubnet(local.vpc_cidr, 4, k)]
        public_subnets  = [for k, v in local.azs : cidrsubnet(local.vpc_cidr, 8, k + 48)]
        db_subnets      = ["10.0.200.0/24"]
      }` }],
    '': [{ path: 'main.tf', content: `
      variable "private_subnets" { default = [] }
      variable "public_subnets"  { default = [] }
      variable "db_subnets"      { default = [] }
      resource "aws_subnet" "private" {
        count      = length(var.private_subnets)
        cidr_block = element(concat(var.private_subnets, [""]), count.index)
      }
      resource "aws_subnet" "public" {
        cidr_block = element(concat(var.public_subnets, [""]), count.index)
      }
      resource "aws_subnet" "db" {
        cidr_block = var.db_subnets[0]
      }` }],
  };
  const g = buildGraph(await loadTree('ex', async (d) => dirs[d] ?? []));
  const c = (id) => g.nodes.find((n) => n.id === id).cidrs;
  assert.deepEqual(c('module.vpc.aws_subnet.private'), ['10.0.0.0/20', '10.0.16.0/20', '10.0.32.0/20']);
  assert.deepEqual(c('module.vpc.aws_subnet.public'), ['10.0.48.0/24', '10.0.49.0/24', '10.0.50.0/24']);
  assert.deepEqual(c('module.vpc.aws_subnet.db'), ['10.0.200.0/24']);
});

test('count / for_each: resources that are not created are left out, copies are counted', async () => {
  const { evalNum, simplify } = await import('../lib/details.js');
  const { loadTree } = await import('../lib/modules.js');
  const { summarize } = await import('../public/render.js');
  assert.equal(evalNum('max(length([]), length(["a","b"]))'), 2);
  assert.equal(evalNum('length(keys({}))'), 0);
  assert.equal(simplify('(true) ? (false) ? 1 : 2 : 3'), '2');              // nested conditional in the middle branch
  assert.equal(simplify('(false) ? (true) ? 1 : 2 : 3'), '3');

  const dirs = {
    ex: [{ path: 'ex/main.tf', content: `
      module "vpc" {
        source          = "../"
        private_subnets = ["10.0.1.0/24", "10.0.2.0/24"]
        gateways        = {}
      }
      module "off" {
        source     = "../"
        create_vpc = false
        gateways   = {}
      }` }],
    '': [{ path: 'main.tf', content: `
      variable "create_vpc" { default = true }
      variable "private_subnets" { default = [] }
      variable "public_subnets" { default = [] }
      variable "gateways" { default = { a = 1 } }
      locals {
        create_vpc  = var.create_vpc
        len_private = length(var.private_subnets)
        len_public  = length(var.public_subnets)
      }
      resource "aws_vpc" "this" { count = local.create_vpc ? 1 : 0 }
      resource "aws_subnet" "private" {
        count      = local.create_vpc && local.len_private > 0 ? local.len_private : 0
        cidr_block = element(var.private_subnets, count.index)
        vpc_id     = aws_vpc.this[0].id
      }
      resource "aws_subnet" "public" {
        count  = local.create_vpc && local.len_public > 0 ? local.len_public : 0
        vpc_id = aws_vpc.this[0].id
      }
      resource "aws_internet_gateway" "this" {
        count  = local.create_vpc && local.len_public > 0 ? 1 : 0
        vpc_id = aws_vpc.this[0].id
      }
      resource "aws_customer_gateway" "this" { for_each = var.gateways }
      resource "aws_nat_gateway" "x" {
        for_each = { for k, v in var.gateways : k => v if local.create_vpc }
      }` }],
  };
  const tree = await loadTree('ex', async (d) => dirs[d] ?? []);
  const g = buildGraph(tree);
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes('module.vpc.aws_vpc.this') && ids.includes('module.vpc.aws_subnet.private'));
  assert.ok(!ids.includes('module.vpc.aws_subnet.public') && !ids.includes('module.vpc.aws_internet_gateway.this'), 'count = 0 resources are not drawn');
  assert.ok(!ids.includes('module.vpc.aws_customer_gateway.this'), 'for_each over {} makes nothing');
  assert.equal(g.nodes.find((n) => n.id === 'module.vpc.aws_subnet.private').instances, 2);
  assert.deepEqual(g.nodes.find((n) => n.id === 'module.vpc.aws_subnet.private').cidrs, ['10.0.1.0/24', '10.0.2.0/24']);
  assert.equal(g.nodes.find((n) => n.id === 'module.off').expanded, false);                     // everything off: a plain module card
  assert.equal(g.nodes.find((n) => n.id === 'module.off').summary, 'nothing created here');
  assert.ok(!ids.some((i) => i.startsWith('module.off.')));
  assert.ok(g.inactive.includes('module.vpc.aws_subnet.public') && g.inactive.includes('module.off.aws_vpc.this'));

  const shown = buildGraph(tree, { showInactive: true });
  const pub = shown.nodes.find((n) => n.id === 'module.vpc.aws_subnet.public');
  assert.equal(pub.inactive, true);
  assert.equal(pub.summary, 'not created (count = 0)');

  // the overview counts copies, and an arrow remembers the links it merges
  const o = summarize(g);
  const sub = o.nodes.find((n) => n.type === 'aws_subnet');
  assert.equal(sub.members, 1);
  assert.equal(sub.count, 2);
  assert.ok(o.edges.some((e) => /aws_vpc$/.test(e.to) && e.count === 1 && e.pairs[0][0] === 'private'));
});

test('a link made only through a hidden association does not hide a direct one', async () => {
  const { reduceEdges } = await import('../public/render.js');
  const g = buildGraph([{ path: 'n.tf', content: `
    resource "aws_vpc" "v" {}
    resource "aws_route_table" "rt" { vpc_id = aws_vpc.v.id }
    resource "aws_subnet" "s" { vpc_id = aws_vpc.v.id }
    resource "aws_route_table_association" "a" {
      subnet_id      = aws_subnet.s.id
      route_table_id = aws_route_table.rt.id
    }` }]);
  const link = g.edges.find((e) => e.from === 'aws_subnet.s' && e.to === 'aws_route_table.rt');
  assert.equal(link.weak, true);
  const kept = reduceEdges(g.edges).map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(kept, ['aws_route_table.rt>aws_vpc.v', 'aws_subnet.s>aws_route_table.rt', 'aws_subnet.s>aws_vpc.v']);   // subnet -> vpc stays
  // while a path made of direct links still removes the redundant arrow
  assert.equal(reduceEdges([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }]).length, 2);
});

test('rules from a for_each over a map written out (EC2 module pattern)', () => {
  const g = buildGraph([{ path: 'm.tf', content: `
    variable "create" { default = true }
    variable "egress_rules" {
      default = {
        ipv4_default = {
          cidr_ipv4   = "0.0.0.0/0"
          description = "Allow all IPv4 traffic"
          ip_protocol = "-1"
        }
        ipv6_default = {
          cidr_ipv6   = "::/0"
          ip_protocol = "-1"
        }
      }
    }
    variable "ingress_rules" { default = null }
    variable "https" {
      default = {
        web = { from_port = 443, to_port = 443, ip_protocol = "tcp", cidr_ipv4 = "10.0.0.0/8" }
      }
    }
    locals { create_sg = var.create }
    resource "aws_security_group" "this" { count = local.create_sg ? 1 : 0 }
    resource "aws_vpc_security_group_egress_rule" "this" {
      for_each          = local.create_sg && var.egress_rules != null ? var.egress_rules : {}
      cidr_ipv4         = each.value.cidr_ipv4
      cidr_ipv6         = each.value.cidr_ipv6
      description       = each.value.description
      from_port         = try(coalesce(each.value.from_port, each.value.to_port), null)
      ip_protocol       = each.value.ip_protocol
      prefix_list_id    = each.value.prefix_list_id
      security_group_id = aws_security_group.this[0].id
    }
    resource "aws_vpc_security_group_ingress_rule" "none" {
      for_each          = local.create_sg && var.ingress_rules != null ? var.ingress_rules : {}
      security_group_id = aws_security_group.this[0].id
      cidr_ipv4         = each.value.cidr_ipv4
    }
    resource "aws_vpc_security_group_ingress_rule" "https" {
      for_each          = var.https
      security_group_id = aws_security_group.this[0].id
      cidr_ipv4         = each.value.cidr_ipv4
      from_port         = each.value.from_port
      to_port           = each.value.to_port
      ip_protocol       = each.value.ip_protocol
    }` }]);
  const sg = g.nodes.find((n) => n.id === 'aws_security_group.this');
  assert.deepEqual(sg.details.rows.map((r) => [r.dir, r.proto, r.ports, r.peers.join(','), r.note]), [
    ['out', 'all', 'all', '0.0.0.0/0', 'Allow all IPv4 traffic'],     // `prefix list` is not listed: that attribute is null
    ['out', 'all', 'all', '::/0', ''],
    ['in', 'tcp', '443', '10.0.0.0/8', ''],
  ]);
  assert.equal(sg.summary, 'in 443 · out all');
});

test('computed settings still name the visible resources they use', () => {
  const g = buildGraph([{ path: 'm.tf', content: `
    resource "aws_security_group" "this" {}
    resource "aws_instance" "i" {
      vpc_security_group_ids = compact(concat([try(aws_security_group.this[0].id, null)], var.extra))
      ami                    = data.aws_ssm_parameter.ami.value
    }` }]);
  const rows = Object.fromEntries(g.nodes.find((n) => n.id === 'aws_instance.i').details.rows.map((r) => [r.k, r.value]));
  assert.equal(rows.vpc_security_group_ids, 'Security group this (computed)');
  assert.equal(rows.ami, 'SSM parameter ami');
});

test('module outputs and inputs are traced to the resources behind them (clipshare pattern)', async () => {
  const { loadTree } = await import('../lib/modules.js');
  const dirs = {
    '': [{ path: 'main.tf', content: `
      module "s3" { source = "./modules/s3" }
      module "acm" {
        source     = "./modules/acm"
        depends_on = [module.s3]
      }
      module "cdn" {
        source          = "./modules/cdn"
        bucket_id       = module.s3.bucket_name
        oai_arn         = module.s3.oai_arn
        certificate_arn = module.acm.certificate_arn
        depends_on      = [module.s3, module.acm]
      }
      module "dns" {
        source      = "./modules/dns"
        cdn_domain  = module.cdn.domain_name
        depends_on  = [module.cdn]
      }` }],
    'modules/s3': [{ path: 'modules/s3/main.tf', content: `
      resource "aws_s3_bucket" "b" {}
      resource "aws_cloudfront_origin_access_identity" "oai" {}
      output "bucket_name" { value = aws_s3_bucket.b.id }
      output "oai_arn"     { value = aws_cloudfront_origin_access_identity.oai.iam_arn }` }],
    'modules/acm': [{ path: 'modules/acm/main.tf', content: `
      resource "aws_acm_certificate" "c" {}
      resource "aws_acm_certificate_validation" "v" { certificate_arn = aws_acm_certificate.c.arn }
      output "certificate_arn" { value = aws_acm_certificate_validation.v.certificate_arn }` }],
    'modules/cdn': [{ path: 'modules/cdn/main.tf', content: `
      variable "bucket_id" {}
      variable "oai_arn" {}
      variable "certificate_arn" {}
      resource "aws_cloudfront_distribution" "d" {
        origin_id       = var.bucket_id
        oai             = var.oai_arn
        certificate_arn = var.certificate_arn
      }
      output "domain_name" { value = aws_cloudfront_distribution.d.domain_name }` }],
    'modules/dns': [{ path: 'modules/dns/main.tf', content: `
      variable "cdn_domain" {}
      resource "aws_route53_record" "www" { records = [var.cdn_domain] }` }],
  };
  const g = buildGraph(await loadTree('', async (d) => dirs[d] ?? []));
  const flow = g.edges.map((e) => `${e.to.replace(/module\.\w+\./, '')}>${e.from.replace(/module\.\w+\./, '')}`);
  const has = (from, to) => g.edges.some((e) => e.to.endsWith(from) && e.from.endsWith(to));
  assert.ok(has('aws_s3_bucket.b', 'aws_cloudfront_distribution.d'), flow.join(' | '));            // module.s3.bucket_name -> var.bucket_id -> the distribution
  assert.ok(has('aws_cloudfront_origin_access_identity.oai', 'aws_cloudfront_distribution.d'));
  assert.ok(has('aws_acm_certificate_validation.v', 'aws_cloudfront_distribution.d'));              // through the output's own reference
  assert.ok(has('aws_cloudfront_distribution.d', 'aws_route53_record.www'));
  // the module boxes are not linked again where resources already are...
  assert.ok(!g.edges.some((e) => e.from === 'module.cdn' && e.to === 'module.s3'));
  assert.ok(!g.edges.some((e) => e.from === 'module.dns' && e.to === 'module.cdn'));
  // ...but a pure depends_on with nothing else behind it stays, marked as ordering only
  const order = g.edges.find((e) => e.from === 'module.acm' && e.to === 'module.s3');
  assert.equal(order?.ordering, true);
});

test('an argument nobody uses inside the module, or an output it cannot follow, still links the module boxes', () => {
  // output of a data source: nothing visible behind it
  const g = buildGraph({ files: [{ path: 'm.tf', content: `
    module "a" { source = "./a" }
    module "b" {
      source = "./b"
      zone   = module.a.zone_id
    }` }], children: {
    a: { dir: 'a', files: [{ path: 'a/m.tf', content: 'data "aws_route53_zone" "z" {}\nresource "aws_vpc" "v" {}\noutput "zone_id" { value = data.aws_route53_zone.z.zone_id }' }], children: {} },
    b: { dir: 'b', files: [{ path: 'b/m.tf', content: 'variable "zone" {}\nresource "aws_vpc" "w" {}' }], children: {} },
  } });
  assert.ok(g.edges.some((e) => e.from === 'module.b' && e.to === 'module.a' && !e.ordering), 'falls back to module -> module');
});

test('object attributes, concat() lengths and try() sizes are evaluated (terraform-aws-backup pattern)', async () => {
  const { simplify, reduceAttrAccess, evalNum } = await import('../lib/details.js');
  const { listLength } = await import('../lib/cidr.js');
  assert.equal(reduceAttrAccess('( { create = false\n name = null } ).create'), 'false');
  assert.equal(reduceAttrAccess('({ a = 1 }).missing'), 'null');
  assert.equal(reduceAttrAccess('f(x).y'), 'f(x).y');                              // not an object literal: left alone
  assert.equal(simplify('( { create = false\n name = null } ).create ? 1 : 0'), '0');
  assert.equal(listLength('concat([], [])'), 0);
  assert.equal(listLength('concat((x == null ? [] : [1]), ([]))'.replace('x == null', 'null == null')), 0);
  assert.equal(listLength('concat([1], [2, 3])'), 3);
  assert.equal(listLength('try(tomap([]), { for k, v in try(tolist([]), []) : k => v })'), 0);
  assert.equal(listLength('flatten([for k, v in {} : [k]])'), 0);
  assert.equal(evalNum('length(concat([], [])) + 1'), 1);

  const g = buildGraph([{ path: 'b.tf', content: `
    variable "enabled" { default = true }
    variable "plans" {
      type = map(object({ name = optional(string) }))
      default = {}
    }
    variable "rule_name" { default = null }
    variable "rules" {
      type = list(object({ name = string }))
      default = []
    }
    variable "audit_framework" {
      type = object({ create = bool, name = optional(string) })
      default = {
        create = false
        name   = null
      }
    }
    locals {
      rule  = var.rule_name == null ? [] : [{ name = var.rule_name }]
      rules = concat(local.rule, var.rules)
      legacy = var.enabled && length(var.plans) == 0 && length(local.rules) > 0
    }
    resource "aws_backup_plan" "legacy" { count = local.legacy ? 1 : 0 }
    resource "aws_backup_framework" "fw" { count = var.audit_framework.create ? 1 : 0 }
    resource "aws_backup_vault" "v" { count = var.enabled ? 1 : 0 }` }]);
  assert.deepEqual(g.nodes.map((n) => n.id), ['aws_backup_vault.v']);
  assert.deepEqual(g.inactive.sort(), ['aws_backup_framework.fw', 'aws_backup_plan.legacy']);
  assert.equal(g.nodes[0].category, 'Data');                                        // backup resources sit with storage
});

test('checks: helper providers (random, null) are not "other clouds"; unsure counts are listed', async () => {
  const { validateProject } = await import('../lib/validate.js');
  const files = [{ path: 'a.tf', content: 'resource "aws_vpc" "v" {}\nresource "random_string" "r" {}\nresource "null_resource" "n" {}\nresource "aws_instance" "i" {\n  count = length(var.unknown)\n}' }];
  const tree = { dir: '', files, children: {} };
  const graph = buildGraph(tree);
  const checks = validateProject({ files, root: '', tree, graph, source: 'github' });
  assert.ok(!checks.some((c) => /other providers/.test(c.text)));
  assert.ok(checks.some((c) => c.level === 'info' && /could not be worked out \(instance i\)/.test(c.text)), checks.map((c) => c.text).join(' | '));
});

test('architecture view nests resources in their subnet and VPC and draws traffic arrows', async () => {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  if (!globalThis.dagre) vm.runInThisContext(fs.readFileSync(new URL('../public/vendor/dagre.min.js', import.meta.url), 'utf8'));
  const { renderArchitecture } = await import('../public/diagram.js');
  const g = buildGraph([{ path: 'a.tf', content: `
    resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
    resource "aws_subnet" "public_a" {
      vpc_id = aws_vpc.main.id
    }
    resource "aws_subnet" "empty" {
      vpc_id = aws_vpc.main.id
    }
    resource "aws_lb" "alb" { subnets = [aws_subnet.public_a.id] }
    resource "aws_lb_target_group" "tg" { vpc_id = aws_vpc.main.id }
    resource "aws_lb_listener" "l" {
      load_balancer_arn = aws_lb.alb.arn
      default_action { target_group_arn = aws_lb_target_group.tg.arn }
    }
    resource "aws_instance" "app" {
      count = 2
      subnet_id = aws_subnet.public_a.id
    }
    resource "aws_lb_target_group_attachment" "a" {
      target_group_arn = aws_lb_target_group.tg.arn
      target_id = aws_instance.app[0].id
    }` }]);
  const svg = renderArchitecture(g);
  assert.ok(!svg.includes('NaN'));
  assert.match(svg, /AWS Cloud/);
  assert.match(svg, /VPC · main/);
  assert.match(svg, /Public subnet · public_a/);
  assert.match(svg, /×2/);
  assert.equal((svg.match(/class="flow"/g) ?? []).length, 2);        // Internet -> load balancer -> instances
  assert.ok(!renderArchitecture(g, { animate: false }).includes('class="arch"'));
});

test('"All folders" draws every folder as a module box', async () => {
  const { handleApi } = await import('../lib/api.js');
  const files = [
    { path: 'envs/dev/main.tf', content: 'resource "aws_vpc" "v" {}' },
    { path: 'envs/prod/main.tf', content: 'resource "aws_s3_bucket" "b" {}' },
    { path: 'modules/net/main.tf', content: 'resource "aws_subnet" "s" {}' },
  ];
  const res = await handleApi(new Request('http://x/api/diagram', { method: 'POST', body: JSON.stringify({ files, root: '*' }) }));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(data.graph.nodes.filter((n) => n.kind === 'module').map((n) => n.name).sort(), ['envs_dev', 'envs_prod', 'modules_net']);
  assert.ok(data.graph.nodes.some((n) => n.id === 'module.envs_dev.aws_vpc.v' && n.parent === 'module.envs_dev'));
  assert.ok(data.sources.every((f) => !f.path.startsWith('(')));
  assert.match(data.checks[0].text, /3 folders at once/);
});

test('terraform.tfvars next to the drawn folder overrides variable defaults', async () => {
  const { handleApi } = await import('../lib/api.js');
  const files = [
    { path: 'main.tf', content: 'variable "on" { default = false }\nvariable "n" { default = 1 }\nresource "aws_instance" "a" {\n  count = var.on ? var.n : 0\n}' },
    { path: 'terraform.tfvars', content: 'on = true\nn  = 3\n' },
  ];
  const post = (body) => handleApi(new Request('http://x/api/diagram', { method: 'POST', body: JSON.stringify(body) })).then((r) => r.json());
  const withVars = await post({ files });
  assert.equal(withVars.graph.nodes.find((n) => n.id === 'aws_instance.a')?.instances, 3);
  assert.equal(withVars.tfvarsApplied, true);
  const without = await post({ files: files.slice(0, 1) });
  assert.equal(without.graph.nodes.length, 0);
});

test('architecture arrows say which security-group rule allows them', async () => {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  if (!globalThis.dagre) vm.runInThisContext(fs.readFileSync(new URL('../public/vendor/dagre.min.js', import.meta.url), 'utf8'));
  const { renderArchitecture } = await import('../public/diagram.js');
  const g = buildGraph([{ path: 'a.tf', content: `
    resource "aws_vpc" "v" { cidr_block = "10.0.0.0/16" }
    resource "aws_security_group" "alb" {
      vpc_id = aws_vpc.v.id
      ingress {
        from_port = 443
        to_port = 443
        protocol = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
      }
    }
    resource "aws_security_group" "app" {
      vpc_id = aws_vpc.v.id
      ingress {
        from_port = 8080
        to_port = 8080
        protocol = "tcp"
        security_groups = [aws_security_group.alb.id]
      }
    }
    resource "aws_security_group" "db" { vpc_id = aws_vpc.v.id }
    resource "aws_lb" "alb" { security_groups = [aws_security_group.alb.id] }
    resource "aws_instance" "app" { vpc_security_group_ids = [aws_security_group.app.id] }
    resource "aws_db_instance" "db" {
      vpc_security_group_ids = [aws_security_group.db.id]
      tags = { who = aws_instance.app.id }
    }` }]);
  const svg = renderArchitecture(g);
  assert.match(svg, /TCP 443/);                       // internet -> load balancer: open
  assert.match(svg, /TCP 8080 from Security group alb/);   // load balancer -> instance
  assert.match(svg, /✗ no rule/);                      // instance -> database: db group allows nothing
});

test('registry modules: sources are classified, versions picked, and the module is opened', async () => {
  const fs = await import('node:fs');
  const { classifySource, pickVersion } = await import('../lib/registry.js');
  assert.deepEqual(classifySource('terraform-aws-modules/vpc/aws//modules/x'), { type: 'registry', ns: 'terraform-aws-modules', name: 'vpc', provider: 'aws', subdir: 'modules/x' });
  assert.deepEqual(classifySource('git::https://github.com/o/r.git//sub?ref=v1.2'), { type: 'github', owner: 'o', repo: 'r', subdir: 'sub', ref: 'v1.2' });
  assert.equal(classifySource('./local'), null);
  assert.equal(classifySource('hashicorp/consul/aws').type, 'registry');
  const v = ['4.0.2', '5.0.0', '5.1.2', '5.8.1', '6.0.0'];
  assert.equal(pickVersion(v, '~> 5.0'), '5.8.1');
  assert.equal(pickVersion(v, '~> 5.1.0'), '5.1.2');
  assert.equal(pickVersion(v, '>= 4.0, < 5.0'), '4.0.2');
  assert.equal(pickVersion(v, '5.0.0'), '5.0.0');
  assert.equal(pickVersion(v, undefined), '6.0.0');

  const zip = fs.readFileSync(new URL('./fixtures/module.zip', import.meta.url));
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    url = String(url); asked.push(url);
    if (url.includes('/acme/missing/')) return new Response('no', { status: 404 });
    if (url.endsWith('/versions')) return new Response(JSON.stringify({ modules: [{ versions: [{ version: '1.0.0' }, { version: '1.2.0' }] }] }));
    if (url.endsWith('/1.2.0/download')) return new Response(null, { status: 204, headers: { 'x-terraform-get': 'git::https://github.com/acme/terraform-aws-net?ref=v1.2.0' } });
    if (url.includes('/zipball/')) return new Response(zip, { headers: { 'content-length': String(zip.length) } });
    return new Response('no', { status: 404 });
  };
  try {
    const { handleApi } = await import('../lib/api.js');
    const code = 'module "net" {\n  source  = "acme/net/aws"\n  version = "~> 1.0"\n  cidr    = "10.9.0.0/16"\n}\nresource "aws_instance" "app" {\n  subnet_id = module.net.subnet_id\n}\nmodule "gone" {\n  source = "acme/missing/aws"\n}';
    const res = await handleApi(new Request('http://x/api/diagram', { method: 'POST', body: JSON.stringify({ code }) }));
    const data = await res.json();
    assert.equal(res.status, 200);
    const ids = data.graph.nodes.map((n) => n.id);
    assert.ok(ids.includes('module.net.aws_vpc.this') && ids.includes('module.net.aws_subnet.a'), ids.join(', '));
    assert.ok(!ids.some((i) => /noise/.test(i)));                                     // examples/ is skipped
    assert.deepEqual(data.graph.nodes.find((n) => n.id === 'module.net.aws_vpc.this').cidrs, ['10.9.0.0/16']);   // the caller's value wins
    assert.ok(asked.some((u) => u.includes('/zipball/v1.2.0')));
    assert.ok(data.checks.some((c) => /Opened 1 module from the Terraform registry/.test(c.text)), JSON.stringify(data.checks));
    assert.ok(data.checks.some((c) => /could not be opened \(acme\/missing\/aws\)/.test(c.text)));
  } finally { globalThis.fetch = real; }
});
