// JSON-API voor de webinterface: /api/...

import {
  HttpError, json, fail, now, hashPassword, verifyPassword, createSession, destroySession,
  clearSessionCookie, sessionUser, tooManyAttempts, recordAttempt, clientIp, newAppPassword,
  normalizeAppPassword, sha256hex, randomToken
} from '../_lib/util.js';
import { occurrences, details, buildEvent, patchEvent, excludeOccurrence, overrideOccurrence, buildRrule, zonedToUtc, DEFAULT_TZ } from '../_lib/ical.js';
import { calendarIcs, importIcs, safeFileName, zip } from '../_lib/export.js';
import {
  visibleCalendars, requireCalendar, createCalendar, putEvent, deleteEvent
} from '../_lib/store.js';

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DAY = 86400000;

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Ongeldige invoer');
  }
}

function str(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Wachtwoord moet minimaal 10 tekens zijn');
  if (pw.length > 200) throw new HttpError(400, 'Wachtwoord is te lang');
}

// ---------- Account ----------

async function register(env, request) {
  const ip = clientIp(request);
  if (await tooManyAttempts(env, `reg|${ip}`, 5, 3600e3)) throw new HttpError(429, 'Te veel pogingen, probeer het later opnieuw');
  const b = await body(request);
  const username = str(b.username, 32).toLowerCase();
  const fullName = str(b.full_name, 100);
  const email = str(b.email, 200).toLowerCase();
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Gebruikersnaam: 3–32 tekens, kleine letters, cijfers, . _ of -');
  if (fullName.length < 2) throw new HttpError(400, 'Vul je volledige naam in');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Vul een geldig e-mailadres in');
  checkPassword(b.password);
  const exists = await env.DB.prepare('SELECT username, email FROM users WHERE username = ? OR email = ?').bind(username, email).first();
  if (exists) throw new HttpError(409, exists.username === username ? 'Deze gebruikersnaam is al bezet' : 'Er is al een account met dit e-mailadres');
  await recordAttempt(env, `reg|${ip}`);

  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const first = n === 0;
  const res = await env.DB.prepare(
    'INSERT INTO users (username, full_name, email, password_hash, status, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).bind(username, fullName, email, await hashPassword(b.password), first ? 'active' : 'pending', first ? 1 : 0, now()).first();
  await createCalendar(env, res.id, { name: 'Persoonlijk', color: '#2F6FED' });

  if (!first) return json({ status: 'pending' }, 201);
  return json({ status: 'active' }, 201, { 'set-cookie': await createSession(env, res.id, true) });
}

async function login(env, request) {
  const b = await body(request);
  const id = str(b.login, 200).toLowerCase();
  const ip = clientIp(request);
  if (await tooManyAttempts(env, `login|${ip}`, 20, 900e3) || await tooManyAttempts(env, `login|${id}`, 10, 900e3)) {
    throw new HttpError(429, 'Te veel mislukte pogingen. Wacht een kwartier en probeer het opnieuw.');
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? OR email = ?').bind(id, id).first();
  if (!user || !(await verifyPassword(String(b.password ?? ''), user.password_hash))) {
    await recordAttempt(env, `login|${ip}`);
    await recordAttempt(env, `login|${id}`);
    throw new HttpError(401, 'Gebruikersnaam of wachtwoord klopt niet');
  }
  if (user.status === 'pending') throw new HttpError(403, 'Je account wacht nog op goedkeuring');
  if (user.status !== 'active') throw new HttpError(403, 'Dit account is uitgeschakeld');
  return json({ ok: true }, 200, { 'set-cookie': await createSession(env, user.id, !!b.remember) });
}

async function updateMe(env, user, request) {
  const b = await body(request);
  const fullName = str(b.full_name, 100);
  const email = str(b.email, 200).toLowerCase();
  if (fullName.length < 2) throw new HttpError(400, 'Vul je volledige naam in');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Vul een geldig e-mailadres in');
  const taken = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(email, user.id).first();
  if (taken) throw new HttpError(409, 'Er is al een account met dit e-mailadres');
  await env.DB.prepare('UPDATE users SET full_name = ?, email = ? WHERE id = ?').bind(fullName, email, user.id).run();
  return json({ ok: true });
}

async function changePassword(env, user, request) {
  const b = await body(request);
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!(await verifyPassword(String(b.current ?? ''), row.password_hash))) throw new HttpError(400, 'Huidig wachtwoord klopt niet');
  checkPassword(b.password);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.password), user.id).run();
  return json({ ok: true });
}

