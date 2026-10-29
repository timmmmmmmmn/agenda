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

// ---------- Abonneren, importeren, back-up ----------

let allCals = [];

async function loadData() {
  allCals = await api('calendars');
  const feeds = await Promise.all(allCals.map((c) => api(`calendars/${c.id}/feed`).then((r) => r.url).catch(() => null)));
  $('#feedList').innerHTML = allCals.map((c, i) => {
    const url = feeds[i];
    return `<div class="row data-row" data-cal="${esc(c.id)}">
      <span class="dot" style="background:${esc(c.color)}"></span>
      <div class="grow"><span>${esc(c.name)}</span>${url ? `<span class="small mono feed-url">${esc(url)}</span>` : '<span class="small">Geen link</span>'}</div>
      <div class="actions">${url ? `
        <button class="soft press sm" type="button" data-copyfeed="${esc(url)}">Kopieer</button>
        <a class="soft press sm" href="${esc(url.replace(/^https:/, 'webcal:'))}">Openen</a>
        <button class="ghost press sm" type="button" data-newfeed>Nieuwe link</button>
        <button class="ghost press sm danger" type="button" data-stopfeed>Stoppen</button>`
        : '<button class="btn press sm" type="button" data-newfeed>Link maken</button>'}
      </div>
    </div>`;
  }).join('');
  const writable = allCals.filter((c) => c.can_write);
  const cur = $('#impCal').value;
  $('#impCal').innerHTML = writable.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.is_owner ? '' : ` (${esc(c.owner.full_name)})`}</option>`).join('');
  if (cur && writable.some((c) => c.id === cur)) $('#impCal').value = cur;
  $('#expList').innerHTML = allCals.map((c) => `
    <a class="row data-row dl-one" href="/api/export?calendar=${encodeURIComponent(c.id)}" download>
      <span class="dot" style="background:${esc(c.color)}"></span>
      <span class="grow">${esc(c.name)}${c.is_owner ? '' : ` <span class="small">van ${esc(c.owner.full_name)}</span>`}</span>
      ${icon('download')}
    </a>`).join('');
}

// Een .ics in stukjes opdelen (per afspraak-UID), zodat grote bestanden in delen naar de server gaan.
function splitIcs(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const zones = [];
  const groups = new Map();
  let depth = 0;
  let cur = null;
  let kind = null;
  for (const line of lines) {
    const up = line.toUpperCase();
    if (up.startsWith('BEGIN:')) {
      depth++;
      if (depth === 2) {
        kind = up.slice(6).trim();
        cur = [];
      }
    }
    if (cur) cur.push(line);
    if (up.startsWith('END:')) {
      if (depth === 2 && cur) {
        if (kind === 'VTIMEZONE') zones.push(cur.join('\r\n'));
        else if (kind === 'VEVENT') {
          const uid = (cur.find((l) => /^UID[:;]/i.test(l)) || '').replace(/^[^:]*:/, '').trim() || `${Math.random()}`;
          if (!groups.has(uid)) groups.set(uid, []);
          groups.get(uid).push(cur.join('\r\n'));
        }
        cur = null;
      }
      depth--;
    }
  }
  const items = [...groups.values()];
  const chunks = [];
  for (let i = 0; i < items.length; i += 150) {
    chunks.push(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//timvanbergen.nl//Agenda import//NL', ...zones, ...items.slice(i, i + 150).flat(), 'END:VCALENDAR'].join('\r\n'));
  }
  return { chunks, total: items.length };
}

function impStatus(html, kind = '') {
  const box = $('#impStatus');
  box.hidden = !html;
  box.className = `imp-status ${kind}`;
  box.innerHTML = html;
}

async function runImport(text) {
  const calId = $('#impCal').value;
  if (!calId) return impStatus('Je hebt geen agenda waarin je mag schrijven.', 'err');
  if (!/BEGIN:VCALENDAR/i.test(text)) return impStatus('Dit is geen agendabestand (.ics).', 'err');
  const { chunks, total } = splitIcs(text);
  if (!total) return impStatus('Er staan geen afspraken in dit bestand.', 'err');
  let added = 0;
  let skipped = 0;
  for (let i = 0; i < chunks.length; i++) {
    impStatus(`<span class="spinner"></span> Importeren… ${Math.min(total, (i + 1) * 150)} van ${total}`);
    const res = await api(`calendars/${encodeURIComponent(calId)}/import`, { method: 'POST', body: { ics: chunks[i] } });
    added += res.added;
    skipped += res.skipped;
  }
  const name = allCals.find((c) => c.id === calId)?.name || 'je agenda';
  impStatus(`${icon('check')} ${added} ${added === 1 ? 'afspraak' : 'afspraken'} in <strong>${esc(name)}</strong> gezet${skipped ? ` (${skipped} overgeslagen)` : ''}.`, 'ok');
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

  $('#icFeed').innerHTML = icon('link');
  $('#icImport').innerHTML = icon('upload');
  $('#icBackup').innerHTML = icon('download');
  $('#expAll').innerHTML = `${icon('download')} Alles downloaden (.zip)`;
  $('#feedList').addEventListener('click', async (e) => {
    const cp = e.target.closest('[data-copyfeed]');
    if (cp) return copy(cp.dataset.copyfeed);
    const row = e.target.closest('[data-cal]');
    if (!row) return;
    const id = encodeURIComponent(row.dataset.cal);
    try {
      if (e.target.closest('[data-newfeed]')) {
        const { url } = await api(`calendars/${id}/feed`, { method: 'POST' });
        await loadData();
        copy(url);
      } else {
        const stop = e.target.closest('[data-stopfeed]');
        if (stop && confirmed(stop)) {
          await api(`calendars/${id}/feed`, { method: 'DELETE' });
          toast('Link werkt niet meer');
          loadData();
        }
      }
    } catch (err) {
      toast(err.message);
    }
  });
  $('#impFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 8e6) return impStatus('Dit bestand is te groot (max. 8 MB).', 'err');
    try {
      await runImport(await file.text());
    } catch (err) {
      impStatus(esc(err.message), 'err');
    }
  });
  $('#impUrlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = e.target.url.value.trim();
    if (!url) return;
    impStatus('<span class="spinner"></span> Ophalen…');
    try {
      const { ics } = await api('import/fetch', { method: 'POST', body: { url } });
      await runImport(ics);
      e.target.reset();
    } catch (err) {
      impStatus(esc(err.message), 'err');
    }
  });

  await Promise.all([loadAppPasswords(), loadCalendars(), loadData()]);

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
