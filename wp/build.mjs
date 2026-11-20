// Bouwt de Windows 10 Mobile-versie (Lumia, EdgeHTML 13–15) in public/wp/, met dezelfde paden als public/.
// De worker geeft oude Edge-browsers (en de Lumia-app, ?wp=1) automatisch die bestanden, zodat alle links
// gewoon blijven werken. Modules worden één ES2015-script met polyfills, CSS-variabelen worden ingevuld.
// Gebruik: cd wp && npm install && node build.mjs (na elke wijziging aan public/, vóór het deployen)
import * as esbuild from 'esbuild';
import swc from '@swc/core';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import customProps from 'postcss-custom-properties';
import { transform as lcss } from 'lightningcss';

const hier = path.dirname(new URL(import.meta.url).pathname);
const pub = path.join(hier, '../public');
const uit = path.join(pub, 'wp');
fs.rmSync(uit, { recursive: true, force: true });
const schrijf = (rel, data) => { const f = path.join(uit, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const lokaal = (src) => !/^(https?:)?\/\//.test(src);
const bron = (src, html) => path.join(src.startsWith('/') ? pub : path.dirname(html), src.split('?')[0]);

// Glisse (WebGL2) draait niet in EdgeHTML; de code valt dan al terug op de gewone balk
const wp = {
  name: 'wp',
  setup(b) {
    b.onLoad({ filter: /\.js$/ }, (a) => {
      if (a.path.includes('node_modules') || a.path.startsWith(hier)) return null;
      const src = fs.readFileSync(a.path, 'utf8').replace(/import\((['"])[^'"]*glisse\.js\1\)/g, "Promise.reject(new Error('geen glisse'))");
      return { contents: src, loader: 'js' };
    });
  },
};

async function js(bestand, metPolyfills) {
  const r = await esbuild.build({
    stdin: { contents: (metPolyfills ? `import ${JSON.stringify(path.join(hier, 'polyfill.js'))};\n` : '') + `import ${JSON.stringify(bestand)};`, resolveDir: hier },
    bundle: true, format: 'iife', target: ['es2020'], legalComments: 'none', charset: 'utf8', write: false, plugins: [wp], logLevel: 'warning',
  });
  // esbuild kan niet naar ES5; SWC zet de bundel om voor EdgeHTML 13 (let/const, destructuring, async)
  return (await swc.transform(r.outputFiles[0].text, {
    env: { targets: { edge: '13' }, bugfixes: true },
    jsc: { parser: { syntax: 'ecmascript' }, minify: { compress: { passes: 1 }, mangle: true } },
    minify: true, isModule: false,
  })).code;
}

const dialogCss = fs.readFileSync(path.join(hier, 'node_modules/dialog-polyfill/dist/dialog-polyfill.css'), 'utf8');
async function css(bestand) {
  let c = fs.readFileSync(bestand, 'utf8') + '\n' + dialogCss;
  c = (await postcss([customProps({ preserve: true })]).process(c, { from: undefined })).css;
  return lcss({ code: Buffer.from(c), minify: true, targets: { edge: 13 << 16 }, errorRecovery: true }).code.toString();
}

const klaar = new Set();
for (const naam of fs.readdirSync(pub).filter((f) => f.endsWith('.html'))) {
  const htmlPad = path.join(pub, naam);
  let html = fs.readFileSync(htmlPad, 'utf8');
  for (const [tag, mod, src] of [...html.matchAll(/<script( type="module")? src="([^"]+)"[^>]*><\/script>/g)].map((m) => [m[0], m[1], m[2]])) {
    if (!lokaal(src)) continue;
    const rel = path.relative(pub, bron(src, htmlPad));
    if (!klaar.has(rel)) { schrijf(rel, await js(path.join(pub, rel), !!mod)); klaar.add(rel); }
    // modules zijn vanzelf 'defer'; een gewoon script niet
    if (mod) html = html.replace(tag, `<script src="${src}" defer></script>`);
  }
  for (const m of html.matchAll(/<link rel="stylesheet" href="([^"]+)"[^>]*>/g)) {
    if (!lokaal(m[1])) continue;
    const rel = path.relative(pub, bron(m[1], htmlPad));
    if (!klaar.has(rel)) { schrijf(rel, await css(path.join(pub, rel))); klaar.add(rel); }
  }
  html = html.replace(/<link rel="manifest"[^>]*>\n?/, '').replace('<head>', '<head>\n<meta http-equiv="X-UA-Compatible" content="IE=edge">');
  schrijf(naam, html);
}
console.log('klaar:', [...klaar].join(', '));