// ---------- App-wachtwoorden ----------

async function listAppPasswords(env, user) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, created_at, last_used_at FROM app_passwords WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return json(results);
}

async function createAppPassword(env, user, request) {
  const b = await body(request);
  const name = str(b.name, 60) || 'Apparaat';
  const password = newAppPassword();
  await env.DB.prepare('INSERT INTO app_passwords (user_id, name, secret_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(user.id, name, await sha256hex(normalizeAppPassword(password)), now())
    .run();
  return json({ name, password }, 201);
}

// ---------- Agenda's ----------

async function listCalendars(env, user) {
  const cals = await visibleCalendars(env, user.id);
  const owned = cals.filter((c) => c.is_owner).map((c) => c.id);
  let shares = [];
  if (owned.length) {
    const { results } = await env.DB.prepare(
      `SELECT s.calendar_id, s.can_write, u.id AS user_id, u.username, u.full_name
         FROM calendar_shares s JOIN users u ON u.id = s.user_id
        WHERE s.calendar_id IN (${owned.map(() => '?').join(',')})
        ORDER BY u.full_name`
    ).bind(...owned).all();
    shares = results;
  }
  return json(cals.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    is_owner: !!c.is_owner,
    can_write: !!c.can_write,
    owner: { username: c.owner_username, full_name: c.owner_name },
    shares: c.is_owner ? shares.filter((s) => s.calendar_id === c.id).map((s) => ({
      user_id: s.user_id, username: s.username, full_name: s.full_name, can_write: !!s.can_write
    })) : undefined
  })));
}

async function newCalendar(env, user, request) {
  const b = await body(request);
  const name = str(b.name, 60);
  if (!name) throw new HttpError(400, 'Geef de agenda een naam');
  const color = COLOR_RE.test(b.color) ? b.color : '#2F6FED';
  return json({ id: await createCalendar(env, user.id, { name, color }) }, 201);
}

async function editCalendar(env, user, calId, request) {
  const cal = await requireCalendar(env, user.id, calId);
  if (!cal.is_owner) throw new HttpError(403, 'Alleen de eigenaar kan deze agenda aanpassen');
  const b = await body(request);
  const name = b.name !== undefined ? str(b.name, 60) : cal.name;
  const color = COLOR_RE.test(b.color) ? b.color : cal.color;
  if (!name) throw new HttpError(400, 'Geef de agenda een naam');
  await env.DB.prepare('UPDATE calendars SET name = ?, color = ?, sync_token = sync_token + 1 WHERE id = ?').bind(name, color, calId).run();
  return json({ ok: true });
}

async function removeCalendar(env, user, calId) {
  const cal = await requireCalendar(env, user.id, calId);
  if (cal.is_owner) {
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM calendars WHERE owner_id = ?').bind(user.id).first();
    if (n <= 1) throw new HttpError(400, 'Je moet minstens één eigen agenda houden');
    await env.DB.prepare('DELETE FROM calendars WHERE id = ?').bind(calId).run();
  } else {
    await env.DB.prepare('DELETE FROM calendar_shares WHERE calendar_id = ? AND user_id = ?').bind(calId, user.id).run();
  }
  return json({ ok: true });
}

