import { auth } from './api.js';

const form = document.getElementById('login-form');
const error = document.getElementById('login-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  const data = new FormData(form);
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: data.get('email'), password: data.get('password') })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Gagal masuk');
    auth.token = body.token;
    location.href = '/';
  } catch (err) {
    error.textContent = err.message;
  }
});
