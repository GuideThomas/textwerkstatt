/**
 * Verifikation der Store-View-/Attribut-Pipeline (Regeln 2, 3, 4, 6).
 *
 * Kein Framework im Repo — daher ein eigenständiges Skript. Es simuliert
 * "DeepL gibt den Text unverändert zurück" und prüft damit genau das, was
 * NICHT von DeepL abhängt: welche URLs umgeschrieben werden, welche unberührt
 * bleiben, welche Attribute in die Übersetzung gehen, und dass Protect→Restore
 * byte-identisch ist.
 *
 * Aufruf (braucht .env wegen config-Import):
 *   npx tsx src/scripts/verify-storeview.ts
 *
 * Bei Änderungen an storeview.ts / html-attributes.ts / html-tags.ts bitte
 * ausführen — die Fälle sind die Spezifikation der Regeln in ausführbarer Form.
 */

// Das Skript prueft reine Funktionen, braucht also keine DB. `config.ts` erzwingt
// aber beim Import DB_PASSWORD (Modul-Nebeneffekt) — daher Platzhalter setzen und
// die Module danach per require laden. `typeof import(...)` liefert dabei die
// vollen Typen, ohne einen echten Import zu erzeugen.
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'verify-only-not-used';
// Eigene Shop-Hosts für die absoluten Links unten (seit 12.11.2026 ohne Vorgabe im Code).
process.env.STOREVIEW_INTERNAL_HOSTS = process.env.STOREVIEW_INTERNAL_HOSTS ?? 'example.com,www.example.com';

const { protectLinkAttributes, restoreLinkAttributes, toStoreViewCode, applyStoreView } =
  require('../services/text/storeview') as typeof import('../services/text/storeview');
const { protectHtmlAttributes, restoreHtmlAttributes } =
  require('../services/text/html-attributes') as typeof import('../services/text/html-attributes');

let pass = 0;
let fail = 0;

function check(name: string, actual: string, expected: string) {
  if (actual === expected) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`       erwartet: ${expected}`);
    console.log(`       bekommen: ${actual}`);
  }
}

/** Protect + Restore ohne "Uebersetzung" — zeigt nur die Link-Umschreibung. */
function roundtrip(html: string, targetLang: string): string {
  const p = protectLinkAttributes(html, targetLang);
  return restoreLinkAttributes(p.protectedText, p.restoreMap);
}

console.log('\n=== Regel 3: Store-View in internen Navigationslinks ===');
check('Locale-Swap DE→EN',
  roundtrip('<a href="/de/produkt-a">A</a>', 'EN'),
  '<a href="/en/produkt-a">A</a>');
check('Locale-Swap DE→FR',
  roundtrip('<a href="/de/kategorie">K</a>', 'FR'),
  '<a href="/fr/kategorie">K</a>');
check('Injection ohne Locale',
  roundtrip('<a href="/led-praxis">L</a>', 'FR'),
  '<a href="/fr/led-praxis">L</a>');
check('Locale ohne Trailing-Slash',
  roundtrip('<a href="/de">Home</a>', 'IT'),
  '<a href="/it">Home</a>');
check('Query + Anchor bleiben erhalten',
  roundtrip('<a href="/de/x?a=1&amp;b=2#top">X</a>', 'ES'),
  '<a href="/es/x?a=1&amp;b=2#top">X</a>');
check('CZ-Store-View wird getauscht',
  roundtrip('<a href="/cz/produkt">P</a>', 'SK'),
  '<a href="/sk/produkt">P</a>');
check('Legacy /cs/ gilt als Store-View',
  roundtrip('<a href="/cs/produkt">P</a>', 'HU'),
  '<a href="/hu/produkt">P</a>');
check('Zielsprache CS erzeugt /cz/',
  roundtrip('<a href="/de/produkt">P</a>', 'CS'),
  '<a href="/cz/produkt">P</a>');
check('area-Tag ist Navigation',
  roundtrip('<area href="/de/x" shape="rect">', 'EN'),
  '<area href="/en/x" shape="rect">');
check('CS und CZ liefern dieselbe Store-View',
  `${toStoreViewCode('CS')}/${toStoreViewCode('CZ')}`,
  'cz/cz');
check('Unbekannte Sprache → kein Umschreiben',
  roundtrip('<a href="/de/x">X</a>', 'XX'),
  '<a href="/de/x">X</a>');

