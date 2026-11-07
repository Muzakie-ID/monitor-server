// Antarmuka pemasangan otomatis lewat SSH: wizard Tambah Server, tes koneksi,
// layar progres job (konfirmasi host key & persetujuan rencana), pasang ulang,
// copot, riwayat, dan log audit. Semua memakai komponen Gentelella v4.
import { showModal, closeModal } from 'gentelella/v4/modal';
import { showToast } from 'gentelella/v4/toast';
import { api } from './api.js';
import { el, icon, ICONS, alertBox, field, check, busy, fmtTime, emptyState } from './dom.js';

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
let info = null; // { publicKey, logsAvailable }

async function provisionInfo() {
  info ??= await api.provisionInfo().catch(() => ({ publicKey: null, logsAvailable: false }));
  return info;
}

// ─────────────────────────────────────────────
//  Kolom kredensial SSH (dipakai tambah, pasang ulang, copot)
// ─────────────────────────────────────────────
function credentialFields({ user = 'root', port = 22, publicKey, prefix = 'c' }) {
  const sshUser = el('input', { id: `${prefix}-user`, className: 'form-control', value: user, autocomplete: 'off', spellcheck: false });
  const sshPort = el('input', { id: `${prefix}-port`, className: 'form-control', type: 'number', min: 1, max: 65535, value: port });

  const methodPw = el('button', { type: 'button', className: 'btn btn-outline btn-sm active', textContent: 'Kata sandi', ariaPressed: 'true' });
  const methodKey = el('button', { type: 'button', className: 'btn btn-outline btn-sm', textContent: 'Kunci SSH', ariaPressed: 'false' });
  const methodGroup = el('div', { className: 'btn-group', role: 'group', ariaLabel: 'Cara login' }, methodPw, methodKey);

  const password = el('input', { id: `${prefix}-pw`, className: 'form-control', type: 'password', autocomplete: 'new-password' });
  const sudoPassword = el('input', { id: `${prefix}-sudo`, className: 'form-control', type: 'password', autocomplete: 'new-password' });
  const pwGroup = field('Kata sandi SSH', password);

  const keyBox = el('textarea', { className: 'form-control', readOnly: true, rows: 3, value: publicKey ?? 'Public key belum tersedia (provisioner belum berjalan).', style: 'font-family:var(--font-mono);font-size:11.5px;height:auto' });
  const copyBtn = el('button', { type: 'button', className: 'btn btn-outline btn-sm', disabled: !publicKey }, icon(ICONS.key), 'Salin public key');
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(publicKey); showToast('Public key disalin', { variant: 'success' }); }
    catch { keyBox.select(); }
  });
  const removeKey = check(`${prefix}-rmkey`, 'Hapus kunci pemantau dari server setelah selesai');
  const keyGroup = el('div', { className: 'form-group', hidden: true },
    el('div', { className: 'form-label', textContent: 'Public key server pemantau' }),
    keyBox,
    el('div', { className: 'form-hint' }, 'Tambahkan baris ini ke ', el('code', { textContent: '~/.ssh/authorized_keys' }), ' milik user SSH di server target.'),
    el('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:8px' }, copyBtn, removeKey.node));

  let method = 'password';
  const setMethod = (m) => {
    method = m;
    methodPw.classList.toggle('active', m === 'password');
    methodKey.classList.toggle('active', m === 'key');
    methodPw.ariaPressed = String(m === 'password');
    methodKey.ariaPressed = String(m === 'key');
    pwGroup.hidden = m !== 'password';
    keyGroup.hidden = m !== 'key';
  };
  methodPw.addEventListener('click', () => setMethod('password'));
  methodKey.addEventListener('click', () => setMethod('key'));

  const node = el('div', {},
    el('div', { className: 'row col-2', style: 'margin-bottom:0' },
      field('User SSH', sshUser, 'Root, atau user dengan hak sudo'),
      field('Port SSH', sshPort)),
    el('div', { className: 'form-group' }, el('div', { className: 'form-label', textContent: 'Cara login' }), methodGroup),
    pwGroup,
    keyGroup,
    field('Kata sandi sudo (opsional)', sudoPassword,
      'Kosongkan jika sama dengan kata sandi SSH, jika login sebagai root, atau jika sudo tanpa kata sandi.'));

  return {
    node,
    validate() {
      const okUser = /^[a-z_][a-z0-9_.-]{0,31}$/.test(sshUser.value.trim());
      const okPw = method === 'key' || password.value.length > 0;
      sshUser.classList.toggle('is-invalid', !okUser);
      password.classList.toggle('is-invalid', !okPw);
      return okUser && okPw ? null : !okUser ? 'User SSH tidak valid.' : 'Kata sandi SSH wajib diisi.';
    },
    read() {
      return {
        user: sshUser.value.trim(),
        port: Number(sshPort.value) || 22,
        authMethod: method,
        ...(method === 'password' ? { password: password.value } : { removeKey: removeKey.input.checked }),
        ...(sudoPassword.value ? { sudoPassword: sudoPassword.value } : {})
      };
    },
    // Kata sandi dihapus dari formulir begitu tidak dibutuhkan lagi
    clear() { password.value = ''; sudoPassword.value = ''; }
  };
}

