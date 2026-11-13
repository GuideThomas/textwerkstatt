import express from 'express';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import connectPgSimple from 'connect-pg-simple';
import { pool, testConnection } from './db/connection';
import { startQueue, stopQueue } from './services/queue';
import { refreshFormalityLanguages } from './services/formality';
import { ensureUploadDir } from './services/storage';
import healthRouter from './routes/health';
import einstellungenRouter from './routes/einstellungen';
import projectsRouter from './routes/projects';
import uploadRouter from './routes/upload';
import glossariesRouter from './routes/glossaries';
import wortlistePflegeRouter from './routes/wortliste-pflege';
import glossarVorschlaegeRouter from './routes/glossar-vorschlaege';
import segmentsRouter from './routes/segments';
import sseRouter from './routes/sse';
import reviewRouter from './routes/review';
import reviewReleaseRouter from './routes/review-release';
import terminologyScanRouter from './routes/terminology-scan';
import authRouter from './routes/auth';
import microsoftAuthRouter from './routes/microsoftAuth';
import dashboardRouter from './routes/dashboard';
import usersRouter from './routes/users';
import quickTranslateRouter from './routes/quick-translate';
import batchTranslateRouter from './routes/batch-translate';
import condenseRouter from './routes/condense';
import uebersetzungPruefungRouter from './routes/uebersetzung-pruefung';
import channelFassungRouter from './routes/channel-fassung';
import namensfassungRouter from './routes/namensfassung';
import namensBausteineRouter from './routes/namens-bausteine';
import cepRouter from './routes/cep';
import panelRouter from './routes/panel';
import languagetoolRouter from './routes/languagetool';
import houseTermsRouter from './routes/house-terms';
import houseTermsExportRouter from './routes/house-terms-export';
import topicsRouter from './routes/topics';
import nativeSpeakersRouter from './routes/native-speakers';
import terminologyRouter from './routes/terminology';
import textwerkstattRouter from './routes/textwerkstatt';
import { requireAuth } from './middleware/auth';
import { uiLang } from './middleware/uiLang';
import { sessionOrChatKey } from './middleware/chat-service';
import { demoSperre } from './demo/sperre';
import { demoAnfrage } from './demo/grenzen';
import demoTorRouter from './demo/tor';
import { demoEigeneProjekte } from './demo/eigene';

const app = express();
const isProduction = !config.isDev;

/**
 * Sitzungs-Cookie nur über https? `SESSION_COOKIE_SECURE`: `true`/`false`, oder `auto` = so, wie die Verbindung ist (hinter
 * einem Proxy aus X-Forwarded-Proto). Ohne Angabe wie bisher: in Produktion immer. Über reines http verschickt express-session
 * ein `secure`-Cookie gar nicht — die Anmeldung meldet Erfolg und man bleibt abgemeldet; docker-compose.yml setzt deshalb `auto`.
 */
function cookieSecure(): boolean | 'auto' {
  const roh = (process.env.SESSION_COOKIE_SECURE ?? '').trim().toLowerCase();
  if (roh === 'auto') return 'auto';
  if (roh === 'true') return true;
  if (roh === 'false') return false;
  if (roh !== '') throw new Error(`SESSION_COOKIE_SECURE="${process.env.SESSION_COOKIE_SECURE}" ist unbekannt (erlaubt: auto, true, false oder leer)`);
  return isProduction;
}

// Der Kopf `X-Powered-By: Express` nennt jedem Besucher das Framework; er nützt niemandem.
app.disable('x-powered-by');

// Trust proxy (behind nginx/Cloudflare)
if (isProduction) {
  app.set('trust proxy', 1);
}

// CORS
app.use(cors({
  origin: isProduction ? false : ['http://localhost:5173', 'http://localhost:3006'],
  credentials: true,
}));

app.use(express.json({ limit: '2mb' })); // 2mb: CEP-Panel kann viele Textrahmen auf einmal schicken
app.use(uiLang); // Fehlermeldungen in der Oberflächensprache (Header X-UI-Lang)

// Session middleware — Store in Postgres (Migration 024). Der frühere MemoryStore
// meldete bei jedem Deploy/Neustart alle ab, auch Reviewer mitten in der Prüfung.
const PgSession = connectPgSimple(session);
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: false, // Tabelle kommt aus der Migration
    pruneSessionInterval: 60 * 60, // abgelaufene Sitzungen stündlich löschen
  }),
  secret: config.auth.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: cookieSecure(),
    httpOnly: true,
    // 24 Stunden. In der Demo zehn Tage, also bis zum nächsten Reset (der leert die Sitzungen mit allem anderen): Dokumente
    // hängen dort an der Gastsitzung, und wer am nächsten Tag wiederkommt, soll seine eigenen noch sehen (Entscheid Thomas 13.11.2026).
    maxAge: (config.demo.an ? 10 * 24 : 24) * 60 * 60 * 1000,
    sameSite: 'lax',
  },
}));

