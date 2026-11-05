import { query } from '../db.js';
import { Q, instant, scalar } from './prometheus.js';

// Data untuk baris statistik dan tabel server di dashboard.
export async function getServersWithMetrics() {
  const { rows: servers } = await query(
    `SELECT s.id, s.name, host(s.ip) AS ip, s.tags, r.name AS region
       FROM servers s LEFT JOIN regions r ON r.id = s.region_id
      ORDER BY s.name`
  );
  const [up, cpu, mem, diskUsed, diskSize, rx, tx, uptime] = await Promise.all([
    instant(Q.up), instant(Q.cpu), instant(Q.mem), instant(Q.diskUsedBytes),
    instant(Q.diskSizeBytes), instant(Q.netRxBps), instant(Q.netTxBps), instant(Q.uptimeSec)
  ]);
  const { rows: firing } = await query(
    "SELECT DISTINCT server FROM alerts WHERE status = 'firing' AND server IS NOT NULL"
  );
  const warned = new Set(firing.map((r) => r.server));

  return servers.map((s) => {
    const online = up[s.name] === 1;
    return {
      ...s,
      status: !online ? 'offline' : warned.has(s.name) ? 'peringatan' : 'online',
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
    scalar(Q.avgCpu), scalar(Q.avgMem), scalar(Q.uptime30d)
  ]);
  return {
    total: servers.length,
    online: servers.filter((s) => s.status !== 'offline').length,
    avgCpu: round(avgCpu),
    avgMem: round(avgMem),
    uptime30d: uptime30d == null ? null : Math.round(uptime30d * 100) / 100,
    updatedAt: new Date().toISOString()
  };
}

const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
