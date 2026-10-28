import { api, esc, $, $$, icon, bindThemeButton, toast, showError, initials, calStyle } from './common.js';

const HOUR = 52;
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const DOW = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
const narrow = matchMedia('(max-width: 900px)');

// ---------- Datumhulpjes (lokale tijd) ----------

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${d.getHours()}:${pad(d.getMinutes())}`;
const hm2 = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

// ---------- Toestand ----------

const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  }
};

const state = {
  me: null,
  cals: [],
  hidden: new Set(store.get('hiddenCals', [])),
  view: store.get('view', narrow.matches ? 'day' : 'week'),
  cursor: startOfDay(new Date()),
  miniMonth: null,
  events: [],
  selected: null,
  animate: true
};

const calById = (id) => state.cals.find((c) => c.id === id);
const occId = (o) => `${o.id}|${o.key}`;

function range() {
  if (state.view === 'day') return [state.cursor, addDays(state.cursor, 1)];
  if (state.view === 'week') {
    const s = startOfWeek(state.cursor);
    return [s, addDays(s, 7)];
  }
  const s = startOfWeek(new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1));
  return [s, addDays(s, 42)];
}

// ---------- Laden ----------

let loadSeq = 0;

function setSync(kind, text) {
  $('#sync').className = `sync ${kind}`;
  $('#syncText').textContent = text;
}

async function load({ animate = false } = {}) {
  const seq = ++loadSeq;
  const [from, to] = range();
  setSync('busy', 'Bijwerken…');
  try {
    const [cals, events] = await Promise.all([
      api('calendars'),
      api(`events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
    ]);
    if (seq !== loadSeq) return;
    state.cals = cals;
    state.events = events.map((o) => ({
      ...o,
      startD: o.allDay ? parseYmd(o.start) : new Date(o.start),
      endD: o.allDay ? parseYmd(o.end) : new Date(o.end)
    }));
    setSync('', 'Gesynchroniseerd');
  } catch (err) {
    if (err.status === 401) return location.replace('/login');
    setSync('err', 'Niet verbonden');
  }
  state.animate = animate;
  render();
}

const visible = () => state.events.filter((e) => !state.hidden.has(e.calendar_id) && calById(e.calendar_id));

// ---------- Weergave ----------

function render() {
  renderHeader();
  renderMini();
  renderCals();
  renderBoard();
  renderDetail();
  state.animate = false;
}

function renderHeader() {
  const c = state.cursor;
  let title, sub;
  if (state.view === 'day') {
    title = `${DAYS[c.getDay()]} ${c.getDate()} ${MONTHS[c.getMonth()]}`;
    sub = `${c.getFullYear()} · week ${isoWeek(c)}`;
  } else if (state.view === 'week') {
    const s = startOfWeek(c);
    const e = addDays(s, 6);
    title = s.getMonth() === e.getMonth()
      ? `${s.getDate()} – ${e.getDate()} ${MONTHS_SHORT[e.getMonth()]} ${e.getFullYear()}`
      : `${s.getDate()} ${MONTHS_SHORT[s.getMonth()]} – ${e.getDate()} ${MONTHS_SHORT[e.getMonth()]} ${e.getFullYear()}`;
    sub = `Week ${isoWeek(s)}`;
  } else {
    title = `${MONTHS[c.getMonth()]} ${c.getFullYear()}`;
    sub = '';
  }
  $('#title').textContent = title.charAt(0).toUpperCase() + title.slice(1);
  $('#subtitle').textContent = sub;
  const views = ['day', 'week', 'month'];
  const idx = views.indexOf(state.view);
  $$('#viewSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  const w = $('#viewSeg button').offsetWidth || 76;
  $('#viewSeg .pill').style.transform = `translateX(${idx * (w + 2)}px)`;
}

function renderMini() {
  const m = state.miniMonth || new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1);
  state.miniMonth = m;
  const start = startOfWeek(m);
  const [rs, re] = range();
  const today = new Date();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.getMonth() !== m.getMonth()) break;
    const cls = [
      d.getMonth() !== m.getMonth() ? 'out' : '',
      sameDay(d, today) ? 'today' : (state.view !== 'month' && d >= rs && d < re ? 'range' : '')
    ].join(' ');
    cells += `<button type="button" class="${cls}" data-goto="${ymd(d)}" aria-label="${d.getDate()} ${MONTHS[d.getMonth()]}">${d.getDate()}</button>`;
  }
  $('#mini').innerHTML = `
    <div class="mini-head">
      <strong>${MONTHS[m.getMonth()]} ${m.getFullYear()}</strong>
      <span>
        <button type="button" class="icon-btn press" data-mini="-1" aria-label="Vorige maand">${icon('left')}</button>
        <button type="button" class="icon-btn press" data-mini="1" aria-label="Volgende maand">${icon('right')}</button>
      </span>
    </div>
    <div class="mini-grid">${DOW.map((d) => `<span class="dow">${d}</span>`).join('')}${cells}</div>`;
}

