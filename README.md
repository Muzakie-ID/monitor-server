# Pantau Server

Dashboard monitoring server: Prometheus untuk metrik, Alertmanager untuk peringatan,
backend Node.js (Fastify) + PostgreSQL, frontend memakai komponen asli Gentelella v4 (paket npm `gentelella`) dengan ECharts.

## Alur data

```
[Server-server]  →  [Prometheus]  →  [Backend API]  →  [Dashboard]
 node_exporter      + blackbox        PostgreSQL         ECharts
                    Alertmanager ──webhook──┘  └──SSE──→ update live

[Dashboard] → [Backend] → [Provisioner] ──SSH──→ [Server target]
  Tambah Server            pasang node_exporter (TLS + basic auth)
                           & agen log (Grafana Alloy) → [Loki gateway] → [Loki]
```

| Bagian di dashboard | Sumber data | Endpoint |
|---|---|---|
| Server online, uptime | blackbox_exporter → Prometheus | `GET /api/summary` |
| CPU, memori, disk, jaringan | node_exporter → Prometheus | `GET /api/servers` |
| Grafik 24 jam | Query rentang waktu ke Prometheus | `GET /api/metrics/range?range=24h` |
| Peringatan aktif | Alertmanager → disimpan di PostgreSQL | `GET /api/alerts` |
| Daftar server, region, pengguna | PostgreSQL | `GET/POST/DELETE /api/servers`, `GET /api/regions` |
| Update live | Backend | `GET /api/stream` (SSE) |
| Pemasangan otomatis, progres job | Provisioner → PostgreSQL | `POST /api/provision/test`, `GET /api/jobs/:id` |
| Log audit | PostgreSQL | `GET /api/audit` |

## Struktur folder

```
pantau-server/
├── docker-compose.yml          semua layanan dalam satu perintah
├── .env.example                password, JWT secret, token webhook & provisioner
├── prometheus/
│   ├── prometheus.yml          job node, node_secure (TLS) + blackbox_icmp (ping)
│   ├── alert.rules.yml         ServerDown, CpuTinggi, MemoriTinggi, DiskHampirPenuh
│   └── targets/                nodes.json (manual) & nodes-secure.json (otomatis), ditulis backend
├── loki/
│   ├── loki.yml                penyimpanan log, retensi 14 hari
│   └── gateway.conf            pintu masuk log: HTTPS + basic auth, hanya endpoint push
├── blackbox/blackbox.yml       modul ping ICMP
├── alertmanager/alertmanager.yml   kirim peringatan ke backend (+ contoh Telegram)
├── backend/                    Node.js 22 + Fastify
│   ├── db/migrations/          001 tabel dasar, 002 job pemasangan & audit log
│   └── src/
│       ├── server.js           titik masuk, JWT, daftar route, LISTEN progres job
│       ├── migrate.js          jalankan migrasi database otomatis saat start
│       ├── config.js           baca variabel lingkungan
│       ├── db.js               koneksi PostgreSQL + buat admin pertama
│       ├── services/
│       │   ├── prometheus.js   semua query PromQL
│       │   ├── overview.js     gabungkan data PostgreSQL + Prometheus
│       │   ├── targets.js      tulis file target saat server ditambah/aktif/dihapus
│       │   ├── provisioner.js  klien API internal provisioner
│       │   └── audit.js        catat aksi admin
│       └── routes/
│           ├── auth.js         login, cek pengguna
│           ├── servers.js      ringkasan, daftar, tambah, hapus server
│           ├── metrics.js      data grafik
│           ├── alerts.js       daftar peringatan + webhook Alertmanager
│           ├── provision.js    tes koneksi, job pasang/copot/cek ulang, log audit
│           └── stream.js       SSE
├── provisioner/                Node.js 22 + ssh2, container terpisah tanpa port publik
│   └── src/
│       ├── index.js            API internal (dipanggil backend dengan token)
│       ├── secrets.js          kunci SSH pemantau, CA, kata sandi exporter & gateway log
│       ├── artifacts.js        unduh node_exporter/Alloy + cek checksum SHA256
│       ├── ssh.js              koneksi SSH, host key, sudo (dengan/tanpa kata sandi)
│       ├── tasks.js            langkah pasang, rollback, copot, verifikasi, tes koneksi
│       ├── templates.js        unit systemd & konfigurasi yang dipasang di target
│       └── jobs.js             status job, log, manifest perubahan
├── frontend/                   Vite + Gentelella v4 + ECharts, disajikan Nginx
│   ├── index.html              dashboard
│   ├── login.html
│   ├── nginx.conf              sajikan file + teruskan /api ke backend
│   └── src/
│       ├── api.js              semua panggilan ke backend
│       ├── main.js             isi tile, grafik, peringatan, tabel
│       ├── provision-ui.js     wizard Tambah Server, progres job, copot, log audit
│       ├── dom.js              helper elemen & komponen Gentelella
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
   Isi `PROVISIONER_TOKEN` dengan string acak panjang. Isi `MONITOR_PUBLIC_HOST` kalau ingin
   memakai fitur log. String acak bisa dibuat dengan:

   ```bash
   openssl rand -base64 32
   ```

   Database lama dari versi sebelumnya ikut diperbarui otomatis saat backend start
   (lihat `backend/src/migrate.js`).

2. Jalankan semua layanan:

   ```bash
   docker compose up -d --build
   ```

3. Buka `http://localhost:8080`, masuk dengan `ADMIN_EMAIL` dan `ADMIN_PASSWORD` dari `.env`.