// ─────────────────────────────────────────────
//  Tes koneksi (dengan konfirmasi host key)
// ─────────────────────────────────────────────
const STEP_CLASS = { done: 'is-green', running: 'is-blue', waiting: 'is-yellow', failed: 'is-red', skipped: '' };
const STEP_ICON = { done: '✓', running: '…', waiting: '?', failed: '✗', skipped: '–', pending: '' };

function stepsTimeline(steps) {
  return el('div', { className: 'timeline' },
    ...steps.map((s) => el('div', { className: `timeline-item ${STEP_CLASS[s.status] ?? ''}`, style: s.status === 'pending' ? 'opacity:.55' : '' },
      el('div', { className: 'ti-title' }, `${STEP_ICON[s.status] ?? ''} ${s.label}`.trim()),
      s.detail ? el('div', { className: 'ti-desc', textContent: s.detail, style: 'word-break:break-word' }) : '')));
}

function hostkeyNotice(fingerprint, { onAccept, onReject, acceptLabel = 'Ya, ini server saya' }) {
  const yes = el('button', { type: 'button', className: 'btn btn-primary btn-sm', textContent: acceptLabel });
  const no = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', textContent: 'Bukan / batalkan' });
  yes.addEventListener('click', () => onAccept(yes));
  no.addEventListener('click', () => onReject?.(no));
  return el('div', { className: 'banner banner-warning', style: 'flex-direction:column;align-items:stretch;gap:8px' },
    el('div', { className: 'banner-body' },
      el('strong', { textContent: 'Pastikan ini benar-benar server Anda.' }),
      ' Fingerprint host key yang diterima:',
      el('div', { style: 'font-family:var(--font-mono);font-size:12px;margin:6px 0;word-break:break-all', textContent: fingerprint }),
      'Cocokkan dengan salah satu baris hasil perintah ini, dijalankan di server target lewat konsol penyedia (bukan lewat jaringan yang sama):',
      el('div', { style: 'font-family:var(--font-mono);font-size:11.5px;margin-top:4px', textContent: 'for k in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $k; done' })),
    el('div', { className: 'banner-actions' }, yes, onReject ? no : ''));
}

