/**
 * Prüft den Schritt „Optimieren“ der Textwerkstatt (Plan `PLAN-textwerkstatt.md` §4 Phase 4, Cockpit #1840).
 * Ohne Datenbank und ohne Netz: Arten, Hausschreibweise, Schutzregeln, Laufprotokoll und KI-Endpunkt sind Attrappen, die
 * jeden Aufruf zählen und den gesendeten Körper festhalten. Echt sind der Dienst `optimieren`, die Vorschau, `kiAufrufen`
 * und die Routen; die Anmeldung (`requireAuth`, `requireAdmin`) ersetzt eine Attrappe über eine Kopfzeile.
 *
 * Aufruf:
 *   DB_PASSWORD=egal npx tsx src/scripts/check-optimieren.ts
 *
 *   A  harte Prüfung mit präparierten Antworten (die Negativtests der Fertig-Bedingung: 24 V → 12 V, fehlender
 *      Platzhalter, zurückgedrehter Hausbegriff), Säubern der Antwort, Absätze
 *   B  Dienst `optimieren` lokal und Cloud: was hinausgeht, was nicht, Laufzeile ohne Text, Kosten auch bei Fehlern,
 *      kein Ausweichen
 *   C  Routen über HTTP: Rechte, Prüfung der Eingaben, Arten anlegen und ändern
 *
 * Je Schranke gilt wie in `check-pseudonym.ts`: Ein HTTP-Code belegt nur, dass geantwortet wurde. Neben jedem Negativpfad
 * steht deshalb der Aufrufzähler der Attrappe (0 = nichts gesendet). Die Fälle mit „Review“ im Namen stammen aus dem
 * Code-Review vom 11.11.2026, die mit „Korpus“ aus dem ersten Korpuslauf.
 */
import express, { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
  OptimierArt, PruefEingabe, pruefen, zahlenAuslesen, anredeZaehlen, antwortSaeubern, absaetzeAusrichten, absaetze,
  werteVergleich, relevanteBegriffe, AusrichtKontext,
} from '../services/optimieren/pruefung';
import { optimieren, OptimierFehler, LaufZeile, OptimierAbhaengigkeiten, systemBauen, kombinationPruefen } from '../services/optimieren/optimieren';
import { verraetWert, verrateneWerte, Wert } from '../services/optimieren/werte';
import { vorschauErstellen, vorschauenLeeren, PseudonymFehler, SchutzEinstellungen } from '../services/pseudonym/vorschau';
import { PSEUDONYM_HINT } from '../services/pseudonym/pseudonymize';
import { KiAbhaengigkeiten, KiWeg, KiWegFehler, kiZustandZuruecksetzen } from '../services/ki-weg';
import type { HouseTerm } from '../services/house-terms';
import { textwerkstattRouter, OptimierSpeicher, SchutzSpeicher } from '../routes/textwerkstatt';

// ── Nachbildung von it/expect (wie check-pseudonym.ts) ──────────────────────────────────────────────────────────
let failed = 0;
let passed = 0;
const tests: { name: string; fn: () => void | Promise<void> }[] = [];
let prefix = '';
function describe(name: string, fn: () => void): void {
  const alt = prefix;
  prefix = `${alt}${name} › `;
  fn();
  prefix = alt;
}
function it(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name: prefix + name, fn });
}
class Fehlschlag extends Error {}
function expect(ist: any) {
  const fail = (was: string) => { throw new Fehlschlag(`${was}; ist: ${JSON.stringify(ist)?.slice(0, 400)}`); };
  return {
    toBe: (soll: unknown) => { if (ist !== soll) fail(`erwartet ${JSON.stringify(soll)}`); },
    toEqual: (soll: unknown) => { if (JSON.stringify(ist) !== JSON.stringify(soll)) fail(`erwartet gleich ${JSON.stringify(soll)}`); },
    toContain: (soll: string) => { if (!String(ist).includes(soll)) fail(`erwartet enthält ${JSON.stringify(soll)}`); },
    toBeNull: () => { if (ist !== null) fail('erwartet null'); },
    not: {
      toContain: (soll: string) => { if (String(ist).includes(soll)) fail(`erwartet enthält NICHT ${JSON.stringify(soll)}`); },
      toBe: (soll: unknown) => { if (ist === soll) fail(`erwartet nicht ${JSON.stringify(soll)}`); },
      toBeNull: () => { if (ist === null) fail('erwartet nicht null'); },
    },
  };
}

// ── Arten wie im Seed (045), hier als Attrappe ──────────────────────────────────────────────────────────────────
const art = (id: string, f: Partial<OptimierArt> = {}): OptimierArt => ({
  id, name: id, beschreibung: '', anweisung: `Anweisung ${id}: bitte überarbeiten.`, zahlen: 'alle', platzhalter_fehlen_erlaubt: false,
  anrede: 'beibehalten', umstellen_erlaubt: true, laenge_min: 0.85, laenge_max: 1.2, zielzeichen: false, aktiv: true, reihenfolge: 0, ...f,
});
const KORRIGIEREN = art('korrigieren', { umstellen_erlaubt: false });
const VERSTAENDLICHER = art('verstaendlicher', { laenge_min: 0.5, laenge_max: 1.6 });
const VERKAUF = art('verkaufsfoerdernd', { laenge_min: 0.5, laenge_max: 1.8 });
const KUERZEN = art('kuerzen', { zahlen: 'keine_neuen', platzhalter_fehlen_erlaubt: true, laenge_min: 0.2, laenge_max: 0.95, zielzeichen: true });
const DU = art('informell', { anrede: 'du', umstellen_erlaubt: false, laenge_max: 1.25 });
const SIE = art('formell', { anrede: 'sie', umstellen_erlaubt: false, laenge_max: 1.25 });
const AUS = art('ausgeschaltet', { aktiv: false });
const LECK = art('leck', { anweisung: 'Erwähne die Lichtleiste nie mit Namen.' });
const LECK2 = art('leck-teil', { anweisung: 'Erwähne keine Lichtleistenprofile.' });
const ARTEN = [KORRIGIEREN, VERSTAENDLICHER, VERKAUF, KUERZEN, DU, SIE, AUS, LECK, LECK2];
const person = (wert: string): Wert => ({ wert, klasse: 'PERSON' });

const HAUS: HouseTerm[] = [{ avoidTerm: 'LED-Treiber', preferredTerm: 'LED-Trafo', note: null }];

const pr = (e: Partial<PruefEingabe> & { original: string; ergebnis: string }) =>
  pruefen({ art: KORRIGIEREN, begriffe: HAUS, fehlend: null, zielzeichen: null, ...e });
const punkt = (b: ReturnType<typeof pruefen>, p: string) => b.punkte.find((x) => x.pruefung === p)!;
const zahlStufe = (a: string, b: string, artX: OptimierArt = VERSTAENDLICHER) =>
  punkt(pruefen({ original: `Text:\n${a}\nEnde.`, ergebnis: `Text:\n${b}\nEnde.`, art: artX, begriffe: HAUS, fehlend: null, zielzeichen: null }), 'zahlen');

// Für `kombinationPruefen`: Arten, Hausschreibweise, Schutzregeln; ein Modell gibt es dort nicht.
const dienstOhneKi = () => ({
  artLaden: async (id: string) => ARTEN.find((a) => a.id === id) ?? null,
  begriffeLaden: async () => HAUS,
  schutzLaden: async () => ({ aus: [], liste: [], artikelnummer: '[1-9][0-9]{4,6}' }) as SchutzEinstellungen,
});

const PRODUKT = 'Das Flexband LS24 5050 RGBW bringt bei 24 V eine Leistung von 14,4 W/m. Mit Schutzart IP67 eignet es sich für außen.';

