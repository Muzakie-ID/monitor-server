import https from 'node:https';
import { gzipSync } from 'node:zlib';
import { config } from './config.js';
import { secrets, issueCert } from './secrets.js';
import { getBinary, versionOf } from './artifacts.js';
import { Remote, checkTcp, shq, SshError } from './ssh.js';
import { P, exporterUnit, exporterWebConfig, alloyUnit, alloyConfig } from './templates.js';
import { Cancelled, updateServer, notify, audit, query } from './jobs.js';

const ARCH = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' };
const SUPPORTED_OS = ['ubuntu', 'debian'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseKv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// Pengaman rollback/copot: hanya path & user milik Pantau yang boleh dihapus.
function assertOurs(entry) {
  const ok =
    (entry.type === 'user' && /^pantau-[a-z]+$/.test(entry.name)) ||
    (entry.type === 'service' && /^pantau-[a-z-]+$/.test(entry.name)) ||
    (['file', 'dir'].includes(entry.type) &&
      /^(\/etc\/pantau(\/|$)|\/var\/lib\/pantau-|\/usr\/local\/bin\/pantau-|\/etc\/systemd\/system\/pantau-)/.test(entry.path) &&
      !entry.path.includes('..')) ||
    (entry.type === 'ufw' && /^allow proto tcp from [0-9a-fA-F.:]+ to any port \d+ comment 'pantau-server'$/.test(entry.spec));
  if (!ok) throw new Error(`Menolak menghapus sesuatu di luar milik Pantau: ${JSON.stringify(entry)}`);
}

async function undoEntry(remote, e) {
  assertOurs(e);
  switch (e.type) {
    case 'service':
      return remote.root(`systemctl disable --now ${e.name} 2>/dev/null; rm -f /etc/systemd/system/${e.name}.service; systemctl daemon-reload`);
    case 'file': return remote.root(`rm -f ${shq(e.path)}`);
    case 'dir': return remote.root(`rm -rf ${shq(e.path)}`);
    case 'user': return remote.root(`id -u ${e.name} >/dev/null 2>&1 && userdel ${e.name} || true`);
    case 'ufw': return remote.root(`ufw delete ${e.spec}`);
    default: return null;
  }
}

// ─────────────────────────────────────────────
//  Koneksi: port SSH → host key → login & sudo
// ─────────────────────────────────────────────
async function connect(job, creds, { acceptedFingerprint } = {}) {
  const s = job.server;
  const port = s.ssh_port ?? 22;

  await job.step('reach', 'running');
  const tcp = await checkTcp(s.ip, port);
  if (!tcp.ok) {
    throw new Error(`Port SSH ${port} di ${s.ip} tidak bisa dijangkau (${tcp.reason}). Cek IP, port SSH, dan firewall/Security Group.`);
  }
  await job.step('reach', 'done', `${s.ip}:${port} terbuka`);
  job.checkCancelled();

  await job.step('hostkey', 'running');
  let expected = s.host_key_fingerprint;
  if (!expected) {
    const fp = await Remote.fetchHostKey(s.ip, port);
    if (acceptedFingerprint && acceptedFingerprint === fp) {
      await job.info(`Host key ${fp} sudah dikonfirmasi admin saat tes koneksi.`);
    } else {
      // Belum ada kata sandi/kunci yang dikirim sampai admin mengonfirmasi fingerprint ini
      job.fingerprint = fp;
      await job.step('hostkey', 'waiting', fp);
      await job.setStatus('awaiting_hostkey');
      await job.waitFor('hostkey');
      job.fingerprint = null;
      await job.setStatus('running');
      await job.info(`Admin mengonfirmasi host key ${fp}.`);
    }
    expected = fp;
    await updateServer(s.id, { host_key_fingerprint: fp });
    s.host_key_fingerprint = fp;
  }
  await job.step('hostkey', 'done', expected);
  job.checkCancelled();

  await job.step('auth', 'running');
  const remote = new Remote({ host: s.ip, port, user: s.ssh_user }, creds);
  await remote.connect({ expectedFingerprint: expected });
  try {
    const mode = await remote.detectSudo();
    const label = { root: 'login sebagai root', nopasswd: 'sudo tanpa kata sandi', password: 'sudo dengan kata sandi' }[mode];
    await job.step('auth', 'done', `Masuk sebagai ${s.ssh_user}; ${label}`);
  } catch (err) {
    remote.close();
    throw err;
  }
  return remote;
}

// ─────────────────────────────────────────────
//  Pemeriksaan awal: hanya membaca
// ─────────────────────────────────────────────
const PREFLIGHT = `
. /etc/os-release 2>/dev/null
echo "os_id=$ID"; echo "os_like=$ID_LIKE"; echo "os_name=$PRETTY_NAME"
echo "arch=$(uname -m)"
[ -d /run/systemd/system ] && echo systemd=yes || echo systemd=no
echo "listening=$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\\n' ',')"
if [ -f /etc/systemd/system/${P.exporterService}.service ]; then
  echo "pantau_exporter_port=$(grep -o 'listen-address=:[0-9]*' /etc/systemd/system/${P.exporterService}.service | cut -d: -f2)"
fi
[ -f /etc/systemd/system/${P.alloyService}.service ] && echo pantau_alloy=yes
for u in node_exporter prometheus-node-exporter; do systemctl is-active --quiet $u 2>/dev/null && echo "other_exporter=$u"; done
systemctl is-active --quiet alloy 2>/dev/null && echo other_alloy=yes
if command -v ufw >/dev/null 2>&1; then echo "ufw=$(ufw status 2>/dev/null | head -1 | awk '{print $2}')"; else echo ufw=none; fi
echo "free_tmp_kb=$(df -Pk /tmp | awk 'NR==2{print $4}')"
echo "free_usr_kb=$(df -Pk /usr/local | awk 'NR==2{print $4}')"
echo "mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)"
[ -e /var/log/auth.log ] && echo auth_log=yes
command -v gzip >/dev/null 2>&1 && echo gzip=yes
`;

async function preflight(job, remote, { collectLogs }) {
  await job.step('preflight', 'running');
  const info = parseKv(await remote.rootOk(PREFLIGHT, 'Pemeriksaan awal'));
  const src = (await remote.exec('echo "${SSH_CLIENT%% *}"')).stdout.trim();
  info.source_ip = config.sourceIp || src;

  const errors = [];
  const warnings = [];
  const osOk = SUPPORTED_OS.includes(info.os_id) || SUPPORTED_OS.some((o) => (info.os_like ?? '').includes(o));
  if (!osOk) errors.push(`Sistem operasi "${info.os_name || info.os_id || 'tidak dikenal'}" belum didukung (hanya Ubuntu/Debian).`);
  info.goarch = ARCH[info.arch];
  if (!info.goarch) errors.push(`Arsitektur ${info.arch} belum didukung (hanya x86_64 dan aarch64).`);
  if (info.systemd !== 'yes') errors.push('systemd tidak ditemukan; layanan tidak bisa dipasang.');
  if (info.gzip !== 'yes') errors.push('Perintah gzip tidak ada di server.');
  if (!info.source_ip) errors.push('Tidak bisa menentukan IP server pemantau yang terlihat dari server ini.');

  // Port: pakai port instalasi Pantau sebelumnya, atau cari yang kosong mulai dari port pilihan
  const used = new Set((info.listening ?? '').split(',').filter(Boolean).map(Number));
  let port = Number(info.pantau_exporter_port) || null;
  if (!port) {
    const wanted = job.server.exporter_port || 9100;
    port = [...Array(50).keys()].map((i) => wanted + i).find((p) => !used.has(p)) ?? null;
    if (!port) errors.push(`Tidak ada port kosong di rentang ${wanted}–${wanted + 49}.`);
    else if (port !== wanted) warnings.push(`Port ${wanted} sudah dipakai program lain, jadi node_exporter Pantau memakai port ${port}.`);
  }
  info.port = port;

  if (info.other_exporter) {
    warnings.push(`Sudah ada layanan "${info.other_exporter}". Tidak disentuh; Pantau memasang node_exporter sendiri.`);
  }
  if (info.ufw !== 'active') {
    warnings.push(`ufw tidak aktif${info.ufw === 'none' ? ' (tidak terpasang)' : ''}: aturan firewall tidak ditambahkan. ` +
      `Port ${port} bisa diakses dari jaringan, tetapi tetap dilindungi TLS + basic auth.`);
  }

  info.logs = collectLogs && !!config.publicHost;
  if (collectLogs && !config.publicHost) {
    warnings.push('Agen log dilewati: MONITOR_PUBLIC_HOST belum diisi di server pemantau.');
  }
  if (info.logs && info.other_alloy) warnings.push('Sudah ada layanan "alloy". Tidak disentuh; Pantau memasang agen log sendiri.');
  if (info.logs && info.auth_log !== 'yes') warnings.push('/var/log/auth.log tidak ada; hanya log journald yang dikumpulkan.');

  const needKb = info.logs ? 700_000 : 80_000;
  if (Number(info.free_tmp_kb) < needKb || Number(info.free_usr_kb) < needKb) {
    errors.push(`Ruang disk kurang: butuh sekitar ${Math.round(needKb / 1000)} MB kosong di /tmp dan /usr/local.`);
  }

  const detail = `${info.os_name ?? info.os_id}, ${info.arch}, ufw: ${info.ufw}`;
  await job.step('preflight', errors.length ? 'failed' : 'done', errors.length ? `${detail} — ${errors.join(' ')}` : detail);
  return { info, errors, warnings };
}

function buildPlan(job, { info, warnings }) {
  const items = [
    `${info.pantau_exporter_port ? 'Memperbarui' : 'Memasang'} node_exporter v${versionOf('nodeExporter')} sebagai layanan "${P.exporterService}" di port ${info.port}`,
    `Membuat user sistem "${P.exporterUser}" (tanpa login) bila belum ada`,
    `Menyimpan sertifikat TLS & konfigurasi di ${P.exporterDir}`
  ];
  if (info.ufw === 'active') items.push(`Menambah aturan ufw: izinkan TCP ${info.port} hanya dari ${info.source_ip}`);
  if (info.logs) {
    items.push(`Memasang agen log Grafana Alloy v${versionOf('alloy')} sebagai layanan "${P.alloyService}" (journald level warning ke atas + auth.log)`);
    items.push(`Membuat user sistem "${P.alloyUser}" dengan akses baca log (grup systemd-journal & adm)`);
  }
  return {
    items,
    warnings,
    untouched: 'Tidak ada paket yang di-update, tidak ada reboot, layanan lain tidak disentuh.',
    port: info.port,
    sourceIp: info.source_ip,
    os: info.os_name,
    logs: info.logs
  };
}

// ─────────────────────────────────────────────
//  Perubahan (semuanya dicatat di manifest)
// ─────────────────────────────────────────────
async function ensureUser(job, remote, name, groups = []) {
  const exists = (await remote.root(`id -u ${name} >/dev/null 2>&1`)).code === 0;
  if (!exists) {
    await job.record({ type: 'user', name });
    await remote.rootOk(`useradd --system --no-create-home --shell /usr/sbin/nologin ${name}`, `Membuat user ${name}`);
  }
  for (const g of groups) {
    await remote.root(`getent group ${g} >/dev/null && usermod -aG ${g} ${name}`);
  }
}

async function ensureDir(job, remote, path, mode, owner) {
  const exists = (await remote.root(`test -d ${shq(path)}`)).code === 0;
  if (!exists) await job.record({ type: 'dir', path });
  await remote.rootOk(`install -d -m ${mode} -o ${owner.split(':')[0]} -g ${owner.split(':')[1]} ${shq(path)}`, `Membuat folder ${path}`);
}

async function placeFile(job, remote, tmp, name, content, dest, mode, owner, { binary = false } = {}) {
  const exists = (await remote.root(`test -e ${shq(dest)}`)).code === 0;
  if (!exists) await job.record({ type: 'file', path: dest });
  const [u, g] = owner.split(':');
  if (binary) {
    // Dikompres saat dikirim supaya hemat bandwidth, dibuka lagi di server target
    const src = await remote.upload(tmp, `${name}.gz`, gzipSync(content));
    await remote.rootOk(`gzip -dc ${shq(src)} > ${shq(`${src}.bin`)} && install -m ${mode} -o ${u} -g ${g} ${shq(`${src}.bin`)} ${shq(dest)}`, `Memasang ${dest}`);
  } else {
    const src = await remote.upload(tmp, name, content);
    await remote.rootOk(`install -m ${mode} -o ${u} -g ${g} ${shq(src)} ${shq(dest)}`, `Memasang ${dest}`);
  }
}

async function startService(job, remote, name, port) {
  const existed = (await remote.root(`test -f /etc/systemd/system/${name}.service`)).code === 0;
  if (!existed) await job.record({ type: 'service', name });
  await remote.rootOk(`systemctl daemon-reload && systemctl enable ${name} >/dev/null 2>&1 && systemctl restart ${name}`, `Menjalankan ${name}`);
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const active = (await remote.root(`systemctl is-active --quiet ${name}`)).code === 0;
    const listening = !port || (await remote.root(`ss -ltnH 'sport = :${port}' | grep -q .`)).code === 0;
    if (active && listening) return;
  }
  const status = await remote.root(`journalctl -u ${name} -n 5 --no-pager 2>/dev/null`);
  throw new Error(`Layanan ${name} tidak mau berjalan. Log terakhir: ${status.stdout.trim().split('\n').slice(-3).join(' | ')}`);
}

