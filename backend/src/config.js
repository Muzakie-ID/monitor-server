function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variabel lingkungan ${name} belum diisi`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  prometheusUrl: process.env.PROMETHEUS_URL ?? 'http://localhost:9090',
  targetsFile: process.env.TARGETS_FILE ?? '../prometheus/targets/nodes.json',
  jwtSecret: required('JWT_SECRET'),
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  alertWebhookToken: required('ALERT_WEBHOOK_TOKEN'),
  streamIntervalMs: 15_000
};
