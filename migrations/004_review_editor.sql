-- Migration 004: Review-Editor Felder
-- Phase 7: Split-Screen Review + Terminologie-Erkennung

-- Segments: Review-Status und Original-Übersetzung sichern
ALTER TABLE segments ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE segments ADD COLUMN IF NOT EXISTS edited_by_user BOOLEAN DEFAULT FALSE;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS original_translation TEXT;

-- Project-Segments: Condensing-Status persistieren (für Farb-Markierung)
ALTER TABLE project_segments ADD COLUMN IF NOT EXISTS condense_status VARCHAR(20);

-- Index für Review-Filter
CREATE INDEX IF NOT EXISTS idx_segments_review ON segments(review_status);
