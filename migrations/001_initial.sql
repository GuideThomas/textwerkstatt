-- SmartDoc AI-Translator — Initial Schema
-- Phase 1: Alle 6 Kerntabellen

-- UUID-Generierung aktivieren
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Projekte (Übersetzungsauftraege)
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    source_lang VARCHAR(5) NOT NULL,
    target_lang VARCHAR(5) NOT NULL,
    file_type VARCHAR(10) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    original_filename TEXT,
    stored_filename TEXT,
    segment_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Segment-Cache (Hash-basiert, Duplikate vermeiden)
CREATE TABLE IF NOT EXISTS segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_hash VARCHAR(64) NOT NULL,
    source_lang VARCHAR(5) NOT NULL,
    target_lang VARCHAR(5) NOT NULL,
    source_text TEXT NOT NULL,
    translated_text TEXT,
    condensed_text TEXT,
    glossary_version INT DEFAULT 0,
    is_stale BOOLEAN DEFAULT FALSE,
    hit_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(segment_hash, source_lang, target_lang)
);

-- Glossare (pro Sprachpaar)
CREATE TABLE IF NOT EXISTS glossaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    source_lang VARCHAR(5) NOT NULL,
    target_lang VARCHAR(5) NOT NULL,
    version INT DEFAULT 1,
    deepl_glossary_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Glossar-Eintraege
CREATE TABLE IF NOT EXISTS glossary_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    glossary_id UUID REFERENCES glossaries(id) ON DELETE CASCADE,
    source_term TEXT NOT NULL,
    target_term TEXT NOT NULL,
    context TEXT,
    category VARCHAR(50),
    approved BOOLEAN DEFAULT FALSE,
    source VARCHAR(20) DEFAULT 'manual',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Jobs (Queue-Status-Tracking, ergaenzend zu pg-boss)
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL,
    status VARCHAR(20) DEFAULT 'queued',
    progress INT DEFAULT 0,
    error TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Token-Usage (LLM-Kostentracking)
CREATE TABLE IF NOT EXISTS token_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    segment_id UUID REFERENCES segments(id),
    model TEXT NOT NULL,
    purpose VARCHAR(20) NOT NULL,
    input_tokens INT NOT NULL,
    output_tokens INT NOT NULL,
    cost_usd NUMERIC(10,6),
    latency_ms INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indizes für Performance
CREATE INDEX IF NOT EXISTS idx_segments_hash ON segments(segment_hash, source_lang, target_lang);
CREATE INDEX IF NOT EXISTS idx_segments_stale ON segments(is_stale) WHERE is_stale = TRUE;
CREATE INDEX IF NOT EXISTS idx_glossary_entries_glossary ON glossary_entries(glossary_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage(project_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
