/*
 * Minimaler CSInterface-Shim für das Textwerkstatt-Panel.
 *
 * Kapselt nur, was wir brauchen: evalScript (ExtendScript aufrufen) +
 * Host-/Theme-Infos. Bei Bedarf kann die offizielle CSInterface.js von
 * Adobe-CEP (github.com/Adobe-CEP/CEP-Resources) hier eingesetzt werden —
 * die API-Signaturen sind kompatibel.
 */
function CSInterface() {}

/**
 * ExtendScript im Host (Illustrator) ausführen.
 * @param {string} script  JS-Ausdruck, z.B. 'cepExportSegments()'
 * @param {function} callback  bekommt das Ergebnis als String
 */
CSInterface.prototype.evalScript = function (script, callback) {
  if (typeof callback !== 'function') { callback = function () {}; }
  if (typeof window.__adobe_cep__ === 'undefined') {
    callback('ERROR: __adobe_cep__ nicht verfügbar (läuft das außerhalb von Illustrator?)');
    return;
  }
  window.__adobe_cep__.evalScript(script, callback);
};

/** Host-Umgebung (App-ID, Version, UI-Theme-Farben) als Objekt. */
CSInterface.prototype.getHostEnvironment = function () {
  try {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  } catch (e) {
    return null;
  }
};

/** Panel im Default-Browser öffnen (für Hilfe-Links). */
CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
    window.cep.util.openURLInDefaultBrowser(url);
  } else {
    window.open(url, '_blank');
  }
};