async function addShare(env, user, calId, request) {
  const cal = await requireCalendar(env, user.id, calId);
  if (!cal.is_owner) throw new HttpError(403, 'Alleen de eigenaar kan deze agenda delen');
  const b = await body(request);
  const target = await env.DB.prepare("SELECT id FROM users WHERE username = ? AND status = 'active'").bind(str(b.username, 32).toLowerCase()).first();
  if (!target) throw new HttpError(404, 'Geen actieve gebruiker met deze gebruikersnaam');
  if (target.id === user.id) throw new HttpError(400, 'Je kunt een agenda niet met jezelf delen');
  await env.DB.prepare(
    'INSERT INTO calendar_shares (calendar_id, user_id, can_write) VALUES (?, ?, ?) ON CONFLICT (calendar_id, user_id) DO UPDATE SET can_write = excluded.can_write'
  ).bind(calId, target.id, b.can_write ? 1 : 0).run();
  return json({ ok: true });
}

async function removeShare(env, user, calId, userId) {
  const cal = await requireCalendar(env, user.id, calId);
  if (!cal.is_owner) throw new HttpError(403, 'Alleen de eigenaar kan delen aanpassen');
  await env.DB.prepare('DELETE FROM calendar_shares WHERE calendar_id = ? AND user_id = ?').bind(calId, Number(userId)).run();
  return json({ ok: true });
}

// ---------- Afspraken ----------

