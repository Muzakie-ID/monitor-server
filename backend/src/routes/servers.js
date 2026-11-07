import { query } from '../db.js';
import { syncTargets } from '../services/targets.js';
import { getServersWithMetrics, getSummary } from '../services/overview.js';
import { audit } from '../services/audit.js';
import { createJob } from './provision.js';
import { sshSchema, credsOf } from '../services/ssh-schema.js';

export default async function serverRoutes(app) {
  // Ringkasan untuk baris statistik di atas dashboard
  app.get('/api/summary', { onRequest: [app.authenticate] }, () => getSummary());

  // Tabel daftar server, lengkap dengan metrik terbaru dan status pemasangan
  app.get('/api/servers', { onRequest: [app.authenticate] }, () => getServersWithMetrics());

  app.get('/api/regions', { onRequest: [app.authenticate] }, async () => {
    const { rows } = await query('SELECT id, name FROM regions ORDER BY name');
    return rows;
  });

  // Tombol "Tambah Server": manual (node_exporter dipasang sendiri) atau otomatis lewat SSH
  app.post('/api/servers', {
    onRequest: [app.requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'ip'],
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' },
          ip: { type: 'string', format: 'ipv4' },
          exporterPort: { type: 'integer', minimum: 1, maximum: 65535, default: 9100 },
          regionId: { type: ['integer', 'null'] },
          tags: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 20, default: [] },
          mode: { type: 'string', enum: ['manual', 'auto'], default: 'manual' },
          ssh: sshSchema,
          collectLogs: { type: 'boolean', default: false },
          acceptedFingerprint: { type: 'string', maxLength: 100 }
        }
      }
    }
  }, async (req, reply) => {
    const { name, ip, exporterPort, regionId, tags, mode, ssh, collectLogs, acceptedFingerprint } = req.body;
    if (mode === 'auto' && !ssh) return reply.code(400).send({ error: 'Data SSH wajib diisi untuk pemasangan otomatis' });
    if (mode === 'auto' && ssh.authMethod === 'password' && !ssh.password) {
      return reply.code(400).send({ error: 'Kata sandi SSH wajib diisi' });
    }

    let id;
    try {
      const { rows } = await query(
        `INSERT INTO servers (name, ip, exporter_port, region_id, tags, mode, provision_status, ssh_user, ssh_port, collect_logs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [name, ip, exporterPort, regionId ?? null, tags, mode, mode === 'auto' ? 'pending' : 'manual',
          ssh?.user ?? null, ssh?.port ?? null, mode === 'auto' && collectLogs]
      );
      id = rows[0].id;
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: `Nama server "${name}" sudah dipakai` });
      throw err;
    }
    await audit(req, 'server.add', name, { ip, mode, collectLogs: mode === 'auto' && collectLogs });

    if (mode === 'manual') {
      await syncTargets(req.log);
      return reply.code(201).send({ id });
    }
    const jobId = await createJob(req, id, 'install', credsOf(ssh), { acceptedFingerprint });
    return reply.code(201).send({ id, jobId });
  });

  // Hapus dari dashboard saja (tanpa menyentuh server target)
  app.delete('/api/servers/:id', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { rows: busy } = await query(
      "SELECT 1 FROM provision_jobs WHERE server_id = $1 AND status IN ('queued','running','awaiting_hostkey','awaiting_approval')",
      [id]);
    if (busy.length) return reply.code(409).send({ error: 'Masih ada job yang berjalan untuk server ini. Batalkan dulu.' });
    const { rows } = await query('DELETE FROM servers WHERE id = $1 RETURNING name', [id]);
    if (!rows.length) return reply.code(404).send({ error: 'Server tidak ditemukan' });
    await audit(req, 'server.delete', rows[0].name, { uninstall: false });
    await syncTargets(req.log);
    return reply.code(204).send();
  });
}
