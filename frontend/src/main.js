import './styles/main.scss';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
// Komponen interaktif Gentelella v4 asli
import { mountShell } from 'gentelella/v4/shell';
import { showModal } from 'gentelella/v4/modal';
import { showToast } from 'gentelella/v4/toast';
import { openMenu, openPanel } from 'gentelella/v4/menus';
import { api, auth } from './api.js';
import { bytes, bits, duration, ago } from './format.js';

if (!auth.token) location.replace('/login.html');

const $ = (sel) => document.querySelector(sel);
const state = { range: '24h', filter: 'all', search: '', servers: [], alerts: [], counts: null };

// Membuat elemen dengan aman: teks selalu lewat textContent, tidak pernah innerHTML
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c ?? '');
  return node;
}

// SVG ikon statis (bukan data pengguna) — aman di-parse dari string
function icon(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild;
}
const ICONS = {
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
  mem: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="10" rx="1.5"/><path d="M6 11v2M10 11v2M14 11v2M18 11v2"/></svg>',
  uptime: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>'
};

// Warna diambil dari token CSS Gentelella, jadi ikut berubah saat mode gelap
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const STATUS_CLASS = { online: 'status-green', peringatan: 'status-yellow', offline: 'status-red' };
const STATUS_LABEL = { online: 'Online', peringatan: 'Peringatan', offline: 'Offline' };
const levelVar = (v, base) => (v >= 85 ? 'var(--red)' : v >= 70 ? 'var(--yellow)' : base);

// ── Komponen Gentelella: empty state ──
function emptyState(title, desc, svg = ICONS.check) {
  return el('div', { className: 'empty-state' },
    el('div', { className: 'empty-state-icon' }, icon(svg)),
    el('div', { className: 'empty-state-title', textContent: title }),
    el('div', { className: 'empty-state-desc', textContent: desc }));
}

// ── Kartu statistik (.card > .stat) ──
function statCard({ label, value, unit, sub, color, svg, progress, barColor }) {
  const valueEl = el('span', { className: 'stat-value', textContent: value ?? '—' });
  if (value != null && unit) {
    valueEl.append(el('span', { textContent: unit, style: 'font-size:12px;font-weight:400;color:var(--text-muted);margin-left:2px' }));
  }
  const card = el('div', { className: 'card' },
    el('div', { className: 'stat' },
      el('div', { className: `stat-icon ${color}` }, icon(svg)),
      el('div', { className: 'stat-content' },
        el('div', { className: 'stat-label', textContent: label }),
        el('div', { className: 'stat-value-row' }, valueEl),
        el('div', { className: 'stat-subtext', textContent: sub }))));
  if (progress != null) {
    card.append(el('div', { style: 'padding:0 16px 12px' },
      el('div', { className: 'progress-thin' },
        el('div', { className: 'bar', style: `width:${Math.min(100, progress)}%;background:${barColor ?? `var(--${color === 'teal' ? 'primary' : color})`}` }))));
  }
  return card;
}

function renderStats(s) {
  const onlinePct = s.total ? Math.round((s.online / s.total) * 100) : 0;
  $('#stats').replaceChildren(
    statCard({ label: 'Server Online', value: `${s.online}`, unit: ` / ${s.total}`, sub: `${s.total - s.online} server tidak terjangkau`, color: 'teal', svg: ICONS.server, progress: onlinePct, barColor: onlinePct < 100 ? 'var(--yellow)' : null }),
    statCard({ label: 'Rata-rata CPU', value: s.avgCpu?.toString(), unit: '%', sub: 'Semua server online', color: 'blue', svg: ICONS.cpu, progress: s.avgCpu, barColor: s.avgCpu >= 70 ? levelVar(s.avgCpu) : null }),
    statCard({ label: 'Penggunaan Memori', value: s.avgMem?.toString(), unit: '%', sub: 'Rata-rata semua server', color: 'purple', svg: ICONS.mem, progress: s.avgMem, barColor: s.avgMem >= 70 ? levelVar(s.avgMem) : null }),
    statCard({ label: 'Uptime 30 Hari', value: s.uptime30d?.toString(), unit: '%', sub: 'Berdasarkan ping blackbox', color: 'green', svg: ICONS.uptime, progress: s.uptime30d, barColor: s.uptime30d < 99 ? 'var(--red)' : null })
  );
  $('#updated').textContent = `Diperbarui ${ago(s.updatedAt)}`;

  const health = $('#health-status');
  const down = s.total - s.online;
  health.className = `status ${down ? 'status-red' : 'status-green'}`;
  health.textContent = down ? `${down} server offline` : 'Semua server online';
}

