// Helper DOM bersama. Teks selalu lewat textContent, tidak pernah innerHTML.
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c ?? '');
  return node;
}

// SVG ikon statis (bukan data pengguna) — aman di-parse dari string
export function icon(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild;
}

export const ICONS = {
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
  mem: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="10" rx="1.5"/><path d="M6 11v2M10 11v2M14 11v2M18 11v2"/></svg>',
  uptime: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  more: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="13" cy="8" r="1.3"/></svg>',
  warn: '<svg class="alert-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5l6.5 12h-13L8 1.5z"/><path d="M8 6v3.5M8 11.5h.01"/></svg>',
  info: '<svg class="alert-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 7v4M8 5h.01"/></svg>',
  ok: '<svg class="alert-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 8l2 2 3.5-4"/></svg>',
  key: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="11" r="3"/><path d="M7.2 8.8L14 2M11 5l2 2"/></svg>'
};

// ── Komponen Gentelella ──
export function emptyState(title, desc, svg = ICONS.check) {
  return el('div', { className: 'empty-state' },
    el('div', { className: 'empty-state-icon' }, icon(svg)),
    el('div', { className: 'empty-state-title', textContent: title }),
    el('div', { className: 'empty-state-desc', textContent: desc }));
}

export function alertBox(variant, ...children) {
  const svg = { error: ICONS.warn, warning: ICONS.warn, success: ICONS.ok, info: ICONS.info }[variant];
  return el('div', { className: `alert alert-${variant}`, role: variant === 'error' ? 'alert' : 'status' },
    icon(svg), el('div', { className: 'alert-body' }, ...children));
}

export function field(label, input, hint) {
  return el('div', { className: 'form-group' },
    el('label', { className: 'form-label', htmlFor: input.id }, label), input,
    hint ? el('div', { className: 'form-hint', textContent: hint }) : '');
}

export function check(id, label, checked = false) {
  const input = el('input', { type: 'checkbox', id, checked });
  return { input, node: el('label', { className: 'form-check', htmlFor: id }, input, ' ', label) };
}

export function busy(btn, on, text) {
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.setAttribute('aria-busy', 'true');
    btn.replaceChildren(el('span', { className: 'btn-spinner' }), ` ${text ?? btn.dataset.label}`);
  } else {
    btn.removeAttribute('aria-busy');
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
}

export function fmtTime(iso) {
  return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}
