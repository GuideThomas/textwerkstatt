-- Das Glossar führt nur noch gewollte Abweichungen (Entscheid Thomas 04.11.2026, `PLAN-glossar-nur-abweichungen.md`, Phase 2).
--
-- Entfernt im Bestand, was einen Begriff bei jeder Änderung in alle Glossare DE→X nachgetragen hat. Migration 027 legt es
-- seit dem 05.11.2026 nicht mehr an, sonst käme es bei jedem Deploy vor dieser Datei zurück. Sie ändert keine Zeile: Die
-- vorhandenen leeren Zeilen der acht Glossare löscht erst Phase 3.
--
-- 🧭 Bleibt, auf Wunsch von Thomas (05.11.2026), das einmalige Befüllen beim Anlegen, jetzt mit einer Schwelle: Ein neues
-- Glossar DE→X bekommt als leere Zeilen die Begriffe, die in mindestens der Hälfte der bestehenden Glossare DE→X (ohne DE→DE,
-- ohne das neue) eine gefüllte Zeile haben, aufgerundet: bei 8 Glossaren ab 4, bei 3 ab 2, bei 1 ab 1. Je Begriff zählt ein
-- Glossar einmal, auch bei einer Dublette dort. Gibt es kein anderes Glossar, entsteht nichts. Was später in anderen Glossaren
-- dazukommt, trägt nichts nach. Weil es als Trigger auf `glossaries` sitzt, kommt kein Schreibweg daran vorbei, auch nicht der
-- Import oder der Terminologie-Scan. Die Zeilen wirken nicht und entwerten nichts: `approved = FALSE`, und ohne Freigabe gehen
-- sie nie an DeepL.
--
-- ⚠️ Rückweg: Diese Datei muss zusammen mit der alten 027 zurückgenommen werden. Bliebe sie liegen, entfernte sie die
-- Trigger der wiederhergestellten 027 sofort wieder.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

DROP TRIGGER IF EXISTS glossar_begriff_nachtragen ON glossary_entries;
DROP TRIGGER IF EXISTS glossar_begriff_umbenannt ON glossary_entries;
DROP FUNCTION IF EXISTS glossar_begriff_nachtragen();

-- Ein Begriff erhält die häufigste Schreibweise seiner gefüllten Zeilen.
CREATE OR REPLACE FUNCTION glossar_neu_befuellen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Der Anteil der bestehenden Glossare, in denen ein Begriff stehen muss. Nur hier festgelegt.
  mindestanteil CONSTANT NUMERIC := 0.5;
  andere INT;
  schwelle INT;
BEGIN
  IF NEW.source_lang = 'DE' AND NEW.target_lang <> 'DE' THEN
    PERFORM pg_advisory_xact_lock(711027);

    SELECT count(*) INTO andere
      FROM glossaries WHERE source_lang = 'DE' AND target_lang <> 'DE' AND id <> NEW.id;
    IF andere = 0 THEN
      RETURN NULL;
    END IF;
    schwelle := ceil(andere * mindestanteil)::INT;

    WITH gefuellt AS (
      SELECT lower(btrim(e.source_term)) AS schluessel, btrim(e.source_term) AS begriff, e.glossary_id
        FROM glossary_entries e
        JOIN glossaries g ON g.id = e.glossary_id
       WHERE g.source_lang = 'DE' AND g.target_lang <> 'DE' AND g.id <> NEW.id
         AND e.target_term IS NOT NULL AND btrim(e.source_term) <> ''
    ), genug AS (
      SELECT schluessel
        FROM gefuellt
       GROUP BY schluessel
      HAVING count(DISTINCT glossary_id) >= schwelle
    ), schreibweisen AS (
      SELECT g.schluessel, g.begriff, count(*) AS n
        FROM gefuellt g
        JOIN genug USING (schluessel)
       GROUP BY g.schluessel, g.begriff
    )
    INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, source)
    SELECT DISTINCT ON (schluessel) NEW.id, begriff, NULL, FALSE, 'nachtrag'
      FROM schreibweisen
     ORDER BY schluessel, n DESC, begriff;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS glossar_neu_befuellen ON glossaries;
CREATE TRIGGER glossar_neu_befuellen
  AFTER INSERT ON glossaries
  FOR EACH ROW EXECUTE FUNCTION glossar_neu_befuellen();

-- Erst hier: Bis zur Zeile oben rief die alte `glossar_neu_befuellen` noch diese Funktion.
DROP FUNCTION IF EXISTS glossar_abgleich(TEXT);
