/**
 * Prüft die Zusagen des Textwerkstatt-Aufrufwegs (Plan `PLAN-textwerkstatt.md` §4 Phase 2, Cockpit #1838).
 * Ohne Datenbank und ohne Netz: Eine OpenAI-kompatible Attrappe läuft auf einem freien Port und zählt jeden Aufruf je Modell.
 * Gerufen wird über die echten Routen (`routes/textwerkstatt.ts`) und das echte OpenAI-SDK; nur Datenbank, Umgebung und
 * Anmeldung sind ersetzt.
 *
 * Aufruf:
 *   DB_PASSWORD=egal npx tsx src/scripts/check-ki-weg.ts
 *
 * Je Negativpfad werden der HTTP-Code UND der Aufrufzähler der Attrappe geprüft. Ein Code allein belegt nur, dass geantwortet
 * wurde, nicht dass kein Modell gerufen wurde. Jede Schranke wird an einem Fall geprüft, den NUR sie aufhält (eine Admin-Schranke
 * also am lokalen Weg, wo die Freischaltung nicht greift).
 *
 * Nicht abgedeckt, weil es eine Datenbank braucht: `PUT /api/users/:id/cloud-ki` und die SQL-Seite des Speichers; das belegt der
 * Live-Lauf nach dem Deploy.
 */
import express, { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { textwerkstattRouter, wegPruefen, PROBE_TEXT, WegSpeicher } from '../routes/textwerkstatt';
import {
  KiAbhaengigkeiten, KiWeg, standardAbhaengigkeiten, anfrageBauen, kiZustandZuruecksetzen, budgetCacheLeeren, KiWegFehler,
} from '../services/ki-weg';
import { callLlm, llmBudgetSperreBis } from '../services/llm';
import { config } from '../config';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failed++;
}

// ── Attrappe eines OpenAI-kompatiblen Endpunkts ─────────────────────────────────────────────────────────────────────
const zaehler: Record<string, number> = {};
const letzterKoerper: Record<string, any> = {};
const zustand = { cloudBudgetErschoepft: false, cloudSpend: 0.5 };
// Reset laut /key/info übermorgen 00:00 UTC: nach dem nächsten Reset der App (morgen), damit die Prüfung „bis Reset“ zeigt,
// dass die Sperre dem Proxy folgt. Bis 11.11.2026 stand hier ein festes Datum; ab diesem Tag lag es in der Vergangenheit, und
// die Prüfung 13 schlug fehl, ohne dass sich am Code etwas geändert hatte.
const RESET_AM = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 2)).toISOString(); })();
const gesamt = () => Object.values(zaehler).reduce((a, b) => a + b, 0);
const z = (m: string) => zaehler[m] ?? 0;

function attrappe(): express.Express {
  const a = express();
  a.use(express.json());
  a.post('/v1/chat/completions', (req, res) => {
    const m = String(req.body?.model);
    zaehler[m] = z(m) + 1;
    letzterKoerper[m] = req.body;
    const ok = (text: string) => res.json({
      id: 'chatcmpl-test', object: 'chat.completion', created: 0, model: m,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 12, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 0 } },
    });
    if (m === 'station-test') return ok('Antwort der Station.');
    if (m === 'llm-test') return ok('Antwort für callLlm.');
    if (m === 'cloud-test') {
      if (zustand.cloudBudgetErschoepft) {
        return res.status(429).json({ error: {
          message: 'Budget has been exceeded! Key=beispiel-schluessel (…abcd) Current cost: 3.01, Max budget: 3.0',
          type: 'budget_exceeded', code: '429' } });
      }
      res.setHeader('x-litellm-response-cost', '0.0002');
      return ok('Antwort der Cloud.');
    }
    if (m === 'cloud-global') {
      return res.status(429).json({ error: { message: 'Budget has been exceeded! Current cost: 7.2, Max budget: 7.0', type: 'budget_exceeded' } });
    }
    if (m === 'haengt') return; // antwortet nie
    res.status(400).json({ error: { message: `unbekanntes Modell ${m}` } });
  });
  a.get('/key/info', (req, res) => {
    const k = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (k !== 'k-cloud') return res.status(404).json({ error: 'Key not found' });
    res.json({ key: 'k-cloud', info: { key_alias: 'test', spend: zustand.cloudSpend, max_budget: 3.0,
      budget_duration: '1d', budget_reset_at: RESET_AM.replace('.000Z', '+00:00') } });
  });
  return a;
}

