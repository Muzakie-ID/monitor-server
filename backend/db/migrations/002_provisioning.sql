-- Tahap 1: pemasangan otomatis lewat SSH, riwayat job, dan audit log.

ALTER TABLE servers
  ADD COLUMN mode                 TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'auto')),
  -- manual: node_exporter dipasang sendiri; ready: terpasang otomatis & terverifikasi
  ADD COLUMN provision_status     TEXT NOT NULL DEFAULT 'manual'
    CHECK (provision_status IN ('manual', 'pending', 'provisioning', 'ready', 'failed', 'removing')),
  ADD COLUMN ssh_user             TEXT,
  ADD COLUMN ssh_port             INTEGER CHECK (ssh_port BETWEEN 1 AND 65535),
  ADD COLUMN host_key_fingerprint TEXT,          -- SHA256:..., disimpan setelah dikonfirmasi admin
  ADD COLUMN collect_logs         BOOLEAN NOT NULL DEFAULT false,
  -- Perubahan yang pernah dibuat di server target (dipakai saat mencopot)
  ADD COLUMN install_manifest     JSONB NOT NULL DEFAULT '[]';

CREATE TABLE provision_jobs (
  id          SERIAL PRIMARY KEY,
  server_id   INTEGER REFERENCES servers(id) ON DELETE SET NULL,
  server_name TEXT NOT NULL,                     -- tetap terbaca walau server sudah dihapus
  kind        TEXT NOT NULL CHECK (kind IN ('install', 'uninstall', 'verify')),
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                'queued', 'running', 'awaiting_hostkey', 'awaiting_approval',
                'succeeded', 'failed', 'cancelled')),
  steps       JSONB NOT NULL DEFAULT '[]',       -- [{id, label, status, detail}]
  log         JSONB NOT NULL DEFAULT '[]',       -- [{t, level, msg}], tanpa kata sandi
  plan        JSONB,                             -- rencana yang menunggu persetujuan
  fingerprint TEXT,                              -- host key yang menunggu konfirmasi
  manifest    JSONB NOT NULL DEFAULT '[]',       -- perubahan yang dibuat job ini (untuk rollback)
  error       TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provision_jobs_server_idx ON provision_jobs (server_id, created_at DESC);
-- Paling banyak satu job aktif per server (mencegah dua admin menjalankan bersamaan)
CREATE UNIQUE INDEX provision_jobs_one_active ON provision_jobs (server_id)
  WHERE status IN ('queued', 'running', 'awaiting_hostkey', 'awaiting_approval');

CREATE TABLE audit_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER,
  user_name  TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

-- Nilai yang bukan rahasia dan perlu dibaca backend (mis. public key SSH pemantau)
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