async function listEvents(env, user, url) {
  const from = Date.parse(url.searchParams.get('from'));
  const to = Date.parse(url.searchParams.get('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 400 * DAY) {
    throw new HttpError(400, 'Ongeldige periode');
  }
  const cals = await visibleCalendars(env, user.id);
  if (!cals.length) return json([]);
  const writable = new Map(cals.map((c) => [c.id, !!c.can_write]));
  const { results } = await env.DB.prepare(
    `SELECT id, calendar_id, ics FROM events
      WHERE calendar_id IN (${cals.map(() => '?').join(',')})
        AND first_start < ? AND (last_end IS NULL OR last_end > ?)`
  ).bind(...cals.map((c) => c.id), to + DAY, from - DAY).all();
  const out = [];
  for (const row of results) {
    for (const o of occurrences(row.ics, from - DAY, to + DAY)) {
      out.push({ ...o, id: row.id, calendar_id: row.calendar_id, can_write: writable.get(row.calendar_id) });
    }
  }
  return json(out);
}

async function loadEvent(env, user, id, write) {
  const row = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(Number(id)).first();
  if (!row) throw new HttpError(404, 'Afspraak niet gevonden');
  const cal = await requireCalendar(env, user.id, row.calendar_id, write);
  return { row, cal };
}

function eventFields(b) {
  const allDay = !!b.allDay;
  const re = allDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  if (!re.test(b.start) || !re.test(b.end)) throw new HttpError(400, 'Ongeldige datum of tijd');
  let end = b.end;
  if (end < b.start) end = b.start;
  if (allDay && end === b.start) {
    const d = new Date(`${b.start}T00:00:00Z`);
    end = new Date(d.getTime() + DAY).toISOString().slice(0, 10);
  }
  let rrule;
  if (b.repeat === 'rule') {
    try {
      rrule = buildRrule(b.rule, b.start, allDay, str(b.tz, 64) || DEFAULT_TZ);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }
  return {
    rrule,
    title: str(b.title, 200) || 'Nieuwe afspraak',
    location: str(b.location, 300),
    notes: str(b.notes, 5000),
    allDay,
    start: b.start,
    end,
    tz: str(b.tz, 64) || undefined,
    repeat: b.repeat === undefined || b.repeat === 'rule' ? undefined
      : ['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom'].includes(b.repeat) ? b.repeat : 'none',
    alarm: b.alarm === undefined ? undefined : (b.alarm === null || b.alarm === 'none' ? 'none' : Number(b.alarm))
  };
}

function occurrenceKey(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, 'Ongeldig voorkomen');
  return n;
}

async function getEventDetails(env, user, id, url) {
  const { row, cal } = await loadEvent(env, user, id, false);
  const key = occurrenceKey(url.searchParams.get('occurrence'));
  return json({ id: row.id, calendar_id: row.calendar_id, can_write: !!cal.can_write, ...details(row.ics, key) });
}

async function createEventApi(env, user, request) {
  const b = await body(request);
  await requireCalendar(env, user.id, b.calendar_id, true);
  const uid = crypto.randomUUID();
  const ics = buildEvent(uid, eventFields(b));
  const { id } = await putEvent(env, b.calendar_id, `${uid}.ics`, ics, user.id);
  return json({ id }, 201);
}

async function updateEventApi(env, user, id, request) {
  const { row } = await loadEvent(env, user, id, true);
  const b = await body(request);
  if (b.move) {
    // Verslepen: alleen begin en eind veranderen, de rest blijft zoals het is.
    const key = occurrenceKey(b.occurrence);
    const d = details(row.ics, key);
    const src = key != null && d.occurrence ? d.occurrence : d;
    const f = eventFields({ title: src.title, location: src.location, notes: src.notes, allDay: b.allDay, start: b.start, end: b.end, tz: b.tz });
    const ics = key != null && d.occurrence ? overrideOccurrence(row.ics, key, f) : patchEvent(row.ics, f);
    const res = await putEvent(env, row.calendar_id, row.href, ics, user.id);
    return json({ id: res.id });
  }
  if (b.scope === 'this') {
    // Alleen dit ene voorkomen aanpassen: blijft in dezelfde agenda.
    const ics = overrideOccurrence(row.ics, occurrenceKey(b.occurrence), eventFields(b));
    const res = await putEvent(env, row.calendar_id, row.href, ics, user.id);
    return json({ id: res.id });
  }
  const ics = patchEvent(row.ics, eventFields(b));
  const target = b.calendar_id && b.calendar_id !== row.calendar_id ? b.calendar_id : row.calendar_id;
  if (target !== row.calendar_id) {
    await requireCalendar(env, user.id, target, true);
    await deleteEvent(env, row.calendar_id, row.href, user.id);
  }
  const res = await putEvent(env, target, row.href, ics, user.id);
  return json({ id: res.id });
}

async function deleteEventApi(env, user, id, url) {
  const { row } = await loadEvent(env, user, id, true);
  const key = occurrenceKey(url.searchParams.get('occurrence'));
  if (key != null) {
    await putEvent(env, row.calendar_id, row.href, excludeOccurrence(row.ics, key), user.id);
    return json({ ok: true });
  }
  await deleteEvent(env, row.calendar_id, row.href, user.id);
  return json({ ok: true });
}

async function searchEvents(env, user, url) {
  const q = str(url.searchParams.get('q'), 100);
  if (q.length < 2) return json([]);
  const cals = await visibleCalendars(env, user.id);
  if (!cals.length) return json([]);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, calendar_id, ics FROM events
      WHERE calendar_id IN (${cals.map(() => '?').join(',')})
        AND (summary LIKE ? ESCAPE '\\' OR ics LIKE ? ESCAPE '\\')
      ORDER BY first_start DESC LIMIT 60`
  ).bind(...cals.map((c) => c.id), like, like).all();
  const now = Date.now();
  const needle = q.toLowerCase();
  const out = [];
  for (const row of results) {
    const occ = occurrences(row.ics, now - 400 * DAY, now + 800 * DAY);
    const hit = (o) => [o.title, o.location, o.notes].some((t) => (t || '').toLowerCase().includes(needle));
    const matches = occ.filter(hit);
    let o = matches.find((x) => Date.parse(x.end) >= now || x.end >= new Date(now).toISOString().slice(0, 10)) || matches[matches.length - 1];
    if (!o) {
      const d = details(row.ics);
      if (!d || !hit(d)) continue;
      o = { ...d, key: Date.parse(d.start), recurring: d.repeat !== 'none' };
    }
    out.push({ id: row.id, calendar_id: row.calendar_id, key: o.key, title: o.title, location: o.location, start: o.start, end: o.end, allDay: o.allDay, recurring: !!o.recurring });
  }
  const iso = new Date(now).toISOString();
  const upcoming = out.filter((o) => o.end >= iso.slice(0, o.allDay ? 10 : 24)).sort((a, b) => (a.start < b.start ? -1 : 1));
  const past = out.filter((o) => !upcoming.includes(o)).sort((a, b) => (a.start > b.start ? -1 : 1));
  return json([...upcoming, ...past].slice(0, 25));
}

// ---------- Abonneren, importeren, back-up ----------

async function getFeed(env, user, calId, url) {
  await requireCalendar(env, user.id, calId);
  const row = await env.DB.prepare('SELECT token FROM feeds WHERE calendar_id = ? AND user_id = ?').bind(calId, user.id).first();
  return json({ url: row ? `${url.origin}/ics/${row.token}.ics` : null });
}

async function newFeed(env, user, calId, url) {
  await requireCalendar(env, user.id, calId);
  const token = randomToken(24);
  await env.DB.prepare(
    'INSERT INTO feeds (token, calendar_id, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (calendar_id, user_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at'
  ).bind(token, calId, user.id, now()).run();
  return json({ url: `${url.origin}/ics/${token}.ics` }, 201);
}

async function removeFeed(env, user, calId) {
  await env.DB.prepare('DELETE FROM feeds WHERE calendar_id = ? AND user_id = ?').bind(calId, user.id).run();
  return json({ ok: true });
}

async function importApi(env, user, calId, request) {
  await requireCalendar(env, user.id, calId, true);
  const b = await body(request);
  if (typeof b.ics !== 'string' || !b.ics.includes('BEGIN:VCALENDAR')) throw new HttpError(400, 'Dit is geen geldig agendabestand (.ics)');
  return json(await importIcs(env, calId, b.ics, user.id));
}

// Een .ics van internet ophalen; de browser splitst en importeert hem daarna in stukjes.
async function fetchIcs(request) {
  const b = await body(request);
  let target;
  try {
    target = new URL(str(b.url, 2000).replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw new HttpError(400, 'Ongeldige link');
  }
  if (!/^https?:$/.test(target.protocol)) throw new HttpError(400, 'Alleen http- of https-links');
  let res;
  try {
    res = await fetch(target, { headers: { accept: 'text/calendar, */*' }, redirect: 'follow' });
  } catch {
    throw new HttpError(502, 'Kon de link niet openen');
  }
  if (!res.ok) throw new HttpError(502, `De link gaf een fout (${res.status})`);
  const text = await res.text();
  if (text.length > 8e6) throw new HttpError(413, 'Dit bestand is te groot (max. 8 MB)');
  if (!text.includes('BEGIN:VCALENDAR')) throw new HttpError(400, 'Op deze link staat geen agenda (.ics)');
  return json({ ics: text });
}

async function exportApi(env, user, url) {
  const calId = url.searchParams.get('calendar');
  const stamp = new Date().toISOString().slice(0, 10);
  if (calId) {
    const cal = await requireCalendar(env, user.id, calId);
    return new Response(await calendarIcs(env, cal), {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': `attachment; filename="${safeFileName(cal.name)} ${stamp}.ics"`,
        'cache-control': 'no-store'
      }
    });
  }
  const cals = await visibleCalendars(env, user.id);
  const files = [];
  const used = new Set();
  for (const c of cals) {
    let name = safeFileName(c.is_owner ? c.name : `${c.name} (${c.owner_name})`);
    while (used.has(name.toLowerCase())) name += '_';
    used.add(name.toLowerCase());
    files.push({ name: `${name}.ics`, text: await calendarIcs(env, c) });
  }
  return new Response(zip(files), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="Agenda back-up ${stamp}.zip"`,
      'cache-control': 'no-store'
    }
  });
}

