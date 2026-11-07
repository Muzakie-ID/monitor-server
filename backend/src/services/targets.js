import { writeFile, rename } from 'node:fs/promises';
import { query } from '../db.js';
import { config } from '../config.js';

// Menulis ulang daftar target Prometheus (file_sd) dari tabel servers.
// Prometheus membaca file ini tiap 30 detik, jadi server baru otomatis dipantau.
// - nodes.json        : server manual, node_exporter biasa (http)
// - nodes-secure.json : server yang dipasang otomatis & terverifikasi (https + basic auth)
// Server yang masih disiapkan/gagal dipasang tidak dimasukkan ke mana pun.
export async function syncTargets(log) {
  const { rows } = await query(
    `SELECT s.name, host(s.ip) AS ip, s.exporter_port, s.mode, s.provision_status, r.name AS region
       FROM servers s LEFT JOIN regions r ON r.id = s.region_id
      ORDER BY s.name`
  );
  const toTarget = (s) => ({
    targets: [`${s.ip}:${s.exporter_port}`],
    labels: { server: s.name, region: s.region ?? 'tanpa-region' }
  });
  const plain = rows.filter((s) => s.mode === 'manual').map(toTarget);
  const secure = rows.filter((s) => s.mode === 'auto' && s.provision_status === 'ready').map(toTarget);

  await writeAtomic(config.targetsFile, plain);
  await writeAtomic(config.secureTargetsFile, secure);
  log?.info(`Target Prometheus diperbarui: ${plain.length} manual, ${secure.length} otomatis`);
}

// Ganti sekaligus supaya Prometheus tidak membaca file setengah jadi
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}
