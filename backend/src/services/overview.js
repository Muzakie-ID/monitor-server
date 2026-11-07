import { query } from '../db.js';
import { Q, instant, scalar } from './prometheus.js';

// Data untuk baris statistik dan tabel server di dashboard.
export async function getServersWithMetrics() {
  const { rows: servers } = await query(
    `SELECT s.id, s.name, host(s.ip) AS ip, s.tags, r.name AS region, s.region_id,
            s.mode, s.provision_status, s.exporter_port, s.ssh_user, s.ssh_port, s.collect_logs,
            s.host_key_fingerprint IS NOT NULL AS has_fingerprint,
            j.id AS job_id, j.kind AS job_kind, j.status AS job_status, j.error AS job_error,
            (SELECT st->>'id' FROM jsonb_array_elements(j.steps) st WHERE st->>'status' = 'failed' LIMIT 1) AS job_failed_step
       FROM servers s
       LEFT JOIN regions r ON r.id = s.region_id
       LEFT JOIN LATERAL (
         SELECT id, kind, status, error, steps FROM provision_jobs
          WHERE server_id = s.id ORDER BY created_at DESC LIMIT 1) j ON true
      ORDER BY s.name`
  );
  // Kalau Prometheus sedang tidak bisa dihubungi, daftar server tetap tampil tanpa metrik
  const safe = (q) => instant(q).catch(() => ({}));
  const [up, cpu, mem, diskUsed, diskSize, rx, tx, uptime] = await Promise.all([
    safe(Q.up), safe(Q.cpu), safe(Q.mem), safe(Q.diskUsedBytes),
    safe(Q.diskSizeBytes), safe(Q.netRxBps), safe(Q.netTxBps), safe(Q.uptimeSec)
  ]);
  const { rows: firing } = await query(
    "SELECT DISTINCT server FROM alerts WHERE status = 'firing' AND server IS NOT NULL"
  );
  const warned = new Set(firing.map((r) => r.server));

  return servers.map((s) => {
    const online = up[s.name] === 1;
    // Server otomatis yang belum siap belum dipantau, jadi statusnya mengikuti pemasangan
    const provisioning = s.mode === 'auto' && s.provision_status !== 'ready';
    return {
      ...s,
      status: provisioning ? 'disiapkan' : !online ? 'offline' : warned.has(s.name) ? 'peringatan' : 'online',
      cpu: round(cpu[s.name]),
      mem: round(mem[s.name]),
      diskUsedBytes: diskUsed[s.name] ?? null,
      diskSizeBytes: diskSize[s.name] ?? null,
      netRxBps: rx[s.name] ?? null,
      netTxBps: tx[s.name] ?? null,
      uptimeSec: online ? uptime[s.name] ?? null : 0
    };
  });
}

export async function getSummary() {
  const servers = await getServersWithMetrics();
  const [avgCpu, avgMem, uptime30d] = await Promise.all([
    scalar(Q.avgCpu).catch(() => null), scalar(Q.avgMem).catch(() => null), scalar(Q.uptime30d).catch(() => null)
  ]);
  const monitored = servers.filter((s) => s.status !== 'disiapkan');
  return {
    total: monitored.length,
    online: monitored.filter((s) => s.status !== 'offline').length,
    avgCpu: round(avgCpu),
    avgMem: round(avgMem),
    uptime30d: uptime30d == null ? null : Math.round(uptime30d * 100) / 100,
    updatedAt: new Date().toISOString()
  };
}

const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
