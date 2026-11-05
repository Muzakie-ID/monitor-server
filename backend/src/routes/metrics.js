import { range } from '../services/prometheus.js';

// Rentang waktu yang bisa dipilih di dashboard (1 Jam / 24 Jam / 7 Hari / 30 Hari)
const RANGES = {
  '1h': { seconds: 3600, step: 30 },
  '24h': { seconds: 86400, step: 600 },
  '7d': { seconds: 604800, step: 3600 },
  '30d': { seconds: 2592000, step: 14400 }
};

// Tanpa server: rata-rata semua server. Dengan server: hanya server itu.
function cpuQuery(server) {
  const sel = server ? `mode="idle",server="${server}"` : 'mode="idle"';
  return `avg(100 - avg by (server) (rate(node_cpu_seconds_total{${sel}}[5m])) * 100)`;
}
function memQuery(server) {
  const sel = server ? `{server="${server}"}` : '';
  return `avg((1 - node_memory_MemAvailable_bytes${sel} / node_memory_MemTotal_bytes${sel}) * 100)`;
}

export default async function metricRoutes(app) {
  // Grafik "Beban Sumber Daya". Tambahkan ?server=nama untuk satu server saja.
  app.get('/api/metrics/range', {
    onRequest: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          range: { type: 'string', enum: Object.keys(RANGES), default: '24h' },
          // pola ketat: mencegah PromQL injection lewat nama server
          server: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' }
        }
      }
    }
  }, async (req) => {
    const { range: key, server } = req.query;
    const { seconds, step } = RANGES[key];
    const end = Math.floor(Date.now() / 1000);
    const opts = { start: end - seconds, end, step };

    const [cpu, mem] = await Promise.all([
      range(cpuQuery(server), opts),
      range(memQuery(server), opts)
    ]);
    return { range: key, step, cpu: cpu[0]?.points ?? [], mem: mem[0]?.points ?? [] };
  });
}