// ─────────────────────────────────────────────
//  Wizard Tambah Server
// ─────────────────────────────────────────────
export async function openAddServerWizard({ onChanged }) {
  const [regions, pinfo] = await Promise.all([api.regions().catch(() => []), provisionInfo()]);

  const name = el('input', { id: 'f-name', className: 'form-control', required: true, pattern: '[a-z0-9][a-z0-9\\-]{1,62}', placeholder: 'web-01', autocomplete: 'off' });
  const ip = el('input', { id: 'f-ip', className: 'form-control', required: true, placeholder: '10.0.0.12', inputMode: 'decimal', autocomplete: 'off' });
  const port = el('input', { id: 'f-port', className: 'form-control', type: 'number', min: 1, max: 65535, value: 9100 });
  const region = el('select', { id: 'f-region', className: 'form-control' },
    el('option', { value: '', textContent: '— Tanpa region —' }),
    ...regions.map((r) => el('option', { value: String(r.id), textContent: r.name })));
  const tags = el('input', { id: 'f-tags', className: 'form-control', placeholder: 'produksi, web' });

  const modeAuto = el('button', { type: 'button', className: 'btn btn-outline btn-sm active', textContent: 'Otomatis lewat SSH', ariaPressed: 'true' });
  const modeManual = el('button', { type: 'button', className: 'btn btn-outline btn-sm', textContent: 'Manual', ariaPressed: 'false' });
  const modeHint = el('div', { className: 'form-hint' });

  const creds = credentialFields({ publicKey: pinfo.publicKey, prefix: 'add' });
  const logs = check('f-logs', 'Kumpulkan log (pasang agen log Grafana Alloy, ±50–150 MB RAM)');
  logs.input.disabled = !pinfo.logsAvailable;
  const logsHint = pinfo.logsAvailable ? '' :
    el('div', { className: 'form-hint' }, 'Belum tersedia: isi ', el('code', { textContent: 'MONITOR_PUBLIC_HOST' }), ' di .env server pemantau.');

  const testBtn = el('button', { type: 'button', className: 'btn btn-outline' }, 'Tes koneksi');
  const testResult = el('div', { style: 'margin-top:10px' });
  const error = el('div', { className: 'form-error', role: 'alert' });

  const autoSection = el('div', {},
    el('div', { style: 'border-top:1px solid var(--border-color-light);margin:4px 0 14px' }),
    creds.node,
    el('div', { className: 'form-group' }, logs.node, logsHint),
    el('div', {}, testBtn, testResult));

  let mode = 'auto';
  const setMode = (m) => {
    mode = m;
    modeAuto.classList.toggle('active', m === 'auto');
    modeManual.classList.toggle('active', m === 'manual');
    modeAuto.ariaPressed = String(m === 'auto');
    modeManual.ariaPressed = String(m === 'manual');
    autoSection.hidden = m !== 'auto';
    modeHint.textContent = m === 'auto'
      ? 'Server pemantau login lewat SSH, memeriksa server, lalu memasang node_exporter (TLS + basic auth) setelah Anda menyetujui rencananya.'
      : 'node_exporter sudah Anda pasang sendiri dan port-nya bisa dijangkau dari server pemantau.';
    const primary = modal?.dialog.querySelector('.modal-footer .btn-primary');
    if (primary) primary.textContent = m === 'auto' ? 'Mulai pemasangan' : 'Simpan';
  };
  modeAuto.addEventListener('click', () => setMode('auto'));
  modeManual.addEventListener('click', () => setMode('manual'));

  const body = el('form', { noValidate: true },
    el('div', { className: 'row col-2', style: 'margin-bottom:0' },
      field('Nama server', name, 'Huruf kecil, angka, dan tanda -'),
      field('Alamat IP', ip)),
    el('div', { className: 'row col-2', style: 'margin-bottom:0' },
      field('Port node_exporter', port, 'Dicari port kosong lain jika sudah dipakai'),
      field('Region', region)),
    field('Tag', tags, 'Pisahkan dengan koma'),
    el('div', { className: 'form-group' },
      el('div', { className: 'form-label', textContent: 'Cara pemasangan' }),
      el('div', { className: 'btn-group', role: 'group' }, modeAuto, modeManual),
      modeHint),
    autoSection,
    error);

  let acceptedFingerprint = null;

  const basicValid = () => {
    const okName = name.checkValidity();
    const okIp = IPV4.test(ip.value.trim());
    name.classList.toggle('is-invalid', !okName);
    ip.classList.toggle('is-invalid', !okIp);
    return okName && okIp ? null : 'Periksa nama server dan alamat IP.';
  };

  async function runTest() {
    const problem = (IPV4.test(ip.value.trim()) ? null : 'Isi alamat IP dulu.') ?? creds.validate();
    if (problem) { error.textContent = problem; return; }
    error.textContent = '';
    busy(testBtn, true, 'Menguji…');
    try {
      const r = await api.testConnection({ ip: ip.value.trim(), ssh: creds.read(), acceptedFingerprint: acceptedFingerprint ?? undefined });
      const parts = [stepsTimeline(r.steps)];
      if (r.needsHostkeyConfirm) {
        parts.push(hostkeyNotice(r.fingerprint, {
          onAccept: () => { acceptedFingerprint = r.fingerprint; runTest(); }
        }));
      } else if (r.ok) {
        parts.push(alertBox('success', 'Koneksi berhasil. Server siap dipasang.'));
      }
      testResult.replaceChildren(el('div', { className: 'card', style: 'padding:12px 14px;box-shadow:none' }, ...parts));
    } catch (err) {
      testResult.replaceChildren(alertBox('error', err.message));
    } finally {
      busy(testBtn, false);
    }
  }
  testBtn.addEventListener('click', runTest);
  // Fingerprint yang sudah dikonfirmasi hanya berlaku untuk IP & port yang sama
  for (const input of [ip, creds.node.querySelector('#add-port')]) {
    input.addEventListener('change', () => { acceptedFingerprint = null; testResult.replaceChildren(); });
  }

  let submitting = false;
  async function submit({ dialog }) {
    if (submitting) return;
    const problem = basicValid() ?? (mode === 'auto' ? creds.validate() : null);
    if (problem) { error.textContent = problem; return; }
    submitting = true;
    const btn = dialog.querySelector('.modal-footer .btn-primary');
    busy(btn, true, mode === 'auto' ? 'Memulai…' : 'Menyimpan…');
    try {
      const payload = {
        name: name.value.trim(),
        ip: ip.value.trim(),
        exporterPort: Number(port.value) || 9100,
        regionId: region.value ? Number(region.value) : null,
        tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
        mode
      };
      if (mode === 'auto') {
        Object.assign(payload, { ssh: creds.read(), collectLogs: logs.input.checked, acceptedFingerprint: acceptedFingerprint ?? undefined });
      }
      const res = await api.addServer(payload);
      creds.clear();
      closeModal();
      onChanged?.();
      if (res.jobId) openJobModal(res.jobId, { onChanged });
      else showToast(`Server ${payload.name} ditambahkan`, { variant: 'success' });
    } catch (err) {
      error.textContent = err.message;
      busy(btn, false);
      submitting = false;
    }
  }

  body.addEventListener('submit', (e) => { e.preventDefault(); submit(modal); });
  const modal = showModal({
    title: 'Tambah Server',
    size: 'lg',
    body,
    actions: [
      { label: 'Batal', variant: 'ghost', action: () => creds.clear() },
      { label: 'Mulai pemasangan', variant: 'primary', action: (ctx) => { submit(ctx); return false; } }
    ]
  });
  setMode('auto');
  return modal;
}

