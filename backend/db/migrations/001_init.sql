-- Dijalankan otomatis oleh image postgres saat volume database masih kosong.

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE regions (
  id   SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE servers (
  id            SERIAL PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,          -- dipakai sebagai label "server" di Prometheus
  ip            INET NOT NULL,
  exporter_port INTEGER NOT NULL DEFAULT 9100,
  region_id     INTEGER REFERENCES regions(id) ON DELETE SET NULL,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id           SERIAL PRIMARY KEY,
  fingerprint  TEXT NOT NULL,                  -- dari Alertmanager, unik per kejadian
  alertname    TEXT NOT NULL,
  server       TEXT,
  severity     TEXT NOT NULL,
  summary      TEXT,
  status       TEXT NOT NULL CHECK (status IN ('firing', 'resolved')),
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fingerprint, starts_at)
);

CREATE INDEX alerts_status_idx ON alerts (status, starts_at DESC);

INSERT INTO regions (name) VALUES ('Jakarta'), ('Singapura'), ('Surabaya');
