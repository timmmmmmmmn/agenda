// Ingang als Cloudflare Worker: routeert naar de API, CalDAV of de statische bestanden in public/.
import { onRequest as api } from '../functions/api/[[path]].js';
import { handleDav } from '../functions/_lib/dav.js';
import { calendarIcs } from '../functions/_lib/export.js';
import { calendarAccess } from '../functions/_lib/store.js';
import { occurrences } from '../functions/_lib/ical.js';

const DAY = 86400000;

// Geheime abonneer-link: /ics/<token>.ics (alleen lezen, voor Google Agenda, Outlook enz.)
async function feedCalendar(env, token) {
  const row = await env.DB.prepare(
    "SELECT f.calendar_id, f.user_id FROM feeds f JOIN users u ON u.id = f.user_id WHERE f.token = ? AND u.status = 'active'"
  ).bind(token).first();
  return row && (await calendarAccess(env, row.user_id, row.calendar_id));
}

async function feed(env, token) {
  const cal = await feedCalendar(env, token);
  if (!cal) return new Response('Niet gevonden', { status: 404 });
  return new Response(await calendarIcs(env, cal), {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300' }
  });
}

// Zelfde geheime link als JSON met herhalingen uitgerekend: /ics/<token>.json?dagen=7 (voor de TV-launcher)
async function feedJson(env, token, url) {
  const cal = await feedCalendar(env, token);
  if (!cal) return new Response('Niet gevonden', { status: 404 });
  const dagen = Math.min(Math.max(Number(url.searchParams.get('dagen')) || 7, 1), 60);
  const from = Date.now() - DAY;
  const to = from + (dagen + 1) * DAY;
  const { results } = await env.DB.prepare(
    'SELECT ics FROM events WHERE calendar_id = ? AND first_start < ? AND (last_end IS NULL OR last_end > ?)'
  ).bind(cal.id, to, from).all();
  const out = [];
  for (const row of results) {
    for (const o of occurrences(row.ics, from, to)) {
      out.push({ start: o.start, end: o.end, allDay: o.allDay, title: o.title, location: o.location });
    }
  }
  out.sort((a, b) => (a.start < b.start ? -1 : 1));
  return new Response(JSON.stringify({ name: cal.name, color: cal.color, events: out }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=60' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method.toUpperCase();

    if (p === '/api' || p.startsWith('/api/')) return api({ request, env });
    if (p === '/dav' || p.startsWith('/dav/')) return handleDav(request, env);
    const ics = p.match(/^\/ics\/([A-Za-z0-9_-]{20,64})\.ics$/);
    if (ics && (m === 'GET' || m === 'HEAD')) return feed(env, ics[1]);
    const feedJ = p.match(/^\/ics\/([A-Za-z0-9_-]{20,64})\.json$/);
    if (feedJ && (m === 'GET' || m === 'HEAD')) return feedJson(env, feedJ[1], url);
    if (p === '/.well-known/caldav' || p === '/.well-known/caldav/') {
      return new Response(null, { status: 301, headers: { location: '/dav/' } });
    }
    // Sommige CalDAV-clients doen eerst een PROPFIND op "/".
    if (p === '/' && m !== 'GET' && m !== 'HEAD') return handleDav(request, env);

    return env.ASSETS.fetch(request);
  }
};