// ---------- Meldingen voor de app ----------

// Herinneringen voor de komende 48 uur, en wat anderen sinds `since` in gedeelde agenda's veranderden.
async function feed(env, user, url) {
  const t = Date.now();
  const since = Math.max(Number(url.searchParams.get('since')) || t, t - 7 * DAY);
  const cals = await visibleCalendars(env, user.id);
  if (!cals.length) return json({ now: t, reminders: [], changes: [] });
  const ids = cals.map((c) => c.id);
  const calName = new Map(cals.map((c) => [c.id, c.name]));
  const marks = ids.map(() => '?').join(',');

  const reminders = [];
  const { results: rows } = await env.DB.prepare(
    `SELECT id, calendar_id, ics FROM events
      WHERE calendar_id IN (${marks}) AND first_start < ? AND (last_end IS NULL OR last_end > ?)`
  ).bind(...ids, t + 3 * DAY, t - DAY).all();
  for (const row of rows) {
    for (const o of occurrences(row.ics, t - DAY, t + 3 * DAY)) {
      if (o.alarm == null) continue;
      let startMs;
      if (o.allDay) {
        const [y, m, d] = o.start.split('-').map(Number);
        startMs = zonedToUtc(y, m, d, 0, 0, 0, DEFAULT_TZ);
      } else startMs = Date.parse(o.start);
      const at = startMs - o.alarm * 60000;
      if (at < t - 60000 || at > t + 2 * DAY) continue;
      reminders.push({
        key: `${row.id}-${o.key}`,
        at,
        start: startMs,
        allDay: o.allDay,
        title: o.title || '(geen titel)',
        location: o.location,
        calendar: calName.get(row.calendar_id)
      });
    }
  }

  const changes = [];
  const { results: changed } = await env.DB.prepare(
    `SELECT e.id, e.calendar_id, e.summary, e.updated_at AS at, e.created_at, u.full_name AS who
       FROM events e JOIN users u ON u.id = e.updated_by
      WHERE e.calendar_id IN (${marks}) AND e.updated_at > ? AND e.updated_by != ?
      ORDER BY e.updated_at LIMIT 20`
  ).bind(...ids, since, user.id).all();
  for (const c of changed) {
    changes.push({ id: c.id, action: c.created_at === c.at ? 'toegevoegd' : 'gewijzigd', title: c.summary || '(geen titel)', who: c.who, calendar: calName.get(c.calendar_id), at: c.at });
  }
  const { results: removed } = await env.DB.prepare(
    `SELECT tb.calendar_id, tb.summary, tb.deleted_at AS at, u.full_name AS who
       FROM tombstones tb JOIN users u ON u.id = tb.deleted_by
      WHERE tb.calendar_id IN (${marks}) AND tb.deleted_at > ? AND tb.deleted_by != ?
      ORDER BY tb.deleted_at LIMIT 20`
  ).bind(...ids, since, user.id).all();
  for (const c of removed) {
    changes.push({ id: null, action: 'verwijderd', title: c.summary || '(geen titel)', who: c.who, calendar: calName.get(c.calendar_id), at: c.at });
  }
  changes.sort((a, b) => a.at - b.at);
  return json({ now: t, reminders: reminders.sort((a, b) => a.at - b.at), changes });
}