// ─────────────────────────────────────────────
//  Layar progres job
// ─────────────────────────────────────────────
const JOB_TITLE = { install: 'Pemasangan', uninstall: 'Pencopotan', verify: 'Cek ulang port' };
const JOB_STATUS = {
  queued: ['status-blue', 'Mengantre'],
  running: ['status-blue', 'Berjalan'],
  awaiting_hostkey: ['status-yellow', 'Menunggu konfirmasi host key'],
  awaiting_approval: ['status-yellow', 'Menunggu persetujuan rencana'],
  succeeded: ['status-green', 'Berhasil'],
  failed: ['status-red', 'Gagal'],
  cancelled: ['', 'Dibatalkan']
};

let openJob = null; // { id, refresh }

/** Dipanggil dari SSE "provision" supaya layar progres ikut diperbarui. */
export function notifyJobChanged(jobId) {
  if (openJob && (!jobId || openJob.id === jobId)) openJob.refresh();
}

export async function openJobModal(jobId, { onChanged } = {}) {
  openJob?.stop(); // modal job sebelumnya ditutup tanpa memanggil onClose
  const head = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap' });
  const steps = el('div');
  const action = el('div', { style: 'margin-top:14px;display:flex;flex-direction:column;gap:10px' });
  const logPre = el('pre', { style: 'font-family:var(--font-mono);font-size:11.5px;line-height:1.55;max-height:220px;overflow:auto;background:var(--bg-surface-secondary);padding:10px 12px;border-radius:var(--radius-sm);margin:8px 0 0;white-space:pre-wrap;word-break:break-word' });
  const logs = el('details', { style: 'margin-top:14px' }, el('summary', { textContent: 'Log teknis', style: 'cursor:pointer;font-size:12.5px;color:var(--text-muted)' }), logPre);
  const body = el('div', {}, head, steps, action, logs);

  let job = null;
  let timer = null;
  let renderedKey = '';

  const act = async (btn, fn, okMsg) => {
    busy(btn, true);
    try {
      await fn();
      if (okMsg) showToast(okMsg, { variant: 'success' });
      await refresh();
    } catch (err) {
      showToast(err.message, { variant: 'error' });
      busy(btn, false);
    }
  };

  function renderAction() {
    const parts = [];
    if (job.status === 'awaiting_hostkey' && job.fingerprint) {
      parts.push(hostkeyNotice(job.fingerprint, {
        onAccept: (b) => act(b, () => api.answerHostkey(job.id, true)),
        onReject: (b) => act(b, () => api.answerHostkey(job.id, false), 'Pemasangan dibatalkan')
      }));
    } else if (job.status === 'awaiting_approval' && job.plan) {
      const p = job.plan;
      const yes = el('button', { type: 'button', className: 'btn btn-primary', textContent: 'Setujui & pasang' });
      const no = el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Batalkan' });
      yes.addEventListener('click', () => act(yes, () => api.answerPlan(job.id, true)));
      no.addEventListener('click', () => act(no, () => api.answerPlan(job.id, false), 'Pemasangan dibatalkan'));
      parts.push(el('div', { className: 'card', style: 'box-shadow:none' },
        el('div', { className: 'card-header' }, el('div', {},
          el('div', { className: 'card-title', textContent: `Rencana untuk ${job.server_name}` }),
          el('div', { className: 'card-subtitle', textContent: `${p.os ?? ''} · IP pemantau terlihat sebagai ${p.sourceIp}` }))),
        el('div', { className: 'card-body' },
          el('ul', { style: 'margin:0 0 10px;padding-inline-start:18px;font-size:13px;line-height:1.7;color:var(--text)' },
            ...p.items.map((t) => el('li', { textContent: t }))),
          el('div', { style: 'font-size:12.5px;color:var(--text-muted);margin-bottom:10px', textContent: p.untouched }),
          ...p.warnings.map((w) => el('div', { style: 'margin-bottom:8px' }, alertBox('warning', w))),
          el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, no, yes))));
    } else if (['queued', 'running'].includes(job.status)) {
      const cancel = el('button', { type: 'button', className: 'btn btn-outline btn-sm', textContent: 'Batalkan' });
      cancel.addEventListener('click', () => act(cancel, () => api.cancelJob(job.id), 'Permintaan batal dikirim; perubahan akan di-rollback'));
      parts.push(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;color:var(--text-muted)' },
        el('span', { style: 'display:inline-flex;gap:8px;align-items:center' }, el('span', { className: 'spinner spinner-sm' }), 'Sedang berjalan. Modal ini boleh ditutup; prosesnya tetap lanjut.'),
        cancel));
    } else if (job.status === 'succeeded') {
      parts.push(alertBox('success', job.kind === 'uninstall'
        ? 'Komponen Pantau sudah dicopot dan server dihapus dari dashboard.'
        : 'Selesai. Metrik akan tampil di dashboard dalam ±30 detik.'));
    } else if (job.status === 'failed' || job.status === 'cancelled') {
      parts.push(alertBox(job.status === 'failed' ? 'error' : 'warning', job.error ?? 'Job berhenti.'));
      const verifyFailed = job.steps.some((s) => s.id === 'verify' && s.status === 'failed');
      if (verifyFailed && job.server_id) {
        const recheck = el('button', { type: 'button', className: 'btn btn-primary btn-sm', textContent: 'Cek ulang port' });
        recheck.addEventListener('click', () => act(recheck, async () => {
          const r = await api.recheck(job.server_id);
          openJobModal(r.jobId, { onChanged });
        }));
        parts.push(el('div', {}, recheck));
      }
    }
    action.replaceChildren(...parts);
  }

  function render() {
    const [cls, label] = JOB_STATUS[job.status] ?? ['', job.status];
    head.replaceChildren(
      el('div', {},
        el('div', { className: 'cell-strong', textContent: `${JOB_TITLE[job.kind] ?? job.kind} · ${job.server_name}` }),
        el('div', { style: 'font-size:11.5px;color:var(--text-muted)', textContent: `Job #${job.id} · dimulai ${fmtTime(job.created_at)}${job.created_by ? ` oleh ${job.created_by}` : ''}` })),
      el('span', { className: `status ${cls}`, textContent: label }));
    steps.replaceChildren(stepsTimeline(job.steps));
    // Jangan menggambar ulang tombol saat statusnya sama (supaya klik tidak hilang)
    const key = `${job.status}|${job.fingerprint}|${!!job.plan}|${job.error}`;
    if (key !== renderedKey) { renderAction(); renderedKey = key; }
    const atBottom = logPre.scrollTop + logPre.clientHeight >= logPre.scrollHeight - 4;
    logPre.textContent = (job.log ?? []).map((l) =>
      `${new Date(l.t).toLocaleTimeString('id-ID')}  ${l.level === 'info' ? '' : `[${l.level}] `}${l.msg}`).join('\n') || '—';
    if (atBottom) logPre.scrollTop = logPre.scrollHeight;
  }

  async function refresh() {
    try {
      job = await api.job(jobId);
      render();
      if (TERMINAL.includes(job.status)) { clearInterval(timer); onChanged?.(); }
    } catch (err) {
      action.replaceChildren(alertBox('error', err.message));
    }
  }

  showModal({
    title: 'Progres pemasangan',
    size: 'lg',
    body,
    actions: [{ label: 'Tutup', variant: 'outline' }],
    onClose: () => { clearInterval(timer); openJob = null; onChanged?.(); }
  });
  openJob = { id: jobId, refresh, stop: () => clearInterval(timer) };
  steps.append(el('div', { className: 'skeleton skeleton-text' }), el('div', { className: 'skeleton skeleton-text' }));
  await refresh();
  // Cadangan kalau SSE terputus
  if (!TERMINAL.includes(job?.status)) timer = setInterval(refresh, 4000);
}

