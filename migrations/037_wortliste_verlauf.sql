-- Der Verlauf der Wortliste schreibt die Datenbank, nicht der Schreibweg.
--
-- Plan `PLAN-wortliste.md` §2.6 und Phase 2 (Cockpit #1830), Entscheid Thomas 10.11.2026: Freigeben darf jeder Angemeldete, Pflicht ist
-- der Vermerk, wer was wann geändert hat. Bis hierher schrieb jeder Weg seinen Verlauf selbst (`recordHistory` in `routes/glossaries.ts`,
-- händische Einträge in drei Diensten). Gemessen 10.11.2026: Review-Quickadd und Terminologie-Scan legten Zeilen ganz ohne Verlauf an,
-- und für Kontext, Kategorie und Freigabe einer Einzelzeile gab es keinen.
--
-- 🚨 WER: Jeder Schreibweg nennt sich in seiner Transaktion:
--     SELECT set_config('wortliste.von_id', '<users.id oder leer>', true), set_config('wortliste.von', '<Name>', true)
-- (`src/db/bearbeiter.ts`). Fehlt der Name, steht `unbekannt` im Verlauf, nie nichts; das trifft auch einen Griff mit `psql`.
--
-- 🚨 EINE ZEILE JE GEÄNDERTEM FELD wie bisher (`field`): `standard` (Ziel), Channel-Code, `gruppe:<n>`, `begriff`, `freigabe`,
-- `an_deepl`, `art`, `wortart`, `genus`, `formen`, `merkmal`, `ziel_name`, `kontext`, `kategorie`. Beim Löschen einer Zeile schreibt der
-- Trigger VOR dem Löschen, denn danach sind ihre Channel-Werte und Gruppenziele schon per Kaskade weg und nicht mehr lesbar.
--
-- Die Spalte `fassung` füllt erst Phase 3 (Fassung je Sprache für Namen).
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

ALTER TABLE glossary_entry_history ADD COLUMN IF NOT EXISTS fassung INTEGER;
COMMENT ON COLUMN glossary_entry_history.fassung IS
  'Fassung der Sprache für Artikelnamen (namens_bausteine_fassung), wenn die Änderung Namen betrifft. Ab Phase 3 der Wortliste.';

CREATE OR REPLACE FUNCTION wortliste_von_id() RETURNS UUID
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v TEXT := NULLIF(btrim(current_setting('wortliste.von_id', true)), '');
BEGIN
  IF v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN v::uuid;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION wortliste_von() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(btrim(current_setting('wortliste.von', true)), ''), 'unbekannt')
$$;

-- `fassung`: die Fassung der Sprache, die diese Transaktion für Namen gezogen hat (Migration 038 zählt sie), sonst NULL. Sie steht
-- an jedem Eintrag der Transaktion, auch an einem Feld, das für Namen nicht zählt (Kontext neben einem neuen Ziel).
CREATE OR REPLACE FUNCTION wortliste_verlauf_schreiben(
  p_entry UUID, p_glossary UUID, p_begriff TEXT, p_feld TEXT, p_aktion TEXT, p_alt TEXT, p_neu TEXT
) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO glossary_entry_history
         (entry_id, glossary_id, source_term, field, action, old_value, new_value, changed_by, changed_by_name, fassung)
  VALUES (p_entry, p_glossary, p_begriff, p_feld, p_aktion, p_alt, p_neu, wortliste_von_id(), wortliste_von(),
          (SELECT f.nummer FROM namens_bausteine_fassung f
            WHERE f.txid = txid_current() AND f.sprache = (SELECT g.target_lang FROM glossaries g WHERE g.id = p_glossary)))
$$;

-- Ein Feld als Text für den Verlauf. NULL bleibt NULL.
CREATE OR REPLACE FUNCTION wortliste_freigabe_text(b BOOLEAN) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN b THEN 'freigegeben' ELSE 'offen' END $$;
CREATE OR REPLACE FUNCTION wortliste_ja_nein(b BOOLEAN) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN b THEN 'ja' ELSE 'nein' END $$;

