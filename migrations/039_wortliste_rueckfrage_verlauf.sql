-- Wortliste Phase 5 (PLAN-wortliste.md §2.6, §2.7, Cockpit #1833): Rückfrage mit Namen im Verlauf.
--
-- Die Rückfrage steht in `wortliste_vorschlag` (Migration 036), die Verlaufs-Trigger aus 037 sitzen auf `glossary_entries`,
-- `glossary_entry_channels` und `glossary_entry_gruppen`. Ohne diesen Trigger stünde „Rückfrage gestellt“ in keinem Verlauf.
-- Feld `rueckfrage`, alt und neu als Text, Bearbeiter wie überall aus `wortliste.von` (sonst „unbekannt“).
-- Zählt nicht für die Namensfassung: Eine Rückfrage ändert keinen Namen.

CREATE OR REPLACE FUNCTION wortliste_verlauf_rueckfrage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e RECORD;
  alt TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    alt := OLD.rueckfrage;
  END IF;
  IF NEW.rueckfrage IS NOT DISTINCT FROM alt THEN
    RETURN NEW;
  END IF;
  SELECT id, glossary_id, source_term INTO e FROM glossary_entries WHERE id = NEW.entry_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  PERFORM wortliste_verlauf_schreiben(e.id, e.glossary_id, e.source_term, 'rueckfrage',
    CASE WHEN alt IS NULL THEN 'created' WHEN NEW.rueckfrage IS NULL THEN 'deleted' ELSE 'updated' END,
    alt, NEW.rueckfrage);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wortliste_verlauf_rueckfrage ON wortliste_vorschlag;
CREATE TRIGGER trg_wortliste_verlauf_rueckfrage
  AFTER INSERT OR UPDATE OF rueckfrage ON wortliste_vorschlag
  FOR EACH ROW EXECUTE FUNCTION wortliste_verlauf_rueckfrage();
