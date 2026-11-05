import { config } from '../config.js';

// Semua query PromQL dikumpulkan di sini supaya mudah diubah.
// Label "server" dan "region" berasal dari file target yang ditulis targets.js.
export const Q = {
  up: 'probe_success{job="blackbox_icmp"}',
  latencyMs: 'probe_duration_seconds{job="blackbox_icmp"} * 1000',
  cpu: '100 - avg by (server) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100',
  mem: 'avg by (server) ((1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100)',
  diskUsedBytes:
    'sum by (server) (node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"} - node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"})',
  diskSizeBytes: 'sum by (server) (node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"})',
  netRxBps: 'sum by (server) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[5m])) * 8',
  netTxBps: 'sum by (server) (rate(node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[5m])) * 8',
  uptimeSec: 'max by (server) (time() - node_boot_time_seconds)',
  avgCpu: 'avg(100 - avg by (server) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
  avgMem: 'avg((1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100)',
  uptime30d: 'avg(avg_over_time(probe_success{job="blackbox_icmp"}[30d])) * 100'
};

async function call(path, params) {
  const url = new URL(path, config.prometheusUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`Prometheus: ${body.error ?? res.statusText}`);
  return body.data;
}

// Query sesaat. Mengembalikan { [server]: angka } untuk hasil per server,
// atau satu angka kalau hasilnya tidak berlabel server.
export async function instant(promql) {
  const data = await call('/api/v1/query', { query: promql });
  const out = {};
  for (const r of data.result) {
    const key = r.metric.server ?? '_';
    out[key] = Number(r.value[1]);
  }
  return out;
}

export async function scalar(promql) {
  const r = await instant(promql);
  const v = Object.values(r)[0];
  return Number.isFinite(v) ? v : null;
}

// Query rentang waktu untuk grafik. Mengembalikan [[detik, nilai], ...].
export async function range(promql, { start, end, step }) {
  const data = await call('/api/v1/query_range', { query: promql, start, end, step });
  return data.result.map((r) => ({
    server: r.metric.server ?? null,
    points: r.values.map(([t, v]) => [t, Number(v)])
  }));
}
