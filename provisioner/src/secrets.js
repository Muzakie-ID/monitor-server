import { mkdir, readFile, writeFile, chmod, mkdtemp, rm, access } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import bcrypt from 'bcryptjs';
import ssh2 from 'ssh2';
import { config } from './config.js';

const run = promisify(execFile);
const S = (...p) => join(config.secretsDir, ...p);
const exists = (p) => access(p).then(() => true, () => false);

// File rahasia di volume /secrets. Yang perlu dibaca Prometheus (CA & kata sandi exporter)
// dibuat 0644; kunci privat 0600 dan hanya dibaca provisioner (dan nginx gateway sebagai root).
async function put(path, content, mode) {
  await writeFile(path, content, { mode });
  await chmod(path, mode); // writeFile tidak mengubah mode file yang sudah ada
}

async function ensureSshKey() {
  await mkdir(S('ssh'), { recursive: true, mode: 0o700 });
  if (await exists(S('ssh', 'id_ed25519'))) return;
  const keys = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'pantau-server' });
  await put(S('ssh', 'id_ed25519'), keys.private, 0o600);
  await put(S('ssh', 'id_ed25519.pub'), `${keys.public.trim()}\n`, 0o644);
}

async function ensureCa() {
  await mkdir(S('ca'), { recursive: true, mode: 0o755 });
  if (await exists(S('ca', 'ca.crt'))) return;
  await run('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', S('ca', 'ca.key'), '-out', S('ca', 'ca.crt'), '-days', '3650',
    '-subj', '/CN=Pantau Server CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign'
  ]);
  await chmod(S('ca', 'ca.key'), 0o600);
  await chmod(S('ca', 'ca.crt'), 0o644);
}

// Sertifikat server ditandatangani CA pemantau. `host` boleh IP atau nama DNS.
export async function issueCert(host) {
  const dir = await mkdtemp(join(tmpdir(), 'cert-'));
  try {
    const san = /^[\d.]+$/.test(host) || host.includes(':') ? `IP:${host}` : `DNS:${host}`;
    await writeFile(join(dir, 'ext.cnf'),
      `subjectAltName=${san}\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=CA:FALSE\n`);
    await run('openssl', ['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.csr'), '-subj', `/CN=${host}`]);
    await run('openssl', ['x509', '-req', '-in', join(dir, 'tls.csr'),
      '-CA', S('ca', 'ca.crt'), '-CAkey', S('ca', 'ca.key'), '-CAcreateserial', '-CAserial', join(dir, 'ca.srl'),
      '-days', '825', '-sha256', '-extfile', join(dir, 'ext.cnf'), '-out', join(dir, 'tls.crt')]);
    return {
      cert: await readFile(join(dir, 'tls.crt'), 'utf8'),
      key: await readFile(join(dir, 'tls.key'), 'utf8')
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const newPassword = () => randomBytes(24).toString('base64url');

// Menjalankan perintah dengan data lewat stdin (supaya kata sandi tidak muncul di daftar proses)
function runWithInput(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `${cmd} keluar dengan kode ${code}`))));
    child.stdin.end(input);
  });
}

// Kredensial basic auth node_exporter: satu untuk semua server, dipakai Prometheus.
async function ensureExporterAuth() {
  await mkdir(S('exporter'), { recursive: true, mode: 0o755 });
  if (await exists(S('exporter', 'password'))) return;
  const pw = newPassword();
  await put(S('exporter', 'password'), pw, 0o644);
  await put(S('exporter', 'password.bcrypt'), bcrypt.hashSync(pw, 10), 0o600);
}

// Gateway Loki: TLS + basic auth supaya agen log di server target bisa mengirim log dengan aman.
async function ensureGateway() {
  await mkdir(S('gateway'), { recursive: true, mode: 0o755 });
  if (!(await exists(S('gateway', 'password')))) {
    const pw = newPassword();
    await put(S('gateway', 'password'), pw, 0o600);
    const hash = await runWithInput('openssl', ['passwd', '-apr1', '-stdin'], `${pw}\n`);
    await put(S('gateway', 'htpasswd'), `pantau:${hash.trim()}\n`, 0o644);
  }
  // Tanpa MONITOR_PUBLIC_HOST, gateway tetap butuh sertifikat agar nginx bisa jalan
  const host = config.publicHost || 'localhost';
  const current = await readFile(S('gateway', 'host'), 'utf8').catch(() => '');
  if (current === host && (await exists(S('gateway', 'tls.crt')))) return;
  const { cert, key } = await issueCert(host);
  await put(S('gateway', 'tls.crt'), cert, 0o644);
  await put(S('gateway', 'tls.key'), key, 0o600);
  await put(S('gateway', 'host'), host, 0o644);
}

export async function initSecrets() {
  await ensureSshKey();
  await ensureCa();
  await ensureExporterAuth();
  await ensureGateway();
  await put(S('ready'), new Date().toISOString(), 0o644);
}

export const secrets = {
  sshPrivateKey: () => readFile(S('ssh', 'id_ed25519'), 'utf8'),
  sshPublicKey: async () => (await readFile(S('ssh', 'id_ed25519.pub'), 'utf8')).trim(),
  caCert: () => readFile(S('ca', 'ca.crt'), 'utf8'),
  exporterPassword: async () => (await readFile(S('exporter', 'password'), 'utf8')).trim(),
  exporterPasswordHash: async () => (await readFile(S('exporter', 'password.bcrypt'), 'utf8')).trim(),
  lokiPassword: async () => (await readFile(S('gateway', 'password'), 'utf8')).trim()
};
