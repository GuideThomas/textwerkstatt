-- Phase 12: Sales-Channel-Glossare
-- Pro Glossar-Eintrag koennen abweichende Zielbegriffe je Verkaufschannel hinterlegt
-- werden (z. B. SHOP-A, SHOP-B, B2C). Bei Projekt-Upload kann ein Channel ausgewaehlt
-- werden — die Channel-Begriffe werden via Pre-/Post-Replacement vor/nach DeepL
-- angewandt. Das DeepL-Glossar selbst bleibt der Standard-Glossar (1 Glossar pro
-- Sprachpaar), die Channel-Logik ist rein clientseitig.

-- 1) Channels Lookup-Tabelle
CREATE TABLE IF NOT EXISTS channels (
  code VARCHAR(20) PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Die Channels selbst sind Sache der Installation: `seeds/<name>/` (seit 12.11.2026).

-- 2) Channel-Overrides pro Glossar-Eintrag
-- Wenn fuer einen Eintrag fuer einen Channel KEIN Override existiert,
-- wird auf das standard target_term aus glossary_entries zurueckgegriffen.
CREATE TABLE IF NOT EXISTS glossary_entry_channels (
  entry_id UUID NOT NULL REFERENCES glossary_entries(id) ON DELETE CASCADE,
  channel_code VARCHAR(20) NOT NULL REFERENCES channels(code) ON DELETE CASCADE,
  target_term TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (entry_id, channel_code)
);

CREATE INDEX IF NOT EXISTS idx_gec_channel ON glossary_entry_channels(channel_code);
CREATE INDEX IF NOT EXISTS idx_gec_entry ON glossary_entry_channels(entry_id);

-- 3) Projekt-Channel-Zuordnung (NULL = Standard der Organisation)
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS channel_code VARCHAR(20) REFERENCES channels(code) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_channel
  ON projects(channel_code) WHERE channel_code IS NOT NULL;

-- 4) Segment-Cache muss channel-aware werden, weil Pre-Replacement zu DeepL andere
--    Uebersetzungen produziert. NULL = Standard, sonst der jeweilige Channel-Code.
ALTER TABLE segments
  ADD COLUMN IF NOT EXISTS channel_code VARCHAR(20);

-- Alte UNIQUE constraint loeschen (Auto-Name aus 001) und durch channel-aware Index ersetzen.
-- Verwendet COALESCE-Ausdruck damit NULL als '__std__' behandelt wird (Postgres-NULL-Eigenheit).
ALTER TABLE segments DROP CONSTRAINT IF EXISTS segments_segment_hash_source_lang_target_lang_key;

-- ⚠️ Nur anlegen, solange kein WEITERER Schlüssel existiert (012 v2, 021 v3, 051 v4). Alle Migrationen laufen bei jedem Start
-- neu: Ohne diese Bedingung entstand dieser engste Index bei jedem Deploy wieder, und sobald zwei Zeilen sich nur in einer
-- späteren Dimension unterscheiden (neutral, Anrede, Besitzer), scheitert er an ihnen — der Migrationslauf bricht ab und der
-- Dienst startet nicht (gefunden 13.11.2026; in der Produktion gab es bis dahin zufällig keine solche Zeile).
DO $$
BEGIN
  IF to_regclass('uniq_segments_hash_lang_channel_v2') IS NULL
     AND to_regclass('uniq_segments_hash_lang_channel_v3') IS NULL
     AND to_regclass('uniq_segments_hash_lang_channel_v4') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_segments_hash_lang_channel
      ON segments (segment_hash, source_lang, target_lang, COALESCE(channel_code, '__std__'));
  END IF;
END $$;

-- Bestehender exakt-Hash Index ergaenzt um channel_code (alter Index bleibt fuer Abwaerts-Lookup)
CREATE INDEX IF NOT EXISTS idx_segments_hash_channel
  ON segments(segment_hash, source_lang, target_lang, channel_code);

CREATE INDEX IF NOT EXISTS idx_segments_normalized_channel
  ON segments(normalized_hash, source_lang, target_lang, channel_code)
  WHERE normalized_hash IS NOT NULL;
