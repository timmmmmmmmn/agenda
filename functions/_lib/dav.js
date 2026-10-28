// CalDAV-server (RFC 4791 + sync-collection uit RFC 6578), genoeg voor
// Apple Agenda (macOS/iOS) en DAVx⁵ (Android → Samsung Agenda).
//
// Indeling:
//   /dav/                                  root
//   /dav/principals/<user>/                principal
//   /dav/calendars/<user>/                 calendar home (alle zichtbare agenda's)
//   /dav/calendars/<user>/<agenda-id>/     agenda
//   /dav/calendars/<user>/<agenda-id>/<x>.ics   afspraak

import { HttpError, now, sha256hex, normalizeAppPassword, tooManyAttempts, recordAttempt, clientIp } from './util.js';
import { readEvents } from './ical.js';
import { visibleCalendars, calendarAccess, createCalendar, getEvent, putEvent, deleteEvent } from './store.js';

const NS = {
  D: 'DAV:',
  C: 'urn:ietf:params:xml:ns:caldav',
  CS: 'http://calendarserver.org/ns/',
  A: 'http://apple.com/ns/ical/'
};
const PREFIX = Object.fromEntries(Object.entries(NS).map(([p, u]) => [u, p]));
const SYNC_PREFIX = 'https://agenda.timvanbergen.nl/ns/sync/';
const DAV_HEADER = '1, 3, calendar-access';
const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR, MKCOL';

// ---------- Kleine XML-parser ----------

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
  });
}

export function parseXml(text) {
  const root = { ns: '', local: '#root', attrs: {}, children: [], text: '' };
  const stack = [{ el: root, scope: { xml: 'http://www.w3.org/XML/1998/namespace' } }];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s\/>]+)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.el.text += m[1];
    else if (m[6] !== undefined) top.el.text += decodeEntities(m[6]);
    else if (m[3]) {
      if (m[2] === '/') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const scope = { ...top.scope };
      const attrs = {};
      const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ''))) {
        const val = decodeEntities(a[2] ?? a[3]);
        if (a[1] === 'xmlns') scope[''] = val;
        else if (a[1].startsWith('xmlns:')) scope[a[1].slice(6)] = val;
        else attrs[a[1].includes(':') ? a[1].split(':')[1] : a[1]] = val;
      }
      const [pfx, local] = m[3].includes(':') ? m[3].split(':') : ['', m[3]];
      const el = { ns: scope[pfx] ?? '', local, attrs, children: [], text: '' };
      top.el.children.push(el);
      if (m[5] !== '/') stack.push({ el, scope });
    }
  }
  return root.children[0] || null;
}

const clark = (el) => `{${el.ns}}${el.local}`;
const child = (el, ns, local) => el?.children.find((c) => c.ns === ns && c.local === local) || null;
const children = (el, ns, local) => el?.children.filter((c) => c.ns === ns && c.local === local) || [];

function descendants(el, ns, local, out = []) {
  for (const c of el?.children || []) {
    if (c.ns === ns && c.local === local) out.push(c);
    descendants(c, ns, local, out);
  }
  return out;
}

// ---------- XML schrijven ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tag(clarkName, inner) {
  const [, ns, local] = clarkName.match(/^\{(.*)\}(.+)$/);
  const p = PREFIX[ns];
  if (p) return inner == null || inner === '' ? `<${p}:${local}/>` : `<${p}:${local}>${inner}</${p}:${local}>`;
  return inner == null || inner === '' ? `<x:${local} xmlns:x="${esc(ns)}"/>` : `<x:${local} xmlns:x="${esc(ns)}">${inner}</x:${local}>`;
}

const href = (h) => `<D:href>${esc(h)}</D:href>`;

function responseXml(path, found, missing, forbidden = []) {
  let x = `<D:response>${href(path)}`;
  if (found.length) x += `<D:propstat><D:prop>${found.map(([k, v]) => tag(k, v)).join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;
  if (forbidden.length) x += `<D:propstat><D:prop>${forbidden.map((k) => tag(k)).join('')}</D:prop><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat>`;
  if (missing.length) x += `<D:propstat><D:prop>${missing.map((k) => tag(k)).join('')}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`;
  return x + '</D:response>';
}

function multistatus(inner, extra = '') {
  const ns = Object.entries(NS).map(([p, u]) => `xmlns:${p}="${u}"`).join(' ');
  return xmlResponse(207, `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${ns}>${inner}${extra}</D:multistatus>`);
}

function xmlResponse(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8', dav: DAV_HEADER, ...headers }
  });
}

function davError(status, condition) {
  return xmlResponse(status, `<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:" xmlns:C="${NS.C}">${condition}</D:error>`);
}

