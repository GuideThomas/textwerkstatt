/**
 * Prüft die Stilprofile der Textwerkstatt (Plan `PLAN-textwerkstatt.md` §4 Phase 5, Cockpit #1841).
 * Ohne Datenbank und ohne fremdes Netz: Profile, Arten, Hausschreibweise, Schutzregeln, Laufprotokoll und KI-Endpunkt sind
 * Attrappen, die jeden Aufruf zählen und den gesendeten Körper festhalten. Das Einlesen läuft gegen einen Server auf 127.0.0.1;
 * dafür lockert das Skript ausdrücklich die Adress- und Portprüfung, die es vorher gegen denselben Server greifen lässt.
 *
 * Aufruf:
 *   DB_PASSWORD=egal npx tsx src/scripts/check-stilprofile.ts
 *
 *   A  reine Funktionen: Felder, Fassung, Anweisung, Ableitung lesen, Befund „darf in die Cloud“, Adressen, HTML zu Text
 *   B  Einlesen über HTTP: Sperren (Name, Adresse beim Verbinden, Weiterleitung, Port, Größe, Art), gutes Ergebnis
 *   C  Dienst `optimieren` mit Profil: was in die Anweisung geht, was nicht hinausgeht, Channel-Fassung danach, Laufzeile
 *   D  Routen: Rechte, Anlegen, Ändern mit Fassung, Verlauf, Einlesen, Ableiten lokal und Cloud
 *
 * Neben jedem Negativpfad steht der Aufrufzähler der Attrappe (0 = nichts gesendet) bzw. der Verbindungszähler des Servers.
 */
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { OptimierArt } from '../services/optimieren/pruefung';
import { optimieren, OptimierFehler, LaufZeile, OptimierAbhaengigkeiten, systemBauen, veraenderlicheTeile, werteSperren } from '../services/optimieren/optimieren';
import {
  StilProfil, ableitungLesen, beispielZeilen, neueFassung, profilPruefen, profilStandPruefen, stilAnweisung, stilCloudBefund, ABLEIT_SYSTEM,
} from '../services/optimieren/stilprofile';
import { ReferenzFehler, ReferenzOptionen, adresseGesperrt, htmlZuText, istAdresse, kuerzen, referenzHolen, textSaeubern, urlPruefen } from '../services/optimieren/referenz';
import { vorschauErstellen, PseudonymFehler, SchutzEinstellungen } from '../services/pseudonym/vorschau';
import { KiAbhaengigkeiten, KiWeg, KiWegFehler, kiZustandZuruecksetzen } from '../services/ki-weg';
import type { HouseTerm } from '../services/house-terms';
import { textwerkstattRouter, OptimierSpeicher, SchutzSpeicher, StilSpeicher, StilVerlaufZeile, stilGeaendert } from '../routes/textwerkstatt';
import { SYSTEM_PROMPT as CHANNEL_SYSTEM } from '../services/channel-fassung';

// ── Nachbildung von it/expect (wie check-optimieren.ts) ─────────────────────────────────────────────────────────
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
const fehlerCode = async (f: () => Promise<unknown>): Promise<string> => {
  try { await f(); } catch (err) {
    if (err instanceof OptimierFehler || err instanceof PseudonymFehler || err instanceof KiWegFehler || err instanceof ReferenzFehler) return err.code;
    return `ANDERER:${(err as Error).message}`;
  }
  return 'KEIN_FEHLER';
};

// ── Attrappen ────────────────────────────────────────────────────────────────────────────────────────────────────
const art = (id: string, f: Partial<OptimierArt> = {}): OptimierArt => ({
  id, name: id, beschreibung: '', anweisung: `Anweisung ${id}: bitte überarbeiten.`, zahlen: 'alle', platzhalter_fehlen_erlaubt: false,
  anrede: 'beibehalten', umstellen_erlaubt: true, laenge_min: 0.5, laenge_max: 1.8, zielzeichen: false, aktiv: true, reihenfolge: 0, ...f,
});
const VERKAUF = art('verkaufsfoerdernd');
const ARTEN = [VERKAUF];

const profil = (id: string, f: Partial<StilProfil> = {}): StilProfil => ({
  id, name: id.toUpperCase(), channel_code: null, beschreibung: '- kurze Sätze\n- aktiv statt passiv\n- sachlich, freundlich, ohne Superlative',
  beispiele: 'Das Profil sitzt fest.\nDie Montage gelingt in wenigen Schritten.', quelle_art: 'hand', quelle_url: null, quelle_zeichen: null,
  fassung: 3, aktiv: true, reihenfolge: 0, cloud_freigabe_fassung: 3, ...f,
});
const SACHLICH = profil('sachlich');
const KANAL = profil('kanal', { channel_code: 'KANAL' });
const AUS = profil('aus', { aktiv: false });
const MIT_NAME = profil('mit-name', { beispiele: 'Wie Herr Karl Huber sagt: Das Profil sitzt fest.' });
const MIT_TELEFON = profil('mit-telefon', { beschreibung: '- kurze Sätze, Rückfragen an +43 512 123456\n- aktiv statt passiv' });
const MIT_LISTE = profil('mit-liste', { beschreibung: '- schreibt wie die Seeblick Gruppe: knapp, sachlich, ohne Füllwörter' });
const MIT_NUMMER = profil('mit-nummer', { beispiele: 'Das Profil 31027 sitzt fest.' });
const VERRAET = profil('verraet', { beschreibung: '- erwähnt Lichtleisten immer mit Nutzen, sachlich und kurz' });
// Freigegeben war Fassung 2, das Profil steht inzwischen auf Fassung 3 (Review M4).
const NICHT_FREI = profil('nicht-frei', { cloud_freigabe_fassung: 2 });
const NIE_FREI = profil('nie-frei', { cloud_freigabe_fassung: null });
const PROFILE = [SACHLICH, KANAL, AUS, MIT_NAME, MIT_TELEFON, MIT_LISTE, MIT_NUMMER, VERRAET, NICHT_FREI, NIE_FREI];

const HAUS: HouseTerm[] = [
  { avoidTerm: 'LED-Treiber', preferredTerm: 'LED-Trafo', note: null },
  { avoidTerm: 'Lichtband', preferredTerm: 'LED-Streifen', note: null },
];
const schutz: SchutzEinstellungen = {
  aus: [], liste: [{ begriff: 'Seeblick Gruppe', art: 'FIRMA' }, { begriff: 'Lichtband Profi', art: 'FIRMA' }], artikelnummer: '[1-9][0-9]{4,6}',
};
const quelle = { laden: async () => schutz };

const aufrufe: { modell: string; body: any }[] = [];
let naechsteAntwort: (body: any) => string = (body) => body.messages[1].content;
let channelKaputt = false;
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
      const istChannel = String((body as any).messages?.[0]?.content ?? '') === CHANNEL_SYSTEM;
      if (istChannel && channelKaputt) throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'APIConnectionError' });
      aufrufe.push({ modell: String(body.model), body });
      return { data: { choices: [{ message: { content: naechsteAntwort(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7 } } };
    },
  }),
  holeJson: async () => ({ status: 404, body: null }),
  jetzt: () => Date.now(),
};
const laeufe: LaufZeile[] = [];
const verbrauch: { modell: string }[] = [];
const dienst: OptimierAbhaengigkeiten = {
  ki,
  artLaden: async (id) => ARTEN.find((a) => a.id === id) ?? null,
  begriffeLaden: async () => HAUS,
  schutzLaden: async () => schutz,
  laufMerken: async (z) => { laeufe.push(z); },
  verbrauchMerken: async (modell) => { verbrauch.push({ modell }); },
  stilLaden: async (id) => PROFILE.find((p) => p.id === id) ?? null,
};
const letzte = () => aufrufe[aufrufe.length - 1]!;
const TEXT = 'Das Profil ALU-12 bringt bei 24 V eine Leistung von 14,4 W/m. Es eignet sich für Küchen und Regale.';
const TEXT_TREIBER = 'Der LED-Treiber liefert 24 V und 60 W. Er passt in jede Unterkonstruktion.';