async function installExporter(job, remote, tmp, info) {
  await job.step('exporter', 'running');
  const bin = await getBinary('nodeExporter', info.goarch, (lvl, m) => job.write(lvl, m));
  const { cert, key } = await issueCert(job.server.ip);
  const grp = `root:${P.exporterUser}`;

  await ensureUser(job, remote, P.exporterUser);
  await ensureDir(job, remote, P.rootDir, '0755', 'root:root');
  await ensureDir(job, remote, P.exporterDir, '0750', grp);
  await placeFile(job, remote, tmp, 'node_exporter', bin, P.exporterBin, '0755', 'root:root', { binary: true });
  await placeFile(job, remote, tmp, 'web.yml', exporterWebConfig(await secrets.exporterPasswordHash()), `${P.exporterDir}/web.yml`, '0640', grp);
  await placeFile(job, remote, tmp, 'tls.crt', cert, `${P.exporterDir}/tls.crt`, '0644', grp);
  await placeFile(job, remote, tmp, 'tls.key', key, `${P.exporterDir}/tls.key`, '0640', grp);
  await placeFile(job, remote, tmp, 'exporter.service', exporterUnit(info.port), `/etc/systemd/system/${P.exporterService}.service`, '0644', 'root:root');
  await startService(job, remote, P.exporterService, info.port);
  await job.step('exporter', 'done', `Berjalan di port ${info.port} dengan TLS + basic auth`);
}

