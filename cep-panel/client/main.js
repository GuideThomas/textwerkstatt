/*
 * Textwerkstatt — CEP Panel Logik (1.1.0, 28.10.2026)
 *
 * Anmeldung (PLAN-panel-anmeldung.md):
 *   „Mit Microsoft anmelden" -> POST /api/cep/pair -> Code anzeigen, Browser öffnen
 *   -> die Person bestätigt in der Web-App -> POST /api/cep/pair/:id/poll liefert
 *   EINMAL den persönlichen Schlüssel -> ab dann `Authorization: Bearer`.
 *   Übergang: Ohne persönlichen Schlüssel gilt noch der alte CEP_SERVICE_KEY
 *   (unter „Erweitert"). Meldet der Server `panel_token_invalid` (getrennt,
 *   verfallen, Konto deaktiviert), wird der Schlüssel gelöscht.
 *
 * Ablauf beim Klick auf „Übersetzen":
 *   1. host cepExportSegments()  -> { source, segments:[{id,text}] } (+ stempelt IDs, speichert Doc)
 *   2. POST /api/cep/jobs        -> Projekt anlegen + einreihen
 *   3. Poll /api/cep/jobs/:id    -> bis status=completed
 *   4. GET  /api/cep/jobs/:id/result -> übersetzte Segmente
 *   5. (Button) host cepSaveLanguageCopy(lang) -> <Name>_<LANG>.ai, Original bleibt
 *      danach host cepImportSegments(uriEncoded, true) -> in die Kopie, speichern
 */
