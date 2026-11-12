/**
 * Referenzseite für ein Stilprofil holen und ihren Text herausziehen (Textwerkstatt Phase 5, Plan `PLAN-textwerkstatt.md`
 * §4 Phase 5, Cockpit #1841).
 *
 * Die Seite holt der **Server**, nie ein Arbeitsrechner: Der Server steht dort, wo auch die App läuft, und der Browser bekommt
 * nur Text zurück, ohne Adressen und ohne Mailadressen.
 *
 * Ein Server, der auf Zuruf eine Adresse abruft, ist ein Weg ins eigene Netz (SSRF). Deshalb, auch wenn nur Admins ihn rufen:
 *  - nur `http`/`https`, nur die Ports 80 und 443, keine Zugangsdaten in der Adresse;
 *  - jede Adresse, zu der der Name aufgelöst wird, muss öffentlich sein (kein 127.0.0.1, kein 10.x, kein 172.16–31.x, kein
 *    192.168.x, kein 169.254.x, kein IPv6-Lokalnetz). Geprüft wird beim Verbinden (`lookup`), nicht vorher: Sonst könnte der
 *    Name zwischen Prüfung und Verbindung auf eine andere Adresse zeigen (DNS-Rebinding);
 *  - höchstens 3 Weiterleitungen, jede neu geprüft; höchstens 2 MB, höchstens 15 s; nur HTML oder Text.
 *
 * Das Herausziehen ist ein linearer Durchlauf ohne Rückverfolgung, damit eine bösartige Seite keine Minuten kostet
 * (`htmlZuText`): Jede Suche beginnt hinter der vorigen und rückt mindestens bis zu ihrem Fund vor. Es ist keine Schranke:
 * Der Text wird angezeigt (React maskiert ihn) und geht danach an die KI.
 */
import http from 'http';
import https from 'https';
import dns from 'dns';
import net from 'net';
import type { LookupFunction } from 'net';
import { STIL_GRENZEN } from './stilprofile';

export type ReferenzFehlerCode = 'URL_UNGUELTIG' | 'ZIEL_GESPERRT' | 'NICHT_ERREICHBAR' | 'ANTWORT' | 'ZU_GROSS' | 'KEIN_TEXT';

const HTTP_JE_CODE: Record<ReferenzFehlerCode, number> = {
  URL_UNGUELTIG: 400,
  ZIEL_GESPERRT: 400,
  NICHT_ERREICHBAR: 502,
  ANTWORT: 502,
  ZU_GROSS: 502,
  KEIN_TEXT: 422,
};

export class ReferenzFehler extends Error {
  readonly http: number;
  constructor(readonly code: ReferenzFehlerCode, message: string) {
    super(message);
    this.name = 'ReferenzFehler';
    this.http = HTTP_JE_CODE[code];
  }
}

export const REFERENZ_GRENZEN = { bytes: 2 * 1024 * 1024, zeitMs: 15_000, weiterleitungen: 3, url: STIL_GRENZEN.url } as const;

// ── Adressen ──────────────────────────────────────────────────────────────────────────────────────────────────────

function v4Zahl(ip: string): number | null {
  const t = ip.split('.');
  if (t.length !== 4) return null;
  let n = 0;
  for (const s of t) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const x = Number(s);
    if (x > 255) return null;
    n = n * 256 + x;
  }
  return n;
}

const V4_GESPERRT: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4Gesperrt(ip: string): boolean {
  const n = v4Zahl(ip);
  if (n === null) return true;
  return V4_GESPERRT.some(([netz, bits]) => {
    const maske = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & maske) >>> 0) === ((v4Zahl(netz)! & maske) >>> 0);
  });
}

