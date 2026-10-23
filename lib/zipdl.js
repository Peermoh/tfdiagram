// Downloads a GitHub repository as a zip. Public repositories come from codeload.github.com, which is not
// part of the (shared, easily exhausted) anonymous API rate limit; with a token the API's zipball is used.
const MAX_ZIP = 40_000_000;

export async function downloadZip(owner, repo, ref, token) {
  const r = encodeURIComponent(ref ?? 'HEAD');
  const url = token ? `https://api.github.com/repos/${owner}/${repo}/zipball/${r}` : `https://codeload.github.com/${owner}/${repo}/zip/${r}`;
  const res = await fetch(url, { headers: { 'user-agent': 'tfdiagram', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_ZIP) throw new Error('too large');
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ZIP) { await reader.cancel(); throw new Error('too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.buffer;
}