// ── Wege, Nutzer, Umgebung ───────────────────────────────────────────────────────────────────────────────────────────
const weg = (w: Partial<KiWeg> & Pick<KiWeg, 'id' | 'art' | 'modell'>): KiWeg => ({
  name: w.id, endpunkt_variable: 'KI_WEG_TEST_URL', schluessel_variable: 'KI_WEG_LOKAL_KEY', zeitlimit_s: 5,
  zusatz_parameter: {}, budget_lesen: false, aktiv: true, reihenfolge: 0, ...w,
});
const WEGE: KiWeg[] = [
  weg({ id: 'lokal', art: 'lokal', modell: 'station-test', reihenfolge: 1,
    zusatz_parameter: { 'no-log': true, num_retries: 0, extra_body: { chat_template_kwargs: { enable_thinking: false } } } }),
  weg({ id: 'cloud', art: 'cloud', modell: 'cloud-test', schluessel_variable: 'KI_WEG_CLOUD_KEY', budget_lesen: true, reihenfolge: 2 }),
  weg({ id: 'lokal-tot', art: 'lokal', modell: 'station-test', endpunkt_variable: 'KI_WEG_TOT_URL' }),
  weg({ id: 'cloud-ohne-schluessel', art: 'cloud', modell: 'cloud-test', schluessel_variable: 'KI_WEG_LEER_KEY' }),
  weg({ id: 'cloud-ohne-endpunkt', art: 'cloud', modell: 'cloud-test', schluessel_variable: 'KI_WEG_CLOUD_KEY', endpunkt_variable: 'KI_WEG_LEER_URL' }),
  weg({ id: 'cloud-global', art: 'cloud', modell: 'cloud-global', schluessel_variable: 'KI_WEG_GLOBAL_KEY' }),
  weg({ id: 'haengt', art: 'lokal', modell: 'haengt', zeitlimit_s: 1 }),
  weg({ id: 'aus', art: 'lokal', modell: 'station-test', aktiv: false }),
  // Diese zwei kämen an den CHECKs der Datenbank nicht vorbei; der Code muss sie trotzdem selbst ablehnen.
  weg({ id: 'falsch-gebunden', art: 'lokal', modell: 'cloud-test', schluessel_variable: 'KI_WEG_CLOUD_KEY' }),
  weg({ id: 'zusatz-boese', art: 'lokal', modell: 'station-test', zusatz_parameter: { extra_body: { model: 'cloud-test' } } }),
];
const NUTZER: Record<string, { role: string; cloud: boolean }> = {
  'admin-frei': { role: 'admin', cloud: true },
  'admin-nicht': { role: 'admin', cloud: false },
  nutzer: { role: 'user', cloud: false },
};

