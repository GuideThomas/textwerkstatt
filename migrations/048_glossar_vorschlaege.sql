-- Vorschläge zum Glossar: Nicht-Admins schlagen vor, Admins geben frei.
--
-- Plan `PLAN-glossar-freigabe.md` (Cockpit #1874), Entscheid Thomas 12.11.2026. Widerruft „jeder Angemeldete gibt frei“ vom
-- 10.11.2026 (`PLAN-wortliste.md`).
--
-- 🚨 Ein Nicht-Admin schreibt nie in `glossary_entries`, `glossary_entry_channels` oder `glossary_entry_gruppen`, sondern nur hierher.
-- Bis zur Freigabe gilt der alte Stand, für DeepL (`glossar_an_deepl`) wie für die Namen des Assistenten (`wortliste_freigegeben`).
-- Die Freigabe führt der Server mit demselben Code aus, mit dem ein Admin direkt schreibt; der Verlauf nennt beide.
--
-- `weg` sagt, was der Vorschlag ändert, `schluessel` wo:
--   neu        neuer Begriff (entry_id leer), daten: target_term, context, category, channel_code
--   eintrag    Ziel, Kontext, Kategorie (schluessel '') oder Umbenennen (schluessel 'begriff', daten: source_term)
--   channel    Channel-Wert (schluessel = Channel-Code), daten.target_term leer heißt entfernen
--   wortliste  Art, Wortart, Genus, Formen, ziel_name, an_deepl
--   gruppe     Ziel je Produktgruppe (schluessel = Gruppe), daten.target_term leer heißt entfernen
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

CREATE TABLE IF NOT EXISTS glossar_vorschlag (
  id                 BIGSERIAL PRIMARY KEY,
  glossary_id        UUID NOT NULL REFERENCES glossaries(id) ON DELETE CASCADE,
  entry_id           UUID REFERENCES glossary_entries(id) ON DELETE CASCADE,
  weg                TEXT NOT NULL CHECK (weg IN ('neu', 'eintrag', 'channel', 'wortliste', 'gruppe')),
  schluessel         TEXT NOT NULL DEFAULT '',
  source_term        TEXT NOT NULL CHECK (btrim(source_term) <> ''),
  daten              JSONB NOT NULL CHECK (jsonb_typeof(daten) = 'object'),
  vorher             JSONB,
  quelle             TEXT NOT NULL CHECK (quelle IN ('glossar', 'quickadd', 'review', 'terminologie-scan')),
  von_id             UUID,
  von                TEXT NOT NULL CHECK (btrim(von) <> ''),
  am                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geaendert_am       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Zählt jedes Ergänzen. Die Freigabe nennt die Fassung, die der Admin gesehen hat; eine neuere wird nicht freigegeben.
  fassung            INTEGER NOT NULL DEFAULT 1,
  -- `in_arbeit`: ein Admin gibt gerade frei. So kann kein zweiter Admin denselben Vorschlag zugleich freigeben oder verwerfen.
  status             TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'in_arbeit', 'freigegeben', 'verworfen')),
  entschieden_von    TEXT,
  entschieden_von_id UUID,
  entschieden_am     TIMESTAMPTZ,
  CONSTRAINT glossar_vorschlag_neu_ohne_zeile CHECK ((weg = 'neu') = (entry_id IS NULL)),
  CONSTRAINT glossar_vorschlag_entscheid CHECK ((status = 'offen') = (entschieden_am IS NULL))
);
COMMENT ON TABLE glossar_vorschlag IS
  'Vorschläge von Nicht-Admins zum Glossar und zur Wortliste. Wirken erst, wenn ein Admin sie freigibt (PLAN-glossar-freigabe.md).';
COMMENT ON COLUMN glossar_vorschlag.vorher IS
  'Stand der vorgeschlagenen Felder beim Einreichen, für den Verlauf. Die Oberfläche zeigt den Stand von jetzt, nicht diesen.';

-- Ein offener Vorschlag je Person und Ziel: Wer zweimal speichert, ergänzt den ersten, statt einen zweiten anzulegen.
CREATE UNIQUE INDEX IF NOT EXISTS uq_glossar_vorschlag_offen
  ON glossar_vorschlag (glossary_id, (COALESCE(entry_id::text, lower(btrim(source_term)))), weg, schluessel, (COALESCE(von_id::text, von)))
  WHERE status = 'offen';
CREATE INDEX IF NOT EXISTS idx_glossar_vorschlag_glossar ON glossar_vorschlag (glossary_id, status, am DESC);
CREATE INDEX IF NOT EXISTS idx_glossar_vorschlag_zeile ON glossar_vorschlag (entry_id) WHERE status = 'offen';