function renderCals() {
  if (!state.cals.length) {
    $('#calList').innerHTML = '<p class="empty">Nog geen agenda\'s.</p>';
    return;
  }
  $('#calList').innerHTML = state.cals.map((c) => {
    let meta = '';
    if (!c.is_owner) meta = `${esc(c.owner.full_name.split(' ')[0])}${c.can_write ? '' : ' · lezen'}`;
    else if (c.shares?.length) meta = `Gedeeld · ${c.shares.length}`;
    return `<label class="cal-row">
      <input type="checkbox" data-cal="${esc(c.id)}" ${state.hidden.has(c.id) ? '' : 'checked'} style="accent-color:${esc(c.color)}">
      <span class="name">${esc(c.name)}</span><span class="meta">${meta}</span>
    </label>`;
  }).join('');
}

function timeLabel(o) {
  if (o.allDay) {
    const last = addDays(o.endD, -1);
    return sameDay(o.startD, last) ? 'Hele dag' : `${o.startD.getDate()} ${MONTHS_SHORT[o.startD.getMonth()]} – ${last.getDate()} ${MONTHS_SHORT[last.getMonth()]}`;
  }
  if (sameDay(o.startD, o.endD) || (o.endD - o.startD <= 864e5 && hm2(o.endD) === '00:00' && sameDay(addDays(o.startD, 1), o.endD))) {
    return `${hm(o.startD)} – ${hm(o.endD)}`;
  }
  return `${o.startD.getDate()} ${MONTHS_SHORT[o.startD.getMonth()]} ${hm(o.startD)} – ${o.endD.getDate()} ${MONTHS_SHORT[o.endD.getMonth()]} ${hm(o.endD)}`;
}

function renderDetail() {
  const o = state.events.find((e) => occId(e) === state.selected);
  const box = $('#detail');
  if (!o || !calById(o.calendar_id)) {
    box.innerHTML = '<p class="empty" style="margin:0">Klik op een afspraak om de details te zien.</p>';
    return;
  }
  const c = calById(o.calendar_id);
  const d = o.startD;
  box.innerHTML = `<div class="detail">
    <div style="display:flex;align-items:center;gap:8px"><span class="dot" style="background:${esc(c.color)}"></span><span class="label" style="font-size:12px">${esc(c.name)}</span></div>
    <h3>${esc(o.title || '(geen titel)')}</h3>
    <div class="meta-row">${icon('clock')}<span>${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}, ${esc(timeLabel(o))}</span></div>
    ${o.location ? `<div class="meta-row">${icon('pin')}<span>${esc(o.location)}</span></div>` : ''}
    ${o.recurring ? `<div class="meta-row">${icon('repeat')}<span>Herhalende afspraak</span></div>` : ''}
    ${o.notes ? `<div class="notes">${esc(o.notes)}</div>` : ''}
    <div style="display:flex;gap:8px">
      <button type="button" class="btn press" style="flex-grow:1" data-edit="${o.id}">${o.can_write ? 'Bewerken' : 'Bekijken'}</button>
      ${o.can_write ? `<button type="button" class="btn press danger" style="flex-grow:1" data-del="${o.id}">Verwijderen</button>` : ''}
    </div>
  </div>`;
}

