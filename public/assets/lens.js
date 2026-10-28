// Liquid Glass-lens: lichtrand (alle browsers) en lichtbreking (Chromium).
//
// De berekening van het glasprofiel, de verplaatsingskaart en de lichtrand is
// overgenomen uit Glisse (https://github.com/0kzh/glisse), omgezet naar gewone
// JavaScript zonder React:
//
//   MIT License
//
//   Copyright (c) 2026 Kelvin Zhang
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

const SELECTOR = '.glass, .btn, .primary, .icon-btn, .avatar, .segmented .pill, .fab, .search';
const SVG = 'http://www.w3.org/2000/svg';
const lenses = new Map();
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Alleen Chromium past SVG-filters toe op de live achtergrond.
const live = /Chrom(?:e|ium)\//.test(navigator.userAgent);
if (live) document.documentElement.classList.add('lens-live');

let defs;
function container() {
  if (defs?.isConnected) return defs;
  const root = document.createElementNS(SVG, 'svg');
  root.setAttribute('width', '0');
  root.setAttribute('height', '0');
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
  defs = document.createElementNS(SVG, 'defs');
  root.append(defs);
  document.body.append(root);
  return defs;
}

function svg(name, attrs) {
  const el = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// Hoeveel het licht afbuigt over de afgeronde rand (bezel) van het glas.
function profile(bezel, thickness) {
  const samples = new Float32Array(128);
  let maximum = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = Math.max(0.001, i / (samples.length - 1));
    const surface = (1 - (1 - t) ** 4) ** 0.25;
    const incident = Math.atan((1 - t) ** 3 / surface ** 3);
    const refracted = Math.asin(Math.sin(incident) / 1.5);
    samples[i] = Math.tan(incident - refracted) * (thickness + surface * bezel);
    maximum = Math.max(maximum, samples[i]);
  }
  return { samples, maximum };
}

function maps(width, height, radius) {
  // Grote panelen op lagere resolutie: de rand is zacht, dat scheelt veel rekenwerk.
  const density = width * height > 250000 ? 1 : Math.min(devicePixelRatio || 1, 2);
  const bezel = clamp(Math.min(width, height) * 0.12, 4, 10);
  const { samples, maximum } = profile(bezel, clamp(Math.min(width, height) * 0.2, 8, 24));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * density);
  canvas.height = Math.ceil(height * density);
  const ctx = canvas.getContext('2d');
  const field = live ? ctx.createImageData(canvas.width, canvas.height) : null;
  const shine = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const px = ((x + 0.5) * width) / canvas.width - width / 2;
      const py = ((y + 0.5) * height) / canvas.height - height / 2;
      const qx = Math.abs(px) - (width / 2 - radius);
      const qy = Math.abs(py) - (height / 2 - radius);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const length = Math.hypot(ox, oy);
      const distance = radius - (length + Math.min(Math.max(qx, qy), 0));
      const nx = length > 0 ? (ox / length) * Math.sign(px) : qx > qy ? Math.sign(px) : 0;
      const ny = length > 0 ? (oy / length) * Math.sign(py) : qx > qy ? 0 : Math.sign(py);
      const i = (y * canvas.width + x) * 4;
      if (field) {
        let shift = 0;
        if (distance >= 0 && distance < bezel) {
          const s = (distance / bezel) * (samples.length - 1);
          const lo = Math.floor(s);
          const a = samples[lo];
          shift = a + (samples[Math.min(lo + 1, samples.length - 1)] - a) * (s - lo);
        }
        field.data[i] = Math.round(127.5 - ((nx * shift) / maximum) * 127.5);
        field.data[i + 1] = Math.round(127.5 - ((ny * shift) / maximum) * 127.5);
        field.data[i + 2] = 128;
        field.data[i + 3] = 255;
      }
      // Lichtval van linksboven: glinstering op de rand, zwakke reflectie rechtsonder.
      const light = -(nx + ny) * Math.SQRT1_2;
      const glint = Math.max(light, 0) ** 3;
      const reflected = Math.max(-light, 0) ** 3;
      shine.data[i] = shine.data[i + 1] = shine.data[i + 2] = 255;
      let alpha = 0;
      if (distance >= 0) {
        const rim = Math.exp(-(((distance - 0.4) / 0.38) ** 2));
        const bloom = Math.exp(-((distance / (bezel * 0.22)) ** 2));
        alpha = rim * (0.045 + 0.52 * glint + 0.2 * reflected) + bloom * 0.02 * glint;
      }
      // Iets sterker dan in Glisse: onze panelen liggen op een lichte, rustige achtergrond.
      shine.data[i + 3] = Math.round(clamp(alpha * 1.5, 0, 1) * 255);
    }
  }
  let displacement = null;
  if (field) {
    ctx.putImageData(field, 0, 0);
    displacement = canvas.toDataURL();
  }
  ctx.putImageData(shine, 0, 0);
  return { displacement, highlight: canvas.toDataURL(), scale: maximum * 2 };
}

function lens(width, height, radius) {
  const key = `${width}-${height}-${radius}`;
  if (lenses.has(key)) return lenses.get(key);
  const { displacement, highlight, scale } = maps(width, height, radius);
  const result = { rim: `url("${highlight}")`, filter: null };
  if (displacement) {
    const id = `lens-${lenses.size}`;
    const box = { x: 0, y: 0, width, height };
    const filter = svg('filter', { id, ...box, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
    filter.append(
      svg('feImage', { href: displacement, ...box, preserveAspectRatio: 'none', result: 'field' }),
      svg('feDisplacementMap', { in: 'SourceGraphic', in2: 'field', scale, xChannelSelector: 'R', yChannelSelector: 'G', result: 'bent' }),
      svg('feGaussianBlur', { in: 'bent', stdDeviation: 0.4, result: 'soft' }),
      svg('feColorMatrix', { in: 'soft', type: 'saturate', values: 1.5 })
    );
    container().append(filter);
    result.filter = `url("#${id}")`;
  }
  lenses.set(key, result);
  return result;
}

function fit(el) {
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  if (!width || !height || width * height > 2_500_000) return;
  const corner = getComputedStyle(el).borderTopLeftRadius;
  const r = corner.endsWith('%') ? (Math.min(width, height) * parseFloat(corner)) / 100 : parseFloat(corner) || 0;
  const { rim, filter } = lens(width, height, Math.min(width / 2, height / 2, r));
  el.style.setProperty('--lg-rim', rim);
  if (filter) el.style.setProperty('--lg-filter', filter);
}

// ---------- Toepassen op de pagina ----------

const queue = new Set();
let scheduled = false;

function flush() {
  scheduled = false;
  for (const el of queue) if (el.isConnected) fit(el);
  queue.clear();
}

function schedule(el) {
  queue.add(el);
  if (scheduled) return;
  scheduled = true;
  if ('requestIdleCallback' in window) requestIdleCallback(flush, { timeout: 300 });
  else setTimeout(flush, 30);
}

const sizes = new ResizeObserver((entries) => entries.forEach((e) => schedule(e.target)));
const seen = new WeakSet();

function adopt(root) {
  const els = root.matches?.(SELECTOR) ? [root] : [];
  if (root.querySelectorAll) els.push(...root.querySelectorAll(SELECTOR));
  for (const el of els) {
    if (seen.has(el)) continue;
    seen.add(el);
    el.classList.add('lens');
    sizes.observe(el);
  }
}

function start() {
  adopt(document.body);
  new MutationObserver((list) => {
    for (const m of list) m.addedNodes.forEach((n) => n.nodeType === 1 && adopt(n));
  }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
