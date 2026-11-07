import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, mkdtemp, rm, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { config } from './config.js';

const run = promisify(execFile);
const exists = (p) => access(p).then(() => true, () => false);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Binary diunduh sekali oleh server pemantau, dicek checksum SHA256-nya, lalu disimpan
// di cache. Server target tidak perlu akses internet dan tidak bisa menerima file palsu.
async function fetchArchive(name, arch, log) {
  const a = config.artifacts[name];
  const expected = a.sha256[arch];
  if (!expected) throw new Error(`Arsitektur ${arch} tidak didukung untuk ${name}`);
  await mkdir(config.cacheDir, { recursive: true });
  const file = join(config.cacheDir, `${name}-${a.version}-${arch}.archive`);

  if (await exists(file)) {
    const buf = await readFile(file);
    if (sha256(buf) === expected) return file;
    log?.('warn', `Cache ${name} rusak, diunduh ulang`);
  }

  const url = a.url(a.version, arch);
  log?.('info', `Mengunduh ${name} v${a.version} (${arch}) dari ${new URL(url).host}`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Gagal mengunduh ${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== expected) throw new Error(`Checksum ${name} tidak cocok (dapat ${got.slice(0, 12)}…). File ditolak.`);
  await writeFile(`${file}.tmp`, buf);
  await rename(`${file}.tmp`, file);
  log?.('info', `Checksum SHA256 ${name} cocok`);
  return file;
}

/** Mengembalikan isi binary (Buffer) yang sudah terverifikasi. */
export async function getBinary(name, arch, log) {
  const a = config.artifacts[name];
  const bin = join(config.cacheDir, `${name}-${a.version}-${arch}.bin`);
  if (await exists(bin)) return readFile(bin);

  const archive = await fetchArchive(name, arch, log);
  const dir = await mkdtemp(join(config.cacheDir, 'extract-'));
  try {
    let extracted;
    if (name === 'nodeExporter') {
      const inner = `node_exporter-${a.version}.linux-${arch}/node_exporter`;
      await run('tar', ['-xzf', archive, '-C', dir, inner]);
      extracted = join(dir, inner);
    } else {
      await run('unzip', ['-o', '-q', archive, '-d', dir]);
      extracted = join(dir, `alloy-linux-${arch}`);
    }
    await rename(extracted, bin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return readFile(bin);
}

export const versionOf = (name) => config.artifacts[name].version;
