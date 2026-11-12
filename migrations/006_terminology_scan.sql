-- Migration 006: Batch-Terminologie-Scan (Phase 5)

-- Scan-Jobs
CREATE TABLE IF NOT EXISTS terminology_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    source_lang VARCHAR(5) NOT NULL,
    target_lang VARCHAR(5) NOT NULL,
    source_file_type VARCHAR(10) NOT NULL,
    source_filename TEXT,
    translation_filename TEXT,
    source_stored_filename TEXT,
    translation_stored_filename TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    total_segments INT DEFAULT 0,
    diff_segments INT DEFAULT 0,
    candidate_count INT DEFAULT 0,
    glossary_id UUID REFERENCES glossaries(id) ON DELETE SET NULL,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- LLM-klassifizierte Abweichungen
CREATE TABLE IF NOT EXISTS terminology_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id UUID NOT NULL REFERENCES terminology_scans(id) ON DELETE CASCADE,
    source_text TEXT NOT NULL,
    existing_translation TEXT NOT NULL,
    deepl_translation TEXT NOT NULL,
    source_term TEXT NOT NULL,
    existing_term TEXT NOT NULL,
    deepl_term TEXT NOT NULL,
    category VARCHAR(20) NOT NULL,
    confidence NUMERIC(3,2) NOT NULL,
    explanation TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    glossary_entry_id UUID REFERENCES glossary_entries(id) ON DELETE SET NULL,
    position INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_term_candidates_scan ON terminology_candidates(scan_id);
CREATE INDEX IF NOT EXISTS idx_term_candidates_status ON terminology_candidates(scan_id, status);
CREATE INDEX IF NOT EXISTS idx_term_candidates_category ON terminology_candidates(scan_id, category);
CREATE INDEX IF NOT EXISTS idx_term_scans_status ON terminology_scans(status);