// ---------- Bord: dag/week ----------

function dayMinutes(o, day) {
  const next = addDays(day, 1);
  const s = o.startD <= day ? 0 : o.startD.getHours() * 60 + o.startD.getMinutes();
  const e = o.endD >= next ? 1440 : o.endD.getHours() * 60 + o.endD.getMinutes();
  return [s, Math.max(e, s)];
}

// Overlappende afspraken naast elkaar zetten.
function layout(items) {
  items.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
  const clusters = [];
  let cur = [];
  let curEnd = -1;
  for (const it of items) {
    const e = Math.max(it.e, it.s + 20);
    if (cur.length && it.s >= curEnd) {
      clusters.push(cur);
      cur = [];
      curEnd = -1;
    }
    cur.push(it);
    curEnd = Math.max(curEnd, e);
  }
  if (cur.length) clusters.push(cur);
  for (const cl of clusters) {
    const cols = [];
    for (const it of cl) {
      const e = Math.max(it.e, it.s + 20);
      let i = cols.findIndex((end) => end <= it.s);
      if (i < 0) {
        i = cols.length;
        cols.push(e);
      } else cols[i] = e;
      it.col = i;
    }
    for (const it of cl) it.n = cols.length;
  }
  return items;
}

function nowTop() {
  const n = new Date();
  return ((n.getHours() * 60 + n.getMinutes()) / 60) * HOUR;
}

function renderTimeGrid(days) {
  const today = new Date();
  const evs = visible();
  const allDay = evs.filter((o) => o.allDay);
  const timed = evs.filter((o) => !o.allDay);
  const multi = days.length > 1;

  const head = days.map((d) => `<button type="button" class="day-head ${sameDay(d, today) ? 'today' : ''}" data-day="${ymd(d)}">
      <span class="dw">${DOW[(d.getDay() + 6) % 7]}</span><span class="dn">${d.getDate()}</span></button>`).join('');

  const allDayCells = days.map((d) => {
    const next = addDays(d, 1);
    const chips = allDay.filter((o) => o.startD < next && o.endD > d).map((o) => chip(o, false)).join('');
    return `<div class="cell" data-allday="${ymd(d)}">${chips}</div>`;
  }).join('');

  const hours = Array.from({ length: 23 }, (_, i) => `<span style="top:${(i + 1) * HOUR}px">${i + 1}:00</span>`).join('');

  const cols = days.map((d) => {
    const next = addDays(d, 1);
    const items = layout(timed.filter((o) => o.startD < next && o.endD > d).map((o) => {
      const [s, e] = dayMinutes(o, d);
      return { o, s, e };
    }));
    const html = items.map(({ o, s, e, col, n }) => {
      const c = calById(o.calendar_id);
      const top = (s / 60) * HOUR + 1;
      const height = Math.max(((e - s) / 60) * HOUR - 3, 20);
      const short = height < 40;
      const w = 100 / n;
      return `<button type="button" class="ev ${short ? 'short' : ''} ${occId(o) === state.selected ? 'sel' : ''}" data-occ="${esc(occId(o))}"
        style="top:${top}px;height:${height}px;left:calc(${col * w}% + 3px);width:calc(${w}% - 6px);${calStyle(c.color)}">
        <span class="t">${esc(o.title || '(geen titel)')}</span><span class="s">${hm(o.startD)}${short ? '' : ` – ${hm(o.endD)}`}${!short && o.location ? ` · ${esc(o.location)}` : ''}</span></button>`;
    }).join('');
    const isToday = sameDay(d, today);
    return `<div class="tg-col ${isToday ? 'today' : ''}" data-col="${ymd(d)}">${html}${isToday ? `<div class="now-line" style="top:${nowTop()}px"></div>` : ''}</div>`;
  }).join('');

  return `<div class="scroller" id="scroller"><div class="tg ${multi ? 'week' : 'day'}" style="--cols:${days.length};--hour:${HOUR}px">
    <div class="tg-sticky">
      <div class="tg-head"><span></span>${head}</div>
      <div class="tg-allday"><span class="lbl">${allDay.length ? 'hele dag' : ''}</span>${allDayCells}</div>
    </div>
    <div class="tg-body"><div class="tg-hours">${hours}</div>${cols}</div>
  </div></div>`;
}