// Demo (`DEMO_MODUS=an`, PLAN-oeffentlich-und-demo.md Phase 2): erst die Positivliste der Wege, dann Zähler und Aufrufgrenze.
// Ohne Demo reichen beide nur weiter. Das Tor liegt neben der Anmeldung und antwortet ohne Demo mit 404.
app.use(demoSperre);
app.use('/api', demoAnfrage); // nur die API: Bilder und Skripte der Oberfläche zählen nicht auf die Minutengrenze
app.use('/api/projects', demoEigeneProjekte); // jeder Gast nur seine eigenen Projekte
app.use('/api/auth', demoTorRouter);

// Auth routes (public — no auth required)
app.use('/api/auth', authRouter);
app.use('/api/auth/microsoft', microsoftAuthRouter);

// Health (public)
app.use('/api', healthRouter);
app.use('/api', einstellungenRouter);

// Protected API routes
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/upload', requireAuth, uploadRouter);
app.use('/api/glossaries', requireAuth, glossariesRouter);
// Wortliste auf der Glossarseite: Art, Formen, Gruppenziele, Rückfrage, Ablehnen (PLAN-wortliste.md §2.7)
app.use('/api/glossaries', requireAuth, wortlistePflegeRouter);
// Vorschläge von Nicht-Admins: Liste für alle, Freigeben und Verwerfen nur Admins (PLAN-glossar-freigabe.md, 12.11.2026)
app.use('/api/glossaries', requireAuth, glossarVorschlaegeRouter);
app.use('/api/projects', requireAuth, segmentsRouter);
app.use('/api/projects', requireAuth, sseRouter);
app.use('/api/projects', requireAuth, reviewRouter);
app.use('/api/projects', requireAuth, reviewReleaseRouter);
app.use('/api/terminology-scan', requireAuth, terminologyScanRouter);
// Doppel-Eingang: Weboberflaeche per Entra-Sitzung, Mitarbeiter-Chat per
// X-Service-Key (Open WebUI auf dem KI-Mini-Server). Beide laufen ueber
// DIESELBE Route — genau deshalb, damit es keinen vierten Uebersetzungspfad
// mit eigener (unvollstaendiger) Schutzkette gibt. Siehe die vier belegten
// Faelle dieser Fehlerklasse in der Historie von services/text/html-pipeline.ts.
// Der Chat-Schluessel oeffnet NUR die Uebersetzung selbst — nicht die
// LLM-gestuetzten Nachbarrouten /alternatives und /word-order desselben Routers.
app.use('/api/quick-translate', sessionOrChatKey(['/']), quickTranslateRouter);
app.use('/api/languagetool', requireAuth, languagetoolRouter);
// Hausschreibweise lesend für den Chat (#1247) — VOR dem Pflege-Router, der
// Schlüssel öffnet nur GET /api/house-terms/export; alles andere fällt durch
// an requireAuth.
app.use('/api/house-terms/export', sessionOrChatKey(['/']), houseTermsExportRouter);
// Hausschreibweise (DE → DE) — jeder Angemeldete darf pflegen
app.use('/api/house-terms', requireAuth, houseTermsRouter);
// Terminologie-Nachschlag (Glossar, ohne DeepL) — Weboberflaeche + Chat.
app.use('/api/terminology', sessionOrChatKey(['/']), terminologyRouter);
// Textwerkstatt (Plan PLAN-textwerkstatt.md): KI-Wege ohne Ausweichmodell, Freischaltung der Cloud-KI je Nutzer.
// Eigene requireAuth/requireAdmin je Route (Phase 2, Cockpit #1838).
app.use('/api/textwerkstatt', textwerkstattRouter);
// Service-to-Service Endpoint (eigene X-Service-Key Auth statt Session)
app.use('/api/batch-translate', batchTranslateRouter);
app.use('/api/condense', condenseRouter);
// Schicht 2+3 der Uebersetzungspruefung — X-Service-Key wie /api/condense.
app.use('/api/uebersetzung-pruefung', uebersetzungPruefungRouter);
// Channel-Fassung deutscher Shop-Texte für den Artikelanlage-Assistenten — X-Service-Key.
app.use('/api/channel-fassung', channelFassungRouter);
// Artikelnamen umstellen / Wiederholung auflösen (29.10.2026) — fail closed wie channel-fassung.
app.use('/api/namensfassung', namensfassungRouter);
// Namensbausteine für den Artikelanlage-Assistenten (06.11.2026, Migration 033) — fail closed wie channel-fassung.
app.use('/api/namens-bausteine', namensBausteineRouter);
// Die Pflegeseite der Namensbausteine (09.11.2026, Migration 035) ist mit Phase 3 der Wortliste in die Glossarseite umgezogen
// (`PLAN-wortliste.md`, Entscheid Thomas 10.11.2026: jeder Angemeldete gibt frei, wie im Glossar). Sie schriebe sonst in die alte,
// für umgezogene Sprachen gesperrte Tabelle. 410 statt 404: Ein alter Aufrufer erfährt, dass der Weg bewusst weg ist.
app.use('/api/namens-pflege', requireAuth, (_req, res) => {
  res.status(410).json({ error: 'Die Namensbausteine werden seit der Wortliste auf der Glossarseite gepflegt' });
});
app.use('/api/cep', cepRouter); // Illustrator-CEP-Panel: persönlicher Panel-Schlüssel (Bearer), übergangsweise CEP_SERVICE_KEY
app.use('/api/panel', requireAuth, panelRouter); // Panel-Kopplung bestätigen, Verbindungen verwalten (Sitzung)
app.use('/api/dashboard', dashboardRouter); // has its own requireAuth per route
app.use('/api/users', usersRouter); // has its own requireAdmin per route
app.use('/api/topics', topicsRouter); // has its own requireAuth/requireAdmin per route
app.use('/api/native-speakers', nativeSpeakersRouter); // has its own requireAuth/requireAdmin per route

