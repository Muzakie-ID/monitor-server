import { config } from '../config.js';
import { getSummary } from '../services/overview.js';

// Server-Sent Events: dashboard menerima ringkasan baru tiap 15 detik
// dan sinyal "alerts" tiap kali Alertmanager mengirim peringatan.
const clients = new Set();

export function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

export default async function streamRoutes(app) {
  // EventSource di browser tidak bisa mengirim header, jadi token lewat ?token=
  app.get('/api/stream', async (req, reply) => {
    try {
      app.jwt.verify(req.query.token ?? '');
    } catch {
      return reply.code(401).send();
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no' // supaya Nginx tidak menahan pesan
    });
    res.write('retry: 5000\n\n');
    clients.add(res);
    req.raw.on('close', () => clients.delete(res));
  });

  const timer = setInterval(async () => {
    if (clients.size === 0) return;
    try {
      broadcast('summary', await getSummary());
    } catch (err) {
      app.log.error({ err }, 'Gagal mengambil ringkasan untuk SSE');
    }
  }, config.streamIntervalMs);
  app.addHook('onClose', async () => clearInterval(timer));
}
