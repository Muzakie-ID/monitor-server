import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const DIR = fileURLToPath(new URL('../db/migrations/', import.meta.url));

// Menjalankan file SQL di db/migrations secara berurutan, sekali saja per file.
// Database lama (dibuat sebelum runner ini ada) sudah berisi 001 dari
// docker-entrypoint-initdb.d, jadi 001 dicatat sebagai sudah dijalankan.
export async function migrate(log) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)'); // cegah dua proses migrasi bersamaan
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

    const { rows: [{ has_users: hasUsers }] } = await client.query(
      "SELECT to_regclass('public.users') IS NOT NULL AS has_users");
    if (hasUsers) {
      await client.query(
        "INSERT INTO schema_migrations (name) VALUES ('001_init.sql') ON CONFLICT DO NOTHING");
    }

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(DIR + file, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log.info(`Migrasi dijalankan: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migrasi ${file} gagal: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}
