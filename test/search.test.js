import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, parseSearchParams, searchRepos } from '../lib/search.js';
import { terraformFolders, fetchTerraformTree, parseRepoUrl } from '../lib/github.js';
import { handleSearch } from '../lib/api.js';

const withFetch = async (impl, fn) => { const real = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = real; } };
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('search query is built from the words and the options', () => {
  assert.equal(buildQuery({ q: ' vpc   module ' }), 'vpc module language:HCL');
  assert.equal(buildQuery({ q: 'landing zone', cloud: 'azure' }), 'landing zone azure language:HCL');
  assert.equal(buildQuery({ q: 'org:hashicorp', hcl: false }), 'org:hashicorp');
  // nothing typed: the popular Terraform repos, for the chosen cloud
  assert.equal(buildQuery({ q: '   ' }), 'terraform language:HCL');
  assert.equal(buildQuery({ q: '', cloud: 'aws' }), 'terraform aws language:HCL');
  assert.equal(buildQuery({ cloud: 'azure', hcl: false }), 'terraform azure');
  assert.equal(buildQuery({ q: 'aws vpc', cloud: 'aws' }), 'aws vpc language:HCL');     // the cloud word is not added twice
  assert.throws(() => buildQuery({ q: 'x'.repeat(201) }), /too long/);
  const p = parseSearchParams(new URLSearchParams('q=eks&sort=bogus&page=99&hcl=0&cloud=aws'));
  assert.deepEqual(p, { query: 'eks aws', sort: 'stars', page: 10 });
  assert.deepEqual(parseSearchParams(new URLSearchParams('q=&cloud=azure')), { query: 'terraform azure language:HCL', sort: 'stars', page: 1 });
});

test('search calls GitHub with the right URL and returns slim results', async () => {
  let seen;
  const data = await withFetch(async (url, init) => {
    seen = { url: new URL(url), auth: init.headers.authorization };
    return jsonRes({ total_count: 1200, items: [{ full_name: 'a/b', description: null, stargazers_count: 42, pushed_at: '2026-01-02T00:00:00Z', language: 'HCL', topics: ['aws', 'terraform', 'x', 'y', 'z', 'q', 'r'], html_url: 'https://github.com/a/b', archived: false, secret: 'dropped' }] });
  }, () => searchRepos({ query: 'vpc language:HCL', sort: 'stars', page: 2 }, 'tok'));
  assert.equal(seen.url.pathname, '/search/repositories');
  assert.equal(seen.url.searchParams.get('q'), 'vpc language:HCL');
  assert.equal(seen.url.searchParams.get('sort'), 'stars');
  assert.equal(seen.url.searchParams.get('page'), '2');
  assert.equal(seen.auth, 'Bearer tok');
  assert.deepEqual(data.items[0], { fullName: 'a/b', description: '', stars: 42, updated: '2026-01-02T00:00:00Z', language: 'HCL', topics: ['aws', 'terraform', 'x', 'y', 'z', 'q'], url: 'https://github.com/a/b', archived: false });
  assert.equal(data.total, 1200);
  assert.equal(data.hasMore, true);
  const best = await withFetch(async (url) => { seen = new URL(url); return jsonRes({ total_count: 3, items: [] }); }, () => searchRepos({ query: 'q', sort: 'best', page: 1 }));
  assert.equal(seen.searchParams.get('sort'), null);        // "best match" = no sort parameter
  assert.equal(best.hasMore, false);
});

test('search errors are explained', async () => {
  const fail = (status, body = {}) => withFetch(async () => jsonRes(body, status), () => searchRepos({ query: 'q', sort: 'stars', page: 1 }));
  await assert.rejects(fail(403), /rate limited.*paste a GitHub token/);
  await assert.rejects(fail(422, { message: 'Validation Failed' }), /could not understand.*Validation Failed/);
  await assert.rejects(fail(500), /failed \(500\)/);
  // through the endpoint: a too-long search is a 400, GitHub trouble a 502
  assert.equal((await handleSearch(new Request(`http://x/api/search?q=${'x'.repeat(201)}`))).status, 400);
  const res = await withFetch(async () => jsonRes({}, 403), () => handleSearch(new Request('http://x/api/search?q=vpc'), {}));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /rate limited/);
});

