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
  assert.ok(ids.includes('azurerm_linux_virtual_machine.vm'));
  assert.ok(!ids.includes('azurerm_subnet_network_security_group_association.a'));
  assert.ok(!ids.includes('azurerm_resource_group.rg'));
  assert.ok(g.edges.some((e) => e.from === 'azurerm_linux_virtual_machine.vm' && e.to === 'azurerm_network_interface.nic'));
  assert.ok(g.edges.some((e) => e.from === 'azurerm_network_interface.nic' && e.to === 'azurerm_subnet.app'));
  assert.equal(g.nodes.find((n) => n.id === 'azurerm_key_vault.kv').category, 'Security & IAM');
  assert.match(toMermaid(g), /virtual_machine<br\/><b>vm/);
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
