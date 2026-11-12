-- Phase 3: Track welche Glossar-Version bei DeepL synchronisiert ist
ALTER TABLE glossaries ADD COLUMN IF NOT EXISTS synced_version INT DEFAULT 0;

-- Bestehende Glossare mit deepl_glossary_id: synced_version = version
-- ⚠️ `migrate.js` führt diese Datei bei jedem Deploy erneut aus. Bis 04.11.2026 fehlte `synced_version = 0`:
-- Jede noch nicht synchronisierte Änderung galt nach einem Deploy als bei DeepL aktuell und kam dort nicht an.
UPDATE glossaries SET synced_version = version WHERE deepl_glossary_id IS NOT NULL AND synced_version = 0;