function chip(o, withTime) {
  const c = calById(o.calendar_id);
  return `<button type="button" class="chip ${occId(o) === state.selected ? 'sel' : ''}" data-occ="${esc(occId(o))}" style="${calStyle(c.color)}">${withTime && !o.allDay ? `<span class="tm">${hm(o.startD)}</span>` : ''}${esc(o.title || '(geen titel)')}</button>`;
}

// ---------- Bord: maand ----------

function renderMonth() {
  const [start] = range();
  const today = new Date();
  const month = state.cursor.getMonth();
  const evs = visible().sort((a, b) => (b.allDay - a.allDay) || (a.startD - b.startD));
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const next = addDays(d, 1);
    const dayEvs = evs.filter((o) => o.startD < next && (o.endD > d || (+o.endD === +o.startD && o.startD >= d)));
    const max = 3;
    const shown = dayEvs.slice(0, dayEvs.length > max ? max - 1 : max).map((o) => chip(o, true)).join('');
    const more = dayEvs.length > max ? `<button type="button" class="more" data-day="${ymd(d)}">+${dayEvs.length - (max - 1)} meer</button>` : '';
    cells += `<div class="mcell ${d.getMonth() !== month ? 'out' : ''} ${sameDay(d, today) ? 'today' : ''}" data-mcell="${ymd(d)}">
      <button type="button" class="mn" data-day="${ymd(d)}">${d.getDate()}</button>${shown}${more}</div>`;
  }
  return `<div class="month"><div class="month-dows">${DOW.map((d) => `<span>${d}</span>`).join('')}</div><div class="month-grid">${cells}</div></div>`;
}

function renderBoard() {
  const board = $('#board');
  const prev = $('#scroller');
  const keepScroll = prev && !state.animate ? prev.scrollTop : null;
  if (state.view === 'month') board.innerHTML = renderMonth();
  else {
    const [s] = range();
    board.innerHTML = renderTimeGrid(Array.from({ length: state.view === 'day' ? 1 : 7 }, (_, i) => addDays(s, i)));
    const sc = $('#scroller');
    if (keepScroll != null) sc.scrollTop = keepScroll;
    else {
      const [rs, re] = range();
      const now = new Date();
      sc.scrollTop = now >= rs && now < re ? Math.max(0, (Math.floor(nowTop() / HOUR) - 3) * HOUR) : 7 * HOUR;
    }
  }
  board.classList.toggle('calm', !state.animate);
}

// ---------- Selectie ----------

function select(id) {
  state.selected = id;
  $$('#board [data-occ]').forEach((el) => el.classList.toggle('sel', el.dataset.occ === id));
  renderDetail();
}

// ---------- Navigatie ----------

function go(dir) {
  const c = state.cursor;
  if (state.view === 'day') state.cursor = addDays(c, dir);
  else if (state.view === 'week') state.cursor = addDays(c, 7 * dir);
  else state.cursor = new Date(c.getFullYear(), c.getMonth() + dir, 1);
  state.miniMonth = null;
  load({ animate: true });
}

function setView(v) {
  if (v === state.view) return;
  state.view = v;
  store.set('view', v);
  state.miniMonth = null;
  load({ animate: true });
}

function gotoDay(s, view = 'day') {
  state.cursor = parseYmd(s);
  state.miniMonth = null;
  if (view !== state.view) {
    state.view = view;
    store.set('view', view);
  }
  load({ animate: true });
}

// ---------- Dialoog ----------

const dlg = $('#dlg');
const form = $('#evForm');
let editing = null;
let lastStart = null;

function writableCals() {
  return state.cals.filter((c) => c.can_write);
}

function fillCalendarSelect(selectedId, includeReadOnly) {
  const list = writableCals();
  if (includeReadOnly && !list.some((c) => c.id === selectedId)) {
    const c = calById(selectedId);
    if (c) list.push(c);
  }
  form.calendar.innerHTML = list.map((c) => `<option value="${esc(c.id)}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.name)}${c.is_owner ? '' : ` (${esc(c.owner.full_name)})`}</option>`).join('');
}

