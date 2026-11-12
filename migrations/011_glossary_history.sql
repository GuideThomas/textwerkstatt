-- Phase 12.5: Glossar-Aenderungsnachweis (Audit-Log)
--
-- Jede Aenderung an einem Glossar-Eintrag (Standard-Zielbegriff ODER Channel-Override
-- je Channel, z. B. SHOP-A/B2C) wird hier mit Vorher/Nachher, Benutzer und Zeitstempel
-- protokolliert. Befuellt wird die Tabelle in den glossaries-Routen (POST/PUT/DELETE
-- inkl. Quickadd und Channel-Override-CRUD).
--
-- Spalten-Convention:
-- - field = 'standard'      → Standard-Zielbegriff (target_term in glossary_entries)
-- - field = '<CHANNEL_CODE>' → Channel-Override (target_term in glossary_entry_channels)
--   z.B. 'SHOP-A', 'B2C'
-- - action: 'created' | 'updated' | 'deleted'
-- - source_term: aktueller Quellbegriff (zur Anzeige; bei DELETE der letzte bekannte)
-- - old_value/new_value: NULL bei created/deleted respektive

CREATE TABLE IF NOT EXISTS glossary_entry_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID,                              -- nullable, weil delete-cascade vom entry den FK-Zwang sprengt
  glossary_id UUID,                           -- denormalisiert: bleibt erhalten auch wenn entry geloescht wird
  source_term TEXT NOT NULL,
  field VARCHAR(20) NOT NULL,                 -- 'standard' | Channel-Code
  action VARCHAR(10) NOT NULL,                -- 'created' | 'updated' | 'deleted'
  old_value TEXT,
  new_value TEXT,
  changed_by UUID,                            -- users.id, nullable wenn unauthentifizierte Aktion
  changed_by_name TEXT,                       -- denormalisiert fuer schnelle Anzeige (Email/Display-Name)
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geh_entry ON glossary_entry_history(entry_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_geh_glossary ON glossary_entry_history(glossary_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_geh_user ON glossary_entry_history(changed_by, changed_at DESC) WHERE changed_by IS NOT NULL;