const plain = (status, text = '', headers = {}) => new Response(text, { status, headers: { dav: DAV_HEADER, ...headers } });

// ---------- Paden ----------

const enc = encodeURIComponent;
const P = {
  principal: (u) => `/dav/principals/${enc(u)}/`,
  home: (u) => `/dav/calendars/${enc(u)}/`,
  calendar: (u, id) => `/dav/calendars/${enc(u)}/${enc(id)}/`,
  object: (u, id, name) => `/dav/calendars/${enc(u)}/${enc(id)}/${enc(name)}`
};

function parsePath(pathname) {
  let p = pathname;
  if (p.startsWith('/dav')) p = p.slice(4);
  const segs = p.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (!segs.length) return { kind: 'root' };
  if (segs[0] === 'principals') {
    if (segs.length === 1) return { kind: 'principals' };
    if (segs.length === 2) return { kind: 'principal', user: segs[1] };
  }
  if (segs[0] === 'calendars') {
    if (segs.length === 1) return { kind: 'calendars' };
    if (segs.length === 2) return { kind: 'home', user: segs[1] };
    if (segs.length === 3) return { kind: 'calendar', user: segs[1], cal: segs[2] };
    if (segs.length === 4) return { kind: 'object', user: segs[1], cal: segs[2], name: segs[3] };
  }
  return { kind: 'unknown' };
}

// ---------- Authenticatie ----------

async function authenticate(env, request) {
  const h = request.headers.get('authorization') || '';
  if (!h.toLowerCase().startsWith('basic ')) return null;
  let decoded;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(h.slice(6).trim()), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const username = decoded.slice(0, i).trim().toLowerCase();
  const secret = normalizeAppPassword(decoded.slice(i + 1));
  const ip = clientIp(request);
  if (await tooManyAttempts(env, `dav|${ip}`, 30, 900e3)) throw new HttpError(429, 'Te veel pogingen');
  const user = await env.DB.prepare("SELECT id, username, full_name, email FROM users WHERE username = ? AND status = 'active'").bind(username).first();
  const ap = user && await env.DB.prepare('SELECT id, last_used_at FROM app_passwords WHERE user_id = ? AND secret_hash = ?')
    .bind(user.id, await sha256hex(secret)).first();
  if (!ap) {
    await recordAttempt(env, `dav|${ip}`);
    return null;
  }
  if (!ap.last_used_at || now() - ap.last_used_at > 300e3) {
    await env.DB.prepare('UPDATE app_passwords SET last_used_at = ? WHERE id = ?').bind(now(), ap.id).run();
  }
  return user;
}

function unauthorized() {
  return plain(401, 'Inloggen vereist', { 'www-authenticate': 'Basic realm="Agenda timvanbergen.nl", charset="UTF-8"' });
}

// ---------- Eigenschappen ----------

const K = (p, local) => `{${NS[p]}}${local}`;

function privileges(write) {
  const list = ['read', 'read-current-user-privilege-set'];
  if (write) list.push('write', 'write-properties', 'write-content', 'bind', 'unbind');
  return list.map((p) => `<D:privilege><D:${p}/></D:privilege>`).join('');
}

const REPORTS = ['C:calendar-multiget', 'C:calendar-query', 'D:sync-collection']
  .map((r) => `<D:supported-report><D:report><${r}/></D:report></D:supported-report>`).join('');

function commonProps(user) {
  return {
    [K('D', 'current-user-principal')]: href(P.principal(user.username)),
    [K('D', 'principal-collection-set')]: href('/dav/principals/')
  };
}

function rootProps(user, displayname = 'Agenda') {
  return {
    ...commonProps(user),
    [K('D', 'resourcetype')]: '<D:collection/>',
    [K('D', 'displayname')]: esc(displayname),
    [K('C', 'calendar-home-set')]: href(P.home(user.username)),
    [K('D', 'current-user-privilege-set')]: privileges(false)
  };
}