console.log('\n=== Nur die 9 echten Store-Views (Thomas 29.07.2026) ===');
check('Zielsprache ohne Store-View (NL) laesst Link unveraendert',
  roundtrip('<a href="/de/produkt">P</a>', 'NL'),
  '<a href="/de/produkt">P</a>');
check('Zielsprache ohne Store-View injiziert auch nicht',
  roundtrip('<a href="/led-praxis">L</a>', 'SL'),
  '<a href="/led-praxis">L</a>');
check('zweideutiges 2-Buchstaben-Segment (/at/) bleibt unangetastet',
  roundtrip('<a href="/at/aktion">A</a>', 'EN'),
  '<a href="/at/aktion">A</a>');
check('zweideutig: kein Verschlucken, kein Doppelpraefix (/no/)',
  roundtrip('<a href="/no/x">X</a>', 'IT'),
  '<a href="/no/x">X</a>');
check('dreibuchstabiges Segment wird normal praefixiert',
  roundtrip('<a href="/led/x">X</a>', 'IT'),
  '<a href="/it/led/x">X</a>');
check('absoluter Link, Zielsprache ohne Store-View',
  roundtrip('<a href="https://www.example.com/de/x">X</a>', 'NL'),
  '<a href="https://www.example.com/de/x">X</a>');

console.log('\n=== Faelle aus der Schnelluebersetzung (Screenshot 29.07.2026) ===');
check('Magento-Produkt-URL auf .html ist NAVIGATION, keine Ressource',
  roundtrip('<a href="/de/al1-regal-wandprofil-200-cm-schwarz-ral-9005-8192355.html">8192355</a>', 'ES'),
  '<a href="/es/al1-regal-wandprofil-200-cm-schwarz-ral-9005-8192355.html">8192355</a>');
check('.htm ebenso',
  roundtrip('<a href="/de/x.htm">X</a>', 'ES'),
  '<a href="/es/x.htm">X</a>');
check('{{media}}-Direktive im src bleibt unangetastet',
  roundtrip('<img src="{{media url=wysiwyg/grafik/kategorien/AL-Kategorie-Uebersicht.jpg}}" alt="AL Serie">', 'ES'),
  '<img src="{{media url=wysiwyg/grafik/kategorien/AL-Kategorie-Uebersicht.jpg}}" alt="AL Serie">');
check('color-box-span mit style bleibt strukturgleich',
  roundtrip('<span class="color-box" style="background-color: black;"></span>', 'ES'),
  '<span class="color-box" style="background-color: black;"></span>');

console.log('\n=== Regel 4: Ressourcen bleiben unveraendert ===');
check('img src mit /de/',
  roundtrip('<img src="/de/media/x.jpg" alt="">', 'EN'),
  '<img src="/de/media/x.jpg" alt="">');
check('srcset unangetastet',
  roundtrip('<img srcset="/media/a.jpg 1x, /media/b.jpg 2x">', 'EN'),
  '<img srcset="/media/a.jpg 1x, /media/b.jpg 2x">');
check('data-src unangetastet',
  roundtrip('<img data-src="/de/media/lazy.webp">', 'FR'),
  '<img data-src="/de/media/lazy.webp">');
check('PDF-Download als <a>',
  roundtrip('<a href="/de/downloads/datenblatt.pdf">DB</a>', 'EN'),
  '<a href="/de/downloads/datenblatt.pdf">DB</a>');
check('PDF ohne Asset-Ordner',
  roundtrip('<a href="/de/datenblatt.pdf">DB</a>', 'EN'),
  '<a href="/de/datenblatt.pdf">DB</a>');
check('link rel=stylesheet',
  roundtrip('<link rel="stylesheet" href="/de/css/style.css">', 'EN'),
  '<link rel="stylesheet" href="/de/css/style.css">');
check('rel=canonical',
  roundtrip('<a rel="canonical" href="/de/x">X</a>', 'EN'),
  '<a rel="canonical" href="/de/x">X</a>');
check('download-Attribut',
  roundtrip('<a download href="/de/x.zip">Z</a>', 'EN'),
  '<a download href="/de/x.zip">Z</a>');
check('/media/-Pfad ohne Endung',
  roundtrip('<a href="/media/wysiwyg/banner">B</a>', 'EN'),
  '<a href="/media/wysiwyg/banner">B</a>');
check('externe URL',
  roundtrip('<a href="https://example.org/de/x">X</a>', 'EN'),
  '<a href="https://example.org/de/x">X</a>');
