/**
 * Prüft die Pseudonymisierung der Textwerkstatt (Plan `PLAN-textwerkstatt.md` §4 Phase 3, Cockpit #1839).
 * Ohne Datenbank und ohne Netz: Schutzeinstellungen und KI-Endpunkt sind Attrappen, die jeden Aufruf zählen und den
 * gesendeten Körper festhalten. Gerufen wird über die echten Routen (`routes/textwerkstatt.ts`) und die echten Dienste.
 *
 * Aufruf:
 *   DB_PASSWORD=egal npx tsx src/scripts/check-pseudonym.ts
 *
 * Abschnitt A sind die Tests des Mail-Agents (`packages/llm/src/pseudonymize.test.ts`, Stand `5777c8d`), hier mit einer
 * kleinen Nachbildung von describe/it/expect statt vitest, weil das Translationtool seine Prüfungen als Skripte führt.
 * Nicht übernommen, weil die Funktion hier fehlt: JSON aus Werkzeugen (3), `personNameFrom` (16), Embedding (1),
 * `restoreArguments` (2 von 3 Zurücksetzen-Tests), `LLMClient` (alle). Geändert, weil die Textwerkstatt mehr verdeckt:
 * „Der Betrag von 240,00 EUR ist offen“ bleibt nur mit abgeschalteter Klasse PREIS stehen.
 *
 * Je Schranke gilt: Ein HTTP-Code allein belegt nur, dass geantwortet wurde. Deshalb steht neben jedem Negativpfad der
 * Aufrufzähler der Attrappe (0 = nichts gesendet).
 */
import express, { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
  PseudonymSession, PseudonymizationError, restpruefung, ibanGueltig, ean13Gueltig, PSEUDONYM_HINT, SchutzBegriff,
  Schutzklasse, PseudonymSeed,
} from '../services/pseudonym/pseudonymize';
import {
  vorschauErstellen, pseudonymSenden, PseudonymFehler, SchutzEinstellungen, vorschauenLeeren, vorschauAnzahl, GRENZEN,
} from '../services/pseudonym/vorschau';
import { KiAbhaengigkeiten, KiWeg, kiZustandZuruecksetzen } from '../services/ki-weg';
import { textwerkstattRouter, SchutzSpeicher, SchutzListeZeile, musterPruefen, SCHUTZLISTE_HOECHSTENS } from '../routes/textwerkstatt';

// ── Nachbildung von describe/it/expect ──────────────────────────────────────────────────────────────────────────
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
it.each = <T extends unknown[]>(fälle: readonly (T | string)[]) => (name: string, fn: (...a: any[]) => void) => {
  for (const f of fälle) {
    const args = Array.isArray(f) ? f : [f];
    tests.push({ name: prefix + name.replace('%s', String(args[0])), fn: () => fn(...args) });
  }
};
class Fehlschlag extends Error {}
function expect(ist: any) {
  const fail = (was: string) => { throw new Fehlschlag(`${was}; ist: ${JSON.stringify(ist)?.slice(0, 300)}`); };
  const m = {
    toBe: (soll: unknown) => { if (ist !== soll) fail(`erwartet ${JSON.stringify(soll)}`); },
    toEqual: (soll: unknown) => { if (JSON.stringify(ist) !== JSON.stringify(soll)) fail(`erwartet gleich ${JSON.stringify(soll)}`); },
    toContain: (soll: string) => { if (!String(ist).includes(soll)) fail(`erwartet enthält ${JSON.stringify(soll)}`); },
    toMatch: (re: RegExp) => { if (!re.test(String(ist))) fail(`erwartet passt auf ${re}`); },
    toBeLessThan: (n: number) => { if (!(ist < n)) fail(`erwartet < ${n}`); },
    toBeNull: () => { if (ist !== null) fail('erwartet null'); },
    toThrow: (art?: new (...a: any[]) => Error) => {
      try { ist(); } catch (e) { if (art && !(e instanceof art)) fail(`falscher Fehler ${(e as Error).name}`); return; }
      fail('erwartet einen Fehler');
    },
    not: {
      toContain: (soll: string) => { if (String(ist).includes(soll)) fail(`erwartet enthält NICHT ${JSON.stringify(soll)}`); },
      toMatch: (re: RegExp) => { if (re.test(String(ist))) fail(`erwartet passt NICHT auf ${re}`); },
      toBe: (soll: unknown) => { if (ist === soll) fail(`erwartet nicht ${JSON.stringify(soll)}`); },
    },
  };
  return m;
}

const neu = (seed: PseudonymSeed = {}) => new PseudonymSession(seed);
const ARTIKEL_SEED = '[1-9][0-9]{4,6}';

// ═══ A. Aus dem Mail-Agent (5777c8d), angepasst wie im Kopf beschrieben ═══════════════════════════════════════
describe('A Erkennung ohne Wörterbuch', () => {
  it.each([
    ['Mail', 'Schreib an anna.mueller@firma.at bitte', 'anna.mueller@firma.at'],
    ['Telefon mit Vorwahl', 'Tel. +43 664 1234567 erreichbar', '+43 664 1234567'],
    ['Telefon national', 'Ruf an: 0664/123 45 67', '0664/123 45 67'],
    ['IBAN', 'Konto AT61 1904 3002 3457 3201 bitte', 'AT61 1904 3002 3457 3201'],
    ['Karte', 'Karte 4111 1111 1111 1111 belastet', '4111 1111 1111 1111'],
    ['Link', 'Siehe https://portal.example.org/k/4711?token=abc', 'https://portal.example.org/k/4711?token=abc'],
    ['Domain', 'Mehr auf muster.at lesen', 'muster.at'],
    ['Straße', 'Wohnt in der Bahnhofstraße 12/3 in Kundl', 'Bahnhofstraße 12/3'],
    ['Postleitzahl', 'Lieferung nach 6250 Kundl geht', '6250 Kundl'],
    ['Firma', 'Bestellt bei Muster Licht GmbH gestern', 'Muster Licht GmbH'],
    ['UID', 'UID ATU12345678 prüfen', 'ATU12345678'],
    ['Rechnungsnummer', 'Rechnung 2026-1184 offen', '2026-1184'],
    ['Anrede', 'Hallo Anna, wie geht es', 'Anna'],
    ['Sehr geehrter', 'Sehr geehrter Herr Dr. Bauer, danke', 'Bauer'],
    ['Titel', 'Das sagte Frau Huber gestern', 'Huber'],
    ['Grußformel', 'Danke und Grüße, Anna Berger', 'Anna Berger'],
    ['Grußformel neue Zeile', 'Mit freundlichen Grüßen\nMaria Gruber', 'Maria Gruber'],
  ])('%s', (_name: string, text: string, geheim: string) => {
    const out = neu().text(text);
    expect(out).not.toContain(geheim);
    expect(out).toMatch(/\[[A-Z]+_\d+(\.\d+)?\]/);
  });

  it.each([
    'Bitte bis Freitag, 15.11.2026 um 10:30 Uhr',
    'Im Jahr 2026 Rechnung prüfen',
    'Guten Morgen und vielen Dank',
    'Am 02.11.2026 sind 1000 Stück da',
    'Sehr geehrte Damen und Herren',
    'Termin 02/11/2026 passt',
  ])('bleibt stehen, Triage und Fristen brauchen es: %s', (text: string) => {
    expect(neu().text(text)).toBe(text);
  });

  it('geändert: ein Betrag mit Währung bleibt nur ohne die Klasse PREIS stehen', () => {
    expect(neu({ aus: ['PREIS'] }).text('Der Betrag von 240,00 EUR ist offen')).toBe('Der Betrag von 240,00 EUR ist offen');
    expect(neu().text('Der Betrag von 240,00 EUR ist offen')).toBe('Der Betrag von [PREIS_1] ist offen');
  });

  it('eine Firma endet an der Zeile: Der Name darüber ist eine Person, nicht Teil der Firma', () => {
    const s = neu();
    const out = s.text('Danke und Grüße\nKarl Mustermann\nMuster Licht GmbH');
    expect(out).not.toContain('Karl');
    const arten = Object.fromEntries(s.replacements().map((r) => [r.value, r.kind]));
    expect(arten['Karl Mustermann']).toBe('PERSON');
    expect(arten['Muster Licht GmbH']).toBe('FIRMA');
  });

  it('ein geschütztes Leerzeichen trennt wie ein Leerzeichen: Firma, IBAN und Name gehen nicht durch', () => {
    const s = neu();
    const out = s.text('Muster Licht GmbH, IBAN AT61 1904 3002 3457 3201\nViele Grüße\nKarl Mustermann');
    for (const wort of ['Licht', 'GmbH', 'AT61', '3201', 'Karl', 'Mustermann']) expect(out).not.toContain(wort);
    const arten = Object.fromEntries(s.replacements().map((r) => [r.value, r.kind]));
    expect(arten['Muster Licht GmbH']).toBe('FIRMA');
    expect(arten['Karl Mustermann']).toBe('PERSON');
  });

  it('ein unsichtbares Zeichen zerteilt keinen Namen', () => {
    const s = neu({ persons: ['Karl Mustermann'] });
    const out = s.text('Rückruf von Karl Mus­ter​mann');
    expect(out).not.toContain('Kar');
    expect(out).not.toMatch(/Mus.?ter/);
  });

  it('eine Domain fällt auch mit seltener Endung, samt Unterdomäne', () => {
    const out = neu().text('Meldung von vps.kundenname.art, portal.muster.academy, muster.tirol und firma.sharepoint.com.');
    for (const wort of ['vps', 'kundenname', 'portal', 'muster', 'academy', 'tirol', 'firma', 'sharepoint']) expect(out).not.toContain(wort);
    expect(out).toContain('[URL_1]');
  });

  it('ein Bindestrich nach der Domain schützt sie nicht', () => {
    const out = neu().text('Der vps.kundenname.art-Server und das muster.at-Konto sind weg.');
    for (const wort of ['kundenname', 'muster']) expect(out).not.toContain(wort);
    expect(out).toContain('-Server');
    expect(out).toContain('-Konto');
  });

  it('Dateinamen, Abkürzungen und Versionen bleiben lesbar', () => {
    const text = 'Anhang rechnung.pdf, plan-v2.xlsx, plan.final-version.pdf und foto.final.jpg, z.b. morgen, d.h. bis Freitag, Version 2.1.296.';
    expect(neu().text(text)).toBe(text);
  });

  it('eine Zahl, die nur wie eine Karte aussieht, bleibt: Prüfziffer falsch', () => {
    expect(neu().text('Auftrag 1234 5678 9012 3456 läuft')).toContain('5678');
  });
});