// ═══ A. Harte Prüfung ═══════════════════════════════════════════════════════════════════════════════════════════
describe('A Zahlen und Einheiten', () => {
  it('Negativtest: 24 V → 12 V wird erkannt (verworfen)', () => {
    const b = pr({ original: PRODUKT, ergebnis: PRODUKT.replace('24 V', '12 V') });
    expect(b.ergebnis).toBe('verworfen');
    expect(punkt(b, 'zahlen').code).toBe('ZAHL_GEAENDERT');
    expect(punkt(b, 'zahlen').fehlt).toEqual(['24 V']);
    expect(punkt(b, 'zahlen').neu).toEqual(['12 V']);
  });
  it('eine erfundene Zahl wird erkannt', () => {
    const b = pr({ original: PRODUKT, ergebnis: PRODUKT.replace('für außen', 'für außen und hält 50.000 Stunden') });
    expect(punkt(b, 'zahlen').code).toBe('ZAHL_NEU');
    expect(b.ergebnis).toBe('verworfen');
  });
  it('eine weggelassene Zahl: verworfen bei „alle“, Hinweis bei „keine_neuen“ (Kürzen)', () => {
    const ohne = PRODUKT.replace(' von 14,4 W/m', '');
    expect(punkt(pr({ original: PRODUKT, ergebnis: ohne }), 'zahlen').stufe).toBe('verstoss');
    const k = pruefen({ original: PRODUKT, ergebnis: ohne, art: KUERZEN, begriffe: HAUS, fehlend: null, zielzeichen: null });
    expect(punkt(k, 'zahlen').stufe).toBe('hinweis');
    expect(punkt(k, 'zahlen').code).toBe('ZAHL_FEHLT');
  });
  it('gleichwertige Schreibungen gelten als gleich (Review M5, Korpus)', () => {
    const paare: [string, string][] = [
      ['1.200 lm', '1200 Lumen'], ['48V', '48 V'], ['89,90 €', '€ 89,90'], ['89,90 EUR', '89,90 Euro'], ['zwei Jahre', '2 Jahre'],
      ['IP67-Schutz', 'Schutzart IP67'], ['IP 67', 'IP67'], ['2700–6500 K', '2700 K bis 6500 K'], ['12/24 V', '12 V und 24 V'],
      ['24-V-Netzteil', 'Netzteil mit 24 Volt'], ['1. Erster Punkt\n2. Zweiter Punkt', 'Erster Punkt\nZweiter Punkt'], ['ip67', 'IP67'],
      ["CHF 8'940.50", 'CHF 8’940.50'], ['5 m', '5 Meter'], ['10 %', '10 Prozent'], ['50.000 h', '50.000 Stunden'],
      ['50.000 Stunden', '50.000 Betriebsstunden'], ['24VDC', '24 V DC'], ['ab 50 Stück', 'ab 50 Stk.'], ['das zweite Obergeschoss', 'das 2. OG'],
      ['am 20.11.2026', 'am 20.11.26'], ['am 20.11.2026', 'am 20. November 2026'], ['am 6. November', 'am 6. Nov.'],
      ['3 600 lm', '3 600 lm'], ['außer Acht lassen', 'nicht beachten'], ['zwanzig Spots', '20 Spots'],
      ['5 150 W Netzteile', 'fünf Netzteile mit je 150 W'], ['4 120 cm Profile', '4 Profile mit 120 cm'],
      ['-30 bis +50 °C', '−30 bis 50 °C'],
    ];
    for (const [a, b] of paare) {
      const p = zahlStufe(a, b);
      if (p.stufe !== 'ok') throw new Fehlschlag(`${a} ↔ ${b}: ${JSON.stringify(p)}`);
    }
  });
  it('eine geänderte Einheit ist eine geänderte Angabe (24 V → 24 W, 5 m → 5 mm)', () => {
    expect(zahlStufe('Das Band hat 24 V.', 'Das Band hat 24 W.').code).toBe('ZAHL_GEAENDERT');
    expect(zahlStufe('Eine 5 m Rolle.', 'Eine 5 mm Rolle.').code).toBe('ZAHL_GEAENDERT');
  });
  it('Nachprüfung Z1: eine Einheit, die nur eine Seite nennt, ist eine geänderte Angabe; Zeitwörter zählen als Einheit', () => {
    expect(zahlStufe('Es ist 5 m lang und wiegt 5 kg.', 'Es ist 5 m lang und wiegt 5 g.').stufe).toBe('verstoss');
    expect(zahlStufe('Mit 24 V und 24 W.', 'Mit 24 V und 24 A.').stufe).toBe('verstoss');
    expect(zahlStufe('Hält 50.000 h.', 'Hält 50.000 Tage.').stufe).toBe('verstoss');
    expect(zahlStufe('3 Jahre Garantie.', '3 Monate Garantie.').stufe).toBe('verstoss');
    expect(zahlStufe('zwei Jahre Garantie', '2 Monate Garantie').stufe).toBe('verstoss');
  });
  it('Nachprüfung Z1: Leerzeichen-Gruppen und Ordnungszahlen sind unsicher, nicht still gleich und nicht verworfen', () => {
    expect(zahlStufe('2 300 mm lange Profile', 'ein 2300 mm langes Profil').code).toBe('ZAHL_UNSICHER');
    expect(zahlStufe('3\u202F600 lm', '3600 lm').code).toBe('ZAHL_UNSICHER');
    expect(zahlStufe('zum zweiten Mal', 'erneut').code).toBe('ZAHL_UNSICHER');
    expect(zahlStufe('das zweite Obergeschoss', 'das 2. OG').stufe).toBe('ok');
  });
  it('Zweite Nachprüfung: eine geänderte Zifferngruppe fällt als Ganzes auf, eine geänderte Ordnungszahl mit Einheit ist ein Verstoß', () => {
    expect(zahlStufe('Zwei Panels mit je 3 600 lm, also 2 Stück.', 'Zwei Panels mit je 2 600 lm, also 3 Stück.').stufe).toBe('verstoss');
    const k = pruefen({ original: 'Das Panel liefert 3 600 lm bei 36 W.', ergebnis: 'Das Panel liefert 2 600 lm.', art: KUERZEN, begriffe: HAUS, fehlend: null, zielzeichen: null });
    expect(punkt(k, 'zahlen').stufe).toBe('verstoss');
    expect(zahlStufe('ab dem zweiten Jahr', 'ab dem dritten Jahr').stufe).toBe('verstoss');
    expect(zahlStufe('zum zweiten Mal', 'erneut').stufe).toBe('hinweis');
  });
  it('Review M2: ein weggefallenes Vorzeichen fällt auf', () => {
    expect(zahlStufe('von -20 °C bis +45 °C', 'von 20 °C bis 45 °C').stufe).toBe('verstoss');
    expect(zahlStufe('ab −20 °C', 'ab 20 °C').stufe).toBe('verstoss');
  });
  it('ein geändertes Datum, eine geänderte Bezeichnung und ein Datum am Zeilenanfang fallen auf (Review N3)', () => {
    expect(zahlStufe('Lieferung am 11.11.2026.', 'Lieferung am 12.11.2026.').stufe).toBe('verstoss');
    expect(zahlStufe('Sockel GU10 passt.', 'Sockel GU5 passt.').stufe).toBe('verstoss');
    expect(zahlStufe('12. Dezember: Abnahme', '13. Dezember: Abnahme').stufe).toBe('verstoss');
  });
  it('Review M3: vertauschte Werte verwerfen, wo die Art nichts umstellen darf, sonst nicht', () => {
    const a = 'Das Netzteil hat 230 V Eingang und 24 V Ausgang.';
    const b = 'Das Netzteil hat 24 V Eingang und 230 V Ausgang.';
    expect(zahlStufe(a, b, KORRIGIEREN).code).toBe('ZAHL_VERTAUSCHT');
    expect(zahlStufe(a, b, DU).code).toBe('ZAHL_VERTAUSCHT');
    expect(zahlStufe(a, 'Am Ausgang liegen 24 V an, am Eingang 230 V.', VERSTAENDLICHER).stufe).toBe('ok');
  });
  it('Korpus: „ein“ ↔ „1“ ist nur ein Hinweis, nicht verworfen', () => {
    expect(zahlStufe('einen zusätzlichen Tag einplanen', '1 Tag mehr einplanen').code).toBe('ZAHL_UNSICHER');
    expect(zahlStufe('einen zusätzlichen Tag einplanen', '1 Tag mehr einplanen').stufe).toBe('hinweis');
    expect(zahlStufe('1 Netzteil reicht', 'ein Netzteil reicht').stufe).toBe('hinweis');
    expect(zahlStufe('1 V reicht', '2 V reicht').stufe).toBe('verstoss');
  });
  it('Zählwerte des Auslesens', () => {
    const m = zahlenAuslesen('LS24 5050 bei 24 V, -30 °C');
    expect(m.map((x) => `${x.schluessel}|${x.einheit}`)).toEqual(['c:LS24|', 'z:5050|', 'z:24|V', 'z:-30|°C']);
  });
});