// ── Grafik CPU & memori (ECharts, gaya mengikuti charts.js Gentelella) ──
echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer]);
const chart = echarts.init($('#chart'));
let lastMetrics = null;
window.addEventListener('resize', () => chart.resize());

function drawChart() {
  if (!lastMetrics) return;
  const t = {
    primary: cssVar('--primary'), azure: cssVar('--azure'), yellow: cssVar('--yellow'),
    text: cssVar('--text'), muted: cssVar('--text-muted'), border: cssVar('--border-color-light'), surface: cssVar('--bg-surface')
  };
  const fontFamily = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
  const toSeries = (pts) => pts.map(([ts, v]) => [ts * 1000, Math.round(v * 10) / 10]);
  chart.setOption({
    textStyle: { fontFamily, fontSize: 11, color: t.muted },
    grid: { left: 40, right: 12, top: 16, bottom: 28 },
    tooltip: {
      trigger: 'axis', valueFormatter: (v) => `${v}%`,
      backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, padding: [8, 10],
      textStyle: { color: t.text, fontSize: 12, fontFamily },
      axisPointer: { type: 'line', lineStyle: { color: t.border } },
      extraCssText: 'box-shadow: 0 2px 8px rgba(30,38,51,0.08); border-radius: 6px;'
    },
    legend: { show: false },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false }, axisLabel: { color: t.muted, fontSize: 10 } },
    yAxis: {
      type: 'value', min: 0, max: 100,
      splitLine: { lineStyle: { color: t.border, type: [4, 3] } },
      axisLabel: { color: t.muted, fontSize: 10, formatter: '{value}%' }, axisLine: { show: false }, axisTick: { show: false }
    },
    series: [
      {
        name: 'CPU', type: 'line', smooth: true, showSymbol: false, data: toSeries(lastMetrics.cpu),
        lineStyle: { color: t.primary, width: 2 }, itemStyle: { color: t.primary },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `${t.primary}33` }, { offset: 1, color: `${t.primary}00` }]) },
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: t.yellow, type: 'dashed' }, data: [{ yAxis: 80 }] }
      },
      { name: 'Memori', type: 'line', smooth: true, showSymbol: false, data: toSeries(lastMetrics.mem), lineStyle: { color: t.azure, width: 1.5 }, itemStyle: { color: t.azure } }
    ]
  }, true);
}

async function loadChart() {
  const card = $('#chart').closest('.card');
  card.classList.add('is-refreshing');
  try {
    lastMetrics = await api.metrics(state.range);
    drawChart();
  } finally {
    card.classList.remove('is-refreshing');
  }
}

// Gambar ulang grafik saat tombol tema Gentelella mengganti data-theme
new MutationObserver(drawChart).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ── Peringatan aktif (.timeline Gentelella) ──
const SEVERITY_CLASS = { kritis: 'is-red', sedang: 'is-yellow' };