// ═══ A. Reine Funktionen ══════════════════════════════════════════════════════════════════════════════════════
describe('A Felder und Fassung', () => {
  it('profilPruefen: gültig, Vorgaben beim Anlegen, unbekannte Felder fallen weg', () => {
    const p = profilPruefen({ id: 'shopa', name: ' SHOPA ', channel_code: 'SHOPA', fremd: 'x' }, true);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.felder.name).toBe('SHOPA');
    expect(p.felder.aktiv).toBe(false);
    expect(p.felder.quelle_art).toBe('hand');
    expect('fremd' in p.felder).toBe(false);
  });
  it('profilPruefen: lehnt Kennung, Länge, Platzhalter, Quelle, Channel ab', () => {
    const bad = (e: any, voll = false) => expect(profilPruefen(e, voll).ok).toBe(false);
    bad({ id: 'Groß', name: 'x' }, true);
    bad({ id: 'ok', name: '' }, true);
    bad({ beschreibung: 'x'.repeat(3001) });
    bad({ beispiele: 'Wie [PERSON_1] sagt.' });
    bad({ beschreibung: 'Text mit [Person 2] darin' });
    bad({ beschreibung: 'Text mit [REDACTED] darin' });
    bad({ quelle_art: 'ftp' });
    bad({ quelle_url: 'ftp://beispiel.test/' });
    bad({ quelle_url: 'https://nutzer:pw@beispiel.test/' });
    bad({ channel_code: 'mit leerzeichen' });
    bad({ aktiv: 'ja' });
    bad({ quelle_zeichen: true });
  });
  it('profilStandPruefen: einschalten erst mit Beschreibung, Adresse nur bei Quelle „url“', () => {
    expect(profilStandPruefen({ aktiv: true, beschreibung: 'zu kurz', quelle_art: 'hand', quelle_url: null })).not.toBeNull();
    expect(profilStandPruefen({ aktiv: true, beschreibung: 'x'.repeat(20), quelle_art: 'hand', quelle_url: null })).toBeNull();
    expect(profilStandPruefen({ aktiv: false, beschreibung: '', quelle_art: 'url', quelle_url: null })).not.toBeNull();
    expect(profilStandPruefen({ aktiv: false, beschreibung: '', quelle_art: 'text', quelle_url: 'https://beispiel.test/' })).not.toBeNull();
  });
  it('neueFassung: nur bei Inhalt, nicht bei Name, Reihenfolge, aktiv', () => {
    expect(neueFassung(SACHLICH, { name: 'Neu', reihenfolge: 4, aktiv: false })).toBe(false);
    expect(neueFassung(SACHLICH, { beschreibung: SACHLICH.beschreibung })).toBe(false);
    expect(neueFassung(SACHLICH, { beschreibung: `${SACHLICH.beschreibung}\n- mehr` })).toBe(true);
    expect(neueFassung(SACHLICH, { channel_code: 'KANAL' })).toBe(true);
    expect(neueFassung(SACHLICH, { quelle_art: 'url', quelle_url: 'https://beispiel.test/' })).toBe(true);
  });
});

describe('A Anweisung', () => {
  it('stilAnweisung: Beschreibung, Beispiele als Vorbild ohne Inhalt, ohne Profilnamen', () => {
    const a = stilAnweisung(SACHLICH);
    expect(a).toContain('- aktiv statt passiv');
    expect(a).toContain('- Die Montage gelingt in wenigen Schritten.');
    expect(a).toContain('Übernimm daraus keinen Inhalt');
    // Probelauf 11.11.2026: Ein Profil darf die Anrede nicht einführen und keine Sätze anhängen.
    expect(a).toContain('Wer im Text nicht angesprochen wird, wird auch jetzt nicht angesprochen');
    expect(ABLEIT_SYSTEM).toContain('Lege keine Anrede fest');
    expect(ABLEIT_SYSTEM).not.toContain('Anrede des Lesers (du, Sie oder keine)');
    expect(a).not.toContain(SACHLICH.name);
    expect(stilAnweisung({ beschreibung: 'nur Beschreibung, ohne Beispiele', beispiele: '' })).not.toContain('Beispielsätze');
  });
  it('systemBauen: Profil zwischen Anweisung der Art und festen Regeln; ohne Profil wie bisher', () => {
    const mit = systemBauen(VERKAUF, { zielzeichen: null, markup: false, begriffe: [], stil: SACHLICH });
    const ohne = systemBauen(VERKAUF, { zielzeichen: null, markup: false, begriffe: [] });
    expect(mit.indexOf(VERKAUF.anweisung) < mit.indexOf('aktiv statt passiv')).toBe(true);
    expect(mit.indexOf('aktiv statt passiv') < mit.indexOf('Dabei gilt immer:')).toBe(true);
    expect(ohne).not.toContain('Schreibe in diesem Stil');
  });
  it('veraenderlicheTeile: enthält Beschreibung und Beispiele des Profils (Schranke in pseudonymSenden)', () => {
    const v = veraenderlicheTeile(VERKAUF, { zielzeichen: null, begriffe: [], stil: VERRAET });
    expect(v).toContain('Lichtleisten');
    expect(v).toContain('Die Montage gelingt');
  });
  it('beispielZeilen: ohne Aufzählungszeichen und Leerzeilen', () => {
    expect(beispielZeilen('- eins\n\n• zwei\n3) drei\n  vier ')).toEqual(['eins', 'zwei', 'drei', 'vier']);
  });
});

describe('A Ableitung lesen', () => {
  it('mit Marken: Stil und Beispiele getrennt, Anführungszeichen weg', () => {
    const a = ableitungLesen('STIL:\n- kurze Sätze\n- duzt den Leser\n\nBEISPIELE:\n- „Du montierst das Profil in Minuten.“\n- "Das hält."');
    expect(a.erkannt).toBe(true);
    expect(a.beschreibung).toBe('- kurze Sätze\n- duzt den Leser');
    expect(a.beispiele).toBe('Du montierst das Profil in Minuten.\nDas hält.');
  });
  it('Marken fett oder als Überschrift', () => {
    const a = ableitungLesen('**STIL:**\n- knapp\n## BEISPIELE\n- Kurz und gut.');
    expect(a.beschreibung).toBe('- knapp');
    expect(a.beispiele).toBe('Kurz und gut.');
  });
  it('ohne Marken: alles ist Beschreibung, nichts geht verloren', () => {
    const a = ableitungLesen('Der Text ist knapp und sachlich.');
    expect(a.erkannt).toBe(false);
    expect(a.beschreibung).toBe('Der Text ist knapp und sachlich.');
  });
  it('gekürzt auf die Grenzen der Tabelle', () => {
    const a = ableitungLesen(`STIL:\n${'x'.repeat(5000)}\nBEISPIELE:\n${'y '.repeat(2000)}`);
    expect(a.beschreibung.length).toBe(3000);
    expect(a.beispiele.length <= 2000).toBe(true);
  });
});

describe('A Befund „darf in die Cloud“', () => {
  it('ein Profil ohne Angaben ist frei', () => {
    expect(stilCloudBefund(SACHLICH, schutz).ok).toBe(true);
  });
  it('Name, Telefon, Schutzliste, Artikelnummer sperren; gezählt je Klasse, nie der Wert', () => {
    for (const p of [MIT_NAME, MIT_TELEFON, MIT_LISTE, MIT_NUMMER]) {
      const b = stilCloudBefund(p, schutz);
      expect(b.ok).toBe(false);
      for (const w of ['Huber', '123456', 'Seeblick', '31027']) expect(JSON.stringify(b)).not.toContain(w);
    }
    expect(stilCloudBefund(MIT_NAME, schutz).klassen.PERSON).toBe(1);
  });
  it('eine abgeschaltete Klasse zählt nicht, eine Pflichtklasse immer', () => {
    expect(stilCloudBefund(MIT_NUMMER, { ...schutz, aus: ['ARTIKELNR'] }).ok).toBe(true);
    expect(stilCloudBefund(MIT_TELEFON, { ...schutz, aus: ['TELEFON' as any] }).ok).toBe(false);
  });
});