/** IPv6 in acht Gruppen zu je 16 Bit; `null`, wenn es keine gültige Schreibung ist. */
function v6Gruppen(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Eingebettete IPv4 am Ende (::ffff:10.0.0.1)
  let schwanz: number[] = [];
  const letzter = s.lastIndexOf(':');
  if (s.includes('.')) {
    const n = v4Zahl(s.slice(letzter + 1));
    if (n === null) return null;
    schwanz = [(n >>> 16) & 0xffff, n & 0xffff];
    s = `${s.slice(0, letzter + 1)}0:0`;
  }
  const doppelt = s.split('::');
  if (doppelt.length > 2) return null;
  const teil = (x: string) => (x === '' ? [] : x.split(':'));
  const vorn = teil(doppelt[0]);
  const hinten = doppelt.length === 2 ? teil(doppelt[1]) : [];
  const fehlen = 8 - vorn.length - hinten.length;
  if (doppelt.length === 1 && fehlen !== 0) return null;
  if (doppelt.length === 2 && fehlen < 1) return null;
  const gruppen = [...vorn, ...Array(doppelt.length === 2 ? fehlen : 0).fill('0'), ...hinten];
  if (gruppen.length !== 8 || gruppen.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const zahlen = gruppen.map((g) => parseInt(g, 16));
  if (schwanz.length) { zahlen[6] = schwanz[0]; zahlen[7] = schwanz[1]; }
  return zahlen;
}

function v6Gesperrt(ip: string): boolean {
  const g = v6Gruppen(ip);
  if (!g) return true;
  const alleNull = (von: number, bis: number) => g.slice(von, bis).every((x) => x === 0);
  if (alleNull(0, 8)) return true; // ::
  if (alleNull(0, 7) && g[7] === 1) return true; // ::1
  // IPv4 darin: ::ffff:a.b.c.d (abgebildet), ::a.b.c.d (alt), 64:ff9b::a.b.c.d (NAT64) — nach der IPv4-Regel
  const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (alleNull(0, 5) && (g[5] === 0xffff || g[5] === 0)) return v4Gesperrt(v4);
  if (alleNull(0, 4) && g[4] === 0xffff && g[5] === 0) return v4Gesperrt(v4); // ::ffff:0:a.b.c.d (übersetzt)
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 NAT64 für das eigene Netz
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo 2001::/32
  if (g[0] === 0x64 && g[1] === 0xff9b && alleNull(2, 6)) return v4Gesperrt(v4);
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 eigenes Netz
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 Verbindung
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 alt
  if ((g[0] & 0xff00) === 0xff00) return true; // Multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // Dokumentation
  if (g[0] === 0x0100 && alleNull(1, 4)) return true; // 100::/64 Verwurf
  if (g[0] === 0x2002) return v4Gesperrt(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4
  return false;
}

/** Ist diese Adresse nicht öffentlich? Was sich nicht lesen lässt, gilt als gesperrt. */
export function adresseGesperrt(ip: string): boolean {
  const art = net.isIP(ip);
  if (art === 4) return v4Gesperrt(ip);
  if (art === 6) return v6Gesperrt(ip);
  return true;
}

const NAME_GESPERRT = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

export interface ReferenzOptionen {
  /** Nur Prüfskripte lockern das, um gegen einen Server auf 127.0.0.1 zu laufen. */
  adresseErlaubt?: (ip: string) => boolean;
  portErlaubt?: (port: number) => boolean;
  /** Nur Prüfskripte ersetzen die Namensauflösung. */
  aufloesen?: (name: string) => Promise<{ address: string; family: number }[]>;
}

const standardPort = (p: number) => p === 80 || p === 443;
const standardAufloesen = (name: string) => dns.promises.lookup(name, { all: true, verbatim: true });

/** Prüft eine Adresse ohne Netz. Wirft `URL_UNGUELTIG` oder `ZIEL_GESPERRT`. */
export function urlPruefen(roh: unknown, o: ReferenzOptionen = {}): URL {
  if (typeof roh !== 'string' || !roh.trim()) throw new ReferenzFehler('URL_UNGUELTIG', 'Adresse fehlt');
  if (roh.length > REFERENZ_GRENZEN.url) throw new ReferenzFehler('URL_UNGUELTIG', `Adresse: höchstens ${REFERENZ_GRENZEN.url} Zeichen`);
  let u: URL;
  try { u = new URL(roh.trim()); } catch { throw new ReferenzFehler('URL_UNGUELTIG', 'Adresse: keine gültige URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ReferenzFehler('URL_UNGUELTIG', 'Adresse: nur http oder https');
  if (u.username || u.password) throw new ReferenzFehler('URL_UNGUELTIG', 'Adresse: ohne Benutzer und Kennwort');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!(o.portErlaubt ?? standardPort)(port)) throw new ReferenzFehler('ZIEL_GESPERRT', 'Adresse: nur die Ports 80 und 443');
  const name = u.hostname.replace(/^\[|\]$/g, '');
  if (!name) throw new ReferenzFehler('URL_UNGUELTIG', 'Adresse: ohne Rechnernamen');
  const erlaubt = o.adresseErlaubt ?? ((ip: string) => !adresseGesperrt(ip));
  if (net.isIP(name)) {
    if (!erlaubt(name)) throw new ReferenzFehler('ZIEL_GESPERRT', 'Diese Adresse liegt nicht im öffentlichen Netz');
  } else if (!o.adresseErlaubt && (NAME_GESPERRT.test(name) || !name.includes('.'))) {
    throw new ReferenzFehler('ZIEL_GESPERRT', 'Dieser Rechnername ist nicht öffentlich');
  }
  return u;
}

/** Namensauflösung beim Verbinden: Jede Adresse muss erlaubt sein, sonst gibt es keine Verbindung. */
function pruefenderLookup(o: ReferenzOptionen): LookupFunction {
  const erlaubt = o.adresseErlaubt ?? ((ip: string) => !adresseGesperrt(ip));
  const aufloesen = o.aufloesen ?? standardAufloesen;
  return ((name: string, opts: any, cb: any) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    aufloesen(name).then(
      (adressen) => {
        if (adressen.length === 0) { cb(Object.assign(new Error('keine Adresse'), { code: 'ENOTFOUND' })); return; }
        if (adressen.some((a) => !erlaubt(a.address))) {
          cb(Object.assign(new Error('Ziel nicht öffentlich'), { code: 'ZIEL_GESPERRT' }));
          return;
        }
        if (opts?.all) cb(null, adressen.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, adressen[0].address, adressen[0].family);
      },
      (err) => cb(err),
    );
  }) as LookupFunction;
}

// ── Holen ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Antwort { status: number; ort: string | null; typ: string; koerper: Buffer }

const KOPF = {
  'User-Agent': 'Textwerkstatt-Stilprofil/1.0 (Einlesen einer Referenzseite)',
  Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
  'Accept-Language': 'de,en;q=0.5',
};

function einmalHolen(u: URL, o: ReferenzOptionen, frist: number): Promise<Antwort> {
  const modul = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const rest = frist - Date.now();
    if (rest <= 0) { reject(new ReferenzFehler('NICHT_ERREICHBAR', 'Zeitlimit überschritten')); return; }
    let fertig = false;
    const ende = (f: () => void) => { if (!fertig) { fertig = true; clearTimeout(uhr); f(); } };
    const req = modul.request(u, { method: 'GET', headers: KOPF, lookup: pruefenderLookup(o), agent: false }, (res) => {
      const status = res.statusCode ?? 0;
      const ort = typeof res.headers.location === 'string' ? res.headers.location : null;
      const typ = String(res.headers['content-type'] ?? '');
      // Den Körper einer Weiterleitung braucht niemand. `resume()` läse ihn ohne Grenze weiter, auch nachdem die Uhr gelöscht ist:
      // gemessen 11,4 GB in 20 s und eine offene Verbindung (Review M2). Deshalb die Verbindung schließen.
      if (status >= 300 && status < 400) { ende(() => resolve({ status, ort, typ, koerper: Buffer.alloc(0) })); req.destroy(); return; }
      const laenge = Number(res.headers['content-length']);
      if (Number.isFinite(laenge) && laenge > REFERENZ_GRENZEN.bytes) {
        req.destroy();
        ende(() => reject(new ReferenzFehler('ZU_GROSS', 'Die Seite ist größer als 2 MB')));
        return;
      }
      const teile: Buffer[] = [];
      let summe = 0;
      res.on('data', (c: Buffer) => {
        summe += c.length;
        if (summe > REFERENZ_GRENZEN.bytes) {
          req.destroy();
          ende(() => reject(new ReferenzFehler('ZU_GROSS', 'Die Seite ist größer als 2 MB')));
          return;
        }
        teile.push(c);
      });
      res.on('end', () => ende(() => resolve({ status, ort, typ, koerper: Buffer.concat(teile) })));
      res.on('error', () => ende(() => reject(new ReferenzFehler('NICHT_ERREICHBAR', 'Die Verbindung brach ab'))));
    });
    const uhr = setTimeout(() => { req.destroy(); ende(() => reject(new ReferenzFehler('NICHT_ERREICHBAR', 'Zeitlimit überschritten'))); }, rest);
    req.on('error', (err: any) => ende(() => reject(err?.code === 'ZIEL_GESPERRT'
      ? new ReferenzFehler('ZIEL_GESPERRT', 'Der Name zeigt auf eine Adresse, die nicht im öffentlichen Netz liegt')
      : new ReferenzFehler('NICHT_ERREICHBAR', 'Die Seite ist nicht erreichbar'))));
    req.end();
  });
}