check('schema-relativ (CDN)',
  roundtrip('<a href="//cdn.example.org/de/x">X</a>', 'EN'),
  '<a href="//cdn.example.org/de/x">X</a>');
check('Anchor-only',
  roundtrip('<a href="#kontakt">K</a>', 'EN'),
  '<a href="#kontakt">K</a>');
check('mailto',
  roundtrip('<a href="mailto:a@b.at">M</a>', 'EN'),
  '<a href="mailto:a@b.at">M</a>');
check('Magento-Direktive im href',
  roundtrip(`<a href="{{store url='led'}}">S</a>`, 'EN'),
  `<a href="{{store url='led'}}">S</a>`);
check('relativ ohne / bleibt',
  roundtrip('<a href="produkt-a">A</a>', 'EN'),
  '<a href="produkt-a">A</a>');

console.log('\n=== Absolute Links auf eigene Shop-Hosts (Befund Live-Daten) ===');
check('eigener Host: /de/ -> /it/',
  roundtrip('<a href="https://www.example.com/de/customer/account/create/">Konto</a>', 'IT'),
  '<a href="https://www.example.com/it/customer/account/create/">Konto</a>');
check('eigener Host ohne www',
  roundtrip('<a href="https://example.com/de/x">X</a>', 'FR'),
  '<a href="https://example.com/fr/x">X</a>');
check('eigener Host, Query bleibt',
  roundtrip('<a href="https://www.example.com/de/x?a=1#t">X</a>', 'EN'),
  '<a href="https://www.example.com/en/x?a=1#t">X</a>');
check('eigener Host, Injection ohne Locale',
  roundtrip('<a href="https://www.example.com/led-praxis">X</a>', 'EN'),
  '<a href="https://www.example.com/en/led-praxis">X</a>');
check('eigener Host, Ressource bleibt',
  roundtrip('<a href="https://www.example.com/de/media/x.pdf">P</a>', 'EN'),
  '<a href="https://www.example.com/de/media/x.pdf">P</a>');
check('eigener Host, blosse Domain bleibt',
  roundtrip('<a href="https://www.example.com/">S</a>', 'EN'),
  '<a href="https://www.example.com/">S</a>');
check('fremder Host bleibt',
  roundtrip('<a href="https://cdn.fremd.at/de/x">X</a>', 'EN'),
  '<a href="https://cdn.fremd.at/de/x">X</a>');
check('eigener Host als img src bleibt',
  roundtrip('<img src="https://www.example.com/de/media/x.jpg">', 'EN'),
  '<img src="https://www.example.com/de/media/x.jpg">');
check('schema-relativ eigener Host',
  roundtrip('<a href="//www.example.com/de/x">X</a>', 'EN'),
  '<a href="//www.example.com/en/x">X</a>');

console.log('\n=== Sentinel-Form: DeepL sieht keine URL ===');
{
  const p = protectLinkAttributes('<a href="/de/x">T</a><img src="/media/y.png">', 'EN');
  check('kein Pfad mehr im DeepL-Input',
    /\/de\/x|\/media\/y\.png/.test(p.protectedText) ? 'PFAD SICHTBAR' : 'sauber',
    'sauber');
  check('rewritten-Zaehler', String(p.rewritten), '1');
}

console.log('\n=== Regel 2: Attribute ===');
function attrRoundtrip(html: string, translate: (s: string) => string): string {
  const p = protectHtmlAttributes(html);
  return restoreHtmlAttributes(
    p.protectedText,
    p.pending,
    p.pending.map((x) => translate(x.sourceText)),
  );
}
const T = (s: string) => `[${s}]`;

check('alt + title',
  attrRoundtrip('<img alt="Warmweiss" title="Mehr Info">', T),
  '<img alt="[Warmweiss]" title="[Mehr Info]">');
check('aria-description (neu)',
  attrRoundtrip('<div aria-description="Hinweis">x</div>', T),
  '<div aria-description="[Hinweis]">x</div>');
check('aria-label + placeholder',
  attrRoundtrip('<input aria-label="Suche" placeholder="Begriff">', T),
  '<input aria-label="[Suche]" placeholder="[Begriff]">');
check('value bei submit (neu)',
  attrRoundtrip('<input type="submit" value="Senden">', T),
  '<input type="submit" value="[Senden]">');
