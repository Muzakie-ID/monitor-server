function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variabel lingkungan ${name} belum diisi`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  prometheusUrl: process.env.PROMETHEUS_URL ?? 'http://localhost:9090',
  // nodes.json: server manual (node_exporter tanpa TLS).
  // nodes-secure.json: server yang dipasang otomatis (TLS + basic auth).
  targetsFile: process.env.TARGETS_FILE ?? '../prometheus/targets/nodes.json',
  secureTargetsFile: process.env.SECURE_TARGETS_FILE ?? '../prometheus/targets/nodes-secure.json',
  provisionerUrl: process.env.PROVISIONER_URL ?? 'http://localhost:4000',
  provisionerToken: process.env.PROVISIONER_TOKEN ?? '',
  monitorPublicHost: process.env.MONITOR_PUBLIC_HOST ?? '',
  jwtSecret: required('JWT_SECRET'),
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  alertWebhookToken: required('ALERT_WEBHOOK_TOKEN'),
  streamIntervalMs: 15_000
};