async function configureFirewall(job, remote, info) {
  if (info.ufw !== 'active') {
    await job.step('firewall', 'skipped', 'ufw tidak aktif; tidak ada aturan yang ditambahkan');
    return;
  }
  await job.step('firewall', 'running');
  const spec = `allow proto tcp from ${info.source_ip} to any port ${info.port} comment '${P.ufwComment}'`;
  const existing = await remote.root(`ufw status | grep -E '^${info.port}/tcp +ALLOW +${info.source_ip.replaceAll('.', '\\.')}( |$)'`);
  if (existing.code === 0) {
    await job.step('firewall', 'done', 'Aturan sudah ada sebelumnya');
    return;
  }
  await job.record({ type: 'ufw', spec });
  await remote.rootOk(`ufw ${spec}`, 'Menambah aturan ufw');
  await job.step('firewall', 'done', `Izinkan TCP ${info.port} dari ${info.source_ip}`);
}

async function installLogs(job, remote, tmp, info) {
  if (!info.logs) {
    await job.step('logs', 'skipped', job.server.collect_logs ? 'MONITOR_PUBLIC_HOST belum diisi' : 'Tidak dipilih');
    return;
  }
  await job.step('logs', 'running');
  const bin = await getBinary('alloy', info.goarch, (lvl, m) => job.write(lvl, m));
  const grp = `root:${P.alloyUser}`;
  const lokiUrl = `https://${config.publicHost}:${config.lokiPort}/loki/api/v1/push`;

  await ensureUser(job, remote, P.alloyUser, ['systemd-journal', 'adm']);
  await ensureDir(job, remote, P.rootDir, '0755', 'root:root');
  await ensureDir(job, remote, P.alloyDir, '0750', grp);
  await ensureDir(job, remote, P.alloyData, '0750', `${P.alloyUser}:${P.alloyUser}`);
  await placeFile(job, remote, tmp, 'alloy', bin, P.alloyBin, '0755', 'root:root', { binary: true });
  await placeFile(job, remote, tmp, 'config.alloy', alloyConfig({ server: job.server.name, lokiUrl }), `${P.alloyDir}/config.alloy`, '0640', grp);
  await placeFile(job, remote, tmp, 'password', await secrets.lokiPassword(), `${P.alloyDir}/password`, '0640', grp);
  await placeFile(job, remote, tmp, 'ca.crt', await secrets.caCert(), `${P.alloyDir}/ca.crt`, '0644', grp);
  await placeFile(job, remote, tmp, 'alloy.service', alloyUnit(), `/etc/systemd/system/${P.alloyService}.service`, '0644', 'root:root');
  await startService(job, remote, P.alloyService, null);
  await job.step('logs', 'done', `Mengirim log ke ${config.publicHost}:${config.lokiPort}`);
}

