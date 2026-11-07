function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variabel lingkungan ${name} belum diisi`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  // Token bersama dengan backend; API provisioner tidak pernah dibuka ke luar jaringan Docker
  token: required('PROVISIONER_TOKEN'),
  secretsDir: process.env.SECRETS_DIR ?? '/secrets',
  cacheDir: process.env.CACHE_DIR ?? '/cache',

  // Alamat server pemantau yang bisa dijangkau server target (IP publik/privat atau DNS).
  // Dibutuhkan agen log untuk mengirim log; kosong = fitur log dimatikan.
  publicHost: process.env.MONITOR_PUBLIC_HOST ?? '',
  lokiPort: Number(process.env.LOKI_PORT ?? 3101),
  // IP server pemantau seperti terlihat dari server target (untuk aturan ufw).
  // Kosong = dideteksi otomatis dari koneksi SSH ($SSH_CLIENT).
  sourceIp: process.env.MONITOR_SOURCE_IP ?? '',

  maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS ?? 3),
  approvalTimeoutMs: 15 * 60_000,   // batas menunggu konfirmasi host key / rencana
  commandTimeoutMs: 5 * 60_000,
  sshReadyTimeoutMs: 20_000,

  // Versi dikunci beserta checksum SHA256 resminya; file yang tidak cocok ditolak.
  artifacts: {
    nodeExporter: {
      version: '1.10.2',
      url: (v, arch) => `https://github.com/prometheus/node_exporter/releases/download/v${v}/node_exporter-${v}.linux-${arch}.tar.gz`,
      sha256: {
        amd64: 'c46e5b6f53948477ff3a19d97c58307394a29fe64a01905646f026ddc32cb65b',
        arm64: 'de69ec8341c8068b7c8e4cfe3eb85065d24d984a3b33007f575d307d13eb89a6'
      }
    },
    alloy: {
      version: '1.12.0',
      url: (v, arch) => `https://github.com/grafana/alloy/releases/download/v${v}/alloy-linux-${arch}.zip`,
      sha256: {
        amd64: 'd0a1f5474a6edbf1222dc66e60290957456595a636f5651c270db00254ee5453',
        arm64: '729188de72aca8f6b04a1ae3d12c1db8e0aadc3130658a0006a3c1a3c4c7a933'
      }
    }
  }
};
