/*
 * Textwerkstatt — Illustrator Text Export
 * -------------------------------------------------
 * Liest den editierbaren Text aller TextFrames des aktiven Dokuments aus,
 * vergibt jedem Frame eine stabile ID (gespeichert in PageItem.note) und
 * schreibt eine JSON-Austauschdatei.
 *
 * WICHTIG: Arbeitet auf dem LEBENDEN Dokument-Objektmodell — NICHT auf dem
 * SVG/PDF-Export. Dadurch ist der Text noch echter Text (keine zerlegten
 * <tspan>-Glyphen) und das Layout bleibt beim Reimport erhalten, weil
 * Illustrator selbst neu umbricht.
 *
 * Grenzen (wie bei Redokun):
 *  - "In Pfade umgewandelter" Text (Create Outlines) wird NICHT erfasst.
 *  - Stilwechsel innerhalb eines Strings (fett/kursiv mitten im Satz)
 *    gehen verloren — der Frame wird als ein String behandelt.
 *
 * Aufruf:  Datei → Skripten → Anderes Skript…  (oder in den Scripts-Ordner legen)
 *
 * ExtendScript (ES3) — kein natives JSON, daher eigener Encoder unten.
 */

#target illustrator

(function () {
  if (app.documents.length === 0) {
    alert('Kein Dokument geoeffnet.');
    return;
  }

  var doc = app.activeDocument;
  var ID_PREFIX = 'RDK:'; // Marker im note-Feld
  var segments = [];
  var stamped = 0;
  var skippedEmpty = 0;

  // --- Minimaler JSON-String-Encoder (ES3-tauglich) -----------------------
  function jsonEscape(s) {
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
          // Steuerzeichen + U+2028/U+2029 (brechen JS-eval beim Import) escapen
          if (code < 0x20 || code === 0x2028 || code === 0x2029) {
            var hex = code.toString(16);
            while (hex.length < 4) hex = '0' + hex;
            out += '\\u' + hex;
          } else {
            out += c;
          }
      }
    }
    return out;
  }

  // --- Stabile, eindeutige ID erzeugen ------------------------------------
  var counter = 0;
  function makeId() {
    counter++;
    var rnd = Math.floor(Math.random() * 0xffffff).toString(16);
    return 't' + (new Date().getTime()) + '-' + counter + '-' + rnd;
  }

  // --- TextFrames durchlaufen ---------------------------------------------
  // doc.textFrames ist eine flache Sammlung ueber alle Ebenen/Gruppen.
  for (var f = 0; f < doc.textFrames.length; f++) {
    var tf = doc.textFrames[f];

    var text;
    try {
      text = tf.contents;
    } catch (e) {
      continue; // z.B. Pfadtext-Sonderfall — ueberspringen
    }

    // Leere/whitespace-only Frames ueberspringen
    if (text === null || text === undefined) { continue; }
    var trimmed = String(text).replace(/^\s+|\s+$/g, '');
    if (trimmed.length === 0) { skippedEmpty++; continue; }

    // ID aus note lesen oder neu stempeln (idempotent)
    var id = null;
    try {
      if (tf.note && tf.note.indexOf(ID_PREFIX) === 0) {
        // Seit 28.10.2026 kann unter der ID eine eigene Notiz stehen (CEP-Panel 1.1.0)
        id = tf.note.substring(ID_PREFIX.length).split(/[\r\n]/)[0];
      }
    } catch (e2) { /* note nicht lesbar */ }

    if (!id) {
      id = makeId();
      try { tf.note = ID_PREFIX + id; stamped++; } catch (e3) { /* note nicht setzbar (gelockt?) */ }
    }

    segments.push({ id: id, text: String(text) });
  }

  if (segments.length === 0) {
    alert('Kein uebersetzbarer Text gefunden.\n\nMoeglich: Text wurde in Pfade umgewandelt (Create Outlines).');
    return;
  }

  // --- JSON zusammenbauen --------------------------------------------------
  var json = '';
  json += '{\n';
  json += '  "schema": "textwerkstatt/illustrator-exchange@1",\n';
  json += '  "source": "' + jsonEscape(doc.name) + '",\n';
  json += '  "segments": [\n';
  for (var s = 0; s < segments.length; s++) {
    json += '    { "id": "' + jsonEscape(segments[s].id) + '", "text": "' + jsonEscape(segments[s].text) + '" }';
    json += (s < segments.length - 1) ? ',\n' : '\n';
  }
  json += '  ]\n';
  json += '}\n';

  // --- Speicherort waehlen -------------------------------------------------
  var defaultName = doc.name.replace(/\.[^.]+$/, '') + '.aijson';
  var saveFile = File.saveDialog('Austauschdatei speichern (' + defaultName + ')', 'Illustrator-Austausch:*.aijson');
  if (!saveFile) { return; }
  if (saveFile.name.indexOf('.aijson') === -1) {
    saveFile = new File(saveFile.fsName + '.aijson');
  }

  saveFile.encoding = 'UTF-8';
  saveFile.open('w');
  saveFile.write(json);
  saveFile.close();

  // Dokument muss gespeichert werden, damit die gestempelten IDs erhalten bleiben
  var hint = stamped > 0
    ? '\n\nWICHTIG: ' + stamped + ' Frames bekamen neue IDs. Bitte das .ai-Dokument SPEICHERN, sonst schlaegt der Reimport fehl.'
    : '';

  alert(
    'Export fertig.\n\n' +
    segments.length + ' Segmente exportiert' +
    (skippedEmpty > 0 ? ' (' + skippedEmpty + ' leere uebersprungen)' : '') +
    '.\nDatei: ' + saveFile.fsName + hint
  );
})();
