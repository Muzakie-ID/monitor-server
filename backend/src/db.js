import pg from 'pg';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export const query = (text, params) => pool.query(text, params);

// Buat akun admin pertama kalau tabel users masih kosong.
export async function ensureAdmin(log) {
  const { rows } = await query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  if (!config.adminEmail || !config.adminPassword) {
    log.warn('Belum ada pengguna. Isi ADMIN_EMAIL dan ADMIN_PASSWORD untuk membuat admin pertama.');
    return;
  }
  const hash = await bcrypt.hash(config.adminPassword, 12);
  await query(
    "INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Admin', $2, 'admin')",
    [config.adminEmail, hash]
  );
  log.info(`Admin pertama dibuat: ${config.adminEmail}`);
}
