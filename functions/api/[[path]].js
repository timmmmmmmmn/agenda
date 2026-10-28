// JSON-API voor de webinterface: /api/...

import {
  HttpError, json, fail, now, hashPassword, verifyPassword, createSession, destroySession,
  clearSessionCookie, sessionUser, tooManyAttempts, recordAttempt, clientIp, newAppPassword,
  normalizeAppPassword, sha256hex, randomToken
} from '../_lib/util.js';
import { occurrences, details, buildEvent, patchEvent } from '../_lib/ical.js';
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
  return {
    title: str(b.title, 200) || 'Nieuwe afspraak',
    location: str(b.location, 300),
    notes: str(b.notes, 5000),
    allDay,
    start: b.start,
    end,
    tz: str(b.tz, 64) || undefined,
    repeat: ['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom'].includes(b.repeat) ? b.repeat : 'none',
    alarm: b.alarm === undefined ? undefined : (b.alarm === null || b.alarm === 'none' ? 'none' : Number(b.alarm))
  };
}

async function getEventDetails(env, user, id) {
  const { row, cal } = await loadEvent(env, user, id, false);
  return json({ id: row.id, calendar_id: row.calendar_id, can_write: !!cal.can_write, ...details(row.ics) });
}

async function createEventApi(env, user, request) {
  const b = await body(request);
  await requireCalendar(env, user.id, b.calendar_id, true);
  const uid = crypto.randomUUID();
  const ics = buildEvent(uid, eventFields(b));
  const { id } = await putEvent(env, b.calendar_id, `${uid}.ics`, ics);
  return json({ id }, 201);
}

async function updateEventApi(env, user, id, request) {
  const { row } = await loadEvent(env, user, id, true);
  const b = await body(request);
  const ics = patchEvent(row.ics, eventFields(b));
  const target = b.calendar_id && b.calendar_id !== row.calendar_id ? b.calendar_id : row.calendar_id;
  if (target !== row.calendar_id) {
    await requireCalendar(env, user.id, target, true);
    await deleteEvent(env, row.calendar_id, row.href);
  }
  const res = await putEvent(env, target, row.href, ics);
  return json({ id: res.id });
}

async function deleteEventApi(env, user, id) {
  const { row } = await loadEvent(env, user, id, true);
  await deleteEvent(env, row.calendar_id, row.href);
  return json({ ok: true });
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
  }

  if (a === 'events') {
    if (!b && m === 'GET') return listEvents(env, user, url);
    if (!b && m === 'POST') return createEventApi(env, user, request);
    if (b && m === 'GET') return getEventDetails(env, user, b);
    if (b && m === 'PATCH') return updateEventApi(env, user, b, request);
    if (b && m === 'DELETE') return deleteEventApi(env, user, b);
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
