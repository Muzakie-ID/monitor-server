import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
export const query = (text, params) => pool.query(text, params);

export const STEP_DEFS = {
  install: [
    ['reach', 'Cek port SSH dapat dijangkau'],
    ['hostkey', 'Verifikasi identitas server (host key)'],
    ['auth', 'Login SSH & cek hak sudo'],
    ['preflight', 'Pemeriksaan awal (hanya membaca)'],
    ['approve', 'Persetujuan rencana'],
    ['exporter', 'Pasang node_exporter (TLS + basic auth)'],
    ['firewall', 'Aturan firewall (ufw)'],
    ['logs', 'Pasang agen log'],
    ['verify', 'Verifikasi port dari server pemantau'],
    ['activate', 'Aktifkan pemantauan']
  ],
  uninstall: [
    ['reach', 'Cek port SSH dapat dijangkau'],
    ['hostkey', 'Verifikasi identitas server (host key)'],
    ['auth', 'Login SSH & cek hak sudo'],
    ['remove', 'Copot node_exporter, agen log & aturan firewall'],
    ['finish', 'Hapus server dari dashboard']
  ],
  verify: [
    ['verify', 'Verifikasi port dari server pemantau'],
    ['activate', 'Aktifkan pemantauan']
  ]
};

export class Cancelled extends Error {
  constructor() { super('Dibatalkan oleh admin'); }
}

/** Satu job yang sedang berjalan. Semua perubahan langsung disimpan & diumumkan. */
export class Job {
  constructor(row, server) {
    this.id = row.id;
    this.kind = row.kind;
    this.server = server;
    this.status = row.status;
    this.steps = row.steps?.length ? row.steps
      : STEP_DEFS[row.kind].map(([id, label]) => ({ id, label, status: 'pending', detail: null }));
    this.log = row.log ?? [];
    this.manifest = row.manifest ?? [];
    this.plan = null;
    this.fingerprint = null;
    this.error = null;
    this.cancelled = false;
    this.waiter = null; // { kind, resolve, reject, timer }
    this.saveChain = Promise.resolve();
  }

  write(level, msg) {
    this.log.push({ t: new Date().toISOString(), level, msg });
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    return this.save();
  }
  info(msg) { return this.write('info', msg); }
  warn(msg) { return this.write('warn', msg); }

  step(id, status, detail = undefined) {
    let s = this.steps.find((x) => x.id === id);
    if (!s) {
      s = { id, label: id === 'rollback' ? 'Rollback perubahan' : id, status: 'pending', detail: null };
      this.steps.push(s);
    }
    s.status = status;
    if (detail !== undefined) s.detail = detail;
    return this.save();
  }

  setStatus(status, error = null) {
    this.status = status;
    if (error) this.error = error;
    return this.save();
  }

  record(entry) {
    this.manifest.push(entry);
    return this.save();
  }

  checkCancelled() {
    if (this.cancelled) throw new Cancelled();
  }

  // Penyimpanan diurutkan supaya update yang lebih lama tidak menimpa yang baru
  save() {
    this.saveChain = this.saveChain.then(async () => {
      await query(
        `UPDATE provision_jobs SET status=$2, steps=$3, log=$4, plan=$5, fingerprint=$6,
                manifest=$7, error=$8, updated_at=now() WHERE id=$1`,
        [this.id, this.status, JSON.stringify(this.steps), JSON.stringify(this.log),
          this.plan ? JSON.stringify(this.plan) : null, this.fingerprint,
          JSON.stringify(this.manifest), this.error]
      );
      await notify({ jobId: this.id, serverId: this.server?.id ?? null, status: this.status });
    }).catch((err) => console.error(`Gagal menyimpan job ${this.id}:`, err.message));
    return this.saveChain;
  }

  /** Jeda sampai admin menjawab (host key / rencana), dengan batas waktu. */
  waitFor(kind) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('Batas waktu menunggu persetujuan (15 menit) habis.'));
      }, config.approvalTimeoutMs);
      this.waiter = { kind, resolve, reject, timer };
    });
  }

  answer(kind, accepted) {
    if (!this.waiter || this.waiter.kind !== kind) return false;
    const w = this.waiter;
    this.waiter = null;
    clearTimeout(w.timer);
    accepted ? w.resolve() : w.reject(new Cancelled());
    return true;
  }

  cancel() {
    this.cancelled = true;
    if (this.waiter) this.answer(this.waiter.kind, false);
  }
}

export async function notify(payload) {
  await query("SELECT pg_notify('provision', $1)", [JSON.stringify(payload)]);
}

export async function audit(action, target, detail = {}) {
  await query(
    "INSERT INTO audit_log (user_name, action, target, detail) VALUES ('sistem', $1, $2, $3)",
    [action, target, JSON.stringify(detail)]
  ).catch(() => {});
}

export async function loadJob(id) {
  const { rows: [row] } = await query('SELECT * FROM provision_jobs WHERE id = $1', [id]);
  if (!row) return null;
  const { rows: [server] } = await query(
    `SELECT id, name, host(ip) AS ip, exporter_port, ssh_user, ssh_port, host_key_fingerprint,
            collect_logs, install_manifest, provision_status
       FROM servers WHERE id = $1`, [row.server_id]);
  return new Job(row, server ?? null);
}

export async function updateServer(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = keys.map((k) => (typeof fields[k] === 'object' && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]));
  await query(`UPDATE servers SET ${sets} WHERE id = $1`, [id, ...values]);
}

/**
 * Job yang tertinggal saat provisioner mati tidak bisa dilanjutkan, karena kata sandi
 * tidak pernah disimpan. Tandai gagal supaya admin bisa mengulang.
 */
export async function failStaleJobs() {
  const { rows } = await query(
    `UPDATE provision_jobs SET status = 'failed', updated_at = now(),
            error = 'Provisioner dimulai ulang saat job berjalan. Kata sandi tidak disimpan, jadi silakan ulangi.'
      WHERE status IN ('queued', 'running', 'awaiting_hostkey', 'awaiting_approval')
      RETURNING server_id, kind`);
  for (const r of rows) {
    if (!r.server_id || r.kind === 'verify') continue;
    // Copot yang terputus: komponen kemungkinan masih terpasang, jadi kembali ke "ready"
    const next = r.kind === 'uninstall' ? 'ready' : 'failed';
    await query(
      "UPDATE servers SET provision_status = $2 WHERE id = $1 AND provision_status IN ('pending','provisioning','removing')",
      [r.server_id, next]);
  }
  return rows.length;
}
