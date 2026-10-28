import { api, esc, $, $$, icon, toast, copy, themePref, applyTheme, bindStrength } from './common.js';

const COLORS = ['#2F6FED', '#0E8A7E', '#1F9D61', '#E07A2E', '#D2552E', '#E5484D', '#8B5CF6', '#D6409F', '#5B6478'];
let me;

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'nog niet gebruikt');

// Dubbelklik-bevestiging voor knoppen die iets weggooien.
function confirmed(btn, label = 'Zeker weten?') {
  if (btn.dataset.confirm) return true;
  const orig = btn.textContent;
  btn.dataset.confirm = '1';
  btn.textContent = label;
  setTimeout(() => {
    if (btn.isConnected) {
      delete btn.dataset.confirm;
      btn.textContent = orig;
    }
  }, 4000);
  return false;
}

// ---------- Thema ----------

function paintThemeSeg() {
  const pref = themePref();
  const btns = $$('#themeSeg button');
  btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === pref)));
  const idx = btns.findIndex((b) => b.dataset.theme === pref);
  $('#themeSeg .pill').style.transform = `translateX(${idx * ((btns[0].offsetWidth || 92) + 2)}px)`;
}

// ---------- Profiel ----------

function fillProfile() {
  $('#username').textContent = me.username;
  $('#profileForm').full_name.value = me.full_name;
  $('#profileForm').email.value = me.email;
  const host = location.host;
  $('#host').textContent = host;
  $('#davUrl').textContent = `${location.origin}/dav/`;
  $('#davUser').textContent = me.username;
  $('#davUser2').textContent = me.username;
}

// ---------- App-wachtwoorden ----------

async function loadAppPasswords() {
  const list = await api('app-passwords');
  $('#apList').innerHTML = list.length ? list.map((a) => `
    <div class="row">
      <span class="dot" style="background:${a.last_used_at ? 'var(--ok)' : 'var(--muted)'}"></span>
      <div class="grow"><span>${esc(a.name)}</span><span class="small">Laatst gebruikt: ${fmtDate(a.last_used_at)}</span></div>
      <button class="ghost press sm danger" type="button" data-revoke="${a.id}">Intrekken</button>
    </div>`).join('') : '<p class="empty" style="margin:0">Nog geen app-wachtwoorden.</p>';
}

// ---------- Agenda's ----------

async function loadCalendars() {
  const cals = await api('calendars');
  const own = cals.filter((c) => c.is_owner);
  const shared = cals.filter((c) => !c.is_owner);
  $('#calCards').innerHTML = own.map((c) => `
    <div class="cal-card" data-cal="${esc(c.id)}">
      <div class="top">
        <span class="dot" style="background:${esc(c.color)};width:14px;height:14px;border-radius:7px"></span>
        <label class="sr-only" for="n-${esc(c.id)}">Naam</label>
        <input class="field" id="n-${esc(c.id)}" data-rename value="${esc(c.name)}" maxlength="60">
        ${own.length > 1 ? '<button class="ghost press sm danger" type="button" data-delcal>Verwijderen</button>' : ''}
      </div>
      <div class="swatches" role="group" aria-label="Kleur">
        ${COLORS.map((col) => `<button type="button" class="swatch" style="--c:${col}" data-color="${col}" aria-label="Kleur ${col}" aria-pressed="${col.toLowerCase() === c.color.toLowerCase()}"></button>`).join('')}
      </div>
      <div class="share-list">
        ${c.shares.length ? c.shares.map((s) => `
          <div class="share">
            <span class="who"><strong>${esc(s.full_name)}</strong> <span class="label">@${esc(s.username)}</span></span>
            <button class="soft press sm" type="button" data-toggle-write="${s.user_id}" data-username="${esc(s.username)}" data-write="${s.can_write ? 1 : 0}">${s.can_write ? 'Kan bewerken' : 'Alleen bekijken'}</button>
            <button class="ghost press sm" type="button" data-unshare="${s.user_id}" aria-label="Delen stoppen met ${esc(s.full_name)}">Stoppen</button>
          </div>`).join('') : '<span class="label" style="font-size:13px">Niet gedeeld</span>'}
      </div>
      <form class="inline-form" data-share>
        <label class="sr-only" for="s-${esc(c.id)}">Gebruikersnaam</label>
        <input class="field" id="s-${esc(c.id)}" name="username" placeholder="Gebruikersnaam" autocapitalize="none" autocomplete="off">
        <select class="field" name="can_write" aria-label="Rechten"><option value="1">Kan bewerken</option><option value="0">Alleen bekijken</option></select>
        <button class="btn press" type="submit" style="height:40px">Delen</button>
      </form>
    </div>`).join('');
  $('#sharedWithMe').innerHTML = shared.length ? `
    <span class="panel-title" style="margin-top:6px">Met jou gedeeld</span>
    <div style="display:flex;flex-direction:column;gap:8px">${shared.map((c) => `
      <div class="row" data-cal="${esc(c.id)}">
        <span class="dot" style="background:${esc(c.color)}"></span>
        <div class="grow"><span>${esc(c.name)}</span><span class="small">van ${esc(c.owner.full_name)} · ${c.can_write ? 'kan bewerken' : 'alleen bekijken'}</span></div>
        <button class="ghost press sm" type="button" data-leave>Verwijderen uit mijn lijst</button>
      </div>`).join('')}</div>` : '';
}