describe('A Adressen', () => {
  it('gesperrt: Rückschleife, Hausnetz, Verbindungslokal, Metadaten, CGNAT, IPv6-Formen', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'fe80::1', 'fc00::1', 'fd12:3456::1',
      '64:ff9b::7f00:1', '2002:7f00:1::1', 'ff02::1', '2001:db8::1', 'kein-ip',
      // Review N3: übersetzte IPv4, NAT64 für das eigene Netz, Teredo
      '::ffff:0:7f00:1', '::ffff:0:10.0.0.1', '64:ff9b:1::1', '2001:0:4136:e378::1']) {
      if (!adresseGesperrt(ip)) throw new Fehlschlag(`nicht gesperrt: ${ip}`);
    }
  });
  it('frei: öffentliche Adressen, auch knapp neben gesperrten Netzen', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.255.255', '100.128.0.1', '193.170.1.1', '2a00:1450:4001::1', '::ffff:8.8.8.8']) {
      if (adresseGesperrt(ip)) throw new Fehlschlag(`gesperrt: ${ip}`);
    }
  });
  it('urlPruefen: Protokoll, Zugangsdaten, Port, Namen ohne Punkt, lokale Namen, IP-Schreibungen', async () => {
    for (const u of ['ftp://beispiel.at/', 'file:///etc/passwd', 'https://a:b@beispiel.at/', 'https://beispiel.at:8443/', 'http://intranet/',
      'http://localhost/', 'http://server.local/', 'http://127.0.0.1/', 'http://[::1]/', 'http://0x7f000001/', 'http://2130706433/',
      'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'kein url', '']) {
      const c = await fehlerCode(async () => urlPruefen(u));
      if (c !== 'URL_UNGUELTIG' && c !== 'ZIEL_GESPERRT') throw new Fehlschlag(`${u} → ${c}`);
    }
    expect(urlPruefen('https://www.beispiel.at/ueber-uns').hostname).toBe('www.beispiel.at');
    expect(urlPruefen('http://beispiel.at:80/').port).toBe('');
  });
});

describe('A HTML zu Text', () => {
  const SEITE = `<!DOCTYPE html><html><head><title>Über uns &amp; Team</title><style>p{color:red}</style>
    <script>var geheim = "Skripttext";</script></head><body>
    <header><nav><a href="/">Start</a><a href="/p">Produkte</a></nav></header>
    <main><h1>Licht, das bleibt</h1>
    <p>Wir entwickeln Profile für Lichtbänder, die sich in wenigen Minuten montieren lassen. Mehr auf <a href="https://beispiel.at/x">https://beispiel.at/x</a>.</p>
    <p>Fragen? Schreib an info@beispiel.at oder besuche www.beispiel.at &ndash; wir helfen gern.</p>
    <!-- ein Kommentar -->
    <p>Wir entwickeln Profile für Lichtbänder, die sich in wenigen Minuten montieren lassen. Mehr auf <a href="https://beispiel.at/x">https://beispiel.at/x</a>.</p>
    <ul><li>Kontakt</li><li>Jetzt kaufen</li></ul>
    <p>Gr&ouml;&szlig;e &#x26; Form: drei &#8222;Standard&#8220;-Längen.</p></main>
    <footer>Impressum · Datenschutz · AGB</footer></body></html>`;
  it('Hauptteil, ohne Skript, Stil, Navigation, Fuß, Kommentar; Entitäten aufgelöst; Wiederholung einmal', () => {
    const r = htmlZuText(SEITE);
    expect(r.titel).toBe('Über uns & Team');
    expect(r.text).toContain('Wir entwickeln Profile für Lichtbänder');
    expect(r.text).toContain('Größe & Form: drei „Standard“-Längen.');
    for (const w of ['Skripttext', 'color:red', 'Impressum', 'Kommentar', 'Produkte', 'Jetzt kaufen']) expect(r.text).not.toContain(w);
    expect(r.text.split('Wir entwickeln').length).toBe(2);
  });
  it('keine Adressen und keine Mailadressen im Text', () => {
    const r = htmlZuText(SEITE);
    for (const w of ['https://', 'http://', 'www.', '@', 'beispiel.at']) expect(r.text).not.toContain(w);
  });
  it('Review N2: Adressen in Klammern, nach „Link:“, als Rechnername mit Pfad, in spitzen Klammern und Anführungszeichen fallen weg', () => {
    for (const w of ['(https://beispiel.at/x)', 'Link:https://beispiel.at/x', 'beispiel.at/profile', '<https://beispiel.at/x>', '„https://beispiel.at/x“',
      'info@beispiel.at', '(www.beispiel.at)', 'mailto:a@b.at']) {
      if (!istAdresse(w)) throw new Fehlschlag(`nicht erkannt: ${w}`);
    }
    for (const w of ['24/7', 'm/s', 'und/oder', 'z.B.', 'ca.', 'IP67/IP68', 'Alu/PMMA', '3.000/4.000']) {
      if (istAdresse(w)) throw new Fehlschlag(`zu Unrecht gestrichen: ${w}`);
    }
    const r = htmlZuText(`<main><p>Mehr dazu (https://beispiel.at/x), Link:https://beispiel.at/y und beispiel.at/profile sowie &lt;https://beispiel.at/z&gt; im Netz.</p>
      <p>Ein zweiter Satz mit genug Wörtern, damit die Seite Fließtext hat, und ohne jede Adresse darin, rund um die Uhr 24/7.</p></main>`);
    for (const w of ['https://', 'beispiel.at']) expect(r.text).not.toContain(w);
    expect(r.text).toContain('24/7');
  });
  it('ohne <main>: ganzer Körper; ein Skript ohne Ende schneidet den Rest ab, statt zu hängen', () => {
    const r = htmlZuText('<body><p>Ein längerer Satz, der als Fließtext stehen bleiben soll.</p><script>var x = 1; <p>nie sichtbar</p>');
    expect(r.text).toContain('Ein längerer Satz');
    expect(r.text).not.toContain('nie sichtbar');
  });
  it('bösartige Eingaben brauchen unter 1 s (2 MB)', () => {
    const zwei = 2 * 1024 * 1024;
    const faelle = ['<script', '<', '<!--', '<a ', '&#x', 'x@y.', '<main><article>'].map((st) => st.repeat(Math.ceil(zwei / st.length)));
    // Review M1: `<` ohne Tag mit einem `>` ganz am Ende (76 s), dieselbe Folge in einer Hülle, die drei Durchläufe erzwingt (252 s)
    faelle.push(`${'<'.repeat(zwei)}>`, `<main><article>${'<'.repeat(zwei)}></article></main>`, `${'< '.repeat(zwei / 2)}>`,
      `${'a/b.c'.repeat(zwei / 5)}`, `${'</ '.repeat(zwei / 3)}>`);
    for (const stueck of faelle) {
      const t0 = Date.now();
      htmlZuText(stueck);
      const ms = Date.now() - t0;
      if (ms > 1000) throw new Fehlschlag(`${stueck.slice(0, 20)}…: ${ms} ms`);
    }
  });
  it('textSaeubern: Menüreste weg, Sätze bleiben; kuerzen an der Zeilengrenze', () => {
    expect(textSaeubern(['Kontakt', 'Mehr erfahren', 'Das ist ein Satz.', 'Vier Wörter ohne Punkt hier'])).toBe('Das ist ein Satz.\nVier Wörter ohne Punkt hier');
    expect(kuerzen('aaaa\nbbbb\ncccc', 11)).toBe('aaaa\nbbbb');
  });
});

// ═══ B. Einlesen über HTTP ════════════════════════════════════════════════════════════════════════════════════
const SEITE_GUT = `<html><head><title>Referenz</title></head><body><main>
  <p>Unsere Profile verschwinden in der Wand. Was bleibt, ist ruhiges, gleichmäßiges Licht.</p>
  <p>Du montierst sie in wenigen Minuten, ganz ohne Spezialwerkzeug. Das spart Zeit auf jeder Baustelle.</p>
  <p>Jedes Profil ist aus Aluminium gefertigt und hält ein ganzes Gebäudeleben lang. Besuche https://beispiel.at/shop.</p>
  </main></body></html>`;