function dekodieren(koerper: Buffer, typ: string): string {
  const m = typ.match(/charset\s*=\s*"?([\w-]+)/i);
  const zeichensatz = (m?.[1] ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(zeichensatz).decode(koerper);
  } catch {
    return new TextDecoder('utf-8').decode(koerper);
  }
}

export interface ReferenzSeite {
  /** Die Adresse nach allen Weiterleitungen. */
  url: string;
  titel: string;
  text: string;
  /** Zeichen des herausgezogenen Textes vor dem Kürzen. */
  zeichenGesamt: number;
  gekuerzt: boolean;
}

export async function referenzHolen(roh: unknown, o: ReferenzOptionen = {}): Promise<ReferenzSeite> {
  let u = urlPruefen(roh, o);
  const frist = Date.now() + REFERENZ_GRENZEN.zeitMs;
  for (let i = 0; i <= REFERENZ_GRENZEN.weiterleitungen; i++) {
    const a = await einmalHolen(u, o, frist);
    if (a.status >= 300 && a.status < 400) {
      if (!a.ort) throw new ReferenzFehler('ANTWORT', `Weiterleitung ohne Ziel (HTTP ${a.status})`);
      if (i === REFERENZ_GRENZEN.weiterleitungen) throw new ReferenzFehler('ANTWORT', 'Zu viele Weiterleitungen');
      let neu: string;
      try { neu = new URL(a.ort, u).toString(); } catch { throw new ReferenzFehler('ANTWORT', 'Weiterleitung auf eine ungültige Adresse'); }
      u = urlPruefen(neu, o);
      continue;
    }
    if (a.status !== 200) throw new ReferenzFehler('ANTWORT', `Die Seite antwortet mit HTTP ${a.status}`);
    const typ = a.typ.toLowerCase();
    const istHtml = typ.includes('text/html') || typ.includes('application/xhtml');
    if (!istHtml && !typ.includes('text/plain')) throw new ReferenzFehler('ANTWORT', 'Die Adresse liefert keine Webseite und keinen Text');
    const roh2 = dekodieren(a.koerper, a.typ);
    const { titel, text } = istHtml ? htmlZuText(roh2) : { titel: '', text: textSaeubern(roh2.split('\n')) };
    if (text.length < 200) throw new ReferenzFehler('KEIN_TEXT', 'Auf der Seite steht zu wenig Fließtext (unter 200 Zeichen); bitte eine andere Seite oder den Text einfügen');
    const gekuerzt = kuerzen(text, STIL_GRENZEN.referenz);
    return { url: u.toString(), titel, text: gekuerzt, zeichenGesamt: text.length, gekuerzt: gekuerzt.length < text.length };
  }
  throw new ReferenzFehler('ANTWORT', 'Zu viele Weiterleitungen');
}

// ── Text herausziehen ──────────────────────────────────────────────────────────────────────────────────────────────

/** Diese Elemente samt Inhalt überspringen: Code, Navigation, Formulare, Fuß- und Kopfzeilen. */
const UEBERSPRINGEN = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'head', 'nav', 'footer', 'header', 'aside', 'form', 'select',
  'button', 'iframe', 'object', 'canvas', 'textarea', 'dialog',
]);
/** Diese Elemente beenden einen Absatz. */
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'main', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th',
  'table', 'blockquote', 'pre', 'dd', 'dt', 'dl', 'figcaption', 'figure', 'hr', 'address', 'summary', 'details',
]);