describe('A Wörterbuch', () => {
  it('bekannte Person: ganzer Name und Teile, dieselbe Nummer', () => {
    expect(neu({ persons: ['Anna Müller'] }).text('Anna Müller schreibt, Anna meint, Müller zahlt')).toBe('[PERSON_1] schreibt, [PERSON_1.1] meint, [PERSON_1.2] zahlt');
  });
  it('ein Nachname „Freitag“ trifft die Frist nicht', () => {
    expect(neu({ persons: ['Anna Freitag'] }).text('Anna Freitag bittet um Antwort bis Freitag')).toBe('[PERSON_1] bittet um Antwort bis Freitag');
  });
  it('eigener Begriff wirkt in jeder Schreibweise, nicht mitten im Wort', () => {
    expect(neu({ terms: ['NORDLICHT'] }).text('Das nordlicht-Team von NORDLICHT, nicht Nordlage')).toBe('Das [BEGRIFF_1]-Team von [BEGRIFF_1], nicht Nordlage');
  });
  it('die Mailadresse verrät den Namen, auch im übrigen Text', () => {
    expect(neu().text('anna.berger@example.org. Grüße von Anna')).not.toContain('Anna');
  });
  it('Rollenadressen sind keine Namen', () => {
    const s = neu();
    s.text('info@example.org und no.reply@example.org');
    expect(s.replacements().filter((r) => r.kind === 'PERSON')).toEqual([]);
  });
});

describe('A Namen ohne eigene Liste', () => {
  it('Vorname und großes Wort sind eine Person, auch ohne Nachnamenliste', () => {
    const out = neu().text('Das hat mir Karl Moser gestern gesagt, und Moser bleibt dabei.');
    expect(out).not.toContain('Karl');
    expect(out).not.toContain('Moser');
    expect(out).toContain('[PERSON_1]');
  });
  it.each([
    ['Doppelvorname', 'Termin mit Anna Maria Huber am Freitag', ['Anna', 'Maria', 'Huber']],
    ['Zusatz', 'Gespräch mit Ludwig van Beethoven vereinbart', ['Ludwig', 'Beethoven']],
    ['Doppelname', 'Laut Eva Müller-Lüdenscheidt passt das', ['Eva', 'Müller-Lüdenscheidt']],
    ['Akzent', 'Rückruf von José Šimić erbeten', ['José', 'Šimić']],
    ['Großschreibung', 'KARL MOSER hat bestätigt', ['KARL', 'MOSER']],
    ['Nach einem Titelwort', 'Kollege Karl Moser übernimmt', ['Karl', 'Moser']],
    ['Hinter von', 'Mail von Anna Huber kam an', ['Anna', 'Huber']],
    ['In eckigen Klammern', 'Betreff: [Karl Moser] Rückruf', ['Karl', 'Moser']],
    ['Erwähnung', 'Bitte an @Karl Moser weiterleiten', ['Karl', 'Moser']],
    ['In Anführungszeichen', 'Er nannte "Karl Moser" als Kontakt', ['Karl', 'Moser']],
    ['Doppelter Vorname mit Bindestrich', 'Laut Hans-Peter Moser passt das', ['Hans-Peter', 'Moser']],
    ['Zwei Personen', 'Gruß von Karl von Peter Müller', ['Peter', 'Müller']],
  ])('%s', (_name: string, text: string, geheim: string[]) => {
    const out = neu().text(text);
    for (const wort of geheim) expect(out).not.toContain(wort);
  });
  it.each(['Max Länge 5 m bei 24 Volt', 'Nur Montag und August Termin', 'Peter Bitte nicht vergessen', 'Claude Code läuft', 'Karl hat angerufen'])(
    'bleibt lesbar: %s',
    (text: string) => { expect(neu().text(text)).toBe(text); },
  );
  it('ein Nachname mit unbekanntem Vornamen bleibt ohne Adressbuch stehen: bekannte Grenze', () => {
    expect(neu().text('Das sagte Zorbas Kowalczyk gestern')).toContain('Zorbas Kowalczyk');
  });
  it('ein Name aus dem Adressbuch fällt samt seinen Teilen in dieser Sitzung', () => {
    const s = neu({ knownNames: new Set(['zorbas kowalczyk']) });
    const out = s.text('Das sagte Zorbas Kowalczyk gestern. Kowalczyk bleibt dabei.');
    expect(out).not.toContain('Zorbas');
    expect(out).not.toContain('Kowalczyk');
    expect(s.counts()['PERSON']).toBe(1);
  });
  it.each(['Zorbas Kowalczyks Angebot', "Zorbas Kowalczyk's Angebot", 'Zorbas Kowalczyk’s Angebot'])('Genitiv aus dem Adressbuch: %s', (text: string) => {
    const out = neu({ knownNames: new Set(['zorbas kowalczyk']) }).text(text);
    expect(out).not.toContain('Kowalczyk');
    expect(out).toContain('Angebot');
  });
  it('ein Name aus lauter kurzen Wörtern fällt trotzdem', () => {
    expect(neu({ knownNames: new Set(['bo li']) }).text('Das sagte Bo Li gestern')).not.toContain('Bo Li');
  });
  it('ein Personenname zerstört keinen Platzhalter', () => {
    const s = neu();
    s.addPerson('URL Moser');
    const out = s.text('Siehe https://muster.at und URL Moser');
    expect(out).toContain('[URL_1]');
    expect(out).not.toContain('Moser');
  });
  it('ein Name aus dem Adressbuch zählt nur, wenn er im Text steht', () => {
    const s = neu({ knownNames: new Set(['zorbas kowalczyk', 'anna berger']) });
    expect(s.text('Nichts davon hier')).toBe('Nichts davon hier');
    expect(s.replacements()).toEqual([]);
  });
  it('einzelne Wörter aus dem Adressbuch ersetzen nichts', () => {
    expect(neu({ knownNames: new Set(['neues österreich']) }).text('In Österreich ist Neues zu hören')).toBe('In Österreich ist Neues zu hören');
  });
  it('Name in der Form Nachname, Vorname', () => {
    const s = neu();
    s.addPerson('Moser, Karl');
    const out = s.text('Moser, Karl schrieb. Karl und Moser antworten.');
    expect(out).not.toContain('Moser');
    expect(out).not.toContain('Karl');
  });
  it('ein Apostroph im Namen bleibt Teil des Namens', () => {
    const s = neu();
    s.addPerson("Sean O'Brien");
    expect(s.text("Antwort von Sean O'Brien, danke.")).not.toContain('Brien');
  });
});

