/*
 * Textwerkstatt — Illustrator Text Import
 * -------------------------------------------------
 * Liest eine uebersetzte Austauschdatei (JSON) und schreibt die Texte per
 * stabiler ID (PageItem.note) in die TextFrames des aktiven Dokuments zurueck.
 * Illustrator bricht den Text danach mit der eigenen Composition-Engine neu um
 * (Kerning/Zeilenumbruch nativ) — das Original-Layout bleibt erhalten.
 *
 * Voraussetzung: Das Dokument wurde mit export-text.jsx exportiert UND
 * danach gespeichert (die IDs stecken im note-Feld der Frames).
 *
 * Tipp: Am uebersetzten Dokument vorher "Speichern unter" (z.B. _FR.ai),
 * dann diesen Import darauf laufen lassen.
 *
 * ExtendScript (ES3) hat kein natives JSON.parse — daher ein kleiner,
 * eingebauter rekursiver Parser unten (kein eval, kein Code-Ausfuehren).
 */

#target illustrator

// --- Minimaler JSON-Parser (recursive descent, ES3) -----------------------
// Unterstuetzt Objekt/Array/String/Zahl/true/false/null inkl. \uXXXX-Escapes.
var MiniJSON = (function () {
  function parse(text) {
    var at = 0;
    var ch = ' ';

    function error(m) { throw new Error(m + ' (Pos ' + at + ')'); }

    function next(c) {
      if (c && c !== ch) { error("Erwartet '" + c + "' statt '" + ch + "'"); }
      ch = text.charAt(at);
      at += 1;
      return ch;
    }

    function white() {
      while (ch && ch <= ' ') { next(); }
    }

    function string() {
      var result = '';
      var hex, i, uffff;
      if (ch !== '"') { error('String erwartet'); }
      next();
      while (ch) {
        if (ch === '"') { next(); return result; }
        if (ch === '\\') {
          next();
          if (ch === 'u') {
            uffff = 0;
            for (i = 0; i < 4; i += 1) {
              hex = parseInt(next(), 16);
              if (!isFinite(hex)) { break; }
              uffff = uffff * 16 + hex;
            }
            result += String.fromCharCode(uffff);
          } else {
            switch (ch) {
              case '"':  result += '"';  break;
              case '\\': result += '\\'; break;
              case '/':  result += '/';  break;
              case 'b':  result += '\b'; break;
              case 'f':  result += '\f'; break;
              case 'n':  result += '\n'; break;
              case 'r':  result += '\r'; break;
              case 't':  result += '\t'; break;
              default:   error('Ungueltiges Escape');
            }
          }
          next();
        } else {
          result += ch;
          next();
        }
      }
      error('String nicht terminiert');
    }

    function number() {
      var s = '';
      if (ch === '-') { s = '-'; next('-'); }
      while (ch >= '0' && ch <= '9') { s += ch; next(); }
      if (ch === '.') { s += '.'; next(); while (ch >= '0' && ch <= '9') { s += ch; next(); } }
      if (ch === 'e' || ch === 'E') {
        s += ch; next();
        if (ch === '-' || ch === '+') { s += ch; next(); }
        while (ch >= '0' && ch <= '9') { s += ch; next(); }
      }
      return Number(s);
    }

    function word() {
      switch (ch) {
        case 't': next('t'); next('r'); next('u'); next('e'); return true;
        case 'f': next('f'); next('a'); next('l'); next('s'); next('e'); return false;
        case 'n': next('n'); next('u'); next('l'); next('l'); return null;
      }
      error("Unerwartetes '" + ch + "'");
    }

    function array() {
      var arr = [];
      if (ch !== '[') { error('Array erwartet'); }
      next();
      white();
      if (ch === ']') { next(); return arr; }
      while (ch) {
        arr.push(value());
        white();
        if (ch === ']') { next(); return arr; }
        next(',');
        white();
      }
      error('Array nicht terminiert');
    }

    function object() {
      var obj = {};
      var key;
      if (ch !== '{') { error('Objekt erwartet'); }
      next();
      white();
      if (ch === '}') { next(); return obj; }
      while (ch) {
        key = string();
        white();
        next(':');
        obj[key] = value();
        white();
        if (ch === '}') { next(); return obj; }
        next(',');
        white();
      }
      error('Objekt nicht terminiert');
    }

    function value() {
      white();
      switch (ch) {
        case '{': return object();
        case '[': return array();
        case '"': return string();
        case '-': return number();
        default:  return (ch >= '0' && ch <= '9') ? number() : word();
      }
    }

    var result = value();
    white();
    if (ch) { error('Unerwartete Daten nach JSON'); }
    return result;
  }

  return { parse: parse };
})();

(function () {
  if (app.documents.length === 0) {
    alert('Kein Dokument geoeffnet.');
    return;
  }

  var doc = app.activeDocument;
  var ID_PREFIX = 'RDK:';

  // --- Austauschdatei waehlen ---------------------------------------------
  var jsonFile = File.openDialog('Uebersetzte Austauschdatei (.aijson) waehlen', 'Illustrator-Austausch:*.aijson');
  if (!jsonFile) { return; }

  jsonFile.encoding = 'UTF-8';
  jsonFile.open('r');
  var content = jsonFile.read();
  jsonFile.close();

  // --- Parsen --------------------------------------------------------------
  var data;
  try {
    data = MiniJSON.parse(content);
  } catch (e) {
    alert('JSON konnte nicht gelesen werden:\n' + e);
    return;
  }
  if (!data || !data.segments || !data.segments.length) {
    alert('Keine Segmente in der Datei gefunden.');
    return;
  }

  // --- Lookup id -> text aufbauen -----------------------------------------
  var byId = {};
  for (var i = 0; i < data.segments.length; i++) {
    var seg = data.segments[i];
    if (seg && seg.id) { byId[seg.id] = (seg.text !== undefined ? seg.text : ''); }
  }

  // --- TextFrames matchen + Inhalt setzen ---------------------------------
  var updated = 0;
  var noId = 0;
  var locked = 0;
  var unmatched = 0;

  for (var f = 0; f < doc.textFrames.length; f++) {
    var tf = doc.textFrames[f];

    var note = null;
    try { note = tf.note; } catch (eN) { note = null; }

    if (!note || note.indexOf(ID_PREFIX) !== 0) { noId++; continue; }
    // Seit 28.10.2026 kann unter der ID eine eigene Notiz stehen (CEP-Panel 1.1.0)
    var id = note.substring(ID_PREFIX.length).split(/[\r\n]/)[0];

    if (!byId.hasOwnProperty(id)) { unmatched++; continue; }

    try {
      tf.contents = byId[id];
      updated++;
    } catch (eSet) {
      locked++; // z.B. Frame auf gesperrter Ebene
    }
  }

  app.redraw();

  alert(
    'Import fertig.\n\n' +
    updated + ' Segmente aktualisiert.\n' +
    (unmatched > 0 ? unmatched + ' IDs ohne Treffer in der JSON-Datei.\n' : '') +
    (locked > 0 ? locked + ' Frames gesperrt/nicht beschreibbar.\n' : '') +
    (noId > 0 ? noId + ' Frames ohne ID (vor Export erstellt?).' : '')
  );
})();