describe('A Platzhalter, Werte, Markup, Abbruch', () => {
  it('Negativtest: ein fehlender Platzhalter wird erkannt (verworfen)', () => {
    const b = pr({ original: 'Karl Moser zahlt 500 €.', ergebnis: 'Karl Moser zahlt 500 €.', fehlend: [{ platzhalter: '[PREIS_1]' }] });
    expect(b.ergebnis).toBe('verworfen');
    expect(punkt(b, 'platzhalter').code).toBe('PLATZHALTER_FEHLT');
    expect(punkt(b, 'platzhalter').fehlt).toEqual(['[PREIS_1]']);
  });
  it('beim Kürzen darf ein Platzhalter fehlen: Hinweis, nicht verworfen', () => {
    const b = pruefen({ original: 'Karl Moser zahlt 500 € für das Band.', ergebnis: 'Karl Moser zahlt.', art: KUERZEN, begriffe: HAUS, fehlend: [{ platzhalter: '[PREIS_1]' }], zielzeichen: null });
    expect(punkt(b, 'platzhalter').stufe).toBe('hinweis');
    expect(b.ergebnis).toBe('hinweis');
  });
  it('Korpus: lokal fällt ein gestrichener Name auf („Frau Steiner“ bei Informell)', () => {
    const b = pruefen({ original: 'Hallo Frau Steiner,\nzu Ihrer Frage …', ergebnis: 'Hallo,\nzu deiner Frage …', art: DU, begriffe: HAUS, fehlend: null, werte: [person('Steiner')], zielzeichen: null });
    expect(punkt(b, 'werte').code).toBe('WERT_FEHLT');
    expect(b.ergebnis).toBe('verworfen');
    const k = pruefen({ original: 'Hallo Frau Steiner, das Band ist da.', ergebnis: 'Band ist da.', art: KUERZEN, begriffe: HAUS, fehlend: null, werte: [person('Steiner')], zielzeichen: null });
    expect(punkt(k, 'werte').stufe).toBe('hinweis');
  });
  it('Werte: ein Teil eines Namens zählt nicht eigens; ganzes Wort, ohne Groß/klein', () => {
    expect(werteVergleich([person('Jakob Rainer'), person('Jakob')], 'Rainer kommt.')).toEqual({ fehlt: [], teil: ['Jakob Rainer'] });
    expect(werteVergleich([person('Jakob Rainer'), person('Jakob')], 'Ein Monteur kommt.')).toEqual({ fehlt: ['Jakob Rainer'], teil: [] });
    expect(werteVergleich([{ wert: 'Li', klasse: 'EIGEN' }], 'Die Lichtleiste.').fehlt).toEqual(['Li']);
    expect(werteVergleich([{ wert: 'Seeblick Gruppe', klasse: 'FIRMA' }], 'die SEEBLICK\ngruppe').fehlt).toEqual([]);
  });
  it('Nachprüfung W1: „Hallo Karl“ ist bei Informell ein Hinweis; eine Nummer zählt nach Ziffern', () => {
    const b = pruefen({ original: 'Sehr geehrter Herr Karl Moser, danke für die Anfrage.', ergebnis: 'Hallo Karl, danke für deine Anfrage.', art: DU, begriffe: HAUS, fehlend: null, werte: [person('Karl Moser'), person('Karl')], zielzeichen: null });
    expect(punkt(b, 'werte').code).toBe('WERT_TEILWEISE');
    expect(punkt(b, 'werte').stufe).toBe('hinweis');
    const t = pruefen({ original: 'Rufen Sie an unter 0664/1234567.', ergebnis: 'Ruf an unter 0664 1234567.', art: DU, begriffe: HAUS, fehlend: null, werte: [{ wert: '0664/1234567', klasse: 'TELEFON' }], zielzeichen: null });
    expect(punkt(t, 'werte').stufe).toBe('ok');
    const f = pruefen({ original: 'Rufen Sie an unter 0664/1234567.', ergebnis: 'Ruf an unter 0664 1234568.', art: DU, begriffe: HAUS, fehlend: null, werte: [{ wert: '0664/1234567', klasse: 'TELEFON' }], zielzeichen: null });
    expect(punkt(f, 'werte').code).toBe('WERT_FEHLT');
    const plz = pruefen({ original: 'Lager 6020, Telefon 0664 1234567.', ergebnis: 'Lager 6020 0664 1234567.', art: KORRIGIEREN, begriffe: HAUS, fehlend: null, werte: [{ wert: '0664 1234567', klasse: 'TELEFON' }], zielzeichen: null });
    expect(punkt(plz, 'werte').stufe).toBe('ok');
  });
  it('lokal ohne Werte und Cloud ohne Werte: kein Punkt „werte“', () => {
    expect(pr({ original: 'Gut so.', ergebnis: 'Gut so.' }).punkte.some((p) => p.pruefung === 'werte' || p.pruefung === 'platzhalter')).toBe(false);
  });
  it('ein verlorenes Tag wird erkannt', () => {
    expect(punkt(pr({ original: 'Das <b>neue</b> Band.', ergebnis: 'Das neue Band.' }), 'markup').code).toBe('MARKUP_GEAENDERT');
  });
  it('Review M7: eine abgeschnittene Antwort verwirft, auch beim Kürzen', () => {
    const b = pruefen({ original: PRODUKT, ergebnis: 'Das Flexband LS24 bringt bei 24 V eine Leis', art: KUERZEN, begriffe: HAUS, fehlend: null, zielzeichen: null, abgeschnitten: true });
    expect(b.ergebnis).toBe('verworfen');
    expect(b.gruende.includes('ANTWORT_ABGESCHNITTEN')).toBe(true);
  });
});

describe('A Hausschreibweise', () => {
  it('Negativtest: ein zurückgedrehter Hausbegriff wird erkannt (verworfen)', () => {
    const b = pr({ original: 'Der LED-Trafo liefert 24 V an das Band.', ergebnis: 'Der LED-Treiber liefert 24 V an das Band.' });
    expect(b.ergebnis).toBe('verworfen');
    expect(punkt(b, 'hausschreibweise').code).toBe('HAUSBEGRIFF_ZURUECK');
    expect(punkt(b, 'hausschreibweise').neu).toEqual(['LED-Treiber → LED-Trafo']);
  });
  it('ein Begriff, der schon im Original stand und stehen blieb: Hinweis', () => {
    const b = pr({ original: 'Der LED-Treiber liefert 24 V an das Band.', ergebnis: 'Der LED-Treiber liefert 24 V an das Band.' });
    expect(punkt(b, 'hausschreibweise').stufe).toBe('hinweis');
  });
  it('Review M6: ein weicher Trennstrich im Original macht den Begriff im Ergebnis nicht „zurückgekehrt“', () => {
    const b = pr({ original: 'Der LED-Trei­ber liefert 24 V an das Band.', ergebnis: 'Der LED-Treiber liefert 24 V an das Band.' });
    expect(punkt(b, 'hausschreibweise').code).toBe('HAUSBEGRIFF_OFFEN');
  });
  it('ohne Liste gilt die Prüfung als nicht bestanden, nicht als bestanden', () => {
    expect(punkt(pr({ original: 'Gut so.', ergebnis: 'Gut so.', begriffe: null }), 'hausschreibweise').code).toBe('HAUSSCHREIBWEISE_UNGEPRUEFT');
  });
  it('Review H1: ein Hausbegriff, dessen eine Hälfte verdeckt ist, geht nicht in die Anweisung', () => {
    const terme: HouseTerm[] = [{ avoidTerm: 'Lichtleiste', preferredTerm: 'LED-Leiste', note: null }, { avoidTerm: 'Netzteil', preferredTerm: 'Brennhofer-Trafo', note: null }];
    expect(relevanteBegriffe('Die LED-Leiste ersetzt die alte [BEGRIFF_1].', terme, ['Lichtleiste'])).toEqual([]);
    expect(relevanteBegriffe('Das Netzteil vom [BEGRIFF_1].', terme, ['Brennhofer-Trafo'])).toEqual([]);
    expect(relevanteBegriffe('Das Netzteil und die LED-Leiste.', terme, []).length).toBe(2);
  });
  it('Nachprüfung H1-Rest: auch als Wortteil und gebeugt geht kein verdeckter Wert in die Anweisung', () => {
    expect(relevanteBegriffe('Das LED-Profil ersetzt das alte.', [{ avoidTerm: 'Lichtleistenprofil', preferredTerm: 'LED-Profil', note: null }], ['Lichtleiste'])).toEqual([]);
    expect(relevanteBegriffe('Das Netzteil liefert 24 V.', [{ avoidTerm: 'Netzteil', preferredTerm: 'Brennhofers Trafo', note: null }], ['Brennhofer'])).toEqual([]);
    expect(relevanteBegriffe('Der LED-Treiber liefert 24 V.', [{ avoidTerm: 'LED-Treiber', preferredTerm: 'Mayrtrafo', note: null }], ['Mayr'])).toEqual([]);
    expect(verrateneWerte('Erwähne keine Lichtleistenprofile.', ['Lichtleiste'])).toEqual(['Lichtleiste']);
    expect(verraetWert('Das Licht ist hell.', 'Li')).toBe(false);
    expect(verraetWert('Herr Li kommt.', 'Li')).toBe(true);
    // Andere Schreibung desselben Wortes (zweite Nachprüfung).
    expect(verraetWert('Schreibe „Mueller-Trafo“.', 'Müller')).toBe(true);
    expect(verraetWert('Schreibe „Müllerlicht-Trafo“.', 'Müller-Licht')).toBe(true);
    expect(verraetWert('Schreibe „Mu\u0308ller-Trafo“.', 'Müller')).toBe(true);
    expect(relevanteBegriffe('Der Trafo liefert 24 V.', [{ avoidTerm: 'Trafo', preferredTerm: 'Mueller-Trafo', note: null }], ['Müller'])).toEqual([]);
  });
});

