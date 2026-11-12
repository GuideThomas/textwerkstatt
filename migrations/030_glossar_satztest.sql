-- Herkunft „satztest“ für Markierungen „unnötig“ (Entscheid Thomas 04.11.2026: geleert wird nur, was den Satztest besteht).
--
-- Die erste Markierung vom 04.11.2026 hat Gewissheit `hoch` schon für Gleichheit am einzelnen Wort vergeben. Das
-- Bereinigen darf sich darauf nicht stützen, und diese Datei darf den Altbestand nicht herabstufen: `migrate.js` führt sie bei
-- jedem Deploy erneut aus und träfe dann auch spätere Bestätigungen. Maßgeblich ist deshalb die Quelle.
--
-- Wiederholbar. Die Liste muss zu `QUELLEN` in `src/services/glossar-hinweise.ts` passen.

ALTER TABLE glossary_hints DROP CONSTRAINT IF EXISTS glossary_hints_quelle_check;
ALTER TABLE glossary_hints ADD CONSTRAINT glossary_hints_quelle_check CHECK (quelle IN ('mechanisch', 'fachlich', 'satztest'));
