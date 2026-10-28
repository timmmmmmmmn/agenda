// Minimale iCalendar (RFC 5545) parser/schrijver met herhalingen (RRULE).
// De ruwe ICS-tekst blijft de bron van waarheid; hier halen we er uit wat de
// webinterface nodig heeft en passen we alleen de velden aan die de gebruiker wijzigt.

export const DEFAULT_TZ = 'Europe/Amsterdam';
const DAY = 86400000;

// ---------- Regels lezen en schrijven ----------

export function unfold(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((l) => l.length);
}

function splitOutsideQuotes(str, sep) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (const c of str) {
    if (c === '"') inQ = !inQ;
    if (c === sep && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseLine(line) {
  let inQ = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1), raw: line };
}

export function parseIcs(text) {
  const root = { name: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const comp = { name: p.value.trim().toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(comp);
      stack.push(comp);
    } else if (p.name === 'END') {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].props.push(p);
    }
  }
  return root.children.find((c) => c.name === 'VCALENDAR') || null;
}

function propLine(p) {
  if (p.raw) return p.raw;
  let s = p.name;
  for (const [k, v] of Object.entries(p.params || {})) {
    s += `;${k}=${/[:;,]/.test(v) ? `"${v}"` : v}`;
  }
  return `${s}:${p.value}`;
}

const enc = new TextEncoder();

function fold(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function serialize(comp) {
  const lines = [];
  const walk = (c) => {
    lines.push(`BEGIN:${c.name}`);
    for (const p of c.props) lines.push(fold(propLine(p)));
    for (const ch of c.children) walk(ch);
    lines.push(`END:${c.name}`);
  };
  walk(comp);
  return lines.join('\r\n') + '\r\n';
}

export function escapeText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

export function unescapeText(s) {
  return String(s ?? '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

const getProp = (comp, name) => comp.props.find((p) => p.name === name);
const getProps = (comp, name) => comp.props.filter((p) => p.name === name);

function setProp(comp, name, params, value) {
  const idx = comp.props.findIndex((p) => p.name === name);
  const prop = { name, params, value, raw: null };
  if (idx >= 0) comp.props[idx] = prop;
  else comp.props.push(prop);
}

function removeProps(comp, names) {
  comp.props = comp.props.filter((p) => !names.includes(p.name));
}

// ---------- Tijdzones ----------

const dtfCache = new Map();
const tzValid = new Map();

function resolveTz(tzid) {
  if (!tzid) return DEFAULT_TZ;
  if (tzValid.has(tzid)) return tzValid.get(tzid);
  let tz = DEFAULT_TZ;
  const candidates = [tzid, (tzid.match(/[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/) || [])[0]];
  for (const c of candidates) {
    if (!c) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: c });
      tz = c;
      break;
    } catch {}
  }
  tzValid.set(tzid, tz);
  return tz;
}

function tzOffset(ms, tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    dtfCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = tzOffset(guess, tz);
  let t = guess - off;
  const off2 = tzOffset(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}

// ---------- Datums ----------

// Een DT-waarde: { allDay, dn (dagnummer sinds 1970), h, mi, s, tz }  tz: 'UTC' | IANA-naam
function parseDt(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const dn = Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY;
  if (!m[4] || prop.params.VALUE === 'DATE') return { allDay: true, dn, h: 0, mi: 0, s: 0, tz: null };
  return { allDay: false, dn, h: +m[4], mi: +m[5], s: +m[6], tz: m[7] ? 'UTC' : resolveTz(prop.params.TZID) };
}

function ymd(dn) {
  const d = new Date(dn * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
}

function dtToMs(dt) {
  if (dt.allDay) return dt.dn * DAY;
  if (dt.tz === 'UTC') return dt.dn * DAY + ((dt.h * 60 + dt.mi) * 60 + dt.s) * 1000;
  const { y, m, d } = ymd(dt.dn);
  return zonedToUtc(y, m, d, dt.h, dt.mi, dt.s, dt.tz);
}

export function dateStr(dn) {
  const { y, m, d } = ymd(dn);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 + +(m[4] || 0)) * 60 + +(m[5] || 0)) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ---------- Afspraken uitlezen ----------

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRrule(value) {
  const r = {};
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) r[k.toUpperCase()] = v;
  }
  if (!r.FREQ) return null;
  const rule = {
    freq: r.FREQ.toUpperCase(),
    interval: Math.max(1, parseInt(r.INTERVAL || '1', 10)),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: null,
    byday: r.BYDAY ? r.BYDAY.split(',').map((x) => {
      const mm = x.match(/^([+-]?\d+)?([A-Z]{2})$/i);
      return mm ? { n: mm[1] ? parseInt(mm[1], 10) : 0, wd: WD[mm[2].toUpperCase()] } : null;
    }).filter(Boolean) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null,
    raw: value
  };
  if (r.UNTIL) {
    const u = parseDt({ value: r.UNTIL, params: {} });
    if (u) rule.until = u.allDay ? (u.dn + 1) * DAY - 1 : (u.tz === 'UTC' ? dtToMs(u) : dtToMs({ ...u, tz: DEFAULT_TZ }));
  }
  return rule;
}

