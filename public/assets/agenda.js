import { api, esc, $, $$, icon, toast, showError, initials, calStyle, applyTheme, themePref, isApp, haptic, nativeSync, dateLogo } from './common.js';

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
  view: isApp ? 'list' : store.get('view', narrow.matches ? 'day' : 'week'),
  calView: store.get('view', 'day'),
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
  if (state.view === 'list') return loadList({ animate, cals });
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
  document.documentElement.dataset.view = state.view;
  if (state.view === 'list') {
    const t = new Date();
    title = 'Planning';
    sub = `Vandaag · ${DAYS[t.getDay()]} ${t.getDate()} ${MONTHS[t.getMonth()]}`;
  } else if (state.view === 'day') {
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
    const tab = state.view === 'list' ? 'list' : 'agenda';
    $$('#appnavPill [data-nav]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.nav === tab)));
    $('#appnavPill .appnav-ind').style.transform = `translateX(${tab === 'list' ? 0 : 100}%)`;
    const ag = $('#appnavPill [data-nav="agenda"]');
    if (ag && ag.dataset.shows !== state.calView) {
      ag.dataset.shows = state.calView;
      ag.querySelector('svg').outerHTML = icon(state.calView);
      ag.querySelector('.lbl').textContent = { day: 'Dag', week: 'Week', month: 'Maand' }[state.calView];
    }
    $$('#viewPick [data-pick]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.pick === state.view)));
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
        <span class="t">${esc(o.title || '(geen titel)')}</span><span class="s">${hm(o.startD)}${short ? '' : ` – ${hm(o.endD)}`}${!short && o.location ? ` · ${esc(o.location)}` : ''}</span>${o.can_write ? '<span class="grip" aria-hidden="true"></span>' : ''}</button>`;
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
  if (drag?.active) {
    drag.rerender = true;
    return;
  }
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
  if (state.view === 'list') {
    board.innerHTML = renderList();
    listObserve();
    if (keepScroll != null) $('#scroller').scrollTop = keepScroll;
  } else if (state.view === 'month') board.innerHTML = renderMonth();
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

// ---------- Lijst (start in de app) ----------
// Begint vandaag en laadt per vier weken bij zodra je richting het eind scrolt.

const CHUNK = 28;
const list = { from: null, to: null, items: [], busy: false, empty: 0, ended: false, io: null };

function listReset() {
  const t = startOfDay(new Date());
  Object.assign(list, { from: t, to: t, items: [], empty: 0, ended: false });
  // Direct iets tonen bij het opstarten: de vorige stand uit het geheugen.
  const snap = store.get('listSnap', null);
  if (snap?.day === ymd(t)) {
    list.items = snap.items.map(hydrate);
    list.to = parseYmd(snap.to);
  }
}

const hydrate = (o) => ({ ...o, startD: o.allDay ? parseYmd(o.start) : new Date(o.start), endD: o.allDay ? parseYmd(o.end) : new Date(o.end) });

function mergeList(events, from, to) {
  const keep = list.items.filter((o) => !(o.startD >= from && o.startD < to));
  const fresh = events.filter((o) => o.startD >= from || (+from === +list.from && o.endD > from));
  const seen = new Set();
  list.items = [...keep, ...fresh].filter((o) => {
    const k = occId(o);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.startD - b.startD || (b.allDay - a.allDay));
  state.events = list.items;
}

async function loadList({ animate = false, cals = false } = {}) {
  const seq = ++loadSeq;
  const today = startOfDay(new Date());
  if (!list.from || !sameDay(list.from, today) && list.from > today) listReset();
  if (animate || !list.items.length) {
    state.events = list.items;
    state.animate = animate;
    render();
  }
  setSync('busy', 'Bijwerken…');
  try {
    // Alles wat al geladen is opnieuw ophalen (hooguit een jaar), anders de eerste vier weken.
    const to = list.to > list.from ? (list.to - list.from > 360 * 864e5 ? addDays(list.from, 360) : list.to) : addDays(list.from, CHUNK);
    const [events] = await Promise.all([fetchRange([list.from, to]), cals ? loadCals() : null]);
    if (seq !== loadSeq || state.view !== 'list') return;
    const before = JSON.stringify(list.items.map(occId));
    mergeList(events, list.from, to);
    if (to > list.to) list.to = to;
    snapshot();
    setSync('', 'Gesynchroniseerd');
    if (before !== JSON.stringify(list.items.map(occId)) || cals || animate) render();
    else renderBoard();
    listMaybeMore();
  } catch (err) {
    if (err.status === 401) return location.replace('/login');
    if (seq === loadSeq) setSync('err', 'Niet verbonden');
  }
}

function snapshot() {
  const t = startOfDay(new Date());
  const items = list.items.filter((o) => o.endD > t && o.startD < addDays(t, CHUNK)).slice(0, 80)
    .map(({ startD, endD, ...rest }) => rest);
  store.set('listSnap', { day: ymd(t), to: ymd(addDays(t, CHUNK)), items });
}

async function listMore() {
  if (list.busy || list.ended || state.view !== 'list') return;
  list.busy = true;
  const from = list.to;
  const to = addDays(from, CHUNK);
  try {
    const events = await fetchRange([from, to]);
    if (state.view !== 'list') return;
    const n = list.items.length;
    mergeList(events, from, to);
    list.to = to;
    list.empty = list.items.length > n ? 0 : list.empty + CHUNK;
    if (list.empty >= 365) list.ended = true;
    appendList(from, to);
  } catch {
    // later opnieuw
  } finally {
    list.busy = false;
  }
  listMaybeMore();
}

async function listEarlier() {
  if (list.busy) return;
  list.busy = true;
  const to = list.from;
  const from = addDays(to, -CHUNK);
  try {
    const events = await fetchRange([from, to]);
    list.from = from;
    mergeList(events, from, to);
    const sc = $('#scroller');
    const h = sc.scrollHeight;
    const top = sc.scrollTop;
    renderBoard();
    const sc2 = $('#scroller');
    sc2.scrollTop = top + (sc2.scrollHeight - h);
  } catch (err) {
    toast(err.message);
  } finally {
    list.busy = false;
  }
}

// Nog dicht bij het eind? Dan meteen verder laden.
function listMaybeMore() {
  const sc = $('#scroller');
  const end = $('#listEnd');
  if (!sc || !end || list.ended) return;
  if (end.getBoundingClientRect().top < sc.getBoundingClientRect().bottom + 800) listMore();
}

function listObserve() {
  list.io?.disconnect();
  const sc = $('#scroller');
  const end = $('#listEnd');
  if (!sc || !end) return;
  list.io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) listMore();
  }, { root: sc, rootMargin: '0px 0px 800px 0px' });
  list.io.observe(end);
}

function dayLabel(d) {
  const t = startOfDay(new Date());
  const diff = Math.round((d - t) / 864e5);
  const base = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== t.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
  if (diff === 0) return ['Vandaag', base];
  if (diff === 1) return ['Morgen', base];
  if (diff === -1) return ['Gisteren', base];
  return [base.charAt(0).toUpperCase() + base.slice(1), ''];
}

function listRow(o, day) {
  const c = calById(o.calendar_id);
  let when;
  if (o.allDay) when = '<span class="lt-a">Hele dag</span>';
  else {
    const startsToday = sameDay(o.startD, day);
    const endsToday = o.endD <= addDays(day, 1);
    when = `<span class="lt-a">${startsToday ? hm2(o.startD) : '…'}</span><span class="lt-b">${endsToday ? hm2(o.endD) : '…'}</span>`;
  }
  return `<button type="button" class="lrow" data-occ="${esc(occId(o))}" style="${calStyle(c.color)}">
    <span class="lt">${when}</span><span class="lbar"></span>
    <span class="lx"><strong>${esc(o.title || '(geen titel)')}</strong>${o.location || o.recurring ? `<span>${o.recurring ? icon('repeat', 'icon mini') : ''}${esc(o.location || '')}</span>` : ''}</span>
  </button>`;
}

// Dagen met afspraken in [from, to); vandaag altijd.
function listDays(from, to) {
  const evs = list.items.filter((o) => !state.hidden.has(o.calendar_id) && calById(o.calendar_id));
  const today = startOfDay(new Date());
  let html = '';
  let month = +from === +list.from ? -1 : list.month;
  for (let d = from; d < to; d = addDays(d, 1)) {
    const next = addDays(d, 1);
    const items = evs.filter((o) => o.startD < next && (o.endD > d || (+o.endD === +o.startD && o.startD >= d)))
      .filter((o) => sameDay(o.startD, d) || +d === +from || o.allDay || d - startOfDay(o.startD) < 7 * 864e5);
    const isToday = sameDay(d, today);
    if (!items.length && !isToday) continue;
    if (d.getMonth() !== month && !(isToday && +d === +list.from)) {
      html += `<h3 class="lmonth">${MONTHS[d.getMonth()]}${d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : ''}</h3>`;
    }
    month = d.getMonth();
    const [a, b] = dayLabel(d);
    html += `<section class="lday ${isToday ? 'today' : ''} ${d < today ? 'past' : ''}" data-lday="${ymd(d)}">
      <button type="button" class="lhead" data-day="${ymd(d)}"><span class="ldn">${d.getDate()}</span><span class="lname"><strong>${esc(a)}</strong>${b ? `<span>${esc(b)}</span>` : ''}</span></button>
      ${items.length ? items.map((o) => listRow(o, d)).join('') : '<p class="lempty">Niets gepland</p>'}
    </section>`;
  }
  list.month = month;
  return html;
}

function listFooter() {
  if (list.ended) return '<div class="lend" id="listEnd"><p>Geen afspraken meer in het komende jaar.</p><button type="button" class="btn press" id="listGoOn">Verder kijken</button></div>';
  return '<div class="lend" id="listEnd"><span class="spinner"></span></div>';
}

function renderList() {
  return `<div class="alist" id="scroller">
    <div class="lstart"><button type="button" class="btn press" id="listEarlier">${icon('left', 'icon up')} Eerdere afspraken</button></div>
    <div id="listBody">${listDays(list.from, list.to > list.from ? list.to : addDays(list.from, 1))}</div>
    ${listFooter()}
  </div>`;
}

function appendList(from, to) {
  const body = $('#listBody');
  if (!body) return;
  body.insertAdjacentHTML('beforeend', listDays(from, to));
  $('#listEnd').outerHTML = listFooter();
  listObserve();
}

// ---------- Selectie ----------

function select(id) {
  state.selected = id;
  $$('#board [data-occ]').forEach((el) => el.classList.toggle('sel', el.dataset.occ === id));
  renderDetail();
}

// ---------- Verslepen ----------
// Muis: meteen slepen. Aanraken: even vasthouden, dan slepen. Onderrand = langer/korter maken.

const SNAP = 15;
let drag = null;
let swallowClick = false;

const occOf = (el) => state.events.find((x) => occId(x) === el?.dataset.occ);

function dragStart(el, x, y, touch) {
  const o = occOf(el);
  if (!o?.can_write) return false;
  const monthChip = !!el.closest('.mcell');
  const col = el.closest('.tg-col');
  if (!monthChip && !col) return false;
  const r = el.getBoundingClientRect();
  const resize = !monthChip && y > r.bottom - (touch ? 16 : 8);
  drag = {
    el, o, x, y, touch, resize, month: monthChip, active: false,
    grab: y - r.top,
    day: parseYmd((col || el.closest('.mcell')).dataset[col ? 'col' : 'mcell']),
    ns: o.startD, ne: o.endD
  };
  return true;
}

function dragActivate() {
  drag.active = true;
  drag.el.classList.add('dragging');
  document.documentElement.classList.add('is-dragging');
  haptic('tick');
  if (!drag.month) autoScroll();
}

function dragMove(x, y) {
  drag.lx = x;
  drag.ly = y;
  const under = document.elementFromPoint(x, y);
  if (drag.month) {
    const cell = under?.closest('[data-mcell]');
    $$('.mcell.drop').forEach((c) => c !== cell && c.classList.remove('drop'));
    if (!cell) return;
    cell.classList.add('drop');
    const delta = Math.round((parseYmd(cell.dataset.mcell) - drag.day) / 864e5);
    drag.ns = addDays(drag.o.startD, delta);
    drag.ne = addDays(drag.o.endD, delta);
    if (!drag.o.allDay) {
      drag.ns = new Date(drag.ns.setHours(drag.o.startD.getHours(), drag.o.startD.getMinutes()));
      drag.ne = new Date(drag.ns.getTime() + (drag.o.endD - drag.o.startD));
    }
    return;
  }
  const col = under?.closest('.tg-col') || drag.el.parentElement;
  const rect = col.getBoundingClientRect();
  const day = parseYmd(col.dataset.col);
  const dur = drag.o.endD - drag.o.startD;
  const at = (min) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, min);
  if (drag.resize) {
    const startMin = (drag.o.startD - day) / 6e4;
    let end = Math.round(((y - rect.top) / HOUR) * 60 / SNAP) * SNAP;
    end = Math.min(1440, Math.max(end, Math.max(startMin, 0) + SNAP));
    drag.ne = at(end);
    drag.ns = drag.o.startD;
    drag.el.style.height = `${Math.max(((end - Math.max(startMin, 0)) / 60) * HOUR - 3, 20)}px`;
  } else {
    const durMin = Math.round(dur / 6e4);
    let start = Math.round(((y - drag.grab - rect.top) / HOUR) * 60 / SNAP) * SNAP;
    start = Math.min(Math.max(start, 0), 1440 - Math.min(durMin, 1440 - SNAP) );
    drag.ns = at(start);
    drag.ne = new Date(drag.ns.getTime() + dur);
    if (drag.el.parentElement !== col) col.append(drag.el);
    Object.assign(drag.el.style, { top: `${(start / 60) * HOUR + 1}px`, left: '3px', width: 'calc(100% - 6px)' });
  }
  const s = drag.el.querySelector('.s');
  if (s) s.textContent = `${hm(drag.ns)} – ${hm(drag.ne)}`;
}

// Bij de boven- of onderrand vanzelf meescrollen.
function autoScroll() {
  if (!drag?.active) return;
  const sc = $('#scroller');
  if (sc && drag.ly != null) {
    const r = sc.getBoundingClientRect();
    const top = r.top + (isApp ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-top')) || 0 : 0) + 60;
    const bottom = r.bottom - (isApp ? 110 : 0) - 30;
    const v = drag.ly < top ? -Math.min(14, (top - drag.ly) / 3) : drag.ly > bottom ? Math.min(14, (drag.ly - bottom) / 3) : 0;
    if (v) {
      sc.scrollTop += v;
      dragMove(drag.lx, drag.ly);
    }
  }
  requestAnimationFrame(autoScroll);
}

function dragEnd(cancel = false) {
  const d = drag;
  drag = null;
  if (!d) return;
  document.documentElement.classList.remove('is-dragging');
  $$('.mcell.drop').forEach((c) => c.classList.remove('drop'));
  if (!d.active) return;
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 0);
  const changed = +d.ns !== +d.o.startD || +d.ne !== +d.o.endD;
  if (cancel || !changed) {
    renderBoard();
    return;
  }
  commitMove(d.o, d.ns, d.ne);
}

async function commitMove(o, ns, ne) {
  const fmt = (d) => (o.allDay ? ymd(d) : `${ymd(d)}T${hm2(d)}`);
  const body = { move: true, allDay: o.allDay, start: fmt(ns), end: fmt(ne), tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
  if (o.recurring) body.occurrence = o.key;
  Object.assign(o, { startD: ns, endD: ne });
  renderBoard();
  renderDetail();
  haptic('confirm');
  try {
    await api(`events/${o.id}`, { method: 'PATCH', body });
    toast(o.recurring ? 'Alleen deze keer verplaatst' : 'Afspraak verplaatst');
  } catch (err) {
    toast(err.message);
  }
  refresh().then(nativeSync);
}

function setupDrag(board) {
  // Muis
  board.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest('[data-occ]');
    if (!el || !dragStart(el, e.clientX, e.clientY, false)) return;
    e.preventDefault();
    const move = (ev) => {
      if (!drag) return;
      if (!drag.active && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 4) dragActivate();
      if (drag.active) dragMove(ev.clientX, ev.clientY);
    };
    const up = () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      dragEnd();
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag?.active) dragEnd(true);
  });

  // Aanraken: 350 ms vasthouden
  let timer = null;
  board.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const el = e.target.closest('[data-occ]');
    if (!el || !dragStart(el, t.clientX, t.clientY, true)) return;
    timer = setTimeout(() => {
      timer = null;
      if (drag) dragActivate();
    }, 350);
  }, { passive: true });
  board.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const t = e.touches[0];
    if (!drag.active) {
      if (Math.hypot(t.clientX - drag.x, t.clientY - drag.y) > 8) {
        clearTimeout(timer);
        drag = null;
      }
      return;
    }
    e.preventDefault();
    dragMove(t.clientX, t.clientY);
  }, { passive: false });
  const stop = (cancel) => () => {
    clearTimeout(timer);
    dragEnd(cancel);
  };
  board.addEventListener('touchend', stop(false));
  board.addEventListener('touchcancel', stop(true));
  board.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-occ]')) e.preventDefault();
  });
  board.addEventListener('click', (e) => {
    if (swallowClick) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
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
  if (v !== 'list') {
    state.calView = v;
    store.set('view', v);
  }
  state.miniMonth = null;
  state.resetScroll = true;
  load({ animate: true });
}

function gotoDay(s, view = 'day') {
  state.cursor = parseYmd(s);
  state.miniMonth = null;
  if (view === 'list') view = state.calView;
  if (view !== state.view) {
    state.view = view;
    state.calView = view;
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

// ---------- Herhaling ----------

const WD_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WD_NL = { MO: 'ma', TU: 'di', WE: 'wo', TH: 'do', FR: 'vr', SA: 'za', SU: 'zo' };
const WD_OF = (d) => WD_ORDER[(d.getDay() + 6) % 7];
const FREQ_NL = { DAILY: ['dag', 'dagen'], WEEKLY: ['week', 'weken'], MONTHLY: ['maand', 'maanden'], YEARLY: ['jaar', 'jaar'] };
const ORD_NL = ['eerste', 'tweede', 'derde', 'vierde', 'vijfde'];
const isWorkdays = (r) => r.freq === 'WEEKLY' && r.interval === 1 && r.end === 'never' && r.byday.join() === 'MO,TU,WE,TH,FR';

// value: none/daily/weekly/monthly/yearly/workdays/rule, of 'custom' (te ingewikkeld: ongemoeid laten).
function setRepeat(value, rule = null) {
  form.repeat.querySelector('option[value="custom"]')?.remove();
  if (rule && value === 'custom') {
    if (!rule.editable) form.repeat.insertAdjacentHTML('beforeend', '<option value="custom">Aangepast (ingesteld op ander apparaat)</option>');
    else value = isWorkdays(rule) ? 'workdays' : 'rule';
  } else if (value === 'custom') {
    form.repeat.insertAdjacentHTML('beforeend', '<option value="custom">Aangepast (ingesteld op ander apparaat)</option>');
  }
  form.repeat.value = value || 'none';
  if (value === 'rule') fillRule(rule);
  showRule();
}

function ruleStart() {
  return form.startDate.value ? parseYmd(form.startDate.value) : new Date();
}

function monthlyOptions() {
  const d = ruleStart();
  const n = Math.ceil(d.getDate() / 7);
  const last = d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const cur = form.ruleMonthly.value;
  form.ruleMonthly.innerHTML = `<option value="day">dag ${d.getDate()}</option>
    ${n <= 4 ? `<option value="nth">de ${ORD_NL[n - 1]} ${DAYS[d.getDay()]}</option>` : ''}
    ${last ? `<option value="last">de laatste ${DAYS[d.getDay()]}</option>` : ''}`;
  form.ruleMonthly.value = form.ruleMonthly.querySelector(`option[value="${cur}"]`) ? cur : 'day';
}

function fillRule(rule) {
  const d = ruleStart();
  const r = rule || { freq: 'WEEKLY', interval: 1, byday: [WD_OF(d)], monthly: 'day', end: 'never' };
  form.ruleFreq.value = r.freq;
  form.ruleInterval.value = r.interval || 1;
  $$('#ruleDays button').forEach((b) => b.setAttribute('aria-pressed', String((r.byday?.length ? r.byday : [WD_OF(d)]).includes(b.dataset.wd))));
  monthlyOptions();
  form.ruleMonthly.value = form.ruleMonthly.querySelector(`option[value="${r.monthly}"]`) ? r.monthly : 'day';
  form.ruleEnd.value = r.end || 'never';
  form.ruleUntil.value = r.until || ymd(addDays(d, 90));
  form.ruleCount.value = r.count || 10;
}

function showRule() {
  const on = form.repeat.value === 'rule' && !$('#repeatLabel').hidden;
  $('#ruleBox').hidden = !on;
  if (!on) return;
  const f = form.ruleFreq.value;
  const n = Math.max(1, parseInt(form.ruleInterval.value, 10) || 1);
  [...form.ruleFreq.options].forEach((o) => { o.textContent = FREQ_NL[o.value][n > 1 ? 1 : 0]; });
  $('#ruleDays').hidden = f !== 'WEEKLY';
  $('#ruleMonthlyRow').hidden = f !== 'MONTHLY';
  form.ruleUntil.hidden = form.ruleEnd.value !== 'until';
  form.ruleCount.hidden = form.ruleEnd.value !== 'count';
  $('#ruleSum').textContent = ruleSummary(collectRule());
}

function collectRule() {
  if (form.repeat.value === 'workdays') return { freq: 'WEEKLY', interval: 1, byday: ['MO', 'TU', 'WE', 'TH', 'FR'], end: 'never' };
  const byday = $$('#ruleDays button[aria-pressed="true"]').map((b) => b.dataset.wd);
  return {
    freq: form.ruleFreq.value,
    interval: Math.max(1, parseInt(form.ruleInterval.value, 10) || 1),
    byday: byday.length ? byday : [WD_OF(ruleStart())],
    monthly: form.ruleMonthly.value || 'day',
    end: form.ruleEnd.value,
    until: form.ruleUntil.value,
    count: Math.max(1, parseInt(form.ruleCount.value, 10) || 1)
  };
}

function ruleSummary(r) {
  const unit = FREQ_NL[r.freq][r.interval > 1 ? 1 : 0];
  let t = r.interval > 1 ? `Elke ${r.interval} ${unit}` : `Elke ${unit}`;
  if (r.freq === 'WEEKLY') t += ` op ${WD_ORDER.filter((w) => r.byday.includes(w)).map((w) => WD_NL[w]).join(', ')}`;
  if (r.freq === 'MONTHLY') t += ` op ${form.ruleMonthly.selectedOptions[0]?.textContent || ''}`;
  if (r.end === 'until' && r.until) {
    const u = parseYmd(r.until);
    t += `, tot en met ${u.getDate()} ${MONTHS[u.getMonth()]} ${u.getFullYear()}`;
  }
  if (r.end === 'count') t += `, ${r.count} keer`;
  return `${t}.`;
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
  setAlarm(15);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60);
  const end = new Date(start.getTime() + 3600e3);
  form.startDate.value = ymd(start);
  form.startTime.value = hm2(start);
  form.endDate.value = ymd(end);
  form.endTime.value = hm2(end);
  setAllDay(allDay);
  setRepeat('none');
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
  showRule();
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
    setRepeat(ev.repeat, ev.rule);
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
  if (!occ) openDialog();
  if (recurring) setScope('this');
  else fillFields(ev.occurrence || ev);
  setRepeat(ev.repeat, ev.rule);
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
  if (form.repeat.value === 'rule' && !$('#ruleBox').hidden && form.ruleEnd.value === 'until' && form.ruleUntil.value < form.startDate.value) {
    return showError($('#dlgError'), 'De herhaling stopt voordat de afspraak begint.');
  }
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
    ...(['rule', 'workdays'].includes(form.repeat.value) ? { repeat: 'rule', rule: collectRule() } : {}),
    alarm: form.alarm.value === '' ? 'none' : Number(form.alarm.value)
  };
  if (editing?.scope === 'this') {
    body.scope = 'this';
    body.occurrence = editing.ev.occurrence.key;
    delete body.repeat;
    delete body.rule;
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

// ---------- App downloaden / op beginscherm ----------

const RELEASES = 'https://github.com/timmmmmmmmn/agenda-android/releases/latest';
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);
// Alleen tonen op een telefoon/tablet, en niet als je de app al gebruikt.
const promo = !isApp && (isIOS || isAndroid) ? (isIOS ? 'ios' : 'android') : null;

function promoHtml() {
  const img = '<img src="/icons/icon-192.png?v=3" alt="">';
  if (promo === 'android') {
    return `<a class="promo" href="${RELEASES}" target="_blank" rel="noopener">${img}
      <span><strong>Download de Android-app</strong><span>APK van GitHub · werkt zich zelf bij</span></span></a>`;
  }
  if (promo === 'ios') {
    return `<button type="button" class="promo" id="iosPromo" aria-expanded="false">${img}
      <span><strong>Zet Agenda op je beginscherm</strong><span>Werkt als een app, zonder App Store</span></span></button>
      <ol class="promo-steps" id="iosSteps" hidden>
        <li>Tik in Safari op de <strong>deelknop</strong> (vierkantje met pijl omhoog).</li>
        <li>Kies <strong>Zet op beginscherm</strong>.</li>
        <li>Tik op <strong>Voeg toe</strong>. Agenda staat nu tussen je apps.</li>
      </ol>`;
  }
  return '';
}

function promoSeen() {
  try {
    return localStorage.getItem('promoSeen') === '1';
  } catch {
    return true;
  }
}

// ---------- Accountmenu ----------

let pendingCount = 0;

async function renderMenu() {
  const me = state.me;
  let pending = 0;
  if (me.is_admin) {
    try {
      pending = (await api('admin/users')).filter((u) => u.status === 'pending').length;
    } catch {}
  }
  pendingCount = pending;
  $('#avatar').innerHTML = `${esc(initials(me.full_name))}${pending || (promo && !promoSeen()) ? '<span class="badge"></span>' : ''}`;
  $('#menu').innerHTML = `
    <div class="who"><strong>${esc(me.full_name)}</strong><span>@${esc(me.username)}</span></div>
    ${promoHtml()}
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
    <div class="menu-label">Broncode</div>
    <a class="src-link" href="https://github.com/timmmmmmmmn/agenda" target="_blank" rel="noopener">Website <span>GitHub ↗</span></a>
    <a class="src-link" href="https://github.com/timmmmmmmmn/agenda-android" target="_blank" rel="noopener">Android-app <span>GitHub ↗</span></a>
    <div class="sep"></div>
    ${appVersion() ? `<button type="button" id="checkUpdate">App bijwerken <span class="label" style="font-size:13px">versie ${esc(appVersion())}</span></button>` : ''}
    <button type="button" id="logout" class="danger">Uitloggen</button>`;
  $('#iosPromo')?.addEventListener('click', (e) => {
    const steps = $('#iosSteps');
    steps.hidden = !steps.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!steps.hidden));
  });
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
  if (show && promo && !promoSeen()) {
    try {
      localStorage.setItem('promoSeen', '1');
    } catch {}
    if (!pendingCount) $('#avatar .badge')?.remove();
  }
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
  dateLogo($('#brandMark'));
  $('#prev').innerHTML = icon('left');
  $('#next').innerHTML = icon('right');
  $('#newBtn').innerHTML = `${icon('plus')} Nieuwe afspraak`;
  $('#fab').innerHTML = icon('plus');
  $('#dlgClose').innerHTML = icon('close');
  renderMenu();

  $('#prev').addEventListener('click', () => go(-1));
  $('#next').addEventListener('click', () => go(1));
  $('#today').addEventListener('click', () => {
    if (state.view !== 'list') return gotoDay(ymd(new Date()), state.view);
    const el = $('.lday.today');
    $('#scroller')?.scrollTo({ top: el ? el.offsetTop - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-top')) || 0) - 8 : 0, behavior: 'smooth' });
  });
  $$('#viewSeg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  const newHere = () => {
    const now = new Date();
    const base = state.view === 'list' || sameDay(state.cursor, now) || state.view !== 'day' && now >= range()[0] && now < range()[1] ? now : state.cursor;
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
  setupDrag(board);
  board.addEventListener('click', (e) => {
    if (e.target.closest('#listEarlier')) return listEarlier();
    if (e.target.closest('#listGoOn')) {
      list.ended = false;
      list.empty = 0;
      $('#listEnd').outerHTML = listFooter();
      listObserve();
      return listMore();
    }
    const occ = e.target.closest('[data-occ]');
    if (occ) {
      select(occ.dataset.occ);
      if (narrow.matches || state.view === 'list') openEdit(...occ.dataset.occ.split('|'));
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
  form.startDate.addEventListener('change', () => {
    shiftEnd();
    monthlyOptions();
    showRule();
  });
  form.repeat.addEventListener('change', () => {
    if (form.repeat.value === 'rule') fillRule(null);
    showRule();
  });
  for (const n of ['ruleFreq', 'ruleInterval', 'ruleMonthly', 'ruleEnd', 'ruleUntil', 'ruleCount']) {
    form[n].addEventListener('input', showRule);
    form[n].addEventListener('change', showRule);
  }
  $('#ruleDays').addEventListener('click', (e) => {
    const b = e.target.closest('[data-wd]');
    if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true';
    if (!on && $$('#ruleDays button[aria-pressed="true"]').length === 1) return;
    b.setAttribute('aria-pressed', String(on));
    if (editing) editing.dirty = true;
    showRule();
  });
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
  if (isApp) listReset();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load({ cals: true });
  });
  form.addEventListener('input', () => {
    if (editing) editing.dirty = true;
  });

  // Terugknop van de Android-app: eerst sluiten wat open staat.
  window.agendaBack = () => {
    if (isApp && !$('#viewPick').hidden) {
      togglePick(false);
      return true;
    }
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
    if (isApp && state.view !== 'list') {
      setView('list');
      return true;
    }
    return false;
  };

  if (isApp) setupApp(newHere);

  state.resetScroll = true;
  await load({ animate: true, cals: true });

  // Vanuit de widget van de app: een afspraak openen of meteen een nieuwe maken.
  window.agendaOpen = (id, key) => openEdit(id, key);
  window.agendaNew = () => newHere();
  const q = new URLSearchParams(location.search);
  if (q.has('open') || q.has('nieuw')) {
    history.replaceState(null, '', '/');
    if (q.has('nieuw')) newHere();
    else {
      const [id, key] = q.get('open').split('-');
      if (/^\d+$/.test(id) && /^\d+$/.test(key)) openEdit(id, key);
    }
  }
}

// ---------- Android-app ----------

function togglePick(open) {
  const pick = $('#viewPick');
  if (!pick) return;
  const show = open ?? pick.hidden;
  pick.hidden = !show;
  if (show) {
    // Boven de Agenda-knop, maar binnen het scherm.
    const nav = pick.parentElement.getBoundingClientRect();
    const btn = $('#appnavPill [data-nav="agenda"]').getBoundingClientRect();
    const half = pick.offsetWidth / 2;
    const x = Math.min(Math.max(btn.left + btn.width / 2, half + 12), innerWidth - half - 12);
    pick.style.setProperty('--pick-x', `${x - nav.left}px`);
  }
  $('#appnavPill [data-nav="agenda"]')?.setAttribute('aria-expanded', String(show));
}

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
    if (nav !== 'agenda') togglePick(false);
    if (nav === 'agenda') {
      closeSearch();
      togglePick();
    } else if (nav === 'search') {
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
  $$('#viewPick [data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
  $('#viewPick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    haptic();
    togglePick(false);
    if (b.dataset.pick === state.view) return;
    if (state.view === 'list') state.cursor = startOfDay(new Date());
    setView(b.dataset.pick);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#viewPick') && !e.target.closest('[data-nav="agenda"]')) togglePick(false);
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
    if (swallowClick || drag || state.view === 'list') return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Date.now() - st < 600 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) go(dx < 0 ? 1 : -1);
  }, { passive: true });
}

init();
