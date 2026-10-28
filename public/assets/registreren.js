import { api, $, icon, bindThemeButton, bindPasswordToggle, bindStrength, showError, USERNAME_RE, EMAIL_RE } from './common.js';

$('#back').innerHTML = `${icon('left')} Inloggen`;
bindThemeButton($('#themeBtn'));
bindPasswordToggle($('#pwToggle'), $('#pw'));
bindStrength($('#pw'), $('#strength'), $('#pwHint'));

const form = $('#form');
const hint = $('#userHint');
const defaultHint = hint.textContent;

function validate() {
  const u = form.username.value;
  const userOk = USERNAME_RE.test(u);
  hint.className = 'hint' + (u && !userOk ? ' bad' : userOk ? ' ok' : '');
  hint.textContent = u && !userOk
    ? 'Gebruik 3–32 tekens: kleine letters, cijfers, . _ of -'
    : userOk ? `${location.host}/dav/ · gebruikersnaam ${u}` : defaultHint;
  $('#submit').disabled = !(userOk && form.full_name.value.trim().length > 1 && EMAIL_RE.test(form.email.value.trim()) && form.password.value.length >= 10);
}

form.username.addEventListener('input', () => {
  const lower = form.username.value.toLowerCase().replace(/\s/g, '');
  if (lower !== form.username.value) form.username.value = lower;
});
form.addEventListener('input', validate);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#submit');
  btn.disabled = true;
  btn.textContent = 'Bezig…';
  try {
    const res = await api('register', {
      method: 'POST',
      body: {
        username: form.username.value,
        full_name: form.full_name.value.trim(),
        email: form.email.value.trim(),
        password: form.password.value
      }
    });
    if (res.status === 'active') return location.replace('/');
    form.hidden = true;
    $('#doneMark').innerHTML = icon('hourglass');
    $('#done').hidden = false;
    $('#done').classList.add('rise');
  } catch (err) {
    showError($('#error'), err.message);
    btn.textContent = 'Account aanmaken';
    validate();
  }
});
