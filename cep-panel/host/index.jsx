/*
 * Textwerkstatt — CEP Host-Logik (ExtendScript, ES3)
 * Wird vom Panel via CSInterface.evalScript() aufgerufen.
 *
 *   cepHostInfo()                  -> "<Rechner> - Illustrator <Version>" (für die Anmeldung)
 *   cepExportSegments()            -> JSON-String { source, segments:[{id,text}] }
 *   cepSaveLanguageCopy(lang)      -> "OK <Name>_<LANG>.ai" (Speichern unter, Original bleibt)
 *   cepImportSegments(uriEncoded, saveAfter) -> Status-String "updated=..;unmatched=..;.."
 *
 * Arbeitet auf dem lebenden Dokument (echter Text), nicht auf dem SVG-Export.
 * IDs werden im note-Feld der TextFrames gestempelt (idempotent).
 */

var RDK_ID_PREFIX = 'RDK:';

// --- JSON-String-Encoder (ES3) --------------------------------------------
function rdkJsonEscape(s) {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    switch (c) {
      case '"':  out += '\\"';  break;
      case '\\': out += '\\\\'; break;
      case '\b': out += '\\b';  break;
      case '\f': out += '\\f';  break;
      case '\n': out += '\\n';  break;
      case '\r': out += '\\r';  break;
      case '\t': out += '\\t';  break;
      default:
        if (code < 0x20 || code === 0x2028 || code === 0x2029) {
          var hex = code.toString(16);
          while (hex.length < 4) hex = '0' + hex;
          out += '\\u' + hex;
        } else { out += c; }
    }
  }
  return out;
}

// --- Minimaler JSON-Parser (recursive descent, kein eval) ------------------
var RdkJSON = (function () {
  function parse(text) {
    var at = 0, ch = ' ';
    function error(m) { throw new Error(m + ' (Pos ' + at + ')'); }
    function next(c) { if (c && c !== ch) { error("Erwartet '" + c + "'"); } ch = text.charAt(at); at += 1; return ch; }
    function white() { while (ch && ch <= ' ') { next(); } }
    function string() {
      var result = '', hex, i, uffff;
      if (ch !== '"') { error('String erwartet'); }
      next();
      while (ch) {
        if (ch === '"') { next(); return result; }
        if (ch === '\\') {
          next();
          if (ch === 'u') {
            uffff = 0;
            for (i = 0; i < 4; i += 1) { hex = parseInt(next(), 16); if (!isFinite(hex)) break; uffff = uffff * 16 + hex; }
            result += String.fromCharCode(uffff);
          } else {
            switch (ch) {
              case '"': result += '"'; break; case '\\': result += '\\'; break; case '/': result += '/'; break;
              case 'b': result += '\b'; break; case 'f': result += '\f'; break; case 'n': result += '\n'; break;
              case 'r': result += '\r'; break; case 't': result += '\t'; break; default: error('Bad escape');
            }
          }
          next();
        } else { result += ch; next(); }
      }
      error('String nicht terminiert');
    }
    function number() {
      var s = '';
      if (ch === '-') { s = '-'; next('-'); }
      while (ch >= '0' && ch <= '9') { s += ch; next(); }
      if (ch === '.') { s += '.'; next(); while (ch >= '0' && ch <= '9') { s += ch; next(); } }
      if (ch === 'e' || ch === 'E') { s += ch; next(); if (ch === '-' || ch === '+') { s += ch; next(); } while (ch >= '0' && ch <= '9') { s += ch; next(); } }
      return Number(s);
    }
    function word() {
      switch (ch) {
        case 't': next('t'); next('r'); next('u'); next('e'); return true;
        case 'f': next('f'); next('a'); next('l'); next('s'); next('e'); return false;
        case 'n': next('n'); next('u'); next('l'); next('l'); return null;
      }
      error("Unerwartet '" + ch + "'");
    }
    function array() {
      var arr = []; next(); white();
      if (ch === ']') { next(); return arr; }
      while (ch) { arr.push(value()); white(); if (ch === ']') { next(); return arr; } next(','); white(); }
      error('Array nicht terminiert');
    }
    function object() {
      var obj = {}, key; next(); white();
      if (ch === '}') { next(); return obj; }
      while (ch) { key = string(); white(); next(':'); obj[key] = value(); white(); if (ch === '}') { next(); return obj; } next(','); white(); }
      error('Objekt nicht terminiert');
    }
    function value() {
      white();
      switch (ch) {
        case '{': return object(); case '[': return array(); case '"': return string();
        case '-': return number(); default: return (ch >= '0' && ch <= '9') ? number() : word();
      }
    }
    var result = value(); white();
    if (ch) { error('Daten nach JSON'); }
    return result;
  }
  return { parse: parse };
})();

