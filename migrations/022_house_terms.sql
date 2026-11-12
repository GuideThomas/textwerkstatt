-- Hausschreibweise (deutsch → deutsch), 16.09.2026
--
-- Eine Liste „nicht verwenden → stattdessen" für deutsche Texte, z. B.
-- „LED-Treiber" → „LED-Trafo". Die Schreibhilfe prüft Texte zusätzlich zu
-- LanguageTool gegen diese Liste.
--
-- Bewusst KEIN deutsch→deutsches Glossar in `glossaries`: diese Tabelle wird
-- nach Sprachpaar abgefragt (DeepL-Sync, /api/terminology für den
-- Artikelanlage-Assistenten, Terminologie-Scan, Dashboard). Ein DE→DE-Eintrag
-- tauchte dort als angebliche Übersetzung auf — `source_term` hiesse dann
-- „falscher Begriff" statt „Quellbegriff".
--
-- Channel-Overrides analog zu `glossary_entry_channels`: gibt es für einen
-- Channel keinen Override, gilt der Standard-Begriff der Organisation.

CREATE TABLE IF NOT EXISTS house_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  avoid_term TEXT NOT NULL,
  preferred_term TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ein zu vermeidender Begriff steht nur einmal in der Liste (Gross-/Kleinschreibung egal)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_house_terms_avoid ON house_terms (LOWER(avoid_term));

CREATE TABLE IF NOT EXISTS house_term_channels (
  term_id UUID NOT NULL REFERENCES house_terms(id) ON DELETE CASCADE,
  channel_code VARCHAR(20) NOT NULL REFERENCES channels(code) ON DELETE CASCADE,
  preferred_term TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (term_id, channel_code)
);

-- Änderungsnachweis, Spalten-Convention wie glossary_entry_history:
-- field = 'avoid' | 'standard' | 'note' | '<CHANNEL_CODE>'
CREATE TABLE IF NOT EXISTS house_term_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id UUID,                 -- nullable: bleibt nach dem Löschen des Eintrags erhalten
  avoid_term TEXT NOT NULL,
  field VARCHAR(20) NOT NULL,
  action VARCHAR(10) NOT NULL,  -- 'created' | 'updated' | 'deleted'
  old_value TEXT,
  new_value TEXT,
  changed_by UUID,
  changed_by_name TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hth_term ON house_term_history(term_id, changed_at DESC);
