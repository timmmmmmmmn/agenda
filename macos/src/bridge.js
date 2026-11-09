// Dezelfde brug als in de Android-app, zodat de pagina niet hoeft te weten dat dit een Mac is.
// Antwoorden die de pagina meteen nodig heeft staan hier al klaar; de rest gaat naar de app.
(function () {
  var post = function (fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    try { window.webkit.messageHandlers.__HANDLER__.postMessage(JSON.stringify({ fn: fn, args: args })); } catch (e) {}
  };
  window.__BRIDGE__ = {
    insets: function () { return '__TOP__,0'; },
    glassUi: function () { return true; },
    setDark: function (dark) { post('setDark', !!dark); },
    haptic: function () {},
    showKeyboard: function () {},
    syncReminders: function () {},
    glassMenu: function (json) { post('glassMenu', json); return true; },
    glassMenuItems: function (json) { post('glassMenuItems', json); },
    glassBar: function (json) { post('glassBar', json); },
    share: function (title, text) { post('share', String(title || ''), String(text || '')); },
    ready: function () { post('ready'); },
    setReminders: function (json) { post('setReminders', json); }
  };
  // Het thema van de pagina volgen, ook als die zelf niets doorgeeft (Agenda in desktopstand).
  var root = document.documentElement;
  var lastDark = null;
  new MutationObserver(function () {
    var dark = root.getAttribute('data-theme') === 'donker';
    if (dark !== lastDark) { lastDark = dark; post('setDark', dark); }
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  // Waar in de titelbalk knoppen en velden zitten: daar gaat een klik naar de pagina,
  // op de rest van de balk sleep je het venster.
  var STRIP = __STRIP__;
  var hits = 'a,button,input,select,textarea,label,summary,[role="button"],[tabindex],.search';
  var lastHoles = '';
  var sendHoles = function () {
    var out = [];
    var els = document.querySelectorAll(hits);
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width && r.height && r.top < STRIP && r.bottom > 0) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    var json = JSON.stringify(out);
    if (json !== lastHoles) { lastHoles = json; post('dragHoles', json); }
  };
  addEventListener('resize', sendHoles);
  document.addEventListener('DOMContentLoaded', sendHoles);
  setInterval(sendHoles, 700);
  document.documentElement.classList.add('mac');
  if ('__HANDLER__' === 'spiek') document.documentElement.classList.add('spiek');
})();
