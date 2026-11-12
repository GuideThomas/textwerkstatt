# Textwerkstatt

Eine Werkstatt zum Schreiben und Übersetzen für Organisationen, denen ihre Wortwahl wichtig ist. Einen deutschen Text prüfen,
ihn mit einem KI-Modell unter harter Prüfung verbessern und mit DeepL übersetzen, mit dem eigenen Glossar, den eigenen
Verkaufskanälen und der gewünschten Anrede. Auch ganze Dokumente: InDesign (IDML), Word, Excel, PDF und Illustrator.

[English](README.md)

## Mit deiner KI einrichten

Node.js oder Docker musst du nicht kennen. Gib dieses Repository dem KI-Werkzeug, das du schon nutzt (Claude Code, Codex,
Cursor, Gemini CLI …), und lass es die Installation und die Anpassung an deine Organisation erledigen.
[docs/mit-ki-einrichten.md](docs/mit-ki-einrichten.md) enthält Sätze zum Kopieren, was die KI dich vorher fragen soll und was
nur du selbst tun kannst. Ihre Anleitung findet die KI in [AGENTS.md](AGENTS.md).

## Was es kann

### Prüfen

LanguageTool findet Rechtschreib- und Grammatikfehler. Auf derselben Seite wird die Hausschreibweise geprüft: Wörter, die du
vermeidest, und was du stattdessen schreibst. Markennamen, die du einträgst, werden nie „verbessert“.

### Optimieren

Ein KI-Modell schreibt den Text auf eine von mehreren Arten um: korrigieren, verständlicher, einfacher, kürzer,
verkaufsfördernd, informell, formell oder im Stilprofil eines Channels. Die Anweisung bittet, die Prüfung danach entscheidet.
Verworfen wird ein Ergebnis, wenn sich eine Zahl oder Einheit geändert hat, ein Platzhalter oder Name fehlt, ein vermiedenes
Wort hineingeraten ist, die Anrede gekippt ist oder die Länge ihr Band verlässt. Übernommen wird das Ganze oder einzelne Absätze.

Bevor ein Text an ein Cloud-Modell geht, werden Namen, Firmen, E-Mail-Adressen, Telefon- und Kontonummern, Anschriften und die
eigene Schutzliste durch Platzhalter ersetzt, und die Antwort wird gegen sie geprüft. Lokale Modelle bekommen den Text, wie er ist.

### Übersetzen

DeepL übersetzt mit deinem Glossar, je Channel und mit der gewählten Anrede (formell, informell oder Standard, wo DeepL das
kann). Auszeichnungen, Platzhalter und Tags überstehen den Weg hin und zurück. Ein Glossar führt nur gewollte Abweichungen:
Begriffe, die DeepL von sich aus anders übersetzen würde, als du sie willst.

### Glossar und Hausschreibweise

Ein Glossar je Sprachpaar, mit Verlauf jeder Änderung. Ein Begriff kann je Channel anders lauten. Wer direkt schreibt, ist ein
Schalter: nur Admins (Vorgabe) oder alle Angemeldeten. Wer nicht Admin ist, schlägt vor, ein Admin gibt frei.

### Dokumente

IDML, DOCX, XLSX, PDF (über Docling), XML, HTML, CSV, Markdown und reiner Text werden Segment für Segment übersetzt und in
ihrem eigenen Format wieder aufgebaut; CSV-Exporte aus Magento behalten ihre Store-View-Links. Ein
Segment-Speicher nutzt frühere Übersetzungen, eine Zeichengrenze je Textrahmen hält das Layout, und Muttersprachler können eine
Übersetzung prüfen und freigeben, bevor sie herausgeht. Ein Illustrator-Panel tauscht Texte mit offenen Dokumenten aus.

## Installation

Du brauchst Docker mit Docker Compose, einen DeepL-API-Schlüssel und, fürs Optimieren, Zugang zu einem OpenAI-kompatiblen
Modell-Endpunkt.

```bash
git clone https://github.com/GuideThomas/textwerkstatt.git
cd textwerkstatt
cp .env.example .env
```

Öffne `.env` in einem Editor und setze mindestens `DB_PASSWORD` und `SESSION_SECRET` auf lange Zufallswerte und `DEEPL_API_KEY`
auf deinen Schlüssel. Die Zufallswerte erzeugt Docker (einmal je Wert ausführen und in die `.env` kopieren):

```bash
docker run --rm alpine:3.20 sh -c "tr -dc a-f0-9 </dev/urandom | head -c 64; echo"
```

Dann:

```bash
docker compose up -d
```

Meldet Docker `ports are not available` (Windows reserviert manche Ports), trag `APP_PORT=3106` in die `.env` ein, starte noch
einmal und nimm diesen Port in der Adresse unten. Ohne DeepL-Schlüssel startet die Werkstatt auch; Prüfen und Hausschreibweise
gehen, Übersetzen nicht, und im Log steht `API key is invalid`, bis der Schlüssel eingetragen ist.