function readVevent(comp) {
  const start = parseDt(getProp(comp, 'DTSTART'));
  if (!start) return null;
  const endProp = parseDt(getProp(comp, 'DTEND'));
  const startMs = dtToMs(start);
  let durMs;
  if (endProp) durMs = Math.max(0, dtToMs(endProp) - startMs);
  else {
    const dur = parseDuration(getProp(comp, 'DURATION')?.value);
    durMs = dur != null ? Math.max(0, dur) : (start.allDay ? DAY : 0);
  }
  const rr = getProp(comp, 'RRULE');
  const exdates = new Set();
  for (const p of getProps(comp, 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const dt = parseDt({ value: v, params: p.params });
      if (dt) exdates.add(dtToMs(dt.allDay === start.allDay ? dt : { ...dt, allDay: start.allDay }));
    }
  }
  const rid = parseDt(getProp(comp, 'RECURRENCE-ID'));
  const alarm = comp.children.find((c) => c.name === 'VALARM');
  const trig = alarm ? parseDuration(getProp(alarm, 'TRIGGER')?.value) : null;
  return {
    comp,
    uid: getProp(comp, 'UID')?.value || '',
    start,
    startMs,
    durMs,
    allDay: start.allDay,
    title: unescapeText(getProp(comp, 'SUMMARY')?.value || ''),
    location: unescapeText(getProp(comp, 'LOCATION')?.value || ''),
    notes: unescapeText(getProp(comp, 'DESCRIPTION')?.value || ''),
    cancelled: (getProp(comp, 'STATUS')?.value || '').toUpperCase() === 'CANCELLED',
    rrule: rr ? parseRrule(rr.value) : null,
    exdates,
    recurrenceId: rid ? dtToMs(rid) : null,
    alarmMin: trig != null && trig <= 0 ? Math.round(-trig / 60000) : null
  };
}

export function readEvents(text) {
  const cal = parseIcs(text);
  if (!cal) return null;
  const vevents = cal.children.filter((c) => c.name === 'VEVENT').map(readVevent).filter(Boolean);
  if (!vevents.length) return null;
  const master = vevents.find((v) => v.recurrenceId == null) || vevents[0];
  const overrides = vevents.filter((v) => v !== master && v.recurrenceId != null);
  return { cal, master, overrides, uid: master.uid };
}

// ---------- Herhalingen uitrekenen ----------

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthDays(y, m, rule, fallbackDay) {
  const dim = daysInMonth(y, m);
  const first = Date.UTC(y, m - 1, 1) / DAY;
  const out = [];
  if (rule.bymonthday) {
    for (const md of rule.bymonthday) {
      const d = md > 0 ? md : dim + md + 1;
      if (d >= 1 && d <= dim) out.push(first + d - 1);
    }
  } else if (rule.byday) {
    for (const { n, wd } of rule.byday) {
      const firstDow = ymd(first).dow;
      const all = [];
      for (let d = 1 + ((wd - firstDow + 7) % 7); d <= dim; d += 7) all.push(first + d - 1);
      if (n > 0 && all[n - 1] != null) out.push(all[n - 1]);
      else if (n < 0 && all[all.length + n] != null) out.push(all[all.length + n]);
      else if (n === 0) out.push(...all);
    }
  } else if (fallbackDay <= dim) {
    out.push(first + fallbackDay - 1);
  }
  return out;
}