// ---------- Beheer ----------

async function loadUsers() {
  const users = await api('admin/users');
  const label = { pending: 'Wacht op goedkeuring', active: 'Actief', disabled: 'Uitgeschakeld' };
  $('#userRows').innerHTML = users.map((u) => {
    const self = u.id === me.id;
    const actions = self ? '<span class="label" style="font-size:13px">Dit ben jij</span>' : [
      u.status === 'pending' ? `<button class="primary press sm" type="button" data-status="active">Goedkeuren</button>` : '',
      u.status === 'active' ? `<button class="btn press sm" type="button" data-status="disabled">Uitschakelen</button>` : '',
      u.status === 'disabled' ? `<button class="btn press sm" type="button" data-status="active">Activeren</button>` : '',
      u.status !== 'pending' ? `<button class="btn press sm" type="button" data-reset>Wachtwoord resetten</button>` : '',
      `<button class="ghost press sm danger" type="button" data-deluser>${u.status === 'pending' ? 'Weigeren' : 'Verwijderen'}</button>`
    ].join('');
    return `<tr data-user="${u.id}" data-name="${esc(u.full_name)}">
      <td><strong>${esc(u.full_name)}</strong>${u.is_admin ? ' <span class="label" style="font-size:12px">· beheerder</span>' : ''}</td>
      <td class="mono">${esc(u.username)}</td>
      <td>${esc(u.email)}</td>
      <td><span class="status ${u.status}">${label[u.status]}</span></td>
      <td><div class="actions">${actions}</div></td>
    </tr>`;
  }).join('');
}

// ---------- Start ----------

