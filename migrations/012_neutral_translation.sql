-- Phase 13: Neutral-Modus (ohne Glossar)
-- Erlaubt Übersetzungen ohne Berücksichtigung des Standard-Glossars und der
-- Channel-Overrides. Wird sowohl bei Schnellübersetzung als auch bei Dokument-
-- Uploads verwendet, wenn der Anwender bewusst eine "rohe" DeepL-Übersetzung
-- möchte (z. B. zum Vergleich oder für sprachlich freie Texte).
--
-- Cache-Auswirkung: Neutral-Übersetzungen müssen vom glossar-aware Cache
-- getrennt sein, damit eine neutrale Übersetzung nicht später als Cache-Hit
-- für eine glossar-aware Anfrage zurückgespielt wird (und umgekehrt).

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS glossary_disabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE segments
  ADD COLUMN IF NOT EXISTS glossary_disabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Unique-Index aus 010_sales_channels.sql ersetzen: jetzt auch glossary_disabled
-- als Schlüsselbestandteil, sonst kollidieren Neutral- und Standard-Einträge.
DROP INDEX IF EXISTS uniq_segments_hash_lang_channel;

-- ⚠️ Nur anlegen, solange kein weiterer Schlüssel existiert (021 v3, 051 v4) — Begründung in 010_sales_channels.sql.
DO $$
BEGIN
  IF to_regclass('uniq_segments_hash_lang_channel_v3') IS NULL
     AND to_regclass('uniq_segments_hash_lang_channel_v4') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_segments_hash_lang_channel_v2
      ON segments (
        segment_hash,
        source_lang,
        target_lang,
        COALESCE(channel_code, '__std__'),
        glossary_disabled
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_segments_neutral
  ON segments(segment_hash, source_lang, target_lang)
  WHERE glossary_disabled = TRUE;