function periodDays(rule, start, i) {
  const { y, m, d, dow } = ymd(start.dn);
  switch (rule.freq) {
    case 'DAILY':
      return [start.dn + i * rule.interval];
    case 'WEEKLY': {
      const ws = start.dn - ((dow + 6) % 7) + i * 7 * rule.interval;
      if (!rule.byday) return [ws + ((dow + 6) % 7)];
      return rule.byday.map(({ wd }) => ws + ((wd + 6) % 7));
    }
    case 'MONTHLY': {
      const idx = (m - 1) + i * rule.interval;
      return monthDays(y + Math.floor(idx / 12), (idx % 12) + 1, rule, d);
    }
    case 'YEARLY': {
      const yy = y + i * rule.interval;
      const months = rule.bymonth || [m];
      return months.flatMap((mm) => (rule.byday || rule.bymonthday ? monthDays(yy, mm, rule, d) : monthDays(yy, mm, {}, d)));
    }
    default:
      return [];
  }
}

const APPROX_PERIOD = { DAILY: 1, WEEKLY: 7, MONTHLY: 28, YEARLY: 365 };

// Geeft { startMs, endMs, allDay, key } per voorkomen binnen [fromMs, toMs).
function expandMaster(ev, fromMs, toMs, max = 2000) {
  const out = [];
  const make = (dn) => {
    const dt = { ...ev.start, dn };
    const startMs = dtToMs(dt);
    return { startMs, endMs: startMs + ev.durMs, allDay: ev.allDay, key: startMs, dn };
  };
  const rule = ev.rrule;
  if (!rule || !APPROX_PERIOD[rule.freq]) {
    const o = make(ev.start.dn);
    if (o.startMs < toMs && (o.endMs > fromMs || (o.endMs === o.startMs && o.startMs >= fromMs))) out.push(o);
    return out;
  }
  let i = 0;
  if (!rule.count) {
    const gapDays = (fromMs - ev.startMs - ev.durMs) / DAY;
    if (gapDays > 0) i = Math.max(0, Math.floor(gapDays / (APPROX_PERIOD[rule.freq] * rule.interval)) - 1);
  }
  let produced = 0;
  for (let guard = 0; guard < 5000; guard++, i++) {
    const days = [...new Set(periodDays(rule, ev.start, i))].sort((a, b) => a - b);
    let stop = false;
    for (const dn of days) {
      if (dn < ev.start.dn) continue;
      if (rule.bymonth && rule.freq !== 'YEARLY' && !rule.bymonth.includes(ymd(dn).m)) continue;
      if (rule.freq === 'DAILY' && rule.byday && !rule.byday.some((b) => b.wd === ymd(dn).dow)) continue;
      const o = make(dn);
      produced++;
      if (rule.count && produced > rule.count) { stop = true; break; }
      if (rule.until != null && o.startMs > rule.until) { stop = true; break; }
      if (o.startMs >= toMs) { stop = true; break; }
      if (o.endMs > fromMs && !ev.exdates.has(o.key)) out.push(o);
      if (out.length >= max) { stop = true; break; }
    }
    if (stop) break;
  }
  return out;
}

export function occurrences(text, fromMs, toMs) {
  const parsed = readEvents(text);
  if (!parsed) return [];
  const { master, overrides } = parsed;
  const overridden = new Set(overrides.map((o) => o.recurrenceId));
  const res = [];
  const push = (ev, o, isOverride) => {
    if (ev.cancelled) return;
    res.push({
      key: o.key,
      start: ev.allDay ? dateStr(Math.floor(o.startMs / DAY)) : new Date(o.startMs).toISOString(),
      end: ev.allDay ? dateStr(Math.floor(o.endMs / DAY)) : new Date(o.endMs).toISOString(),
      allDay: ev.allDay,
      title: ev.title,
      location: ev.location,
      notes: ev.notes,
      recurring: !!master.rrule,
      override: isOverride
    });
  };
  for (const o of expandMaster(master, fromMs, toMs)) {
    if (!overridden.has(o.key)) push(master, o, false);
  }
  for (const ov of overrides) {
    const o = { startMs: ov.startMs, endMs: ov.startMs + ov.durMs, key: ov.recurrenceId };
    if (o.startMs < toMs && o.endMs > fromMs) push(ov, o, true);
  }
  return res.sort((a, b) => (a.start < b.start ? -1 : 1));
}

// Index-velden voor de database: eerste start en laatste eind (null = oneindig).
export function summarize(text) {
  const parsed = readEvents(text);
  if (!parsed) return null;
  const { master, overrides } = parsed;
  let lastEnd = master.startMs + master.durMs;
  const r = master.rrule;
  if (r) {
    if (r.until != null) lastEnd = r.until + master.durMs;
    else if (r.count) {
      const occ = expandMaster(master, -8.64e15, 8.64e15, r.count + 1);
      lastEnd = occ.length ? occ[occ.length - 1].endMs : lastEnd;
    } else lastEnd = null;
  }
  for (const ov of overrides) {
    if (lastEnd != null) lastEnd = Math.max(lastEnd, ov.startMs + ov.durMs);
  }
  const firstStart = Math.min(master.startMs, ...overrides.map((o) => o.startMs));
  return { uid: parsed.uid, summary: master.title, firstStart, lastEnd, recurring: r ? 1 : 0 };
}

