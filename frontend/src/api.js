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

  // Update live: onSummary dipanggil tiap 15 detik, onAlerts saat ada peringatan baru
  stream({ onSummary, onAlerts }) {
    const es = new EventSource(`/api/stream?token=${encodeURIComponent(auth.token ?? '')}`);
    es.addEventListener('summary', (e) => onSummary?.(JSON.parse(e.data)));
    es.addEventListener('alerts', () => onAlerts?.());
    return () => es.close();
  }
};
