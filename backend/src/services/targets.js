import { writeFile, rename } from 'node:fs/promises';
import { query } from '../db.js';
import { config } from '../config.js';

// Menulis ulang daftar target Prometheus (file_sd) dari tabel servers.
// Prometheus membaca file ini tiap 30 detik, jadi server baru otomatis dipantau.
export async function syncTargets(log) {
  const { rows } = await query(
    `SELECT s.name, host(s.ip) AS ip, s.exporter_port, r.name AS region
       FROM servers s LEFT JOIN regions r ON r.id = s.region_id
      ORDER BY s.name`
  );
  const targets = rows.map((s) => ({
    targets: [`${s.ip}:${s.exporter_port}`],
    labels: { server: s.name, region: s.region ?? 'tanpa-region' }
  }));
  const tmp = `${config.targetsFile}.tmp`;
  await writeFile(tmp, JSON.stringify(targets, null, 2));
  await rename(tmp, config.targetsFile); // ganti sekaligus supaya Prometheus tidak membaca file setengah jadi
  log?.info(`Target Prometheus diperbarui: ${targets.length} server`);
}
