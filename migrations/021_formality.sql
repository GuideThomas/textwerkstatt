-- Anredestufe (DeepL `formality`), 14.08.2026 — Cockpit #752
--
-- Der Anwender kann vor einem Übersetzungslauf optional eine Anredestufe
-- wählen: formell (`more`) oder informell (`less`). `default` ist der Zustand
-- von heute und sendet KEINEN Parameter an DeepL.
--
-- Cache-Auswirkung: Derselbe Text unter `more` und unter `less` ergibt
-- verschiedene Übersetzungen. Die Stufe muss deshalb Teil des Segment-
-- Schlüssels sein, sonst liefert der Cache die formelle Fassung als Treffer
-- für eine informelle Anfrage — dieselbe Klasse wie 012 (glossary_disabled)
-- und 010 (channel_code).
--
-- ⚠️ DURCHGEHEND IDEMPOTENT — das ist keine Stilfrage.
-- `src/db/migrate.ts` liest ALLE .sql-Dateien und führt sie bei JEDEM Start
-- aus; es gibt kein Ledger, das bereits angewandte Migrationen überspringt.
-- Schlägt eine Datei fehl, bricht der gesamte Lauf mit `process.exit(1)` ab und
-- alle nachfolgenden Migrationen bleiben liegen. Eine Anweisung ohne
-- `IF NOT EXISTS` würde also beim ZWEITEN Start den Migrationslauf lahmlegen.
-- Migration 012 macht es deshalb überall so; bitte bei Überarbeitungen nicht
-- als Redundanz entfernen.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS formality TEXT NOT NULL DEFAULT 'default';

ALTER TABLE segments
  ADD COLUMN IF NOT EXISTS formality TEXT NOT NULL DEFAULT 'default';

-- Der Default trägt die Rückwärtskompatibilität: alles bereits Übersetzte lief
-- ohne den Parameter, ist also per Definition `default`. Kein Bestand wird
-- ungültig, und der neue Unique-Index kann auf dem Bestand nicht kollidieren,
-- weil alle Zeilen denselben Wert tragen.

-- Unique-Index aus 012_neutral_translation.sql ersetzen: jetzt zusätzlich
-- `formality` als Schlüsselbestandteil.
DROP INDEX IF EXISTS uniq_segments_hash_lang_channel_v2;

-- ⚠️ Nur anlegen, solange kein weiterer Schlüssel existiert (051 v4) — Begründung in 010_sales_channels.sql.
DO $$
BEGIN
  IF to_regclass('uniq_segments_hash_lang_channel_v4') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_segments_hash_lang_channel_v3
      ON segments (
        segment_hash,
        source_lang,
        target_lang,
        COALESCE(channel_code, '__std__'),
        glossary_disabled,
        formality
      );
  END IF;
END $$;

-- Wertebereich absichern. Ohne diese Schranke könnte ein künftiger Schreibweg
-- eine vierte Ausprägung einschleusen und damit lautlos eine weitere
-- Cache-Dimension erzeugen, die kein Leser kennt.
-- `NOT VALID` wäre hier unnötig: der Bestand trägt ausschließlich 'default'.
-- `conrelid = '...'::regclass` statt eines blossen Namensvergleichs: der Name
-- allein ist nicht eindeutig, wenn dieselbe Tabelle in einem zweiten Schema
-- existiert (etwa bei einem Probelauf). `::regclass` loest ueber den
-- search_path auf und trifft damit genau die Tabelle, die auch geaendert wird.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'segments_formality_chk' AND conrelid = 'segments'::regclass
  ) THEN
    ALTER TABLE segments
      ADD CONSTRAINT segments_formality_chk
      CHECK (formality IN ('default', 'more', 'less'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'projects_formality_chk' AND conrelid = 'projects'::regclass
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_formality_chk
      CHECK (formality IN ('default', 'more', 'less'));
  END IF;
END $$;
