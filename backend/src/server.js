import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { config } from './config.js';
import pg from 'pg';
import { pool, ensureAdmin } from './db.js';
import { migrate } from './migrate.js';
import { syncTargets } from './services/targets.js';
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/servers.js';
import metricRoutes from './routes/metrics.js';
import alertRoutes from './routes/alerts.js';
import streamRoutes, { broadcast } from './routes/stream.js';
import provisionRoutes from './routes/provision.js';

const app = Fastify({ logger: true });

app.register(fastifyJwt, { secret: config.jwtSecret });

app.decorate('authenticate', async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Silakan login dulu' });
  }
});

app.decorate('requireAdmin', async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Silakan login dulu' });
  }
  if (req.user.role !== 'admin') reply.code(403).send({ error: 'Hanya admin' });
});

app.get('/api/health', async () => ({ ok: true }));

app.register(authRoutes);
app.register(serverRoutes);
app.register(metricRoutes);
app.register(alertRoutes);
app.register(streamRoutes);
app.register(provisionRoutes);

app.addHook('onClose', async () => pool.end());

// Provisioner mengabarkan progres job lewat NOTIFY; diteruskan ke dashboard lewat SSE.
// Setelah server aktif/dihapus, file target Prometheus ditulis ulang di sini.
async function listenProvision() {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  client.on('notification', async (msg) => {
    let payload = {};
    try { payload = JSON.parse(msg.payload); } catch { /* abaikan */ }
    if (payload.type === 'sync-targets') await syncTargets(app.log).catch((err) => app.log.error({ err }, 'syncTargets gagal'));
    broadcast('provision', payload);
  });
  client.on('error', (err) => {
    app.log.error({ err }, 'Koneksi LISTEN terputus, menyambung ulang dalam 5 detik');
    setTimeout(listenProvision, 5000);
  });
  await client.connect();
  await client.query('LISTEN provision');
  app.addHook('onClose', async () => client.end());
}

await migrate(app.log);
await ensureAdmin(app.log);
await syncTargets(app.log);
await listenProvision();
await app.listen({ port: config.port, host: '0.0.0.0' });
