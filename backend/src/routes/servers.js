import { query } from '../db.js';
import { syncTargets } from '../services/targets.js';
import { getServersWithMetrics, getSummary } from '../services/overview.js';

export default async function serverRoutes(app) {
  // Ringkasan untuk baris statistik di atas dashboard
  app.get('/api/summary', { onRequest: [app.authenticate] }, () => getSummary());

  // Tabel daftar server, lengkap dengan metrik terbaru
  app.get('/api/servers', { onRequest: [app.authenticate] }, () => getServersWithMetrics());

  app.get('/api/regions', { onRequest: [app.authenticate] }, async () => {
    const { rows } = await query('SELECT id, name FROM regions ORDER BY name');
    return rows;
  });

  // Tombol "Tambah Server"
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
          tags: { type: 'array', items: { type: 'string' }, default: [] }
        }
      }
    }
  }, async (req, reply) => {
    const { name, ip, exporterPort, regionId, tags } = req.body;
    const { rows } = await query(
      `INSERT INTO servers (name, ip, exporter_port, region_id, tags)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, ip, exporterPort, regionId ?? null, tags]
    );
    await syncTargets(req.log);
    return reply.code(201).send({ id: rows[0].id });
  });

  app.delete('/api/servers/:id', { onRequest: [app.requireAdmin] }, async (req, reply) => {
    const { rowCount } = await query('DELETE FROM servers WHERE id = $1', [Number(req.params.id)]);
    if (!rowCount) return reply.code(404).send({ error: 'Server tidak ditemukan' });
    await syncTargets(req.log);
    return reply.code(204).send();
  });
}