function renderAlerts() {
  const { alerts: active, counts } = state;
  $('#alert-counts').textContent = `${counts.kritis} kritis · ${counts.sedang} sedang · ${counts.selesai_hari_ini} selesai hari ini`;
  $('#alert-list').replaceChildren(
    active.length
      ? el('div', { className: 'timeline' },
          ...active.map((a) => el('div', { className: `timeline-item ${SEVERITY_CLASS[a.severity] ?? 'is-blue'}` },
            el('div', { className: 'ti-time', textContent: `${ago(a.starts_at)} · ${a.severity}` }),
            el('div', { className: 'ti-title', textContent: a.server ? `${a.server} — ${a.alertname}` : a.alertname }),
            el('div', { className: 'ti-desc', textContent: a.summary ?? '' }))))
      : emptyState('Semua aman', 'Tidak ada peringatan aktif saat ini.')
  );

  const total = active.length;
  const navBadge = $('#nav-alert-count');
  navBadge.hidden = !total;
  navBadge.textContent = String(total);
  $('#alerts-bell .dot').hidden = !total;

  $('#critical-banner').hidden = !counts.kritis;
  const text = $('#critical-banner-text');
  text.replaceChildren(el('strong', { textContent: `${counts.kritis} peringatan kritis` }), ' sedang aktif — segera periksa server terkait.');
}

async function loadAlerts() {
  const { active, counts } = await api.alerts();
  state.alerts = active;
  state.counts = counts;
  renderAlerts();
}

// Panel lonceng di topbar (.menu-panel Gentelella) berisi peringatan sungguhan
function buildAlertsPanel() {
  const wrap = el('div', { className: 'panel-content' },
    el('div', { className: 'panel-header' },
      el('span', { className: 'panel-title', textContent: 'Peringatan aktif' }),
      state.alerts.length ? el('span', { className: 'panel-badge', textContent: `${state.alerts.length} aktif` }) : ''),
    el('div', { className: 'panel-list' },
      ...(state.alerts.length
        ? state.alerts.slice(0, 8).map((a) => el('a', { className: 'panel-row unread', href: '#alerts' },
            el('span', { className: `panel-icon ${a.severity === 'kritis' ? 'panel-icon-alert' : 'panel-icon-info'}`, ariaHidden: 'true' },
              icon('<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1l7 13H1L8 1z"/><path d="M8 6v4"/></svg>')),
            el('span', { className: 'panel-body' },
              el('span', { className: 'panel-from', textContent: a.server ?? a.alertname }),
              el('span', { className: 'panel-text', textContent: a.summary ?? a.alertname })),
            el('span', { className: 'panel-time', textContent: ago(a.starts_at) })))
        : [emptyState('Semua aman', 'Tidak ada peringatan aktif.')])),
    el('div', { className: 'panel-footer' }, el('a', { className: 'panel-link', href: '#alerts', textContent: 'Lihat semua peringatan' })));
  return wrap;
}

// ── Tabel server (table.table + .status + .progress-thin) ──
function cellBar(value, base) {
  if (value == null) return '—';
  return el('div', { className: 'cell-bar' },
    el('div', { className: 'progress-thin' }, el('div', { className: 'bar', style: `width:${value}%;background:${levelVar(value, base)}` })),
    el('span', { textContent: `${value}%` }));
}

function renderServers() {
  const q = state.search.trim().toLowerCase();
  const rows = state.servers
    .filter((s) => state.filter === 'all' || s.status === state.filter)
    .filter((s) => !q || s.name.includes(q) || s.ip.includes(q) || s.tags.some((t) => t.toLowerCase().includes(q)));

  const online = state.servers.filter((s) => s.status !== 'offline').length;
  $('#server-subtitle').textContent = `${state.servers.length} server terdaftar · ${online} online`;
  const navBadge = $('#nav-server-count');
  navBadge.hidden = !state.servers.length;
  navBadge.textContent = String(state.servers.length);

  $('#server-rows').replaceChildren(
    ...(rows.length
      ? rows.map((s) => el('tr', {},
          el('td', {}, el('div', { className: 'cell-strong', textContent: s.name }), el('div', { className: 'cell-mono', textContent: s.ip })),
          el('td', {}, el('span', { className: `status ${STATUS_CLASS[s.status] ?? ''}`, textContent: STATUS_LABEL[s.status] ?? s.status })),
          el('td', { textContent: s.region ?? '—' }),
          el('td', {}, cellBar(s.cpu, 'var(--primary)')),
          el('td', {}, cellBar(s.mem, 'var(--azure)')),
          el('td', { textContent: s.diskSizeBytes ? `${bytes(s.diskUsedBytes)} / ${bytes(s.diskSizeBytes)}` : '—' }),
          el('td', { className: 'cell-mono', textContent: s.netRxBps == null ? '—' : `↑${bits(s.netTxBps)} ↓${bits(s.netRxBps)}` }),
          el('td', { textContent: duration(s.uptimeSec) }),
          el('td', { style: 'text-align:end' },
            el('button', { type: 'button', className: 'btn btn-ghost btn-icon', title: `Hapus ${s.name}`, ariaLabel: `Hapus ${s.name}`, onclick: () => confirmRemove(s) }, icon(ICONS.trash)))))
      : [el('tr', {}, el('td', { colSpan: 9 },
          state.servers.length
            ? emptyState('Tidak ada yang cocok', 'Ubah kata kunci pencarian atau saringan status.', ICONS.search)
            : emptyState('Belum ada server', 'Klik "Tambah Server" untuk mulai memantau.', ICONS.server)))])
  );
}