CREATE OR REPLACE FUNCTION wortliste_verlauf_eintrag() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  k RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'standard', 'created', NULL, NEW.target_term);
    IF NEW.approved IS NOT TRUE THEN
      PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'freigabe', 'created', NULL, 'offen');
    END IF;
    IF NEW.art <> 'wort' THEN
      PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'art', 'created', NULL, NEW.art);
    END IF;
    IF NEW.an_deepl IS NOT TRUE THEN
      PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'an_deepl', 'created', NULL, 'nein');
    END IF;
    IF NEW.ziel_name IS NOT NULL THEN
      PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'ziel_name', 'created', NULL, NEW.ziel_name);
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM wortliste_verlauf_schreiben(OLD.id, OLD.glossary_id, OLD.source_term, 'standard', 'deleted', OLD.target_term, NULL);
    FOR k IN SELECT channel_code, target_term FROM glossary_entry_channels WHERE entry_id = OLD.id ORDER BY channel_code LOOP
      PERFORM wortliste_verlauf_schreiben(OLD.id, OLD.glossary_id, OLD.source_term, k.channel_code, 'deleted', k.target_term, NULL);
    END LOOP;
    FOR k IN SELECT produktgruppe, target_term FROM glossary_entry_gruppen WHERE entry_id = OLD.id ORDER BY produktgruppe LOOP
      PERFORM wortliste_verlauf_schreiben(OLD.id, OLD.glossary_id, OLD.source_term, 'gruppe:' || k.produktgruppe, 'deleted', k.target_term, NULL);
    END LOOP;
    RETURN OLD;
  END IF;

  -- UPDATE: je geändertem Feld eine Zeile; der Begriff zuerst, damit die folgenden Zeilen schon den neuen tragen.
  IF NEW.source_term IS DISTINCT FROM OLD.source_term THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'begriff', 'updated', OLD.source_term, NEW.source_term);
  END IF;
  IF NEW.target_term IS DISTINCT FROM OLD.target_term THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'standard', 'updated', OLD.target_term, NEW.target_term);
  END IF;
  IF NEW.approved IS DISTINCT FROM OLD.approved THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'freigabe', 'updated',
      wortliste_freigabe_text(OLD.approved), wortliste_freigabe_text(NEW.approved));
  END IF;
  IF NEW.an_deepl IS DISTINCT FROM OLD.an_deepl THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'an_deepl', 'updated',
      wortliste_ja_nein(OLD.an_deepl), wortliste_ja_nein(NEW.an_deepl));
  END IF;
  IF NEW.art IS DISTINCT FROM OLD.art THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'art', 'updated', OLD.art, NEW.art);
  END IF;
  IF NEW.wortart IS DISTINCT FROM OLD.wortart THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'wortart', 'updated', OLD.wortart, NEW.wortart);
  END IF;
  IF NEW.genus IS DISTINCT FROM OLD.genus THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'genus', 'updated', OLD.genus, NEW.genus);
  END IF;
  IF NEW.formen IS DISTINCT FROM OLD.formen THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'formen', 'updated', OLD.formen::text, NEW.formen::text);
  END IF;
  IF NEW.merkmalsklasse IS DISTINCT FROM OLD.merkmalsklasse THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'merkmal', 'updated', OLD.merkmalsklasse, NEW.merkmalsklasse);
  END IF;
  IF NEW.ziel_name IS DISTINCT FROM OLD.ziel_name THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'ziel_name', 'updated', OLD.ziel_name, NEW.ziel_name);
  END IF;
  IF NEW.context IS DISTINCT FROM OLD.context THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'kontext', 'updated', OLD.context, NEW.context);
  END IF;
  IF NEW.category IS DISTINCT FROM OLD.category THEN
    PERFORM wortliste_verlauf_schreiben(NEW.id, NEW.glossary_id, NEW.source_term, 'kategorie', 'updated', OLD.category, NEW.category);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_wortliste_verlauf_eintrag ON glossary_entries;
CREATE TRIGGER trg_wortliste_verlauf_eintrag
  AFTER INSERT OR UPDATE ON glossary_entries
  FOR EACH ROW EXECUTE FUNCTION wortliste_verlauf_eintrag();

DROP TRIGGER IF EXISTS trg_wortliste_verlauf_eintrag_weg ON glossary_entries;
CREATE TRIGGER trg_wortliste_verlauf_eintrag_weg
  BEFORE DELETE ON glossary_entries
  FOR EACH ROW EXECUTE FUNCTION wortliste_verlauf_eintrag();

-- Channel-Werte und Gruppenziele. Fällt die Zeile selbst weg, hat der Trigger oben sie schon vermerkt; die Kaskade findet die Zeile
-- dann nicht mehr und schreibt nichts doppelt.
CREATE OR REPLACE FUNCTION wortliste_verlauf_neben() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e RECORD;
  feld TEXT;
  alt TEXT;
  neu TEXT;
BEGIN
  SELECT id, glossary_id, source_term INTO e
    FROM glossary_entries WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'glossary_entry_channels' THEN
    feld := COALESCE(NEW.channel_code, OLD.channel_code);
  ELSE
    feld := 'gruppe:' || COALESCE(NEW.produktgruppe, OLD.produktgruppe);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    alt := OLD.target_term;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    neu := NEW.target_term;
  END IF;
  IF TG_TABLE_NAME = 'glossary_entry_gruppen' THEN
    -- Genus und Formen gehören zum Gruppenziel; ändern sie sich, steht das im Wert.
    IF TG_OP <> 'INSERT' AND (OLD.genus IS NOT NULL OR OLD.formen IS NOT NULL) THEN
      alt := alt || ' [' || concat_ws(' ', OLD.genus, OLD.formen::text) || ']';
    END IF;
    IF TG_OP <> 'DELETE' AND (NEW.genus IS NOT NULL OR NEW.formen IS NOT NULL) THEN
      neu := neu || ' [' || concat_ws(' ', NEW.genus, NEW.formen::text) || ']';
    END IF;
  END IF;
  IF alt IS NOT DISTINCT FROM neu THEN
    RETURN NULL;
  END IF;
  PERFORM wortliste_verlauf_schreiben(e.id, e.glossary_id, e.source_term, feld,
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'DELETE' THEN 'deleted' ELSE 'updated' END, alt, neu);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_wortliste_verlauf_channel ON glossary_entry_channels;
CREATE TRIGGER trg_wortliste_verlauf_channel
  AFTER INSERT OR UPDATE OR DELETE ON glossary_entry_channels
  FOR EACH ROW EXECUTE FUNCTION wortliste_verlauf_neben();

DROP TRIGGER IF EXISTS trg_wortliste_verlauf_gruppe ON glossary_entry_gruppen;
CREATE TRIGGER trg_wortliste_verlauf_gruppe
  AFTER INSERT OR UPDATE OR DELETE ON glossary_entry_gruppen
  FOR EACH ROW EXECUTE FUNCTION wortliste_verlauf_neben();
