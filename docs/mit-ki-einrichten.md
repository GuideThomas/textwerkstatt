# Textwerkstatt mit deiner KI einrichten

Du brauchst kein Vorwissen. Ein KI-Werkzeug, das auf deinem Rechner Befehle ausführen darf (Claude Code, Codex, Cursor,
Gemini CLI …), erledigt Installation und Anpassung. Es liest dafür [AGENTS.md](../AGENTS.md). Du kopierst einen der Sätze unten,
beantwortest die Rückfragen und tust die wenigen Dinge, die nur du tun kannst.

[English](setup-with-ai.md)

## Was nur du tust

- **Schlüssel besorgen und eintragen.** Einen DeepL-API-Schlüssel (deepl.com, Konto „API“) und, wenn du optimieren willst,
  einen Schlüssel für ein KI-Modell. Trag sie selbst mit einem Editor in die Datei `.env` ein. Gib sie der KI nicht im Chat:
  Was im Chat steht, gilt als weitergegeben.
- **Das Admin-Passwort wählen** und eintippen, wenn der Befehl danach fragt.
- **Kosten im Blick behalten.** DeepL und Cloud-Modelle rechnen nach Zeichen ab. Setz bei deinem Modell-Anbieter ein Budget.

## Schritt 1: Installieren

> Installiere mir die Textwerkstatt aus diesem Ordner lokal mit Docker, nach der README. Lege die `.env` aus der `.env.example`
> an, trag aber keine Schlüssel ein, sondern sag mir, welche ich selbst eintragen muss. Starte danach und prüfe, dass
> http://localhost:3006 antwortet. Dann hilf mir, das erste Admin-Konto anzulegen.

Die KI sollte vorher fragen: ob Docker schon installiert ist, ob die Werkstatt nur auf diesem Rechner laufen soll oder später
unter einer eigenen Adresse, und ob du mit dem Beispielinhalt (Fahrradladen) starten willst oder leer.

## Schritt 2: Für deine Organisation einrichten

> Richte die Textwerkstatt für meine Firma ‹Name› ein. Unsere Verkaufskanäle sind ‹Onlineshop, Katalog, …›, wir übersetzen
> nach ‹Englisch, Französisch, …›. Unsere Marken- und Produktnamen, die nie geändert werden dürfen: ‹…›. Lege dafür einen
> eigenen Seed an, statt den Beispielinhalt zu ändern.

Die KI sollte vorher fragen: ob der Beispielinhalt weg soll, wer außer dir Admin wird, und ob alle Angemeldeten direkt ins
Glossar schreiben dürfen oder nur Vorschläge machen (`GLOSSAR_FREIGABE`).

## Schritt 3: Glossar übernehmen

> Übernimm mein Glossar aus dieser Excel-Datei ‹Pfad›. Spalte A ist Deutsch, die anderen Spalten sind die Zielsprachen. Nimm
> nur Begriffe auf, die DeepL ohne Glossar anders übersetzen würde, und zeig mir vorher die Liste.

Die KI sollte vorher fragen: welche Zeile die Überschrift ist, was eine leere Zelle heißt, und ob Begriffe je Verkaufskanal
anders lauten. Rechne damit, dass sie für den Abgleich mit DeepL Zeichen verbraucht: bei 500 Begriffen und drei Sprachen nur
wenige tausend.

## Schritt 4: Farben und Logo anpassen

> Passe Farben und Logo der Textwerkstatt an unser Erscheinungsbild an: Hauptfarbe ‹…›, Schrift ‹…›, Logo liegt unter ‹Pfad›.
> Leg dafür ein eigenes Thema an und prüf danach die Kontraste.

Die KI sollte vorher fragen: ob die Schrift auf deinem Server liegen darf (keine Anfragen an fremde Server wie Google Fonts) und
ob es eine helle Kopfzeile oder eine dunkle sein soll.

## Wenn etwas nicht geht

> Die Textwerkstatt startet nicht oder zeigt einen Fehler. Lies die Logs mit `docker compose logs app` und sag mir in einfachen
> Worten, was los ist, bevor du etwas änderst.
