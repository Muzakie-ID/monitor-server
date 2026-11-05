import { timingSafeEqual } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { broadcast } from './stream.js';

function tokenOk(header) {
  const expected = Buffer.from(`Bearer ${config.alertWebhookToken}`);
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export default async function alertRoutes(app) {
  // Panel "Peringatan Aktif" + kotak ringkasan Kritis / Sedang / Selesai hari ini
  app.get('/api/alerts', { onRequest: [app.authenticate] }, async () => {
    const { rows: active } = await query(
      `SELECT id, alertname, server, severity, summary, starts_at
         FROM alerts WHERE status = 'firing'
        ORDER BY (severity = 'kritis') DESC, starts_at DESC`
    );
    const { rows: [counts] } = await query(
      `SELECT
         count(*) FILTER (WHERE status = 'firing' AND severity = 'kritis')::int AS kritis,
         count(*) FILTER (WHERE status = 'firing' AND severity = 'sedang')::int AS sedang,
         count(*) FILTER (WHERE status = 'resolved' AND ends_at >= date_trunc('day', now()))::int AS selesai_hari_ini
       FROM alerts`
    );
    return { active, counts };
  });

  // Dipanggil oleh Alertmanager (lihat alertmanager/alertmanager.yml)
  app.post('/api/alerts/webhook', async (req, reply) => {
    if (!tokenOk(req.headers.authorization)) return reply.code(401).send();

    for (const a of req.body?.alerts ?? []) {
      const endsAt = a.status === 'resolved' ? a.endsAt : null;
      await query(
        `INSERT INTO alerts (fingerprint, alertname, server, severity, summary, status, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (fingerprint, starts_at)
         DO UPDATE SET status = EXCLUDED.status, ends_at = EXCLUDED.ends_at,
                       summary = EXCLUDED.summary, updated_at = now()`,
        [
          a.fingerprint,
          a.labels?.alertname ?? 'tanpa-nama',
          a.labels?.server ?? null,
          a.labels?.severity ?? 'sedang',
          a.annotations?.summary ?? null,
          a.status,
          a.startsAt,
          endsAt
        ]
      );
    }
    broadcast('alerts', { changed: true });
    return reply.code(204).send();
  });
}
