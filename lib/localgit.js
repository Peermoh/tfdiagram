// LOCAL USE ONLY (server.js): read a repository with the git installed on this computer, so whatever it is already signed in
// to (Git Credential Manager, SSH keys, an SSO login) just works. Nothing here is available in the Cloudflare Worker.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wantedPath, textPath } from '../public/unzip.js';

const run = (cmd, args, opts) => new Promise((resolve, reject) => execFile(cmd, args, opts, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout))));

// https://, ssh:// or user@host:path only; no options, no whitespace
export function safeGitUrl(url, { allowLocal = false } = {}) {
  const u = String(url ?? '').trim();
  if (!u || u.startsWith('-') || /[\s\u0000-\u001f]/.test(u)) return null;
  if (/^https:\/\/[^/]+\/./i.test(u) || /^ssh:\/\/[^/]+\/./i.test(u) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(u)) return u;
  return allowLocal && /^[/\\]|^[A-Za-z]:[\\/]/.test(u) ? u : null;
}

const hide = (s) => String(s).replace(/(https?:\/\/)[^@/\s]+@/g, '$1');      // never echo credentials in an error

export async function hasGit() {
  try { await run('git', ['--version'], { timeout: 5000 }); return true; } catch { return false; }
}

async function walk(dir, rel, out, accept) {
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    if (e.name === '.git' || e.name === '.terraform' || e.name === 'node_modules') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(dir, r, out, accept);
    else if (e.isFile() && accept(r)) out.push(r);
  }
}

export async function readRepoWithGit(url, { branch = '', timeoutMs = 180_000, allowLocal = false, all = false } = {}) {
  const safe = safeGitUrl(url, { allowLocal });
  if (!safe) throw new Error('Give an https:// or ssh:// Git URL (for Azure DevOps: https://dev.azure.com/org/project/_git/repo).');
  if (branch && !/^[\w./-]+$/.test(branch)) throw new Error('That branch name has characters I will not pass to git.');
  const tmp = await mkdtemp(join(tmpdir(), 'tfdiagram-'));
  const target = join(tmp, 'repo');
  try {
    try {
      // terminal prompts are off (they would hang a server), but Git Credential Manager can still open its own sign-in window
      await run('git', ['clone', '--depth', '1', '--single-branch', '--no-tags', ...(branch ? ['--branch', branch] : []), '--', safe, target], { timeout: timeoutMs, maxBuffer: 20_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('git is not installed on this computer. Install git, or use a token (Azure DevOps) or upload a zip instead.');
      if (e.killed) throw new Error('git took too long (it may be waiting for a sign-in window). Sign in once with `git ls-remote <url>` in a terminal, then try again.');
      const msg = hide(e.stderr || e.message).trim().split('\n').slice(-3).join(' ');
      throw new Error(`git could not read that repository: ${msg}. If it asks for credentials, sign in once in a terminal (git ls-remote <url>) or give a token.`);
    }
    const paths = [];
    await walk(target, '', paths, all ? textPath : wantedPath);
    const files = []; const skipped = []; const tree = [];
    let total = 0;
    const maxFile = all ? 300_000 : 500_000; const maxTotal = all ? 14_000_000 : 25_000_000;
    for (const path of paths.slice(0, all ? 30000 : 5000)) {
      const abs = join(target, path);
      const size = (await stat(abs)).size;
      tree.push({ path, size });
      if (size > maxFile || (all && (files.length >= 4000 || total >= maxTotal))) { skipped.push(path); continue; }
      const content = await readFile(abs, 'utf8');
      if (all && content.includes('\u0000')) { skipped.push(path); continue; }
      total += content.length;
      if (!all && total > maxTotal) throw new Error('The Terraform files in this repository are too large (limit 25 MB of text).');
      files.push({ path, content });
    }
    return { files, skipped, tree };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
