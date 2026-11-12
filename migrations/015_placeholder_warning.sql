-- 015_placeholder_warning.sql
--
-- Adobe-Latein / Lorem-Ipsum Placeholder-Detector (siehe
-- src/services/placeholder-detector.ts).
--
-- Speichert das Detektor-Ergebnis pro Projekt direkt am projects-Datensatz:
--   { triggered, totalSegments, placeholderCount, ratio, loremIpsumDetected,
--     samples: [{ id, preview, matchedTokens }] }
--
-- NULL = noch nicht gescannt (alte Projekte, Migrationen vor 015).
-- triggered=false bleibt persistent gespeichert, damit die UI nicht jedes Mal
-- neu rechnen muss.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS placeholder_warning JSONB;

-- Generated column fuer schnellen Filter "alle Projekte mit Warnung".
-- Wir nutzen einen Partial-Index statt einer generated column, weil JSONB
-- mit b-tree auf boolesches Feld so am effizientesten faellt.
CREATE INDEX IF NOT EXISTS idx_projects_placeholder_triggered
  ON projects ((placeholder_warning->>'triggered'))
  WHERE placeholder_warning IS NOT NULL;
