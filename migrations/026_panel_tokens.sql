-- Illustrator-Panel: Anmeldung mit Microsoft statt gemeinsamem Schlüssel (28.10.2026).
--
-- Bisher teilten sich alle Designer einen CEP_SERVICE_KEY, und Panel-Aufträge
-- gehörten niemandem (created_by = NULL) — kein Review anforderbar, keine
-- Freigabe. Jetzt koppelt sich das Panel einmal je Rechner über den Browser an
-- das Konto der Person (bestehende Microsoft-Anmeldung der Web-App) und trägt
-- danach einen persönlichen Schlüssel. Plan: PLAN-panel-anmeldung.md.
--
-- Gespeichert wird von Schlüssel und Abhol-Geheimnis nur der SHA-256-Hash.
-- Der Klartext des Schlüssels entsteht erst beim Abholen und geht genau einmal
-- an das Panel.

CREATE TABLE IF NOT EXISTS panel_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  -- „NBWIT · Illustrator 29.3" — damit die Person ihre Verbindungen erkennt
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_panel_tokens_user
  ON panel_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS panel_pairings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Kurzer Code zum Abgleich zwischen Panel und Browser („K7Q-4FX")
  code              TEXT NOT NULL,
  poll_secret_hash  TEXT NOT NULL,
  label             TEXT,
  -- grober Absender (gekürzter Hash der IP) für die Obergrenze offener Kopplungen
  client            TEXT NOT NULL,
  user_id           UUID REFERENCES users(id) ON DELETE CASCADE,
  token_id          UUID REFERENCES panel_tokens(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  confirmed_at      TIMESTAMPTZ,
  picked_up_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_panel_pairings_open
  ON panel_pairings (client, expires_at) WHERE picked_up_at IS NULL;

-- Übergang: Wer noch mit dem gemeinsamen CEP_SERVICE_KEY kommt, wird je Tag
-- und Absender gezählt. Abgeschaltet wird der Schlüssel erst, wenn hier
-- 14 Tage lang nichts mehr dazukommt (Plan §5 F4) — Messung statt Datum.
CREATE TABLE IF NOT EXISTS cep_shared_key_uses (
  day      DATE NOT NULL,
  client   TEXT NOT NULL,
  uses     INTEGER NOT NULL DEFAULT 0,
  last_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, client)
);