// ─────────────────────────────────────────────
//  Pasang ulang / copot / hapus
// ─────────────────────────────────────────────
export async function openReprovision(server, { onChanged }) {
  const pinfo = await provisionInfo();
  const creds = credentialFields({ user: server.ssh_user ?? 'root', port: server.ssh_port ?? 22, publicKey: pinfo.publicKey, prefix: 're' });
  const logs = check('re-logs', 'Kumpulkan log (pasang agen log)', server.collect_logs);
  logs.input.disabled = !pinfo.logsAvailable;
  const error = el('div', { className: 'form-error', role: 'alert' });
  const body = el('div', {},
    alertBox('info', 'Pemasangan dijalankan ulang. Langkahnya aman diulang: yang sudah terpasang diperbarui, layanan lain tidak disentuh.'),
    el('div', { style: 'height:12px' }),
    creds.node,
    el('div', { className: 'form-group' }, logs.node),
    error);
  showModal({
    title: `Pasang ulang · ${server.name}`,
    size: 'md',
    body,
    actions: [
      { label: 'Batal', variant: 'ghost', action: () => creds.clear() },
      {
        label: 'Mulai', variant: 'primary',
        action: ({ dialog }) => {
          const problem = creds.validate();
          if (problem) { error.textContent = problem; return false; }
          const btn = dialog.querySelector('.modal-footer .btn-primary');
          busy(btn, true, 'Memulai…');
          api.reprovision(server.id, { ssh: creds.read(), collectLogs: logs.input.checked })
            .then((r) => { creds.clear(); closeModal(); onChanged?.(); openJobModal(r.jobId, { onChanged }); })
            .catch((err) => { error.textContent = err.message; busy(btn, false); });
          return false;
        }
      }
    ]
  });
}

