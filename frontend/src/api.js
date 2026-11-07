// Satu-satunya tempat frontend berbicara dengan backend.
const TOKEN_KEY = 'pantau:token';

export const auth = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set token(v) {
    try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* abaikan */ }
  },
  logout() {
    this.token = null;
    location.href = '/login.html';
  }
};

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      ...options.headers
    }
  });
  if (res.status === 401) return auth.logout();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Permintaan gagal (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request('/api/auth/me'),
  summary: () => request('/api/summary'),
  servers: () => request('/api/servers'),
  regions: () => request('/api/regions'),
  addServer: (data) => request('/api/servers', { method: 'POST', body: JSON.stringify(data) }),
  removeServer: (id) => request(`/api/servers/${id}`, { method: 'DELETE' }),
  metrics: (range = '24h', server) =>
    request(`/api/metrics/range?range=${range}${server ? `&server=${encodeURIComponent(server)}` : ''}`),
  alerts: () => request('/api/alerts'),

  // Pemasangan otomatis lewat SSH
  provisionInfo: () => request('/api/provision/info'),
  testConnection: (body) => request('/api/provision/test', { method: 'POST', body: JSON.stringify(body) }),
  reprovision: (id, body) => request(`/api/servers/${id}/provision`, { method: 'POST', body: JSON.stringify(body) }),
  recheck: (id) => request(`/api/servers/${id}/recheck`, { method: 'POST', body: '{}' }),
  uninstall: (id, body) => request(`/api/servers/${id}/uninstall`, { method: 'POST', body: JSON.stringify(body) }),
  serverJobs: (id) => request(`/api/servers/${id}/jobs`),
  job: (id) => request(`/api/jobs/${id}`),
  answerHostkey: (id, accept) => request(`/api/jobs/${id}/hostkey`, { method: 'POST', body: JSON.stringify({ accept }) }),
  answerPlan: (id, approve) => request(`/api/jobs/${id}/approve`, { method: 'POST', body: JSON.stringify({ approve }) }),
  cancelJob: (id) => request(`/api/jobs/${id}/cancel`, { method: 'POST', body: '{}' }),
  audit: (limit = 200) => request(`/api/audit?limit=${limit}`),

  // Update live: onSummary dipanggil tiap 15 detik, onAlerts saat ada peringatan baru
  stream({ onSummary, onAlerts, onProvision }) {
    const es = new EventSource(`/api/stream?token=${encodeURIComponent(auth.token ?? '')}`);
    es.addEventListener('summary', (e) => onSummary?.(JSON.parse(e.data)));
    es.addEventListener('alerts', () => onAlerts?.());
    es.addEventListener('provision', (e) => onProvision?.(JSON.parse(e.data)));
    return () => es.close();
  }
};
