-- Phase 14: LanguageTool Quelltext-Optimierung
-- Bei aktiviertem Flag wird vor der DeepL-Uebersetzung ein LT-Check pro
-- Segment durchgefuehrt; nur "high confidence" Korrekturen (Tippfehler,
-- Typografie, Interpunktion) werden silent angewandt. Die Aenderungen werden
-- pro Segment protokolliert, damit der Anwender im Review nachvollziehen kann
-- welche Korrekturen vor DeepL passiert sind.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS optimize_source BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE segments
  ADD COLUMN IF NOT EXISTS source_text_original TEXT,
  ADD COLUMN IF NOT EXISTS lt_corrections JSONB;

CREATE INDEX IF NOT EXISTS idx_segments_lt_corrections
  ON segments(id) WHERE lt_corrections IS NOT NULL;
