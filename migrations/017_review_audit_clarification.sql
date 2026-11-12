-- 017_review_audit_clarification.sql
--
-- Erweitert das Review-Modell um:
--   1. Audit-Trail: wer hat wann approved
--   2. "Unklar / Nachfragen"-Status mit optionaler Notiz
--
-- review_status erlaubt jetzt: pending | translated | edited | approved | needs_clarification
-- (Constraint nicht hart gesetzt — bisherige Werte sind Strings ohne CHECK.)

ALTER TABLE segments
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clarification_note TEXT,
  ADD COLUMN IF NOT EXISTS clarification_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS clarification_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_segments_approved_by
  ON segments (approved_by) WHERE approved_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_segments_clarification
  ON segments (review_status) WHERE review_status = 'needs_clarification';
