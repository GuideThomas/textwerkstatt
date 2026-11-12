-- Freigabe einer Übersetzung durch einen Native Speaker, 17.09.2026
--
-- Bisher konnte ein Reviewer nur einzelne Segmente abhaken. Ob er fertig war,
-- blieb offen. Jetzt bestätigt er das ganze Projekt mit „Übersetzung freigeben".
--
-- Regeln (Anfrage einer Kollegin, Entscheid Thomas 17.09.2026):
--   - Eine Anfrage kann an mehrere Reviewer gehen; EINE Freigabe genügt.
--     Die übrigen Angefragten erhalten dann eine Mail „bereits erledigt".
--   - Freigeben geht nur, wenn jedes übersetzte Segment abgehakt ist und
--     keine Rückfrage mehr offen steht.
--   - Ändert sich danach der Text, fällt die Freigabe weg, und wer die
--     Prüfung angefragt hat, bekommt eine Mail.
--
-- Warum ein Fingerabdruck (content_hash) und nicht nur ein Hook im Editor:
-- Segmenttexte werden an mehreren Stellen geschrieben (Editor, Kürzen,
-- Neuübersetzung veralteter Segmente, Terminologie-Scan), und ein Segment kann
-- über `project_segments` in mehreren Projekten stecken. Der Hash über die
-- finalen Texte des Projekts erkennt jede Änderung, egal auf welchem Weg.

CREATE TABLE IF NOT EXISTS review_releases (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  released_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Name und Mail zum Zeitpunkt der Freigabe festhalten — der Nachweis soll
  -- auch dann lesbar bleiben, wenn der Benutzer später gelöscht wird.
  released_by_name   TEXT NOT NULL,
  released_by_email  TEXT NOT NULL,
  released_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_hash       TEXT NOT NULL,
  segment_count      INTEGER NOT NULL,
  revoked_at         TIMESTAMPTZ,
  revoked_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  -- text_changed | unapproved | clarification
  revoked_reason     TEXT
);

-- Höchstens eine gültige Freigabe je Projekt. Fängt auch zwei Reviewer ab,
-- die im selben Moment auf „Freigeben" klicken.
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_releases_active
  ON review_releases (project_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_review_releases_project
  ON review_releases (project_id, released_at DESC);
