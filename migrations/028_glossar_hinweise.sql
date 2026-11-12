-- Prüfhinweise zu Glossareinträgen (Auftrag Thomas, 04.11.2026).
--
-- Ein Hinweis sagt, warum ein Eintrag aus Sicht der Prüfung nicht optimal ist. Er liegt getrennt vom
-- Eintrag und wirkt nie: Kein Weg zu DeepL oder in einen Prompt liest diese Tabelle, und sie ändert
-- keinen Eintrag.
--
-- ERLEDIGT OHNE ZUTUN: Der Hinweis trägt den Stand, zu dem er gehört (Glossar, Begriff, Übersetzung).
-- Ändert jemand Begriff oder Übersetzung, passt er nicht mehr und verschwindet, ohne dass ein
-- Schreibweg daran denken muss. Darum auch kein Fremdschlüssel auf den Eintrag.
--
-- VERWORFEN: Hält ein Mensch den Eintrag für richtig, bleibt der Eintrag unverändert und nur der
-- Hinweis fällt weg. Ein erneutes Einspielen lässt das stehen.
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus.

CREATE TABLE IF NOT EXISTS glossary_hints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  glossary_id UUID NOT NULL REFERENCES glossaries(id) ON DELETE CASCADE,
  source_term TEXT NOT NULL,
  target_term TEXT NOT NULL,
  kategorie VARCHAR(20) NOT NULL CHECK (kategorie IN (
    'falsch', 'sprachlich', 'schreibung', 'zeichen', 'satz',
    'wert', 'mehrdeutig', 'dublette', 'eigenname', 'unuebersetzt'
  )),
  gewissheit VARCHAR(10) NOT NULL CHECK (gewissheit IN ('hoch', 'mittel', 'niedrig')),
  -- 'mechanisch' = von einer Regel gefunden, 'fachlich' = beurteilt. Die Voreinstellung des Filters
  -- blendet nur mechanische Schreibungs-Hinweise aus, die sonst die Liste füllen.
  quelle VARCHAR(12) NOT NULL CHECK (quelle IN ('mechanisch', 'fachlich')),
  vorschlag TEXT CHECK (vorschlag IS NULL OR btrim(vorschlag) <> ''),
  grund TEXT NOT NULL CHECK (btrim(grund) <> ''),
  verworfen_am TIMESTAMPTZ,
  verworfen_von TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Je Stand eines Eintrags ein Hinweis je Kategorie. Der Index trägt auch die Zuordnung zur Liste.
CREATE UNIQUE INDEX IF NOT EXISTS uq_glossary_hints
  ON glossary_hints (glossary_id, source_term, target_term, kategorie);
