-- Pflege der Namensbausteine durch die Muttersprachler: Rückfrage, Ablehnung und wer zuletzt entschieden hat.
--
-- Bauplan `Artikelanlage-Assistent/docs/BAUPLAN-Bausteine-Phase2.md` §9 und §10 Schritt 7, Cockpit #1767. Die Pflegeseite
-- (`routes/namens-pflege.ts`) gibt vorläufige Bausteine frei, korrigiert sie, stellt eine Rückfrage oder lehnt ab. Freigeben
-- schreibt nach `namens_bausteine`, dort zählen die Trigger aus Migration 033 Fassung und Verlauf. Für Rückfrage und Ablehnung
-- fehlte bisher der Platz für den Grund und die Spur, wer entschieden hat.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

ALTER TABLE namens_bausteine_vorlaeufig ADD COLUMN IF NOT EXISTS anmerkung TEXT;
ALTER TABLE namens_bausteine_vorlaeufig ADD COLUMN IF NOT EXISTS bearbeitet_von TEXT;
ALTER TABLE namens_bausteine_vorlaeufig ADD COLUMN IF NOT EXISTS bearbeitet_am TIMESTAMPTZ;

COMMENT ON COLUMN namens_bausteine_vorlaeufig.anmerkung IS
  'Text des Prüfers zur Rückfrage oder Ablehnung. Eine Rückfrage ohne Text weist die Pflegeseite ab.';
COMMENT ON COLUMN namens_bausteine_vorlaeufig.bearbeitet_von IS
  'E-Mail der angemeldeten Person, die zuletzt freigegeben, nachgefragt oder abgelehnt hat.';
