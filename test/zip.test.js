import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipTerraform, wantedPath } from '../public/unzip.js';
import { handleApi, pickRoot } from '../lib/api.js';

const zip = () => { const b = readFileSync(new URL('./fixtures/project.zip', import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

test('only real Terraform sources are picked from a zip', () => {
  assert.equal(wantedPath('a/b/main.tf'), 'a/b/main.tf');
  assert.equal(wantedPath('./main.tf'), 'main.tf');
  assert.equal(wantedPath('a\\b.tf'), 'a/b.tf');
  for (const bad of ['a/.terraform/x.tf', 'a/.git/x.tf', '__MACOSX/a/._x.tf', 'a/../../etc.tf', 'a/README.md', 'a/x.tf.bak', 'dir/']) assert.equal(wantedPath(bad), null, bad);
});

test('unzips stored and deflated entries, skips junk', async () => {
  const { files, skipped } = await unzipTerraform(zip());
  assert.deepEqual(files.map((f) => f.path).sort(), ['proj/main.tf', 'proj/modules/net/main.tf', 'proj/stored.tf']);
  assert.deepEqual(skipped, []);
  assert.match(files.find((f) => f.path === 'proj/stored.tf').content, /aws_sqs_queue/);
  assert.match(files.find((f) => f.path === 'proj/modules/net/main.tf').content, /variable "cidr"/);
});

test('rejects non-zips and honours the size limit', async () => {
  await assert.rejects(unzipTerraform(new TextEncoder().encode('not a zip at all, just text').buffer), /does not look like a zip/);
  const { files, skipped } = await unzipTerraform(zip(), { maxFile: 50 });
  assert.ok(skipped.length >= 1 && files.length < 3);
  await assert.rejects(unzipTerraform(zip(), { maxTotal: 10 }), /too large/);
});

test('api: an uploaded zip follows local modules from the chosen folder', async () => {
  const { files } = await unzipTerraform(zip());
  const call = (extra = {}) => handleApi(new Request('http://x/api/diagram?provider=aws', { method: 'POST', body: JSON.stringify({ files, ...extra }) }));
  const res = await call();
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.root, 'proj');                                   // shallowest folder with .tf files
  assert.deepEqual(data.dirs.map((d) => d.dir).sort(), ['proj', 'proj/modules/net']);
  const ids = data.graph.nodes.map((n) => n.id);
  assert.ok(ids.includes('module.net.aws_vpc.this') && ids.includes('aws_s3_bucket.b'));
  assert.deepEqual(data.graph.nodes.find((n) => n.id === 'module.net.aws_vpc.this').cidrs, ['10.5.0.0/16']);   // module argument wins

  const inner = await (await call({ root: 'proj/modules/net' })).json();
  assert.equal(inner.root, 'proj/modules/net');
  assert.deepEqual(inner.graph.nodes.map((n) => n.id).sort(), ['aws_subnet.a', 'aws_vpc.this']);

  assert.equal((await call({ files: [{ path: 'a.txt', content: 'x' }] })).status, 400);
  assert.equal(pickRoot([{ dir: 'a/b', count: 5 }, { dir: 'a', count: 1 }, { dir: 'a/c', count: 2 }]), 'a');
});

const post = async (files, extra = {}) => (await handleApi(new Request('http://x/api/diagram?provider=auto', { method: 'POST', body: JSON.stringify({ files, ...extra }) }))).json();
const lv = (data, level) => data.checks.filter((c) => c.level === level).map((c) => c.text);

test('checks: a complete project is followed and reported', async () => {
  const { files } = await unzipTerraform(zip());
  const data = await post(files);
  assert.deepEqual(lv(data, 'error'), []);
  assert.ok(lv(data, 'ok').some((t) => /Read 3 \.tf files in 2 folders/.test(t)));
  assert.ok(lv(data, 'ok').some((t) => /Followed 1 local module.*net → \.\/modules\/net/.test(t)));
  assert.ok(lv(data, 'info').some((t) => /no provider/i.test(t)), 'tells you it looks like a module');
});

test('checks: a module folder missing from the zip is called out', async () => {
  const data = await post([{ path: 'repo/examples/simple/main.tf', content: 'module "vpc" {\n  source = "../../"\n}\nmodule "far" {\n  source = "../../../../elsewhere"\n}' }]);
  const warns = lv(data, 'warn');
  assert.ok(warns.some((t) => /module\.vpc uses the folder "\.\.\/\.\.\/".*Zip the whole repository/.test(t)), warns.join('|'));
  assert.ok(warns.some((t) => /module\.far points to .*outside the zip/.test(t)));
});

test('checks: nothing to draw, other providers, mixed clouds, remote modules, unset variables', async () => {
  const onlyVars = await post([{ path: 'v.tf', content: 'variable "a" {}\noutput "o" { value = 1 }' }]);
  assert.ok(lv(onlyVars, 'error').some((t) => /no resource or module blocks/.test(t)));

  const gcp = await post([{ path: 'g.tf', content: 'resource "google_compute_instance" "x" {}\nresource "aws_vpc" "v" {}' }]);
  assert.ok(lv(gcp, 'warn').some((t) => /other providers \(google\)/.test(t)));

  const mixed = await post([{ path: 'm.tf', content: 'resource "aws_vpc" "v" {}\nresource "azurerm_virtual_network" "n" {}' }]);
  assert.ok(lv(mixed, 'warn').some((t) => /Both AWS and Azure/.test(t)));

  const mods = await post([{ path: 'r.tf', content: 'module "vpc" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "5.0.0"\n}\nresource "aws_instance" "i" {\n  instance_type = var.size\n  ami = var.ami\n}' }]);
  assert.ok(lv(mods, 'info').some((t) => /could not be opened \(terraform-aws-modules\/vpc\/aws\)/.test(t)));
  assert.ok(lv(mods, 'info').some((t) => /2 variables used here have no default.*ami, size/.test(t)));
});

test('checks: things in the zip that were not read are reported', async () => {
  const data = await post([{ path: 'a.tf', content: 'resource "aws_vpc" "v" {}' }], { ignored: { tfjson: 2, tfvars: 1, skipped: 3 } });
  assert.ok(lv(data, 'warn').some((t) => /2 \.tf\.json files in the zip are not read/.test(t)));
  assert.ok(lv(data, 'warn').some((t) => /3 files skipped/.test(t)));
  assert.ok(lv(data, 'info').some((t) => /1 \.tfvars file found but not applied/.test(t)));
  const levels = data.checks.map((c) => c.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => ['error', 'warn', 'info', 'ok'].indexOf(a) - ['error', 'warn', 'info', 'ok'].indexOf(b)), 'problems come first');
});

test('unzip counts .tf.json and .tfvars it does not read', async () => {
  // a zip built on the fly (stored entries) with the files we want to see counted
  const enc = new TextEncoder();
  const entries = [['a/main.tf', 'resource "aws_vpc" "v" {}'], ['a/x.tf.json', '{}'], ['a/prod.tfvars', 'x = 1'], ['a/.terraform/y.tf.json', '{}']];
  const parts = []; const central = []; let offset = 0;
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const [name, body] of entries) {
    const nb = enc.encode(name); const bb = enc.encode(body);
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(bb.length), ...u32(bb.length), ...u16(nb.length), ...u16(0), ...nb, ...bb];
    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(bb.length), ...u32(bb.length), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nb]);
    parts.push(local); offset += local.length;
  }
  const cd = central.flat();
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cd.length), ...u32(offset), ...u16(0)];
  const bytes = new Uint8Array([...parts.flat(), ...cd, ...eocd]);
  const { files, ignored } = await unzipTerraform(bytes.buffer);
  assert.deepEqual(files.map((f) => f.path), ['a/main.tf']);
  assert.deepEqual(ignored, { tfjson: 1, tfvars: 1 });   // the one inside .terraform/ is junk, not counted
});
