-- Leere Glossarzeilen: der Zustand und seine Schranken.
--
-- 🚨 Geändert am 05.11.2026 (Plan `PLAN-glossar-nur-abweichungen.md`, Phase 2). Bis dahin legte diese Datei die Trigger und
-- Funktionen an, die jeden Begriff bei jeder Änderung in alle Glossare DE→X nachtrugen. Thomas hat das widerrufen: Im Glossar
-- steht nur, was wir ausdrücklich anders wollen als DeepL. Weil `migrate.js` bei jedem Deploy ALLE Dateien erneut ausführt,
-- müssen sie hier herausfallen; eine neue Datei allein ließe 027 sie vorher jedes Mal neu anlegen. Im Bestand entfernt sie
-- Migration 031, die auch das einmalige Befüllen eines neuen Glossars trägt.
--
-- ZUSTAND LEERE ZEILE: target_term IS NULL, approved = FALSE, source = 'nachtrag': Der Begriff wartet auf eine Übersetzung und
-- wirkt bis dahin nicht. Solche Zeilen entstehen nur noch beim Anlegen eines Glossars, die 4.091 aus dem alten Nachtragen
-- (04.11.2026) fallen in Phase 3 weg. NULL statt leerem Text, weil ein leerer Text in jedem Vergleich und jedem Prompt still
-- mitliefe, während NULL in SQL nichts trifft. Die Schranke steht in der Datenbank, nicht im Code: Eine leere Zeile kann nicht
-- freigegeben werden, und jeder Leser mit `approved = TRUE` sieht sie damit nie.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

ALTER TABLE glossary_entries ALTER COLUMN target_term DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'glossary_entries_leer_nie_freigegeben') THEN
    -- IS FALSE und nicht = FALSE: `approved` darf NULL sein, und bei NULL ließe ein CHECK die Zeile durch.
    ALTER TABLE glossary_entries ADD CONSTRAINT glossary_entries_leer_nie_freigegeben
      CHECK (target_term IS NOT NULL OR approved IS FALSE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'glossary_entries_kein_leerer_text') THEN
    ALTER TABLE glossary_entries ADD CONSTRAINT glossary_entries_kein_leerer_text
      CHECK (target_term IS NULL OR btrim(target_term) <> '');
  END IF;
END $$;

-- Gleicher Begriff heißt: gleicher Schlüssel lower(btrim(source_term)).
-- Ein Unique-Index über alle Zeilen geht nicht, der Bestand enthält Dubletten, die Menschen klären.
-- Für leere Zeilen geht er: Je Glossar und Begriff gibt es höchstens eine.
CREATE INDEX IF NOT EXISTS idx_glossary_entries_begriff
  ON glossary_entries (lower(btrim(source_term)), glossary_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_glossary_entries_zu_pflegen
  ON glossary_entries (glossary_id, lower(btrim(source_term)))
  WHERE target_term IS NULL;

-- Eine gefüllte Zeile ersetzt die leere, egal welcher Weg anlegt: Neben einer gefüllten Zeile bleibt
-- keine leere stehen. Zwei gefüllte Zeilen verhindert das nicht, das regeln die Schreibwege.
--
-- 🧭 Bleibt dauerhaft, obwohl das Nachtragen weg ist: Leere Zeilen sind weiter ein gültiger Zustand, und Plus, Quickadd, Review,
-- Terminologie-Scan und CSV-Import treffen auf sie. Ohne diesen Trigger stünde danach die leere Zeile neben der neuen, und
-- jeder dieser fünf Wege müsste sie selbst wegräumen.
CREATE OR REPLACE FUNCTION glossar_leere_zeile_ersetzen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_term IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(711027);
    DELETE FROM glossary_entries
     WHERE glossary_id = NEW.glossary_id
       AND target_term IS NULL
       AND lower(btrim(source_term)) = lower(btrim(NEW.source_term));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS glossar_leere_zeile_ersetzen ON glossary_entries;
CREATE TRIGGER glossar_leere_zeile_ersetzen
  BEFORE INSERT ON glossary_entries
  FOR EACH ROW EXECUTE FUNCTION glossar_leere_zeile_ersetzen();
