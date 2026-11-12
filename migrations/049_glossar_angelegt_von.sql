-- Wer einen Glossareintrag angelegt hat: eine Person über die Anwendung, oder niemand (Seed, Migration, Skript).
--
-- Plan `PLAN-oeffentlich-und-demo.md` Phase 2, Entscheid Thomas E4 (12.11.2026): Bei `GLOSSAR_FREIGABE=alle` löschen Nicht-Admins
-- nur Einträge, die eine Person angelegt hat; das Beispiel-Glossar aus dem Seed bleibt stehen (`middleware/glossar-recht.ts`).
--
-- Gesetzt wird die Spalte allein vom Trigger, aus dem Bearbeiter der Transaktion (`alsBearbeiter` → `wortliste.von_id`, Migration
-- 037). Einen mitgeschickten Wert überschreibt er, die Spalte lässt sich also nicht vortäuschen. Wer ohne Bearbeiter schreibt — ein
-- Seed per psql, eine Migration, ein Skript —, hinterlässt NULL, und der Eintrag gilt als geschützt. Fehlt etwas, schließt es.
-- Bestehende Zeilen bleiben NULL: In der Produktion (`GLOSSAR_FREIGABE=admin`) löschen ohnehin nur Admins.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

ALTER TABLE glossary_entries ADD COLUMN IF NOT EXISTS angelegt_von UUID;

COMMENT ON COLUMN glossary_entries.angelegt_von IS
  'users.id der Person, die den Eintrag über die Anwendung angelegt hat; NULL = Seed, Migration oder Skript (geschützt bei GLOSSAR_FREIGABE=alle). Setzt nur der Trigger.';

CREATE OR REPLACE FUNCTION eintrag_angelegt_von() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.angelegt_von := wortliste_von_id();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_glossary_entries_angelegt_von ON glossary_entries;
CREATE TRIGGER trg_glossary_entries_angelegt_von
  BEFORE INSERT ON glossary_entries
  FOR EACH ROW EXECUTE FUNCTION eintrag_angelegt_von();
