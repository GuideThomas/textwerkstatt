-- Phase 2: Projekt-Segment-Zuordnung für IDML-Parser
-- Verknuepft Projekte mit ihren extrahierten Segmenten inkl. IDML-Metadaten

CREATE TABLE IF NOT EXISTS project_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    segment_id UUID REFERENCES segments(id),
    -- IDML-spezifische Metadaten
    idml_segment_id TEXT NOT NULL,       -- z.B. "story_u123_p2"
    story_file TEXT,                      -- z.B. "Stories/Story_u123.xml"
    paragraph_index INT,
    content_map JSONB,                    -- ContentMapping[] als JSON
    max_chars INT,                        -- Geschaetzte max. Zeichen (aus Frame)
    -- Sortierung innerhalb des Projekts
    position INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_segments_project ON project_segments(project_id);
CREATE INDEX IF NOT EXISTS idx_project_segments_segment ON project_segments(segment_id);
CREATE INDEX IF NOT EXISTS idx_project_segments_position ON project_segments(project_id, position);