function setAllDay(on) {
  form.allDay.checked = on;
  $$('.timed', form).forEach((el) => { el.hidden = on; });
}

function setRepeat(value) {
  form.repeat.querySelector('option[value="custom"]')?.remove();
  if (value === 'custom') form.repeat.insertAdjacentHTML('beforeend', '<option value="custom">Aangepast (ingesteld op ander apparaat)</option>');
  form.repeat.value = value || 'none';
}

function setAlarm(value) {
  form.alarm.querySelector('option[data-extra]')?.remove();
  const v = value == null ? '' : String(value);
  if (v && !form.alarm.querySelector(`option[value="${v}"]`)) {
    form.alarm.insertAdjacentHTML('beforeend', `<option data-extra value="${v}">${v} minuten van tevoren</option>`);
  }
  form.alarm.value = v;
}

function openDialog() {
  $('#dlgError').hidden = true;
  $('#dlgDelete').textContent = 'Verwijderen';
  delete $('#dlgDelete').dataset.confirm;
  if (!dlg.open) dlg.showModal();
  setTimeout(() => (editing?.readOnly ? $('#dlgCancel') : form.title).focus(), 50);
}

function openNew(date, minutes, allDay = false) {
  const cals = writableCals();
  if (!cals.length) return toast('Je hebt geen agenda waarin je mag schrijven.');
  editing = null;
  const def = cals.find((c) => !state.hidden.has(c.id)) || cals[0];
  form.reset();
  $('#dlgTitle').textContent = 'Nieuwe afspraak';
  $('#dlgFields').disabled = false;
  $('#dlgSave').hidden = false;
  $('#dlgDelete').hidden = true;
  $('#recurNote').hidden = true;
  $('#roNote').hidden = true;
  fillCalendarSelect(def.id);
  setRepeat('none');
  setAlarm(15);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60);
  const end = new Date(start.getTime() + 3600e3);
  form.startDate.value = ymd(start);
  form.startTime.value = hm2(start);
  form.endDate.value = ymd(end);
  form.endTime.value = hm2(end);
  setAllDay(allDay);
  lastStart = start;
  openDialog();
}

async function openEdit(id) {
  let ev;
  try {
    ev = await api(`events/${id}`);
  } catch (err) {
    return toast(err.message);
  }
  editing = { id: ev.id, readOnly: !ev.can_write };
  form.reset();
  $('#dlgTitle').textContent = ev.can_write ? 'Afspraak bewerken' : 'Afspraak';
  $('#dlgFields').disabled = !ev.can_write;
  $('#dlgSave').hidden = !ev.can_write;
  $('#dlgDelete').hidden = !ev.can_write;
  $('#recurNote').hidden = !(ev.repeat !== 'none' && ev.can_write);
  $('#roNote').hidden = ev.can_write;
  fillCalendarSelect(ev.calendar_id, true);
  form.title.value = ev.title;
  form.location.value = ev.location;
  form.notes.value = ev.notes;
  setRepeat(ev.repeat);
  setAlarm(ev.alarm);
  if (ev.allDay) {
    const s = parseYmd(ev.start);
    const e = addDays(parseYmd(ev.end), -1);
    form.startDate.value = ymd(s);
    form.endDate.value = ymd(e < s ? s : e);
    form.startTime.value = '09:00';
    form.endTime.value = '10:00';
    lastStart = s;
  } else {
    const s = new Date(ev.start);
    const e = new Date(ev.end);
    form.startDate.value = ymd(s);
    form.startTime.value = hm2(s);
    form.endDate.value = ymd(e);
    form.endTime.value = hm2(e);
    lastStart = s;
  }
  setAllDay(ev.allDay);
  openDialog();
}

function formStart() {
  return form.allDay.checked ? parseYmd(form.startDate.value) : new Date(`${form.startDate.value}T${form.startTime.value || '00:00'}`);
}

