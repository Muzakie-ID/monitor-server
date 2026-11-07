import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { initSecrets, secrets } from './secrets.js';
import { pool, query, loadJob, failStaleJobs } from './jobs.js';
import { runInstall, runUninstall, runVerify, testConnection } from './tasks.js';

// API internal: hanya dipanggil backend lewat jaringan Docker, dengan token bersama.
// Kata sandi SSH/sudo datang lewat API ini, hanya disimpan di memori selama job berjalan.

const active = new Map(); // jobId -> Job yang sedang berjalan
const queue = [];         // [{ jobId, run }]
let running = 0;

function pump() {
  while (running < config.maxConcurrentJobs && queue.length) {
    const { run } = queue.shift();
    running++;
    run().finally(() => { running--; pump(); });
  }
}

async function startJob(jobId, body) {
  const job = await loadJob(jobId);
  if (!job) return [404, { error: 'Job tidak ditemukan' }];
  if (job.status !== 'queued') return [409, { error: 'Job sudah berjalan atau selesai' }];
  if (!job.server) return [409, { error: 'Server untuk job ini sudah dihapus' }];

  const creds = sanitizeCreds(body.creds);
  if (job.kind !== 'verify' && !creds) return [400, { error: 'Kredensial SSH tidak lengkap' }];

  active.set(job.id, job);
  const run = async () => {
    try {
      if (job.kind === 'install') await runInstall(job, creds, { acceptedFingerprint: body.acceptedFingerprint });
      else if (job.kind === 'uninstall') await runUninstall(job, creds);
      else await runVerify(job);
    } finally {
      active.delete(job.id);
      if (creds) { creds.password = null; creds.sudoPassword = null; } // lepaskan dari memori
    }
  };
  queue.push({ jobId, run });
  if (running >= config.maxConcurrentJobs) await job.info('Menunggu giliran (job lain sedang berjalan)…');
  pump();
  return [202, { ok: true }];
}

function sanitizeCreds(c) {
  if (!c || !['password', 'key'].includes(c.authMethod)) return null;
  if (c.authMethod === 'password' && !c.password) return null;
  return {
    authMethod: c.authMethod,
    password: c.password || null,
    sudoPassword: c.sudoPassword || null,
    removeKey: !!c.removeKey
  };
}

const routes = {
  'GET /health': async () => [200, { ok: true, running, queued: queue.length }],
  'GET /public-key': async () => [200, { publicKey: await secrets.sshPublicKey() }],
  'POST /test': async (_m, body) => {
    const creds = sanitizeCreds(body.creds);
    if (!creds || !body.ip || !body.sshUser) return [400, { error: 'IP, user SSH, dan kredensial wajib diisi' }];
    return [200, await testConnection(body, creds)];
  },
  'POST /jobs/:id/start': async (m, body) => startJob(Number(m.id), body),
  'POST /jobs/:id/hostkey': async (m, body) => answer(Number(m.id), 'hostkey', body.accept === true),
  'POST /jobs/:id/approve': async (m, body) => answer(Number(m.id), 'approve', body.approve === true),
  'POST /jobs/:id/cancel': async (m) => {
    const job = active.get(Number(m.id));
    if (job) {
      job.cancel();
      return [200, { ok: true }];
    }
    // Belum berjalan (masih antre) atau provisioner sudah tidak memegangnya
    const i = queue.findIndex((q) => q.jobId === Number(m.id));
    if (i >= 0) queue.splice(i, 1);
    await query("UPDATE provision_jobs SET status='cancelled', error='Dibatalkan oleh admin.', updated_at=now() WHERE id=$1 AND status NOT IN ('succeeded','failed','cancelled')", [Number(m.id)]);
    return [200, { ok: true }];
  }
};

function answer(id, kind, accepted) {
  const job = active.get(id);
  if (!job || !job.answer(kind, accepted)) return [409, { error: 'Job ini tidak sedang menunggu jawaban tersebut' }];
  return [200, { ok: true }];
}

function match(method, path) {
  for (const [key, handler] of Object.entries(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '(\\d+)'; })}$`);
    const hit = re.exec(path);
    if (hit) return [handler, Object.fromEntries(names.map((n, i) => [n, hit[i + 1]]))];
  }
  return [null, null];
}

function authorized(req) {
  const expected = Buffer.from(config.token);
  const got = Buffer.from(req.headers['x-provisioner-token'] ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const server = http.createServer(async (req, res) => {
  const send = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (path !== '/health' && !authorized(req)) return send(401, { error: 'unauthorized' });
    const [handler, params] = match(req.method, path);
    if (!handler) return send(404, { error: 'not found' });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64 * 1024) return send(413, { error: 'terlalu besar' });
    }
    const body = raw ? JSON.parse(raw) : {};
    const [code, data] = await handler(params, body);
    send(code, data);
  } catch (err) {
    console.error(err);
    send(500, { error: err.message });
  }
});

await initSecrets();
await query(
  `INSERT INTO app_settings (key, value) VALUES ('ssh_public_key', $1)
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  [await secrets.sshPublicKey()]
).catch((err) => console.warn('app_settings belum ada (migrasi backend belum jalan?):', err.message));
const stale = await failStaleJobs().catch(() => 0);
if (stale) console.log(`${stale} job lama ditandai gagal`);

server.listen(config.port, '0.0.0.0', () => console.log(`Provisioner berjalan di port ${config.port}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const job of active.values()) job.cancel();
    server.close();
    setTimeout(() => pool.end().finally(() => process.exit(0)), 3000);
  });
}