// ---------- Beheer ----------

function requireAdmin(user) {
  if (!user.is_admin) throw new HttpError(403, 'Alleen voor beheerders');
}

async function adminUsers(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, username, full_name, email, status, is_admin, created_at FROM users ORDER BY status = \'pending\' DESC, created_at DESC'
  ).all();
  return json(results);
}

async function adminSetStatus(env, user, id, request) {
  const b = await body(request);
  if (!['active', 'disabled'].includes(b.status)) throw new HttpError(400, 'Ongeldige status');
  if (Number(id) === user.id) throw new HttpError(400, 'Je kunt je eigen account niet uitschakelen');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(b.status, Number(id)),
    ...(b.status === 'disabled' ? [env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(Number(id))] : [])
  ]);
  return json({ ok: true });
}

async function adminDelete(env, user, id) {
  if (Number(id) === user.id) throw new HttpError(400, 'Je kunt je eigen account niet verwijderen');
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(Number(id)).run();
  return json({ ok: true });
}

async function adminResetPassword(env, user, id) {
  const password = randomToken(9);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), Number(id)),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(Number(id))
  ]);
  return json({ password });
}

// ---------- Router ----------

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const m = request.method;
  const p = parts.join('/');

  if (m !== 'GET' && m !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) throw new HttpError(403, 'Ongeldige herkomst');
  }

  if (p === 'register' && m === 'POST') return register(env, request);
  if (p === 'login' && m === 'POST') return login(env, request);
  if (p === 'logout' && m === 'POST') {
    await destroySession(env, request);
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
  }

  const user = await sessionUser(env, request);
  if (!user) throw new HttpError(401, 'Niet ingelogd');

  const [a, b, c, d] = parts;
  if (p === 'me' && m === 'GET') return json({ ...user, is_admin: !!user.is_admin });
  if (p === 'me' && m === 'PATCH') return updateMe(env, user, request);
  if (p === 'me/password' && m === 'POST') return changePassword(env, user, request);

  if (a === 'app-passwords') {
    if (!b && m === 'GET') return listAppPasswords(env, user);
    if (!b && m === 'POST') return createAppPassword(env, user, request);
    if (b && m === 'DELETE') {
      await env.DB.prepare('DELETE FROM app_passwords WHERE id = ? AND user_id = ?').bind(Number(b), user.id).run();
      return json({ ok: true });
    }
  }

  if (a === 'calendars') {
    if (!b && m === 'GET') return listCalendars(env, user);
    if (!b && m === 'POST') return newCalendar(env, user, request);
    if (b && !c && m === 'PATCH') return editCalendar(env, user, b, request);
    if (b && !c && m === 'DELETE') return removeCalendar(env, user, b);
    if (b && c === 'shares' && !d && m === 'POST') return addShare(env, user, b, request);
    if (b && c === 'shares' && d && m === 'DELETE') return removeShare(env, user, b, d);
    if (b && c === 'feed' && m === 'GET') return getFeed(env, user, b, url);
    if (b && c === 'feed' && m === 'POST') return newFeed(env, user, b, url);
    if (b && c === 'feed' && m === 'DELETE') return removeFeed(env, user, b);
    if (b && c === 'import' && m === 'POST') return importApi(env, user, b, request);
  }

  if (p === 'search' && m === 'GET') return searchEvents(env, user, url);
  if (p === 'feed' && m === 'GET') return feed(env, user, url);
  if (p === 'import/fetch' && m === 'POST') return fetchIcs(request);
  if (p === 'export' && m === 'GET') return exportApi(env, user, url);

  if (a === 'events') {
    if (!b && m === 'GET') return listEvents(env, user, url);
    if (!b && m === 'POST') return createEventApi(env, user, request);
    if (b && m === 'GET') return getEventDetails(env, user, b, url);
    if (b && m === 'PATCH') return updateEventApi(env, user, b, request);
    if (b && m === 'DELETE') return deleteEventApi(env, user, b, url);
  }

  if (a === 'admin') {
    requireAdmin(user);
    if (b === 'users' && !c && m === 'GET') return adminUsers(env);
    if (b === 'users' && c && !d && m === 'PATCH') return adminSetStatus(env, user, c, request);
    if (b === 'users' && c && !d && m === 'DELETE') return adminDelete(env, user, c);
    if (b === 'users' && c && d === 'reset-password' && m === 'POST') return adminResetPassword(env, user, c);
  }

  throw new HttpError(404, 'Niet gevonden');
}

export async function onRequest({ request, env }) {
  try {
    return await route(request, env);
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message);
    console.error(err);
    return fail(500, 'Er ging iets mis op de server');
  }
}
