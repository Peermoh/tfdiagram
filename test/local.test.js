import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { parseAdoUrl, fetchAdoZip } from '../lib/ado.js';
import { safeGitUrl, readRepoWithGit } from '../lib/localgit.js';

test('Azure DevOps URLs: org, project, repo, branch and folder are read from the address', () => {
  const a = parseAdoUrl('https://dev.azure.com/sc-ado/PDBQPR/_git/17527-t2apps-aws-falcon?path=%2Fdev%2Fstack.json&version=GBfeature%2Fadd-ebs');
  assert.deepEqual({ org: a.org, project: a.project, repo: a.repo, branch: a.branch, path: a.path }, { org: 'sc-ado', project: 'PDBQPR', repo: '17527-t2apps-aws-falcon', branch: 'feature/add-ebs', path: 'dev' });
  assert.equal(a.cloneUrl, 'https://dev.azure.com/sc-ado/PDBQPR/_git/17527-t2apps-aws-falcon');
  assert.equal(parseAdoUrl('https://someone@dev.azure.com/org/My%20Project/_git/repo').project, 'My Project');
  assert.equal(parseAdoUrl('https://org.visualstudio.com/DefaultCollection/proj/_git/repo').org, 'org');
  assert.equal(parseAdoUrl('https://github.com/o/r'), null);
  assert.equal(parseAdoUrl('not a url'), null);
});

test('git URLs: only https, ssh and user@host:path; never options or whitespace', () => {
  assert.ok(safeGitUrl('https://dev.azure.com/o/p/_git/r'));
  assert.ok(safeGitUrl('git@ssh.dev.azure.com:v3/o/p/r'));
  assert.ok(safeGitUrl('ssh://git@host/x/y.git'));
  for (const bad of ['--upload-pack=evil', '-c core.x=y', 'ext::sh -c id', 'file:///etc', '/home/me/repo', 'https://x/y z', 'https://x/y\nz', '']) assert.equal(safeGitUrl(bad), null, bad);
  assert.ok(safeGitUrl('/tmp/repo', { allowLocal: true }));
});

test('Azure DevOps API: token sent as Basic auth, helpful errors, zip unpacked', async () => {
  const zip = readFileSync(new URL('./fixtures/module.zip', import.meta.url));
  let seen;
  const ok = async (url, init) => { seen = { url: String(url), auth: init.headers.authorization }; return new Response(zip, { status: 200 }); };
  const r = await fetchAdoZip({ org: 'o', project: 'My Project', repo: 'r', branch: 'main' }, 'TOKEN', ok);
  assert.ok(r.files.some((f) => f.path.endsWith('main.tf')));
  assert.equal(seen.auth, `Basic ${Buffer.from(':TOKEN').toString('base64')}`);
  assert.match(seen.url, /dev\.azure\.com\/o\/My%20Project\/_apis\/git\/repositories\/r\/items\?/);
  assert.match(seen.url, /versionDescriptor\.version=main/);
  await assert.rejects(() => fetchAdoZip({ org: 'o', project: 'p', repo: 'r' }, 'x', async () => new Response('', { status: 401 })), /refused the token.*Code: Read/);
  await assert.rejects(() => fetchAdoZip({ org: 'o', project: 'p', repo: 'r' }, 'x', async () => new Response('', { status: 404 })), /cannot find p\/r/);
});

test('reading a repository with local git: tf, tfvars, stack.json and json; branches; junk skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tfd-src-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd: dir, stdio: 'pipe' });
  git('init');
  mkdirSync(join(dir, 'dev'), { recursive: true }); mkdirSync(join(dir, '.terraform'), { recursive: true });
  writeFileSync(join(dir, 'dev/main.tf'), 'resource "aws_vpc" "v" {}\n');
  writeFileSync(join(dir, 'dev/terraform.tfvars'), 'a = 1\n');
  writeFileSync(join(dir, 'dev/stack.json'), '{"stack":{}}');
  writeFileSync(join(dir, 'README.md'), 'x');
  writeFileSync(join(dir, '.terraform/x.tf'), 'junk');
  git('add', '-A'); git('commit', '-m', 'one');
  git('checkout', '-b', 'feature/x'); writeFileSync(join(dir, 'dev/extra.tf'), 'resource "aws_s3_bucket" "b" {}\n'); git('add', '-A'); git('commit', '-m', 'two'); git('checkout', 'main');
  const main = await readRepoWithGit(dir, { allowLocal: true });
  assert.deepEqual(main.files.map((f) => f.path).sort(), ['dev/main.tf', 'dev/stack.json', 'dev/terraform.tfvars']);
  const feat = await readRepoWithGit(dir, { allowLocal: true, branch: 'feature/x' });
  assert.ok(feat.files.some((f) => f.path === 'dev/extra.tf'));
  await assert.rejects(() => readRepoWithGit(dir), /https:\/\/ or ssh:\/\//);                     // a local path is refused unless the test allows it
  await assert.rejects(() => readRepoWithGit('https://localhost:1/none/_git/x', { timeoutMs: 20000 }), /git could not read that repository/);
});

test('the private-repository endpoints answer this computer only, and the public Worker has none', async () => {
  const { default: worker } = await import('../worker.js');
  assert.equal((await worker.fetch(new Request('https://tfdiagram.example/api/local'), {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://tfdiagram.example/api/local/fetch', { method: 'POST', body: '{}' }), {})).status, 404);
  process.env.PORT = '0';
  // start server.js on a free port
  const { spawn } = await import('node:child_process');
  const port = 41000 + Math.floor(Math.random() * 1000);
  const srv = spawn('node', ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) } });
  try {
    await new Promise((r) => setTimeout(r, 1200));
    const get = (path, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
      req.on('error', reject); if (body) req.write(body); req.end();
    });
    const ok = await get('/api/local');
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).local, true);
    assert.equal((await get('/api/local', { host: 'evil.example' })).status, 404);                 // DNS rebinding: wrong Host
    assert.equal((await get('/api/local', { origin: 'https://evil.example' })).status, 404);       // another site's page
    const bad = await get('/api/local/fetch', { 'content-type': 'application/json' }, 'POST', JSON.stringify({ url: '--upload-pack=x' }));
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.body).error, /https:\/\/ or ssh:\/\//);
    assert.equal((await get('/api/local/fetch', { host: 'evil.example' }, 'POST', '{}')).status, 404);
  } finally { srv.kill(); }
});