async function loadServers() {
  state.servers = await api.servers();
  renderServers();
}

// ── Modal Gentelella: tambah server ──
async function openAddServer() {
  const regions = await api.regions().catch(() => []);
  const field = (label, input, hint) => el('div', { className: 'form-group' },
    el('label', { className: 'form-label', htmlFor: input.id }, label), input,
    hint ? el('div', { className: 'form-hint', textContent: hint }) : '');

  const name = el('input', { id: 'f-name', className: 'form-control', required: true, pattern: '[a-z0-9][a-z0-9\\-]{1,62}', placeholder: 'web-01' });
  const ip = el('input', { id: 'f-ip', className: 'form-control', required: true, placeholder: '10.0.0.12', inputMode: 'decimal' });
  const port = el('input', { id: 'f-port', className: 'form-control', type: 'number', min: 1, max: 65535, value: 9100 });
  const region = el('select', { id: 'f-region', className: 'form-control' },
    el('option', { value: '', textContent: '— Tanpa region —' }),
    ...regions.map((r) => el('option', { value: String(r.id), textContent: r.name })));
  const tags = el('input', { id: 'f-tags', className: 'form-control', placeholder: 'produksi, web' });
  const error = el('div', { className: 'form-error', role: 'alert' });

  const body = el('form', { noValidate: true },
    field('Nama server', name, 'Huruf kecil, angka, dan tanda -'),
    field('Alamat IP', ip),
    el('div', { className: 'row col-2', style: 'margin-bottom:0' },
      field('Port node_exporter', port),
      field('Region', region)),
    field('Tag', tags, 'Pisahkan dengan koma'),
    error);

  const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  let busy = false;

  const submit = async ({ dialog, close }) => {
    if (busy) return false;
    name.classList.toggle('is-invalid', !name.checkValidity());
    ip.classList.toggle('is-invalid', !ipv4.test(ip.value.trim()));
    if (!name.checkValidity() || !ipv4.test(ip.value.trim())) {
      error.textContent = 'Periksa nama server dan alamat IP.';
      return false;
    }
    busy = true;
    const btn = dialog.querySelector('.modal-footer .btn-primary');
    btn.setAttribute('aria-busy', 'true');
    try {
      await api.addServer({
        name: name.value.trim(),
        ip: ip.value.trim(),
        exporterPort: Number(port.value) || 9100,
        regionId: region.value ? Number(region.value) : null,
        tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean)
      });
      close();
      showToast(`Server ${name.value.trim()} ditambahkan`, { variant: 'success' });
      loadServers();
    } catch (err) {
      error.textContent = err.message;
      btn.removeAttribute('aria-busy');
      busy = false;
    }
    return false;
  };

  body.addEventListener('submit', (e) => { e.preventDefault(); modal.dialog.querySelector('.modal-footer .btn-primary').click(); });

  const modal = showModal({
    title: 'Tambah Server',
    body,
    actions: [
      { label: 'Batal', variant: 'ghost' },
      { label: 'Simpan', variant: 'primary', action: (ctx) => { submit(ctx); return false; } }
    ]
  });
}