4. Lanjutkan ke [Menambah server yang dipantau](#menambah-server-yang-dipantau).

## Menambah server yang dipantau

Klik **Tambah Server**. Ada dua cara:

| Cara | Kapan dipakai |
|---|---|
| **Otomatis lewat SSH** (disarankan) | Server Ubuntu/Debian yang bisa di-SSH dari server pemantau |
| **Manual** | node_exporter sudah Anda pasang sendiri (lihat bagian manual di bawah) |

### Otomatis lewat SSH

Isi nama, IP, user SSH, port SSH, lalu pilih cara login:

- **Kata sandi**: dipakai hanya selama pemasangan, tidak pernah disimpan ke database atau log.
- **Kunci SSH**: salin public key pemantau yang tampil di formulir ke
  `~/.ssh/authorized_keys` di server target. Bisa dicentang agar kunci itu dihapus
  lagi setelah selesai.
- **Kata sandi sudo**: isi kalau user-nya butuh kata sandi untuk `sudo` dan berbeda
  dari kata sandi SSH. Kosongkan untuk root atau sudo tanpa kata sandi.

Klik **Tes koneksi** dulu (tidak mengubah apa pun), lalu **Mulai pemasangan**.
Langkah-langkahnya tampil langsung di layar:

1. **Cek port SSH** dari server pemantau.
2. **Verifikasi host key.** Fingerprint server ditampilkan dan Anda konfirmasi
   (kata sandi belum dikirim sebelum ini). Cocokkan dengan hasil perintah berikut,
   dijalankan di server target lewat konsol penyedia:

   ```bash
   for k in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $k; done
   ```

   Fingerprint disimpan; kalau suatu saat berubah, koneksi ditolak.
3. **Login SSH & cek sudo.**
4. **Pemeriksaan awal** (hanya membaca): OS, arsitektur, systemd, port yang
   terpakai, layanan yang sudah ada, status ufw, sisa disk.
5. **Persetujuan rencana.** Daftar perubahan dan peringatan ditampilkan; tidak ada
   yang dipasang sebelum Anda klik **Setujui & pasang**.
6. **Pasang node_exporter** dengan TLS (sertifikat dari CA pemantau) dan basic auth.
7. **Firewall:** kalau ufw aktif, ditambah satu aturan "izinkan port exporter hanya
   dari IP pemantau". Kalau ufw tidak aktif, ufw **tidak** dinyalakan (bisa mengunci
   akses SSH Anda); cukup diberi peringatan.
8. **Agen log** (kalau dicentang): Grafana Alloy mengirim journald level warning ke
   atas dan `/var/log/auth.log` ke Loki.
9. **Verifikasi port dari server pemantau** lewat HTTPS + basic auth.
10. **Aktifkan pemantauan:** server masuk ke `nodes-secure.json`, metrik muncul
    dalam ±30 detik.

Kalau langkah 6–8 gagal atau dibatalkan, semua yang dibuat job itu di-**rollback**.
Kalau hanya langkah 9 yang gagal (biasanya port diblokir firewall penyedia cloud /
Security Group), instalasi dibiarkan; buka port-nya lalu pilih **Cek ulang port**
di menu ⋯ pada baris server.

**Jaminan "tidak merusak":**