describe('A Anrede', () => {
  it('Zählen: „Sie“ am Satzanfang zählt eigens, mitten im Satz als gesiezt', () => {
    expect(anredeZaehlen('Sie erhalten das Band.')).toEqual({ du: 0, sie: 0, sieAnfang: 1 });
    expect(anredeZaehlen('Bestellen Sie heute, wir senden Ihnen Ihre Ware.')).toEqual({ du: 0, sie: 3, sieAnfang: 0 });
    expect(anredeZaehlen('Bestell dir dein Band, du wirst es mögen.')).toEqual({ du: 3, sie: 0, sieAnfang: 0 });
  });
  it('Informell: ein „Sie“ mitten im Satz verwirft, am Satzanfang ist es ein Hinweis (Review M4)', () => {
    const t = (e: string) => punkt(pruefen({ original: 'Bestellen Sie heute.', ergebnis: e, art: DU, begriffe: HAUS, fehlend: null, zielzeichen: null }), 'anrede');
    expect(t('Bestell heute, dann senden wir Ihnen alles.').code).toBe('ANREDE_SIE');
    expect(t('Sie erhalten 5 m Band. Bestell heute.').code).toBe('ANREDE_MEHRDEUTIG');
    expect(t('Bestell heute.\n• Ihr Vorteil: 24 V').code).toBe('ANREDE_MEHRDEUTIG');
  });
  it('Formell: ein „du“ im Ergebnis verwirft', () => {
    const b = pruefen({ original: 'Bestell dir heute dein Band.', ergebnis: 'Bestellen Sie heute dein Band.', art: SIE, begriffe: HAUS, fehlend: null, zielzeichen: null });
    expect(punkt(b, 'anrede').code).toBe('ANREDE_DU');
  });
  it('beibehalten: Wechsel verwirft, auch wenn das Original nur am Satzanfang siezt (Review M4); neu eingeführte Anrede ist ein Hinweis', () => {
    expect(punkt(pr({ original: 'Bestellen Sie heute, wir liefern Ihnen morgen.', ergebnis: 'Bestell heute, wir liefern dir morgen.' }), 'anrede').code).toBe('ANREDE_GEWECHSELT');
    expect(punkt(pr({ original: 'Sie erhalten das Band morgen. Sie sparen damit Strom.', ergebnis: 'Du erhältst das Band morgen. Du sparst damit Strom.' }), 'anrede').code).toBe('ANREDE_GEWECHSELT');
    const n = pruefen({ original: 'Das Band ist robust und hell.', ergebnis: 'Erleben Sie das robuste, helle Band.', art: VERKAUF, begriffe: HAUS, fehlend: null, zielzeichen: null });
    expect(punkt(n, 'anrede').stufe).toBe('hinweis');
  });
});

describe('A Länge und Zielzahl', () => {
  const lang = 'Ein ausreichend langer Satz über ein Band, das hell leuchtet und lange hält.';
  it('Korrigieren: doppelt so lang verwirft', () => {
    expect(punkt(pr({ original: lang, ergebnis: `${lang} ${lang}` }), 'laenge').code).toBe('LAENGE_LANG');
    expect(pr({ original: lang, ergebnis: `${lang} ${lang}` }).ergebnis).toBe('verworfen');
  });
  it('kurzer Text: nur ein Hinweis', () => {
    expect(punkt(pr({ original: 'Hallo.', ergebnis: 'Hallo und guten Tag.' }), 'laenge').stufe).toBe('hinweis');
  });
  it('Zielzahl: überschritten ist ein Hinweis, die untere Grenze gilt nicht', () => {
    const b = pruefen({ original: lang, ergebnis: 'Band, hell.', art: KUERZEN, begriffe: HAUS, fehlend: null, zielzeichen: 5 });
    expect(punkt(b, 'laenge').stufe).toBe('ok');
    expect(punkt(b, 'zielzeichen').code).toBe('ZIEL_UEBERSCHRITTEN');
  });
  it('alles bestanden: ok und keine Gründe', () => {
    const b = pr({ original: PRODUKT, ergebnis: PRODUKT.replace('eignet es sich', 'eignet es sich gut') });
    expect(b.ergebnis).toBe('ok');
    expect(b.gruende).toEqual([]);
  });
});