Die Oberfläche läuft auf http://localhost:3006, nur auf diesem Rechner (anderer Port: `APP_PORT` in der `.env`). Beim ersten Start legt der Container das Datenbankschema
an und spielt den Beispielinhalt aus `seeds/demo/` ein: einen kleinen Fahrradladen mit zwei Channels, Glossar DE→EN und DE→FR,
Hausschreibweise und Stilprofilen. Mit `SEED=` in der `.env` startet es leer; eigener Inhalt gehört nach `seeds/<name>/`, dazu
`SEED=<name>`.

Das erste Admin-Konto in einem eigenen Terminal anlegen (PowerShell, Terminal); der Befehl fragt nach dem Passwort (mindestens 12
Zeichen), eine KI kann es also nicht für dich eintippen, und er geht nur, solange es noch keinen Admin gibt. Weitere Konten legt ein Admin unter Verwaltung › Benutzer an, oder sie entstehen bei der ersten Microsoft-Anmeldung
(`AZURE_*`).

```bash
docker compose exec -it app node dist/db/erster-admin.js du@example.com "Dein Name"
```

Für eine eigene Domain gehört ein Reverse Proxy mit TLS davor (nginx, Caddy), dazu `APP_URL`.

## Dienste und Einstellungen

Alle Einstellungen stehen in der `.env`; [.env.example](.env.example) erklärt jede.

| Dienst | Gebraucht für | Einstellungen |
|---|---|---|
| PostgreSQL 16 | alles | `DB_*` (Compose startet sie) |
| DeepL API | Übersetzen, Glossare | `DEEPL_API_KEY`, `DEEPL_CHARACTER_LIMIT` |
| OpenAI-kompatibler Endpunkt (z. B. LiteLLM) | Optimieren, Kürzen, Namensfassung | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_*_MODEL`, je KI-Weg ein Schlüssel `KI_WEG_<NAME>_KEY` |
| LanguageTool | Prüfen | `LANGUAGETOOL_URL` (Compose startet es) |
| Docling | PDF | `DOCLING_URL` |
| Microsoft Entra ID | Anmeldung mit Microsoft | `AZURE_*` |
| Mailserver | Einladungen zur Prüfung | `MAIL_FROM` (SMTP auf 127.0.0.1:25) |
| Deine Organisation | Namen in der Oberfläche | `ORGANISATION_NAME`, `APP_NAME`, `GESCHUETZTE_WOERTER` |
| Erscheinungsbild | Farben, Logo, Schrift | Build-Argument `THEMA`, Ordner `client/themes/<name>/` |

## Sicherheitsmodell

- Schlüssel nur in der `.env`, nie im Code oder im Repository. Der Server lauscht auf 127.0.0.1, den Weg nach außen macht ein
  Reverse Proxy.
- Maschinen-Wege (Stapelübersetzung, Kürzen, Übersetzungsprüfung, Chat-Zugang, Illustrator-Panel) sind zu, solange ihr Schlüssel
  leer ist. Ein leerer Schlüssel heißt nie „offen“.
- Schalter schließen, wenn sie fehlen: ein unbekannter Wert für `GLOSSAR_FREIGABE` heißt „nur Admins“, `DEMO_MODUS=an` ohne
  Passwort verweigert den Start.
- Freitext erreicht ein Cloud-Modell nur über die Pseudonymisierung und ihre Prüfung danach. Ihre Grenzen: Sie erkennt die
  Klassen oben und deine Schutzliste, nicht jede vertrauliche Tatsache in einem Satz. Bedeutungswörter um eine Zahl
  („mindestens“ → „bis zu“) werden nicht geprüft. Texte, die das Haus nicht verlassen dürfen, gehören auf keinen Cloud-Weg,
  sondern an ein lokales Modell.
- Jeder KI-Weg hat einen eigenen Schlüssel, ein Budget kann ihn also allein sperren. Die Werkstatt weicht nie auf ein anderes
  Modell aus.

## Demo

Eine öffentliche Demo mit Beispielinhalt entsteht unter textwerkstatt.thomaswinkler.art. Sie setzt sich alle zehn Tage selbst
zurück. Bitte dort keine vertraulichen Texte eingeben.

## Entwicklung

```bash
npm ci && (cd client && npm ci)
npm run dev
```

Die Prüfungen laufen gegen eine Wegwerf-Datenbank (sie bauen deren Schema neu):

```bash
npm run build:server
node scripts/oeffentlich/pruefen.mjs
```

Wie man diese Datenbank mit Docker startet, steht im Kopf von [scripts/oeffentlich/pruefen.mjs](scripts/oeffentlich/pruefen.mjs).

## Lizenz

Vorerst alle Rechte vorbehalten. Eine Lizenz folgt. Issues sind willkommen.