describe('A Viele Namen in einem Text', () => {
  const lauterNamen = (anzahl: number): string => {
    const wort = (i: number) => `M${i.toString(26).replace(/\d/g, (d) => 'qrstuvwxyz'[Number(d)]!)}er`;
    return Array.from({ length: anzahl }, (_, i) => `Karl ${wort(i)}`).join(', ');
  };
  it('tausend Namen werden alle ersetzt, in kurzer Zeit', () => {
    const start = performance.now();
    const out = neu().text(lauterNamen(1000));
    expect(out).not.toContain('Karl');
    expect(out).not.toMatch(/M[a-z]+er/);
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it('über der Obergrenze geht nichts hinaus, und das schnell', () => {
    const text = lauterNamen(20_000);
    const start = performance.now();
    expect(() => neu().text(text)).toThrow(PseudonymizationError);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe('A Zurücksetzen und Fehler', () => {
  it('Antwort trägt wieder die echten Werte', () => {
    const s = neu({ persons: ['Anna Berger'] });
    s.text('Anna Berger, anna@example.org');
    expect(s.restore('Antwort an [PERSON_1], [PERSON_1.1] und [EMAIL_1]')).toBe('Antwort an Anna Berger, Anna und anna@example.org');
  });
  it('einen erfundenen Platzhalter lässt es stehen', () => {
    expect(neu().restore('Das sagte [PERSON_9]')).toBe('Das sagte [PERSON_9]');
  });
  it('die Zuordnung steht nicht im Text', () => {
    const s = neu({ persons: ['Anna Berger'] });
    expect(s.text('Anna Berger')).not.toContain('Anna');
    expect(s.replacements()[0]).toEqual({ placeholder: '[PERSON_1]', kind: 'PERSON', value: 'Anna Berger' });
  });
  it('PseudonymizationError hat ihren Namen', () => {
    expect(new PseudonymizationError('x').name).toBe('PseudonymizationError');
  });
});

// ═══ B. Neu in der Textwerkstatt ═════════════════════════════════════════════════════════════════════════════════
describe('B Bank', () => {
  it('IBAN nur mit gültiger Prüfsumme: eine Produktbezeichnung bleibt stehen (R4)', () => {
    expect(ibanGueltig('AT61 1904 3002 3457 3201')).toBe(true);
    expect(ibanGueltig('LS24 5050 RGBW')).toBe(false);
    expect(neu().text('Das Flexband LS24 5050 RGBW bei 24 V')).toBe('Das Flexband LS24 5050 RGBW bei 24 V');
  });
  it('ein angehängtes Wort macht die IBAN nicht unkenntlich', () => {
    const out = neu().text('IBAN AT61 1904 3002 3457 3201 RGBW');
    expect(out).not.toContain('1904');
    expect(out).toContain('RGBW');
  });
  it('IBAN ohne Leerzeichen und eine aus Großbritannien', () => {
    const out = neu().text('Konto DE89370400440532013000 oder GB82 WEST 1234 5698 7654 32.');
    expect(out).not.toContain('3704');
    expect(out).not.toContain('WEST');
  });
  it('BIC, Bankname und Ablaufdatum im Zusammenhang', () => {
    const out = neu().text('Bitte auf das Konto bei der Raiffeisenbank Unterland, IBAN AT61 1904 3002 3457 3201, BIC RZUNAT2K. Kreditkarte 4111 1111 1111 1111, gültig bis 08/28.');
    for (const w of ['Raiffeisenbank', 'Unterland', 'RZUNAT2K', '08/28']) expect(out).not.toContain(w);
  });
  it('ohne Bankzusammenhang bleibt eine Datenbank eine Datenbank, ein Angebot gültig bis 12/26', () => {
    const text = 'Die Datenbank Abfrage läuft. Das Angebot ist gültig bis 12/26.';
    expect(neu().text(text)).toBe(text);
  });
  it('Amex-Testnummer', () => {
    expect(neu().text('Karte 3782 822463 10005')).not.toContain('822463');
  });
});

describe('B Preise und Konditionen', () => {
  it.each([
    ['Euro hinten', 'Listenpreis 89,90 € netto', '89,90'],
    ['Strich statt Cent', 'kostet 64,– € statt 79,– €', '64,–'],
    ['Tausender', 'Gesamtpreis 4.860,00 € netto', '4.860'],
    ['EUR vorne', 'Budget EUR 12.000 für das Licht', '12.000'],
    ['Millionen', 'Volumen 1,2 Mio. Euro', '1,2'],
    ['Rabatt davor', 'ein Rabatt von 35 % auf den Listenpreis', '35 %'],
    ['Rabatt danach', 'abzüglich 8 % Projektrabatt', '8 %'],
    ['auf Liste', 'ab sofort 42 % auf Liste', '42 %'],
    ['Kulanz', 'davon übernehmen wir aus Kulanz 50 %.', '50 %'],
    ['Skonto', 'gewähren wir 3 % Skonto', '3 %'],
    ['Zahlungsziel', 'Das Zahlungsziel bleibt bei 30 Tagen netto.', '30 Tagen'],
    ['Aktionscode', 'mit dem Code HERBST26 im Shop', 'HERBST26'],
  ])('%s', (_n: string, text: string, geheim: string) => {
    expect(neu().text(text)).not.toContain(geheim);
  });
  it.each(['Wirkungsgrad 91 % bei Volllast', 'zu 80 % montiert', 'Dimmung auf 10 % herunter', 'Lebensdauer L80 bei 50000 Stunden', '24 V, 14,4 W/m, 3000 K, IP67'])(
    'technischer Wert bleibt: %s',
    (text: string) => { expect(neu({ artikelnummer: ARTIKEL_SEED }).text(text)).toBe(text); },
  );
});

describe('B Artikelnummern', () => {
  it('hinter einem Kennwort jede Nummer einer Aufzählung', () => {
    const out = neu().text('besteht aus den Artikeln 112455, 112456 und 31540; Artikelnummern 115301 bis 115303; EAN 9120071468023.');
    for (const n of ['112455', '112456', '31540', '115301', '115303', '9120071468023']) expect(out).not.toContain(n);
  });
  it('ohne Muster bleibt eine Nummer ohne Kennwort stehen, mit Muster nicht', () => {
    expect(neu().text('Endkappen gibt es unter 31027')).toContain('31027');
    expect(neu({ artikelnummer: ARTIKEL_SEED }).text('Endkappen gibt es unter 31027')).not.toContain('31027');
  });
  it('mit Muster: vor einer Einheit, einem Mengenwort oder einem Hauptwort ist es eine Menge', () => {
    const text = 'Mit 100000 Schaltzyklen, 50000 h, 12000 lm und 15000 Mitarbeitern; Lieferung 24500 Stück.';
    expect(neu({ artikelnummer: ARTIKEL_SEED }).text(text)).toBe(text);
  });
  it('EAN mit gültiger Prüfziffer auch ohne Kennwort, mit falscher nicht', () => {
    expect(ean13Gueltig('4006381333931')).toBe(true);
    expect(neu().text('Barcode-Etikett 4006381333931 kleben')).not.toContain('4006381333931');
    // Eine 13-stellige Zahl, die weder als EAN noch nach Luhn (Karte) gültig ist, bleibt stehen.
    const weder = Array.from({ length: 10 }, (_, i) => `400638133393${i}`).find((n) => !ean13Gueltig(n) && !restpruefung(`x ${n} x`).funde.length)!;
    expect(neu().text(`Seriennummer ${weder} notieren`)).toContain(weder);
  });
  it('ein falsches Muster wird abgelehnt', () => {
    expect(() => neu({ artikelnummer: '([' })).toThrow(PseudonymizationError);
    expect(() => neu({ artikelnummer: '\\d*' })).toThrow(PseudonymizationError);
    expect(musterPruefen('[a-z]{4}')).toMatch(/Wörter/);
    expect(musterPruefen('[a-z]+')).toMatch(/Zeichenklassen/);
    expect(musterPruefen(ARTIKEL_SEED)).toBeNull();
  });
});

describe('B Belegnummern', () => {
  it.each([
    ['Füllwort', 'Unsere Kundennummer bei Ihnen ist 20417.', '20417'],
    ['Kompositum', 'gemäß Auftragsbestätigung AB-26-0451', 'AB-26-0451'],
    ['Bericht', 'Reklamationsbericht 2026-R-117: Kunde meldet', '2026-R-117'],
    ['Lieferschein', 'Lieferschein LS-88123 geprüft', 'LS-88123'],
    ['fremde UID', 'Ihre UID HU23456789 ist hinterlegt', 'HU23456789'],
    ['Proforma', 'Die Proforma-Rechnung PR-2026-0098 ist raus', 'PR-2026-0098'],
  ])('%s', (_n: string, text: string, geheim: string) => {
    expect(neu().text(text)).not.toContain(geheim);
  });
  it.each(['ab 120 m Länge', 'die bestellten 3000 K Bänder', 'Bestellung von 120 Stück'])('bleibt: %s', (text: string) => {
    expect(neu().text(text)).toBe(text);
  });
});

describe('B Firmen, Projekte, Anschrift, Personen', () => {
  it.each([
    ['fremde Rechtsform', 'die Buchhaltung der Novak Elektrotechnik s.r.o. in Bratislava', 'Novak Elektrotechnik'],
    ['ungarisch', 'bei der Fényház Kft. in Győr', 'Fényház'],
    ['Und-Zeichen', 'Kunde Licht & Raum OG meldet', 'Licht & Raum'],
    ['& Partner', 'vom Architekturbüro Lechner & Partner', 'Lechner'],
    ['Branche', 'zugesagt hat Elektro Kröll, und', 'Kröll'],
    ['Hotel', 'vom Hotel Seeblick am Achensee', 'Seeblick'],
    ['Restaurant', 'im Restaurant Zum Goldenen Hirschen', 'Goldenen Hirschen'],
    ['Projekt', 'zum Projekt Wohnanlage Lindenhof. Anbei', 'Lindenhof'],
    ['Objekt', 'für das Bürohaus Am Mühlbach in der', 'Mühlbach'],
    ['Heim', 'für das Projekt Seniorenheim St. Josef ist', 'Josef'],
    ['Straße mit Wort', 'im Gewerbepark Süd 7 abholen', 'Gewerbepark Süd 7'],
    ['Straße ohne Nummer', 'in der Maria-Theresien-Straße eröffnet', 'Maria-Theresien'],
    ['Akzent', 'Sehr geehrte Frau Kovács,', 'Kovács'],
    ['Danke', 'Bitte löschen.\n\nDanke, Martin', 'Martin'],
    ['Titel nach Grußformel', 'Mit freundlichen Grüßen\nIng. Florian Moser', 'Florian'],
    ['kurze Durchwahl', 'Infos unter 05223 58410.', '58410'],
    ['verkleidete Mail', 'schreib an m.mayr(at)kunde.at bitte', 'mayr'],
  ])('%s', (_n: string, text: string, geheim: string) => {
    expect(neu().text(text)).not.toContain(geheim);
  });
  it('„Firma“ bleibt sichtbar, der Name nicht', () => {
    const out = neu().text('Der Monteur der Firma Lichttechnik Gasser kommt');
    expect(out).toContain('Firma [FIRMA_1]');
  });
  it('eine Abteilung unter der Grußformel ist kein Name', () => {
    expect(neu().text('Mit freundlichen Grüßen\nSandra Kofler\nInnendienst')).toContain('Innendienst');
  });
  it('„Projekt Status“ ist kein Projektname', () => {
    expect(neu().text('Der Projekt Status ist grün')).toBe('Der Projekt Status ist grün');
  });
  it.each(['Lichtstrom 1200 Lumen bei 3000 Kelvin', 'nach 50000 Stunden noch 80 %'])('Menge ist keine PLZ: %s', (text: string) => {
    expect(neu().text(text)).toBe(text);
  });
});

describe('B Klassen, Aufdecken, Schutzliste', () => {
  it.each(['BANK', 'MAIL', 'TELEFON'])('Pflichtklasse %s lässt sich nicht abschalten', (k: string) => {
    expect(() => neu({ aus: [k as Schutzklasse] })).toThrow(PseudonymizationError);
  });
  it('eine abgeschaltete Klasse bleibt stehen, die anderen nicht', () => {
    const out = neu({ aus: ['PREIS', 'FIRMA'] }).text('Elektro Kröll zahlt 500 € an anna@example.org');
    expect(out).toContain('Elektro Kröll');
    expect(out).toContain('500 €');
    expect(out).not.toContain('anna@');
  });
  it('aufgedeckt bleibt stehen, Teile eines aufgedeckten Namens auch', () => {
    const s = neu({ aufdecken: ['89,90 €', 'Karl Moser'] });
    const out = s.text('Karl Moser zahlt 89,90 €, Moser bestätigt.');
    expect(out).toBe('Karl Moser zahlt 89,90 €, Moser bestätigt.');
    expect(s.aufdeckBefund().aufgedeckt.length).toBe(2);
  });
  it('eine Pflichtklasse lässt sich nicht aufdecken, und das wird gemeldet', () => {
    const s = neu({ aufdecken: ['AT61 1904 3002 3457 3201', 'anna@example.org', '0664 1234567'] });
    const out = s.text('IBAN AT61 1904 3002 3457 3201, anna@example.org, Tel. 0664 1234567');
    expect(out).not.toContain('1904');
    expect(out).not.toContain('anna@');
    expect(out).not.toContain('1234567');
    expect(s.aufdeckBefund().nichtAufdeckbar.length).toBe(3);
  });
  it('Schutzliste mit Art: Kundenname als Ganzes, auch über Zeilen', () => {
    const t: SchutzBegriff[] = [{ begriff: 'Seeblick Gruppe', art: 'FIRMA' }, { begriff: 'Lindenhof', art: 'PROJEKT' }];
    const out = neu({ terms: t }).text('Die Seeblick\nGruppe baut den Lindenhof.');
    expect(out).toBe('Die [FIRMA_1] baut den [PROJEKT_1].');
  });
  it('eine Person der Schutzliste fällt auch bei abgeschalteter Klasse PERSON', () => {
    const out = neu({ aus: ['PERSON'], persons: ['Zorbas Kowalczyk'] }).text('Zorbas Kowalczyk und Karl Moser');
    expect(out).toBe('[PERSON_1] und Karl Moser');
  });
  it('Negativprobe: ein Text ohne Treffer geht unverändert durch', () => {
    const text = 'Das Aluprofil mit opaler Abdeckung eignet sich für Bänder bis 12 mm Breite. Bei 24 V und 3000 K ergibt sich mit IP67 ein ruhiges Licht, die Lebensdauer liegt bei 50000 Stunden.';
    expect(neu({ artikelnummer: ARTIKEL_SEED }).text(text)).toBe(text);
  });
});

// Regeln aus den Erstläufen an den zwei fremden Korpora (Plan §4 Phase 3 „Belegt“); je Regel ein eigener Satz, nicht der aus dem Korpus.
describe('B Nachgezogen nach den fremden Korpora', () => {
  it.each([
    ['Handy ohne Vorwahl', 'Kontakt vor Ort: Handy 348 221 9090, bitte vorher anrufen', '221 9090'],
    ['Durchwahl allein', 'bitte Durchwahl -317 verlangen', '317'],
    ['kurze Rufnummer', 'Zentrale 07612 4433 ab acht Uhr', '4433'],
    ['Nummer ohne Kennwort im Kontaktsatz', 'erreichbar über das Büro und 339 876 5432 jederzeit', '876 5432'],
    ['Bank vorn', 'Bitte überweisen an die Bank Oberland Nord, IBAN AT61 1904 3002 3457 3201', 'Oberland'],
    ['Kartendatum ohne Kennwort', 'Karte 5555 5555 5555 4444, läuft 09/28 ab', '09/28'],
    ['Schweizer Betrag', 'Total CHF 12\'480.50 inkl. MWST, Anzahlung CHF 2\'000.–', '480'],
    ['Spanne', 'Limit von 30.000 auf 45.000 Euro erhöht', '30.000'],
    ['Tausend', 'Budget laut Bauherr rund 7 Tsd. je Geschoss', '7 Tsd'],
    ['k', 'Kosten ca. 18k für die Halle', '18k'],
    ['Frist nach', 'Zahlung nach 45 Tagen ohne Abzug', '45 Tagen'],
    ['auf alle', 'Herbstaktion: 20 % auf alle Strahler', '20 %'],
    ['Schweizer Gruß', 'Hoi Simone, kurze Frage', 'Simone'],
    ['Erwähnung', '@Nicole bitte prüfen', 'Nicole'],
    ['Vorname als Anrede', 'Mirko, Kundenanruf von heute', 'Mirko'],
    ['Rolle', 'Beratung: Ladina Caduff, Mo–Fr', 'Caduff'],
    ['Bis später', 'Schick ich dir.\n\nBis später, Ines', 'Ines'],
    ['Initiale', 'Viele Grüße\nJ. Brandt', 'Brandt'],
    ['Schreibung aus der Adresse', 'Kontakt Tereza Horáková, tereza.horakova@lichtwerk.example', 'Horáková'],
    ['Sagl', 'Kunde: Lumen Ticino Sagl meldet', 'Ticino'],
    ['Behörde', 'Bauherr: Landratsamt Unterfranken.', 'Unterfranken'],
    ['Hochschule für', 'Vortrag an der Hochschule für Technik Rapperswil', 'Rapperswil'],
    ['Stadtwerke', 'für die Stadtwerke Kufstein liefern', 'Kufstein'],
    ['Objekt Tennishalle', 'Messung Tennishalle Seefeld abgeschlossen', 'Seefeld'],
    ['Ausschreibung', 'Die Ausschreibung Messehalle Dornbirn läuft', 'Dornbirn'],
    ['Servicebericht', 'Servicebericht 2026-S-411: Treiber getauscht', '2026-S-411'],
    ['Prüfnummer', 'Prüfnummer PR-26-0777, Prüfer Hr. Kogler', 'PR-26-0777'],
    ['Kieler Straße', 'Lieferung an Hamburger Straße 12 bitte', 'Hamburger Straße 12'],
    ['Via', 'Cantiere in Via Roma 22, 39100 Bolzano', 'Via Roma 22'],
  ])('%s', (_n: string, text: string, geheim: string) => {
    expect(neu().text(text)).not.toContain(geheim);
  });
  it.each([
    'Konform nach EN 60598 und EN 62471',
    'Linearleuchte LL-1500 Slim, 1500 mm, 28 W',
    'Projektbericht KW 44: Montage läuft',
    'spart bis zu 60 % Energie gegenüber Halogen',
    'Die Anlage: Datenblatt liegt bei',
  ])('bleibt: %s', (text: string) => {
    expect(neu({ artikelnummer: ARTIKEL_SEED }).text(text)).toBe(text);
  });
  it('Restprüfung fängt eine Durchwahl und eine Handynummer im Kontaktsatz', () => {
    expect(restpruefung('bitte Durchwahl -214 verlangen').ok).toBe(false);
    expect(restpruefung('erreichbar unter 335 123 4567').ok).toBe(false);
    expect(restpruefung('Handy 349 556 7788').ok).toBe(false);
  });
});

describe('B Restprüfung', () => {
  it.each([
    ['Mail', 'Antwort an info@kunde.example bitte', 'MAIL'],
    ['halbe Mail', 'an info@[URL_1] bitte', 'MAIL'],
    ['IBAN', 'IBAN DE89 3704 0044 0532 0130 00', 'BANK'],
    ['Karte', 'Karte 5555 5555 5555 4444', 'BANK'],
    ['BIC', 'BIC RZUNAT2K', 'BANK'],
    ['Telefon', 'Ruf an: +43 664 1234567', 'TELEFON'],
  ])('findet %s', (_n: string, text: string, klasse: string) => {
    const r = restpruefung(text);
    expect(r.ok).toBe(false);
    expect(r.funde.map((f) => f.klasse).join(',')).toContain(klasse);
  });
  it('Platzhalter, Produktbezeichnung und Messwerte lassen sie durch', () => {
    expect(restpruefung('[PERSON_1] bestellt LS24 5050 RGBW, 24 V, 3000 K, [TELEFON_1], [IBAN_1], am 15.12.2026.').ok).toBe(true);
  });
  it('meldet nie den Wert', () => {
    expect(JSON.stringify(restpruefung('info@kunde.example'))).not.toContain('kunde');
  });
});

describe('B Zurücksetzen der Antwort', () => {
  const s = neu({ persons: ['Anna Berger'] });
  const gesendet = s.text('Anna Berger zahlt 500 € an Elektro Kröll.');
  it('auch in veränderter Form', () => {
    const z = s.zuruecksetzen('[Person 1] zahlt [PREIS 1] an [firma-1]; PERSON_1.1 bestätigt.', gesendet);
    expect(z.text).toBe('Anna Berger zahlt 500 € an Elektro Kröll; Anna bestätigt.');
    expect(z.unbekannt).toEqual([]);
    expect(z.fehlend).toEqual([]);
  });
  it('erfunden, fehlend, geschwärzt', () => {
    const z = s.zuruecksetzen('[PERSON_1] und [PERSON_7] zahlen [REDACTED].', gesendet);
    expect(z.unbekannt).toEqual(['[PERSON_7]']);
    expect(z.fehlend.map((f) => f.placeholder).join(',')).toBe('[PREIS_1],[FIRMA_1]');
    expect(z.geschwaerzt).toBe(1);
  });
});

// ═══ R. Befunde des Code-Reviews vom 10.11.2026, je Befund die Eingabe aus dem Review ═══════════════════════════════
describe('R Review', () => {
  const liste: SchutzBegriff[] = [{ begriff: 'Zorbas Kowalczyk', art: 'PERSON' }, { begriff: 'Ladina Caduff', art: 'PERSON' }];
  it('H1 eine Person der Schutzliste bekommt erst im Text eine Nummer: die Nummer verrät die Liste nicht', () => {
    expect(neu({ schutzliste: liste }).text('Herr Karl Moser ruft an')).toBe('Herr [PERSON_1] ruft an');
  });
  it('H1 ein nie gesendeter Platzhalter setzt keinen Wert ein', () => {
    const s = neu({ schutzliste: liste });
    const gesendet = s.text('Herr Karl Moser ruft an');
    const z = s.zuruecksetzen('Ansprechpartner ist [PERSON_2], Vertretung [PERSON_2.1], Herr [PERSON_1].', gesendet);
    expect(z.text).not.toContain('Kowalczyk');
    expect(z.text).not.toContain('Ladina');
    expect(z.unbekannt.length).toBe(2);
    expect(z.text).toContain('Karl Moser');
  });
  it('H1 ein bekannter, aber nicht gesendeter Platzhalter gilt nicht (nur die Sperre in zuruecksetzen hält das auf)', () => {
    const s = neu({ persons: ['Zorbas Kowalczyk'] }); // vorab nummeriert, steht nicht im Text
    const gesendet = s.text('Herr Karl Moser ruft an');
    expect(s.replacementOf('[PERSON_1]')!.value).toBe('Zorbas Kowalczyk');
    const z = s.zuruecksetzen('Grüße an [PERSON_1]', gesendet);
    expect(z.text).not.toContain('Kowalczyk');
    expect(z.unbekannt).toEqual(['[PERSON_1]']);
  });
  it('H1 ein Teil eines gesendeten Namens gilt', () => {
    const s = neu();
    const gesendet = s.text('Das sagte Karl Moser.');
    expect(s.zuruecksetzen('Laut [PERSON_1.2] passt das.', gesendet).text).toBe('Laut Moser passt das.');
  });
  it.each([
    ['H2 Ziffer vor der Karte', 'Bitte Karte 2 4111 1111 1111 1111 belasten', '1111 1111'],
    ['H2 Kürzel vor der IBAN', 'Schutzart IP67 GB82 WEST 1234 5698 7654 32', 'WEST'],
    ['H2 Referenz vor der IBAN', 'Ref RE26 DE89 3704 0044 0532 0130 00', '3704'],
    ['H3 Nullbreite vor dem @', 'Mail an anna.mueller‌@kunde.at bitte', 'kunde'],
    ['H3 Vollbreite Mail', 'Mail an anna.mueller＠kunde.at bitte', 'kunde'],
    ['H3 Vollbreite Telefon', 'Tel. ０６６４ １２３４５６７', '1234567'],
    ['H3 Formatzeichen im Telefon', 'Tel. 0664‍ 123‎4567', '1234567'],
    ['H3 IBAN über den Zeilenumbruch', 'IBAN AT61 1904\n3002 3457 3201 bitte', '3002'],
    ['M2 Artikel vor der Karte', 'Artikel 4111 1111 1111 1111 ist reserviert', '1111 1111 1111'],
  ])('%s', (_n: string, text: string, geheim: string) => {
    expect(neu({ artikelnummer: ARTIKEL_SEED }).text(text)).not.toContain(geheim);
  });
  it('H2 die Restprüfung findet dieselben Fälle im Rohtext', () => {
    for (const t of ['Bitte Karte 2 4111 1111 1111 1111 belasten', 'Ref RE26 DE89 3704 0044 0532 0130 00', 'IP67 GB82 WEST 1234 5698 7654 32']) {
      expect(restpruefung(t).ok).toBe(false);
    }
  });
  it('H3 die Restprüfung sieht durch Formatzeichen, Vollbreite und Prozentkodierung', () => {
    for (const t of ['anna.mueller‌@kunde.at', '０６６４ １２３４５６７', '?email=anna%40kunde.at', 'IBAN AT61 1904\n3002 3457 3201']) {
      expect(restpruefung(t).ok).toBe(false);
    }
  });
  it('H3 mit abgeschalteter Klasse URL bleiben Mail und Telefon in einer URL verdeckt', () => {
    const out = neu({ aus: ['URL'] }).text('Link https://x.example.at/k?email=anna.mueller%40kunde.at&tel=%2B436641234567 bitte');
    expect(out).not.toContain('kunde.at');
    expect(out).not.toContain('6641234567');
    expect(restpruefung(out).ok).toBe(true);
  });
  it('M1 Platzhalter im Eingabetext: der Text wird abgelehnt', () => {
    for (const t of ['Test [PERSON_1] [PERSON_1.2]', 'Feld PERSON_1 prüfen', 'Sehr geehrte [Person 1]', 'Das war [REDACTED]']) {
      expect(() => neu().text(t)).toThrow(PseudonymizationError);
    }
  });
  it('M2 ein selbst verdecktes Wort oder ein Begriff der Schutzliste zerteilt keine Telefonnummer', () => {
    expect(neu({ terms: ['0664'] }).text('Tel. 0664 1234567')).not.toContain('1234567');
    expect(neu({ schutzliste: [{ begriff: '20417', art: 'BEGRIFF' }] }).text('Ruf an: 0664 20417 33')).not.toContain('0664');
  });
  it('M3 Kontonummer und BLZ sind Bankverbindung: nicht abschaltbar, nicht aufdeckbar', () => {
    const s = neu({ aus: ['BELEGNR'], aufdecken: ['12345678901'] });
    const out = s.text('Kontonummer 12345678901, BLZ 20111, Erste Bank, Konto bitte prüfen');
    expect(out).not.toContain('12345678901');
    expect(out).not.toContain('20111');
    expect(s.aufdeckBefund().nichtAufdeckbar).toEqual(['12345678901']);
  });
  it.each([['(?:\\d+)+'], ['(?:[0-9]+[ ]?)+'], ['([1-9])[0-9]{4,6}'], ['\\b'], ['\\p{L}{4}'], ['[a-z]{4}'], [')|(?:'], ['\\d*']])(
    'M4/M5/N1 Muster %s wird abgelehnt',
    (muster: string) => {
      expect(musterPruefen(muster)).not.toBe(null);
      expect(() => PseudonymSession.artikelMuster(muster)).toThrow(PseudonymizationError);
    },
  );
  it('M4 Muster wie die Installation sie braucht, gehen durch', () => {
    for (const m of [ARTIKEL_SEED, '\\d{6}', '[1-9][0-9]{4}|9[0-9]{6}', 'AB-[0-9]{5}']) expect(musterPruefen(m)).toBeNull();
  });
  it('M6 eine Person der Schutzliste in jeder Schreibung, auch kurz', () => {
    const out = neu({ schutzliste: [...liste, { begriff: 'Li', art: 'PERSON' }] }).text('KOWALCZYK ZORBAS, zorbas kowalczyk, Zorbas\nKowalczyk und Herr Li.');
    expect(out.toLowerCase()).not.toContain('kowalczyk');
    expect(out.toLowerCase()).not.toContain('zorbas');
    expect(out).not.toContain(' Li.');
  });
  it('Schutzliste lässt sich nicht aufdecken, und die Vorschau sagt das', () => {
    const s = neu({ schutzliste: [{ begriff: 'Seeblick Gruppe', art: 'FIRMA' }], aufdecken: ['Seeblick Gruppe'] });
    expect(s.text('Die Seeblick Gruppe baut')).toBe('Die [FIRMA_1] baut');
    expect(s.aufdeckBefund().nichtAufdeckbar).toEqual(['Seeblick Gruppe']);
    expect(s.aufdeckbar(s.replacementOf('[FIRMA_1]')!)).toBe(false);
  });
  it('N3 eine Mail in einer URL: kein verschachtelter Platzhalter, und alles kommt zurück', () => {
    const s = neu();
    const text = 'Siehe https://x.example.at/?m=anna@kunde.at bitte';
    const out = s.text(text);
    expect(out).not.toContain(']]');
    expect(s.zuruecksetzen(out, out).text).toBe(text);
  });
  it('N4 erfundene Platzhalter in anderer Form fallen auf', () => {
    const s = neu();
    const gesendet = s.text('Karl Moser ruft an');
    expect(s.zuruecksetzen('[KUNDE_1] und [NAME] und [PERSON１]', gesendet).unbekannt.length).toBe(3);
    expect(s.zuruecksetzen('Herr [PERSON_1] und [REDACTED]', gesendet).unbekannt).toEqual([]);
  });
});

// ═══ C. Vorschau, Senden, Routen ═════════════════════════════════════════════════════════════════════════════════
const einstellungen: SchutzEinstellungen = { aus: [], liste: [{ begriff: 'Seeblick Gruppe', art: 'FIRMA' }], artikelnummer: ARTIKEL_SEED };
const quelle = { laden: async () => einstellungen };
const kaputteQuelle = { laden: async (): Promise<SchutzEinstellungen> => { throw new Error('DB weg'); } };

const aufrufe: { modell: string; body: any }[] = [];
let naechsteAntwort: (body: any) => string = () => 'ok';
const WEG_CLOUD: KiWeg = {
  id: 'cloud', name: 'Cloud', art: 'cloud', modell: 'cloud-test', endpunkt_variable: 'KI_WEG_TEST_URL', schluessel_variable: 'KI_WEG_CLOUD_KEY',
  zeitlimit_s: 5, zusatz_parameter: {}, budget_lesen: false, aktiv: true, reihenfolge: 1,
};
const deps: KiAbhaengigkeiten = {
  wegLaden: async (id) => (id === 'cloud' ? WEG_CLOUD : null),
  wegeLaden: async () => [WEG_CLOUD],
  darfCloud: async (nutzer) => nutzer === 'nutzer-frei',
  env: (n) => ({ KI_WEG_TEST_URL: 'http://attrappe.invalid/v1', KI_WEG_CLOUD_KEY: 'k-test' } as Record<string, string>)[n],
  client: () => ({
    create: async (body) => {
      aufrufe.push({ modell: String(body.model), body });
      return { data: { choices: [{ message: { content: naechsteAntwort(body) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
    },
  }),
  holeJson: async () => ({ status: 404, body: null }),
  jetzt: () => Date.now(),
};
const gesendeterText = (i = aufrufe.length - 1) => aufrufe[i]!.body.messages[1].content as string;

describe('C Vorschau und Senden', () => {
  const TEXT = 'Sehr geehrter Herr Karl Moser, die Seeblick Gruppe zahlt 4.860,00 € auf IBAN AT61 1904 3002 3457 3201. Rückfragen an k.moser@kunde.example. Band LS24 5050 RGBW, 24 V, 3000 K.';

  it('Vorschau: ausgehender Text, Segmente, Zähler, Restprüfung', async () => {
    vorschauenLeeren();
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: TEXT }, quelle);
    for (const w of ['Moser', 'Seeblick', '4.860', '1904', 'k.moser']) expect(v.ausgehend).not.toContain(w);
    for (const w of ['LS24 5050 RGBW', '24 V', '3000 K']) expect(v.ausgehend).toContain(w);
    expect(v.restpruefung.ok).toBe(true);
    const seg = v.segmente.filter((s) => 'platzhalter' in s) as any[];
    expect(seg.find((s) => s.art === 'IBAN')!.pflicht).toBe(true);
    expect(seg.find((s) => s.art === 'PREIS')!.pflicht).toBe(false);
    expect(v.segmente.map((s: any) => s.text ?? s.platzhalter).join('')).toBe(v.ausgehend);
    expect(v.zaehler.BANK).toBe(1);
  });

  it('Senden schickt genau den gespeicherten Text, mit Hinweis, und setzt zurück', async () => {
    vorschauenLeeren();
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: TEXT }, quelle);
    const vorher = aufrufe.length;
    naechsteAntwort = (body) => body.messages[1].content.replace('zahlt', 'überweist');
    const e = await pseudonymSenden({ vorschauId: v.vorschauId, nutzerId: 'nutzer-frei', wegId: 'cloud', system: 'Korrigiere.' }, deps);
    expect(aufrufe.length).toBe(vorher + 1);
    expect(gesendeterText()).toBe(v.ausgehend);
    expect(aufrufe[aufrufe.length - 1]!.body.messages[0].content).toContain(PSEUDONYM_HINT);
    for (const w of ['Moser', 'Seeblick', '1904', 'k.moser', '4.860']) expect(JSON.stringify(aufrufe[aufrufe.length - 1]!.body)).not.toContain(w);
    expect(e.text).toContain('Karl Moser');
    expect(e.text).toContain('überweist 4.860,00 €');
    expect(e.fehlend).toEqual([]);
  });

  it('fehlender Platzhalter wird gemeldet, nicht verworfen', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Karl Moser zahlt 500 €.' }, quelle);
    naechsteAntwort = () => '[PERSON_1] zahlt.';
    const e = await pseudonymSenden({ vorschauId: v.vorschauId, nutzerId: 'nutzer-frei', wegId: 'cloud', system: 'Kürze.' }, deps);
    expect(e.fehlend.map((f) => f.klasse).join()).toBe('PREIS');
  });

  const fehlerCode = async (f: () => Promise<unknown>): Promise<string> => {
    try { await f(); } catch (err) { return err instanceof PseudonymFehler ? err.code : `ANDERER:${(err as Error).message}`; }
    return 'KEIN_FEHLER';
  };

  it('[REDACTED] in der Antwort verwirft (vom Proxy geschwärzt), erfundener Platzhalter verwirft', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Band LS24 5050 RGBW für Karl Moser.' }, quelle);
    naechsteAntwort = () => 'Band [REDACTED] für [PERSON_1].';
    expect(await fehlerCode(() => pseudonymSenden({ vorschauId: v.vorschauId, nutzerId: 'nutzer-frei', wegId: 'cloud', system: 'x' }, deps))).toBe('PROXY_GESCHWAERZT');
    naechsteAntwort = () => 'Band LS24 5050 RGBW für [PERSON_1] und [PERSON_2].';
    expect(await fehlerCode(() => pseudonymSenden({ vorschauId: v.vorschauId, nutzerId: 'nutzer-frei', wegId: 'cloud', system: 'x' }, deps))).toBe('PLATZHALTER_UNBEKANNT');
  });

  it('fremde, unbekannte und abgelaufene Vorschau: 404-Code und kein Aufruf', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Karl Moser' }, quelle);
    const vorher = aufrufe.length;
    expect(await fehlerCode(() => pseudonymSenden({ vorschauId: v.vorschauId, nutzerId: 'nutzer-anderer', wegId: 'cloud', system: 'x' }, deps))).toBe('VORSCHAU_UNBEKANNT');
    expect(await fehlerCode(() => pseudonymSenden({ vorschauId: 'gibt-es-nicht', nutzerId: 'nutzer-frei', wegId: 'cloud', system: 'x' }, deps))).toBe('VORSCHAU_UNBEKANNT');
    expect(await fehlerCode(() => pseudonymSenden({ vorschauId: v.vorschauId, nutzerId: 'nutzer-frei', wegId: 'cloud', system: 'x' }, deps, Date.now() + GRENZEN.gueltigMs + 1))).toBe('VORSCHAU_UNBEKANNT');
    expect(aufrufe.length).toBe(vorher);
  });

  it('Pflichtklasse übrig: PFLICHT_UEBRIG und kein Aufruf', async () => {
    // Eine Adresse ohne Endung erkennt die Erkennung nicht, die breitere Restprüfung schon: Dann geht nichts hinaus.
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Bitte an rechnung@kunde schicken.' }, quelle);
    expect(v.restpruefung.ok).toBe(false);
    const vorher = aufrufe.length;
    expect(await fehlerCode(() => pseudonymSenden({ vorschauId: v.vorschauId, nutzerId: 'nutzer-frei', wegId: 'cloud', system: 'x' }, deps))).toBe('PFLICHT_UEBRIG');
    expect(aufrufe.length).toBe(vorher);
  });

  it('IBAN auch klein geschrieben und mit Punkten', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Konto at61.1904.3002.3457.3201 bitte' }, quelle);
    expect(v.ausgehend).not.toContain('1904');
    expect(v.restpruefung.ok).toBe(true);
    expect(restpruefung('Konto at61.1904.3002.3457.3201').ok).toBe(false);
  });

  it('Einstellungen nicht lesbar: keine Vorschau (G4)', async () => {
    expect(await fehlerCode(() => vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Karl Moser' }, kaputteQuelle))).toBe('EINSTELLUNGEN');
  });

  it('eine Pflichtklasse aus der Tabelle wird übergangen', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Mail an a.b@kunde.example' }, { laden: async () => ({ ...einstellungen, aus: ['MAIL', 'PREIS'] }) });
    expect(v.ausgehend).not.toContain('kunde.example');
    expect(v.klassenAus).toEqual(['PREIS']);
  });

  it('Eingaben werden geprüft', async () => {
    expect(await fehlerCode(() => vorschauErstellen({ nutzerId: 'u', text: '' }, quelle))).toBe('EINGABE');
    expect(await fehlerCode(() => vorschauErstellen({ nutzerId: 'u', text: 'x'.repeat(GRENZEN.zeichen + 1) }, quelle))).toBe('EINGABE');
    expect(await fehlerCode(() => vorschauErstellen({ nutzerId: 'u', text: 'a', verdecken: ['[PERSON_1]'] }, quelle))).toBe('EINGABE');
    expect(await fehlerCode(() => vorschauErstellen({ nutzerId: 'u', text: 'a', verdecken: 'kein Array' }, quelle))).toBe('EINGABE');
    // Review M1: Platzhalter im Text oder in verdecken
    expect(await fehlerCode(() => vorschauErstellen({ nutzerId: 'u', text: 'Test [PERSON_1] [PERSON_2]' }, quelle))).toBe('EINGABE');
    expect(await fehlerCode(() => vorschauErstellen({ nutzerId: 'u', text: 'Gut', verdecken: ['EMAIL_1'] }, quelle))).toBe('EINGABE');
  });

  it('Review H1 über den echten Weg: ein nie gesendeter Platzhalter in der Antwort verwirft', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Herr Karl Moser ruft an.' }, quelle);
    naechsteAntwort = () => 'Herr [PERSON_1] ruft an, Vertretung [PERSON_2].';
    expect(await fehlerCode(() => pseudonymSenden({ vorschauId: v.vorschauId, nutzerId: 'nutzer-frei', wegId: 'cloud', system: 'x' }, deps))).toBe('PLATZHALTER_UNBEKANNT');
  });

  it('Treffer der Schutzliste sind in den Segmenten nicht aufdeckbar', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Die Seeblick Gruppe zahlt 500 €.' }, quelle);
    const seg = v.segmente.filter((s) => 'platzhalter' in s) as any[];
    expect(seg.find((s) => s.art === 'FIRMA')!.aufdeckbar).toBe(false);
    expect(seg.find((s) => s.art === 'PREIS')!.aufdeckbar).toBe(true);
  });

  it('ein ungültiges Muster in der Tabelle: keine Vorschau statt einer mit Vorgaben', async () => {
    expect(await fehlerCode(() => vorschauErstellen({ nutzerId: 'u', text: 'Gut' }, { laden: async () => ({ ...einstellungen, artikelnummer: '(?:\\d+)+' }) }))).toBe('EINSTELLUNGEN');
  });

  it('selbst verdeckt und aufgedeckt erzeugen eine neue Vorschau mit anderem Text', async () => {
    const a = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Das Hotel Seeblick bestellt bei Mayrhofer Licht.' }, quelle);
    const b = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: 'Das Hotel Seeblick bestellt bei Mayrhofer Licht.', verdecken: ['Mayrhofer'], aufdecken: ['Hotel Seeblick'] }, quelle);
    expect(a.vorschauId).not.toBe(b.vorschauId);
    expect(a.ausgehend).toContain('Mayrhofer');
    expect(b.ausgehend).not.toContain('Mayrhofer');
    expect(b.ausgehend).toContain('Hotel Seeblick');
    expect(b.aufgedeckt).toEqual(['Hotel Seeblick']);
  });

  it('höchstens 20 Vorschauen je Nutzer im Speicher', async () => {
    vorschauenLeeren();
    for (let i = 0; i < 25; i += 1) await vorschauErstellen({ nutzerId: 'nutzer-viel', text: `Text ${i}` }, quelle);
    expect(vorschauAnzahl()).toBe(GRENZEN.jeNutzer);
  });
});