let verbindungen = 0;
const endlos = { zu: false, bytes: 0 };
let referenzServer: Server;
let refPort = 0;
const antworten: Record<string, (res: http.ServerResponse) => void> = {
  '/gut': (res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(SEITE_GUT); },
  '/kurz': (res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>Zu kurz.</p>'); },
  '/pdf': (res) => { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end('%PDF-1.4'); },
  '/fehlt': (res) => { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('nicht da'); },
  '/gross': (res) => { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': String(3 * 1024 * 1024) }); res.end(); },
  '/strom': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const stueck = 'x'.repeat(64 * 1024);
    let n = 0;
    const weiter = () => { while (n < 40) { n++; if (!res.write(stueck)) { res.once('drain', weiter); return; } } res.end(); };
    weiter();
  },
  '/nach-innen': (res) => { res.writeHead(302, { Location: 'http://10.0.0.1/' }); res.end(); },
  '/nach-gut': (res) => { res.writeHead(301, { Location: '/gut' }); res.end(); },
  // Review M2: eine Weiterleitung, deren Körper nie endet
  '/weiter-endlos': (res) => {
    endlos.zu = false;
    endlos.bytes = 0;
    res.on('close', () => { endlos.zu = true; });
    res.writeHead(302, { Location: '/gut', 'Content-Type': 'text/html' });
    const stueck = 'x'.repeat(64 * 1024);
    const weiter = () => {
      while (!res.destroyed && !endlos.zu) {
        endlos.bytes += stueck.length;
        if (!res.write(stueck)) { res.once('drain', weiter); return; }
      }
    };
    weiter();
  },
  '/schleife': (res) => { res.writeHead(302, { Location: '/schleife' }); res.end(); },
  '/latin1': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
    res.end(Buffer.from(`<p>${'Größere Sätze mit Umlauten für die Prüfung der Zeichen. '.repeat(6)}</p>`, 'latin1'));
  },
};
const LOKAL_ERLAUBT: ReferenzOptionen = {
  adresseErlaubt: (ip) => ip === '127.0.0.1',
  portErlaubt: () => true,
  aufloesen: async (name) => (name === 'referenz.test' ? [{ address: '127.0.0.1', family: 4 }] : []),
};
const ref = (pfad: string) => `http://referenz.test:${refPort}${pfad}`;

describe('B Einlesen', () => {
  it('Server starten', async () => {
    referenzServer = http.createServer((req, res) => (antworten[req.url ?? ''] ?? antworten['/fehlt'])(res));
    referenzServer.on('connection', () => { verbindungen += 1; });
    referenzServer.listen(0, '127.0.0.1');
    await new Promise((r) => referenzServer.once('listening', r));
    refPort = (referenzServer.address() as AddressInfo).port;
  });
  it('Vorgabe: 127.0.0.1, localhost und ein Name, der auf 127.0.0.1 zeigt, verbinden nie (0 Verbindungen)', async () => {
    const vorher = verbindungen;
    const nurPort: ReferenzOptionen = { portErlaubt: () => true };
    expect(await fehlerCode(() => referenzHolen(`http://127.0.0.1:${refPort}/gut`, nurPort))).toBe('ZIEL_GESPERRT');
    expect(await fehlerCode(() => referenzHolen(`http://localhost:${refPort}/gut`, nurPort))).toBe('ZIEL_GESPERRT');
    // Der Name selbst ist unverdächtig; erst die Auflösung beim Verbinden zeigt das Hausnetz (DNS-Rebinding).
    const umgelenkt: ReferenzOptionen = { portErlaubt: () => true, aufloesen: LOKAL_ERLAUBT.aufloesen };
    expect(await fehlerCode(() => referenzHolen(ref('/gut'), umgelenkt))).toBe('ZIEL_GESPERRT');
    expect(await fehlerCode(() => referenzHolen(`http://127.0.0.1:${refPort}/gut`))).toBe('ZIEL_GESPERRT');
    expect(verbindungen).toBe(vorher);
  });
  it('Positivkontrolle: dieselbe Seite mit gelockerter Prüfung kommt an, als Text ohne Adressen', async () => {
    const s = await referenzHolen(ref('/gut'), LOKAL_ERLAUBT);
    expect(s.titel).toBe('Referenz');
    expect(s.text).toContain('Du montierst sie in wenigen Minuten');
    expect(s.text).not.toContain('https://');
    expect(s.gekuerzt).toBe(false);
  });
  it('Weiterleitung ins Hausnetz wird vor dem Verbinden gesperrt; eine erlaubte wird verfolgt; Schleife endet', async () => {
    expect(await fehlerCode(() => referenzHolen(ref('/nach-innen'), LOKAL_ERLAUBT))).toBe('ZIEL_GESPERRT');
    expect((await referenzHolen(ref('/nach-gut'), LOKAL_ERLAUBT)).url).toContain('/gut');
    expect(await fehlerCode(() => referenzHolen(ref('/schleife'), LOKAL_ERLAUBT))).toBe('ANTWORT');
  });
  it('Review M2: Der Körper einer Weiterleitung wird nicht gelesen, die Verbindung ist danach zu', async () => {
    const s = await referenzHolen(ref('/weiter-endlos'), LOKAL_ERLAUBT);
    expect(s.url).toContain('/gut');
    await new Promise((r) => setTimeout(r, 400));
    expect(endlos.zu).toBe(true);
    if (endlos.bytes > 8 * 1024 * 1024) throw new Fehlschlag(`${endlos.bytes} Bytes gesendet`);
  });
  it('zu groß (angekündigt und gestreamt), keine Webseite, HTTP-Fehler, zu wenig Text', async () => {
    expect(await fehlerCode(() => referenzHolen(ref('/gross'), LOKAL_ERLAUBT))).toBe('ZU_GROSS');
    expect(await fehlerCode(() => referenzHolen(ref('/strom'), LOKAL_ERLAUBT))).toBe('ZU_GROSS');
    expect(await fehlerCode(() => referenzHolen(ref('/pdf'), LOKAL_ERLAUBT))).toBe('ANTWORT');
    expect(await fehlerCode(() => referenzHolen(ref('/fehlt'), LOKAL_ERLAUBT))).toBe('ANTWORT');
    expect(await fehlerCode(() => referenzHolen(ref('/kurz'), LOKAL_ERLAUBT))).toBe('KEIN_TEXT');
  });
  it('Zeichensatz aus der Kopfzeile (ISO-8859-1)', async () => {
    expect((await referenzHolen(ref('/latin1'), LOKAL_ERLAUBT)).text).toContain('Größere Sätze');
  });
});