async function rollback(job, remote) {
  if (!job.manifest.length) return;
  await job.step('rollback', 'running');
  await job.warn('Membatalkan perubahan yang dibuat job ini…');
  for (const e of [...job.manifest].reverse()) {
    try {
      await undoEntry(remote, e);
    } catch (err) {
      await job.warn(`Rollback ${e.type} ${e.path ?? e.name ?? e.spec}: ${err.message}`);
    }
  }
  job.manifest = [];
  await job.step('rollback', 'done', 'Perubahan dibatalkan; server kembali seperti sebelumnya');
}

// ─────────────────────────────────────────────
//  Verifikasi dari server pemantau
// ─────────────────────────────────────────────
async function scrapeOnce(ip, port) {
  const [ca, pw] = await Promise.all([secrets.caCert(), secrets.exporterPassword()]);
  return new Promise((resolve, reject) => {
    const req = https.get({ host: ip, port, path: '/metrics', ca, auth: `pantau:${pw}`, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => { if (body.length < 65536) body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

async function verify(job, ip, port, sourceIp) {
  await job.step('verify', 'running');
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await scrapeOnce(ip, port);
      if (r.status === 401) throw new Error('Basic auth ditolak node_exporter.');
      if (r.status !== 200 || !r.body.includes('node_')) throw new Error(`Jawaban tidak terduga (HTTP ${r.status}).`);
      await job.step('verify', 'done', `https://${ip}:${port}/metrics terbaca`);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(3000);
    }
  }
  const code = lastErr.code ?? '';
  let msg;
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') {
    msg = `node_exporter berjalan, tetapi port ${port} tidak bisa dijangkau dari server pemantau. ` +
      `Kemungkinan diblokir firewall penyedia cloud (Security Group). Izinkan TCP ${port}` +
      `${sourceIp ? ` dari ${sourceIp}` : ''}, lalu klik "Cek ulang port".`;
  } else if (code === 'ECONNREFUSED') {
    msg = `Port ${port} menolak koneksi. Pastikan layanan ${P.exporterService} berjalan.`;
  } else if (/certificate|CERT|self.signed/i.test(`${code} ${lastErr.message}`)) {
    msg = `Sertifikat TLS tidak cocok: ${lastErr.message}`;
  } else {
    msg = lastErr.message;
  }
  await job.step('verify', 'failed', msg);
  throw new Error(msg);
}

async function activate(job, port) {
  await job.step('activate', 'running');
  await updateServer(job.server.id, { provision_status: 'ready', exporter_port: port });
  await notify({ type: 'sync-targets' });
  await job.step('activate', 'done', 'Prometheus mulai mengambil metrik dalam ±30 detik');
}

async function removeOwnKey(job, remote) {
  const pub = await secrets.sshPublicKey();
  const body = pub.split(' ')[1];
  const r = await remote.exec(
    `f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0; grep -vF ${shq(body)} "$f" > "$f.pantau" ; cat "$f.pantau" > "$f"; rm -f "$f.pantau"`);
  if (r.code === 0) await job.info('Kunci SSH pemantau dihapus dari authorized_keys.');
  else await job.warn(`Gagal menghapus kunci SSH pemantau: ${r.stderr.trim()}`);
}

const mergeManifest = (a = [], b = []) => {
  const seen = new Set();
  return [...a, ...b].filter((e) => {
    const k = JSON.stringify(e);
    return seen.has(k) ? false : seen.add(k);
  });
};

// ─────────────────────────────────────────────
//  Job: install
// ─────────────────────────────────────────────
export async function runInstall(job, creds, opts) {
  const s = job.server;
  const prevStatus = s.provision_status;
  let remote;
  let changed = false;
  try {
    await job.setStatus('running');
    await updateServer(s.id, { provision_status: 'provisioning' });
    await notify({ type: 'servers' });

    remote = await connect(job, creds, opts);
    const pre = await preflight(job, remote, { collectLogs: s.collect_logs });
    if (pre.errors.length) throw new Error(pre.errors.join(' '));

    job.plan = buildPlan(job, pre);
    await job.step('approve', 'waiting');
    await job.setStatus('awaiting_approval');
    await job.waitFor('approve');
    job.plan = null;
    await job.setStatus('running');
    await job.step('approve', 'done', 'Disetujui admin');

    const { info } = pre;
    const tmp = (await remote.exec('mktemp -d /tmp/pantau.XXXXXX')).stdout.trim();
    if (!tmp.startsWith('/tmp/pantau.')) throw new Error('Gagal membuat folder sementara di /tmp.');
    changed = true;
    try {
      job.checkCancelled();
      await installExporter(job, remote, tmp, info);
      job.checkCancelled();
      await configureFirewall(job, remote, info);
      job.checkCancelled();
      await installLogs(job, remote, tmp, info);
    } catch (err) {
      const step = job.steps.find((x) => x.status === 'running');
      if (step) await job.step(step.id, 'failed', err.message);
      await job.write('error', err.message);
      err.logged = true;
      await rollback(job, remote);
      changed = false;
      throw err;
    } finally {
      await remote.exec(`rm -rf ${shq(tmp)}`).catch(() => {});
    }

    // Instalasi berhasil: simpan sekarang supaya "Cek ulang port" & copot tetap bisa dipakai
    await updateServer(s.id, {
      exporter_port: info.port,
      install_manifest: mergeManifest(s.install_manifest, job.manifest)
    });

    if (creds.authMethod === 'key' && creds.removeKey) await removeOwnKey(job, remote);
    remote.close();
    remote = null;

    await verify(job, s.ip, info.port, info.source_ip);
    await activate(job, info.port);
    await job.setStatus('succeeded');
    await audit('provision.succeeded', s.name, { jobId: job.id });
  } catch (err) {
    const cancelled = err instanceof Cancelled;
    const msg = cancelled ? 'Dibatalkan oleh admin.' : err.message;
    const running = job.steps.find((x) => ['running', 'waiting'].includes(x.status));
    if (running) await job.step(running.id, cancelled ? 'skipped' : 'failed', running.detail ?? msg);
    if (!err.logged) await job.write(cancelled ? 'warn' : 'error', msg);
    job.plan = null;
    job.fingerprint = null;
    await job.setStatus(cancelled ? 'cancelled' : 'failed', msg);
    // Gagal sebelum ada perubahan pada server yang sudah aktif → tetap aktif
    const next = !changed && prevStatus === 'ready' ? 'ready' : 'failed';
    await updateServer(s.id, { provision_status: next });
    await audit(cancelled ? 'provision.cancelled' : 'provision.failed', s.name, { jobId: job.id, error: msg });
  } finally {
    remote?.close();
    await notify({ type: 'servers' });
  }
}

// ─────────────────────────────────────────────
//  Job: uninstall (copot lalu hapus server)
// ─────────────────────────────────────────────
const UNINSTALL = `
for s in ${P.exporterService} ${P.alloyService}; do
  systemctl disable --now $s >/dev/null 2>&1
  rm -f /etc/systemd/system/$s.service
done
systemctl daemon-reload
rm -f ${P.exporterBin} ${P.alloyBin}
rm -rf ${P.rootDir} ${P.alloyData}
for u in ${P.exporterUser} ${P.alloyUser}; do id -u $u >/dev/null 2>&1 && userdel $u; done
exit 0
`;

export async function runUninstall(job, creds) {
  const s = job.server;
  let remote;
  try {
    await job.setStatus('running');
    await updateServer(s.id, { provision_status: 'removing' });
    await notify({ type: 'servers' });
    remote = await connect(job, creds);

    await job.step('remove', 'running');
    await remote.rootOk(UNINSTALL, 'Mencopot layanan Pantau');
    for (const e of (s.install_manifest ?? []).filter((x) => x.type === 'ufw')) {
      assertOurs(e);
      const r = await remote.root(`ufw delete ${e.spec}`);
      await job.info(r.code === 0 ? `Aturan ufw dihapus: ${e.spec}` : `Aturan ufw tidak ditemukan: ${e.spec}`);
    }
    if (creds.authMethod === 'key' && creds.removeKey) await removeOwnKey(job, remote);
    await job.step('remove', 'done', 'node_exporter, agen log, user & aturan firewall Pantau dihapus');

    await job.step('finish', 'running');
    await query('DELETE FROM servers WHERE id = $1', [s.id]);
    await notify({ type: 'sync-targets' });
    await job.step('finish', 'done');
    await job.setStatus('succeeded');
    await audit('server.uninstalled', s.name, { jobId: job.id });
  } catch (err) {
    const cancelled = err instanceof Cancelled;
    const msg = cancelled ? 'Dibatalkan oleh admin.' : err.message;
    const running = job.steps.find((x) => ['running', 'waiting'].includes(x.status));
    if (running) await job.step(running.id, cancelled ? 'skipped' : 'failed', msg);
    await job.write(cancelled ? 'warn' : 'error', msg);
    job.fingerprint = null;
    await job.setStatus(cancelled ? 'cancelled' : 'failed', msg);
    await updateServer(s.id, { provision_status: 'ready' }).catch(() => {});
  } finally {
    remote?.close();
    await notify({ type: 'servers' });
  }
}

// ─────────────────────────────────────────────
//  Job: verify (Cek ulang port, tanpa SSH)
// ─────────────────────────────────────────────
export async function runVerify(job) {
  const s = job.server;
  try {
    await job.setStatus('running');
    await verify(job, s.ip, s.exporter_port, null);
    await activate(job, s.exporter_port);
    await job.setStatus('succeeded');
  } catch (err) {
    await job.write('error', err.message);
    await job.setStatus('failed', err.message);
  } finally {
    await notify({ type: 'servers' });
  }
}

// ─────────────────────────────────────────────
//  Tes koneksi (tanpa perubahan apa pun)
// ─────────────────────────────────────────────
export async function testConnection({ ip, sshPort = 22, sshUser, savedFingerprint, acceptedFingerprint }, creds) {
  const steps = [];
  const add = (id, label, status, detail) => steps.push({ id, label, status, detail });
  const result = { ok: false, steps };

  const tcp = await checkTcp(ip, sshPort);
  if (!tcp.ok) {
    add('reach', 'Port SSH dapat dijangkau', 'failed', `${ip}:${sshPort} tidak bisa dijangkau (${tcp.reason})`);
    return result;
  }
  add('reach', 'Port SSH dapat dijangkau', 'done', `${ip}:${sshPort} terbuka`);

  let fp;
  try {
    fp = await Remote.fetchHostKey(ip, sshPort);
  } catch (err) {
    add('hostkey', 'Identitas server (host key)', 'failed', err.message);
    return result;
  }
  result.fingerprint = fp;
  if (savedFingerprint && savedFingerprint !== fp) {
    add('hostkey', 'Identitas server (host key)', 'failed', `Host key BERUBAH: tersimpan ${savedFingerprint}, sekarang ${fp}`);
    return result;
  }
  if (!savedFingerprint && acceptedFingerprint !== fp) {
    add('hostkey', 'Identitas server (host key)', 'waiting', fp);
    result.needsHostkeyConfirm = true;
    return result; // kata sandi belum dikirim sebelum admin mengonfirmasi
  }
  add('hostkey', 'Identitas server (host key)', 'done', fp);

  const remote = new Remote({ host: ip, port: sshPort, user: sshUser }, creds);
  try {
    await remote.connect({ expectedFingerprint: fp });
    const mode = await remote.detectSudo();
    add('auth', 'Login SSH & hak sudo', 'done',
      `Masuk sebagai ${sshUser}; ${{ root: 'login sebagai root', nopasswd: 'sudo tanpa kata sandi', password: 'sudo dengan kata sandi' }[mode]}`);
    const info = parseKv((await remote.exec('. /etc/os-release; echo "id=$ID"; echo "like=$ID_LIKE"; echo "name=$PRETTY_NAME"; echo "arch=$(uname -m)"')).stdout);
    const osOk = SUPPORTED_OS.includes(info.id) || SUPPORTED_OS.some((o) => (info.like ?? '').includes(o));
    const archOk = !!ARCH[info.arch];
    add('os', 'Sistem operasi didukung', osOk && archOk ? 'done' : 'failed',
      `${info.name ?? info.id} (${info.arch})${osOk ? '' : ' — hanya Ubuntu/Debian'}${archOk ? '' : ' — arsitektur tidak didukung'}`);
    result.ok = osOk && archOk;
  } catch (err) {
    add('auth', 'Login SSH & hak sudo', 'failed', err instanceof SshError ? err.message : `Gagal: ${err.message}`);
  } finally {
    remote.close();
  }
  return result;
}
