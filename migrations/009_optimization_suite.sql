-- Phase 11: Optimierungs-Suite
-- - normalized_hash: Whitespace/Quote-tolerante Cache-Lookups
-- - parent_project_id: Versionsketten zwischen Dokument-Generationen
-- - sibling_group_id: Multi-Target-Uploads gruppieren

-- 1) Normalized-Hash für robusteren Cache-Lookup
ALTER TABLE segments
  ADD COLUMN IF NOT EXISTS normalized_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_segments_normalized
  ON segments(normalized_hash, source_lang, target_lang)
  WHERE normalized_hash IS NOT NULL;

-- 2) Versionsketten: Projekt B kann als "neue Version" von Projekt A markiert werden
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS parent_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version_number INT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_project_id);

-- 3) Multi-Target-Gruppen: Ein Upload erzeugt N Projekte (eine pro Zielsprache)
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS sibling_group_id UUID;

CREATE INDEX IF NOT EXISTS idx_projects_sibling ON projects(sibling_group_id) WHERE sibling_group_id IS NOT NULL;

-- 4) Glossary-Entry-Origin: Spur woher ein Glossar-Eintrag kam (für Inline-Quickadd)
ALTER TABLE glossary_entries
  ADD COLUMN IF NOT EXISTS source_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_segment_id UUID REFERENCES segments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- 5) Konsistenz-Marker: Wann wurde manuell editiert (für Konsistenz-Check)
-- (Spalte review_status existiert bereits aus 004_review_editor.sql)

-- 6) Estimate-Snapshot pro Job (für Pre-Translation-Anzeige im Frontend)
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS estimate JSONB;
