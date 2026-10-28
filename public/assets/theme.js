// Vroeg geladen (in <head>) zodat er geen witte flits is in de donkere modus.
(function () {
  var root = document.documentElement;
  var pref = 'systeem';
  try { pref = localStorage.getItem('theme') || 'systeem'; } catch (e) {}
  var dark = pref === 'donker' || (pref === 'systeem' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'donker' : 'licht');

  // In de Android-app: app-stand aan, en meteen de ruimte van status- en navigatiebalk weten.
  if (/AgendaApp\//.test(navigator.userAgent)) {
    root.classList.add('app');
    // Eigen lettertypes van de app: rustig voor tekst, smal en vet voor datums en tijden.
    var font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Instrument+Sans:wght@400;500;600;700&display=swap';
    document.head.appendChild(font);
    try {
      var i = window.AgendaNative.insets().split(',');
      root.style.setProperty('--sat', i[0] + 'px');
      root.style.setProperty('--sab', i[1] + 'px');
      window.AgendaNative.setDark(dark);
    } catch (e) {}
  }
})();