describe('A Säubern und Absätze', () => {
  it('Zaun, Einleitung und Anführungszeichen fallen, Rand des Originals bleibt', () => {
    expect(antwortSaeubern('```\nNeuer Text.\n```', 'Alter Text.')).toBe('Neuer Text.');
    expect(antwortSaeubern('Hier ist der überarbeitete Text:\n\nNeuer Text.', 'Alter Text.')).toBe('Neuer Text.');
    expect(antwortSaeubern('„Neuer Text.“', 'Alter Text.')).toBe('Neuer Text.');
    expect(antwortSaeubern('„A“ und „B“', 'x')).toBe('„A“ und „B“');
    expect(antwortSaeubern('Neu.', '\nAlt.\n\n')).toBe('\nNeu.\n\n');
  });
  it('Review N6: eine Inhaltszeile mit „Gerne … :“ bleibt stehen; Review N7: CRLF wird LF', () => {
    expect(antwortSaeubern('Gerne stellen wir Ihnen unser Band vor:\n\n• 24 V\n• IP67', 'x')).toBe('Gerne stellen wir Ihnen unser Band vor:\n\n• 24 V\n• IP67');
    expect(antwortSaeubern('Eins, 24 V.\r\nZwei, 3000 K.', 'Eins.\nZwei.')).toBe('Eins, 24 V.\nZwei, 3000 K.');
  });
  it('Review M6: unveränderte Zeilen kommen aus dem Original, samt geschützten Leerzeichen', () => {
    const o = 'Das Panel liefert 3 600 lm.\nZweite Zeile.';
    expect(antwortSaeubern('Das Panel liefert 3 600 lm.\nZweite Zeile, neu.', o)).toBe('Das Panel liefert 3 600 lm.\nZweite Zeile, neu.');
  });
  const ctx: AusrichtKontext = { art: VERSTAENDLICHER, begriffe: HAUS, werte: [person('Karl Moser')] };
  it('Absätze: gleich viele → Paare; gleichwertige wählbar; ungleich oder einer → null', () => {
    const a = absaetzeAusrichten('Der erste Absatz mit 24 V hier.\n\nDer zweite Absatz mit 3000 K hier.', 'Der erste Absatz hat 24 V hier.\n\nDer zweite Absatz hat 3000 K hier.', ctx);
    expect(a!.map((x) => x.waehlbar)).toEqual([true, true]);
    expect(absaetzeAusrichten('Eins.\nZwei.', 'Eins und zwei.', ctx)).toBeNull();
    expect(absaetzeAusrichten('Nur einer.', 'Nur einer!', ctx)).toBeNull();
    expect(absaetze('a\n\n  \nb\n')).toEqual(['a', 'b']);
  });
  it('Review M9: verschobene Zahl, Tag, Hausbegriff, Wert, falsche Zuordnung und du/Sie sperren den Absatz', () => {
    const g = (alt: string, neu: string, k: AusrichtKontext = ctx) => absaetzeAusrichten(alt, neu, k)!.map((x) => x.grund);
    expect(g('Das Band hat 24 V Spannung.\nEs hat 3000 K Farbe.', 'Das Band hat 24 V und 3000 K.\nEs hat eine Farbe.')).toEqual(['zahlen', 'zahlen']);
    expect(g('Das <b>neue</b> Band ist da.\nEs leuchtet hell.', 'Das neue Band ist da.\nEs leuchtet <b>neu</b> und hell.')).toEqual(['markup', 'markup']);
    expect(g('Der LED-Trafo liefert Strom.\nDas Band leuchtet.', 'Der Trafo liefert Strom.\nDas Band am LED-Treiber leuchtet.')).toEqual([null, 'hausschreibweise']);
    expect(g('Karl Moser bestellt das Band.\nEs kommt morgen.', 'Das Band wird bestellt.\nEs kommt morgen zu Karl Moser.')).toEqual(['werte', 'werte']);
    expect(g('Sehr geehrte Frau Huber,\ndanke für Ihre Anfrage zum Band.', 'Mit freundlichen Grüßen,\nIhr Team vom Lager')).toEqual(['zuordnung', 'zuordnung']);
    expect(g('Bestellen Sie das Band.\nSie bekommen es morgen.', 'Bestellen Sie das Band.\nDu bekommst es morgen.', { ...ctx, art: SIE })).toEqual(['gleich', 'anrede']);
  });
  it('Nachprüfung M9-Rest: ein verlängerter Absatz ist einzeln gesperrt, und die Kombination prüft der Server', async () => {
    const alt = 'Das Flexband bringt bei 24 V eine gute Leistung für jeden Raum.\nEs ist einfach zu montieren und hält sehr lange.';
    const neu = 'Das Flexband bringt bei 24 V eine gute Leistung für jeden Raum. Es ist das beste Band am Markt und hält ewig.\nEs ist leicht montiert.';
    expect(pruefen({ original: alt, ergebnis: neu, art: KORRIGIEREN, begriffe: HAUS, fehlend: null, zielzeichen: null }).ergebnis).toBe('ok');
    expect(absaetzeAusrichten(alt, neu, { ...ctx, art: KORRIGIEREN })!.map((x) => x.grund)).toEqual(['laenge', 'laenge']);
    const nurErster = `${neu.split('\n')[0]}\n${alt.split('\n')[1]}`;
    const b = await kombinationPruefen({ artId: 'korrigieren', original: alt, text: nurErster }, dienstOhneKi());
    expect(b.ergebnis).toBe('verworfen');
    expect(b.gruende.includes('LAENGE_LANG')).toBe(true);
  });
  it('Zweite Nachprüfung: die Kombination prüft mit der Zielzahl des Laufs', async () => {
    const alt = 'Ein ausreichend langer erster Absatz über ein Band, das hell leuchtet und lange hält.\nEin zweiter Absatz, der ebenfalls ausreichend lang ist und vom Licht erzählt.';
    const kurz = 'Band, hell.\nVom Licht.';
    const ohne = await kombinationPruefen({ artId: 'kuerzen', original: alt, text: kurz }, dienstOhneKi());
    expect(ohne.gruende.includes('LAENGE_KURZ')).toBe(true);
    const mit = await kombinationPruefen({ artId: 'kuerzen', original: alt, text: kurz, zielzeichen: 20 }, dienstOhneKi());
    expect(mit.gruende.includes('LAENGE_KURZ')).toBe(false);
  });
  it('Laufzeit: 600 Werte bei 10.000 Zeichen', () => {
    const werte = Array.from({ length: 600 }, (_, i) => person(`Vorname${i} Nachname${i}`));
    const text = werte.slice(0, 300).map((w) => w.wert).join(', ').padEnd(10_000, ' x').slice(0, 10_000);
    const start = Date.now();
    pruefen({ original: text, ergebnis: text, art: VERKAUF, begriffe: HAUS, fehlend: null, werte, zielzeichen: null });
    absaetzeAusrichten(`${text.slice(0, 5000)}\n${text.slice(5000)}`, `${text.slice(0, 5000)} neu\n${text.slice(5000)}`, { art: VERKAUF, begriffe: HAUS, werte });
    const ms = Date.now() - start;
    if (ms > 1000) throw new Fehlschlag(`${ms} ms`);
  });
});

// ═══ B. Dienst ═══════════════════════════════════════════════════════════════════════════════════════════════════
const aufrufe: { modell: string; body: any }[] = [];
let naechsteAntwort: (body: any) => string = (body) => body.messages[1].content;
let naechstesEnde: string = 'stop';
let stationWeg = false;
const WEG_LOKAL: KiWeg = {
  id: 'lokal', name: 'Lokal', art: 'lokal', modell: 'station-test', endpunkt_variable: 'KI_WEG_TEST_URL', schluessel_variable: 'KI_WEG_LOKAL_KEY',
  zeitlimit_s: 5, zusatz_parameter: {}, budget_lesen: false, aktiv: true, reihenfolge: 1,
};
const WEG_CLOUD: KiWeg = { ...WEG_LOKAL, id: 'cloud', name: 'Cloud', art: 'cloud', modell: 'cloud-test', schluessel_variable: 'KI_WEG_CLOUD_KEY', reihenfolge: 2 };
const ki: KiAbhaengigkeiten = {
  wegLaden: async (id) => ({ lokal: WEG_LOKAL, cloud: WEG_CLOUD } as Record<string, KiWeg>)[id] ?? null,
  wegeLaden: async () => [WEG_LOKAL, WEG_CLOUD],
  darfCloud: async (nutzer) => nutzer === 'nutzer-frei' || nutzer === 'admin-frei',
  env: (n) => ({ KI_WEG_TEST_URL: 'http://attrappe.invalid/v1', KI_WEG_LOKAL_KEY: 'k-lokal', KI_WEG_CLOUD_KEY: 'k-cloud' } as Record<string, string>)[n],
  client: () => ({
    create: async (body) => {
      if (stationWeg && body.model === 'station-test') throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'APIConnectionError' });
      aufrufe.push({ modell: String(body.model), body });
      return {
        data: { choices: [{ message: { content: naechsteAntwort(body) }, finish_reason: naechstesEnde }], usage: { prompt_tokens: 12, completion_tokens: 7 } },
      };
    },
  }),
  holeJson: async () => ({ status: 404, body: null }),
  jetzt: () => Date.now(),
};
const zaehle = (modell: string) => aufrufe.filter((a) => a.modell === modell).length;

const laeufe: LaufZeile[] = [];
const verbrauch: { modell: string }[] = [];
let begriffeKaputt = false;
let schutzKaputt = false;
const schutz: SchutzEinstellungen = { aus: [], liste: [{ begriff: 'Seeblick Gruppe', art: 'FIRMA' }], artikelnummer: '[1-9][0-9]{4,6}' };
const quelle = { laden: async () => schutz };
const dienst: OptimierAbhaengigkeiten = {
  ki,
  artLaden: async (id) => ARTEN.find((a) => a.id === id) ?? null,
  begriffeLaden: async () => { if (begriffeKaputt) throw new Error('DB weg'); return HAUS; },
  schutzLaden: async () => { if (schutzKaputt) throw new Error('DB weg'); return schutz; },
  laufMerken: async (z) => { laeufe.push(z); },
  verbrauchMerken: async (modell) => { verbrauch.push({ modell }); },
};

const fehlerCode = async (f: () => Promise<unknown>): Promise<string> => {
  try { await f(); } catch (err) {
    if (err instanceof OptimierFehler || err instanceof PseudonymFehler || err instanceof KiWegFehler) return err.code;
    return `ANDERER:${(err as Error).message}`;
  }
  return 'KEIN_FEHLER';
};

const MAIL = 'Sehr geehrter Herr Karl Moser, die Seeblick Gruppe erhält das Band LS24 5050 RGBW mit 24 V für 4.860,00 €. Bitte bestellen Sie bis 20.11.2026.';

