import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeRepo, repoContext } from '../lib/repomap.js';
import { handleRepo } from '../lib/repoapi.js';
import { handleMcp } from '../lib/mcp.js';
import { repoMermaid, parseAiReply, buildAiPrompt, mdToHtml, validateDiagram } from '../public/explain.js';

const zip = readFileSync(new URL('./fixtures/webshop.zip', import.meta.url));
const withFetch = async (fn) => {
  const real = globalThis.fetch; const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); return String(url).startsWith('https://codeload.github.com/') ? new Response(zip, { headers: { 'content-length': String(zip.length) } }) : new Response('no', { status: 404 }); };
  try { return await fn(asked); } finally { globalThis.fetch = real; }
};

test('repo map: monorepo components, technologies, compose, CI and imports', async () => {
  const r = await withFetch(() => handleRepo(new Request('http://x/api/repo?repo=' + encodeURIComponent('https://github.com/acme/webshop')))).then((x) => x.json());
  const m = r.model;
  assert.equal(r.name, 'acme/webshop');
  assert.deepEqual(m.components.map((c) => `${c.kind}:${c.name}`).sort(), ['backend:api', 'frontend:web', 'library:shared']);
  assert.ok(m.techs.some((t) => t.label === 'React') && m.techs.some((t) => t.label === 'PostgreSQL') && m.techs.some((t) => t.label === 'Express'));
  assert.deepEqual(m.imports.map((e) => `${e.from}->${e.to}`).sort(), ['api->shared', 'web->shared']);
  const labels = m.diagram.nodes.map((n) => n.label);
  for (const want of ['Users (browser / app)', 'PostgreSQL', 'Redis', 'Stripe', 'Container image']) assert.ok(labels.includes(want), `${want} in ${labels.join(', ')}`);
  assert.ok(labels.some((l) => l.startsWith('CI/CD')));
  const byId = new Map(m.diagram.nodes.map((n) => [n.id, n.label]));
  const e = (a, b) => m.diagram.edges.find((x) => byId.get(x.from) === a && byId.get(x.to) === b);
  assert.ok(e('api', 'PostgreSQL') && !e('api', 'PostgreSQL').inferred);            // compose depends_on is read, not guessed
  assert.ok(e('web', 'api')?.inferred);                                             // the browser -> API link is a guess and says so
  assert.ok(!m.tree?.some?.((t) => /node_modules|logo\.png/.test(t.path)));
  assert.match(m.explanation.join(' '), /React storefront/);
  assert.deepEqual(m.readme.run[0].lines, ['npm install', 'npm run dev']);
  assert.equal(m.readme.title, 'Shop');
  assert.ok(!m.readme.intro.includes('[!['));                                       // badges are skipped
  assert.match(r.mermaid, /^flowchart LR/);
  assert.match(r.context, /## Components found by the tool/);
  assert.ok(r.context.length < 60500);
});

test('repo map: Python, Java and Go imports resolve to components', () => {
  const mk = (o) => Object.entries(o).map(([path, content]) => ({ path, content }));
  const run = (o, name) => { const f = mk(o); return analyzeRepo({ name, tree: f.map((x) => ({ path: x.path, size: x.content.length })), files: f }); };
  const py = run({ 'requirements.txt': 'django\npsycopg2-binary', 'blog/models.py': '', 'blog/views.py': 'from .models import P\nfrom accounts.utils import u\n', 'accounts/utils.py': '' }, 'blog');
  assert.ok(py.imports.some((e) => e.from === 'blog' && e.to === 'accounts'));
  assert.ok(py.techs.some((t) => t.label === 'Django') && py.techs.some((t) => t.label === 'PostgreSQL'));
  const java = run({ 'pom.xml': '<project><artifactId>o</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>', 'src/main/java/com/acme/App.java': 'package com.acme;\nimport com.acme.service.S;\n', 'src/main/java/com/acme/service/S.java': 'package com.acme.service;\nimport com.acme.repo.R;\n', 'src/main/java/com/acme/repo/R.java': 'package com.acme.repo;\n' }, 'o');
  assert.deepEqual(java.components.map((c) => c.name).sort(), ['acme (core)', 'repo', 'service']);
  assert.ok(java.imports.some((e) => e.from === 'service' && e.to === 'repo'));
  const go = run({ 'go.mod': 'module example.com/app\n\ngo 1.22\n', 'cmd/app/main.go': 'package main\nimport (\n\t"fmt"\n\t"example.com/app/internal/store"\n)\n', 'internal/store/store.go': 'package store\n', 'internal/api/api.go': 'package api\nimport "example.com/app/internal/store"\n' }, 'app');
  assert.ok(go.imports.some((e) => e.to === 'store') || go.imports.some((e) => e.to?.includes('store')));
});

test('repo explain: POST with files, errors, and the AI helpers', async () => {
  const post = (body) => handleRepo(new Request('http://x/api/repo', { method: 'POST', body: JSON.stringify(body) })).then(async (r) => ({ status: r.status, json: await r.json() }));
  const ok = await post({ name: 'mine', files: [{ path: 'README.md', content: '# Mine\n\nA tiny tool that does something useful for testing purposes.' }, { path: 'a.py', content: 'print(1)' }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.model.languages[0].name, 'Python');
  assert.equal((await post({ files: [] })).status, 400);
  assert.equal((await handleRepo(new Request('http://x/api/repo'))).status, 400);
  // prompt + reply parsing
  const { system, user } = buildAiPrompt('CONTEXT HERE');
  assert.match(system, /honest/); assert.match(user, /CONTEXT HERE/); assert.match(user, /<diagram>/);
  const reply = parseAiReply('## What it is\nA **shop**.\n\n<diagram>```json\n{"nodes":[{"id":"a","label":"A","group":"backend"},{"id":"b","label":"B","group":"weird"}],"edges":[{"from":"a","to":"b","label":"x","inferred":true},{"from":"a","to":"zz"}]}\n```</diagram>');
  assert.equal(reply.diagram.nodes.length, 2);
  assert.equal(reply.diagram.nodes[1].group, 'library');
  assert.equal(reply.diagram.edges.length, 1);
  assert.equal(parseAiReply('just text').diagram, null);
  assert.equal(parseAiReply('<diagram>{broken</diagram>').diagram, null);
  assert.equal(validateDiagram({ nodes: [] }), null);
  assert.match(mdToHtml('## Hi\n- **a** and `b`\n- c\n\n<script>x</script>'), /<h3>Hi<\/h3>\s*<ul>\s*<li><b>a<\/b> and <code>b<\/code><\/li>/);
  assert.ok(!mdToHtml('<script>x</script>').includes('<script>'));
  assert.match(repoMermaid(ok.json.model.diagram), /^flowchart LR/);
});

test('MCP: analyze_repo and get_repo_file', async () => {
  const call = (name, args) => withFetch(() => handleMcp(new Request('https://t.example/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }))).then((r) => r.json());
  const a = await call('analyze_repo', { repo_url: 'https://github.com/acme/webshop' });
  const text = a.result.content[0].text;
  assert.match(text, /# Overview of acme\/webshop/);
  assert.match(text, /```mermaid\nflowchart LR/);
  assert.match(text, /## Components found by the tool/);
  assert.match(text, /React storefront/);
  const f = await call('get_repo_file', { repo_url: 'https://github.com/acme/webshop', path: 'apps/api/src/db.js' });
  assert.match(f.result.content[0].text, /require\('pg'\)/);
  const bad = await call('get_repo_file', { repo_url: 'https://github.com/acme/webshop', path: 'nope.js' });
  assert.equal(bad.result.isError, true);
});

test('repo map: README HTML is stripped, and a repository with no code is described as content', () => {
  const mk = (o) => Object.entries(o).map(([path, content]) => ({ path, content }));
  const f = mk({
    'readme.md': '<div align="center"><h1>Awesome</h1></div>\n\n# Awesome\n\nJust type <a href="https://awesome.re"><code>awesome.re</code></a> to go here. Check out my <a href="https://x.com/apps">apps</a> &amp; more.\n\n## Contents\n\n- x\n\n## Platforms\n\nx\n',
    'contributing.md': '# Contributing\n', 'license': 'CC0', 'code-of-conduct.md': 'x', 'docs/guide.md': '# Guide\n', 'docs/faq.md': '# FAQ\n',
    '.github/workflows/lint.yml': 'name: lint\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n',
  });
  const m = analyzeRepo({ name: 'awesome', tree: f.map((x) => ({ path: x.path, size: x.content.length })), files: f });
  assert.equal(m.description, 'Just type awesome.re to go here. Check out my apps & more.');
  assert.ok(!m.explanation.join(' ').includes('<a'));
  assert.equal(m.contentRepo, true);
  assert.equal(m.languages[0].name, 'Markdown');
  assert.ok(m.components.every((c) => c.kind === 'docs'));
  assert.ok(m.diagram.nodes.some((n) => n.group === 'content'));
  assert.match(m.explanation.join(' '), /holds no source code/);
  assert.match(m.explanation.join(' '), /main sections: Contents, Platforms/);
});

test('repo file endpoint rejects traversal and returns text', async () => {
  const { handleRepoFile } = await import('../lib/repoapi.js');
  const bad = await handleRepoFile(new Request('http://x/api/repo/file?repo=https://github.com/a/b&path=../etc/passwd'));
  assert.equal(bad.status, 400);
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).includes('raw.githubusercontent.com/a/b/') ? new Response('hello\nworld') : new Response('', { status: 404 }));
  try {
    const ok = await handleRepoFile(new Request('http://x/api/repo/file?repo=https://github.com/a/b&path=src/a.js'));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).content, 'hello\nworld');
  } finally { globalThis.fetch = orig; }
});

test('catalog README becomes topics, links and a diagram', () => {
  const readme = '# Build your own x\n\nGuides.\n\n## Tutorials\n\n### Build your own `Database`\n\n* [Python: Write a db](https://example.com/a)\n* [Go: Another db](https://example.org/b)\n\n### Build your own `Shell`\n\n* [C: A shell](https://example.com/c)\n\n### Build your own `Git`\n\n* [Ruby: git](https://example.com/d)\n\n## Contribute\n\n* [x](https://x.dev)\n';
  const m = analyzeRepo({ name: 'o/x', tree: [{ path: 'README.md', size: 300 }, { path: 'a.md', size: 10 }, { path: 'b.md', size: 10 }], files: [{ path: 'README.md', content: readme }, { path: 'a.md', content: 'a' }, { path: 'b.md', content: 'b' }] });
  assert.equal(m.contentRepo, true);
  assert.deepEqual(m.catalog.sections.map((s) => s.title), ['Database', 'Shell', 'Git']);
  assert.equal(m.catalog.links, 4);
  assert.ok(m.diagram.nodes.some((n) => n.label === 'Database'));
  assert.match(m.explanation.join(' '), /catalog: 3 topics/);
});