(function () {
  'use strict';

  var VERSION = '1.1.0';
  var cs = new CSInterface();
  var LS_BASE = 'textwerkstatt_apiBase';
  var LS_KEY = 'textwerkstatt_serviceKey';
  var LS_TOKEN = 'textwerkstatt_panelToken';
  var LS_USER = 'textwerkstatt_panelUser';
  var DEFAULT_BASE = 'http://localhost:3006';
  var PAIR_POLL_MS = 2000;

  // --- DOM ----------------------------------------------------------------
  var el = function (id) { return document.getElementById(id); };
  var translateBtn = el('translateBtn');
  var importBtn = el('importBtn');
  var importBox = el('importBox');
  var statusBox = el('status');
  var settingsToggle = el('settingsToggle');
  var settingsBox = el('settings');
  var saveSettingsBtn = el('saveSettings');
  var apiBaseInput = el('apiBase');
  var serviceKeyInput = el('serviceKey');
  var accountIn = el('accountIn');
  var accountOut = el('accountOut');
  var accountName = el('accountName');
  var legacyHint = el('legacyHint');
  var loginBtn = el('loginBtn');
  var logoutBtn = el('logoutBtn');
  var pairBox = el('pairBox');
  var pairCode = el('pairCode');
  var pairUrl = el('pairUrl');
  var pairCancel = el('pairCancel');

  var pendingResult = null; // { segments:[{id,text}], lang }
  var pairing = null;       // { id, secret, deadline, timer }

  el('version').textContent = 'Version ' + VERSION;

  // --- Einstellungen und Anmeldung (localStorage) --------------------------
  function getBase() { return (localStorage.getItem(LS_BASE) || DEFAULT_BASE).replace(/\/+$/, ''); }
  function getKey() { return localStorage.getItem(LS_KEY) || ''; }
  function getToken() { return localStorage.getItem(LS_TOKEN) || ''; }
  function setToken(token, name) {
    localStorage.setItem(LS_TOKEN, token);
    localStorage.setItem(LS_USER, name || '');
  }
  function clearToken() {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_USER);
  }

  apiBaseInput.value = getBase();
  serviceKeyInput.value = getKey();

  settingsToggle.addEventListener('click', function () {
    settingsBox.classList.toggle('hidden');
  });
  saveSettingsBtn.addEventListener('click', function () {
    localStorage.setItem(LS_BASE, apiBaseInput.value.trim() || DEFAULT_BASE);
    localStorage.setItem(LS_KEY, serviceKeyInput.value.trim());
    setStatus('Einstellungen gespeichert.', 'ok');
    settingsBox.classList.add('hidden');
    renderAccount();
  });

  function renderAccount() {
    var signedIn = !!getToken();
    accountIn.classList.toggle('hidden', !signedIn || !!pairing);
    accountOut.classList.toggle('hidden', signedIn || !!pairing);
    pairBox.classList.toggle('hidden', !pairing);
    legacyHint.classList.toggle('hidden', signedIn || !getKey());
    accountName.textContent = localStorage.getItem(LS_USER) || '';
  }

  // --- Status-Helfer ------------------------------------------------------
  function setStatus(msg, kind) {
    statusBox.textContent = msg;
    statusBox.className = 'status ' + (kind || '');
    statusBox.classList.remove('hidden');
  }
  function busy(on) {
    translateBtn.disabled = on;
    translateBtn.textContent = on ? 'Läuft…' : 'Übersetzen';
  }

  // --- fetch ---------------------------------------------------------------
  // request() liefert { status, data } und wirft nur bei Netzfehlern.
  function request(method, pathPart, body, noAuth) {
    var headers = {};
    if (!noAuth) {
      var token = getToken();
      if (token) { headers.Authorization = 'Bearer ' + token; }
      else if (getKey()) { headers['X-Service-Key'] = getKey(); }
    }
    var opts = { method: method, headers: headers };
    if (body) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(getBase() + pathPart, opts).then(function (resp) {
      return resp.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = { error: txt }; }
        // Getrennt, verfallen oder Konto deaktiviert: Schlüssel weg, neu anmelden.
        if (resp.status === 401 && data && data.code === 'panel_token_invalid') {
          clearToken();
          renderAccount();
        }
        return { status: resp.status, data: data };
      });
    });
  }
  function errorText(r) { return (r.data && r.data.error) ? r.data.error : ('HTTP ' + r.status); }
  function api(method, pathPart, body) {
    return request(method, pathPart, body).then(function (r) {
      if (r.status < 200 || r.status >= 300) { throw new Error(errorText(r)); }
      return r.data;
    });
  }

  // --- ExtendScript-Aufruf als Promise ------------------------------------
  function evalHost(script) {
    return new Promise(function (resolve) {
      cs.evalScript(script, function (res) { resolve(res); });
    });
  }

  // --- Anmeldung mit Microsoft --------------------------------------------
  function startLogin() {
    loginBtn.disabled = true;
    setStatus('Anmeldung wird vorbereitet…', '');
    evalHost('cepHostInfo()').then(function (label) {
      if (!label || label.indexOf('ERROR') === 0) { label = ''; }
      return request('POST', '/api/cep/pair', { label: label }, true);
    }).then(function (r) {
      if (r.status !== 201) { throw new Error(errorText(r)); }
      pairing = {
        id: r.data.pairingId,
        secret: r.data.pollSecret,
        deadline: Date.now() + r.data.expiresInSeconds * 1000,
        timer: null
      };
      pairCode.textContent = r.data.code;
      pairUrl.value = r.data.verifyUrl;
      renderAccount();
      setStatus('Browser geöffnet — bitte dort anmelden und bestätigen.', '');
      cs.openURLInDefaultBrowser(r.data.verifyUrl);
      pairing.timer = setTimeout(pollPairing, PAIR_POLL_MS);
    }).catch(function (err) {
      stopLogin('Anmeldung nicht möglich: ' + err.message, 'err');
    });
  }

  function pollPairing() {
    if (!pairing) { return; }
    if (Date.now() > pairing.deadline) {
      stopLogin('Anmeldung abgelaufen — bitte erneut auf „Mit Microsoft anmelden“ klicken.', 'err');
      return;
    }
    var current = pairing;
    request('POST', '/api/cep/pair/' + current.id + '/poll', { pollSecret: current.secret }, true).then(function (r) {
      if (pairing !== current) { return; } // inzwischen abgebrochen
      if (r.status === 202) { current.timer = setTimeout(pollPairing, PAIR_POLL_MS); return; }
      if (r.status === 200 && r.data && r.data.token) {
        setToken(r.data.token, r.data.user && r.data.user.name);
        stopLogin('✓ Angemeldet als ' + (r.data.user && r.data.user.name) + '.', 'ok');
        return;
      }
      stopLogin('Anmeldung fehlgeschlagen: ' + errorText(r), 'err');
    }).catch(function () {
      // Netz kurz weg: weiter versuchen, bis die Anfrage abläuft
      if (pairing === current) { current.timer = setTimeout(pollPairing, PAIR_POLL_MS); }
    });
  }

  function stopLogin(msg, kind) {
    if (pairing && pairing.timer) { clearTimeout(pairing.timer); }
    pairing = null;
    loginBtn.disabled = false;
    renderAccount();
    if (msg) { setStatus(msg, kind); }
  }

  loginBtn.addEventListener('click', startLogin);
  pairCancel.addEventListener('click', function () { stopLogin('Anmeldung abgebrochen.', ''); });
  pairUrl.addEventListener('focus', function () { pairUrl.select(); });

  logoutBtn.addEventListener('click', function () {
    // Verbindung auch am Server trennen; klappt das nicht, bleibt sie in der Web-App sichtbar.
    request('DELETE', '/api/cep/token').catch(function () {}).then(function () {
      clearToken();
      renderAccount();
      setStatus('Abgemeldet. Die Verbindung dieses Rechners ist getrennt.', '');
    });
  });

  // Beim Öffnen: gilt der gespeicherte Schlüssel noch, und für wen?
  renderAccount();
  if (getToken()) {
    api('GET', '/api/cep/me').then(function (me) {
      if (me && me.kind === 'personal') {
        localStorage.setItem(LS_USER, me.user.name);
        renderAccount();
      }
    }).catch(function (err) {
      if (!getToken()) { setStatus('Verbindung wurde getrennt — bitte neu anmelden. (' + err.message + ')', 'err'); }
    });
  }

  // --- Polling ------------------------------------------------------------
  function pollUntilDone(projectId, onProgress) {
    var attempts = 0;
    var MAX_ATTEMPTS = 400; // ~10 min bei 1.5s
    return new Promise(function (resolve, reject) {
      function tick() {
        attempts++;
        if (attempts > MAX_ATTEMPTS) { reject(new Error('Timeout beim Warten auf die Übersetzung')); return; }
        api('GET', '/api/cep/jobs/' + projectId).then(function (st) {
          if (onProgress) onProgress(st);
          if (st.status === 'completed') { resolve(st); }
          else if (st.status === 'error') { reject(new Error(st.error || 'Übersetzung fehlgeschlagen')); }
          else { setTimeout(tick, 1500); }
        }).catch(reject);
      }
      tick();
    });
  }

  // --- Hauptablauf --------------------------------------------------------
  translateBtn.addEventListener('click', function () {
    if (!getToken() && !getKey()) {
      setStatus('Bitte zuerst mit Microsoft anmelden.', 'err');
      return;
    }

    importBox.classList.add('hidden');
    pendingResult = null;
    busy(true);
    setStatus('Text aus Illustrator wird gelesen…', '');

    var sourceLang = el('sourceLang').value;
    var targetLang = el('targetLang').value;
    var glossaryDisabled = el('glossaryDisabled').checked;
    var optimizeSource = el('optimizeSource').checked;
    var channelCode = el('channelCode').value.trim();

    evalHost('cepExportSegments()').then(function (raw) {
      if (!raw || raw.indexOf('ERROR') === 0) { throw new Error(raw || 'Export fehlgeschlagen'); }
      var exported;
      try { exported = JSON.parse(raw); } catch (e) { throw new Error('Export-JSON unlesbar: ' + e.message); }
      if (!exported.segments || !exported.segments.length) { throw new Error('Keine Textrahmen gefunden'); }

      setStatus(exported.segments.length + ' Textrahmen → Server…', '');
      return api('POST', '/api/cep/jobs', {
        segments: exported.segments,
        source: exported.source,
        sourceLang: sourceLang,
        targetLangs: [targetLang],
        glossaryDisabled: glossaryDisabled,
        optimizeSource: optimizeSource,
        channelCode: channelCode || null
      });
    }).then(function (job) {
      var project = job.projects[0];
      setStatus('Übersetzung läuft (' + targetLang + ')…', '');
      return pollUntilDone(project.projectId, function (st) {
        setStatus('Übersetzung läuft (' + targetLang + ') — ' + (st.progress || 0) + '%', '');
      }).then(function () {
        return api('GET', '/api/cep/jobs/' + project.projectId + '/result');
      });
    }).then(function (result) {
      pendingResult = { segments: result.segments, lang: targetLang };
      setStatus('✓ Fertig: ' + result.segments.length + ' Segmente übersetzt (' + targetLang + ').', 'ok');
      importBox.classList.remove('hidden');
    }).catch(function (err) {
      setStatus('Fehler: ' + err.message, 'err');
    }).then(function () {
      busy(false);
    });
  });

  // --- Sprachkopie anlegen und Übersetzung einsetzen ----------------------
  importBtn.addEventListener('click', function () {
    if (!pendingResult) { return; }
    importBtn.disabled = true;
    setStatus('Lege Sprachkopie an…', '');
    var copyName = '';
    evalHost('cepSaveLanguageCopy("' + encodeURIComponent(pendingResult.lang) + '")').then(function (res) {
      if (!res || res.indexOf('OK ') !== 0) { throw new Error(res || 'Sprachkopie fehlgeschlagen'); }
      copyName = res.substring(3);
      setStatus('Schreibe Übersetzung in ' + copyName + '…', '');
      var payload = JSON.stringify({ segments: pendingResult.segments });
      return evalHost('cepImportSegments("' + encodeURIComponent(payload) + '", true)');
    }).then(function (res) {
      if (!res || res.indexOf('ERROR') === 0) { throw new Error(res || 'Import fehlgeschlagen'); }
      setStatus('✓ ' + copyName + ' angelegt und gespeichert (' + res.replace('OK ', '') + '). Das Original bleibt unverändert.', 'ok');
      pendingResult = null;
      importBox.classList.add('hidden');
    }).catch(function (err) {
      setStatus('Fehler beim Einsetzen: ' + err.message, 'err');
    }).then(function () {
      importBtn.disabled = false;
    });
  });
})();