function principalProps(user) {
  return {
    ...commonProps(user),
    [K('D', 'resourcetype')]: '<D:collection/><D:principal/>',
    [K('D', 'displayname')]: esc(user.full_name),
    [K('D', 'principal-URL')]: href(P.principal(user.username)),
    [K('D', 'owner')]: href(P.principal(user.username)),
    [K('C', 'calendar-home-set')]: href(P.home(user.username)),
    [K('C', 'calendar-user-address-set')]: href(`mailto:${user.email}`) + href(P.principal(user.username)),
    [K('D', 'current-user-privilege-set')]: privileges(false),
    [K('D', 'supported-report-set')]: ''
  };
}

function homeProps(user) {
  return {
    ...commonProps(user),
    [K('D', 'resourcetype')]: '<D:collection/>',
    [K('D', 'displayname')]: esc(user.full_name),
    [K('D', 'owner')]: href(P.principal(user.username)),
    [K('D', 'current-user-privilege-set')]: privileges(true),
    [K('D', 'supported-report-set')]: REPORTS
  };
}

function calendarProps(user, cal) {
  const name = cal.is_owner ? cal.name : `${cal.name} (${cal.owner_name || 'gedeeld'})`;
  return {
    ...commonProps(user),
    [K('D', 'resourcetype')]: '<D:collection/><C:calendar/>',
    [K('D', 'displayname')]: esc(name),
    [K('D', 'owner')]: href(P.principal(cal.owner_username || user.username)),
    [K('A', 'calendar-color')]: `${cal.color}FF`,
    [K('A', 'calendar-order')]: String(cal.sort_order || 0),
    [K('C', 'supported-calendar-component-set')]: '<C:comp name="VEVENT"/>',
    [K('C', 'supported-calendar-data')]: '<C:calendar-data content-type="text/calendar" version="2.0"/>',
    [K('C', 'max-resource-size')]: '1000000',
    [K('CS', 'getctag')]: String(cal.sync_token),
    [K('D', 'sync-token')]: SYNC_PREFIX + cal.sync_token,
    [K('D', 'current-user-privilege-set')]: privileges(!!cal.can_write),
    [K('D', 'supported-report-set')]: REPORTS
  };
}

function objectProps(user, ev, withData) {
  const props = {
    ...commonProps(user),
    [K('D', 'resourcetype')]: '',
    [K('D', 'getetag')]: esc(ev.etag),
    [K('D', 'getcontenttype')]: 'text/calendar; charset=utf-8; component=vevent',
    [K('D', 'getlastmodified')]: new Date(ev.updated_at).toUTCString()
  };
  if (ev.ics != null) {
    props[K('D', 'getcontentlength')]= String(new TextEncoder().encode(ev.ics).length);
    if (withData) props[K('C', 'calendar-data')] = esc(ev.ics);
  }
  return props;
}

// Kiest uit de beschikbare props wat er gevraagd is.
function select(available, requested, path) {
  if (!requested) {
    const found = Object.entries(available).filter(([k]) => k !== K('C', 'calendar-data'));
    return responseXml(path, found, []);
  }
  const found = [];
  const missing = [];
  for (const k of requested) {
    if (k in available) found.push([k, available[k]]);
    else missing.push(k);
  }
  return responseXml(path, found, missing);
}

function requestedProps(doc) {
  const prop = child(doc, NS.D, 'prop');
  if (!prop) return null; // allprop / propname / lege body
  return prop.children.map(clark);
}

// ---------- Hulp: agenda's van de gebruiker ----------

async function calendarFor(env, user, path) {
  if (path.user !== user.username) return null;
  const cal = await calendarAccess(env, user.id, path.cal);
  if (!cal) return null;
  if (!cal.is_owner) {
    const owner = await env.DB.prepare('SELECT username, full_name FROM users WHERE id = ?').bind(cal.owner_id).first();
    cal.owner_username = owner?.username;
    cal.owner_name = owner?.full_name;
  }
  return cal;
}

async function readBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 1_000_000) throw new HttpError(413, 'Te groot');
  const text = await request.text();
  if (text.length > 1_000_000) throw new HttpError(413, 'Te groot');
  return text;
}

// ---------- Methoden ----------

