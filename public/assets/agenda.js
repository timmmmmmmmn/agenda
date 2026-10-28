import { api, esc, $, $$, icon, toast, showError, initials, calStyle, applyTheme, themePref, isApp, haptic, nativeSync } from './common.js';

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

function rangeFor(view, cursor) {
  if (view === 'day') return [cursor, addDays(cursor, 1)];
  if (view === 'week') {
    const s = startOfWeek(cursor);
    return [s, addDays(s, 7)];
  }
  const s = startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  return [s, addDays(s, 42)];
}

const range = () => rangeFor(state.view, state.cursor);

// Wat we ophalen: in de dagweergave de hele week (voor de weekbalk en direct wisselen).
const dataRangeFor = (view, cursor) => rangeFor(view === 'day' ? 'week' : view, cursor);

function shifted(view, cursor, dir) {
  if (view === 'day') return addDays(cursor, dir);
  if (view === 'week') return addDays(cursor, 7 * dir);
  return new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
}

// ---------- Laden ----------

let loadSeq = 0;
const cache = new Map();
const rangeKey = ([a, b]) => `${a.getTime()}|${b.getTime()}`;

function setSync(kind, text) {
  $('#sync').className = `sync ${kind}`;
  $('#syncText').textContent = text;
}

async function fetchRange(r) {
  const [from, to] = r;
  const events = await api(`events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
  const mapped = events.map((o) => ({
    ...o,
    startD: o.allDay ? parseYmd(o.start) : new Date(o.start),
    endD: o.allDay ? parseYmd(o.end) : new Date(o.end)
  }));
  cache.set(rangeKey(r), mapped);
  return mapped;
}

// Buren alvast ophalen, zodat vorige/volgende meteen klaar staan.
function prefetch() {
  const run = () => {
    for (const dir of [1, -1]) {
      const r = dataRangeFor(state.view, shifted(state.view, state.cursor, dir));
      if (!cache.has(rangeKey(r))) fetchRange(r).catch(() => {});
    }
  };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 200);
}

async function loadCals() {
  state.cals = await api('calendars');
}

// Meteen tekenen met wat we al hebben, daarna stil bijwerken.
async function load({ animate = false, cals = false } = {}) {
  const seq = ++loadSeq;
  const r = dataRangeFor(state.view, state.cursor);
  const cached = cache.get(rangeKey(r));
  if (cached || animate) {
    state.events = cached || [];
    state.animate = animate && !!cached;
    render();
  }
  setSync('busy', 'Bijwerken…');
  try {
    const [events] = await Promise.all([fetchRange(r), cals ? loadCals() : null]);
    if (seq !== loadSeq) return;
    const changed = !cached || JSON.stringify(events.map(occId)) !== JSON.stringify(state.events.map(occId)) || cals;
    state.events = events;
    setSync('', 'Gesynchroniseerd');
    if (changed || !cached) {
      state.animate = animate && !cached;
      render();
    } else if (cached) {
      // Zelfde afspraken; inhoud kan wel gewijzigd zijn (titel, tijd).
      renderBoard();
      renderDetail();
    }
    if (state.pendingSelect != null) {
      const o = state.events.find((x) => x.id === state.pendingSelect);
      state.pendingSelect = null;
      if (o) select(occId(o));
    }
    prefetch();
  } catch (err) {
    if (err.status === 401) return location.replace('/login');
    if (seq === loadSeq) setSync('err', 'Niet verbonden');
  }
}

function refresh() {
  cache.clear();
  return load({ cals: true });
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
    title = `${DAYS[c.getDay()]} ${c.getDate()} ${(isApp ? MONTHS_SHORT : MONTHS)[c.getMonth()]}`;
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
  if (isApp) {
    $$('#appnavPill [data-nav]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.nav === state.view)));
    $('#appnavPill .appnav-ind').style.transform = `translateX(${idx * 100}%)`;
  }
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
      <button type="button" class="btn press" style="flex-grow:1" data-edit="${esc(occId(o))}">${o.can_write ? 'Bewerken' : 'Bekijken'}</button>
      ${o.can_write ? `<button type="button" class="btn press danger" style="flex-grow:1" data-del="${esc(occId(o))}">${o.recurring ? 'Deze verwijderen' : 'Verwijderen'}</button>` : ''}
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
  const shownEnd = addDays(days[days.length - 1], 1);
  const allDay = evs.filter((o) => o.allDay && o.startD < shownEnd && o.endD > days[0]);
  const timed = evs.filter((o) => !o.allDay);
  const multi = days.length > 1;

  const head = days.map((d) => `<button type="button" class="day-head ${sameDay(d, today) ? 'today' : ''}" data-day="${ymd(d)}">
      <span class="dw">${DOW[(d.getDay() + 6) % 7]}</span><span class="dn">${d.getDate()}</span></button>`).join('');

  // Dagweergave: de hele week als bolletjes, met een stipje op dagen met afspraken.
  const strip = multi ? '' : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(days[0]), i)).map((d) => {
    const next = addDays(d, 1);
    const has = evs.some((o) => o.startD < next && (o.endD > d || (+o.endD === +o.startD && o.startD >= d)));
    const cls = ['sd', sameDay(d, days[0]) ? 'on' : '', sameDay(d, today) ? 'today' : ''].join(' ');
    return `<button type="button" class="${cls}" data-strip="${ymd(d)}" aria-pressed="${sameDay(d, days[0])}" aria-label="${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}">
      <span class="dw">${DOW[(d.getDay() + 6) % 7]}</span><span class="dn">${d.getDate()}</span><span class="dot ${has ? '' : 'none'}"></span></button>`;
  }).join('');

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
      ${multi ? `<div class="tg-head"><span></span>${head}</div>` : `<div class="week-strip">${strip}</div>`}
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

let slideDir = 0;

function renderBoard() {
  const board = $('#board');
  board.classList.remove('slide-next', 'slide-prev');
  if (slideDir && state.animate) {
    void board.offsetWidth;
    board.classList.add(slideDir > 0 ? 'slide-next' : 'slide-prev');
  }
  if (state.animate) slideDir = 0;
  const prev = $('#scroller');
  const keepScroll = prev && !state.resetScroll ? prev.scrollTop : null;
  state.resetScroll = false;
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
  haptic();
  slideDir = dir;
  state.cursor = shifted(state.view, state.cursor, dir);
  state.miniMonth = null;
  state.resetScroll = true;
  load({ animate: true });
}

function setView(v) {
  if (v === state.view) return;
  state.view = v;
  store.set('view', v);
  state.miniMonth = null;
  state.resetScroll = true;
  load({ animate: true });
}

function gotoDay(s, view = 'day') {
  state.cursor = parseYmd(s);
  state.miniMonth = null;
  if (view !== state.view) {
    state.view = view;
    store.set('view', view);
  }
  state.resetScroll = true;
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
  $('#scopeSeg').hidden = true;
  $('#repeatLabel').hidden = false;
  form.calendar.disabled = false;
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

function fillFields(src) {
  form.title.value = src.title;
  form.location.value = src.location;
  form.notes.value = src.notes;
  setAlarm(src.alarm);
  if (src.allDay) {
    const s = parseYmd(src.start);
    const e = addDays(parseYmd(src.end), -1);
    form.startDate.value = ymd(s);
    form.endDate.value = ymd(e < s ? s : e);
    form.startTime.value = '09:00';
    form.endTime.value = '10:00';
    lastStart = s;
  } else {
    const s = new Date(src.start);
    const e = new Date(src.end);
    form.startDate.value = ymd(s);
    form.startTime.value = hm2(s);
    form.endDate.value = ymd(e);
    form.endTime.value = hm2(e);
    lastStart = s;
  }
  setAllDay(src.allDay);
}

// Bij een herhaling: alleen dit voorkomen, of de hele reeks.
function setScope(scope, refill = true) {
  editing.scope = scope;
  const seg = $('#scopeSeg');
  const btns = $$('button', seg);
  btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === scope)));
  seg.querySelector('.pill').style.transform = `translateX(${scope === 'all' ? (btns[0].offsetWidth || 120) + 2 : 0}px)`;
  const ev = editing.ev;
  if (refill) fillFields(scope === 'this' ? ev.occurrence : ev);
  $('#repeatLabel').hidden = scope === 'this';
  form.calendar.disabled = scope === 'this';
  $('#recurNote').textContent = scope === 'this'
    ? 'Je wijzigt alleen deze ene afspraak; de rest van de reeks blijft zoals hij is.'
    : 'Wijzigingen gelden voor de hele reeks.';
  $('#dlgDelete').textContent = scope === 'this' ? 'Deze verwijderen' : 'Reeks verwijderen';
  delete $('#dlgDelete').dataset.confirm;
}

async function openEdit(id, key) {
  // Direct openen met wat we al weten; details (herhaling, melding) volgen.
  const occ = state.events.find((x) => String(x.id) === String(id) && (key == null || String(x.key) === String(key)));
  const token = {};
  if (occ) {
    editing = { id: occ.id, readOnly: !occ.can_write, ev: null, scope: 'all', token, dirty: false };
    form.reset();
    $('#dlgTitle').textContent = occ.can_write ? 'Afspraak bewerken' : 'Afspraak';
    $('#dlgFields').disabled = !occ.can_write;
    $('#dlgSave').hidden = !occ.can_write;
    $('#dlgSave').disabled = true;
    $('#dlgDelete').hidden = true;
    $('#recurNote').hidden = true;
    $('#scopeSeg').hidden = true;
    $('#repeatLabel').hidden = false;
    form.calendar.disabled = false;
    $('#roNote').hidden = occ.can_write;
    fillCalendarSelect(occ.calendar_id, true);
    setRepeat(occ.recurring ? 'weekly' : 'none');
    fillFields({ ...occ, alarm: null });
    openDialog();
  }
  let ev;
  try {
    ev = await api(`events/${id}${key ? `?occurrence=${encodeURIComponent(key)}` : ''}`);
  } catch (err) {
    if (occ && dlg.open) dlg.close();
    return toast(err.message);
  }
  if (occ && (!dlg.open || editing?.token !== token)) return;
  const dirty = !!editing?.dirty;
  $('#dlgSave').disabled = false;
  editing = { id: ev.id, readOnly: !ev.can_write, ev, scope: 'all', token, dirty };
  if (dirty) {
    // Gebruiker typt al: alleen aanvullen wat nog ontbrak.
    setRepeat(ev.repeat);
    if (form.alarm.value === '') setAlarm(ev.alarm);
    const recurring = !!ev.occurrence && ev.can_write;
    $('#recurNote').hidden = !recurring;
    $('#scopeSeg').hidden = !recurring;
    $('#dlgDelete').hidden = !ev.can_write;
    if (recurring) setScope('this', false);
    return;
  }
  if (!occ) form.reset();
  $('#dlgTitle').textContent = ev.can_write ? 'Afspraak bewerken' : 'Afspraak';
  $('#dlgFields').disabled = !ev.can_write;
  $('#dlgSave').hidden = !ev.can_write;
  $('#dlgDelete').hidden = !ev.can_write;
  const recurring = !!ev.occurrence && ev.can_write;
  $('#recurNote').hidden = !recurring;
  $('#scopeSeg').hidden = !recurring;
  $('#roNote').hidden = ev.can_write;
  fillCalendarSelect(ev.calendar_id, true);
  setRepeat(ev.repeat);
  if (!occ) openDialog();
  if (recurring) setScope('this');
  else fillFields(ev.occurrence || ev);
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
  if (editing?.scope === 'this') {
    body.scope = 'this';
    body.occurrence = editing.ev.occurrence.key;
    delete body.repeat;
    delete body.calendar_id;
  }
  const btn = $('#dlgSave');
  btn.disabled = true;
  try {
    const res = editing
      ? await api(`events/${editing.id}`, { method: 'PATCH', body })
      : await api('events', { method: 'POST', body });
    dlg.close();
    haptic('confirm');
    toast(editing ? 'Afspraak bijgewerkt' : 'Afspraak toegevoegd');
    state.selected = null;
    state.pendingSelect = res.id;
    refresh().then(nativeSync);
  } catch (err) {
    showError($('#dlgError'), err.message);
  } finally {
    btn.disabled = false;
  }
}

async function remove(id, btn, key = null) {
  if (!btn.dataset.confirm) {
    const label = btn.textContent;
    btn.dataset.confirm = '1';
    btn.textContent = 'Zeker weten?';
    setTimeout(() => {
      if (btn.isConnected && btn.dataset.confirm) {
        delete btn.dataset.confirm;
        btn.textContent = label;
      }
    }, 4000);
    return;
  }
  if (dlg.open) dlg.close();
  haptic('confirm');
  state.selected = null;
  state.events = state.events.filter((x) => !(String(x.id) === String(id) && (key == null || String(x.key) === String(key))));
  renderBoard();
  renderDetail();
  try {
    await api(`events/${id}${key != null ? `?occurrence=${encodeURIComponent(key)}` : ''}`, { method: 'DELETE' });
    toast(key != null ? 'Deze afspraak is uit de reeks gehaald' : 'Afspraak verwijderd');
  } catch (err) {
    toast(err.message);
  }
  refresh().then(nativeSync);
}

// ---------- Zoeken ----------

let searchTimer;
let searchSeq = 0;

function whenLabel(r) {
  const s = r.allDay ? parseYmd(r.start) : new Date(r.start);
  const date = `${DAYS[s.getDay()].slice(0, 2)} ${s.getDate()} ${MONTHS_SHORT[s.getMonth()]} ${s.getFullYear() !== new Date().getFullYear() ? s.getFullYear() : ''}`.trim();
  return `${date}${r.allDay ? '' : `, ${hm(s)}`}${r.recurring ? ' · herhaalt' : ''}${r.location ? ` · ${r.location}` : ''}`;
}

async function runSearch() {
  const q = $('#q').value.trim();
  const box = $('#results');
  if (q.length < 2) {
    box.hidden = true;
    return;
  }
  const seq = ++searchSeq;
  let res;
  try {
    res = await api(`search?q=${encodeURIComponent(q)}`);
  } catch (err) {
    res = [];
  }
  if (seq !== searchSeq) return;
  box.innerHTML = res.length ? res.map((r) => {
    const c = calById(r.calendar_id);
    return `<button type="button" class="result" role="option" data-hit="${r.id}|${r.key}" data-date="${esc((r.allDay ? r.start : ymd(new Date(r.start))))}">
      <span class="dot" style="background:${esc(c?.color || '#5B6478')}"></span>
      <span><strong>${esc(r.title || '(geen titel)')}</strong><span class="when">${esc(whenLabel(r))}</span></span></button>`;
  }).join('') : '<p class="empty">Niets gevonden</p>';
  box.hidden = false;
}

function closeSearch() {
  $('#results').hidden = true;
  if (isApp && document.documentElement.classList.contains('searching')) {
    document.documentElement.classList.remove('searching');
    $('#q').blur();
  }
}

function openSearch() {
  document.documentElement.classList.add('searching');
  $('#q').value = '';
  $('#results').hidden = true;
  setTimeout(() => $('#q').focus(), 30);
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
    <div class="sep"></div>
    <div class="menu-label">Weergave</div>
    <div class="theme-pick" role="group" aria-label="Thema">
      <button type="button" data-theme="systeem">Systeem</button>
      <button type="button" data-theme="licht">Licht</button>
      <button type="button" data-theme="donker">Donker</button>
    </div>
    <div class="sep"></div>
    ${appVersion() ? `<button type="button" id="checkUpdate">App bijwerken <span class="label" style="font-size:13px">versie ${esc(appVersion())}</span></button>` : ''}
    <button type="button" id="logout" class="danger">Uitloggen</button>`;
  $('#checkUpdate')?.addEventListener('click', () => {
    toggleMenu(false);
    try {
      window.AgendaNative.checkForUpdate();
    } catch {}
  });
  const paintTheme = () => $$('#menu .theme-pick button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === themePref())));
  paintTheme();
  $$('#menu .theme-pick button').forEach((b) => b.addEventListener('click', () => {
    applyTheme(b.dataset.theme);
    paintTheme();
  }));
  $('#logout').addEventListener('click', async () => {
    try {
      await api('logout', { method: 'POST' });
    } finally {
      location.replace('/login');
    }
  });
}

function appVersion() {
  try {
    return window.AgendaNative?.appVersion?.() || '';
  } catch {
    return '';
  }
}

function toggleMenu(open) {
  if (isApp) {
    const more = $('#moreDlg');
    const show = open ?? !more.open;
    if (show && !more.open) more.showModal();
    else if (!show && more.open) more.close();
    return;
  }
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
  $('#brandMark').innerHTML = '<img src="/icons/icon-192.png" alt="">';
  $('#prev').innerHTML = icon('left');
  $('#next').innerHTML = icon('right');
  $('#newBtn').innerHTML = `${icon('plus')} Nieuwe afspraak`;
  $('#fab').innerHTML = icon('plus');
  $('#dlgClose').innerHTML = icon('close');
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
    if (!isApp && !$('#menu').hidden && !e.target.closest('.menu-wrap')) toggleMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleMenu(false);
  });

  $('#searchIcon').innerHTML = icon('search');
  $('#q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });
  $('#q').addEventListener('focus', () => {
    if ($('#q').value.trim().length >= 2) runSearch();
  });
  $('#q').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#q').value = '';
      closeSearch();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      $('#results .result')?.focus();
    }
  });
  $('#results').addEventListener('keydown', (e) => {
    const items = $$('#results .result');
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (i <= 0 ? $('#q') : items[i - 1]).focus(); }
    if (e.key === 'Escape') { closeSearch(); $('#q').focus(); }
  });
  $('#results').addEventListener('click', (e) => {
    const hit = e.target.closest('[data-hit]');
    if (!hit) return;
    closeSearch();
    state.selected = hit.dataset.hit;
    gotoDay(hit.dataset.date, state.view === 'month' ? 'month' : state.view);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap') && !e.target.closest('[data-nav="search"]')) closeSearch();
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
    if (ed) return openEdit(...ed.dataset.edit.split('|'));
    const del = e.target.closest('[data-del]');
    if (del) {
      const [id, key] = del.dataset.del.split('|');
      const o = state.events.find((x) => occId(x) === del.dataset.del);
      remove(id, del, o?.recurring ? Number(key) : null);
    }
  });

  const board = $('#board');
  board.addEventListener('click', (e) => {
    const occ = e.target.closest('[data-occ]');
    if (occ) {
      select(occ.dataset.occ);
      if (narrow.matches) openEdit(...occ.dataset.occ.split('|'));
      return;
    }
    const sd = e.target.closest('[data-strip]');
    if (sd) {
      const d = parseYmd(sd.dataset.strip);
      if (sameDay(d, state.cursor)) return;
      haptic();
      slideDir = d > state.cursor ? 1 : -1;
      state.cursor = d;
      state.miniMonth = null;
      return load({ animate: true });
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
    if (occ && !narrow.matches) openEdit(...occ.dataset.occ.split('|'));
  });

  form.addEventListener('submit', save);
  form.allDay.addEventListener('change', () => setAllDay(form.allDay.checked));
  form.startDate.addEventListener('change', shiftEnd);
  form.startTime.addEventListener('change', shiftEnd);
  $('#dlgCancel').addEventListener('click', () => dlg.close());
  $('#dlgClose').addEventListener('click', () => dlg.close());
  $('#dlgDelete').addEventListener('click', (e) => {
    if (!editing) return;
    remove(editing.id, e.currentTarget, editing.scope === 'this' ? editing.ev.occurrence.key : null);
  });
  $$('#scopeSeg button').forEach((b) => b.addEventListener('click', () => setScope(b.dataset.scope)));
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });

  document.addEventListener('themechange', () => renderBoard());
  addEventListener('resize', () => renderHeader());

  // Verversen: elke minuut, en zodra je terugkomt naar het tabblad.
  setInterval(() => {
    if (document.visibilityState === 'visible') load({ cals: true });
  }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load({ cals: true });
  });
  form.addEventListener('input', () => {
    if (editing) editing.dirty = true;
  });

  // Terugknop van de Android-app: eerst sluiten wat open staat.
  window.agendaBack = () => {
    if (isApp && $('#moreDlg').open) {
      $('#moreDlg').close();
      return true;
    }
    if (isApp && document.documentElement.classList.contains('searching')) {
      closeSearch();
      return true;
    }
    if (dlg.open) {
      dlg.close();
      return true;
    }
    if (!$('#menu').hidden) {
      toggleMenu(false);
      return true;
    }
    if (!$('#results').hidden) {
      closeSearch();
      return true;
    }
    return false;
  };

  if (isApp) setupApp(newHere);

  state.resetScroll = true;
  await load({ animate: true, cals: true });
}