// ── Modal Gentelella: konfirmasi hapus ──
function confirmRemove(s) {
  showModal({
    title: 'Hapus server?',
    size: 'sm',
    body: el('p', { style: 'font-size:13px;color:var(--text-secondary);line-height:1.6;margin:0' },
      'Server ', el('strong', { textContent: s.name }), ` (${s.ip}) akan berhenti dipantau Prometheus.`),
    actions: [
      { label: 'Batal', variant: 'ghost' },
      {
        label: 'Hapus', variant: 'danger',
        action: async () => {
          try {
            await api.removeServer(s.id);
            showToast(`Server ${s.name} dihapus`, { variant: 'success' });
            loadServers();
          } catch (err) {
            showToast(err.message, { variant: 'error' });
          }
        }
      }
    ]
  });
}

// ── Menu akun (popover .menu-popover Gentelella) ──
function confirmLogout() {
  showModal({
    title: 'Keluar?',
    size: 'sm',
    body: el('p', { style: 'font-size:13px;color:var(--text-secondary);line-height:1.6;margin:0', textContent: 'Anda perlu masuk kembali untuk membuka dashboard.' }),
    actions: [{ label: 'Batal', variant: 'ghost' }, { label: 'Keluar', variant: 'primary', action: () => auth.logout() }]
  });
}
const accountMenu = () => [
  { label: 'Tambah server', action: openAddServer },
  { label: 'Ganti tema', action: () => $('.theme-toggle').click() },
  '-',
  { label: 'Keluar', action: confirmLogout }
];

// ── Shell Gentelella: sidebar (drawer/rail), tombol tema ──
mountShell();
// mountShell juga memasang menu demo bawaan pada avatar & tombol "…"; ganti dengan menu aplikasi ini
for (const sel of ['.tb-avatar', '.sidebar-user .more-btn']) {
  const old = $(sel);
  const btn = old.cloneNode(true);
  old.replaceWith(btn);
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openMenu(btn, accountMenu()); });
}
$('#alerts-bell').addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  openPanel(e.currentTarget, buildAlertsPanel(), { className: 'panel-notifications', width: 360 });
});

// Tautan sidebar: tandai yang aktif sesuai hash
function syncNav() {
  const hash = location.hash || '#top';
  for (const a of document.querySelectorAll('.sidebar .nav-link')) {
    const on = a.getAttribute('href') === hash;
    a.classList.toggle('active', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', syncNav);
syncNav();

// ── Kontrol ──
$('#ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('.chart-tab');
  if (!btn) return;
  for (const b of $('#ranges').children) b.classList.toggle('active', b === btn);
  state.range = btn.dataset.range;
  loadChart();
});

$('#filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn');
  if (!btn) return;
  for (const b of $('#filters').children) {
    b.classList.toggle('active', b === btn);
    b.setAttribute('aria-pressed', String(b === btn));
  }
  state.filter = btn.dataset.filter;
  renderServers();
});

$('#search').addEventListener('input', (e) => { state.search = e.target.value; renderServers(); });
$('#add-server').addEventListener('click', openAddServer);

// ── Mulai ──
api.me().then((u) => {
  if (!u) return;
  const initial = (u.name ?? '?').trim().charAt(0).toUpperCase();
  $('#user-name').textContent = u.name ?? '—';
  $('#user-role').textContent = u.role === 'admin' ? 'Administrator' : (u.role ?? '');
  $('#user-initial').firstChild.textContent = initial;
  $('.tb-avatar').textContent = initial;
}).catch(() => {});

try {
  const [summary] = await Promise.all([api.summary(), loadChart(), loadAlerts(), loadServers()]);
  renderStats(summary);
} catch (err) {
  showToast(err.message, { variant: 'error', duration: 5000 });
}

api.stream({
  onSummary: (s) => { renderStats(s); loadServers(); },
  onAlerts: () => { loadAlerts(); loadServers(); }
});