- Semua yang dipasang bernama `pantau-…` (layanan `pantau-node-exporter` &
  `pantau-alloy`, user `pantau-exporter` & `pantau-alloy`, folder `/etc/pantau`,
  binary `/usr/local/bin/pantau-*`). node_exporter/Alloy yang sudah ada tidak disentuh.
  Kalau port 9100 sudah dipakai, dicari port kosong berikutnya.
- Tidak ada `apt upgrade`, tidak ada paket baru, tidak ada reboot.
- Binary diunduh oleh server pemantau dan dicocokkan dengan checksum SHA256 resmi,
  lalu dikirim lewat SSH. Server target tidak perlu akses internet.
- Layanan berjalan sebagai user tanpa login, dengan pembatasan systemd
  (`NoNewPrivileges`, `ProtectSystem=strict`, batas memori & CPU).
- Rollback dan pencopotan hanya mau menghapus path & user berawalan `pantau-`.
- Satu server hanya boleh punya satu job aktif.

### Menu ⋯ di setiap baris server

| Aksi | Keterangan |
|---|---|
| Lihat pemasangan terakhir / Riwayat pemasangan | Langkah, log teknis, dan siapa yang menjalankan |
| Cek ulang port | Verifikasi dari server pemantau tanpa SSH (setelah membuka Security Group) |
| Pasang ulang | Menjalankan pemasangan lagi; aman diulang |
| Hapus server | Bisa sekalian **mencopot** node_exporter, agen log & aturan ufw dari server target |

Semua aksi admin tercatat di **Log audit** (menu akun di kanan atas).

### Fitur log

Isi `MONITOR_PUBLIC_HOST` di `.env` dengan IP/DNS server pemantau yang bisa dijangkau
server target, lalu buka port `LOKI_PORT` (default 3101) dari server target ke server
pemantau. Log disimpan 14 hari (`loki/loki.yml`). Halaman untuk membaca log menyusul
di tahap berikutnya; agen yang dipasang sekarang sudah mengirim datanya.

### Manual

Pasang node_exporter sendiri, misalnya dengan Ansible:

```bash
cd ansible && cp inventory.example.ini inventory.ini
```

```bash
ansible-playbook -i inventory.ini install-node-exporter.yml
```

Pastikan port 9100 dan ping (ICMP) bisa dijangkau dari server pemantau, lalu pilih
**Manual** di formulir Tambah Server. Cek dari server pemantau:

```bash
curl -s http://IP_SERVER:9100/metrics | head
```

### Membaca status di tabel

| Status | Artinya |
|---|---|
| **Online** | Semua berjalan |
| **Online**, CPU/memori "—" | Ping berhasil, tapi metrik tidak terbaca: cek node_exporter dan firewall |
| **Offline** | Ping gagal: cek IP, atau ICMP diblokir |
| **Peringatan** | Server berjalan, tapi ada alert aktif |
| **Sedang dipasang / Menunggu konfirmasi** | Pemasangan otomatis sedang berjalan; klik untuk melihat progres |
| **Gagal dipasang / Port tak terjangkau** | Klik untuk melihat alasannya |

Kalau masih bermasalah, lihat status target di Prometheus. Kolom `lastError`
menjelaskan penyebabnya:

```bash
docker compose exec prometheus wget -qO- localhost:9090/api/v1/targets | head -c 2000
```

## Catatan keamanan

- Prometheus, Alertmanager, dan PostgreSQL tidak membuka port ke luar; hanya Nginx (port 8080).
- Port 9100 (node_exporter) di tiap server sebaiknya hanya bisa diakses dari server pemantau.
  Playbook Ansible dan pemasangan otomatis memasang aturan ufw untuk itu (kalau ufw aktif).
- Provisioner tidak membuka port ke luar. Backend memanggilnya dengan `PROVISIONER_TOKEN`.
- Kunci SSH pemantau, CA, dan kata sandi exporter ada di volume Docker `secrets`.
  Siapa pun yang bisa membaca volume ini bisa login ke server yang memakai kunci tersebut,
  jadi batasi akses root ke server pemantau.
- Gateway log (`LOKI_PORT`) hanya menerima kiriman log lewat HTTPS + basic auth;
  membaca log hanya bisa dari dalam jaringan Docker.
- Pasang HTTPS di depan Nginx (misalnya Caddy atau Certbot) sebelum dipakai lewat internet.