// ---------- Android-app ----------

function setupApp(newHere) {
  $$('#appnavPill [data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
  $('#appnavAdd').innerHTML = icon('plus');

  // Accountmenu en agenda's verhuizen naar het "Meer"-paneel.
  const more = $('#moreDlg');
  const menu = $('#menu');
  menu.hidden = false;
  $('#moreBody').append(menu, $('#calList').closest('section'));
  more.addEventListener('click', (e) => {
    if (e.target === more) more.close();
  });

  $('#appnavPill').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nav]');
    if (!b) return;
    haptic();
    const nav = b.dataset.nav;
    if (nav === 'search') {
      if (document.documentElement.classList.contains('searching')) closeSearch();
      else openSearch();
    } else if (nav === 'more') {
      closeSearch();
      toggleMenu(true);
    } else {
      closeSearch();
      setView(nav);
    }
  });
  $('#appnavAdd').addEventListener('click', () => {
    haptic();
    closeSearch();
    newHere();
  });
  $('#scrim').addEventListener('click', closeSearch);

  // Vegen over het rooster: naar de vorige of volgende dag/week/maand.
  let sx = 0, sy = 0, st = 0;
  const board = $('#board');
  board.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX;
    sy = t.clientY;
    st = Date.now();
  }, { passive: true });
  board.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Date.now() - st < 600 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) go(dx < 0 ? 1 : -1);
  }, { passive: true });
}

init();
