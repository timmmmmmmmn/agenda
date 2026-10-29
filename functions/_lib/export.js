// Agenda's als één .ics-bestand (abonneren, back-up) en .ics-bestanden inlezen (importeren).

import { parseIcs, serialize, summarize, escapeText } from './ical.js';
import { HttpError, now } from './util.js';
import { etagFor } from './store.js';

const prop = (name, value, params = {}) => ({ name, params, value, raw: null });

// Alle afspraken van een agenda samen in één VCALENDAR.
export async function calendarIcs(env, cal) {
  const { results } = await env.DB.prepare('SELECT ics FROM events WHERE calendar_id = ? ORDER BY first_start').bind(cal.id).all();
  const zones = new Map();
  const events = [];
  for (const row of results) {
    const c = parseIcs(row.ics);
    if (!c) continue;
    for (const ch of c.children) {
      if (ch.name === 'VTIMEZONE') {
        const id = ch.props.find((p) => p.name === 'TZID')?.value;
        if (id && !zones.has(id)) zones.set(id, ch);
      } else if (ch.name === 'VEVENT') events.push(ch);
    }
  }
  return serialize({
    name: 'VCALENDAR',
    props: [
      prop('VERSION', '2.0'),
      prop('PRODID', '-//timvanbergen.nl//Agenda//NL'),
      prop('CALSCALE', 'GREGORIAN'),
      prop('METHOD', 'PUBLISH'),
      prop('X-WR-CALNAME', escapeText(cal.name)),
      prop('X-WR-TIMEZONE', 'Europe/Amsterdam'),
      prop('X-APPLE-CALENDAR-COLOR', cal.color),
      prop('REFRESH-INTERVAL', 'PT1H', { VALUE: 'DURATION' }),
      prop('X-PUBLISHED-TTL', 'PT1H')
    ],
    children: [...zones.values(), ...events]
  });
}

export function safeFileName(name) {
  return (String(name).normalize('NFKD').replace(/[^\w .-]+/g, '').trim() || 'agenda').slice(0, 60);
}

// ---------- Importeren ----------

// Splitst een .ics in losse afspraken (per UID, met herhaal-uitzonderingen erbij).
export function splitIcs(text) {
  const cal = parseIcs(text);
  if (!cal) throw new HttpError(400, 'Dit is geen geldig agendabestand (.ics)');
  const zones = cal.children.filter((c) => c.name === 'VTIMEZONE');
  const groups = new Map();
  for (const ev of cal.children.filter((c) => c.name === 'VEVENT')) {
    let uid = ev.props.find((p) => p.name === 'UID')?.value?.trim();
    if (!uid) {
      uid = crypto.randomUUID();
      ev.props.push(prop('UID', uid));
    }
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(ev);
  }
  const out = [];
  for (const [uid, evs] of groups) {
    const used = new Set(evs.flatMap((e) => e.props.map((p) => p.params?.TZID).filter(Boolean)));
    out.push({
      uid,
      ics: serialize({
        name: 'VCALENDAR',
        props: [prop('VERSION', '2.0'), prop('PRODID', '-//timvanbergen.nl//Agenda//NL'), prop('CALSCALE', 'GREGORIAN')],
        children: [...zones.filter((z) => used.has(z.props.find((p) => p.name === 'TZID')?.value)), ...evs]
      })
    });
  }
  return out;
}

async function hrefFor(uid) {
  if (/^[A-Za-z0-9@._-]{1,120}$/.test(uid)) return `${uid}.ics`;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uid)));
  return `${[...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}.ics`;
}

// Zet de afspraken in de agenda; een bestaande afspraak met dezelfde UID wordt overschreven.
export async function importIcs(env, calId, text, userId) {
  const items = splitIcs(text);
  if (items.length > 500) throw new HttpError(413, 'Te veel afspraken in één keer (max. 500)');
  const rows = [];
  let skipped = 0;
  for (const it of items) {
    const s = summarize(it.ics);
    if (!s) {
      skipped++;
      continue;
    }
    rows.push({ ...s, uid: it.uid, ics: it.ics, href: await hrefFor(it.uid), etag: await etagFor(it.ics) });
  }
  if (!rows.length) return { added: 0, skipped };
  const { sync_token: modseq } = await env.DB.prepare('UPDATE calendars SET sync_token = sync_token + 1 WHERE id = ? RETURNING sync_token').bind(calId).first();
  const t = now();
  const stmts = [];
  for (const r of rows) {
    stmts.push(env.DB.prepare(
      `INSERT INTO events (calendar_id, href, uid, ics, etag, summary, first_start, last_end, recurring, modseq, updated_at, created_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12)
       ON CONFLICT (calendar_id, href) DO UPDATE SET
         uid = excluded.uid, ics = excluded.ics, etag = excluded.etag, summary = excluded.summary,
         first_start = excluded.first_start, last_end = excluded.last_end, recurring = excluded.recurring,
         modseq = excluded.modseq, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(calId, r.href, r.uid, r.ics, r.etag, r.summary, r.firstStart, r.lastEnd, r.recurring, modseq, t, userId));
    stmts.push(env.DB.prepare('DELETE FROM tombstones WHERE calendar_id = ? AND href = ?').bind(calId, r.href));
  }
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  return { added: rows.length, skipped };
}

// ---------- Zip (zonder compressie) voor de volledige back-up ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files) {
  const enc = new TextEncoder();
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true);
    parts.push(new Uint8Array(head.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
