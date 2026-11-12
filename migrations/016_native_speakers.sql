-- 016_native_speakers.sql
--
-- Native-Speaker als externe Reviewer fuer maschinelle Uebersetzungen.
--
-- Workflow:
--   1. Admin pflegt Liste (Name, E-Mail, Zielsprachen) im Admin-Bereich.
--   2. Auf Pruefen-Seite waehlt User einen Speaker (gefiltert nach target_lang)
--      aus dem Dropdown und klickt "Anfrage senden".
--   3. Backend persistiert review_invitation und schickt E-Mail.
--   4. Speaker klickt Link, MS-Auth-Login, landet auf Review-Seite und
--      koennen Segmente abnicken oder korrigieren.
--
-- Auth: Speaker brauchen einen MS-Entra-Account. Beim ersten Login wird der
-- User automatisch angelegt (microsoftAuth.ts). Native-Speaker-Tabelle ist
-- bewusst separat von users — die Liste dient nur dem Dropdown, nicht der
-- Authorization.

CREATE TABLE IF NOT EXISTS native_speakers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  -- DeepL-/ISO-Sprachcodes der Sprachen, die diese Person als Native abdeckt
  -- (z. B. {'EN', 'DE'} fuer eine bilinguale Person). UPPERCASE.
  languages   TEXT[] NOT NULL DEFAULT '{}',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_native_speakers_languages
  ON native_speakers USING GIN (languages);

CREATE INDEX IF NOT EXISTS idx_native_speakers_active
  ON native_speakers (active) WHERE active = TRUE;

-- Versand-Log: wer hat wann fuer welches Projekt einen Reviewer gebeten?
-- Dient Audit + ggf. spaeter "wartet auf Review"-Status im Dashboard.
CREATE TABLE IF NOT EXISTS review_invitations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  speaker_id         UUID NOT NULL REFERENCES native_speakers(id) ON DELETE CASCADE,
  speaker_email      TEXT NOT NULL,
  requested_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  message            TEXT,
  sent_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivery_status    TEXT NOT NULL DEFAULT 'sent', -- sent | failed
  delivery_error     TEXT
);

CREATE INDEX IF NOT EXISTS idx_review_invitations_project
  ON review_invitations (project_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_invitations_speaker
  ON review_invitations (speaker_id, sent_at DESC);