export async function openRemove(server, { onChanged }) {
  const canUninstall = server.mode === 'auto' && server.provision_status !== 'pending';
  const pinfo = canUninstall ? await provisionInfo() : null;
  const uninstall = check('rm-uninstall', 'Copot juga node_exporter, agen log & aturan firewall dari server (butuh login SSH)', canUninstall);
  const creds = canUninstall
    ? credentialFields({ user: server.ssh_user ?? 'root', port: server.ssh_port ?? 22, publicKey: pinfo.publicKey, prefix: 'rm' })
    : null;
  const error = el('div', { className: 'form-error', role: 'alert' });
  const credsWrap = el('div', { style: 'margin-top:12px' }, creds?.node ?? '');
  uninstall.input.addEventListener('change', () => { credsWrap.hidden = !uninstall.input.checked; });

  const body = el('div', {},
    el('p', { style: 'font-size:13px;color:var(--text-secondary);line-height:1.6;margin:0 0 12px' },
      'Server ', el('strong', { textContent: server.name }), ` (${server.ip}) akan berhenti dipantau.`),
    canUninstall ? uninstall.node : '',
    canUninstall ? credsWrap : '',
    error);

  showModal({
    title: 'Hapus server?',
    size: canUninstall ? 'md' : 'sm',
    body,
    actions: [
      { label: 'Batal', variant: 'ghost', action: () => creds?.clear() },
      {
        label: 'Hapus', variant: 'danger',
        action: ({ dialog }) => {
          const btn = dialog.querySelector('.modal-footer .btn-danger');
          if (canUninstall && uninstall.input.checked) {
            const problem = creds.validate();
            if (problem) { error.textContent = problem; return false; }
            busy(btn, true, 'Memulai…');
            api.uninstall(server.id, { ssh: creds.read() })
              .then((r) => { creds.clear(); closeModal(); onChanged?.(); openJobModal(r.jobId, { onChanged }); })
              .catch((err) => { error.textContent = err.message; busy(btn, false); });
            return false;
          }
          busy(btn, true, 'Menghapus…');
          api.removeServer(server.id)
            .then(() => { closeModal(); showToast(`Server ${server.name} dihapus`, { variant: 'success' }); onChanged?.(); })
            .catch((err) => { error.textContent = err.message; busy(btn, false); });
          return false;
        }
      }
    ]
  });
}