test('folders with Terraform are listed shallowest first', () => {
  const blobs = ['main.tf', 'infra/prod/main.tf', 'infra/prod/vars.tf', 'infra/dev/main.tf', 'modules/net/a.tf'].map((path) => ({ path }));
  const { dirs, best } = terraformFolders(blobs);
  assert.equal(best, '');
  assert.deepEqual(dirs.map((d) => d.dir), ['', 'infra/prod', 'infra/dev', 'modules/net']);   // same depth: more files first
  assert.equal(terraformFolders(blobs.slice(1)).best, 'infra/prod');                            // no top-level .tf: best deeper folder
  assert.deepEqual(terraformFolders(blobs, 'infra').dirs.map((d) => d.dir), ['infra/prod', 'infra/dev']);
  assert.equal(terraformFolders([], '').best, undefined);
});

test('a repo with no .tf at the top level draws its best folder and offers the others', async () => {
  const tree = { tree: [
    { type: 'blob', path: 'README.md', size: 10 },
    { type: 'blob', path: 'infra/main.tf', size: 50 },
    { type: 'blob', path: 'infra/net/main.tf', size: 50 },
  ], truncated: false };
  const raw = { 'infra/main.tf': 'resource "aws_vpc" "v" {}', 'infra/net/main.tf': 'resource "aws_subnet" "s" {}' };
  const impl = async (url) => {
    const u = String(url);
    if (u.includes('/git/trees/')) return jsonRes(tree);
    const hit = Object.keys(raw).find((k) => u.endsWith(`/HEAD/${k}`));
    return hit ? new Response(raw[hit]) : new Response('', { status: 404 });
  };
  const auto = await withFetch(impl, () => fetchTerraformTree('https://github.com/o/r'));
  assert.equal(auto.root, 'infra');
  assert.deepEqual(auto.dirs.map((d) => d.dir), ['infra', 'infra/net']);
  assert.equal(auto.tree.files[0].path, 'infra/main.tf');
  const picked = await withFetch(impl, () => fetchTerraformTree('https://github.com/o/r', undefined, 'infra/net'));
  assert.equal(picked.root, 'infra/net');
  const bogus = await withFetch(impl, () => fetchTerraformTree('https://github.com/o/r', undefined, 'nope'));
  assert.equal(bogus.root, 'infra');                         // an unknown folder falls back to the best one
  assert.equal(parseRepoUrl('https://github.com/o/r/tree/main/infra/net').path, 'infra/net');
  await assert.rejects(withFetch(async (url) => (String(url).includes('/git/trees/') ? jsonRes({ tree: [{ type: 'blob', path: 'a.md', size: 1 }] }) : new Response('')), () => fetchTerraformTree('https://github.com/o/r')), /No \.tf files found in that repository/);
});

test('search any repository: no Terraform words or HCL filter, optional language, popular repos when empty', () => {
  assert.equal(buildQuery({ q: '', any: true }), 'stars:>1000');
  assert.equal(buildQuery({ q: '  ', any: true, lang: 'Go' }), 'stars:>1000 language:Go');
  assert.equal(buildQuery({ q: 'react hooks', any: true, lang: 'TypeScript' }), 'react hooks language:TypeScript');
  assert.equal(buildQuery({ q: 'cli language:rust', any: true, lang: 'Go' }), 'cli language:rust');       // a typed qualifier wins
  assert.equal(buildQuery({ q: 'x', any: true, lang: 'Go; drop' }), 'x');                                    // odd language values are ignored
  assert.equal(buildQuery({ q: 'org:vercel', any: true, hcl: true, cloud: 'aws' }), 'org:vercel');            // Terraform options do not apply
  assert.deepEqual(parseSearchParams(new URLSearchParams('any=1&lang=C%2B%2B&sort=updated')), { query: 'stars:>1000 language:C++', sort: 'updated', page: 1 });
  assert.equal(parseSearchParams(new URLSearchParams('q=vpc')).query, 'vpc language:HCL');                    // the default is still Terraform
});