// Routen über HTTP: Anmeldung per Kopfzeile ersetzt, alles andere echt.
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
const liste: SchutzListeZeile[] = [];
const klassen = new Map<string, { aktiv: boolean; muster: string | null }>();
const schutzSpeicher: SchutzSpeicher = {
  laden: async () => ({
    aus: [...klassen].filter(([, z]) => !z.aktiv).map(([k]) => k as Schutzklasse),
    liste: liste.map((l) => ({ begriff: l.begriff, art: l.art })),
    artikelnummer: klassen.get('ARTIKELNR')?.muster ?? null,
  }),
  klassenLesen: async () => [...klassen].map(([klasse, z]) => ({ klasse: klasse as Schutzklasse, ...z, geaendert_am: null })),
  listeLesen: async () => liste,
  klasseSetzen: async (k, f) => {
    const z = klassen.get(k) ?? { aktiv: true, muster: null };
    klassen.set(k, { aktiv: f.aktiv ?? z.aktiv, muster: f.muster !== undefined ? f.muster : z.muster });
    return true;
  },
  begriffAnlegen: async (begriff, art) => {
    if (liste.some((l) => l.begriff.toLowerCase() === begriff.toLowerCase())) return null;
    const z = { id: liste.length + 1, begriff, art, angelegt_am: null };
    liste.push(z);
    return z;
  },
  begriffLoeschen: async (id) => {
    const i = liste.findIndex((l) => l.id === id);
    if (i < 0) return false;
    liste.splice(i, 1);
    return true;
  },
};

