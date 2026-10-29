// Vroeg geladen (in <head>) zodat er geen witte flits is in de donkere modus.
(function () {
  var root = document.documentElement;
  var pref = 'systeem';
  try { pref = localStorage.getItem('theme') || 'systeem'; } catch (e) {}
  var dark = pref === 'donker' || (pref === 'systeem' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'donker' : 'licht');

  // App-stand: in de Android-app, of geopend vanaf het beginscherm (webapp op iPhone/Android).
  var native = /AgendaApp\//.test(navigator.userAgent);
  var standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (native || standalone) {
    root.classList.add('app');
    if (!native) root.classList.add('pwa');
    // Eigen lettertypes van de app: rustig voor tekst, smal en vet voor datums en tijden.
    var font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Instrument+Sans:wght@400;500;600;700&display=swap';
    document.head.appendChild(font);
  }
  // In de Android-app: meteen de ruimte van status- en navigatiebalk weten.
  if (native) {
    try {
      var i = window.AgendaNative.insets().split(',');
      root.style.setProperty('--sat', i[0] + 'px');
      root.style.setProperty('--sab', i[1] + 'px');
      window.AgendaNative.setDark(dark);
    } catch (e) {}
  }
})();

// Icoon met de datum van vandaag: lege kalender met het dagnummer erin, als favicon en logo.
(function () {
  var img = new Image();
  var ready = new Promise(function (resolve) { img.onload = resolve; });
  img.src = '/icons/kalender.png?v=1';

  function draw(size) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0, size, size);
    var day = String(new Date().getDate());
    var s = size / 512;
    // Het witte vlak van de kalender loopt (op 512 px) van y 160 tot 452 en x 46 tot 466.
    g.fillStyle = '#000';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    var px = 270;
    g.font = '800 ' + px * s + 'px -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
    var m = g.measureText(day);
    var w = m.width, max = 380 * s;
    if (w > max) { px = px * max / w; g.font = '800 ' + px * s + 'px -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif'; m = g.measureText(day); }
    var h = m.actualBoundingBoxAscent - m.actualBoundingBoxDescent;
    g.fillText(day, 256 * s, 306 * s + h / 2);
    return c.toDataURL('image/png');
  }

  function apply() {
    var url = draw(64);
    var links = document.querySelectorAll('link[rel="icon"]');
    for (var i = 0; i < links.length; i++) links[i].parentNode.removeChild(links[i]);
    var link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = url;
    document.head.appendChild(link);
    window.agendaDatumLogo = draw(256);
    var logos = document.querySelectorAll('img[data-datum]');
    for (var j = 0; j < logos.length; j++) logos[j].src = window.agendaDatumLogo;
    // Om middernacht opnieuw tekenen.
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    setTimeout(apply, next - now);
  }

  window.agendaDatumIcoon = ready.then(apply);
})();