// Ein unbekannter API-Weg ist 404 mit JSON. Bis 13.11.2026 fiel ein GET darauf in die Oberfläche unten und kam als
// Startseite mit 200 zurück: Ein Aufrufer mit vertipptem Pfad bekam „Erfolg“ und HTML statt eines Fehlers.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Fehler, die eine Route nicht selbst fängt — allen voran Multer (Datei zu groß, falscher Typ): JSON mit Grund statt der
// HTML-Fehlerseite von Express, an der die Oberfläche beim Lesen der Antwort scheiterte („Unexpected token '<'“).
app.use('/api', (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const e = err as { name?: string; code?: string; message?: string; status?: number; type?: string };
  if (e?.name === 'MulterError') {
    const zuGross = e.code === 'LIMIT_FILE_SIZE';
    res.status(zuGross ? 413 : 400).json({
      error: zuGross ? `Die Datei ist zu groß (höchstens ${config.upload.maxFileSizeMb} MB)` : `Upload abgelehnt: ${e.message ?? e.code}`,
      code: zuGross ? 'datei_zu_gross' : 'upload_abgelehnt',
    });
    return;
  }
  if (typeof e?.message === 'string' && e.message.startsWith('Unsupported file type')) {
    res.status(400).json({ error: e.message, code: 'upload_abgelehnt' });
    return;
  }
  // body-parser: kaputtes JSON oder zu großer Rumpf
  if (e?.type === 'entity.parse.failed' || e?.type === 'entity.too.large') {
    res.status(e.status ?? 400).json({ error: e.type === 'entity.too.large' ? 'Anfrage zu groß' : 'Ungültiges JSON' });
    return;
  }
  console.error('Unbehandelter Fehler in einer API-Route:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Static Frontend (Production)
if (isProduction) {
  const clientDist = path.join(__dirname, '../client/dist');
  // Titel aus APP_NAME schon im HTML: Linkvorschauen und Lesezeichen lesen kein JavaScript.
  const titel = config.appName.replace(/[&<>"]/g, (z) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[z]!);
  const indexHtml = fs
    .readFileSync(path.join(clientDist, 'index.html'), 'utf-8')
    .replace(/<title>[^<]*<\/title>/, `<title>${titel}</title>`);
  app.use(express.static(clientDist, { index: false }));
  app.get('*', (_req, res) => {
    res.type('html').send(indexHtml);
  });
}

async function start() {
  // Upload-Verzeichnis sicherstellen
  ensureUploadDir();
  // Hinweis: Auto-Cleanup von Originaldateien wurde entfernt (Phase 10).
  // Dateien werden nur noch manuell via UI gelöscht.

  // DB-Verbindung testen
  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('Cannot connect to database. Exiting.');
    process.exit(1);
  }
  console.log('Database connected');

  // Sprachliste fuer die Anredestufe von DeepL holen. Schlaegt der Aufruf
  // fehl, bleibt die eingecheckte Rueckfallliste stehen — der Start darf daran
  // nicht scheitern. Ergaenzt DeepL spaeter eine Sprache (etwa Englisch),
  // kommt das ohne Deploy an.
  await refreshFormalityLanguages();

  // pg-boss Queue starten
  await startQueue();

  // Server starten. Vorgabe 127.0.0.1, den Weg nach außen macht ein Reverse Proxy. Nur im Container setzt das Dockerfile
  // BIND_ADDRESS=0.0.0.0, damit der veröffentlichte Port ankommt; Compose veröffentlicht ihn wiederum nur auf 127.0.0.1.
  const bind = (process.env.BIND_ADDRESS ?? '').trim() || '127.0.0.1';
  app.listen(config.port, bind, () => {
    console.log(`${config.appName} running on ${bind}:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Microsoft SSO: ${config.auth.microsoftEnabled ? 'enabled' : 'disabled'}`);
    console.log(`Glossar-Freigabe: ${config.glossarFreigabe} · Demo-Modus: ${config.demo.an ? 'an' : 'aus'}`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await stopQueue();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  await stopQueue();
  process.exit(0);
});

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