// Begin verschuiven = eind evenveel meeschuiven.
function shiftEnd() {
  if (!form.startDate.value) return;
  const ns = formStart();
  if (!lastStart || isNaN(ns)) return;
  const diff = ns - lastStart;
  lastStart = ns;
  if (!diff || !form.endDate.value) return;
  const ne = new Date(new Date(`${form.endDate.value}T${form.endTime.value || '00:00'}`).getTime() + diff);
  form.endDate.value = ymd(ne);
  if (!form.allDay.checked) form.endTime.value = hm2(ne);
}

async function save(e) {
  e.preventDefault();
  if (editing?.readOnly) return dlg.close();
  const allDay = form.allDay.checked;
  if (!form.startDate.value || !form.endDate.value) return showError($('#dlgError'), 'Vul een begin- en einddatum in.');
  let start, end;
  if (allDay) {
    if (form.endDate.value < form.startDate.value) return showError($('#dlgError'), 'De einddatum ligt voor de begindatum.');
    start = form.startDate.value;
    end = ymd(addDays(parseYmd(form.endDate.value), 1));
  } else {
    if (!form.startTime.value || !form.endTime.value) return showError($('#dlgError'), 'Vul een begin- en eindtijd in.');
    start = `${form.startDate.value}T${form.startTime.value}`;
    end = `${form.endDate.value}T${form.endTime.value}`;
    if (end < start) return showError($('#dlgError'), 'De eindtijd ligt voor de begintijd.');
  }
  const body = {
    calendar_id: form.calendar.value,
    title: form.title.value.trim(),
    location: form.location.value.trim(),
    notes: form.notes.value.trim(),
    allDay,
    start,
    end,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    repeat: form.repeat.value,
    alarm: form.alarm.value === '' ? 'none' : Number(form.alarm.value)
  };
  const btn = $('#dlgSave');
  btn.disabled = true;
  try {
    const res = editing
      ? await api(`events/${editing.id}`, { method: 'PATCH', body })
      : await api('events', { method: 'POST', body });
    dlg.close();
    toast(editing ? 'Afspraak bijgewerkt' : 'Afspraak toegevoegd');
    state.selected = null;
    await load();
    const o = state.events.find((x) => x.id === res.id);
    if (o) select(occId(o));
  } catch (err) {
    showError($('#dlgError'), err.message);
  } finally {
    btn.disabled = false;
  }
}