describe('B Dienst lokal', () => {
  it('der Text geht an den lokalen Weg, mit Anweisung der Art und Rahmen, mit no-log; Ergebnis geprüft, Laufzeile ohne Text', async () => {
    const vorher = aufrufe.length;
    naechsteAntwort = (body) => body.messages[1].content.replace('erhält', 'bekommt');
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'korrigieren', wegId: 'lokal', text: MAIL }, dienst);
    expect(aufrufe.length).toBe(vorher + 1);
    const a = aufrufe[aufrufe.length - 1]!;
    expect(a.modell).toBe('station-test');
    expect(a.body.messages[1].content).toBe(MAIL);
    expect(a.body.messages[0].content).toContain(KORRIGIEREN.anweisung);
    expect(a.body.messages[0].content).toContain('Antworte nur mit dem überarbeiteten Text');
    expect(a.body.messages[0].content).not.toContain(PSEUDONYM_HINT);
    // Review N2: Lokal steht no-log im Körper, auch wenn der Weg keine Zusatzparameter hat.
    expect(a.body['no-log']).toBe(true);
    expect(r.befund.ergebnis).toBe('ok');
    expect(r.befund.punkte.find((p) => p.pruefung === 'werte')!.stufe).toBe('ok');
    expect(r.text).toContain('bekommt');
    expect(r.original).toBe(MAIL);
    const z = laeufe[laeufe.length - 1]!;
    expect(z.ergebnis).toBe('ok');
    expect(z.wegArt).toBe('lokal');
    expect(z.eingabeToken).toBe(12);
    for (const w of ['Moser', 'Seeblick', 'bekommt', 'LS24', '4.860']) expect(JSON.stringify(z)).not.toContain(w);
    expect(verbrauch[verbrauch.length - 1]!.modell).toBe('station-test');
  });
  it('Negativtest über den Dienst: 24 V → 12 V verworfen, Grund in der Laufzeile', async () => {
    naechsteAntwort = (body) => body.messages[1].content.replace('24 V', '12 V');
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: MAIL }, dienst);
    expect(r.befund.ergebnis).toBe('verworfen');
    expect(laeufe[laeufe.length - 1]!.pruefgruende).toEqual(['ZAHL_GEAENDERT']);
    expect(laeufe[laeufe.length - 1]!.ergebnis).toBe('verworfen');
  });
  it('Korpus: ein gestrichener Name verwirft lokal über die erkannten Werte', async () => {
    naechsteAntwort = (body) => body.messages[1].content.replace('Herr Karl Moser', 'Kunde');
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'lokal', text: MAIL }, dienst);
    expect(r.befund.gruende.includes('WERT_FEHLT')).toBe(true);
    expect(r.befund.punkte.find((p) => p.pruefung === 'werte')!.fehlt).toEqual(['Karl Moser']);
  });
  it('Station nicht erreichbar: Fehler, kein Aufruf der Cloud (G2), Laufzeile „fehler“', async () => {
    stationWeg = true;
    const cloudVorher = zaehle('cloud-test');
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'lokal', text: MAIL }, dienst))).toBe('NICHT_ERREICHBAR');
    expect(zaehle('cloud-test')).toBe(cloudVorher);
    expect(laeufe[laeufe.length - 1]!.fehlerCode).toBe('NICHT_ERREICHBAR');
    stationWeg = false;
  });
  it('Hausschreibweise oder Schutzregeln nicht lesbar: 503 und kein Aufruf', async () => {
    const vorher = aufrufe.length;
    begriffeKaputt = true;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'lokal', text: MAIL }, dienst))).toBe('HAUSSCHREIBWEISE');
    begriffeKaputt = false;
    schutzKaputt = true;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'lokal', text: MAIL }, dienst))).toBe('SCHUTZREGELN');
    schutzKaputt = false;
    expect(aufrufe.length).toBe(vorher);
  });
  it('Eingaben: Art unbekannt, Art aus, Zielzahl, Platzhalter im Text, kein Text — je ohne Aufruf', async () => {
    const vorher = aufrufe.length;
    const t = (f: Partial<Parameters<typeof optimieren>[0]>) =>
      fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'lokal', text: MAIL, ...f }, dienst));
    expect(await t({ artId: 'gibt-es-nicht' })).toBe('ART_UNBEKANNT');
    expect(await t({ artId: 'ausgeschaltet' })).toBe('ART_INAKTIV');
    expect(await t({ artId: 'Kein Muster!' })).toBe('EINGABE');
    expect(await t({ artId: 'kuerzen', zielzeichen: 5 })).toBe('EINGABE');
    expect(await t({ text: 'Hallo [PERSON_1]' })).toBe('EINGABE');
    expect(await t({ text: '   ' })).toBe('TEXT_FEHLT');
    expect(await t({ wegId: 'gibt-es-nicht' })).toBe('WEG_UNBEKANNT');
    expect(await t({ channelCode: 'a b' })).toBe('EINGABE');
    expect(aufrufe.length).toBe(vorher);
  });
  it('Zielzahl geht nur bei einer Art mit Zielzahl in die Anweisung', async () => {
    naechsteAntwort = () => 'Herr Karl Moser, die Seeblick Gruppe: Band LS24 5050 RGBW, 24 V.';
    await optimieren({ nutzerId: 'nutzer-frei', artId: 'kuerzen', wegId: 'lokal', text: MAIL, zielzeichen: 60 }, dienst);
    expect(aufrufe[aufrufe.length - 1]!.body.messages[0].content).toContain('höchstens 60 Zeichen');
    naechsteAntwort = (body) => body.messages[1].content;
    await optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'lokal', text: MAIL, zielzeichen: 60 }, dienst);
    expect(aufrufe[aufrufe.length - 1]!.body.messages[0].content).not.toContain('höchstens 60 Zeichen');
  });
  it('Review M7: finish_reason „length“ verwirft das Ergebnis', async () => {
    naechstesEnde = 'length';
    naechsteAntwort = (body) => body.messages[1].content.slice(0, 60);
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'kuerzen', wegId: 'lokal', text: MAIL }, dienst);
    naechstesEnde = 'stop';
    expect(r.befund.ergebnis).toBe('verworfen');
    expect(r.befund.gruende[0]).toBe('ANTWORT_ABGESCHNITTEN');
  });
  it('Review M8: eine leere Antwort kostet trotzdem und steht mit Token in der Laufzeile', async () => {
    naechsteAntwort = () => '';
    const v = verbrauch.length;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'lokal', text: MAIL }, dienst))).toBe('LEERE_ANTWORT');
    expect(verbrauch.length).toBe(v + 1);
    expect(laeufe[laeufe.length - 1]!.ausgabeToken).toBe(7);
  });
  it('Review N1: lädt der Weg beim Aufruf als Cloud, geht kein Klartext hinaus', async () => {
    let n = 0;
    const wechselnd: OptimierAbhaengigkeiten = {
      ...dienst,
      ki: { ...ki, wegLaden: async (id) => (id === 'lokal' ? (n++ === 0 ? WEG_LOKAL : { ...WEG_LOKAL, art: 'cloud', schluessel_variable: 'KI_WEG_CLOUD_KEY' }) : null) },
    };
    const vorher = aufrufe.length;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'lokal', text: MAIL }, wechselnd))).toBe('KONFIGURATION');
    expect(aufrufe.length).toBe(vorher);
  });
});

