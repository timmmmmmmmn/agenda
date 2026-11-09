// Alleen in het spiekbriefje: altijd dezelfde notitie open, en Esc zet het venster weg.
(function () {
  var post = function (fn) {
    try { window.webkit.messageHandlers.spiek.postMessage(JSON.stringify({ fn: fn, args: [] })); } catch (e) {}
  };
  var KEY = 'notities:spiekbriefje';
  var TITLE = 'Spiekbriefje';

  function find() {
    var me = null, data = null;
    try { me = JSON.parse(localStorage.getItem('notities:me')); } catch (e) {}
    if (!me) return null;
    try { data = JSON.parse(localStorage.getItem('notities:' + me.id)); } catch (e) {}
    var notes = (data && data.notes) || [];
    var alive = function (n) { return n && !n.deleted_at && !n.purged; };
    var id = localStorage.getItem(KEY);
    var note = notes.filter(function (n) { return n.id === id; })[0];
    if (!alive(note)) note = notes.filter(function (n) { return alive(n) && n.title === TITLE; })[0];
    return alive(note) ? note.id : null;
  }

  function focusEnd() {
    var body = document.getElementById('edBody');
    if (!body) return;
    body.focus();
    body.selectionStart = body.selectionEnd = body.value.length;
  }

  // Bestaande notitie openen; anders eerst de server laten bijwerken en pas dan een nieuwe maken,
  // zodat er op een nieuw apparaat geen tweede spiekbriefje ontstaat.
  window.timSpiekOpen = function (retry) {
    if (!window.notitiesOpen) return false;
    var id = find();
    if (id) {
      localStorage.setItem(KEY, id);
      window.notitiesOpen(id);
      setTimeout(focusEnd, 30);
      return true;
    }
    if (!retry) {
      setTimeout(function () { window.timSpiekOpen(true); }, 2500);
      return true;
    }
    if (!window.notitiesNew('tekst', TITLE, '')) return false;
    setTimeout(function () {
      var made = find();
      if (made) localStorage.setItem(KEY, made);
      focusEnd();
    }, 600);
    return true;
  };

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var sheet = document.getElementById('sheetBack');
    if (sheet && !sheet.hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    post('hide');
  }, true);
})();
