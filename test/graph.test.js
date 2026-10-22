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
