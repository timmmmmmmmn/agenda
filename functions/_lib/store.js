// Database-toegang voor agenda's en afspraken, gedeeld door de API en CalDAV.
// Elke wijziging verhoogt de sync_token van de agenda; afspraken krijgen die
// waarde als modseq zodat apparaten precies kunnen opvragen wat er veranderd is.

import { summarize } from './ical.js';
import { HttpError, now, sha256hex } from './util.js';

export async function visibleCalendars(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.color, c.sort_order, c.sync_token, c.owner_id,
            u.username AS owner_username, u.full_name AS owner_name,
            1 AS is_owner, 1 AS can_write
       FROM calendars c JOIN users u ON u.id = c.owner_id
      WHERE c.owner_id = ?1
     UNION ALL
     SELECT c.id, c.name, c.color, c.sort_order, c.sync_token, c.owner_id,
            u.username, u.full_name, 0, s.can_write
       FROM calendar_shares s
       JOIN calendars c ON c.id = s.calendar_id
       JOIN users u ON u.id = c.owner_id
      WHERE s.user_id = ?1 AND u.status = 'active'
     ORDER BY is_owner DESC, sort_order, name`
  ).bind(userId).all();
  return results;
}

export async function calendarAccess(env, userId, calId) {
  const row = await env.DB.prepare(
    `SELECT c.*, CASE WHEN c.owner_id = ?1 THEN 1 ELSE 0 END AS is_owner,
            CASE WHEN c.owner_id = ?1 THEN 1 ELSE s.can_write END AS can_write
       FROM calendars c
       LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ?1
      WHERE c.id = ?2 AND (c.owner_id = ?1 OR s.user_id IS NOT NULL)`
  ).bind(userId, calId).first();
  return row || null;
}

export async function requireCalendar(env, userId, calId, write = false) {
  const cal = await calendarAccess(env, userId, calId);
  if (!cal) throw new HttpError(404, 'Agenda niet gevonden');
  if (write && !cal.can_write) throw new HttpError(403, 'Je mag deze agenda alleen bekijken');
  return cal;
}

export async function createCalendar(env, ownerId, { id, name, color }) {
  const order = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM calendars WHERE owner_id = ?').bind(ownerId).first();
  const calId = id || crypto.randomUUID();
  await env.DB.prepare('INSERT INTO calendars (id, owner_id, name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(calId, ownerId, name, color || '#2F6FED', order.n, now())
    .run();
  return calId;
}

export async function etagFor(ics) {
  return `"${(await sha256hex(ics)).slice(0, 32)}"`;
}

export async function getEvent(env, calId, href) {
  return env.DB.prepare('SELECT * FROM events WHERE calendar_id = ? AND href = ?').bind(calId, href).first();
}

export async function putEvent(env, calId, href, ics, userId = null) {
  const s = summarize(ics);
  if (!s || !s.uid) throw new HttpError(400, 'Ongeldige afspraak (geen VEVENT of UID)');
  const etag = await etagFor(ics);
  const t = now();
  const res = await env.DB.batch([
    env.DB.prepare('UPDATE calendars SET sync_token = sync_token + 1 WHERE id = ?').bind(calId),
    env.DB.prepare(
      `INSERT INTO events (calendar_id, href, uid, ics, etag, summary, first_start, last_end, recurring, modseq, updated_at, created_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, (SELECT sync_token FROM calendars WHERE id = ?1), ?10, ?10, ?11)
       ON CONFLICT (calendar_id, href) DO UPDATE SET
         uid = excluded.uid, ics = excluded.ics, etag = excluded.etag, summary = excluded.summary,
         first_start = excluded.first_start, last_end = excluded.last_end, recurring = excluded.recurring,
         modseq = excluded.modseq, updated_at = excluded.updated_at, updated_by = excluded.updated_by
       RETURNING id`
    ).bind(calId, href, s.uid, ics, etag, s.summary, s.firstStart, s.lastEnd, s.recurring, t, userId),
    env.DB.prepare('DELETE FROM tombstones WHERE calendar_id = ? AND href = ?').bind(calId, href)
  ]);
  return { etag, id: res[1].results[0].id };
}

export async function deleteEvent(env, calId, href, userId = null) {
  await env.DB.batch([
    env.DB.prepare('UPDATE calendars SET sync_token = sync_token + 1 WHERE id = ?').bind(calId),
    env.DB.prepare(
      `INSERT INTO tombstones (calendar_id, href, modseq, summary, deleted_by, deleted_at)
       VALUES (?1, ?2, (SELECT sync_token FROM calendars WHERE id = ?1),
               (SELECT summary FROM events WHERE calendar_id = ?1 AND href = ?2), ?3, ?4)
       ON CONFLICT (calendar_id, href) DO UPDATE SET modseq = excluded.modseq, summary = excluded.summary,
         deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at`
    ).bind(calId, href, userId, now()),
    env.DB.prepare('DELETE FROM events WHERE calendar_id = ? AND href = ?').bind(calId, href)
  ]);
}
