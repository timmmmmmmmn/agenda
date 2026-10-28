// Ingang als Cloudflare Worker: routeert naar de API, CalDAV of de statische bestanden in public/.
import { onRequest as api } from '../functions/api/[[path]].js';
import { handleDav } from '../functions/_lib/dav.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method.toUpperCase();

    if (p === '/api' || p.startsWith('/api/')) return api({ request, env });
    if (p === '/dav' || p.startsWith('/dav/')) return handleDav(request, env);
    if (p === '/.well-known/caldav' || p === '/.well-known/caldav/') {
      return new Response(null, { status: 301, headers: { location: '/dav/' } });
    }
    // Sommige CalDAV-clients doen eerst een PROPFIND op "/".
    if (p === '/' && m !== 'GET' && m !== 'HEAD') return handleDav(request, env);

    return env.ASSETS.fetch(request);
  }
};
