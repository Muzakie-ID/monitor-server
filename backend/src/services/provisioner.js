import { config } from '../config.js';

// Klien API internal provisioner. Kata sandi SSH hanya diteruskan, tidak disimpan.
export async function provisioner(method, path, body) {
  let res;
  try {
    res = await fetch(new URL(path, config.provisionerUrl), {
      method,
      headers: { 'Content-Type': 'application/json', 'x-provisioner-token': config.provisionerToken },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90_000)
    });
  } catch {
    throw Object.assign(new Error('Layanan provisioner tidak bisa dihubungi. Cek container "provisioner".'), { statusCode: 502 });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw Object.assign(new Error('PROVISIONER_TOKEN backend dan provisioner tidak sama. Samakan di .env lalu jalankan ulang.'), { statusCode: 502 });
  }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Provisioner: HTTP ${res.status}`), { statusCode: res.status >= 500 ? 502 : res.status });
  return data;
}