const ENTITAETEN: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö',
  Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', ccedil: 'ç', ndash: '–', mdash: '—', bdquo: '„',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', laquo: '«', raquo: '»', hellip: '…', euro: '€', copy: '©', reg: '®',
  trade: '™', deg: '°', middot: '·', bull: '•', times: '×', sup2: '²', sup3: '³', micro: 'µ', thinsp: ' ', ensp: ' ', emsp: ' ',
};

export function entitaetenAufloesen(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});/gi, (ganz, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return ENTITAETEN[e] ?? ganz;
  });
}

/** Tag-Name ab `i` (nach `<` bzw. `</`), klein geschrieben. */
function tagName(html: string, i: number): string {
  let j = i;
  while (j < html.length) {
    const c = html.charCodeAt(j);
    // A–Z, a–z, 0–9, „-“ — als Zeichencode statt Regex je Zeichen: Bei 2 MB `<` zählt jede Nanosekunde.
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) break;
    j++;
  }
  return j === i ? '' : html.slice(i, j).toLowerCase();
}

/**
 * HTML zu Text, in einem Durchlauf: Jede Suche (`indexOf`) beginnt hinter der vorigen, nichts wird zweimal gelesen. Ein
 * übersprungenes Element ohne Ende überspringt den Rest der Seite, statt den Durchlauf zu wiederholen.
 */