describe('B Dienst Cloud', () => {
  it('ohne Vorschau: VORSCHAU_FEHLT und kein Aufruf, auch wenn ein Text mitkommt', async () => {
    const vorher = aufrufe.length;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'cloud', text: MAIL }, dienst))).toBe('VORSCHAU_FEHLT');
    expect(aufrufe.length).toBe(vorher);
  });
  it('G3: es geht genau der Text der Vorschau hinaus, nie der Text im Körper; geprüft gegen den Klartext der Vorschau', async () => {
    vorschauenLeeren();
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: MAIL }, quelle);
    naechsteAntwort = (body) => body.messages[1].content.replace('erhält', 'bekommt');
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'cloud', vorschauId: v.vorschauId, text: 'GEHEIMER TEXT AUS DEM BROWSER' }, dienst);
    const a = aufrufe[aufrufe.length - 1]!;
    expect(a.modell).toBe('cloud-test');
    expect(a.body.messages[1].content).toBe(v.ausgehend);
    const koerper = JSON.stringify(a.body);
    for (const w of ['GEHEIMER', 'Moser', 'Seeblick', '4.860']) expect(koerper).not.toContain(w);
    expect(a.body['no-log']).toBe(undefined);
    expect(a.body.messages[0].content).toContain(PSEUDONYM_HINT);
    expect(r.original).toBe(MAIL);
    expect(r.text).toContain('Karl Moser');
    expect(r.text).toContain('bekommt');
    expect(r.befund.ergebnis).toBe('ok');
    const z = laeufe[laeufe.length - 1]!;
    expect(z.wegArt).toBe('cloud');
    expect(z.platzhalter!.PERSON).toBe(1);
    expect(z.maskenVerdeckt).toBe(0);
    for (const w of ['Moser', 'Seeblick', 'bekommt']) expect(JSON.stringify(z)).not.toContain(w);
  });
  it('Negativtest über den Dienst: fehlender Platzhalter verwirft bei Korrigieren, ist ein Hinweis beim Kürzen', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: MAIL }, quelle);
    naechsteAntwort = (body) => body.messages[1].content.replace(/ für \[PREIS_1\]/, '');
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'cloud', vorschauId: v.vorschauId }, dienst);
    expect(r.befund.ergebnis).toBe('verworfen');
    expect(r.befund.gruende.includes('PLATZHALTER_FEHLT')).toBe(true);
    expect(r.fehlend.map((f) => f.klasse)).toEqual(['PREIS']);
    const k = await optimieren({ nutzerId: 'nutzer-frei', artId: 'kuerzen', wegId: 'cloud', vorschauId: v.vorschauId }, dienst);
    expect(k.befund.punkte.find((p) => p.pruefung === 'platzhalter')!.stufe).toBe('hinweis');
  });
  it('Negativtest über den Dienst: zurückgedrehter Hausbegriff verwirft', async () => {
    const text = 'Der LED-Trafo der Seeblick Gruppe liefert 24 V an das Band.';
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text }, quelle);
    naechsteAntwort = (body) => body.messages[1].content.replace('LED-Trafo', 'LED-Treiber');
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'cloud', vorschauId: v.vorschauId }, dienst);
    expect(r.befund.gruende).toEqual(['HAUSBEGRIFF_ZURUECK']);
  });
  it('Review H1: ein verdecktes Wort erreicht die Cloud in keiner Richtung über die Hausbegriffe', async () => {
    const mit = (terme: HouseTerm[]): OptimierAbhaengigkeiten => ({ ...dienst, begriffeLaden: async () => terme });
    naechsteAntwort = (body) => body.messages[1].content;
    // Richtung 1: verdeckt ist der vermiedene Begriff, im Text steht der bevorzugte.
    const v1 = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Unsere LED-Leiste ersetzt die alte Lichtleiste mit 24 V vollständig.', verdecken: ['Lichtleiste'] }, quelle);
    await optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'cloud', vorschauId: v1.vorschauId }, mit([{ avoidTerm: 'Lichtleiste', preferredTerm: 'LED-Leiste', note: null }]));
    expect(JSON.stringify(aufrufe[aufrufe.length - 1]!.body)).not.toContain('Lichtleiste');
    // Richtung 2: verdeckt ist der bevorzugte Begriff, im Text steht der vermiedene.
    const v2 = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Das Netzteil vom Brennhofer-Trafo liefert 24 V.', verdecken: ['Brennhofer-Trafo'] }, quelle);
    await optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'cloud', vorschauId: v2.vorschauId }, mit([{ avoidTerm: 'Netzteil', preferredTerm: 'Brennhofer-Trafo', note: null }]));
    expect(JSON.stringify(aufrufe[aufrufe.length - 1]!.body)).not.toContain('Brennhofer');
    expect(laeufe[laeufe.length - 1]!.maskenVerdeckt).toBe(1);
  });
  it('Review H1, Schranke: ein verdeckter Wert in der Anweisung der Art sendet nichts, auch als Wortteil', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Die alte Lichtleiste hat 24 V.', verdecken: ['Lichtleiste'] }, quelle);
    const vorher = aufrufe.length;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'leck', wegId: 'cloud', vorschauId: v.vorschauId }, dienst))).toBe('WERT_IN_ANWEISUNG');
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'leck-teil', wegId: 'cloud', vorschauId: v.vorschauId }, dienst))).toBe('WERT_IN_ANWEISUNG');
    expect(aufrufe.length).toBe(vorher);
  });
  it('Zweite Nachprüfung: ein Name, der im festen Rahmen steckt („Mark“ in „Markdown“), sperrt die Cloud nicht', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Sehr geehrter Herr Mark Huber, das Band mit 24 V ist da.' }, quelle);
    naechsteAntwort = (body) => body.messages[1].content;
    const vorher = aufrufe.length;
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'cloud', vorschauId: v.vorschauId }, dienst);
    expect(aufrufe.length).toBe(vorher + 1);
    expect(r.text).toContain('Mark Huber');
    expect(JSON.stringify(aufrufe[aufrufe.length - 1]!.body.messages[1])).not.toContain('Huber');
  });
  it('Nachprüfung H1-Rest über den Dienst: ein Hausbegriff mit dem verdeckten Wort als Wortteil geht nicht hinaus', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Mayr liefert den LED-Treiber mit 24 V.', verdecken: ['Mayr'] }, quelle);
    naechsteAntwort = (body) => body.messages[1].content;
    const vorher = aufrufe.length;
    await optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'cloud', vorschauId: v.vorschauId },
      { ...dienst, begriffeLaden: async () => [{ avoidTerm: 'LED-Treiber', preferredTerm: 'Mayrtrafo', note: null }] });
    expect(aufrufe.length).toBe(vorher + 1);
    expect(JSON.stringify(aufrufe[aufrufe.length - 1]!.body).toLowerCase()).not.toContain('mayr');
  });
  it('Review M6: geschützte Leerzeichen im Original — eine unveränderte Antwort gilt als unverändert', async () => {
    const text = 'Das Panel von Karl Moser liefert 3 600 lm bei 36 W und hält 50 000 h.';
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text }, quelle);
    naechsteAntwort = (body) => body.messages[1].content;
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'cloud', vorschauId: v.vorschauId }, dienst);
    expect(r.befund.ergebnis).toBe('ok');
    expect(r.text).toBe(text);
  });
  it('ohne Freischaltung: NICHT_FREIGESCHALTET, kein Aufruf, Laufzeile „fehler“', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-gesperrt', text: MAIL }, quelle);
    const vorher = aufrufe.length;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'korrigieren', wegId: 'cloud', vorschauId: v.vorschauId }, dienst))).toBe('NICHT_FREIGESCHALTET');
    expect(aufrufe.length).toBe(vorher);
    expect(laeufe[laeufe.length - 1]!.fehlerCode).toBe('NICHT_FREIGESCHALTET');
  });
  it('fremde Vorschau: VORSCHAU_UNBEKANNT, kein Aufruf', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: MAIL }, quelle);
    const vorher = aufrufe.length;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'admin-frei', artId: 'korrigieren', wegId: 'cloud', vorschauId: v.vorschauId }, dienst))).toBe('VORSCHAU_UNBEKANNT');
    expect(aufrufe.length).toBe(vorher);
  });
  it('erfundener Platzhalter: verworfen mit Fehler wie in Phase 3, die Kosten zählen trotzdem (Review M8)', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: MAIL }, quelle);
    naechsteAntwort = (body) => `${body.messages[1].content} Gruß [PERSON_7]`;
    const vb = verbrauch.length;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'korrigieren', wegId: 'cloud', vorschauId: v.vorschauId }, dienst))).toBe('PLATZHALTER_UNBEKANNT');
    expect(verbrauch.length).toBe(vb + 1);
    expect(laeufe[laeufe.length - 1]!.eingabeToken).toBe(12);
  });
  it('systemBauen enthält keine Werte einer Installation, nur Rahmen und Anweisung', () => {
    const s = systemBauen(KORRIGIEREN, { zielzeichen: null, markup: false, begriffe: [] });
    expect(s.toLowerCase()).not.toContain((process.env.ORGANISATION_NAME || 'Beispielfirma').toLowerCase());
    expect(s).toContain(KORRIGIEREN.anweisung);
    expect(s).toContain('Reihenfolge der Angaben bleibt');
  });
});

