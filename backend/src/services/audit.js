import { query } from '../db.js';

/** Catat aksi admin. `detail` tidak boleh berisi kata sandi. */
export function audit(req, action, target, detail = {}) {
  return query(
    'INSERT INTO audit_log (user_id, user_name, action, target, detail) VALUES ($1, $2, $3, $4, $5)',
    [req.user?.sub ?? null, req.user?.name ?? 'tidak dikenal', action, target, JSON.stringify(detail)]
  ).catch((err) => req.log.error({ err }, 'Gagal menulis audit log'));
}