async function init() {
  try {
    me = await api('me');
  } catch {
    return location.replace('/login');
  }
  $('#back').innerHTML = `${icon('left')} Agenda`;
  $('#iconApple').innerHTML = icon('laptop');
  $('#iconPhone').innerHTML = icon('phone');
  paintThemeSeg();
  fillProfile();
  bindStrength($('#pwForm').password, $('#strength'), $('#pwHint'));

  $$('#themeSeg button').forEach((b) => b.addEventListener('click', () => {
    applyTheme(b.dataset.theme);
    paintThemeSeg();
  }));

  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copy($(`#${b.dataset.copy}`).textContent)));

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('me', { method: 'PATCH', body: { full_name: e.target.full_name.value, email: e.target.email.value } });
      toast('Profiel opgeslagen');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('me/password', { method: 'POST', body: { current: e.target.current.value, password: e.target.password.value } });
      e.target.reset();
      e.target.password.dispatchEvent(new Event('input'));
      toast('Wachtwoord gewijzigd');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#apForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('app-passwords', { method: 'POST', body: { name: e.target.name.value.trim() } });
      e.target.reset();
      const box = $('#apNew');
      box.hidden = false;
      box.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px">
          <span class="sub">Wachtwoord voor <strong>${esc(res.name)}</strong>. Je ziet het maar één keer; vul het nu in op je apparaat.</span>
          <div class="secret mono" id="secret">${esc(res.password)}</div>
          <div style="display:flex;gap:8px"><button class="soft press" type="button" id="copySecret" style="flex-grow:1">Kopieer</button><button class="btn press" type="button" id="hideSecret">Klaar</button></div>
        </div>`;
      $('#copySecret').addEventListener('click', () => copy(res.password));
      $('#hideSecret').addEventListener('click', () => {
        box.hidden = true;
        box.innerHTML = '';
      });
      loadAppPasswords();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#apList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b || !confirmed(b)) return;
    await api(`app-passwords/${b.dataset.revoke}`, { method: 'DELETE' });
    toast('App-wachtwoord ingetrokken');
    loadAppPasswords();
  });

  $('#newCalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    try {
      await api('calendars', { method: 'POST', body: { name, color: COLORS[Math.floor(Math.random() * COLORS.length)] } });
      e.target.reset();
      toast('Agenda toegevoegd');
      loadCalendars();
    } catch (err) {
      toast(err.message);
    }
  });

  const cals = $('#h-cals').closest('section');
  cals.addEventListener('click', async (e) => {
    const card = e.target.closest('[data-cal]');
    if (!card) return;
    const id = card.dataset.cal;
    const run = async (fn, msg) => {
      try {
        await fn();
        if (msg) toast(msg);
        loadCalendars();
      } catch (err) {
        toast(err.message);
      }
    };
    const color = e.target.closest('[data-color]');
    if (color) return run(() => api(`calendars/${id}`, { method: 'PATCH', body: { color: color.dataset.color } }));
    const del = e.target.closest('[data-delcal]');
    if (del && confirmed(del, 'Ook alle afspraken weg?')) return run(() => api(`calendars/${id}`, { method: 'DELETE' }), 'Agenda verwijderd');
    const leave = e.target.closest('[data-leave]');
    if (leave && confirmed(leave)) return run(() => api(`calendars/${id}`, { method: 'DELETE' }), 'Agenda verwijderd uit je lijst');
    const un = e.target.closest('[data-unshare]');
    if (un) return run(() => api(`calendars/${id}/shares/${un.dataset.unshare}`, { method: 'DELETE' }), 'Delen gestopt');
    const tw = e.target.closest('[data-toggle-write]');
    if (tw) return run(() => api(`calendars/${id}/shares`, { method: 'POST', body: { username: tw.dataset.username, can_write: tw.dataset.write !== '1' } }));
  });
  cals.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-rename]')) return;
    const id = e.target.closest('[data-cal]').dataset.cal;
    try {
      await api(`calendars/${id}`, { method: 'PATCH', body: { name: e.target.value } });
      toast('Naam opgeslagen');
    } catch (err) {
      toast(err.message);
    }
  });
  cals.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-share]')) return;
    e.preventDefault();
    const id = e.target.closest('[data-cal]').dataset.cal;
    try {
      await api(`calendars/${id}/shares`, { method: 'POST', body: { username: e.target.username.value.trim(), can_write: e.target.can_write.value === '1' } });
      toast('Agenda gedeeld');
      loadCalendars();
    } catch (err) {
      toast(err.message);
    }
  });

  await Promise.all([loadAppPasswords(), loadCalendars()]);

  if (me.is_admin) {
    $('#beheer').hidden = false;
    await loadUsers();
    if (location.hash === '#beheer') $('#beheer').scrollIntoView({ behavior: 'smooth' });
    $('#userRows').addEventListener('click', async (e) => {
      const row = e.target.closest('[data-user]');
      if (!row) return;
      const id = row.dataset.user;
      try {
        const st = e.target.closest('[data-status]');
        if (st) {
          await api(`admin/users/${id}`, { method: 'PATCH', body: { status: st.dataset.status } });
          toast(st.dataset.status === 'active' ? 'Account geactiveerd' : 'Account uitgeschakeld');
        }
        const rs = e.target.closest('[data-reset]');
        if (rs) {
          if (!confirmed(rs)) return;
          const { password } = await api(`admin/users/${id}/reset-password`, { method: 'POST' });
          const box = $('#adminNew');
          box.hidden = false;
          box.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
            <span class="sub">Tijdelijk wachtwoord voor <strong>${esc(row.dataset.name)}</strong>. Geef dit door; het kan daarna in Instellingen worden gewijzigd.</span>
            <div class="secret mono">${esc(password)}</div></div>`;
        }
        const du = e.target.closest('[data-deluser]');
        if (du) {
          if (!confirmed(du)) return;
          await api(`admin/users/${id}`, { method: 'DELETE' });
          toast('Account verwijderd');
        }
        loadUsers();
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

init();
