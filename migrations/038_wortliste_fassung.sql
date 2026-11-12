-- Wortliste Phase 3: Fassung je Sprache aus der Datenbank, Schlüssel je Schreibung, Umzug der Namensbausteine.
--
-- Plan `PLAN-wortliste.md` §2.1, §2.5, §3 Phase 3 und §4 (Cockpit #1831).
--
-- 🚨 DIE FASSUNG ZÄHLT DIE DATENBANK, wie seit Migration 033 für die Bausteintabelle. Jede Transaktion, die ändert, was
-- `bildeName` aus der Wortliste einer Sprache sieht (`wortliste_freigegeben`), erhöht deren Fassung genau einmal, gleich auf welchem
-- Weg: Freigabe, Begriff, Ziel, `ziel_name`, Art, Wortart, Genus, Formen, Merkmalsklasse, Channel-Wert, Gruppenziel, Löschen.
-- Nicht: `an_deepl`, Kontext, Kategorie, Quelle, offene Zeilen. Die Nummern laufen in `namens_bausteine_fassung` weiter (EN stand
-- am 10.11.2026 bei 3). Auch die Fließtext-Pflege zählt: Ein geändertes Glossarwort ändert die Namen (Entscheid Thomas 10.11.2026).
--
-- 🚨 UMZUG JE SPRACHE. `namens_bausteine` und `namens_bausteine_vorlaeufig` werden für eine Sprache gesperrt, sobald das Werkzeug
-- `src/scripts/wortliste-zusammenfuehren.ts` sie zusammengeführt hat (`wortliste_umzug`). Wer danach dort noch schreibt, scheitert
-- laut. Sprachen ohne Umzug bleiben beschreibbar, damit das Einlesen der übrigen Prüftabellen (#1810) bis Phase 6 weiterläuft; ein
-- späterer Lauf des Werkzeugs nimmt sie mit.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

-- ── Schlüssel je exakter Schreibung (Plan §2.1) ────────────────────────────────────────────────────────────────────────
-- Nicht `lower()`: `COVER` (Blockschrift) neben `Cover` ist gewollt. Führt der Bestand eine exakte Dublette (am 10.11.2026: 2, HU und
-- IT, je gleiches Ziel), entsteht der Index nicht und es gibt eine Warnung statt eines Abbruchs wie in Migration 032; das Werkzeug legt
-- sie zusammen, der nächste Deploy legt den Index an.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM glossary_entries GROUP BY glossary_id, btrim(source_term) HAVING count(*) > 1) THEN
    RAISE WARNING 'Wortliste: Ein Glossar führt einen Begriff in gleicher Schreibung mehrfach, uq_glossary_entries_schreibung wird nicht angelegt';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_glossary_entries_schreibung ON glossary_entries (glossary_id, btrim(source_term));
  END IF;
END $$;

-- ── Fassung ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Die Sprache eines Glossars, wenn es eine Wortliste für Artikelnamen ist (DE→ eine der acht Sprachen), sonst NULL.
CREATE OR REPLACE FUNCTION wortliste_sprache(p_glossary UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT target_lang FROM glossaries
   WHERE id = p_glossary AND source_lang = 'DE' AND target_lang IN ('EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ')
$$;

CREATE OR REPLACE FUNCTION wortliste_fassung_eintrag() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s TEXT;
  zaehlt BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.approved IS TRUE AND OLD.target_term IS NOT NULL THEN
      s := wortliste_sprache(OLD.glossary_id);
      IF s IS NOT NULL THEN
        PERFORM namens_fassung_der_transaktion(s, wortliste_von());
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  s := wortliste_sprache(NEW.glossary_id);
  IF TG_OP = 'INSERT' THEN
    zaehlt := NEW.approved IS TRUE AND NEW.target_term IS NOT NULL;
  ELSE
    zaehlt := ((OLD.approved IS TRUE AND OLD.target_term IS NOT NULL) OR (NEW.approved IS TRUE AND NEW.target_term IS NOT NULL))
      AND (NEW.approved, NEW.target_term, NEW.source_term, NEW.art, NEW.wortart, NEW.genus, NEW.formen, NEW.merkmalsklasse,
           NEW.ziel_name, NEW.glossary_id)
          IS DISTINCT FROM
          (OLD.approved, OLD.target_term, OLD.source_term, OLD.art, OLD.wortart, OLD.genus, OLD.formen, OLD.merkmalsklasse,
           OLD.ziel_name, OLD.glossary_id);
  END IF;
  IF zaehlt AND s IS NOT NULL THEN
    NEW.namensfassung := namens_fassung_der_transaktion(s, wortliste_von());
  ELSIF TG_OP = 'UPDATE' THEN
    -- Die Fassung setzt nur dieser Trigger, nie ein Schreibweg.
    NEW.namensfassung := OLD.namensfassung;
  ELSE
    NEW.namensfassung := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Name mit „fassung“ vor „verlauf“: Beim Löschen laufen beide BEFORE-Trigger in Namensfolge, die Fassung muss zuerst stehen, damit der
-- Verlauf sie findet.
DROP TRIGGER IF EXISTS trg_wortliste_fassung_eintrag ON glossary_entries;
CREATE TRIGGER trg_wortliste_fassung_eintrag
  BEFORE INSERT OR UPDATE OR DELETE ON glossary_entries
  FOR EACH ROW EXECUTE FUNCTION wortliste_fassung_eintrag();

-- Channel-Werte und Gruppenziele zählen, wenn ihre Zeile freigegeben ist. Fällt die Zeile selbst weg, hat sie schon gezählt.
CREATE OR REPLACE FUNCTION wortliste_fassung_neben() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e RECORD;
  s TEXT;
  zaehlt BOOLEAN := TG_OP <> 'UPDATE';
BEGIN
  SELECT glossary_id, approved, target_term INTO e FROM glossary_entries WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
  IF FOUND AND e.approved IS TRUE AND e.target_term IS NOT NULL THEN
    IF TG_OP = 'UPDATE' THEN
      zaehlt := NEW.target_term IS DISTINCT FROM OLD.target_term;
      -- Getrennt, nicht mit AND: PL/pgSQL plant den ganzen Ausdruck, und die Channel-Tabelle hat kein Genus.
      IF TG_TABLE_NAME = 'glossary_entry_gruppen' THEN
        zaehlt := zaehlt OR (NEW.genus, NEW.formen) IS DISTINCT FROM (OLD.genus, OLD.formen) OR NEW.produktgruppe <> OLD.produktgruppe;
      ELSE
        zaehlt := zaehlt OR NEW.channel_code <> OLD.channel_code;
      END IF;
    END IF;
    IF zaehlt THEN
      s := wortliste_sprache(e.glossary_id);
      IF s IS NOT NULL THEN
        PERFORM namens_fassung_der_transaktion(s, wortliste_von());
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wortliste_fassung_channel ON glossary_entry_channels;
CREATE TRIGGER trg_wortliste_fassung_channel
  BEFORE INSERT OR UPDATE OR DELETE ON glossary_entry_channels
  FOR EACH ROW EXECUTE FUNCTION wortliste_fassung_neben();

DROP TRIGGER IF EXISTS trg_wortliste_fassung_gruppe ON glossary_entry_gruppen;
CREATE TRIGGER trg_wortliste_fassung_gruppe
  BEFORE INSERT OR UPDATE OR DELETE ON glossary_entry_gruppen
  FOR EACH ROW EXECUTE FUNCTION wortliste_fassung_neben();

-- ── Umzug der Namensbausteine ──────────────────────────────────────────────────────────────────────────────────────────────
-- Je Sprache eine Zeile, sobald das Werkzeug sie zusammengeführt hat. Danach ist die alte Tabelle für diese Sprache gesperrt.
CREATE TABLE IF NOT EXISTS wortliste_umzug (
  sprache    TEXT PRIMARY KEY CHECK (sprache IN ('EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ')),
  bausteine  INTEGER NOT NULL CHECK (bausteine >= 0),
  vorlaeufig INTEGER NOT NULL CHECK (vorlaeufig >= 0),
  von        TEXT NOT NULL CHECK (btrim(von) <> ''),
  am         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE wortliste_umzug IS
  'Sprachen, deren Namensbausteine ins Glossar umgezogen sind (Plan Wortliste Phase 3). Für sie nimmt namens_bausteine nichts mehr an.';

-- Woher eine Zeile der Wortliste kam: alter Baustein oder Vorschlag. Die alten Tabellen bleiben bis Phase 7 stehen.
CREATE TABLE IF NOT EXISTS wortliste_herkunft (
  entry_id      UUID NOT NULL,
  baustein_id   UUID,
  vorlaeufig_id UUID,
  sprache       TEXT NOT NULL,
  wie           TEXT NOT NULL CHECK (wie IN ('gleich', 'entschieden', 'neu', 'gruppe', 'vorschlag', 'abgelehnt')),
  am            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (baustein_id IS NOT NULL OR vorlaeufig_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_wortliste_herkunft_entry ON wortliste_herkunft (entry_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wortliste_herkunft_baustein ON wortliste_herkunft (baustein_id) WHERE baustein_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wortliste_herkunft_vorlaeufig ON wortliste_herkunft (vorlaeufig_id) WHERE vorlaeufig_id IS NOT NULL;

ALTER TABLE namens_einlesen_protokoll ADD COLUMN IF NOT EXISTS entry_id UUID;
COMMENT ON COLUMN namens_einlesen_protokoll.entry_id IS 'Zeile der Wortliste, in die der Baustein dieses Paars umgezogen ist (Phase 3).';

CREATE OR REPLACE FUNCTION namens_bausteine_umgezogen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s TEXT := COALESCE(NEW.sprache, OLD.sprache);
BEGIN
  IF EXISTS (SELECT 1 FROM wortliste_umzug WHERE sprache = s) THEN
    RAISE EXCEPTION 'Die Namensbausteine % sind ins Glossar umgezogen (Plan PLAN-wortliste.md Phase 3); % nimmt für diese Sprache nichts mehr an',
      s, TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_namens_bausteine_umgezogen ON namens_bausteine;
CREATE TRIGGER trg_namens_bausteine_umgezogen
  BEFORE INSERT OR UPDATE OR DELETE ON namens_bausteine
  FOR EACH ROW EXECUTE FUNCTION namens_bausteine_umgezogen();

DROP TRIGGER IF EXISTS trg_namens_bausteine_vorlaeufig_umgezogen ON namens_bausteine_vorlaeufig;
CREATE TRIGGER trg_namens_bausteine_vorlaeufig_umgezogen
  BEFORE INSERT OR UPDATE OR DELETE ON namens_bausteine_vorlaeufig
  FOR EACH ROW EXECUTE FUNCTION namens_bausteine_umgezogen();