// ═══ C. Routen ════════════════════════════════════════════════════════════════════════════════════════════════════
function fakeAuth(admin: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.headers['x-test-user'] ?? '');
    if (!id) { res.status(401).json({ error: 'auth' }); return; }
    const role = id.startsWith('admin') ? 'admin' : 'user';
    if (admin && role !== 'admin') { res.status(403).json({ error: 'admin' }); return; }
    (req as any).user = { id, email: `${id}@test.invalid`, name: id, role, display_name: null };
    next();
  };
}
const artenSpeicher: OptimierArt[] = ARTEN.map((a) => ({ ...a }));
const optimierSpeicher: OptimierSpeicher = {
  artenLesen: async () => artenSpeicher.map((a) => ({ ...a })),
  artLaden: async (id) => { const a = artenSpeicher.find((x) => x.id === id); return a ? { ...a } : null; },
  artAnlegen: async (a) => { artenSpeicher.push({ ...a }); },
  artAendern: async (id, f) => { const a = artenSpeicher.find((x) => x.id === id); if (!a) return false; Object.assign(a, f); return true; },
  laufMerken: async (z) => { laeufe.push(z); },
  begriffeLaden: async () => HAUS,
};
const schutzSpeicher = { laden: async () => schutz } as unknown as SchutzSpeicher;
const wegSpeicher = {
  anlegen: async () => {}, aendern: async () => true,
  verbrauchMerken: async (modell: string) => { verbrauch.push({ modell }); },
};

describe('C Routen', () => {
  let server: Server;
  let basis = '';
  const rufe = async (methode: string, pfad: string, nutzer: string, body?: unknown) => {
    const r = await fetch(`${basis}${pfad}`, {
      method: methode,
      headers: { 'Content-Type': 'application/json', ...(nutzer ? { 'x-test-user': nutzer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  it('Server starten', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/textwerkstatt', textwerkstattRouter({
      deps: ki, speicher: wegSpeicher, optimier: optimierSpeicher, schutz: schutzSpeicher, requireAuth: fakeAuth(false), requireAdmin: fakeAuth(true),
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    basis = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/textwerkstatt`;
  });

  it('GET /arten: nur aktive, ohne Anweisung; ohne Anmeldung 401', async () => {
    const r = await rufe('GET', '/arten', 'nutzer-frei');
    expect(r.status).toBe(200);
    expect(r.body.some((a: any) => a.id === 'ausgeschaltet')).toBe(false);
    expect(r.body.some((a: any) => 'anweisung' in a)).toBe(false);
    expect((await rufe('GET', '/arten', '')).status).toBe(401);
  });
  it('GET /arten/alle nur Admin, mit Anweisung', async () => {
    expect((await rufe('GET', '/arten/alle', 'nutzer-frei')).status).toBe(403);
    const r = await rufe('GET', '/arten/alle', 'admin-1');
    expect(r.status).toBe(200);
    expect(r.body.find((a: any) => a.id === 'korrigieren').anweisung).toBe(KORRIGIEREN.anweisung);
  });
  it('POST /arten: prüft Felder, legt an, doppelt 409, Nutzer 403', async () => {
    const neu = { id: 'sachlich', name: 'Sachlich', anweisung: 'Schreibe sachlich und nüchtern.', laenge_min: 0.7, laenge_max: 1.3 };
    expect((await rufe('POST', '/arten', 'nutzer-frei', neu)).status).toBe(403);
    expect((await rufe('POST', '/arten', 'admin-1', { ...neu, id: 'Groß' })).status).toBe(400);
    expect((await rufe('POST', '/arten', 'admin-1', { ...neu, anweisung: 'kurz' })).status).toBe(400);
    expect((await rufe('POST', '/arten', 'admin-1', { ...neu, laenge_min: 2, laenge_max: 1 })).status).toBe(400);
    expect((await rufe('POST', '/arten', 'admin-1', { ...neu, anrede: 'ihr' })).status).toBe(400);
    expect((await rufe('POST', '/arten', 'admin-1', { ...neu, zahlen: 'egal' })).status).toBe(400);
    expect((await rufe('POST', '/arten', 'admin-1', { ...neu, laenge_max: true })).status).toBe(400);
    expect((await rufe('POST', '/arten', 'admin-1', { ...neu, umstellen_erlaubt: 'ja' })).status).toBe(400);
    const r = await rufe('POST', '/arten', 'admin-1', neu);
    expect(r.status).toBe(201);
    expect(r.body.zahlen).toBe('alle');
    expect(r.body.umstellen_erlaubt).toBe(true);
    expect((await rufe('POST', '/arten', 'admin-1', neu)).status).toBe(409);
  });
  it('PUT /arten/:id: ändert, prüft das Band gegen den alten Stand, unbekannt 404', async () => {
    expect((await rufe('PUT', '/arten/sachlich', 'admin-1', { laenge_min: 1.5 })).status).toBe(400);
    expect((await rufe('PUT', '/arten/sachlich', 'admin-1', {})).status).toBe(400);
    expect((await rufe('PUT', '/arten/gibts-nicht', 'admin-1', { aktiv: false })).status).toBe(404);
    const r = await rufe('PUT', '/arten/sachlich', 'admin-1', { aktiv: false, name: 'Sachlich (aus)', umstellen_erlaubt: false });
    expect(r.status).toBe(200);
    expect(r.body.aktiv).toBe(false);
    expect(r.body.umstellen_erlaubt).toBe(false);
    expect((await rufe('GET', '/arten', 'nutzer-frei')).body.some((a: any) => a.id === 'sachlich')).toBe(false);
  });
  it('POST /optimieren lokal: 200 mit Befund; Cloud ohne Vorschau 400 mit Code und ohne Aufruf; ohne Anmeldung 401', async () => {
    naechsteAntwort = (body) => body.messages[1].content;
    const r = await rufe('POST', '/optimieren', 'nutzer-gesperrt', { art: 'korrigieren', wegId: 'lokal', text: MAIL });
    expect(r.status).toBe(200);
    expect(r.body.befund.ergebnis).toBe('ok');
    expect(r.body.weg.art).toBe('lokal');
    const vorher = aufrufe.length;
    const c = await rufe('POST', '/optimieren', 'nutzer-frei', { art: 'korrigieren', wegId: 'cloud', text: MAIL });
    expect(c.status).toBe(400);
    expect(c.body.code).toBe('VORSCHAU_FEHLT');
    expect((await rufe('POST', '/optimieren', '', { art: 'korrigieren', wegId: 'lokal', text: MAIL })).status).toBe(401);
    expect((await rufe('POST', '/optimieren', 'nutzer-frei', { art: 'gibts-nicht', wegId: 'lokal', text: MAIL })).body.code).toBe('ART_UNBEKANNT');
    expect(aufrufe.length).toBe(vorher);
  });
  it('POST /optimieren Cloud: der Körper zur Cloud ist der ausgehende Text, ein Text im Körper der Anfrage zählt nicht', async () => {
    // Die Vorschau entsteht hier über den Dienst mit denselben Schutzregeln, die die Route liest.
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: MAIL }, quelle);
    naechsteAntwort = (body) => body.messages[1].content;
    const r = await rufe('POST', '/optimieren', 'nutzer-frei', { art: 'korrigieren', wegId: 'cloud', vorschauId: v.vorschauId, text: 'GEHEIM' });
    expect(r.status).toBe(200);
    expect(aufrufe[aufrufe.length - 1]!.body.messages[1].content).toBe(v.ausgehend);
    expect(r.body.text).toBe(MAIL);
  });
  it('POST /optimieren/kombination: prüft ohne Modell, verlangt Anmeldung und Eingaben', async () => {
    const vorher = aufrufe.length;
    const r = await rufe('POST', '/optimieren/kombination', 'nutzer-gesperrt', { art: 'korrigieren', original: PRODUKT, text: PRODUKT.replace('24 V', '12 V') });
    expect(r.status).toBe(200);
    expect(r.body.befund.ergebnis).toBe('verworfen');
    expect((await rufe('POST', '/optimieren/kombination', 'nutzer-frei', { art: 'korrigieren', original: PRODUKT, text: PRODUKT })).body.befund.ergebnis).toBe('ok');
    expect((await rufe('POST', '/optimieren/kombination', 'nutzer-frei', { art: 'korrigieren', original: PRODUKT })).status).toBe(400);
    expect((await rufe('POST', '/optimieren/kombination', '', { art: 'korrigieren', original: PRODUKT, text: PRODUKT })).status).toBe(401);
    expect(aufrufe.length).toBe(vorher);
  });
  it('Server stoppen', async () => {
    await new Promise((r) => server.close(r));
  });
});

// ── Lauf ────────────────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  kiZustandZuruecksetzen();
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${t.name}\n     ${(err as Error).message}`);
    }
  }
  console.log(`\n${passed} OK, ${failed} FAIL (${tests.length} Prüfungen)`);
  process.exit(failed ? 1 : 0);
})();
