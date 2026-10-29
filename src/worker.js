// Ingang als Cloudflare Worker: routeert naar de API, CalDAV of de statische bestanden in public/.
import { onRequest as api } from '../functions/api/[[path]].js';
import { handleDav } from '../functions/_lib/dav.js';
import { calendarIcs } from '../functions/_lib/export.js';
import { calendarAccess } from '../functions/_lib/store.js';

// Geheime abonneer-link: /ics/<token>.ics (alleen lezen, voor Google Agenda, Outlook enz.)
async function feed(env, token) {
  const row = await env.DB.prepare(
    "SELECT f.calendar_id, f.user_id FROM feeds f JOIN users u ON u.id = f.user_id WHERE f.token = ? AND u.status = 'active'"
  ).bind(token).first();
  const cal = row && (await calendarAccess(env, row.user_id, row.calendar_id));
  if (!cal) return new Response('Niet gevonden', { status: 404 });
  return new Response(await calendarIcs(env, cal), {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300' }
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
    if (p === '/.well-known/caldav' || p === '/.well-known/caldav/') {
      return new Response(null, { status: 301, headers: { location: '/dav/' } });
    }
    // Sommige CalDAV-clients doen eerst een PROPFIND op "/".
    if (p === '/' && m !== 'GET' && m !== 'HEAD') return handleDav(request, env);

    return env.ASSETS.fetch(request);
  }
};
