import { query } from '../db.js';
import { config } from '../config.js';
import { provisioner } from '../services/provisioner.js';
import { audit } from '../services/audit.js';
import { sshSchema, credsOf } from '../services/ssh-schema.js';

const ACTIVE = "('queued','running','awaiting_hostkey','awaiting_approval')";

/**
 * Buat baris job lalu serahkan ke provisioner bersama kredensial (yang tidak disimpan).
 * Kalau provisioner tidak bisa dihubungi, job langsung ditandai gagal.
 */
export async function createJob(req, serverId, kind, creds, extra = {}) {
  const { rows: [server] } = await query('SELECT name FROM servers WHERE id = $1', [serverId]);
  let job;
  try {
    ({ rows: [job] } = await query(
      'INSERT INTO provision_jobs (server_id, server_name, kind, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [serverId, server.name, kind, req.user?.name ?? null]));
  } catch (err) {
    if (err.code === '23505') throw Object.assign(new Error('Masih ada job yang berjalan untuk server ini.'), { statusCode: 409 });
    throw err;
  }
  await audit(req, `provision.${kind}`, server.name, { jobId: job.id });
  try {
    await provisioner('POST', `/jobs/${job.id}/start`, { creds, ...extra });
  } catch (err) {
    await query("UPDATE provision_jobs SET status='failed', error=$2, updated_at=now() WHERE id=$1", [job.id, err.message]);
    if (kind === 'install') await query("UPDATE servers SET provision_status='failed' WHERE id=$1", [serverId]);
  }
  return job.id;
}

async function ensureIdle(serverId, reply) {
  const { rows } = await query(`SELECT id FROM provision_jobs WHERE server_id = $1 AND status IN ${ACTIVE}`, [serverId]);
  if (rows.length) {
    reply.code(409).send({ error: 'Masih ada job yang berjalan untuk server ini.', jobId: rows[0].id });
    return false;
  }
  return true;
}

async function getServer(id, reply) {
  const { rows: [s] } = await query(
    'SELECT id, name, host(ip) AS ip, mode, provision_status, ssh_user, ssh_port, host_key_fingerprint, collect_logs FROM servers WHERE id = $1',
    [id]);
  if (!s) reply.code(404).send({ error: 'Server tidak ditemukan' });
  return s;
}

const sendError = (reply, err) => reply.code(err.statusCode ?? 500).send({ error: err.message });

export default async function provisionRoutes(app) {
  // Informasi untuk formulir: public key pemantau & apakah fitur log tersedia
  app.get('/api/provision/info', { onRequest: [app.requireAdmin] }, async () => {
    const { rows } = await query("SELECT value FROM app_settings WHERE key = 'ssh_public_key'");
    return { publicKey: rows[0]?.value ?? null, logsAvailable: !!config.monitorPublicHost };
  });

  // Tes koneksi tanpa menyimpan atau mengubah apa pun
  app.post('/api/provision/test', {
    onRequest: [app.requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['ip', 'ssh'],
        properties: {
          ip: { type: 'string', format: 'ipv4' },
          ssh: sshSchema,
          serverId: { type: 'integer' },
          acceptedFingerprint: { type: 'string', maxLength: 100 }
        }
      }
    }
  }, async (req, reply) => {
    const { ip, ssh, serverId, acceptedFingerprint } = req.body;
    let savedFingerprint = null;
    if (serverId) {
      const { rows } = await query('SELECT host_key_fingerprint FROM servers WHERE id = $1', [serverId]);
      savedFingerprint = rows[0]?.host_key_fingerprint ?? null;
    }
    await audit(req, 'provision.test', ip, { user: ssh.user });
    try {
      return await provisioner('POST', '/test', {
        ip, sshPort: ssh.port, sshUser: ssh.user, savedFingerprint, acceptedFingerprint, creds: credsOf(ssh)
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Pasang ulang / coba lagi
  app.post('/api/servers/:id/provision', {
    onRequest: [app.requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['ssh'],
        properties: {
          ssh: sshSchema,
          collectLogs: { type: 'boolean' },
          acceptedFingerprint: { type: 'string', maxLength: 100 }
        }
      }
    }
  }, async (req, reply) => {
    const s = await getServer(Number(req.params.id), reply);
    if (!s || !(await ensureIdle(s.id, reply))) return;
    const { ssh, collectLogs, acceptedFingerprint } = req.body;
    await query(
      `UPDATE servers SET mode = 'auto', ssh_user = $2, ssh_port = $3, collect_logs = COALESCE($4, collect_logs),
              provision_status = CASE WHEN provision_status = 'ready' THEN 'ready' ELSE 'pending' END
        WHERE id = $1`,
      [s.id, ssh.user, ssh.port, collectLogs ?? null]);
    try {
      return { jobId: await createJob(req, s.id, 'install', credsOf(ssh), { acceptedFingerprint }) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Cek ulang port dari server pemantau (tanpa SSH), mis. setelah membuka Security Group
  app.post('/api/servers/:id/recheck', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const s = await getServer(Number(req.params.id), reply);
    if (!s || !(await ensureIdle(s.id, reply))) return;
    if (s.mode !== 'auto') return reply.code(400).send({ error: 'Hanya untuk server yang dipasang otomatis' });
    try {
      return { jobId: await createJob(req, s.id, 'verify', null) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Copot node_exporter & agen log dari server target, lalu hapus dari dashboard
  app.post('/api/servers/:id/uninstall', {
    onRequest: [app.requireAdmin],
    schema: { body: { type: 'object', required: ['ssh'], properties: { ssh: sshSchema } } }
  }, async (req, reply) => {
    const s = await getServer(Number(req.params.id), reply);
    if (!s || !(await ensureIdle(s.id, reply))) return;
    if (s.mode !== 'auto') return reply.code(400).send({ error: 'Server ini dipasang manual; tidak ada yang bisa dicopot otomatis.' });
    await query('UPDATE servers SET ssh_user = $2, ssh_port = $3 WHERE id = $1', [s.id, req.body.ssh.user, req.body.ssh.port]);
    try {
      return { jobId: await createJob(req, s.id, 'uninstall', credsOf(req.body.ssh)) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/servers/:id/jobs', { onRequest: [app.authenticate] }, async (req) => {
    const { rows } = await query(
      `SELECT id, kind, status, error, created_by, created_at, updated_at
         FROM provision_jobs WHERE server_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [Number(req.params.id)]);
    return rows;
  });

  app.get('/api/jobs/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { rows: [job] } = await query('SELECT * FROM provision_jobs WHERE id = $1', [Number(req.params.id)]);
    if (!job) return reply.code(404).send({ error: 'Job tidak ditemukan' });
    return job;
  });

  for (const [action, field] of [['hostkey', 'accept'], ['approve', 'approve']]) {
    app.post(`/api/jobs/:id/${action}`, {
      onRequest: [app.requireAdmin],
      schema: { body: { type: 'object', required: [field], properties: { [field]: { type: 'boolean' } } } }
    }, async (req, reply) => {
      const id = Number(req.params.id);
      const { rows: [job] } = await query('SELECT server_name, fingerprint FROM provision_jobs WHERE id = $1', [id]);
      if (!job) return reply.code(404).send({ error: 'Job tidak ditemukan' });
      await audit(req, `provision.${action}.${req.body[field] ? 'yes' : 'no'}`, job.server_name,
        { jobId: id, ...(action === 'hostkey' ? { fingerprint: job.fingerprint } : {}) });
      try {
        return await provisioner('POST', `/jobs/${id}/${action}`, req.body);
      } catch (err) {
        return sendError(reply, err);
      }
    });
  }

  app.post('/api/jobs/:id/cancel', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { rows: [job] } = await query('SELECT server_name FROM provision_jobs WHERE id = $1', [id]);
    if (!job) return reply.code(404).send({ error: 'Job tidak ditemukan' });
    await audit(req, 'provision.cancel', job.server_name, { jobId: id });
    try {
      return await provisioner('POST', `/jobs/${id}/cancel`);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/audit', { onRequest: [app.requireAdmin] }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await query(
      'SELECT id, user_name, action, target, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT $1',
      [limit]);
    return rows;
  });
}
