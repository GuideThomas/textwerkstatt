-- Unnötige Zeilen als Prüfhinweis (Auftrag Thomas, 04.11.2026).
--
-- Ein Gegencheck gegen DeepL ohne Glossar zeigt, welche Zeilen an der Übersetzung nichts ändern. Das
-- markiert die Zeile, es löscht nichts. Zwei Stufen (seit 05.11.2026 gilt × nur noch im eigenen Glossar, die Stufen
-- bleiben als Aussage über den Begriff):
--   unnoetig_ueberall  der ganze Begriff ist in allen Sprachen entbehrlich
--   unnoetig_hier      nur diese Zeile, eine andere Sprache braucht den Begriff
--
-- Wiederholbar: `migrate.js` führt bei jedem Deploy alle Dateien erneut aus. Die Liste muss zu
-- `KATEGORIEN` in `src/services/glossar-hinweise.ts` passen.

ALTER TABLE glossary_hints DROP CONSTRAINT IF EXISTS glossary_hints_kategorie_check;
ALTER TABLE glossary_hints ADD CONSTRAINT glossary_hints_kategorie_check CHECK (kategorie IN (
  'falsch', 'sprachlich', 'schreibung', 'zeichen', 'satz',
  'wert', 'mehrdeutig', 'dublette', 'eigenname', 'unuebersetzt',
  'unnoetig_ueberall', 'unnoetig_hier'
));
