-- Phase 20 (28.07.2026): Store-View-Anpassung gilt für ALLE Projekte
--
-- Entscheidung Thomas 28.07.2026: die Anpassung der Store-View in internen
-- Navigationslinks ist keine Projekt-Option mehr, sondern Standardverhalten.
--
-- Warum die Spalte trotzdem bleibt:
--   * Alt-Projekte tragen die Historie, ob damals injiziert wurde — das ist bei
--     der Fehlersuche in bereits ausgelieferten Dateien relevant.
--   * Ein DROP COLUMN wäre die einzige nicht rückholbare Operation dieses
--     Deploys; der Nutzen ist null, weil die Spalte niemanden stört.
-- Der Code liest sie nicht mehr (`src/routes/upload.ts`, `src/services/queue.ts`).
--
-- Der neue Default TRUE ist reine Kosmetik für manuell angelegte Zeilen, damit
-- die Spalte nicht fälschlich "war aus" suggeriert.

ALTER TABLE projects
  ALTER COLUMN inject_storeview_prefix SET DEFAULT TRUE;

COMMENT ON COLUMN projects.inject_storeview_prefix IS
  'VERALTET seit 28.07.2026 (Migration 020) — wird nicht mehr gelesen. Die '
  'Store-View-Anpassung interner Navigationslinks läuft für alle Projekte, '
  'siehe src/services/text/storeview.ts. Spalte nur noch als Historie für '
  'Projekte, die vor dem 28.07.2026 übersetzt wurden.';
