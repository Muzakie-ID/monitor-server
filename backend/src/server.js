import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { config } from './config.js';
import { pool, ensureAdmin } from './db.js';
import { syncTargets } from './services/targets.js';
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/servers.js';
import metricRoutes from './routes/metrics.js';
import alertRoutes from './routes/alerts.js';
import streamRoutes from './routes/stream.js';

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

app.addHook('onClose', async () => pool.end());

await ensureAdmin(app.log);
await syncTargets(app.log);
await app.listen({ port: config.port, host: '0.0.0.0' });