check('value bei hidden NICHT',
  attrRoundtrip('<input type="hidden" value="42">', T),
  '<input type="hidden" value="42">');
check('value bei option NICHT',
  attrRoundtrip('<option value="warmweiss">Warmweiss</option>', T),
  '<option value="warmweiss">Warmweiss</option>');
check('label bei option',
  attrRoundtrip('<option label="Warmweiss" value="ww">', T),
  '<option label="[Warmweiss]" value="ww">');
check('meta description',
  attrRoundtrip('<meta name="description" content="LED Profile">', T),
  '<meta name="description" content="[LED Profile]">');
check('meta viewport NICHT',
  attrRoundtrip('<meta name="viewport" content="width=device-width">', T),
  '<meta name="viewport" content="width=device-width">');
check('og:title',
  attrRoundtrip('<meta property="og:title" content="Titel">', T),
  '<meta property="og:title" content="[Titel]">');
check('data-title NICHT (Regel 5)',
  attrRoundtrip('<div data-title="technisch" title="sichtbar">x</div>', T),
  '<div data-title="technisch" title="[sichtbar]">x</div>');
check('data-content-type NICHT',
  attrRoundtrip('<div data-content-type="html" data-element="main">x</div>', T),
  '<div data-content-type="html" data-element="main">x</div>');
check('leeres alt bleibt',
  attrRoundtrip('<img alt="" src="/x.png">', T),
  '<img alt="" src="/x.png">');
check('Zahlenwert bleibt',
  attrRoundtrip('<div title="230">x</div>', T),
  '<div title="230">x</div>');
check('Sentinel-Wert bleibt',
  attrRoundtrip('<img alt="__ISOLURL0__">', T),
  '<img alt="__ISOLURL0__">');
check('Quote-Kollision wird escaped',
  attrRoundtrip('<img alt="Warmweiss">', () => 'Blanc "chaud"'),
  '<img alt="Blanc &quot;chaud&quot;">');

console.log('\n=== Zusammenspiel: URL-Schutz vor Attribut-Pass ===');
{
  const html =
    '<a href="/de/led-praxis" title="LED-Praxis lesen"><img src="/media/a.jpg" alt="Strahler"></a>';
  const u = protectLinkAttributes(html, 'FR');
  const a = protectHtmlAttributes(u.protectedText);
  check('Attribut-Pass sieht keine URLs',
    String(a.pending.map((p) => p.attrName).sort()),
    'alt,title');
  let out = restoreHtmlAttributes(a.protectedText, a.pending, a.pending.map((p) => T(p.sourceText)));
  out = restoreLinkAttributes(out, u.restoreMap);
  check('Endergebnis',
    out,
    '<a href="/fr/led-praxis" title="[LED-Praxis lesen]"><img src="/media/a.jpg" alt="[Strahler]"></a>');
}

console.log('\n=== Struktur-Erhalt (Regel 6) ===');
{
  const html = `<div data-content-type="row" data-appearance="contained" style="color:#00B9F1">
  <a class="btn" href='/de/shop' target="_blank" rel="noopener">Shop</a>
  <img src="/media/x.png" srcset="/media/x.png 1x" alt="Bild" loading="lazy"/>
  <!-- Kommentar mit href="/de/x" -->
  <input type="text" placeholder="Suche" value="vorbelegt">
</div>`;
  const p = protectLinkAttributes(html, 'DE'); // gleiche Sprache → nur Schutz
  const back = restoreLinkAttributes(p.protectedText, p.restoreMap);
  check('Roundtrip byte-identisch bei gleicher Store-View', back, html);
}
{
  // Ein `>` in einem Attributwert: Tag-Match bricht ab → keine Korruption
  const html = '<a title="a > b" href="/de/x">X</a>';
  const back = roundtrip(html, 'EN');
  check('">" im Attributwert korrumpiert nicht',
    back.includes('<a title="a > b" href=') ? 'intakt' : back,
    'intakt');
}

console.log('\n=== applyStoreView direkt ===');
check('doppeltes Segment nicht verdoppeln', applyStoreView('/de/de-produkt', 'en'), '/en/de-produkt');
check('unbekanntes 2-Buchstaben-Segment unveraendert', applyStoreView('/at/x', 'en'), '/at/x');
check('kein Locale', applyStoreView('/produkt', 'en'), '/en/produkt');
check('nur Slash', applyStoreView('/', 'en'), '/en/');

console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
process.exit(fail > 0 ? 1 : 0);
