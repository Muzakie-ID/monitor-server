# Pantau Server

Dashboard monitoring server: Prometheus untuk metrik, Alertmanager untuk peringatan,
backend Node.js (Fastify) + PostgreSQL, frontend memakai komponen asli Gentelella v4 (paket npm `gentelella`) dengan ECharts.

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
├── frontend/                   Vite + Gentelella v4 + ECharts, disajikan Nginx
│   ├── index.html              dashboard
│   ├── login.html
│   ├── nginx.conf              sajikan file + teruskan /api ke backend
│   └── src/
│       ├── api.js              semua panggilan ke backend
│       ├── main.js             isi tile, grafik, peringatan, tabel
│       ├── format.js           format byte, bit/s, durasi
│       └── styles/main.scss    impor SCSS Gentelella v4 + sedikit penyesuaian
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

4. Lanjutkan ke [Menambah server yang dipantau](#menambah-server-yang-dipantau).

## Menambah server yang dipantau

Tombol **Tambah Server** hanya mendaftarkan server ke Prometheus. Supaya datanya
muncul, server tersebut juga harus menjalankan **node_exporter** dan bisa dijangkau
dari mesin pemantau (mesin yang menjalankan docker-compose).

### Yang terjadi otomatis setelah klik Simpan

1. Server disimpan ke PostgreSQL.
2. Backend menulis ulang `nodes.json` (target Prometheus) berisi `IP:port` plus
   label `server` dan `region`.
3. Paling lambat **30 detik** kemudian Prometheus mulai:
   - mengambil metrik dari `http://IP:9100/metrics` (CPU, memori, disk, jaringan, uptime);
   - mem-ping IP lewat blackbox (status Online/Offline).

Tidak perlu me-restart apa pun.

### Yang harus dilakukan di server yang ditambahkan

1. **Pasang node_exporter.** Lewat Ansible: salin inventory, isi IP server di bawah
   `[pantau]`, dan ubah `monitor_ip` di `install-node-exporter.yml` menjadi IP
   mesin pemantau.

   ```bash
   cd ansible && cp inventory.example.ini inventory.ini
   ```

   ```bash
   ansible-playbook -i inventory.ini install-node-exporter.yml
   ```

   Atau manual di Ubuntu/Debian (versi dari repo distro biasanya lebih lama):

   ```bash
   sudo apt install prometheus-node-exporter
   ```

2. **Buka firewall dari mesin pemantau:**
   - TCP **9100**, batasi hanya dari IP mesin pemantau. Playbook sudah memasang
     aturan ufw untuk ini.
   - **ICMP (ping)**. Kalau ping diblokir, server tampil **Offline** walaupun
     metriknya masuk.
   - Firewall penyedia cloud (Security Group dan sejenisnya) tetap harus diatur sendiri.

3. **Cek dari mesin pemantau.** Kalau keluar teks metrik, berarti sudah benar:

   ```bash
   curl -s http://IP_SERVER:9100/metrics | head
   ```

### Membaca hasilnya di dashboard

Tunggu sekitar 30–60 detik, lalu lihat tabel Daftar Server:

| Yang terlihat | Artinya |
|---|---|
| **Online**, CPU/memori terisi | Semua berjalan |
| **Online**, CPU/memori "—" | Ping berhasil, tapi port 9100 tidak terjangkau: cek node_exporter dan firewall |
| **Offline** | Ping gagal: cek IP, atau ICMP diblokir |
| **Peringatan** | Server berjalan, tapi ada alert aktif (misalnya CPU di atas 85%) |

Kalau masih bermasalah, lihat status target di Prometheus. Kolom `lastError`
menjelaskan penyebabnya, misalnya *connection refused* atau *timeout*:

```bash
docker compose exec prometheus wget -qO- localhost:9090/api/v1/targets | head -c 2000
```

## Catatan keamanan

- Prometheus, Alertmanager, dan PostgreSQL tidak membuka port ke luar; hanya Nginx (port 8080).
- Port 9100 (node_exporter) di tiap server sebaiknya hanya bisa diakses dari server pemantau.
  Playbook Ansible sudah memasang aturan ufw untuk itu.
- Pasang HTTPS di depan Nginx (misalnya Caddy atau Certbot) sebelum dipakai lewat internet.