// Details van het hoofd-event, voor het bewerkvenster.
function fieldsOf(ev, startMs, durMs) {
  return {
    title: ev.title,
    location: ev.location,
    notes: ev.notes,
    allDay: ev.allDay,
    start: ev.allDay ? dateStr(Math.floor(startMs / DAY)) : new Date(startMs).toISOString(),
    end: ev.allDay ? dateStr(Math.floor((startMs + durMs) / DAY)) : new Date(startMs + durMs).toISOString(),
    alarm: ev.alarmMin
  };
}

// Details van het hoofd-event, voor het bewerkvenster. Met `key` (start van één
// voorkomen) komt er ook `occurrence` bij: dat ene voorkomen, met eventuele eigen wijzigingen.
export function details(text, key = null) {
  const parsed = readEvents(text);
  if (!parsed) return null;
  const m = parsed.master;
  let repeat = 'none';
  if (m.rrule) {
    const simple = m.rrule.interval === 1 && !m.rrule.count && !m.rrule.until && !m.rrule.byday && !m.rrule.bymonthday && !m.rrule.bymonth;
    repeat = simple ? m.rrule.freq.toLowerCase() : 'custom';
  }
  const out = { ...fieldsOf(m, m.startMs, m.durMs), repeat };
  if (key != null && m.rrule) {
    const ov = parsed.overrides.find((o) => o.recurrenceId === key);
    out.occurrence = ov ? { ...fieldsOf(ov, ov.startMs, ov.durMs), key } : { ...fieldsOf(m, key, m.durMs), key };
  }
  return out;
}

// ---------- Afspraken schrijven ----------

const VTIMEZONE_AMS = `BEGIN:VTIMEZONE
TZID:Europe/Amsterdam
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE`;

function utcStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// value: 'YYYY-MM-DD' (hele dag) of 'YYYY-MM-DDTHH:MM' (lokale tijd in tz)
function dtProp(value, allDay, tz) {
  if (allDay) return { params: { VALUE: 'DATE' }, value: value.replace(/-/g, '').slice(0, 8) };
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) throw new Error('Ongeldige tijd');
  if (tz === DEFAULT_TZ) return { params: { TZID: DEFAULT_TZ }, value: `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00` };
  const ms = zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], 0, resolveTz(tz));
  return { params: {}, value: utcStamp(ms) };
}

const FREQS = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };

function alarmComp(minutes) {
  return {
    name: 'VALARM',
    props: [
      { name: 'ACTION', params: {}, value: 'DISPLAY', raw: null },
      { name: 'DESCRIPTION', params: {}, value: 'Herinnering', raw: null },
      { name: 'TRIGGER', params: {}, value: minutes === 0 ? 'PT0S' : `-PT${minutes}M`, raw: null }
    ],
    children: []
  };
}

function applyFields(cal, ev, f) {
  const tz = f.tz || DEFAULT_TZ;
  setProp(ev, 'SUMMARY', {}, escapeText(f.title || 'Nieuwe afspraak'));
  for (const [key, name] of [['location', 'LOCATION'], ['notes', 'DESCRIPTION']]) {
    if (f[key]) setProp(ev, name, {}, escapeText(f[key]));
    else removeProps(ev, [name]);
  }
  const s = dtProp(f.start, f.allDay, tz);
  const e = dtProp(f.end, f.allDay, tz);
  setProp(ev, 'DTSTART', s.params, s.value);
  removeProps(ev, ['DURATION']);
  setProp(ev, 'DTEND', e.params, e.value);
  if ((s.params.TZID || e.params.TZID) && !cal.children.some((c) => c.name === 'VTIMEZONE' && getProp(c, 'TZID')?.value === DEFAULT_TZ)) {
    cal.children.unshift(parseIcs(`BEGIN:VCALENDAR\n${VTIMEZONE_AMS}\nEND:VCALENDAR`).children[0]);
  }
  if (f.repeat && f.repeat !== 'custom') {
    if (FREQS[f.repeat]) {
      const cur = getProp(ev, 'RRULE');
      const curFreq = cur && parseRrule(cur.value)?.freq;
      if (curFreq !== FREQS[f.repeat] || /INTERVAL|COUNT|UNTIL|BY/.test(cur.value)) {
        setProp(ev, 'RRULE', {}, `FREQ=${FREQS[f.repeat]}`);
      }
    } else {
      removeProps(ev, ['RRULE', 'RDATE', 'EXDATE']);
      cal.children = cal.children.filter((c) => !(c.name === 'VEVENT' && c !== ev && getProp(c, 'RECURRENCE-ID')));
    }
  }
  if (f.alarm !== undefined) {
    ev.children = ev.children.filter((c) => c.name !== 'VALARM');
    if (f.alarm !== null && f.alarm !== 'none' && Number.isFinite(Number(f.alarm))) ev.children.push(alarmComp(Number(f.alarm)));
  }
  setProp(ev, 'DTSTAMP', {}, utcStamp());
  setProp(ev, 'LAST-MODIFIED', {}, utcStamp());
}

