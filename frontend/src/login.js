import './styles/main.scss';
import { showToast } from 'gentelella/v4/toast';
import { auth } from './api.js';

const form = document.getElementById('login-form');
const submit = document.getElementById('login-submit');
const errorBox = document.getElementById('login-error');
const errorText = document.getElementById('login-error-text');

function showError(message) {
  errorText.textContent = message;
  errorBox.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.hidden = true;
  for (const input of form.querySelectorAll('.form-control')) input.classList.toggle('is-invalid', !input.checkValidity());
  if (!form.checkValidity()) return showError('Isi email dan kata sandi dengan benar.');

  const data = new FormData(form);
  const label = submit.textContent;
  submit.setAttribute('aria-busy', 'true');
  submit.replaceChildren(Object.assign(document.createElement('span'), { className: 'btn-spinner' }), ' Memproses…');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: data.get('email'), password: data.get('password') })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? 'Gagal masuk');
    auth.token = body.token;
    showToast('Berhasil masuk', { variant: 'success', duration: 800 });
    setTimeout(() => { location.href = '/'; }, 400);
  } catch (err) {
    showError(err.message);
    submit.removeAttribute('aria-busy');
    submit.textContent = label;
  }
});
