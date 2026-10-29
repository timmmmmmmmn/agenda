import { api, $, icon, bindThemeButton, bindPasswordToggle, showError, toast, dateLogo } from './common.js';

dateLogo($('#brandMark'));
bindThemeButton($('#themeBtn'));
bindPasswordToggle($('#pwToggle'), $('#pw'));

// Al ingelogd? Direct door naar de agenda.
api('me').then(() => location.replace('/')).catch(() => {});

$('#forgot').addEventListener('click', (e) => {
  e.preventDefault();
  toast('Vraag de beheerder om je wachtwoord te resetten.');
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('#submit');
  btn.disabled = true;
  btn.textContent = 'Bezig…';
  try {
    await api('login', { method: 'POST', body: { login: f.login.value.trim(), password: f.password.value, remember: f.remember.checked } });
    location.replace('/');
  } catch (err) {
    showError($('#error'), err.message);
    btn.disabled = false;
    btn.textContent = 'Inloggen';
  }
});
