# Pantau Server

Dashboard monitoring server: Prometheus untuk metrik, Alertmanager untuk peringatan,
backend Node.js (Fastify) + PostgreSQL, frontend bergaya Gentelella dengan ECharts.

## Alur data

```
[Server-server]  →  [Prometheus]  →  [Backend API]  →  [Dashboard]
 node_exporter      + blackbox        PostgreSQL         ECharts
                    Alertmanager ──webhook──┘  └──SSE──→ update live
```

| Bagian di dashboard | Sumber data | Endpoint |
|---|---|---|
| Server online, uptime | blackbox_exporter → Prometheus | `GET /api/summary` |
| CPU, memori, disk, jaringan | node_exporter → Prometheus | `GET /api/servers` |
| Grafik 24 jam | Query rentang waktu ke Prometheus | `GET /api/metrics/range?range=24h` |
| Peringatan aktif | Alertmanager → disimpan di PostgreSQL | `GET /api/alerts` |
| Daftar server, region, pengguna | PostgreSQL | `GET/POST/DELETE /api/servers`, `GET /api/regions` |
| Update live | Backend | `GET /api/stream` (SSE) |

## Struktur folder

```
pantau-server/
├── docker-compose.yml          semua layanan dalam satu perintah
├── .env.example                password, JWT secret, token webhook
├── prometheus/
│   ├── prometheus.yml          job node (node_exporter) + blackbox_icmp (ping)
│   ├── alert.rules.yml         ServerDown, CpuTinggi, MemoriTinggi, DiskHampirPenuh
│   └── targets/nodes.json      daftar target, ditulis otomatis oleh backend
├── blackbox/blackbox.yml       modul ping ICMP
├── alertmanager/alertmanager.yml   kirim peringatan ke backend (+ contoh Telegram)
├── backend/                    Node.js 22 + Fastify
│   ├── db/migrations/001_init.sql  tabel users, regions, servers, alerts
│   └── src/
│       ├── server.js           titik masuk, JWT, daftar route
│       ├── config.js           baca variabel lingkungan
│       ├── db.js               koneksi PostgreSQL + buat admin pertama
│       ├── services/
│       │   ├── prometheus.js   semua query PromQL
│       │   ├── overview.js     gabungkan data PostgreSQL + Prometheus
│       │   └── targets.js      tulis nodes.json saat server ditambah/dihapus
│       └── routes/
│           ├── auth.js         login, cek pengguna
│           ├── servers.js      ringkasan, daftar, tambah, hapus server
│           ├── metrics.js      data grafik
│           ├── alerts.js       daftar peringatan + webhook Alertmanager
│           └── stream.js       SSE
├── frontend/                   Vite + ECharts, disajikan Nginx
│   ├── index.html              dashboard
│   ├── login.html
│   ├── nginx.conf              sajikan file + teruskan /api ke backend
│   └── src/
│       ├── api.js              semua panggilan ke backend
│       ├── main.js             isi tile, grafik, peringatan, tabel
│       ├── format.js           format byte, bit/s, durasi
│       └── styles/main.scss    token warna Gentelella
└── ansible/
    └── install-node-exporter.yml   pasang node_exporter ke banyak server
```

## Menjalankan

1. Salin konfigurasi lalu isi password dan token:

   ```bash
   cp .env.example .env
   ```

   Samakan juga `credentials` di `alertmanager/alertmanager.yml` dengan `ALERT_WEBHOOK_TOKEN`.

2. Jalankan semua layanan:

   ```bash
   docker compose up -d --build
   ```

3. Buka `http://localhost:8080`, masuk dengan `ADMIN_EMAIL` dan `ADMIN_PASSWORD` dari `.env`.

4. Pasang node_exporter di server yang mau dipantau:

   ```bash
   cd ansible && cp inventory.example.ini inventory.ini
   ```

   ```bash
   ansible-playbook -i inventory.ini install-node-exporter.yml
   ```

5. Tambahkan server lewat tombol **Tambah Server** di dashboard. Backend menulis
   `nodes.json`, dan dalam 30 detik Prometheus mulai mengambil metriknya.

## Memakai Gentelella v4 yang asli

`frontend/src/styles/main.scss` meniru token warna Gentelella v4 supaya proyek ini
bisa langsung jalan. Untuk komponen lengkapnya (sidebar, modal, DataTables, toast):

1. Clone `https://github.com/colorlibhq/gentelella`.
2. Salin `src/scss/v4/` dan `src/v4/` ke `frontend/src/gentelella/`.
3. Di `main.scss`, ganti isinya dengan `@use './gentelella/scss/v4/main';`.
4. Ganti `prompt()` di tombol Tambah Server dengan `src/v4/modal.js`, dan tabel
   dengan DataTables (`src/v4/tables.js`).

## Catatan keamanan

- Prometheus, Alertmanager, dan PostgreSQL tidak membuka port ke luar; hanya Nginx (port 8080).
- Port 9100 (node_exporter) di tiap server sebaiknya hanya bisa diakses dari server pemantau.
  Playbook Ansible sudah memasang aturan ufw untuk itu.
- Pasang HTTPS di depan Nginx (misalnya Caddy atau Certbot) sebelum dipakai lewat internet.