async function propfind(env, request, user, path) {
  const text = await readBody(request);
  const doc = text.trim() ? parseXml(text) : null;
  const requested = doc ? requestedProps(doc) : null;
  const depth = (request.headers.get('depth') ?? '1') === '0' ? 0 : 1;
  const wantsData = requested?.includes(K('C', 'calendar-data'));
  const self = new URL(request.url).pathname;
  const out = [];

  switch (path.kind) {
    case 'root':
    case 'principals':
    case 'calendars':
      out.push(select(rootProps(user), requested, self.endsWith('/') ? self : `${self}/`));
      if (depth && path.kind === 'principals') out.push(select(principalProps(user), requested, P.principal(user.username)));
      if (depth && path.kind === 'calendars') out.push(select(homeProps(user), requested, P.home(user.username)));
      break;
    case 'principal':
      if (path.user !== user.username) return plain(404);
      out.push(select(principalProps(user), requested, P.principal(user.username)));
      break;
    case 'home': {
      if (path.user !== user.username) return plain(404);
      out.push(select(homeProps(user), requested, P.home(user.username)));
      if (depth) {
        for (const c of await visibleCalendars(env, user.id)) {
          out.push(select(calendarProps(user, c), requested, P.calendar(user.username, c.id)));
        }
      }
      break;
    }
    case 'calendar': {
      const cal = await calendarFor(env, user, path);
      if (!cal) return plain(404);
      out.push(select(calendarProps(user, cal), requested, P.calendar(user.username, cal.id)));
      if (depth) {
        const cols = wantsData ? '*' : 'href, etag, updated_at, ics';
        const { results } = await env.DB.prepare(`SELECT ${cols} FROM events WHERE calendar_id = ?`).bind(cal.id).all();
        for (const ev of results) out.push(select(objectProps(user, ev, wantsData), requested, P.object(user.username, cal.id, ev.href)));
      }
      break;
    }
    case 'object': {
      const cal = await calendarFor(env, user, path);
      const ev = cal && await getEvent(env, cal.id, path.name);
      if (!ev) return plain(404);
      out.push(select(objectProps(user, ev, wantsData), requested, P.object(user.username, cal.id, ev.href)));
      break;
    }
    default:
      return plain(404);
  }
  return multistatus(out.join(''));
}

