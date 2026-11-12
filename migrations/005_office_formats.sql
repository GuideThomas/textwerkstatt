-- Phase 6: Office-Formate (DOCX/XLSX)
-- Generalisiert project_segments: idml_segment_id wird nullable,
-- neues Feld format_segment_id als generischer Identifier für alle Formate.
-- format_metadata speichert format-spezifische Daten (JSONB).

-- idml_segment_id nullable machen (war NOT NULL)
ALTER TABLE project_segments ALTER COLUMN idml_segment_id DROP NOT NULL;

-- Generischer Segment-Identifier (für DOCX: "p_5", für XLSX: "Sheet1_B3")
ALTER TABLE project_segments ADD COLUMN IF NOT EXISTS format_segment_id TEXT;

-- Format-spezifische Metadaten als JSONB
-- DOCX: { "paragraphIndex": 5, "styleId": "Heading1" }
-- XLSX: { "sheet": "Sheet1", "cell": "B3", "row": 2, "col": 1 }
ALTER TABLE project_segments ADD COLUMN IF NOT EXISTS format_metadata JSONB;

-- Index für Format-Segment-Lookup
CREATE INDEX IF NOT EXISTS idx_project_segments_format_seg
  ON project_segments(project_id, format_segment_id);

-- Bestehende IDML-Daten migrieren: idml_segment_id → format_segment_id
UPDATE project_segments
SET format_segment_id = idml_segment_id
WHERE format_segment_id IS NULL AND idml_segment_id IS NOT NULL;