// --- Stabile ID erzeugen ---------------------------------------------------
var rdkCounter = 0;
function rdkMakeId() {
  rdkCounter++;
  var rnd = Math.floor(Math.random() * 0xffffff).toString(16);
  return 't' + (new Date().getTime()) + '-' + rdkCounter + '-' + rnd;
}

// --- ID im note-Feld (28.10.2026) -----------------------------------------
// Format: "RDK:<id>" — hatte der Rahmen schon eine eigene Notiz, steht sie in
// der Zeile darunter ("RDK:<id>\n<Notiz>"). Bis 28.10. überschrieb das Stempeln
// eine vorhandene Notiz. Ohne Notiz ist das Format unverändert, ältere
// Dokumente und die Einzelskripte unter illustrator-scripts/ lesen es weiter.
function rdkIdOf(note) {
  if (!note || note.indexOf(RDK_ID_PREFIX) !== 0) { return null; }
  var rest = note.substring(RDK_ID_PREFIX.length);
  var cut = rest.search(/[\r\n]/);
  return cut === -1 ? rest : rest.substring(0, cut);
}
function rdkStamp(tf, id) {
  var old = '';
  try { old = tf.note || ''; } catch (e) { old = ''; }
  if (old.indexOf(RDK_ID_PREFIX) === 0) {
    var nl = old.search(/[\r\n]/);
    old = nl === -1 ? '' : old.substring(nl + 1);
  }
  tf.note = RDK_ID_PREFIX + id + (old ? '\n' + old : '');
}

// === GERÄT =================================================================
// Für die Liste „Meine Panel-Verbindungen" in der Web-App: Rechner + Version.
// Zeichenketten in dieser Datei bleiben ASCII — ExtendScript liest die Datei je
// nach Version nicht als UTF-8 (deshalb auch „geoeffnet" statt „geöffnet").
function cepHostInfo() {
  try {
    var computer = $.getenv('COMPUTERNAME') || $.getenv('HOSTNAME') || '';
    return (computer ? computer + ' - ' : '') + 'Illustrator ' + app.version;
  } catch (err) {
    return 'ERROR: ' + err;
  }
}

// === EXPORT ================================================================
function cepExportSegments() {
  try {
    if (app.documents.length === 0) { return 'ERROR: Kein Dokument geoeffnet'; }
    var doc = app.activeDocument;
    var segs = [];
    var stamped = 0;
    var seen = {};

    for (var f = 0; f < doc.textFrames.length; f++) {
      var tf = doc.textFrames[f];
      var text;
      try { text = tf.contents; } catch (e) { continue; }
      if (text === null || text === undefined) { continue; }
      if (String(text).replace(/^\s+|\s+$/g, '').length === 0) { continue; }

      var id = null;
      try { id = rdkIdOf(tf.note); } catch (e2) {}
      // Ein kopierter Rahmen trägt die ID seines Originals mit. Der Server lehnt
      // doppelte IDs ab (ganzer Auftrag 400) — der spätere Rahmen bekommt eine neue.
      if (id && seen.hasOwnProperty(id)) { id = null; }
      if (!id) { id = rdkMakeId(); try { rdkStamp(tf, id); stamped++; } catch (e3) {} }
      seen[id] = true;

      segs.push({ id: id, text: String(text) });
    }

    if (segs.length === 0) { return 'ERROR: Kein uebersetzbarer Text (evtl. in Pfade umgewandelt)'; }

    // Dokument speichern, damit die gestempelten IDs persistent sind
    try { if (doc.saved === false || stamped > 0) { doc.save(); } } catch (eSave) {}

    var json = '{"source":"' + rdkJsonEscape(doc.name) + '","segments":[';
    for (var s = 0; s < segs.length; s++) {
      json += '{"id":"' + rdkJsonEscape(segs[s].id) + '","text":"' + rdkJsonEscape(segs[s].text) + '"}';
      if (s < segs.length - 1) json += ',';
    }
    json += ']}';
    return json;
  } catch (err) {
    return 'ERROR: ' + err;
  }
}