export function htmlZuText(html: string): { titel: string; text: string } {
  const tm = html.slice(0, 200_000).match(/<title[^>]{0,200}>([^<]{0,500})<\/title>/i);
  const titel = tm ? entitaetenAufloesen(tm[1]).replace(/\s+/g, ' ').trim() : '';

  // Gibt es einen Hauptteil, gilt nur er (Menüs und Fußzeilen stehen meist außerhalb). Höchstens zwei Durchläufe: der
  // Hauptteil (`<main>`, sonst `<article>`) und, wenn er zu wenig Text trägt, die ganze Seite.
  const klein = html.toLowerCase();
  for (const t of ['main', 'article']) {
    const a = klein.indexOf(`<${t}`);
    const b = klein.lastIndexOf(`</${t}`);
    if (a >= 0 && b > a) {
      const teil = durchlauf(html.slice(a, b));
      return { titel, text: teil.length >= 200 ? teil : durchlauf(html) };
    }
  }
  return { titel, text: durchlauf(html) };
}

function durchlauf(html: string): string {
  const klein = html.toLowerCase();
  const zeilen: string[] = [];
  let zeile = '';
  const umbruch = () => { zeilen.push(zeile); zeile = ''; };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { zeile += html.slice(i); break; }
    zeile += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      i = e < 0 ? html.length : e + 3;
      continue;
    }
    const zu = html[lt + 1] === '/';
    const name = tagName(html, lt + (zu ? 2 : 1));
    const steuer = html[lt + 1] === '!' || html[lt + 1] === '?';
    if (!name && !steuer) {
      // `<` ohne Tag: weglassen, OHNE vorher nach `>` zu suchen. Sonst sucht jedes `<` bis ans Ende und der Durchlauf rückt nur
      // ein Zeichen vor: 2 MB `<<<…>` kosteten 76 s (Review M1). Behalten kostete bei 2 MB noch 0,4 s für eine Zeile Müll; in
      // gültigem HTML steht ein Kleiner-als-Zeichen im Text ohnehin als `&lt;` und kommt beim Auflösen zurück.
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break;
    // <!DOCTYPE …>, <![CDATA[…]]>, <?xml …?>: kein Text
    if (steuer) { i = gt + 1; continue; }
    if (!zu && UEBERSPRINGEN.has(name) && html[gt - 1] !== '/') {
      const e = klein.indexOf(`</${name}`, gt + 1);
      if (e < 0) { i = html.length; break; }
      const e2 = html.indexOf('>', e);
      i = e2 < 0 ? html.length : e2 + 1;
      umbruch();
      continue;
    }
    if (BLOCK.has(name)) umbruch();
    else zeile += ' ';
    i = gt + 1;
  }
  umbruch();
  return textSaeubern(zeilen.map(entitaetenAufloesen));
}

