-- Segment-Cache je Besitzer, 13.11.2026 (PLAN-oeffentlich-und-demo.md §4 „Review 13.11.2026“)
--
-- Die Zeilen in `segments` sind der Übersetzungs-Cache: Zwei Projekte mit demselben Satz (gleiches Sprachpaar, gleicher Channel,
-- gleiche Anrede) zeigen auf DIESELBE Zeile. In einer Installation mit einem Haus ist das gewollt — eine Korrektur im
-- Review-Editor gilt dann für alle. In der öffentlichen Demo (`DEMO_MODUS=an`) hieße es: Gast A ändert in seinem Dokument die
-- Übersetzung, die im Dokument von Gast B steht. Deshalb bekommt der Schlüssel eine weitere Dimension, den Besitzer.
--
-- `besitzer` ist NULL = gemeinsamer Cache. So bleibt jede bestehende Zeile, was sie war, und ohne Demo schreibt der Code nie
-- etwas anderes als NULL (`segmentKeyOf` in `src/services/queue.ts`): Die Installation ohne Demo merkt nichts. In der Demo
-- trägt jede Zeile den Gast, dem das Projekt gehört (`projects.created_by`).
--
-- Kein Fremdschlüssel auf `users`: `ON DELETE SET NULL` würfe die Zeile in den gemeinsamen Cache (und könnte dort am
-- eindeutigen Index scheitern), `ON DELETE CASCADE` risse Zeilen weg, auf die `project_segments.segment_id` zeigt. Die Demo
-- leert sich beim Zurücksetzen als Ganzes.
--
-- ⚠️ DURCHGEHEND IDEMPOTENT (alle Migrationen laufen bei jedem Start, siehe 021_formality.sql). Und: 010, 012 und 021 legen
-- ihre engeren Indizes seit 13.11.2026 nur noch an, solange kein weiterer existiert — sonst entstünde v1 bei jedem Start neu
-- und scheiterte an zwei Zeilen, die sich nur im Besitzer unterscheiden.
--
-- ⚠️ `batch-translate.ts` und `terminology-scan.ts` lesen `segments` mit eigenem SQL an `upsertSegment` vorbei; beide tragen
-- die Bedingung `besitzer IS NULL` ausgeschrieben.

ALTER TABLE segments
  ADD COLUMN IF NOT EXISTS besitzer UUID;

-- Der Bestand trägt überall NULL, der neue Index kann an ihm nicht scheitern. COALESCE auf die Null-UUID aus demselben Grund
-- wie bei `channel_code`: Für einen eindeutigen Index sind zwei NULL verschieden.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_segments_hash_lang_channel_v4
  ON segments (
    segment_hash,
    source_lang,
    target_lang,
    COALESCE(channel_code, '__std__'),
    glossary_disabled,
    formality,
    COALESCE(besitzer, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- Erst danach den Vorgänger entfernen: Zu keinem Zeitpunkt ist die Tabelle ohne eindeutigen Schlüssel.
DROP INDEX IF EXISTS uniq_segments_hash_lang_channel_v3;

-- Die Suche nach dem normalisierten Hash (zweite Stufe in `upsertSegment`) je Besitzer; ohne Demo bleibt der Teilindex leer.
CREATE INDEX IF NOT EXISTS idx_segments_besitzer
  ON segments (besitzer, normalized_hash, source_lang, target_lang)
  WHERE besitzer IS NOT NULL;