export function buildEvent(uid, f) {
  const cal = parseIcs(`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//timvanbergen.nl//Agenda//NL\nCALSCALE:GREGORIAN\nBEGIN:VEVENT\nUID:${uid}\nCREATED:${utcStamp()}\nSEQUENCE:0\nEND:VEVENT\nEND:VCALENDAR`);
  applyFields(cal, cal.children.find((c) => c.name === 'VEVENT'), f);
  return serialize(cal);
}

export function patchEvent(text, f) {
  const parsed = readEvents(text);
  if (!parsed) throw new Error('Kan afspraak niet lezen');
  const { cal, master } = parsed;
  const ev = master.comp;
  applyFields(cal, ev, f);
  const seq = parseInt(getProp(ev, 'SEQUENCE')?.value || '0', 10);
  setProp(ev, 'SEQUENCE', {}, String(seq + 1));
  return serialize(cal);
}

// ---------- Eén voorkomen van een herhaling ----------

// RECURRENCE-ID/EXDATE in hetzelfde formaat als de DTSTART van de reeks.
function likeDtstart(master, key) {
  const p = getProp(master.comp, 'DTSTART');
  if (master.allDay) return { params: { VALUE: 'DATE' }, value: dateStr(Math.floor(key / DAY)).replace(/-/g, '') };
  if (master.start.tz === 'UTC') return { params: {}, value: utcStamp(key) };
  const local = key + tzOffset(key, master.start.tz);
  return { params: p.params.TZID ? { TZID: p.params.TZID } : {}, value: utcStamp(local).replace('Z', '') };
}

export function excludeOccurrence(text, key) {
  const parsed = readEvents(text);
  if (!parsed?.master.rrule) throw new Error('Geen herhalende afspraak');
  const { cal, master, overrides } = parsed;
  const drop = new Set(overrides.filter((o) => o.recurrenceId === key).map((o) => o.comp));
  cal.children = cal.children.filter((c) => !drop.has(c));
  const ex = likeDtstart(master, key);
  master.comp.props.push({ name: 'EXDATE', params: ex.params, value: ex.value, raw: null });
  setProp(master.comp, 'LAST-MODIFIED', {}, utcStamp());
  return serialize(cal);
}

export function overrideOccurrence(text, key, f) {
  const parsed = readEvents(text);
  if (!parsed?.master.rrule) throw new Error('Geen herhalende afspraak');
  const { cal, master, overrides } = parsed;
  let comp = overrides.find((o) => o.recurrenceId === key)?.comp;
  if (!comp) {
    const skip = ['RRULE', 'RDATE', 'EXDATE', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID'];
    comp = {
      name: 'VEVENT',
      props: master.comp.props.filter((p) => !skip.includes(p.name)).map((p) => ({ ...p })),
      children: master.comp.children.map((c) => ({ ...c, props: c.props.map((p) => ({ ...p })) }))
    };
    const rid = likeDtstart(master, key);
    comp.props.push({ name: 'RECURRENCE-ID', params: rid.params, value: rid.value, raw: null });
    cal.children.splice(cal.children.indexOf(master.comp) + 1, 0, comp);
  }
  applyFields(cal, comp, { ...f, repeat: undefined });
  const seq = parseInt(getProp(comp, 'SEQUENCE')?.value || '0', 10);
  setProp(comp, 'SEQUENCE', {}, String(seq + 1));
  return serialize(cal);
}