/**
 * Ein Wort, das eine Adresse oder Mailadresse ist oder enthält, auch in Klammern, Anführungszeichen oder nach „Link:“, und ein
 * Rechnername mit Pfad („beispiel.at/profile“). Bis zum Review prüfte das nur den Wortanfang (Review N2). Ohne Rückverfolgung:
 * Geprüft wird ein einzelnes Wort mit `includes` und zwei Mustern aus je einer Zeichenklasse.
 */
export function istAdresse(wort: string): boolean {
  const w = wort.toLowerCase();
  if (w.includes('://') || w.includes('www.') || w.includes('mailto:') || w.startsWith('tel:')) return true;
  const at = w.indexOf('@');
  if (at > 0 && w.indexOf('.', at) > at + 1) return true;
  const schraeg = w.indexOf('/');
  if (schraeg <= 0) return false;
  const rechner = w.slice(0, schraeg).replace(/^[^a-z0-9]+/, '');
  const punkt = rechner.lastIndexOf('.');
  return punkt > 0 && /^[a-z]{2,24}$/.test(rechner.slice(punkt + 1)) && /^[a-z0-9.-]+$/.test(rechner);
}

/**
 * Zeilen zu Fließtext: Adressen und Mailadressen fallen weg (sie tragen keinen Stil, und Text mit Links soll nicht auf einen
 * Arbeitsrechner gehen), Leerraum wird eins, Menüreste (wenige Wörter ohne Satzzeichen) und Wiederholungen fallen weg.
 */
export function textSaeubern(zeilen: string[]): string {
  const gesehen = new Set<string>();
  const aus: string[] = [];
  for (const roh of zeilen) {
    const woerter = roh.replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‍﻿]/g, '').split(/\s+/).filter((w) => w && !istAdresse(w));
    const z = woerter.join(' ').trim();
    if (!z) continue;
    const satz = /[.!?:;…]["“”»«)]?$/.test(z);
    if (woerter.length < 4 && !satz) continue;
    if (woerter.length < 2) continue;
    const schluessel = z.toLowerCase();
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    aus.push(z);
  }
  return aus.join('\n');
}

/** Auf höchstens `max` Zeichen, an einer Zeilengrenze; eine einzelne lange Zeile an einer Wortgrenze. */
export function kuerzen(text: string, max: number): string {
  if (text.length <= max) return text;
  const schnitt = text.lastIndexOf('\n', max);
  if (schnitt >= max / 2) return text.slice(0, schnitt);
  const wort = text.lastIndexOf(' ', max);
  return text.slice(0, wort > 0 ? wort : max);
}