async function remove(id, btn) {
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = '1';
    btn.textContent = 'Zeker weten?';
    setTimeout(() => {
      if (btn.isConnected) {
        delete btn.dataset.confirm;
        btn.textContent = 'Verwijderen';
      }
    }, 4000);
    return;
  }
  try {
    await api(`events/${id}`, { method: 'DELETE' });
    if (dlg.open) dlg.close();
    state.selected = null;
    toast('Afspraak verwijderd');
    load();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Accountmenu ----------

async function renderMenu() {
  const me = state.me;
  let pending = 0;
  if (me.is_admin) {
    try {
      pending = (await api('admin/users')).filter((u) => u.status === 'pending').length;
    } catch {}
  }
  $('#avatar').innerHTML = `${esc(initials(me.full_name))}${pending ? '<span class="badge"></span>' : ''}`;
  $('#menu').innerHTML = `
    <div class="who"><strong>${esc(me.full_name)}</strong><span>@${esc(me.username)}</span></div>
    <a href="/instellingen">Instellingen &amp; apparaten</a>
    ${me.is_admin ? `<a href="/instellingen#beheer">Gebruikers beheren ${pending ? `<span class="count">${pending}</span>` : ''}</a>` : ''}
    <button type="button" id="logout" class="danger">Uitloggen</button>`;
  $('#logout').addEventListener('click', async () => {
    try {
      await api('logout', { method: 'POST' });
    } finally {
      location.replace('/login');
    }
  });
}

function toggleMenu(open) {
  const menu = $('#menu');
  const show = open ?? menu.hidden;
  menu.hidden = !show;
  $('#avatar').setAttribute('aria-expanded', String(show));
}

// ---------- Start ----------

async function init() {
  try {
    state.me = await api('me');
  } catch {
    return location.replace('/login');
  }
  $('#brandMark').innerHTML = icon('calendar');
  $('#prev').innerHTML = icon('left');
  $('#next').innerHTML = icon('right');
  $('#newBtn').innerHTML = `${icon('plus')} Nieuwe afspraak`;
  $('#fab').innerHTML = icon('plus');
  $('#dlgClose').innerHTML = icon('close');
  bindThemeButton($('#themeBtn'));
  renderMenu();

  $('#prev').addEventListener('click', () => go(-1));
  $('#next').addEventListener('click', () => go(1));
  $('#today').addEventListener('click', () => gotoDay(ymd(new Date()), state.view));
  $$('#viewSeg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  const newHere = () => {
    const now = new Date();
    const base = sameDay(state.cursor, now) || state.view !== 'day' && now >= range()[0] && now < range()[1] ? now : state.cursor;
    openNew(base, sameDay(base, now) ? Math.min(23 * 60, (now.getHours() + 1) * 60) : 9 * 60);
  };
  $('#newBtn').addEventListener('click', newHere);
  $('#fab').addEventListener('click', newHere);

  $('#avatar').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  document.addEventListener('click', (e) => {
    if (!$('#menu').hidden && !e.target.closest('.menu-wrap')) toggleMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleMenu(false);
  });

  $('#mini').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-mini]');
    if (nav) {
      const m = state.miniMonth;
      state.miniMonth = new Date(m.getFullYear(), m.getMonth() + Number(nav.dataset.mini), 1);
      return renderMini();
    }
    const d = e.target.closest('[data-goto]');
    if (d) gotoDay(d.dataset.goto, state.view === 'month' ? 'day' : state.view);
  });

  $('#calList').addEventListener('change', (e) => {
    const id = e.target.dataset.cal;
    if (!id) return;
    if (e.target.checked) state.hidden.delete(id);
    else state.hidden.add(id);
    store.set('hiddenCals', [...state.hidden]);
    renderBoard();
  });

  $('#detail').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) return openEdit(ed.dataset.edit);
    const del = e.target.closest('[data-del]');
    if (del) remove(del.dataset.del, del);
  });

  const board = $('#board');
  board.addEventListener('click', (e) => {
    const occ = e.target.closest('[data-occ]');
    if (occ) {
      select(occ.dataset.occ);
      if (narrow.matches) openEdit(occ.dataset.occ.split('|')[0]);
      return;
    }
    const day = e.target.closest('[data-day]');
    if (day) return gotoDay(day.dataset.day, 'day');
    const col = e.target.closest('.tg-col');
    if (col && e.target === col) {
      const minutes = Math.min(23 * 60 + 30, Math.floor(e.offsetY / HOUR * 2) * 30);
      return openNew(parseYmd(col.dataset.col), minutes);
    }
    const ad = e.target.closest('[data-allday]');
    if (ad && e.target === ad) return openNew(parseYmd(ad.dataset.allday), 9 * 60, true);
    const cell = e.target.closest('[data-mcell]');
    if (cell && e.target === cell) return openNew(parseYmd(cell.dataset.mcell), 9 * 60);
  });
  board.addEventListener('dblclick', (e) => {
    const occ = e.target.closest('[data-occ]');
    if (occ && !narrow.matches) openEdit(occ.dataset.occ.split('|')[0]);
  });

  form.addEventListener('submit', save);
  form.allDay.addEventListener('change', () => setAllDay(form.allDay.checked));
  form.startDate.addEventListener('change', shiftEnd);
  form.startTime.addEventListener('change', shiftEnd);
  $('#dlgCancel').addEventListener('click', () => dlg.close());
  $('#dlgClose').addEventListener('click', () => dlg.close());
  $('#dlgDelete').addEventListener('click', (e) => editing && remove(editing.id, e.currentTarget));
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });

  document.addEventListener('themechange', () => renderBoard());
  addEventListener('resize', () => renderHeader());

  // Verversen: elke minuut, en zodra je terugkomt naar het tabblad.
  setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });

  await load({ animate: true });
}

init();
