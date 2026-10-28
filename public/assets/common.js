// Gedeelde helpers voor alle pagina's.

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `Er ging iets mis (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Iconen (lijn-iconen, kleuren mee met de tekst)
const PATHS = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 01-3 3H3"/>',
  bell: '<path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  laptop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M1 20h22"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  day: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><rect x="10" y="13.5" width="4" height="4" rx="1"/>',
  week: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4M9.5 10v11M14.5 10v11"/>',
  month: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4M3 15.5h18M9 10v11M15 10v11"/>',
  more: '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>',
  hourglass: '<path d="M6 2h12M6 22h12M7 2v4a5 5 0 005 5 5 5 0 005-5V2M7 22v-4a5 5 0 015-5 5 5 0 015 5v4"/>'
};
export const icon = (name, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;

// ---------- Android-app ----------

export const isApp = document.documentElement.classList.contains('app');

// Korte trilling in de app ('tick' bij tikken, 'confirm' bij opslaan/verwijderen).
export function haptic(kind = 'tick') {
  try {
    window.AgendaNative?.haptic(kind);
  } catch {}
}

// Vervagende randen boven (statusbalk) en onder (navigatiebalk), in drie lagen voor een zachte overloop.
if (isApp) {
  const addEdges = () => {
    if (document.querySelector('.edge')) return;
    document.body.insertAdjacentHTML('beforeend',
      '<div class="edge edge-top" aria-hidden="true"><i></i><i></i><i></i></div>' +
      '<div class="edge edge-bottom" aria-hidden="true"><i></i><i></i><i></i></div>');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addEdges);
  else addEdges();
}

// ---------- Thema ----------

export function themePref() {
  try {
    return localStorage.getItem('theme') || 'systeem';
  } catch {
    return 'systeem';
  }
}

export function applyTheme(pref) {
  try {
    localStorage.setItem('theme', pref);
  } catch {}
  const dark = pref === 'donker' || (pref === 'systeem' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'donker' : 'licht');
  try {
    window.AgendaNative?.setDark(dark);
  } catch {}
  document.dispatchEvent(new CustomEvent('themechange'));
}

export const isDark = () => document.documentElement.getAttribute('data-theme') === 'donker';

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themePref() === 'systeem') applyTheme('systeem');
});

// Zon/maan-knop: wisselt tussen licht en donker.
export function bindThemeButton(btn) {
  const paint = () => {
    btn.innerHTML = icon(isDark() ? 'sun' : 'moon');
    btn.setAttribute('aria-label', isDark() ? 'Lichte modus' : 'Donkere modus');
  };
  paint();
  btn.addEventListener('click', () => applyTheme(isDark() ? 'licht' : 'donker'));
  document.addEventListener('themechange', paint);
}

// ---------- Overig ----------

let toastTimer;
export function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast glass strong';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

export function showError(box, message) {
  box.textContent = message;
  box.hidden = false;
  box.style.animation = 'none';
  void box.offsetWidth;
  box.style.animation = '';
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Gekopieerd');
  } catch {
    toast('Kopiëren lukte niet');
  }
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function passwordScore(pw) {
  let score = 0;
  if (pw.length >= 10) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length > 0 && pw.length < 10) score = Math.min(score, 1);
  return score;
}

export function bindStrength(input, bar, hint) {
  const colors = ['#D2552E', '#E08A2E', '#2F6FED', '#1F9D61'];
  const labels = ['Zwak', 'Redelijk', 'Goed', 'Sterk'];
  const update = () => {
    const pw = input.value;
    const score = passwordScore(pw);
    [...bar.children].forEach((seg, i) => {
      seg.style.backgroundColor = i < score ? colors[score - 1] : '';
      seg.style.transform = i < score ? 'scaleY(1)' : '';
    });
    hint.textContent = !pw ? 'Minimaal 10 tekens' : pw.length < 10 ? `Nog ${10 - pw.length} tekens` : labels[score - 1];
  };
  input.addEventListener('input', update);
  update();
}

export function bindPasswordToggle(btn, input) {
  btn.innerHTML = icon('eye');
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Wachtwoord verbergen' : 'Wachtwoord tonen');
  });
}

// Kleuren per agenda: tint en tekstkleur afgeleid van de agendakleur.
export function calStyle(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const mix = (t, a) => Math.round(r + (t - r) * a) + ',' + Math.round(g + (t - g) * a) + ',' + Math.round(b + (t - b) * a);
  return isDark()
    ? `--c:${hex};--tint:rgba(${r},${g},${b},.26);--ink:rgb(${mix(255, .72)})`
    : `--c:${hex};--tint:rgba(${r},${g},${b},.17);--ink:rgb(${mix(0, .5)})`;
}