async function main(): Promise<void> {
  const ziel = attrappe().listen(0, '127.0.0.1');
  await new Promise((r) => ziel.once('listening', r));
  const zielPort = (ziel.address() as AddressInfo).port;
  // Ein Port, auf dem sicher niemand lauscht: kurz belegen und wieder freigeben.
  const tot = express().listen(0, '127.0.0.1');
  await new Promise((r) => tot.once('listening', r));
  const totPort = (tot.address() as AddressInfo).port;
  await new Promise((r) => tot.close(r));

  const UMGEBUNG: Record<string, string> = {
    KI_WEG_TEST_URL: `http://127.0.0.1:${zielPort}/v1`,
    KI_WEG_TOT_URL: `http://127.0.0.1:${totPort}/v1`,
    KI_WEG_LOKAL_KEY: 'k-lokal',
    KI_WEG_CLOUD_KEY: 'k-cloud',
    KI_WEG_GLOBAL_KEY: 'k-global',
  };
  // callLlm (services/llm.ts) gegen dieselbe Attrappe: Der Client entsteht erst beim ersten Aufruf aus `config.llm`.
  // `config` ist für den Code schreibgeschützt; nur hier im Prüfskript wird es zur Laufzeit umgebogen.
  Object.assign(config.llm as Record<string, unknown>, {
    baseUrl: UMGEBUNG.KI_WEG_TEST_URL, apiKey: 'k-llm', primaryModel: 'llm-test', fallbackModel: 'llm-test',
  });

  const deps: KiAbhaengigkeiten = {
    ...standardAbhaengigkeiten,
    wegLaden: async (id) => WEGE.find((w) => w.id === id) ?? null,
    wegeLaden: async () => WEGE,
    darfCloud: async (id) => NUTZER[id]?.cloud === true,
    env: (n) => UMGEBUNG[n],
  };
  let verbrauch = 0;
  const aenderungen: Array<{ id: string; felder: Partial<KiWeg> }> = [];
  const speicher: WegSpeicher = {
    anlegen: async (w) => { WEGE.push({ ...w }); },
    aendern: async (id, felder) => {
      aenderungen.push({ id, felder });
      const w = WEGE.find((x) => x.id === id);
      if (!w) return false;
      Object.assign(w, felder);
      return true;
    },
    verbrauchMerken: async () => { verbrauch++; },
  };
  const auth = (admin: boolean) => (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.headers['x-test-nutzer'] || '');
    const n = NUTZER[id];
    if (!n) { res.status(401).json({ error: 'Authentication required' }); return; }
    if (admin && n.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return; }
    (req as any).user = { id, email: `${id}@test`, name: id, role: n.role, display_name: null };
    next();
  };

  const app = express();
  app.use(express.json());
  app.use('/api/textwerkstatt', textwerkstattRouter({ deps, speicher, requireAuth: auth(false), requireAdmin: auth(true) }));
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const basis = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/textwerkstatt`;

  const rufen = async (methode: string, pfad: string, nutzer: string | null, koerper?: unknown) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (nutzer) headers['x-test-nutzer'] = nutzer;
    const r = await fetch(`${basis}${pfad}`, { method: methode, headers, body: koerper === undefined ? undefined : JSON.stringify(koerper) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const probe = (wegId: string, nutzer: string) => rufen('POST', `/ki-wege/${wegId}/probe`, nutzer);
  const status = (nutzer: string | null) => rufen('GET', '/ki-status', nutzer);

  try {
    kiZustandZuruecksetzen();

    // 1. Lokal geht für jeden Admin, auch ohne Freischaltung; der Körper trägt die Zusatzfelder.
    let r = await probe('lokal', 'admin-nicht');
    const k = letzterKoerper['station-test'] ?? {};
    check('lokal: 200 mit Antwort', r.status === 200 && r.body.antwort === 'Antwort der Station.', r);
    check('lokal: Station genau einmal gerufen', z('station-test') === 1, zaehler);
    check('lokal: no-log und num_retries 0 stehen im Körper', k['no-log'] === true && k.num_retries === 0, k);
    check('lokal: extra_body.chat_template_kwargs.enable_thinking = false', k.extra_body?.chat_template_kwargs?.enable_thinking === false, k);
    check('lokal: model und stream setzt der Code', k.model === 'station-test' && k.stream === false, k);
    check('lokal: gesendet wird der feste Probetext', k.messages?.[1]?.content === PROBE_TEXT, k.messages);
    check('lokal: Denk-Token aus der Antwort gelesen (0)', r.body.denkToken === 0, r.body);
    check('lokal: Verbrauch gemerkt', verbrauch === 1, verbrauch);

    // 2. Admin-Schranke an einem Fall, den nur sie aufhält: lokaler Weg, Nutzer ohne Adminrolle.
    let vorher = gesamt();
    r = await probe('lokal', 'nutzer');
    check('Probe als Nicht-Admin (lokal) → 403 Admin access required', r.status === 403 && r.body.error === 'Admin access required', r);
    check('Probe als Nicht-Admin: kein Modell gerufen', gesamt() === vorher, zaehler);

    // 3. Ohne Freischaltung: 403, und die Cloud wurde nicht gerufen.
    r = await probe('cloud', 'admin-nicht');
    check('ohne Freischaltung → 403 NICHT_FREIGESCHALTET', r.status === 403 && r.body.code === 'NICHT_FREIGESCHALTET', r);
    check('ohne Freischaltung: Cloud-Modell nicht gerufen (Zähler 0)', z('cloud-test') === 0, zaehler);

    // 4. Schlüssel oder Endpunkt fehlt: 503, kein Aufruf.
    vorher = gesamt();
    r = await probe('cloud-ohne-schluessel', 'admin-frei');
    check('Schlüssel fehlt → 503 SCHLUESSEL_FEHLT', r.status === 503 && r.body.code === 'SCHLUESSEL_FEHLT', r);
    r = await probe('cloud-ohne-endpunkt', 'admin-frei');
    check('Endpunkt fehlt → 503 ENDPUNKT_FEHLT', r.status === 503 && r.body.code === 'ENDPUNKT_FEHLT', r);
    check('Schlüssel/Endpunkt fehlt: kein Modell gerufen', gesamt() === vorher, zaehler);

    // 5. Konfiguration zur Laufzeit: falsch gebundene Art und unzulässige Zusatzfelder werden abgelehnt, bevor etwas hinausgeht.
    vorher = gesamt();
    r = await probe('falsch-gebunden', 'admin-nicht');
    check('lokal auf Cloud-Schlüssel → 503 KONFIGURATION', r.status === 503 && r.body.code === 'KONFIGURATION', r);
    r = await probe('zusatz-boese', 'admin-frei');
    check('extra_body.model in den Zusatzfeldern → 503 KONFIGURATION', r.status === 503 && r.body.code === 'KONFIGURATION', r);
    check('Konfigurationsfehler: kein Modell gerufen (Cloud 0)', gesamt() === vorher && z('cloud-test') === 0, zaehler);

    // 6. Station nicht erreichbar: Fehler, und die Cloud wurde NICHT gerufen (kein stiller Rückfall, G2).
    vorher = gesamt();
    r = await probe('lokal-tot', 'admin-frei');
    check('Station weg → 502 NICHT_ERREICHBAR', r.status === 502 && r.body.code === 'NICHT_ERREICHBAR', r);
    check('Station weg: Cloud-Modell nicht gerufen (Zähler 0)', z('cloud-test') === 0, zaehler);
    check('Station weg: auch sonst kein Modell gerufen', gesamt() === vorher, zaehler);

    // 7. Cloud mit Freischaltung: 200, Kosten aus der Kopfzeile.
    r = await probe('cloud', 'admin-frei');
    check('Cloud freigeschaltet → 200', r.status === 200 && r.body.antwort === 'Antwort der Cloud.', r);
    check('Cloud: Kosten aus x-litellm-response-cost', r.body.kostenUsd === 0.0002, r.body);
    check('Cloud: genau einmal gerufen', z('cloud-test') === 1, zaehler);

    // 8. Budget erreicht: Meldung mit Zeitpunkt, danach kein weiterer Aufruf an diesen Schlüssel, alles andere läuft weiter.
    zustand.cloudBudgetErschoepft = true;
    zustand.cloudSpend = 3.01;
    r = await probe('cloud', 'admin-frei');
    check('Budget erreicht → 429 BUDGET_EIGEN mit bis', r.status === 429 && r.body.code === 'BUDGET_EIGEN' && !!r.body.bis, r);
    check('Budget erreicht: genau ein Versuch, kein Ausweichen', z('cloud-test') === 2, zaehler);
    r = await probe('cloud', 'admin-frei');
    check('Budget gesperrt → 429 ohne neuen Aufruf (Zähler bleibt 2)', r.status === 429 && z('cloud-test') === 2, { r, zaehler });
    const stationVorher = z('station-test');
    r = await probe('lokal', 'admin-frei');
    check('Budget Cloud erreicht: lokaler Weg läuft weiter', r.status === 200 && z('station-test') === stationVorher + 1, r);
    const llm = await callLlm('System', 'Text').catch((e) => ({ text: `FEHLER ${e.message}` }));
    check('Budget Cloud erreicht: callLlm läuft weiter (echter Aufruf an die Attrappe)', llm.text === 'Antwort für callLlm.' && z('llm-test') === 1, { llm, zaehler });
    check('Budget Cloud erreicht: callLlm hat keine eigene Sperre gesetzt', llmBudgetSperreBis() === 0, llmBudgetSperreBis());

    // 9. Globale Proxy-Grenze wird als solche gemeldet, nicht als eigene.
    r = await probe('cloud-global', 'admin-frei');
    check('globale Grenze → 429 BUDGET_GLOBAL', r.status === 429 && r.body.code === 'BUDGET_GLOBAL', r);

    // 10. Zeitlimit je Weg, ohne zweiten Versuch.
    const t0 = Date.now();
    r = await probe('haengt', 'admin-frei');
    const dauer = Date.now() - t0;
    check('Zeitlimit 1 s → 504 ZEITLIMIT', r.status === 504 && r.body.code === 'ZEITLIMIT', r);
    check('Zeitlimit: ein Versuch, kein Wiederholen (Zähler 1, unter 4 s)', z('haengt') === 1 && dauer < 4000, { zaehler, dauer });

    // 11. Ausgeschaltet und unbekannt.
    vorher = gesamt();
    r = await probe('aus', 'admin-frei');
    check('ausgeschalteter Weg → 409 WEG_INAKTIV', r.status === 409 && r.body.code === 'WEG_INAKTIV', r);
    r = await probe('gibtsnicht', 'admin-frei');
    check('unbekannter Weg → 404 WEG_UNBEKANNT', r.status === 404 && r.body.code === 'WEG_UNBEKANNT', r);
    check('ausgeschaltet/unbekannt: kein Modell gerufen', gesamt() === vorher, zaehler);

    // 12. Zustand je Nutzer: zeigt Gründe, ruft kein Modell, Budgetzahlen nur für Freigeschaltete.
    vorher = gesamt();
    let s = await status('nutzer');
    const lokalN = s.body.wege?.find((w: any) => w.id === 'lokal');
    const cloudN = s.body.wege?.find((w: any) => w.id === 'cloud');
    check('Status Nutzer: lokal verfügbar', s.status === 200 && lokalN?.verfuegbar === true, s.body);
    check('Status Nutzer: Cloud nicht freigeschaltet', cloudN?.verfuegbar === false && cloudN?.grund === 'NICHT_FREIGESCHALTET', cloudN);
    check('Status Nutzer: kein Cloud-Budget sichtbar', cloudN?.budget === null, cloudN);
    check('Status Nutzer: ausgeschaltete Wege fehlen', !s.body.wege?.some((w: any) => w.id === 'aus'), s.body.wege);
    s = await status('admin-frei');
    const cloudA = s.body.wege?.find((w: any) => w.id === 'cloud');
    check('Status Admin: Cloud gesperrt mit Grund BUDGET_EIGEN und Zeitpunkt', cloudA?.grund === 'BUDGET_EIGEN' && !!cloudA?.gesperrtBis, cloudA);
    check('Status Admin: Budget aus /key/info (3,01 von 3)', cloudA?.budget?.erreicht === true && cloudA?.budget?.grenzeUsd === 3, cloudA?.budget);
    check('Status: kein Modell gerufen', gesamt() === vorher, zaehler);

    // 13. Nach einem Neustart: Die Grenze aus /key/info sperrt auch den Aufruf, ohne erst einen zu verbrennen.
    kiZustandZuruecksetzen();
    s = await status('admin-frei');
    const cloudB = s.body.wege?.find((w: any) => w.id === 'cloud');
    check('Neustart: erreichte Grenze aus /key/info → BUDGET_EIGEN bis Reset', cloudB?.grund === 'BUDGET_EIGEN' && cloudB?.gesperrtBis === RESET_AM, cloudB);
    const cloudVorher = z('cloud-test');
    r = await probe('cloud', 'admin-frei');
    check('Neustart: Probe danach → 429 ohne Aufruf', r.status === 429 && z('cloud-test') === cloudVorher, { r, zaehler });

    // 14. Grenze tagsüber erhöht: /key/info meldet frei, die eigene Sperre fällt, der Weg ruft wieder.
    zustand.cloudBudgetErschoepft = false;
    zustand.cloudSpend = 0.6;
    budgetCacheLeeren();
    s = await status('admin-frei');
    const cloudC = s.body.wege?.find((w: any) => w.id === 'cloud');
    check('Grenze erhöht: Status wieder verfügbar', cloudC?.verfuegbar === true, cloudC);
    r = await probe('cloud', 'admin-frei');
    check('Grenze erhöht: Probe → 200 mit genau einem Aufruf', r.status === 200 && z('cloud-test') === cloudVorher + 1, { r, zaehler });

    // 15. Rechte der Routen.
    check('ki-status ohne Anmeldung → 401', (await status(null)).status === 401);
    check('ki-wege lesen als Nicht-Admin → 403', (await rufen('GET', '/ki-wege', 'nutzer')).status === 403);
    check('ki-wege anlegen als Nicht-Admin → 403', (await rufen('POST', '/ki-wege', 'nutzer', { id: 'x' })).status === 403);
    check('ki-wege ändern als Nicht-Admin → 403', (await rufen('PUT', '/ki-wege/lokal', 'nutzer', { modell: 'x' })).status === 403);
    const liste = await rufen('GET', '/ki-wege', 'admin-frei');
    const lokalL = liste.body?.find?.((w: any) => w.id === 'lokal');
    check('ki-wege als Admin: Variablenname und „gesetzt“, nie der Wert', liste.status === 200 && lokalL?.schluesselGesetzt === true
      && lokalL?.schluessel_variable === 'KI_WEG_LOKAL_KEY' && !JSON.stringify(liste.body).includes('k-lokal'), lokalL);

    // 16. Die Routen prüfen ihre Eingaben, und Art und Variablen sind nach dem Anlegen fest.
    const n0 = aenderungen.length;
    r = await rufen('PUT', '/ki-wege/lokal', 'admin-frei', { schluessel_variable: 'DB_PASSWORD' });
    check('PUT Schlüssel-Variable DB_PASSWORD → 400', r.status === 400, r);
    r = await rufen('PUT', '/ki-wege/lokal', 'admin-frei', { schluessel_variable: 'KI_WEG_CLOUD_KEY' });
    check('PUT anderer Schlüssel → 400 (fest)', r.status === 400, r);
    r = await rufen('PUT', '/ki-wege/lokal', 'admin-frei', { art: 'cloud' });
    check('PUT Art ändern → 400 (fest)', r.status === 400, r);
    r = await rufen('PUT', '/ki-wege/lokal', 'admin-frei', { zusatz_parameter: { fallbacks: ['cloud-test'] } });
    check('PUT Zusatz fallbacks → 400', r.status === 400, r);
    r = await rufen('PUT', '/ki-wege/lokal', 'admin-frei', { zusatz_parameter: { extra_body: { model: 'cloud-test' } } });
    check('PUT Zusatz extra_body.model → 400', r.status === 400, r);
    r = await rufen('PUT', '/ki-wege/lokal', 'admin-frei', { zusatz_parameter: { user: 'freier Text' } });
    check('PUT Zusatz user → 400', r.status === 400, r);
    check('abgelehnte PUTs: nichts gespeichert', aenderungen.length === n0, aenderungen);
    r = await rufen('PUT', '/ki-wege/lokal', 'admin-frei', { zeitlimit_s: 200, art: 'lokal' });
    check('PUT Zeitlimit (Art unverändert mitgeschickt) → 200', r.status === 200 && r.body.zeitlimit_s === 200, r);
    r = await rufen('PUT', '/ki-wege/gibtsnicht', 'admin-frei', { modell: 'x' });
    check('PUT unbekannter Weg → 404', r.status === 404, r);
    const neuerWeg = { id: 'neu-lokal', name: 'Neu', art: 'lokal', modell: 'station-test', endpunkt_variable: 'LLM_BASE_URL', zeitlimit_s: 30 };
    r = await rufen('POST', '/ki-wege', 'admin-frei', { ...neuerWeg, schluessel_variable: 'KI_WEG_CLOUD_KEY' });
    check('POST lokal mit Cloud-Schlüssel → 400', r.status === 400, r);
    r = await rufen('POST', '/ki-wege', 'admin-frei', { ...neuerWeg, art: 'cloud', schluessel_variable: 'KI_WEG_LOKAL_KEY' });
    check('POST Cloud mit lokalem Schlüssel → 400', r.status === 400, r);
    r = await rufen('POST', '/ki-wege', 'admin-frei', { ...neuerWeg, schluessel_variable: 'KI_WEG_LOKAL2_KEY' });
    check('POST gültiger lokaler Weg → 201', r.status === 201 && r.body?.id === 'neu-lokal', r);
    r = await rufen('POST', '/ki-wege', 'admin-frei', { ...neuerWeg, schluessel_variable: 'KI_WEG_LOKAL2_KEY' });
    check('POST dieselbe Kennung → 409', r.status === 409, r);

    // 17. Prüffunktionen direkt.
    check('wegPruefen: Endpunkt-Variable LANGUAGETOOL_URL abgelehnt', !wegPruefen({ endpunkt_variable: 'LANGUAGETOOL_URL' }, false).ok);
    check('wegPruefen: Zusatzparameter als Liste abgelehnt', !wegPruefen({ zusatz_parameter: [1] }, false).ok);
    check('wegPruefen: chat_template_kwargs mit Text abgelehnt', !wegPruefen({ zusatz_parameter: { extra_body: { chat_template_kwargs: { system: 'x' } } } }, false).ok);
    check('wegPruefen: num_retries 2 abgelehnt', !wegPruefen({ zusatz_parameter: { num_retries: 2 } }, false).ok);
    check('wegPruefen: Füllung der Installation angenommen', wegPruefen({ zusatz_parameter:
      { 'no-log': true, num_retries: 0, cache: { 'no-cache': true }, extra_body: { reasoning_effort: 'low' } } }, false).ok);
    let geworfen: unknown = null;
    try { anfrageBauen({ ...WEGE[0], zusatz_parameter: { model: 'x' } }, 's', 't'); } catch (e) { geworfen = e; }
    check('anfrageBauen: unzulässiges Zusatzfeld wirft KONFIGURATION', geworfen instanceof KiWegFehler && geworfen.code === 'KONFIGURATION', geworfen);
  } finally {
    server.closeAllConnections?.();
    server.close();
    ziel.closeAllConnections?.();
    ziel.close();
  }

  console.log(failed === 0 ? '\nAlle Prüfungen bestanden.' : `\n${failed} Prüfung(en) fehlgeschlagen.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('Prüfskript abgebrochen:', err);
  process.exitCode = 2;
});