// === SPRACHKOPIE ===========================================================
// Vor dem Zurückschreiben: Dokument als <Name>_<LANG>.ai neben das Original
// speichern („Speichern unter"). Danach ist die Kopie das aktive Dokument; das
// Original auf der Platte bleibt unverändert. Bis 28.10.2026 schrieb das Panel
// ins offene Original und verließ sich auf einen Warnhinweis.
// Gibt es die Datei schon, wird durchnummeriert (_FR-2.ai) statt überschrieben.
function cepSaveLanguageCopy(lang) {
  try {
    if (app.documents.length === 0) { return 'ERROR: Kein Dokument geoeffnet'; }
    var doc = app.activeDocument;
    var folder = null;
    try { folder = doc.path; } catch (eP) { folder = null; }
    if (!folder || String(folder) === '') { return 'ERROR: Dokument bitte zuerst speichern (Datei > Speichern unter)'; }

    var code = String(lang).replace(/[^A-Za-z]/g, '').toUpperCase();
    if (!code) { return 'ERROR: Keine Zielsprache'; }
    var base = String(doc.name).replace(/\.ai$/i, '');
    var target = new File(folder + '/' + base + '_' + code + '.ai');
    var n = 2;
    while (target.exists) {
      target = new File(folder + '/' + base + '_' + code + '-' + n + '.ai');
      n++;
    }
    doc.saveAs(target, new IllustratorSaveOptions());
    return 'OK ' + target.displayName;
  } catch (err) {
    return 'ERROR: ' + err;
  }
}

// === IMPORT ================================================================
// uriEncoded = encodeURIComponent(JSON-String { segments:[{id,text}] })
// saveAfter  = true → das (Kopie-)Dokument danach speichern
function cepImportSegments(uriEncoded, saveAfter) {
  try {
    if (app.documents.length === 0) { return 'ERROR: Kein Dokument geoeffnet'; }
    var raw = decodeURIComponent(uriEncoded);
    var data = RdkJSON.parse(raw);
    if (!data || !data.segments || !data.segments.length) { return 'ERROR: Keine Segmente'; }

    var byId = {};
    for (var i = 0; i < data.segments.length; i++) {
      var seg = data.segments[i];
      if (seg && seg.id) { byId[seg.id] = (seg.text !== undefined ? seg.text : ''); }
    }

    var doc = app.activeDocument;
    var updated = 0, unmatched = 0, locked = 0, noId = 0;

    for (var f = 0; f < doc.textFrames.length; f++) {
      var tf = doc.textFrames[f];
      var note = null;
      try { note = tf.note; } catch (eN) { note = null; }
      var id = rdkIdOf(note);
      if (!id) { noId++; continue; }
      if (!byId.hasOwnProperty(id)) { unmatched++; continue; }
      try { tf.contents = byId[id]; updated++; } catch (eSet) { locked++; }
    }

    app.redraw();
    if (saveAfter === true) { doc.save(); }
    return 'OK updated=' + updated + ';unmatched=' + unmatched + ';locked=' + locked + ';noId=' + noId;
  } catch (err) {
    return 'ERROR: ' + err;
  }
}
