// Vroeg geladen (in <head>) zodat er geen witte flits is in de donkere modus.
(function () {
  var pref = 'systeem';
  try { pref = localStorage.getItem('theme') || 'systeem'; } catch (e) {}
  var dark = pref === 'donker' || (pref === 'systeem' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'donker' : 'licht');
})();