// ═══ C. Dienst mit Profil ═════════════════════════════════════════════════════════════════════════════════════
describe('C Dienst', () => {
  it('lokal: Beschreibung und Beispiele in der Anweisung, Text unverändert; Laufzeile mit Profil und Fassung', async () => {
    naechsteAntwort = (body) => body.messages[1].content;
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT, stilprofilId: 'sachlich' }, dienst);
    expect(letzte().body.messages[0].content).toContain('- aktiv statt passiv');
    expect(letzte().body.messages[0].content).toContain('Die Montage gelingt in wenigen Schritten.');
    expect(letzte().body.messages[1].content).toBe(TEXT);
    expect(r.stil).toEqual({ id: 'sachlich', name: 'SACHLICH', fassung: 3 });
    expect(r.channel).toBeNull();
    const z = laeufe[laeufe.length - 1]!;
    expect(z.stilprofilId).toBe('sachlich');
    expect(z.stilprofilFassung).toBe(3);
    expect(z.channelSchritt).toBeNull();
  });
  it('ohne Profil: keine Stilzeilen, stil null', async () => {
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT }, dienst);
    expect(letzte().body.messages[0].content).not.toContain('Schreibe in diesem Stil');
    expect(r.stil).toBeNull();
  });
  it('unbekannt, ausgeschaltet, falscher Channel, falsche Kennung: Fehler, 0 Aufrufe, keine Laufzeile', async () => {
    const a = aufrufe.length;
    const l = laeufe.length;
    const lauf = (stilprofilId: unknown, channelCode: unknown = null) =>
      fehlerCode(() => optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT, stilprofilId, channelCode }, dienst));
    expect(await lauf('gibts-nicht')).toBe('STIL_UNBEKANNT');
    expect(await lauf('aus')).toBe('STIL_INAKTIV');
    expect(await lauf('kanal')).toBe('STIL_CHANNEL');
    expect(await lauf('kanal', 'ANDERS')).toBe('STIL_CHANNEL');
    expect(await lauf('Groß')).toBe('EINGABE');
    expect(await lauf(['sachlich'])).toBe('EINGABE');
    expect(await fehlerCode(() => optimieren({ nutzerId: 'x', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT, stilprofilId: 'sachlich' },
      { ...dienst, stilLaden: undefined }))).toBe('STIL_UNBEKANNT');
    expect(aufrufe.length).toBe(a);
    expect(laeufe.length).toBe(l);
  });
  it('Cloud mit freiem Profil: gesendet wird der Vorschautext, die Anweisung trägt das Profil', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: `Herr Karl Moser fragt: ${TEXT}` }, quelle);
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'verkaufsfoerdernd', wegId: 'cloud', vorschauId: v.vorschauId, stilprofilId: 'sachlich' }, dienst);
    expect(letzte().modell).toBe('cloud-test');
    expect(letzte().body.messages[1].content).toBe(v.ausgehend);
    expect(letzte().body.messages[0].content).toContain('- aktiv statt passiv');
    expect(JSON.stringify(letzte().body)).not.toContain('Moser');
    expect(r.text).toContain('Moser');
  });
  it('Cloud mit Profil, das Name, Telefon, Schutzliste oder Artikelnummer trägt: STIL_MIT_WERTEN, 0 Aufrufe', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: TEXT }, quelle);
    const a = aufrufe.length;
    for (const id of ['mit-name', 'mit-telefon', 'mit-liste', 'mit-nummer']) {
      const c = await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'verkaufsfoerdernd', wegId: 'cloud', vorschauId: v.vorschauId, stilprofilId: id }, dienst));
      if (c !== 'STIL_MIT_WERTEN') throw new Fehlschlag(`${id}: ${c}`);
    }
    expect(aufrufe.length).toBe(a);
  });
  it('Review M4: Cloud nur in der freigegebenen Fassung (alte Freigabe, nie freigegeben): STIL_NICHT_FREIGEGEBEN, 0 Aufrufe; lokal geht es', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: TEXT }, quelle);
    const a = aufrufe.length;
    for (const id of ['nicht-frei', 'nie-frei']) {
      const c = await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'verkaufsfoerdernd', wegId: 'cloud', vorschauId: v.vorschauId, stilprofilId: id }, dienst));
      if (c !== 'STIL_NICHT_FREIGEGEBEN') throw new Fehlschlag(`${id}: ${c}`);
    }
    expect(aufrufe.length).toBe(a);
    await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT, stilprofilId: 'nie-frei' }, dienst);
    expect(aufrufe.length).toBe(a + 1);
  });
  it('Positivkontrolle: dasselbe Profil mit Namen geht lokal (Klartext bleibt im Haus)', async () => {
    const a = aufrufe.length;
    await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT, stilprofilId: 'mit-name' }, dienst);
    expect(aufrufe.length).toBe(a + 1);
  });
  it('Cloud: Ein Profil, das ein in der Vorschau verdecktes Wort enthält (auch als Wortteil), geht nicht hinaus', async () => {
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: `Die Lichtleiste passt. ${TEXT}`, verdecken: ['Lichtleiste'] }, quelle);
    const a = aufrufe.length;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-frei', artId: 'verkaufsfoerdernd', wegId: 'cloud', vorschauId: v.vorschauId, stilprofilId: 'verraet' }, dienst)))
      .toBe('WERT_IN_ANWEISUNG');
    expect(aufrufe.length).toBe(a);
  });
  it('Channel lokal: Das Ergebnis behält einen vermiedenen Begriff, die Station schreibt ihn um, der Endstand ist geprüft', async () => {
    naechsteAntwort = (body) => (body.messages[0].content === CHANNEL_SYSTEM
      ? 'Der LED-Trafo liefert 24 V und 60 W. Er passt in jede Unterkonstruktion.'
      : body.messages[1].content);
    // Das Profil gehört zum Channel KANAL; so läuft die Channel-Fassung danach.
    const a = aufrufe.length;
    const v = verbrauch.length;
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT_TREIBER, stilprofilId: 'kanal', channelCode: 'KANAL' }, dienst);
    expect(aufrufe.length).toBe(a + 2);
    expect(letzte().body.messages[0].content).toBe(CHANNEL_SYSTEM);
    expect(letzte().modell).toBe('station-test');
    expect(r.text).toContain('LED-Trafo');
    expect(r.text).not.toContain('LED-Treiber');
    expect(r.channel?.herkunft).toBe('sprachmodell');
    expect(r.befund.ergebnis).toBe('ok');
    expect(r.ki.eingabeToken).toBe(24);
    expect(verbrauch.length).toBe(v + 2);
    const z = laeufe[laeufe.length - 1]!;
    expect(z.channelSchritt).toBe('sprachmodell');
    expect(z.channelCode).toBe('KANAL');
    expect(z.eingabeToken).toBe(24);
  });
  it('Channel lokal, Station weg für die Umschreibung: nach Regel ersetzt, Hinweis CHANNEL_REGEL, kein anderer Weg', async () => {
    naechsteAntwort = (body) => body.messages[1].content;
    channelKaputt = true;
    try {
      const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT_TREIBER, channelCode: 'KANAL', stilprofilId: 'sachlich' }, dienst);
      expect(r.channel?.herkunft).toBe('regel');
      expect(r.text).toContain('LED-Trafo');
      expect(r.befund.ergebnis).toBe('hinweis');
      expect(r.befund.gruende.includes('CHANNEL_REGEL')).toBe(true);
      expect(aufrufe.some((x) => x.modell === 'cloud-test' && x.body.messages[0].content === CHANNEL_SYSTEM)).toBe(false);
    } finally {
      channelKaputt = false;
    }
  });
  it('Channel Cloud: kein zweiter Aufruf, nach Regel ersetzt und gekennzeichnet', async () => {
    naechsteAntwort = (body) => body.messages[1].content;
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: TEXT_TREIBER }, quelle);
    const a = aufrufe.length;
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'verkaufsfoerdernd', wegId: 'cloud', vorschauId: v.vorschauId, channelCode: 'KANAL', stilprofilId: 'sachlich' }, dienst);
    expect(aufrufe.length).toBe(a + 1);
    expect(r.channel?.herkunft).toBe('regel');
    expect(r.text).toContain('LED-Trafo');
    expect(r.befund.gruende.includes('CHANNEL_REGEL')).toBe(true);
    expect(laeufe[laeufe.length - 1]!.channelSchritt).toBe('regel');
  });
  it('Channel ohne Treffer: unverändert, kein zusätzlicher Aufruf', async () => {
    const a = aufrufe.length;
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT, channelCode: 'KANAL', stilprofilId: 'sachlich' }, dienst);
    expect(aufrufe.length).toBe(a + 1);
    expect(r.channel?.herkunft).toBe('unverändert');
  });
  it('Review N8: ohne Stilprofil kein Channel-Schritt, auch mit Channel und Treffer (Verhalten wie Phase 4)', async () => {
    naechsteAntwort = (body) => body.messages[1].content;
    const a = aufrufe.length;
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT_TREIBER, channelCode: 'KANAL' }, dienst);
    expect(aufrufe.length).toBe(a + 1);
    expect(r.channel).toBeNull();
    expect(r.text).toContain('LED-Treiber');
    expect(laeufe[laeufe.length - 1]!.channelSchritt).toBeNull();
  });
  it('Review M3: Cloud – ein geschützter Wert (Schutzliste „Lichtband Profi“) bleibt, nur das freie „Lichtband“ wird ersetzt', async () => {
    naechsteAntwort = (body) => body.messages[1].content;
    const t = 'Für die Lichtband Profi liefern wir ein Lichtband mit 24 V. Es passt in jede Unterkonstruktion.';
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: t }, quelle);
    expect(v.ausgehend).not.toContain('Lichtband Profi');
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'verkaufsfoerdernd', wegId: 'cloud', vorschauId: v.vorschauId, channelCode: 'KANAL', stilprofilId: 'sachlich' }, dienst);
    expect(r.text).toContain('Lichtband Profi');
    expect(r.text).toContain('ein LED-Streifen');
    expect(r.text).not.toContain('LED-Streifen Profi');
    expect(r.channel?.herkunft).toBe('regel');
  });
  it('Review M3: lokal – die Station bekommt die Sperrmarke statt des Wertes, der Wert steht danach wieder da', async () => {
    const t = 'Für die Lichtband Profi liefern wir ein Lichtband mit 24 V. Es passt in jede Unterkonstruktion.';
    naechsteAntwort = (body) => {
      if (body.messages[0].content !== CHANNEL_SYSTEM) return body.messages[1].content;
      const m = /<<<\n([\s\S]*)\n>>>/.exec(body.messages[1].content);
      return (m ? m[1] : '').replace('ein Lichtband', 'einen LED-Streifen');
    };
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: t, channelCode: 'KANAL', stilprofilId: 'sachlich' }, dienst);
    expect(letzte().body.messages[0].content).toBe(CHANNEL_SYSTEM);
    expect(letzte().body.messages[1].content).toContain('__TWSCHUTZ0__');
    expect(letzte().body.messages[1].content).not.toContain('Lichtband Profi');
    expect(r.text).toBe('Für die Lichtband Profi liefern wir einen LED-Streifen mit 24 V. Es passt in jede Unterkonstruktion.');
    expect(r.channel?.herkunft).toBe('sprachmodell');
    // „Lichtband“ steckt im Firmennamen und bleibt dort: ein Hinweis, kein Verstoß.
    expect(JSON.stringify(r.befund.gruende)).toBe('["HAUSBEGRIFF_OFFEN"]');
  });
  it('Nachprüfung M3-Rest: Cloud – eine Firma, die die Vorschau durchlässt (Klasse aus), wird trotzdem nicht umgeschrieben', async () => {
    naechsteAntwort = (body) => body.messages[1].content;
    const t = 'Die Lichtband Werke GmbH bestellt ein Lichtband mit 24 V. Es passt in jede Unterkonstruktion.';
    const ohneFirma = { laden: async () => ({ ...schutz, aus: ['FIRMA'] as any }) };
    const v = await vorschauErstellen({ nutzerId: 'nutzer-frei', text: t }, ohneFirma);
    expect(v.ausgehend).toContain('Lichtband Werke GmbH');
    const r = await optimieren({ nutzerId: 'nutzer-frei', artId: 'verkaufsfoerdernd', wegId: 'cloud', vorschauId: v.vorschauId, channelCode: 'KANAL', stilprofilId: 'sachlich' }, dienst);
    expect(r.text).toContain('Die Lichtband Werke GmbH');
    expect(r.text).toContain('ein LED-Streifen');
    expect(r.text).not.toContain('LED-Streifen Werke');
  });
  it('Nachprüfung: Sperre in einem Durchgang – Werte, die in der Marke stecken („TWS“, „10“, „__“), treffen sie nicht', () => {
    const t = 'TWS liefert 10 Stück an Karl Moser und Moser, Kennung __ und 2__ und __TW.';
    const w = werteSperren(t, ['TWS', '10', 'Karl Moser', 'Moser', '__', 'S', 'CHUTZ'])!;
    expect(w.zurueck(w.text)).toBe(t);
    expect(w.text.includes('Moser')).toBe(false);
    for (let i = 0; i < 200; i++) {
      const werte = Array.from({ length: 6 }, () => ['TWS', 'SCH', '1', '10', '_', 'UTZ', 'Moser', 'a b', 'T'][Math.floor(Math.random() * 9)]);
      const x = `${werte.join(' ')} __TW ${werte.reverse().join('-')}`;
      const y = werteSperren(x, werte);
      if (y && y.zurueck(y.text) !== x) throw new Fehlschlag(`Rundlauf falsch: ${JSON.stringify(werte)}`);
    }
  });
  it('Nachprüfung: Ist das Profil seit dem Laden der Seite geändert (andere Fassung), geht nichts hinaus', async () => {
    const a = aufrufe.length;
    expect(await fehlerCode(() => optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT, stilprofilId: 'sachlich', stilprofilFassung: 2 }, dienst)))
      .toBe('STIL_VERALTET');
    expect(aufrufe.length).toBe(a);
    await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT, stilprofilId: 'sachlich', stilprofilFassung: 3 }, dienst);
    expect(aufrufe.length).toBe(a + 1);
  });
  it('werteSperren: längere Werte zuerst, zurück ohne Rest; ein Text mit der Marke wird nicht angefasst', () => {
    const w = werteSperren('Karl Moser und Moser kommen.', ['Moser', 'Karl Moser'])!;
    expect(w.text).toBe('__TWSCHUTZ0__ und __TWSCHUTZ1__ kommen.');
    expect(w.zurueck(w.text)).toBe('Karl Moser und Moser kommen.');
    expect(werteSperren('steht schon __TWSCHUTZ0__ da', ['x'])).toBeNull();
  });
  it('verworfenes Ergebnis: kein Channel-Schritt (nichts zu übernehmen)', async () => {
    naechsteAntwort = (body) => body.messages[1].content.replace('24 V', '12 V');
    const a = aufrufe.length;
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT_TREIBER, channelCode: 'KANAL', stilprofilId: 'sachlich' }, dienst);
    expect(r.befund.ergebnis).toBe('verworfen');
    expect(r.channel).toBeNull();
    expect(aufrufe.length).toBe(a + 1);
  });
  it('die Channel-Umschreibung ändert eine Zahl: Der Endstand wird verworfen, nicht der Zwischenstand gezeigt', async () => {
    naechsteAntwort = (body) => (body.messages[0].content === CHANNEL_SYSTEM
      ? 'Der LED-Trafo liefert 12 V und 60 W. Er passt in jede Unterkonstruktion.'
      : body.messages[1].content);
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT_TREIBER, channelCode: 'KANAL', stilprofilId: 'sachlich' }, dienst);
    // checkRewrite der Channel-Fassung lässt die Zahl nicht durch (geändert außerhalb des Fensters): Ersatz nach Regel.
    expect(r.text).not.toContain('12 V');
    expect(r.text).toContain('24 V');
  });
  it('die Umschreibung ändert eine Zahl IM Fenster (checkRewrite lässt sie durch): Die Prüfung des Endstands verwirft sie, es gilt der Ersatz nach Regel (Review N7)', async () => {
    const t = 'Der LED-Treiber 24 V liefert 60 W. Er passt in jede Unterkonstruktion.';
    naechsteAntwort = (body) => (body.messages[0].content === CHANNEL_SYSTEM
      ? 'Der LED-Trafo 12 V liefert 60 W. Er passt in jede Unterkonstruktion.'
      : body.messages[1].content);
    const r = await optimieren({ nutzerId: 'nutzer-gesperrt', artId: 'verkaufsfoerdernd', wegId: 'lokal', text: t, channelCode: 'KANAL', stilprofilId: 'sachlich' }, dienst);
    expect(r.channel?.herkunft).toBe('regel');
    expect(r.text).toBe('Der LED-Trafo 24 V liefert 60 W. Er passt in jede Unterkonstruktion.');
    expect(r.befund.ergebnis).toBe('hinweis');
    expect(r.befund.gruende.includes('CHANNEL_REGEL')).toBe(true);
    expect(r.befund.gruende.includes('ZAHL_GEAENDERT')).toBe(false);
    expect(laeufe[laeufe.length - 1]!.channelSchritt).toBe('regel');
  });
});

