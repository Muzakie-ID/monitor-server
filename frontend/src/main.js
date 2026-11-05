import * as echarts from 'echarts';
import { api, auth } from './api.js';
import { bytes, bits, duration, ago, level } from './format.js';

if (!auth.token) location.href = '/login.html';

const $ = (sel) => document.querySelector(sel);
const state = { range: '24h', filter: 'all', search: '', servers: [] };

// Membuat elemen dengan aman: teks selalu lewat textContent, tidak pernah innerHTML
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c ?? '');
  return node;
}

// ── Baris statistik ──
function renderTiles(s) {
  const tile = (label, value, unit = '') =>
    el('div', { className: 'tile' },
      el('div', { className: 'tile__label', textContent: label }),
      el('div', { className: 'tile__value' }, value ?? '—', el('small', { textContent: value == null ? '' : unit })));
  $('#tiles').replaceChildren(
    tile('Total Server', String(s.total)),
    tile('Server Online', `${s.online}`, ` / ${s.total}`),
    tile('Rata-rata CPU', s.avgCpu?.toString(), '%'),
    tile('Penggunaan Memori', s.avgMem?.toString(), '%'),
    tile('Uptime 30 Hari', s.uptime30d?.toString(), '%')
  );
  $('#updated').textContent = `Diperbarui ${ago(s.updatedAt)}`;
}

// ── Grafik CPU & memori ──
const chart = echarts.init($('#chart'));
window.addEventListener('resize', () => chart.resize());

async function loadChart() {
  const m = await api.metrics(state.range);
  const toSeries = (pts) => pts.map(([t, v]) => [t * 1000, Math.round(v * 10) / 10]);
  chart.setOption({
    grid: { left: 40, right: 16, top: 30, bottom: 30 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => `${v}%` },
    legend: { top: 0, left: 0 },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
    series: [
      { name: 'CPU', type: 'line', showSymbol: false, data: toSeries(m.cpu), color: '#1abb9c', areaStyle: { opacity: 0.15 },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: '#e67e22', type: 'dashed' }, data: [{ yAxis: 80, name: 'Ambang 80%' }] } },
      { name: 'Memori', type: 'line', showSymbol: false, data: toSeries(m.mem), color: '#3498db' }
    ]
  });
}

// ── Peringatan aktif ──
async function loadAlerts() {
  const { active, counts } = await api.alerts();
  $('#alert-counts').textContent = `${counts.kritis} kritis · ${counts.sedang} sedang · ${counts.selesai_hari_ini} selesai hari ini`;
  $('#alert-list').replaceChildren(
    ...(active.length
      ? active.map((a) => el('div', { className: 'alert-item' },
          el('div', {},
            el('div', {}, el('strong', { textContent: a.server ?? a.alertname }), ' ',
              el('span', { className: `badge badge--${a.severity}`, textContent: a.severity })),
            el('div', { textContent: a.summary ?? a.alertname }),
            el('div', { className: 'mono', textContent: ago(a.starts_at) }))))
      : [el('div', { className: 'empty', textContent: 'Tidak ada peringatan aktif.' })])
  );
}

// ── Tabel server ──
function bar(value, base) {
  if (value == null) return '—';
  return el('div', { className: 'bar' },
    el('div', { className: 'bar__track' },
      el('div', { className: 'bar__fill', style: `width:${value}%;background:${level(value, base)}` })),
    el('span', { textContent: `${value}%` }));
}

function renderServers() {
  const q = state.search.toLowerCase();
  const rows = state.servers
    .filter((s) => state.filter === 'all' || s.status === state.filter)
    .filter((s) => !q || s.name.includes(q) || s.ip.includes(q) || s.tags.some((t) => t.toLowerCase().includes(q)));

  $('#server-rows').replaceChildren(
    ...(rows.length
      ? rows.map((s) => el('tr', {},
          el('td', {}, el('div', {}, el('strong', { textContent: s.name })), el('div', { className: 'mono', textContent: s.ip })),
          el('td', {}, el('span', { className: `badge badge--${s.status}`, textContent: s.status })),
          el('td', { textContent: s.region ?? '—' }),
          el('td', {}, bar(s.cpu, '#1abb9c')),
          el('td', {}, bar(s.mem, '#3498db')),
          el('td', { textContent: s.diskSizeBytes ? `${bytes(s.diskUsedBytes)} / ${bytes(s.diskSizeBytes)}` : '—' }),
          el('td', { textContent: s.netRxBps == null ? '—' : `↑${bits(s.netTxBps)} ↓${bits(s.netRxBps)}` }),
          el('td', { textContent: duration(s.uptimeSec) })))
      : [el('tr', {}, el('td', { colSpan: 8, className: 'empty', textContent: 'Belum ada server yang cocok.' }))])
  );
}

async function loadServers() {
  state.servers = await api.servers();
  renderServers();
}

// ── Kontrol ──
function pressGroup(container, attr, value) {
  for (const b of container.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
}

$('#ranges').addEventListener('click', (e) => {
  const r = e.target.closest('button')?.dataset.range;
  if (!r) return;
  state.range = r;
  pressGroup($('#ranges'), 'range', r);
  loadChart();
});

$('#filters').addEventListener('click', (e) => {
  const f = e.target.closest('button')?.dataset.filter;
  if (!f) return;
  state.filter = f;
  pressGroup($('#filters'), 'filter', f);
  renderServers();
});

$('#search').addEventListener('input', (e) => { state.search = e.target.value; renderServers(); });
$('#logout').addEventListener('click', () => auth.logout());

// Formulir sederhana; ganti dengan modal Gentelella (src/v4/modal.js) kalau sudah dipasang
$('#add-server').addEventListener('click', async () => {
  const name = prompt('Nama server (huruf kecil, angka, tanda -):');
  if (!name) return;
  const ip = prompt('Alamat IP:');
  if (!ip) return;
  try {
    await api.addServer({ name, ip });
    await loadServers();
  } catch (err) {
    alert(err.message);
  }
});

// ── Mulai ──
const [summary] = await Promise.all([api.summary(), loadChart(), loadAlerts(), loadServers()]);
renderTiles(summary);

api.stream({
  onSummary: (s) => { renderTiles(s); loadServers(); },
  onAlerts: () => { loadAlerts(); loadServers(); }
});