function parseUtc(v) {
  const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

async function report(env, request, user, path) {
  const doc = parseXml(await readBody(request));
  if (!doc) return plain(400, 'Lege REPORT');
  const requested = requestedProps(doc);

  if (doc.ns === NS.D && doc.local === 'principal-search-property-set') {
    return xmlResponse(200, '<?xml version="1.0" encoding="utf-8"?>\n<D:principal-search-property-set xmlns:D="DAV:"/>');
  }
  if (doc.ns === NS.D && (doc.local === 'principal-property-search' || doc.local === 'expand-property')) {
    return multistatus('');
  }
  if (path.kind !== 'calendar') return plain(403, 'REPORT alleen op agenda\'s');

  const cal = await calendarFor(env, user, path);
  if (!cal) return plain(404);
  const objHref = (h) => P.object(user.username, cal.id, h);

  if (doc.ns === NS.C && doc.local === 'calendar-multiget') {
    const names = children(doc, NS.D, 'href').map((h) => {
      const raw = h.text.trim();
      let p = raw;
      try {
        p = new URL(raw, request.url).pathname;
      } catch {}
      const seg = p.split('/').filter(Boolean).pop() || '';
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    });
    const out = [];
    for (const name of names) {
      const ev = await getEvent(env, cal.id, name);
      if (ev) out.push(select(objectProps(user, ev, true), requested, objHref(ev.href)));
      else out.push(`<D:response>${href(objHref(name))}<D:status>HTTP/1.1 404 Not Found</D:status></D:response>`);
    }
    return multistatus(out.join(''));
  }

  if (doc.ns === NS.C && doc.local === 'calendar-query') {
    const range = descendants(doc, NS.C, 'time-range')[0];
    const start = range ? parseUtc(range.attrs.start) : null;
    const end = range ? parseUtc(range.attrs.end) : null;
    const compFilters = descendants(doc, NS.C, 'comp-filter').map((c) => (c.attrs.name || '').toUpperCase());
    if (compFilters.includes('VTODO') && !compFilters.includes('VEVENT')) return multistatus('');
    let sql = 'SELECT * FROM events WHERE calendar_id = ?';
    const args = [cal.id];
    if (end != null) { sql += ' AND first_start < ?'; args.push(end); }
    if (start != null) { sql += ' AND (last_end IS NULL OR last_end > ?)'; args.push(start); }
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    const wantsData = requested?.includes(K('C', 'calendar-data'));
    return multistatus(results.map((ev) => select(objectProps(user, ev, wantsData), requested, objHref(ev.href))).join(''));
  }

  if (doc.ns === NS.D && doc.local === 'sync-collection') {
    const tokenText = (child(doc, NS.D, 'sync-token')?.text || '').trim();
    let since = 0;
    if (tokenText) {
      const m = tokenText.match(/\/(\d+)$/);
      if (!tokenText.startsWith(SYNC_PREFIX) || !m || Number(m[1]) > cal.sync_token) {
        return davError(403, '<D:valid-sync-token/>');
      }
      since = Number(m[1]);
    }
    const wantsData = requested?.includes(K('C', 'calendar-data'));
    const cols = wantsData ? '*' : 'href, etag, updated_at, ics';
    const { results } = await env.DB.prepare(`SELECT ${cols} FROM events WHERE calendar_id = ? AND modseq > ?`).bind(cal.id, since).all();
    const out = results.map((ev) => select(objectProps(user, ev, wantsData), requested, objHref(ev.href)));
    if (since) {
      const gone = await env.DB.prepare('SELECT href FROM tombstones WHERE calendar_id = ? AND modseq > ?').bind(cal.id, since).all();
      for (const t of gone.results) out.push(`<D:response>${href(objHref(t.href))}<D:status>HTTP/1.1 404 Not Found</D:status></D:response>`);
    }
    return multistatus(out.join(''), `<D:sync-token>${SYNC_PREFIX}${cal.sync_token}</D:sync-token>`);
  }

  return plain(501, 'REPORT niet ondersteund');
}

async function getObject(env, request, user, path, head) {
  if (path.kind !== 'object') {
    return plain(200, head ? '' : 'CalDAV-server van agenda.timvanbergen.nl', { 'content-type': 'text/plain; charset=utf-8' });
  }
  const cal = await calendarFor(env, user, path);
  const ev = cal && await getEvent(env, cal.id, path.name);
  if (!ev) return plain(404);
  return plain(200, head ? null : ev.ics, {
    'content-type': 'text/calendar; charset=utf-8',
    etag: ev.etag,
    'last-modified': new Date(ev.updated_at).toUTCString()
  });
}

function etagMatches(header, etag) {
  return header.split(',').map((s) => s.trim().replace(/^W\//, '')).some((t) => t === '*' || t === etag);
}

async function put(env, request, user, path) {
  if (path.kind !== 'object') return plain(405);
  const cal = await calendarFor(env, user, path);
  if (!cal) return plain(404);
  if (!cal.can_write) return davError(403, '<D:need-privileges/>');
  const text = await readBody(request);
  const parsed = readEvents(text);
  if (!parsed) return davError(403, '<C:supported-calendar-component/>');
  const existing = await getEvent(env, cal.id, path.name);
  const ifMatch = request.headers.get('if-match');
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && existing && etagMatches(ifNoneMatch, existing.etag)) return plain(412);
  if (ifMatch && (!existing || !etagMatches(ifMatch, existing.etag))) return plain(412);
  const { etag } = await putEvent(env, cal.id, path.name, text);
  return plain(existing ? 204 : 201, null, { etag });
}

async function del(env, request, user, path) {
  if (path.kind === 'object') {
    const cal = await calendarFor(env, user, path);
    if (!cal) return plain(404);
    if (!cal.can_write) return plain(403);
    const ev = await getEvent(env, cal.id, path.name);
    if (!ev) return plain(404);
    const ifMatch = request.headers.get('if-match');
    if (ifMatch && !etagMatches(ifMatch, ev.etag)) return plain(412);
    await deleteEvent(env, cal.id, path.name);
    return plain(204);
  }
  if (path.kind === 'calendar') {
    const cal = await calendarFor(env, user, path);
    if (!cal) return plain(404);
    if (cal.is_owner) {
      const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM calendars WHERE owner_id = ?').bind(user.id).first();
      if (n <= 1) return plain(403, 'Je moet minstens één agenda houden');
      await env.DB.prepare('DELETE FROM calendars WHERE id = ?').bind(cal.id).run();
    } else {
      await env.DB.prepare('DELETE FROM calendar_shares WHERE calendar_id = ? AND user_id = ?').bind(cal.id, user.id).run();
    }
    return plain(204);
  }
  return plain(403);
}

function propValues(doc) {
  const out = {};
  for (const set of children(doc, NS.D, 'set')) {
    for (const p of child(set, NS.D, 'prop')?.children || []) out[clark(p)] = p.text.trim();
  }
  return out;
}

function normalizeColor(c) {
  const m = String(c || '').match(/^#?([0-9a-fA-F]{6})/);
  return m ? `#${m[1].toUpperCase()}` : null;
}

async function mkcalendar(env, request, user, path) {
  if (path.kind !== 'calendar' || path.user !== user.username) return plain(403);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(path.cal)) return plain(403, 'Ongeldige naam');
  const exists = await env.DB.prepare('SELECT id FROM calendars WHERE id = ?').bind(path.cal).first();
  if (exists) return davError(405, '<D:resource-must-be-null/>');
  const text = await readBody(request);
  const doc = text.trim() ? parseXml(text) : null;
  const props = doc ? propValues(doc) : {};
  const comps = doc ? descendants(doc, NS.C, 'comp').map((c) => (c.attrs.name || '').toUpperCase()) : [];
  if (comps.length && !comps.includes('VEVENT')) return davError(403, '<C:supported-calendar-component/>');
  await createCalendar(env, user.id, {
    id: path.cal,
    name: (props[K('D', 'displayname')] || 'Nieuwe agenda').slice(0, 60),
    color: normalizeColor(props[K('A', 'calendar-color')]) || '#2F6FED'
  });
  return plain(201);
}

async function proppatch(env, request, user, path) {
  const doc = parseXml(await readBody(request));
  if (!doc) return plain(400);
  const keys = [...children(doc, NS.D, 'set'), ...children(doc, NS.D, 'remove')]
    .flatMap((s) => child(s, NS.D, 'prop')?.children.map(clark) || []);
  const self = new URL(request.url).pathname;
  if (path.kind !== 'calendar') return multistatus(responseXml(self, keys.map((k) => [k, '']), []));
  const cal = await calendarFor(env, user, path);
  if (!cal) return plain(404);
  if (!cal.is_owner) return multistatus(responseXml(self, [], [], keys));
  const v = propValues(doc);
  const name = v[K('D', 'displayname')];
  const color = normalizeColor(v[K('A', 'calendar-color')]);
  const order = v[K('A', 'calendar-order')];
  await env.DB.prepare('UPDATE calendars SET name = ?, color = ?, sort_order = ?, sync_token = sync_token + 1 WHERE id = ?')
    .bind(name ? name.slice(0, 60) : cal.name, color || cal.color, Number.isFinite(Number(order)) && order !== undefined ? Number(order) : cal.sort_order, cal.id)
    .run();
  return multistatus(responseXml(self, keys.map((k) => [k, '']), []));
}

// ---------- Ingang ----------

export async function handleDav(request, env) {
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return plain(200, null, { allow: ALLOW });
  try {
    const user = await authenticate(env, request);
    if (!user) return unauthorized();
    const path = parsePath(new URL(request.url).pathname);
    switch (method) {
      case 'PROPFIND': return await propfind(env, request, user, path);
      case 'REPORT': return await report(env, request, user, path);
      case 'GET': return await getObject(env, request, user, path, false);
      case 'HEAD': return await getObject(env, request, user, path, true);
      case 'PUT': return await put(env, request, user, path);
      case 'DELETE': return await del(env, request, user, path);
      case 'MKCALENDAR':
      case 'MKCOL': return await mkcalendar(env, request, user, path);
      case 'PROPPATCH': return await proppatch(env, request, user, path);
      default: return plain(405, null, { allow: ALLOW });
    }
  } catch (err) {
    if (err instanceof HttpError) return plain(err.status, err.message);
    console.error(err);
    return plain(500, 'Serverfout');
  }
}