// ═══ D. Routen ════════════════════════════════════════════════════════════════════════════════════════════════
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
const stilSpeicherDaten: StilProfil[] = PROFILE.map((p) => ({ ...p }));
const stilVerlauf: (StilVerlaufZeile & { id: string })[] = [];
const stilSpeicher: StilSpeicher = {
  profileLesen: async () => stilSpeicherDaten.map((p) => ({ ...p })),
  profilLaden: async (id) => { const p = stilSpeicherDaten.find((x) => x.id === id); return p ? { ...p } : null; },
  profilAnlegen: async (p, von) => {
    if (p.channel_code === 'GIBTSNICHT') throw Object.assign(new Error('fk'), { code: '23503' });
    stilSpeicherDaten.push({ ...p, fassung: 1 });
    stilVerlauf.push({ id: p.id, fassung: 1, aktion: 'angelegt', felder: { ...p }, von, am: new Date().toISOString() });
  },
  profilAendern: async (id, f, von, erwartet) => {
    const p = stilSpeicherDaten.find((x) => x.id === id);
    if (!p) return null;
    if (erwartet !== undefined && erwartet !== p.fassung) return 'veraltet';
    if (!stilGeaendert(p, f)) return { ...p };
    const fassung = p.fassung + (neueFassung(p, f) ? 1 : 0);
    Object.assign(p, f, { fassung });
    stilVerlauf.push({ id, fassung, aktion: 'geaendert', felder: { ...p }, von, am: new Date().toISOString() });
    return { ...p };
  },
  cloudFreigabeSetzen: async (id, fassung, von) => {
    const p = stilSpeicherDaten.find((x) => x.id === id);
    if (!p) return null;
    if (fassung !== null && fassung !== p.fassung) return 'veraltet';
    p.cloud_freigabe_fassung = fassung;
    stilVerlauf.push({ id, fassung: p.fassung, aktion: (fassung === null ? 'cloud_entzogen' : 'cloud_freigegeben') as any, felder: {}, von, am: new Date().toISOString() });
    return { ...p };
  },
  verlaufLesen: async (id) => stilVerlauf.filter((v) => v.id === id).reverse(),
};
const optimierSpeicher: OptimierSpeicher = {
  artenLesen: async () => ARTEN, artLaden: async (id) => ARTEN.find((a) => a.id === id) ?? null, artAnlegen: async () => {},
  artAendern: async () => true, laufMerken: async (z) => { laeufe.push(z); }, begriffeLaden: async () => HAUS,
};
const schutzSpeicher = { laden: async () => schutz } as unknown as SchutzSpeicher;
const wegSpeicher = { anlegen: async () => {}, aendern: async () => true, verbrauchMerken: async (modell: string) => { verbrauch.push({ modell }); } };