describe('C Routen', () => {
  let server: Server;
  let basis = '';
  const rufe = async (methode: string, pfad: string, nutzer: string, body?: unknown) => {
    const r = await fetch(`${basis}${pfad}`, {
      method: methode,
      headers: { 'Content-Type': 'application/json', 'x-test-user': nutzer },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (r.status === 204 ? null : await r.json().catch(() => null)) as any };
  };

  it('Server starten', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/textwerkstatt', textwerkstattRouter({ deps, schutz: schutzSpeicher, requireAuth: fakeAuth(false), requireAdmin: fakeAuth(true) }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    basis = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/textwerkstatt`;
  });

  it('Vorschau: ohne Freischaltung 403, freigeschaltet und Admin 200', async () => {
    const vorher = aufrufe.length;
    expect((await rufe('POST', '/vorschau', 'nutzer-gesperrt', { text: 'Karl Moser' })).status).toBe(403);
    expect((await rufe('POST', '/vorschau', 'nutzer-frei', { text: 'Karl Moser' })).status).toBe(200);
    const a = await rufe('POST', '/vorschau', 'admin-1', { text: 'Karl Moser zahlt 500 €' });
    expect(a.status).toBe(200);
    expect(a.body.ausgehend).toBe('[PERSON_1] zahlt [PREIS_1]');
    expect(aufrufe.length).toBe(vorher); // die Vorschau sendet nichts
  });

  it('Schutzregeln: nur Admin, Pflichtklasse nie aus, Muster geprüft', async () => {
    expect((await rufe('GET', '/schutz', 'nutzer-frei')).status).toBe(403);
    const g = await rufe('GET', '/schutz', 'admin-1');
    expect(g.status).toBe(200);
    expect(g.body.klassen.length).toBe(11);
    expect((await rufe('PUT', '/schutz/klassen/MAIL', 'admin-1', { aktiv: false })).status).toBe(400);
    expect((await rufe('PUT', '/schutz/klassen/BANK', 'admin-1', { aktiv: false })).status).toBe(400);
    expect((await rufe('PUT', '/schutz/klassen/PREIS', 'admin-1', { aktiv: false })).status).toBe(200);
    expect((await rufe('PUT', '/schutz/klassen/PREIS', 'admin-1', { muster: '\\d+' })).status).toBe(400);
    expect((await rufe('PUT', '/schutz/klassen/ARTIKELNR', 'admin-1', { muster: '[a-z]+' })).status).toBe(400);
    expect((await rufe('PUT', '/schutz/klassen/ARTIKELNR', 'admin-1', { muster: ARTIKEL_SEED })).status).toBe(200);
    expect((await rufe('PUT', '/schutz/klassen/GIBTS', 'admin-1', { aktiv: false })).status).toBe(404);
    const v = await rufe('POST', '/vorschau', 'admin-1', { text: 'Karl Moser zahlt 500 € für 31027' });
    expect(v.body.ausgehend).toBe('[PERSON_1] zahlt 500 € für [ARTIKELNR_1]');
    expect(v.body.klassenAus).toEqual(['PREIS']);
    expect((await rufe('PUT', '/schutz/klassen/PREIS', 'admin-1', { aktiv: true })).status).toBe(200);
  });

  it('Schutzliste: anlegen, doppelt 409, Klammern 400, löschen', async () => {
    const a = await rufe('POST', '/schutz/liste', 'admin-1', { begriff: 'Alpenrose', art: 'PROJEKT' });
    expect(a.status).toBe(201);
    expect((await rufe('POST', '/schutz/liste', 'admin-1', { begriff: 'alpenrose', art: 'FIRMA' })).status).toBe(409);
    expect((await rufe('POST', '/schutz/liste', 'admin-1', { begriff: '[PERSON_1]' })).status).toBe(400);
    expect((await rufe('POST', '/schutz/liste', 'admin-1', { begriff: 'X', art: 'FIRMA' })).status).toBe(400);
    expect((await rufe('POST', '/schutz/liste', 'admin-1', { begriff: 'Gut', art: 'GEHEIM' })).status).toBe(400);
    expect((await rufe('POST', '/schutz/liste', 'nutzer-frei', { begriff: 'Gut' })).status).toBe(403);
    const v = await rufe('POST', '/vorschau', 'nutzer-frei', { text: 'Das Hotel Alpenrose bestellt.' });
    expect(v.body.ausgehend).toBe('Das Hotel [PROJEKT_1] bestellt.');
    expect((await rufe('DELETE', `/schutz/liste/${a.body.id}`, 'admin-1')).status).toBe(204);
    expect((await rufe('DELETE', `/schutz/liste/${a.body.id}`, 'admin-1')).status).toBe(404);
    expect((await rufe('DELETE', '/schutz/liste/1e21', 'admin-1')).status).toBe(400);
    expect((await rufe('POST', '/schutz/liste', 'admin-1', { begriff: 'PERSON_1', art: 'FIRMA' })).status).toBe(400);
  });

  it('Schutzliste hat eine Obergrenze', async () => {
    const vorher = liste.length;
    for (let i = 0; i < SCHUTZLISTE_HOECHSTENS; i += 1) liste.push({ id: 10_000 + i, begriff: `Begriff ${i}`, art: 'BEGRIFF', angelegt_am: null });
    expect((await rufe('POST', '/schutz/liste', 'admin-1', { begriff: 'Noch einer', art: 'FIRMA' })).status).toBe(409);
    liste.splice(vorher);
  });

  it('Vorschau mit Platzhalter im Text: 400 mit Code', async () => {
    const r = await rufe('POST', '/vorschau', 'nutzer-frei', { text: 'Hallo [PERSON_1]' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('EINGABE');
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
