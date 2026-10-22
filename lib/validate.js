// Checks that what was uploaded / fetched looks like the Terraform project we expect, and says what is missing or
// can't be followed. Each check: { level: 'ok' | 'info' | 'warn' | 'error', text }.
import { parseTerraform } from './parse.js';
import { resolveDir, allFiles } from './modules.js';

const dirOf = (path) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));
const isLocal = (src) => typeof src === 'string' && /^\.{1,2}(\/|$)/.test(src);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const list = (items, max = 4) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

// Every module call in the tree, with whether we could follow it.
function moduleCalls(tree, dir, trail = []) {
  const calls = [];
  for (const f of tree.files) {
    for (const b of parseTerraform(f.content)) {
      if (b.kind !== 'module' || !b.labels[0]) continue;
      const name = b.labels[0];
      const source = /source\s*=\s*"([^"]+)"/.exec(b.body)?.[1];
      const where = [...trail, name].join('.');
      if (!isLocal(source)) { calls.push({ name: where, source, status: 'remote' }); continue; }
      const child = tree.children?.[name];
      const target = resolveDir(dir, source);
      if (child && child.files.length) { calls.push({ name: where, source, status: 'expanded' }, ...moduleCalls(child, child.dir, [...trail, name])); }
      else calls.push({ name: where, source, status: target === null ? 'outside' : child ? 'missing' : 'skipped', target });
    }
  }
  return calls;
}

// input: { files, root, tree, graph, source: 'zip'|'github'|'paste', dirs, ignored: { tfjson, tfvars, skipped, truncated } }
export function validateProject({ files, root = '', tree, graph, source, dirs, ignored = {} }) {
  const checks = [];
  const add = (level, text) => checks.push({ level, text });
  const where = root ? `folder "${root}"` : 'the top-level folder';

  // --- what we got
  const folders = dirs?.length ?? new Set(files.map((f) => dirOf(f.path))).size;
  add('ok', `Read ${plural(files.length, '.tf file')}${folders > 1 ? ` in ${folders} folders` : ''}.`);
  const rootFiles = tree.files;
  if (!rootFiles.length) {
    add('error', `There are no .tf files in ${where}. Pick a folder that contains the Terraform files${dirs?.length ? ' (the folder list shows where they are)' : ''}.`);
    return checks;
  }
  if (source === 'zip') add('ok', `Drawing ${where} (${plural(rootFiles.length, 'file')}).`);

  // --- expected structure of a Terraform folder
  const text = rootFiles.map((f) => f.content).join('\n');
  const blocks = rootFiles.flatMap((f) => parseTerraform(f.content));
  const count = (k) => blocks.filter((b) => b.kind === k).length;
  const resources = count('resource');
  const modules = count('module');
  const variables = count('variable');
  const names = new Set(rootFiles.map((f) => f.path.split('/').pop().toLowerCase()));

  if (!resources && !modules) {
    add('error', `${where[0].toUpperCase()}${where.slice(1)} has no resource or module blocks, so there is nothing to draw. It may only hold variables or outputs: pick the folder that creates the infrastructure.`);
  } else {
    add('ok', `Found ${plural(resources, 'resource block')}${modules ? ` and ${plural(modules, 'module call')}` : ''}.`);
  }
  if (!names.has('main.tf') && (resources || modules)) add('info', 'There is no main.tf here. That is fine, but the usual layout puts resources in main.tf, inputs in variables.tf and results in outputs.tf.');
  const hasProvider = /\bprovider\s+"/.test(text) || /required_providers\s*\{/.test(text);
  if (!hasProvider && resources) add('info', 'No provider or required_providers block in this folder: it looks like a reusable module (or the provider is configured elsewhere). Resources are still drawn.');

  // --- providers
  const others = [...new Set([...text.matchAll(/^\s*resource\s+"([a-z0-9]+)_/gm)].map((m) => m[1]).filter((p) => p !== 'aws' && p !== 'azurerm'))];
  const clouds = [...new Set([...text.matchAll(/^\s*resource\s+"(aws|azurerm)_/gm)].map((m) => m[1]))];
  if (clouds.length > 1) add('warn', `Both AWS and Azure resources are in ${where}. Only ${graph.provider === 'aws' ? 'AWS' : 'Azure'} is drawn: change "Cloud" to see the other.`);
  if (others.length) add('warn', `${where[0].toUpperCase()}${where.slice(1)} also uses other providers (${list(others)}). Only AWS and Azure resources are drawn for now.`);
  if (resources && !graph.nodes.some((n) => n.kind === 'resource') && !others.length && !clouds.length) add('warn', 'No AWS or Azure resources were recognised in this folder.');

  // --- modules
  const calls = moduleCalls(tree, tree.dir ?? root);
  const missing = calls.filter((c) => c.status === 'missing' || c.status === 'outside');
  const remote = calls.filter((c) => c.status === 'remote');
  const expanded = calls.filter((c) => c.status === 'expanded');
  if (expanded.length) add('ok', `Followed ${plural(expanded.length, 'local module')} (${list(expanded.map((c) => `${c.name} → ${c.source}`))}).`);
  for (const c of missing) {
    add('warn', c.status === 'outside'
      ? `module.${c.name} points to "${c.source}", which is outside ${source === 'zip' ? 'the zip' : 'the folder that was loaded'}. ${source === 'zip' ? 'Zip the whole repository (not only this subfolder) to expand it; until then it is' : 'It is'} drawn as a single box.`
      : `module.${c.name} uses the folder "${c.source}", which has no .tf files in ${source === 'zip' ? 'the zip' : 'what was loaded'}. ${source === 'zip' ? 'Zip the whole repository (not only this subfolder) to expand it' : 'It is drawn as a single box'}.`);
  }
  if (calls.some((c) => c.status === 'skipped')) add('info', 'Some modules are nested too deep to follow (limit 4 levels) and are drawn as single boxes.');
  if (remote.length) add('info', `${plural(remote.length, 'module')} come from a registry or git (${list([...new Set(remote.map((c) => c.source))])}). Their contents are not downloaded, so each is drawn as a single box.`);

  // --- inputs
  if (graph.unresolvedVars?.length) {
    add('info', `${plural(graph.unresolvedVars.length, 'variable')} used here ${graph.unresolvedVars.length === 1 ? 'has' : 'have'} no default or value we can see (${list(graph.unresolvedVars)}). Values that depend on ${graph.unresolvedVars.length === 1 ? 'it' : 'them'} show "from variable …" or "(computed)".${ignored.tfvars ? '' : ' Values from .tfvars files or the command line are not known.'}`);
  } else if (variables) add('ok', 'Every variable that is used has a value (a default or a module argument).');
  if (variables && !names.has('variables.tf') && !blocks.some((b) => b.kind === 'variable')) add('info', 'No variable definitions found.');

  // --- things in the zip we did not read
  if (ignored.tfjson) add('warn', `${plural(ignored.tfjson, '.tf.json file')} in the zip ${ignored.tfjson === 1 ? 'is' : 'are'} not read (only .tf files are supported).`);
  if (ignored.tfvars) add('info', `${plural(ignored.tfvars, '.tfvars file')} found but not applied: values set there are not used.`);
  if (ignored.skipped) add('warn', `${plural(ignored.skipped, 'file')} skipped because ${ignored.skipped === 1 ? 'it is' : 'they are'} too large or use an unsupported zip format.`);
  if (ignored.truncated) add('warn', 'The project is large; only part of it was read (limit reached).');

  const order = { error: 0, warn: 1, info: 2, ok: 3 };
  return checks.sort((a, b) => order[a.level] - order[b.level]);
}