describe('D Routen', () => {
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
      deps: ki, speicher: wegSpeicher, optimier: optimierSpeicher, schutz: schutzSpeicher, stil: stilSpeicher, referenz: LOKAL_ERLAUBT,
      requireAuth: fakeAuth(false), requireAdmin: fakeAuth(true),
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    basis = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/textwerkstatt`;
  });
  it('GET /stilprofile: nur eingeschaltete, mit Beschreibung und Befund „cloud“; ohne Anmeldung 401', async () => {
    const r = await rufe('GET', '/stilprofile', 'nutzer-frei');
    expect(r.status).toBe(200);
    expect(r.body.some((p: any) => p.id === 'aus')).toBe(false);
    expect(r.body.find((p: any) => p.id === 'sachlich').cloud).toBe(true);
    expect(r.body.find((p: any) => p.id === 'mit-name').cloud).toBe(false);
    expect(r.body.find((p: any) => p.id === 'kanal').channelCode).toBe('KANAL');
    expect((await rufe('GET', '/stilprofile', '')).status).toBe(401);
  });
  it('GET /stilprofile/alle nur Admin, mit Befund je Klasse', async () => {
    expect((await rufe('GET', '/stilprofile/alle', 'nutzer-frei')).status).toBe(403);
    const r = await rufe('GET', '/stilprofile/alle', 'admin-1');
    expect(r.body.find((p: any) => p.id === 'mit-name').cloud.klassen.PERSON).toBe(1);
    expect(r.body.some((p: any) => p.id === 'aus')).toBe(true);
  });
  it('POST /stilprofile: prüft, legt an mit Fassung 1, doppelt 409, unbekannter Channel 400, Nutzer 403', async () => {
    const neu = { id: 'shopa', name: 'SHOPA', channel_code: 'KANAL' };
    expect((await rufe('POST', '/stilprofile', 'nutzer-frei', neu)).status).toBe(403);
    expect((await rufe('POST', '/stilprofile', 'admin-1', { ...neu, id: 'Groß' })).status).toBe(400);
    expect((await rufe('POST', '/stilprofile', 'admin-1', { ...neu, aktiv: true })).status).toBe(400);
    expect((await rufe('POST', '/stilprofile', 'admin-1', { ...neu, beschreibung: 'mit [PERSON_1]' })).status).toBe(400);
    expect((await rufe('POST', '/stilprofile', 'admin-1', { ...neu, quelle_art: 'url' })).status).toBe(400);
    expect((await rufe('POST', '/stilprofile', 'admin-1', { ...neu, id: 'fk', channel_code: 'GIBTSNICHT' })).status).toBe(400);
    const r = await rufe('POST', '/stilprofile', 'admin-1', neu);
    expect(r.status).toBe(201);
    expect(r.body.fassung).toBe(1);
    expect(r.body.aktiv).toBe(false);
    expect((await rufe('POST', '/stilprofile', 'admin-1', neu)).status).toBe(409);
  });
  it('PUT /stilprofile/:id: Inhalt ⇒ neue Fassung, Name ⇒ nicht; einschalten erst mit Beschreibung; Verlauf zeigt beides', async () => {
    expect((await rufe('PUT', '/stilprofile/shopa', 'admin-1', { aktiv: true })).status).toBe(400);
    expect((await rufe('PUT', '/stilprofile/shopa', 'admin-1', {})).status).toBe(400);
    expect((await rufe('PUT', '/stilprofile/gibts-nicht', 'admin-1', { name: 'x' })).status).toBe(404);
    expect((await rufe('PUT', '/stilprofile/..%2F', 'admin-1', { name: 'x' })).status).toBe(404);
    const a = await rufe('PUT', '/stilprofile/shopa', 'admin-1', {
      beschreibung: '- duzt den Leser\n- kurze Sätze, viele Verben', beispiele: 'Du montierst es in Minuten.', aktiv: true,
      quelle_art: 'url', quelle_url: 'https://beispiel.at/ueber-uns', quelle_zeichen: 4120,
    });
    expect(a.status).toBe(200);
    expect(a.body.fassung).toBe(2);
    const b = await rufe('PUT', '/stilprofile/shopa', 'admin-1', { name: 'SHOPA Web' });
    expect(b.body.fassung).toBe(2);
    const c = await rufe('PUT', '/stilprofile/shopa', 'admin-1', { beispiele: 'Du montierst es in Minuten.\nDas hält.' });
    expect(c.body.fassung).toBe(3);
    const v = await rufe('GET', '/stilprofile/shopa/verlauf', 'admin-1');
    expect(v.body.map((z: any) => z.fassung)).toEqual([3, 2, 2, 1]);
    expect((await rufe('GET', '/stilprofile/shopa/verlauf', 'nutzer-frei')).status).toBe(403);
  });
  it('PUT: auf einer alten Fassung 409 STIL_VERALTET; ohne Änderung keine neue Verlaufszeile (Review N4)', async () => {
    const vorher = (await rufe('GET', '/stilprofile/shopa/verlauf', 'admin-1')).body.length;
    const alt = await rufe('PUT', '/stilprofile/shopa', 'admin-1', { beschreibung: 'Fremde Änderung auf einem alten Stand', fassung: 2 });
    expect(alt.status).toBe(409);
    expect(alt.body.code).toBe('STIL_VERALTET');
    const gleich = await rufe('PUT', '/stilprofile/shopa', 'admin-1', { name: 'SHOPA Web', fassung: 3 });
    expect(gleich.status).toBe(200);
    expect(gleich.body.fassung).toBe(3);
    expect((await rufe('GET', '/stilprofile/shopa/verlauf', 'admin-1')).body.length).toBe(vorher);
  });
  it('POST /stilprofile/:id/cloud: nur Admin, nur die aktuelle Fassung, nicht mit erkannten Angaben; eine neue Fassung hebt die Freigabe auf (Review M4)', async () => {
    expect((await rufe('POST', '/stilprofile/shopa/cloud', 'nutzer-frei', { freigeben: true, fassung: 3 })).status).toBe(403);
    expect((await rufe('POST', '/stilprofile/shopa/cloud', 'admin-1', { freigeben: true, fassung: 2 })).body.code).toBe('STIL_VERALTET');
    expect((await rufe('POST', '/stilprofile/shopa/cloud', 'admin-1', { freigeben: 'ja', fassung: 3 })).status).toBe(400);
    expect((await rufe('POST', '/stilprofile/mit-name/cloud', 'admin-1', { freigeben: true, fassung: 3 })).body.code).toBe('STIL_MIT_WERTEN');
    expect((await rufe('GET', '/stilprofile', 'nutzer-frei')).body.find((p: any) => p.id === 'shopa').cloud).toBe(false);
    const f = await rufe('POST', '/stilprofile/shopa/cloud', 'admin-1', { freigeben: true, fassung: 3 });
    expect(f.status).toBe(200);
    expect(f.body.cloudFreigegeben).toBe(true);
    expect((await rufe('GET', '/stilprofile', 'nutzer-frei')).body.find((p: any) => p.id === 'shopa').cloud).toBe(true);
    await rufe('PUT', '/stilprofile/shopa', 'admin-1', { beispiele: 'Du montierst es in Minuten.\nDas hält.\nUnd es bleibt.', fassung: 3 });
    expect((await rufe('GET', '/stilprofile', 'nutzer-frei')).body.find((p: any) => p.id === 'shopa').cloud).toBe(false);
    expect((await rufe('GET', '/stilprofile/alle', 'admin-1')).body.find((p: any) => p.id === 'shopa').cloudFreigegeben).toBe(false);
    const v = await rufe('GET', '/stilprofile/shopa/verlauf', 'admin-1');
    expect(v.body.some((z: any) => z.aktion === 'cloud_freigegeben')).toBe(true);
    const e = await rufe('POST', '/stilprofile/shopa/cloud', 'admin-1', { freigeben: false });
    expect(e.body.cloudFreigegeben).toBe(false);
  });
  it('POST /stilprofile/quelle: Admin holt über den Server, Nutzer 403, gesperrte Adresse 400 ohne Verbindung', async () => {
    expect((await rufe('POST', '/stilprofile/quelle', 'nutzer-frei', { url: ref('/gut') })).status).toBe(403);
    const vorher = verbindungen;
    const g = await rufe('POST', '/stilprofile/quelle', 'admin-1', { url: 'http://10.0.0.1/' });
    expect(g.status).toBe(400);
    expect(g.body.code).toBe('ZIEL_GESPERRT');
    expect(verbindungen).toBe(vorher);
    const r = await rufe('POST', '/stilprofile/quelle', 'admin-1', { url: ref('/gut') });
    expect(r.status).toBe(200);
    expect(r.body.text).toContain('Du montierst sie');
  });
  it('POST /stilprofile/ableiten lokal: fester Rahmen als Anweisung, Referenztext als Nachricht, Antwort gelesen', async () => {
    naechsteAntwort = () => 'STIL:\n- duzt den Leser\n- kurze Sätze\nBEISPIELE:\n- Du sparst Zeit.';
    const referenzText = SEITE_GUT.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const r = await rufe('POST', '/stilprofile/ableiten', 'admin-1', { wegId: 'lokal', text: referenzText });
    expect(r.status).toBe(200);
    expect(letzte().body.messages[0].content).toBe(ABLEIT_SYSTEM);
    expect(letzte().body.messages[1].content).toBe(referenzText);
    expect(letzte().modell).toBe('station-test');
    expect(r.body.beschreibung).toBe('- duzt den Leser\n- kurze Sätze');
    expect(r.body.beispiele).toBe('Du sparst Zeit.');
    expect(r.body.cloud.ok).toBe(true);
    expect((await rufe('POST', '/stilprofile/ableiten', 'admin-1', { wegId: 'lokal', text: 'zu kurz' })).body.code).toBe('TEXT_FEHLT');
    expect((await rufe('POST', '/stilprofile/ableiten', 'nutzer-frei', { wegId: 'lokal', text: referenzText })).status).toBe(403);
  });
  it('POST /stilprofile/ableiten Cloud: ohne Vorschau 400 und 0 Aufrufe; mit Vorschau geht nur der Pseudonym-Text hinaus', async () => {
    const a = aufrufe.length;
    const ohne = await rufe('POST', '/stilprofile/ableiten', 'admin-frei', { wegId: 'cloud', text: 'Herr Karl Moser schreibt ...'.repeat(10) });
    expect(ohne.status).toBe(400);
    expect(ohne.body.code).toBe('VORSCHAU_FEHLT');
    expect(aufrufe.length).toBe(a);
    const referenz = `Herr Karl Moser schreibt uns: ${SEITE_GUT.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`;
    const v = await rufe('POST', '/vorschau', 'admin-frei', { text: referenz });
    expect(v.status).toBe(200);
    naechsteAntwort = () => 'STIL:\n- knapp, sachlich\nBEISPIELE:\n- Das hält.';
    const r = await rufe('POST', '/stilprofile/ableiten', 'admin-frei', { wegId: 'cloud', vorschauId: v.body.vorschauId, text: 'GEHEIM' });
    expect(r.status).toBe(200);
    expect(aufrufe.length).toBe(a + 1);
    expect(letzte().modell).toBe('cloud-test');
    expect(letzte().body.messages[1].content).toBe(v.body.ausgehend);
    expect(JSON.stringify(letzte().body)).not.toContain('Moser');
    expect(JSON.stringify(letzte().body)).not.toContain('GEHEIM');
    // Ein Admin ohne Freischaltung bekommt die Cloud nicht, auch hier nicht — mit seiner EIGENEN Vorschau (Review N5).
    const eigene = await rufe('POST', '/vorschau', 'admin-gesperrt', { text: referenz });
    expect(eigene.status).toBe(200);
    const g = await rufe('POST', '/stilprofile/ableiten', 'admin-gesperrt', { wegId: 'cloud', vorschauId: eigene.body.vorschauId });
    expect(g.status).toBe(403);
    expect(g.body.code).toBe('NICHT_FREIGESCHALTET');
    expect(aufrufe.length).toBe(a + 1);
  });
  it('POST /optimieren mit Feld „stilprofil“: Profil in der Anweisung; falscher Channel 409 ohne Aufruf', async () => {
    naechsteAntwort = (body) => body.messages[1].content;
    const r = await rufe('POST', '/optimieren', 'nutzer-gesperrt', { art: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT, stilprofil: 'shopa', channelCode: 'KANAL' });
    expect(r.status).toBe(200);
    expect(r.body.stil.fassung).toBe(4);
    expect(letzte().body.messages[0].content).toContain('- duzt den Leser');
    const a = aufrufe.length;
    const f = await rufe('POST', '/optimieren', 'nutzer-gesperrt', { art: 'verkaufsfoerdernd', wegId: 'lokal', text: TEXT, stilprofil: 'shopa' });
    expect(f.status).toBe(409);
    expect(f.body.code).toBe('STIL_CHANNEL');
    expect(aufrufe.length).toBe(a);
  });
  it('Server stoppen', async () => {
    // Offene Verbindungen zuerst schließen: Bleibt eine hängen (etwa eine Weiterleitung, deren Körper weiterläuft), wartete
    // `close` sonst ewig, und das Skript endete nie (Gegenprobe zu Review M2, 11.11.2026).
    server.closeAllConnections();
    referenzServer.closeAllConnections();
    await new Promise((r) => server.close(r));
    await new Promise((r) => referenzServer.close(r));
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
