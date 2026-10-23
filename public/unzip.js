// Reads the Terraform files out of a .zip entirely in the browser (no library): parses the zip's central
// directory and inflates entries with the built-in DecompressionStream.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

// variable files Terraform loads on its own (other .tfvars need -var-file, so they are not applied)
export const VARS = /(^|\/)(terraform|[^/]+\.auto)\.tfvars$/i;
// every .tfvars file: the others are offered in a dropdown (Terraform needs -var-file for them)
export const ANYVARS = /\.tfvars$/i;

// virtual path inside the zip, or null if it is not a Terraform source file we should read
export function wantedPath(name) {
  const path = name.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
  if (!(/\.tf$/i.test(path) || ANYVARS.test(path)) || path.endsWith('/')) return null;
  const parts = path.split('/');
  if (parts.some((p) => p === '..' || p === '.terraform' || p === '.git' || p === '__MACOSX' || p.startsWith('._'))) return null;
  return path;
}

async function inflate(data, expected) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > Math.max(expected * 2, 4096)) { await reader.cancel(); throw new Error('A file in the zip expands to an unexpectedly large size'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Returns { files: [{ path, content }], skipped: [path], ignored: { tfjson, tfvars } } for the .tf files in a zip (an ArrayBuffer).
export async function unzipTerraform(buffer, { maxFiles = 3000, maxFile = 500_000, maxTotal = 8_000_000 } = {}) {
  const v = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 22 - 65535); i--) {
    if (v.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That does not look like a zip file');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('Zip64 archives are not supported: please re-zip with a standard zip tool');

  const text = new TextDecoder();
  const files = [];
  const skipped = [];
  const ignored = { tfjson: 0, tfvars: 0 }; // present in the zip but not read
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== CENTRAL) throw new Error('The zip file is damaged');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = text.decode(u8.subarray(p + 46, p + 46 + nlen));
    const path = wantedPath(name);
    p += 46 + nlen + xlen + clen;
    if (!path) {
      const other = name.replace(/\\/g, '/');
      if (!/(^|\/)(\.terraform|\.git|__MACOSX)\//.test(other) && !/\/\._/.test(`/${other}`)) { if (/\.tf\.json$/i.test(other)) ignored.tfjson++; else if (/\.tfvars(\.json)?$/i.test(other)) ignored.tfvars++; }
      continue;
    }
    if (flags & 1) throw new Error('This zip is password protected');
    if (usize > maxFile) { skipped.push(path); continue; }
    if (v.getUint32(local, true) !== LOCAL) throw new Error('The zip file is damaged');
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + csize);
    const bytes = method === 0 ? raw : method === 8 ? await inflate(raw, usize) : null;
    if (!bytes) { skipped.push(path); continue; }
    total += bytes.length;
    if (total > maxTotal) throw new Error('The Terraform files in this zip are too large (limit 8 MB of .tf text)');
    files.push({ path, content: text.decode(bytes) });
    if (files.length >= maxFiles) break;
  }
  return { files, skipped, ignored };
}
