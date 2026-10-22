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