export async function openJobHistory(server, { onChanged }) {
  const jobs = await api.serverJobs(server.id).catch((err) => { showToast(err.message, { variant: 'error' }); return null; });
  if (!jobs) return;
  const body = jobs.length
    ? el('div', { className: 'table-responsive' }, el('table', { className: 'table' },
        el('thead', {}, el('tr', {}, ...['Waktu', 'Jenis', 'Status', 'Oleh', ''].map((h) => el('th', { textContent: h })))),
        el('tbody', {}, ...jobs.map((j) => {
          const [cls, label] = JOB_STATUS[j.status] ?? ['', j.status];
          const open = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', textContent: 'Detail' });
          open.addEventListener('click', () => { closeModal(); openJobModal(j.id, { onChanged }); });
          return el('tr', {},
            el('td', { textContent: fmtTime(j.created_at) }),
            el('td', { textContent: JOB_TITLE[j.kind] ?? j.kind }),
            el('td', {}, el('span', { className: `status ${cls}`, textContent: label })),
            el('td', { textContent: j.created_by ?? '—' }),
            el('td', { style: 'text-align:end' }, open));
        }))))
    : emptyState('Belum ada riwayat', 'Server ini belum pernah dipasang otomatis.');
  showModal({ title: `Riwayat pemasangan · ${server.name}`, size: 'lg', body, actions: [{ label: 'Tutup', variant: 'outline' }] });
}

// ─────────────────────────────────────────────
//  Log audit
// ─────────────────────────────────────────────
const AUDIT_LABEL = {
  'server.add': 'Menambah server',
  'server.delete': 'Menghapus server (dashboard saja)',
  'server.uninstalled': 'Mencopot & menghapus server',
  'provision.test': 'Tes koneksi SSH',
  'provision.install': 'Memulai pemasangan',
  'provision.uninstall': 'Memulai pencopotan',
  'provision.verify': 'Cek ulang port',
  'provision.hostkey.yes': 'Mengonfirmasi host key',
  'provision.hostkey.no': 'Menolak host key',
  'provision.approve.yes': 'Menyetujui rencana',
  'provision.approve.no': 'Menolak rencana',
  'provision.cancel': 'Membatalkan job',
  'provision.succeeded': 'Pemasangan berhasil',
  'provision.failed': 'Pemasangan gagal',
  'provision.cancelled': 'Pemasangan dibatalkan'
};

export async function openAuditLog() {
  const rows = await api.audit().catch((err) => { showToast(err.message, { variant: 'error' }); return null; });
  if (!rows) return;
  const body = rows.length
    ? el('div', { className: 'table-responsive', style: 'max-height:60vh;overflow:auto' }, el('table', { className: 'table' },
        el('thead', {}, el('tr', {}, ...['Waktu', 'Pengguna', 'Aksi', 'Target'].map((h) => el('th', { textContent: h })))),
        el('tbody', {}, ...rows.map((r) => el('tr', {},
          el('td', { textContent: fmtTime(r.created_at), style: 'white-space:nowrap' }),
          el('td', { className: r.user_name === 'sistem' ? '' : 'cell-strong', textContent: r.user_name }),
          el('td', { textContent: AUDIT_LABEL[r.action] ?? r.action, title: r.detail?.error ?? '' }),
          el('td', { className: 'cell-mono', textContent: r.target ?? '—' }))))))
    : emptyState('Belum ada aktivitas', 'Aksi admin akan tercatat di sini.');
  showModal({ title: 'Log audit', size: 'lg', body, actions: [{ label: 'Tutup', variant: 'outline' }] });
}
