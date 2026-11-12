-- Phase 17 (22.05.2026): Target-Post-Processing Audit-Trail
--
-- Zwei neue Pipeline-Schritte rund um DeepL:
--   A) LanguageTool-Target-Pass: korrigiert Mid-Sentence-Grossschreibung,
--      die DeepL faelschlicherweise aus dem DE beibehaelt
--      (`Avec Design moderne` → `avec design moderne`).
--   B) Akronym-Pre-Pass: Glossar-Begriffe wie `CRI → IRC` greifen auch dann,
--      wenn der Source eine angehaengte Zahl hat (`CRI90 → IRC90`).
--
-- Beide Schritte werden pro Segment audit-gelogged, damit im Review
-- nachvollziehbar ist welche Korrekturen automatisch passiert sind.

ALTER TABLE segments
  ADD COLUMN IF NOT EXISTS lt_target_corrections JSONB,
  ADD COLUMN IF NOT EXISTS tech_term_substitutions JSONB;

CREATE INDEX IF NOT EXISTS idx_segments_lt_target_corrections
  ON segments(id) WHERE lt_target_corrections IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_segments_tech_term_substitutions
  ON segments(id) WHERE tech_term_substitutions IS NOT NULL;

-- Projekt-Defaults: beide Schritte standardmaessig aktiv fuer neue Projekte.
-- Frontend kann pro Projekt opt-out.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS optimize_target_casing BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS protect_acronym_suffixes BOOLEAN NOT NULL DEFAULT TRUE;
